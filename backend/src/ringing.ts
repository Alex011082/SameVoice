import type { FastifyBaseLogger } from "fastify";
import { stopAgent } from "./agentClient.js";
import type { CallArchive } from "./archive.js";
import type { Config } from "./config.js";
import {
  archivableCalls,
  callCallee,
  callCaller,
  deadCalls,
  dueRingCalls,
  forgetCalls,
  getCall,
  setCallAgent,
  setCallState,
  setRingState,
  type ArchiveLimits,
  type CallLifetimeLimits,
} from "./store.js";
import type { Call, CallRing, RingState, RingView } from "./types.js";

/**
 * How long a finished ring keeps showing up in the CALLER's poll. Without it the
 * ring would just vanish from the caller's screen and "she declined" would be
 * indistinguishable from "the network dropped".
 */
export const RING_RESULT_GRACE_MS = 20_000;

export function newRing(timeoutSeconds: number, nowMs: number): CallRing {
  return {
    state: "ringing",
    startedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + timeoutSeconds * 1000).toISOString(),
    respondedAt: null,
    timeoutSeconds,
  };
}

export function toRingView(call: Call, nowMs: number): RingView | null {
  if (call.ring === null) return null;
  const { role: _fromRole, ...from } = callCaller(call);
  const { role: _toRole, ...to } = callCallee(call);
  return {
    callId: call.id,
    roomName: call.roomName,
    mode: call.mode,
    reason: call.reason,
    ringState: call.ring.state,
    callState: call.state,
    from,
    to,
    startedAt: call.ring.startedAt,
    expiresAt: call.ring.expiresAt,
    respondedAt: call.ring.respondedAt,
    secondsRemaining: Math.max(0, Math.round((Date.parse(call.ring.expiresAt) - nowMs) / 1000)),
  };
}

/**
 * The single place a ring stops without being answered. Decline, cancel and
 * timeout differ only in the label: all three end the call and, critically, stop
 * the agent — an agent left in a room after a declined ring is a silent leak of
 * both LiveKit participant-minutes and vendor STT minutes.
 *
 * Idempotent: a second call with an already-ended ring is a no-op, which is what
 * makes the decline-vs-cancel and decline-vs-timeout races harmless.
 */
export async function endRing(
  cfg: Config,
  callId: string,
  state: Exclude<RingState, "ringing" | "accepted">,
  log?: FastifyBaseLogger,
): Promise<Call | undefined> {
  const call = getCall(callId);
  if (!call) return undefined;

  const nowIso = new Date().toISOString();
  if (call.ring !== null && (call.ring.state === "ringing" || call.ring.state === "accepted")) {
    setRingState(callId, state, nowIso);
  }
  await endCallReleasingAgent(cfg, call, state, log);
  return getCall(callId);
}

/**
 * End a call and release whatever agent it holds. The ring paths and the
 * lifetime reaper both go through here so that neither can grow its own,
 * subtly different, version of "and stop the agent too".
 *
 * Idempotent: a call that is already ended with no dispatched agent is a no-op.
 */
async function endCallReleasingAgent(
  cfg: Config,
  call: Call,
  why: string,
  log?: FastifyBaseLogger,
): Promise<void> {
  if (call.state !== "ended") setCallState(call.id, "ended");
  if (!call.agent.dispatched) return;
  const stop = await stopAgent(cfg, call.id);
  setCallAgent(call.id, {
    ...call.agent,
    dispatched: false,
    error: stop.error ?? call.agent.error,
  });
  if (stop.error) log?.warn({ callId: call.id, why, error: stop.error }, "agent stop failed");
}

/**
 * Bounds on how long a call may live and how long the store remembers a dead
 * one. Deliberately generous: their job is to make sure nothing is immortal,
 * not to cut anybody's conversation short. See the "Call lifetime" section of
 * store.ts for why the backend cannot do better than a timer here.
 */
