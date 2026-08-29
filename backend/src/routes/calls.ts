import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { dispatchAgent, sendVerdict, stopAgent } from "../agentClient.js";
import type { Config } from "../config.js";
import { mintAgentToken, mintHumanToken } from "../livekit.js";
import { decideMode, effectiveGender, effectiveLang, effectiveTone } from "../mode.js";
import { endRing, newRing, toRingView, type CallSweeper } from "../ringing.js";
import {
  callCallee,
  callCaller,
  callParticipant,
  callPeer,
  createCall,
  findBusyCall,
  getCall,
  getContact,
  getUser,
  setCallAgent,
  setCallMode,
  setCallParticipants,
  setCallRing,
  setCallState,
  touchCall,
} from "../store.js";
import {
  agentTrackNameFor,
  AGENT_IDENTITY,
  apiError,
  CALL_ID_RE,
  USER_ID_RE,
  type AgentJob,
  type AgentVerdict,
  type Call,
  type CallMode,
  type CallParticipant,
  type CallRing,
  type JoinResponse,
} from "../types.js";

const userIdSchema = z.string().regex(USER_ID_RE, "must match ^u_[a-z0-9_]{1,30}$");
const callIdSchema = z.string().regex(CALL_ID_RE, "must match ^c_[0-9a-f]{12}$");

const callParams = z.object({ callId: callIdSchema });

const createCallBody = z
  .object({
    callerId: userIdSchema,
    calleeId: userIdSchema,
    force: z.boolean().default(false),
    /**
     * false (default) = the pre-existing invite-link flow, byte-for-byte unchanged.
     * true = the callee is notified through presence polling and must Accept.
     */
    ring: z.boolean().default(false),
    /** Per-call override of RING_TIMEOUT_SECONDS. 1s is allowed so tests need not sleep 45s. */
    ringTimeoutSeconds: z.number().int().min(1).max(300).optional(),
  })
  .strict();

const userOnlyBody = z.object({ userId: userIdSchema }).strict();

const modeBody = z.object({ userId: userIdSchema, force: z.boolean().default(false) }).strict();

