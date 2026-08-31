import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { requireActor, requireSelf } from "../auth.js";
import type { Config } from "../config.js";
import { RING_RESULT_GRACE_MS, toRingView, type CallSweeper } from "../ringing.js";
import {
  dropPresence,
  findIncomingRing,
  findOutgoingRing,
  getPresence,
  getUser,
  listContacts,
  touchPresence,
} from "../store.js";
import { apiError, USER_ID_RE, type PresenceView, type RingPollResponse } from "../types.js";

const userIdSchema = z.string().regex(USER_ID_RE, "must match ^u_[a-z0-9_]{1,30}$");
const userParams = z.object({ userId: userIdSchema });

const heartbeatBody = z
  .object({
    userId: userIdSchema,
    /** false is an explicit goodbye (tab close / navigator.sendBeacon on unload). */
    online: z.boolean().default(true),
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

function presenceView(cfg: Config, userId: string, nowMs: number): PresenceView {
  const record = getPresence(userId);
  const ttlMs = cfg.presenceTtlSeconds * 1000;
  return {
    userId,
    online: record !== undefined && nowMs - record.lastSeenMs <= ttlMs,
    lastSeenAt: record === undefined ? null : new Date(record.lastSeenMs).toISOString(),
    ttlSeconds: cfg.presenceTtlSeconds,
  };
}

/**
 * Builds the one payload both poll endpoints return. Presence and ringing are
 * answered together on purpose: the client that must heartbeat is exactly the
 * client that must learn about an incoming call, so making it two polls would
 * double the request rate for nothing.
 */
function poll(cfg: Config, userId: string, nowMs: number): RingPollResponse {
  const incoming = findIncomingRing(userId, nowMs);
  const outgoing = findOutgoingRing(userId, nowMs, RING_RESULT_GRACE_MS);
  return {
    now: new Date(nowMs).toISOString(),
    self: presenceView(cfg, userId, nowMs),
    peers: listContacts(userId).map((c) => presenceView(cfg, c.contactUserId, nowMs)),
    incoming: incoming === undefined ? null : toRingView(incoming, nowMs),
    outgoing: outgoing === undefined ? null : toRingView(outgoing, nowMs),
    pollIntervalMs: cfg.presencePollIntervalMs,
  };
}

export function presenceRoutes(cfg: Config, sweeper: CallSweeper): FastifyPluginAsync {
  return async (app) => {
    app.post("/api/presence", async (req, reply) => {
      if (requireActor(req, reply) === null) return reply;
      const body = parse(heartbeatBody, req.body, reply, "body");
      if (!body) return reply;
      // The heartbeat is also the ring poll, so an unchecked userId here handed
      // out somebody else's incoming calls — caller name included — at two
      // requests a second.
      if (!requireSelf(req, reply, body.userId)) return reply;
      if (!getUser(body.userId)) {
        return reply.code(404).send(apiError("not_found", `user ${body.userId} does not exist`));
      }

      // Sweep BEFORE answering: a heartbeat is the most frequent request in the
      // system, so it is also the most reliable moment to notice a dead ring.
      await sweeper.sweep();

      const nowMs = Date.now();
      if (body.online) touchPresence(body.userId, nowMs);
      else dropPresence(body.userId);

      return poll(cfg, body.userId, nowMs);
    });

    /** Same payload, no side effect — for a client that wants to look without claiming to be online. */
    app.get("/api/ring/:userId", async (req, reply) => {
      if (requireActor(req, reply) === null) return reply;
      const params = parse(userParams, req.params, reply, "path");
      if (!params) return reply;
      if (!requireSelf(req, reply, params.userId)) return reply;
      if (!getUser(params.userId)) {
        return reply.code(404).send(apiError("not_found", `user ${params.userId} does not exist`));
      }
      await sweeper.sweep();
      return poll(cfg, params.userId, Date.now());
    });
  };
}