export const CALL_LIFETIME_LIMITS: CallLifetimeLimits = {
  // Long enough that an invite link pasted into a chat still works when it is
  // opened; short enough that yesterday's unanswered call is not still around
  // this morning for a client to latch onto.
  idleMs: 10 * 60_000,
  // A joined call nobody hung up. Three hours is well past any real call and
  // well short of the 15 hours c_f74783a70042 survived.
  maxLifetimeMs: 3 * 60 * 60_000,
};

export const CALL_ARCHIVE_LIMITS: ArchiveLimits = {
  // The call is over the moment it ends; this window only decides how long the
  // record stays reachable through the ordinary call route before it moves to
  // the archive. Comfortably longer than RING_RESULT_GRACE_MS, so a client can
  // still be told why its call ended.
  archiveAfterMs: 10 * 60_000,
  maxCalls: 500,
};

/**
 * End every call that has outlived its bounds, releasing any agent it holds.
 * Exported (and taking `nowMs`) so tests can age a call without sleeping.
 */
export async function reapDeadCalls(
  cfg: Config,
  nowMs: number,
  log?: FastifyBaseLogger,
  limits: CallLifetimeLimits = CALL_LIFETIME_LIMITS,
): Promise<Call[]> {
  const dead = deadCalls(nowMs, limits);
  for (const { call, reason } of dead) {
    log?.info(
      {
        callId: call.id,
        reason,
        callState: call.state,
        createdAt: call.createdAt,
        lastActivityAt: call.lastActivityAt,
        agentDispatched: call.agent.dispatched,
      },
      "call outlived its bounds — ending it",
    );
    await endCallReleasingAgent(cfg, call, reason, log);
  }
  return dead.map((d) => d.call);
}

export interface CallSweeper {
  /** Expire overdue rings, reap dead calls, forget old ones. A no-op when nothing is due. */
  sweep(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * Expiry is enforced two ways on purpose:
 *   - lazily, at the top of every ring-facing handler, so a poll can never observe
 *     a ring that should already be dead (no clock-skew window, no stale Accept);
 *   - by a background interval, so an abandoned ring still releases its agent even
 *     when both browsers have gone away and nobody is polling at all.
 * The interval is unref'd, so it never keeps the process (or `node --test`) alive.
 *
 * The same pass owns call lifetime, because "a call nobody is in" and "a ring
 * nobody answered" are the same kind of debt and must not be collected by two
 * mechanisms that can disagree about which calls exist.
 */
export function createCallSweeper(
  cfg: Config,
  log: FastifyBaseLogger,
  archive: CallArchive,
  intervalMs = 1000,
  limits: CallLifetimeLimits & ArchiveLimits = { ...CALL_LIFETIME_LIMITS, ...CALL_ARCHIVE_LIMITS },
): CallSweeper {
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  async function run(): Promise<void> {
    const nowMs = Date.now();
    const due = dueRingCalls(nowMs);
    for (const call of due) {
      log.info(
        { callId: call.id, ringState: call.ring?.state, agentDispatched: call.agent.dispatched },
        "ring expired — ending call",
      );
      await endRing(cfg, call.id, "timeout", log);
    }

    await reapDeadCalls(cfg, nowMs, log, limits);

    // Archiving runs last: a call this pass just ended is inside its window, so
    // it is still queryable and the client that lost it can still be told why.
    //
    // Written first, forgotten second. A finished call is a record two people
    // are entitled to, so it only leaves memory once it is safely on disk; if
    // the write fails it stays where it is and comes round again next pass.
    const stored: string[] = [];
    for (const call of archivableCalls(nowMs, limits)) {
      if (await archive.put(call)) stored.push(call.id);
    }
    if (stored.length > 0) {
      forgetCalls(stored);
      log.info({ count: stored.length, callIds: stored.slice(0, 10) }, "calls moved to the archive");
    }
  }

  // Collapse concurrent sweeps: two polls arriving together must not both try to
  // expire (and both try to stop the agent for) the same call.
  function sweep(): Promise<void> {
    if (inFlight === null) {
      inFlight = run().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    sweep,
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => void sweep(), intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