const verdictBody = z
  .object({
    userId: userIdSchema,
    verdict: z.enum(["wrong", "ok"]).default("wrong"),
    /** Omit to label the most recent translated utterance the agent logged for this call. */
    utteranceId: z.string().min(1).max(128).optional(),
    expected: z.string().max(2000).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

function issues(err: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
  what: string,
): z.output<S> | null {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    reply.code(400).send(apiError("bad_request", `invalid ${what} — ${issues(result.error)}`));
    return null;
  }
  return result.data;
}

interface Resolved {
  mode: CallMode;
  reason: ReturnType<typeof decideMode>["reason"];
  participants: CallParticipant[];
}

/**
 * Mode is decided here and nowhere else — only the backend knows both profiles.
 * The override describing user X lives on the card the OTHER side keeps for X, which is
 * what makes "language is a property of the contact" symmetric for both directions.
 */
function resolveCall(callerId: string, calleeId: string, force: boolean): Resolved | null {
  const caller = getUser(callerId);
  const callee = getUser(calleeId);
  if (!caller || !callee) return null;

  const callerCard = getContact(callerId, calleeId);
  const calleeCard = getContact(calleeId, callerId);

  const langA = effectiveLang(caller, calleeCard?.overrides);
  const langB = effectiveLang(callee, callerCard?.overrides);

  const forceEffective =
    force || (callerCard?.forceTranslate ?? false) || (calleeCard?.forceTranslate ?? false);

  const decision = decideMode(langA, langB, forceEffective);

  const participants: CallParticipant[] = [
    {
      userId: caller.id,
      displayName: caller.displayName,
      lang: langA,
      gender: effectiveGender(caller, calleeCard?.overrides),
      tone: effectiveTone(caller, calleeCard?.overrides),
      role: "caller",
    },
    {
      userId: callee.id,
      displayName: callee.displayName,
      lang: langB,
      gender: effectiveGender(callee, callerCard?.overrides),
      tone: effectiveTone(callee, callerCard?.overrides),
      role: "callee",
    },
  ];

  return { mode: decision.mode, reason: decision.reason, participants };
}

async function dispatchForCall(cfg: Config, call: Call): Promise<void> {
  const token = await mintAgentToken(cfg, call.roomName);
  const job: AgentJob = {
    callId: call.id,
    roomName: call.roomName,
    mode: call.mode,
    livekitUrl: cfg.livekitUrl,
    token,
    participants: call.participants.map(({ role: _role, ...rest }) => rest),
  };
  const result = await dispatchAgent(cfg, job);
  setCallAgent(call.id, {
    required: true,
    dispatched: result.dispatched,
    identity: AGENT_IDENTITY,
    error: result.error ?? null,
  });
}

export function callRoutes(cfg: Config, sweeper: CallSweeper): FastifyPluginAsync {
  return async (app) => {
    app.post("/api/calls", async (req, reply) => {
      const body = parse(createCallBody, req.body, reply, "body");
      if (!body) return reply;

      if (body.callerId === body.calleeId) {
        return reply.code(409).send(apiError("self_call", "callerId and calleeId must differ"));
      }
      if (!getUser(body.callerId)) {
        return reply.code(404).send(apiError("not_found", `user ${body.callerId} does not exist`));
      }
      if (!getUser(body.calleeId)) {
        return reply.code(404).send(apiError("not_found", `user ${body.calleeId} does not exist`));
      }

      let ring: CallRing | null = null;
      if (body.ring) {
        // Expire stale rings first, otherwise a ring that has already timed out
        // would report both parties busy and block the retry.
        await sweeper.sweep();
        const nowMs = Date.now();
        for (const id of [body.callerId, body.calleeId]) {
          const busy = findBusyCall(id, nowMs);
          if (busy) {
            return reply
              .code(409)
              .send(
                apiError(
                  "busy",
                  `${id} already has a ${busy.ring!.state} call (${busy.id}); cancel or answer it first`,
                ),
              );
          }
        }
        ring = newRing(body.ringTimeoutSeconds ?? cfg.ringTimeoutSeconds, nowMs);
      }

      const resolved = resolveCall(body.callerId, body.calleeId, body.force)!;
      const call = createCall({ ...resolved, ring });

      if (call.mode === "DIRECT") {
        // The DIRECT guarantee is structural: the agent is not contacted at all.
        req.log.info(
          { callId: call.id, mode: call.mode, reason: call.reason },
          "call created — DIRECT, agent not dispatched",
        );
      } else {
        await dispatchForCall(cfg, call);
        req.log.info(
          { callId: call.id, mode: call.mode, reason: call.reason, agent: call.agent },
          "call created — agent dispatch attempted",
        );
      }

      const created = getCall(call.id)!;
      return reply
        .code(201)
        .send({ call: created, ring: toRingView(created, Date.now()) });
    });

    app.get("/api/calls/:callId", async (req, reply) => {
      const params = parse(callParams, req.params, reply, "path");
      if (!params) return reply;
      await sweeper.sweep();
      const call = getCall(params.callId);
      if (!call) return reply.code(404).send(apiError("not_found", `call ${params.callId} does not exist`));
      return { call, ring: toRingView(call, Date.now()) };
    });

    app.post("/api/calls/:callId/join", async (req, reply) => {
      const params = parse(callParams, req.params, reply, "path");
      if (!params) return reply;
      const body = parse(userOnlyBody, req.body, reply, "body");
      if (!body) return reply;

      await sweeper.sweep();
      const call = getCall(params.callId);
      if (!call) return reply.code(404).send(apiError("not_found", `call ${params.callId} does not exist`));
      if (call.state === "ended") {
        const why =
          call.ring !== null && call.ring.state !== "accepted"
            ? `call ${call.id} has already ended (ring ${call.ring.state})`
            : `call ${call.id} has already ended`;
        return reply.code(409).send(apiError("conflict", why));
      }

      const self = callParticipant(call, body.userId);
      const peer = callPeer(call, body.userId);
      if (!self || !peer) {
        return reply
          .code(403)
          .send(apiError("forbidden", `user ${body.userId} is not a participant of call ${call.id}`));
      }

      const token = await mintHumanToken(cfg, {
        userId: self.userId,
        displayName: self.displayName,
        lang: self.lang,
        gender: self.gender,
        tone: self.tone,
        roomName: call.roomName,
      });

      // A callee who joins a still-ringing call has answered it, whatever route
      // she took to get here (Accept button, or the invite link on a ringing call).
      // Treating the join as the accept removes the accept-vs-join ordering race
      // entirely instead of trying to referee it.
      if (call.ring !== null && call.ring.state === "ringing" && self.role === "callee") {
        setCallRing(call.id, {
          ...call.ring,
          state: "accepted",
          respondedAt: new Date().toISOString(),
        });
      }

      if (call.state === "created") setCallState(call.id, "active");
      // A join is the only proof the backend ever gets that somebody is in this
      // room, so it must count as activity even when the call was already
      // `active` — otherwise the second person to arrive leaves no trace and
      // the lifetime reaper measures from before the call really started.
      touchCall(call.id);

      const { role: _selfRole, ...selfInfo } = self;
      const { role: _peerRole, ...peerInfo } = peer;

      const response: JoinResponse = {
        token,
        livekitUrl: cfg.livekitUrl,
        roomName: call.roomName,
        callId: call.id,
        mode: call.mode,
        self: selfInfo,
        peer: peerInfo,
        agentIdentity: call.mode === "DIRECT" ? null : AGENT_IDENTITY,
        expectedAgentTrackName: call.mode === "DIRECT" ? null : agentTrackNameFor(self.userId),
        ttlSeconds: cfg.tokenTtlSeconds,
      };

      req.log.info({ callId: call.id, userId: self.userId, mode: call.mode }, "join token minted");
      return response;
    });

    app.post("/api/calls/:callId/mode", async (req, reply) => {
      const params = parse(callParams, req.params, reply, "path");
      if (!params) return reply;
      const body = parse(modeBody, req.body, reply, "body");
      if (!body) return reply;

      const call = getCall(params.callId);
      if (!call) return reply.code(404).send(apiError("not_found", `call ${params.callId} does not exist`));
      if (!callParticipant(call, body.userId)) {
        return reply
          .code(403)
          .send(apiError("forbidden", `user ${body.userId} is not a participant of call ${call.id}`));
      }
      if (call.state !== "created") {
        return reply
          .code(409)
          .send(
            apiError(
              "mode_locked",
              `call ${call.id} is ${call.state}; Stage 0 does not support live mode switching`,
            ),
          );
      }

      const caller = call.participants.find((p) => p.role === "caller")!;
      const callee = call.participants.find((p) => p.role === "callee")!;
      const resolved = resolveCall(caller.userId, callee.userId, body.force)!;

      const wasDispatched = call.agent.dispatched;
      // The recomputed lang/gender/tone must land on the call too: they are what
      // the agent job and every later join response are built from. Dropping them
      // would leave the mode saying TRANSLATED while the participants still carry
      // the languages the call was created with.
      setCallParticipants(call.id, resolved.participants);
      setCallMode(call.id, resolved.mode, resolved.reason);

      if (resolved.mode === "DIRECT") {
        if (wasDispatched) await stopAgent(cfg, call.id);
        setCallAgent(call.id, { required: false, dispatched: false, identity: null, error: null });
      } else {
        await dispatchForCall(cfg, call);
      }

      const updated = getCall(call.id)!;
      req.log.info({ callId: call.id, mode: updated.mode, reason: updated.reason }, "call mode recomputed");
      return { call: updated, ring: toRingView(updated, Date.now()) };
    });

    app.post("/api/calls/:callId/end", async (req, reply) => {
      const params = parse(callParams, req.params, reply, "path");
      if (!params) return reply;
      const body = parse(userOnlyBody, req.body, reply, "body");
      if (!body) return reply;

      const call = getCall(params.callId);
      if (!call) return reply.code(404).send(apiError("not_found", `call ${params.callId} does not exist`));
      const self = callParticipant(call, body.userId);
      if (!self) {
        return reply
          .code(403)
          .send(apiError("forbidden", `user ${body.userId} is not a participant of call ${call.id}`));
      }

      // Hanging up on a call that is still ringing is a cancel (by the caller) or a
      // decline (by the callee). Routing it through endRing keeps ONE code path
      // responsible for stopping the agent, so no exit can leak one.
      //
      // `state === "created"` is what makes this "still ringing" rather than
      // "ever rang": the ring stays `accepted` for the WHOLE duration of an
      // answered call, so without this guard a normal hang-up on a live,
      // fully-conducted call would relabel it `cancelled`/`declined` and
      // overwrite `respondedAt` — losing the accept timestamp and making a
      // completed call indistinguishable from a refused one in the record.
      // This is the same boundary dueRingCalls() draws: once anyone joins, the
      // call is live and the ring is history.
      if (
        call.state === "created" &&
        call.ring !== null &&
        (call.ring.state === "ringing" || call.ring.state === "accepted")
      ) {
        const updated = (await endRing(
          cfg,
          call.id,
          self.role === "caller" ? "cancelled" : "declined",
          req.log,
        ))!;
        req.log.info(
          { callId: call.id, by: self.userId, ringState: updated.ring?.state },
          "call ended while ringing",
        );
        return { call: updated, ring: toRingView(updated, Date.now()) };
      }

      const wasDispatched = call.agent.dispatched;
      setCallState(call.id, "ended");
      if (wasDispatched) {
        const stop = await stopAgent(cfg, call.id);
        // Clearing `dispatched` is what makes /end idempotent, exactly as endRing
        // already is: without it a second hang-up (double-clicked button, retry
        // after a flaky response) fires a second stop, and the ended call keeps
        // reporting an agent that is no longer in the room.
        setCallAgent(call.id, {
          ...call.agent,
          dispatched: false,
          error: stop.error ?? call.agent.error,
        });
        if (stop.error) req.log.warn({ callId: call.id, error: stop.error }, "agent stop failed");
      }

      const updated = getCall(call.id)!;
      req.log.info({ callId: call.id, endedAt: updated.endedAt }, "call ended");
      return { call: updated, ring: toRingView(updated, Date.now()) };
    });

    // -----------------------------------------------------------------------
    // Ringing
    // -----------------------------------------------------------------------

    /**
     * Shared guard for accept / decline / cancel. Returns the call, or null after
     * having sent the response. `expectRole` is who is allowed to press this button.
     */
    async function ringGuard(
      req: { params: unknown; body: unknown },
      reply: FastifyReply,
      expectRole: "caller" | "callee",
    ): Promise<{ call: Call; userId: string } | null> {
      const params = parse(callParams, req.params, reply, "path");
      if (!params) return null;
      const body = parse(userOnlyBody, req.body, reply, "body");
      if (!body) return null;

      await sweeper.sweep();
      const call = getCall(params.callId);
      if (!call) {
        reply.code(404).send(apiError("not_found", `call ${params.callId} does not exist`));
        return null;
      }
      if (call.ring === null) {
        reply
          .code(409)
          .send(apiError("ring_conflict", `call ${call.id} was created without a ring (invite-link call)`));
        return null;
      }
      const expected = expectRole === "caller" ? callCaller(call) : callCallee(call);
      if (expected.userId !== body.userId) {
        reply
          .code(403)
          .send(
            apiError(
              "forbidden",
              `only the ${expectRole} (${expected.userId}) may do this on call ${call.id}`,
            ),
          );
        return null;
      }
      return { call, userId: body.userId };
    }

    app.post("/api/calls/:callId/ring/accept", async (req, reply) => {
      const guard = await ringGuard(req, reply, "callee");
      if (!guard) return reply;
      const { call } = guard;
      const ring = call.ring!;

      // Double accept: the same callee pressing twice, or a retry after a flaky
      // response, must succeed rather than tell her the call she is already in
      // no longer exists.
      if (ring.state === "accepted") {
        return { call, ring: toRingView(call, Date.now()), alreadyAccepted: true };
      }
      if (ring.state !== "ringing" || call.state === "ended") {
        return reply
          .code(409)
          .send(
            apiError("ring_conflict", `call ${call.id} is no longer ringing (ring ${ring.state})`),
          );
      }

      const nowMs = Date.now();
      // The deadline is pushed forward, not cleared: an accepted call that nobody
      // ever joins would otherwise keep an agent sitting in a LiveKit room forever.
      const updated = setCallRing(call.id, {
        ...ring,
        state: "accepted",
        respondedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ring.timeoutSeconds * 1000).toISOString(),
      })!;
      req.log.info({ callId: call.id, by: guard.userId, mode: call.mode }, "ring accepted");
      return { call: updated, ring: toRingView(updated, nowMs), alreadyAccepted: false };
    });

    app.post("/api/calls/:callId/ring/decline", async (req, reply) => {
      const guard = await ringGuard(req, reply, "callee");
      if (!guard) return reply;
      const { call } = guard;
      const ring = call.ring!;

      if (ring.state === "declined") {
        return { call, ring: toRingView(call, Date.now()) };
      }
      if (ring.state !== "ringing") {
        return reply
          .code(409)
          .send(apiError("ring_conflict", `call ${call.id} is no longer ringing (ring ${ring.state})`));
      }

      const updated = (await endRing(cfg, call.id, "declined", req.log))!;
      req.log.info({ callId: call.id, by: guard.userId }, "ring declined");
      return { call: updated, ring: toRingView(updated, Date.now()) };
    });

    app.post("/api/calls/:callId/ring/cancel", async (req, reply) => {
      const guard = await ringGuard(req, reply, "caller");
      if (!guard) return reply;
      const { call } = guard;
      const ring = call.ring!;

      if (ring.state === "cancelled") {
        return { call, ring: toRingView(call, Date.now()) };
      }
      if (ring.state !== "ringing" && ring.state !== "accepted") {
        return reply
          .code(409)
          .send(apiError("ring_conflict", `call ${call.id} is no longer ringing (ring ${ring.state})`));
      }

      const updated = (await endRing(cfg, call.id, "cancelled", req.log))!;
      req.log.info({ callId: call.id, by: guard.userId }, "ring cancelled by caller");
      return { call: updated, ring: toRingView(updated, Date.now()) };
    });

    // -----------------------------------------------------------------------
    // Bilingual-judge verdict
    // -----------------------------------------------------------------------

    /**
     * The judge feature's whole value is that a WRONG label is trustworthy, so the
     * agent's answer is passed through rather than swallowed: if the label did not
     * land in the JSONL, the tester is told so while she still remembers what she heard.
     */
    app.post("/api/calls/:callId/verdict", async (req, reply) => {
      const params = parse(callParams, req.params, reply, "path");
      if (!params) return reply;
      const body = parse(verdictBody, req.body, reply, "body");
      if (!body) return reply;

      const call = getCall(params.callId);
      if (!call) return reply.code(404).send(apiError("not_found", `call ${params.callId} does not exist`));
      if (!callParticipant(call, body.userId)) {
        return reply
          .code(403)
          .send(apiError("forbidden", `user ${body.userId} is not a participant of call ${call.id}`));
      }
      if (call.mode === "DIRECT") {
        return reply
          .code(409)
          .send(
            apiError(
              "no_agent",
              `call ${call.id} is DIRECT — nothing was translated, so there is nothing to judge`,
            ),
          );
      }
      if (!call.agent.dispatched) {
        return reply
          .code(409)
          .send(
            apiError(
              "no_agent",
              `no agent was running for call ${call.id}${call.agent.error ? ` (${call.agent.error})` : ""} — no utterance was logged`,
            ),
          );
      }

      const payload: AgentVerdict = {
        callId: call.id,
        userId: body.userId,
        verdict: body.verdict,
        utteranceId: body.utteranceId ?? null,
        expected: body.expected ?? null,
        note: body.note ?? null,
        receivedAt: new Date().toISOString(),
      };

      // Somebody is listening closely enough to grade a translation: the call
      // is alive, whatever its last request looked like.
      touchCall(call.id);
      const outcome = await sendVerdict(cfg, payload);
      if (!outcome.ok) {
        const status = outcome.kind === "not_found" ? 404 : 502;
        const code = outcome.kind === "not_found" ? "not_found" : "agent_unreachable";
        req.log.warn({ callId: call.id, error: outcome.error }, "verdict not recorded");
        return reply.code(status).send(apiError(code, outcome.error));
      }

      req.log.info(
        { callId: call.id, by: body.userId, verdict: body.verdict, utteranceId: payload.utteranceId },
        "judge verdict forwarded to the agent",
      );
      return { ok: true, callId: call.id, verdict: body.verdict, agent: outcome.body };
    });
  };
}
