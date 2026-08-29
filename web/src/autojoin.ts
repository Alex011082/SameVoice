/**
 * The gate in front of "the callee answered, join the room without asking".
 *
 * Auto-join is triggered from the paint path, which runs on every poll, so a
 * join that keeps failing would be retried at the poll rate — measured at ~20
 * requests/second per client against our own backend. Attempts are therefore
 * capped and spaced per call id.
 *
 * Two more rules came out of the failed two-person test on 25.08.2026, where a
 * call created at 17:48 the previous day was still live the next morning:
 *
 *   - a call id the backend has answered 409/404 for is DEAD to this tab. It is
 *     never retried, however many times the poll keeps offering it — the answer
 *     to "that call is over" is not to ask again;
 *   - a ring this tab did not place and whose deadline has already passed is a
 *     leftover from an earlier session. Joining it silently puts this client in
 *     a room nobody else is in, which is exactly what happened: both testers
 *     had a working pipeline and heard nothing, because they were not in the
 *     same room. A ring still inside its window is fine — that is the caller
 *     who reloaded the page mid-ring, and he should still be connected.
 *
 * No DOM, no timers, no fetch: pure decisions, so web/test/autojoin.test.ts can
 * drive the whole thing on a fake clock.
 */

export const AUTO_JOIN_MAX_ATTEMPTS = 3;
export const AUTO_JOIN_BACKOFF_MS = [0, 1000, 3000];

/** Remembering every id forever is pointless; a tab makes a handful of calls. */
const MAX_REMEMBERED_IDS = 50;

export type AutoJoinVerdict =
  /** Join now. */
  | 'go'
  /** Too soon after the last attempt; the next poll will ask again. */
  | 'wait'
  /** The attempt cap is spent. Returned exactly once per call id, so the caller
   *  can tell the user without needing a "did I already say this" flag. */
  | 'exhausted'
  /** Never join this one: it is over, or it belongs to a session that is. */
  | 'stale';

/** The part of a RingView this decision needs. */
export interface AutoJoinRing {
  callId: string;
  /** Server-computed and clamped at 0, so no clock-skew maths happens here. */
  secondsRemaining: number;
}

function remember(ids: Set<string>, id: string): void {
  ids.add(id);
  // Sets iterate in insertion order, so this drops the oldest.
  while (ids.size > MAX_REMEMBERED_IDS) ids.delete(ids.values().next().value as string);
}

export class AutoJoinGate {
  private readonly now: () => number;
  private readonly placed = new Set<string>();
  private readonly abandoned = new Set<string>();
  private callId: string | null = null;
  private attempts = 0;
  private lastAt = 0;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** This tab placed this call. Its answer is worth joining even after a reload. */
  place(callId: string): void {
    remember(this.placed, callId);
  }

  /** The backend says this call is gone. Stop asking, for good. */
  abandon(callId: string): void {
    remember(this.abandoned, callId);
  }

  isAbandoned(callId: string): boolean {
    return this.abandoned.has(callId);
  }

  decide(ring: AutoJoinRing): AutoJoinVerdict {
    const callId = ring.callId;
    if (this.abandoned.has(callId)) return 'stale';
    if (!this.placed.has(callId) && ring.secondsRemaining <= 0) {
      // Not ours and past its deadline: a ghost from a previous session.
      this.abandon(callId);
      return 'stale';
    }

    if (callId !== this.callId) {
      this.callId = callId;
      this.attempts = 0;
      this.lastAt = 0;
    }
    if (this.attempts >= AUTO_JOIN_MAX_ATTEMPTS) {
      // Giving up is permanent for this id, which is what makes 'exhausted'
      // fire exactly once: every later poll sees it abandoned.
      this.abandon(callId);
      return 'exhausted';
    }
    const wait = AUTO_JOIN_BACKOFF_MS[this.attempts] ?? 3000;
    if (this.lastAt !== 0 && this.now() - this.lastAt < wait) return 'wait';
    this.attempts += 1;
    this.lastAt = this.now();
    return 'go';
  }
}
