import { describe, expect, it } from 'vitest';
import {
  AutoJoinGate,
  AUTO_JOIN_BACKOFF_MS,
  AUTO_JOIN_MAX_ATTEMPTS,
  type AutoJoinRing,
} from '../src/autojoin';
import { initialRingState, ringReducer, type RingState } from '../src/ring';
import type { RingView } from '../src/types';

/** A clock the test moves by hand; the gate never reads the real one. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1000;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

const LIVE: AutoJoinRing = { callId: 'c_aaaaaaaaaaaa', secondsRemaining: 30 };
/** The shape of the 25.08.2026 ghost: answered yesterday, deadline long gone. */
const GHOST: AutoJoinRing = { callId: 'c_f74783a70042', secondsRemaining: 0 };

describe('AutoJoinGate', () => {
  it('joins a call this tab placed, then backs off instead of retrying at the poll rate', () => {
    const t = clock();
    const gate = new AutoJoinGate(t.now);
    gate.place(LIVE.callId);

    expect(gate.decide(LIVE)).toBe('go');
    expect(gate.decide(LIVE)).toBe('wait');

    t.advance(AUTO_JOIN_BACKOFF_MS[1]!);
    expect(gate.decide(LIVE)).toBe('go');
    t.advance(AUTO_JOIN_BACKOFF_MS[2]!);
    expect(gate.decide(LIVE)).toBe('go');
    expect(AUTO_JOIN_MAX_ATTEMPTS).toBe(3);

    // The cap is spent. It is announced exactly once, so the caller needs no
    // "have I already said this" flag, and never retried afterwards.
    t.advance(60_000);
    expect(gate.decide(LIVE)).toBe('exhausted');
    expect(gate.decide(LIVE)).toBe('stale');
  });

  it('gives up on a call id the moment the backend answers 409', () => {
    const t = clock();
    const gate = new AutoJoinGate(t.now);
    gate.place(LIVE.callId);
    expect(gate.decide(LIVE)).toBe('go');

    // POST /join came back 409: that call has already ended.
    gate.abandon(LIVE.callId);

    expect(gate.isAbandoned(LIVE.callId)).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      t.advance(10_000);
      expect(gate.decide(LIVE)).toBe('stale');
    }
  });

  it('never resurrects a ring from a previous session', () => {
    const gate = new AutoJoinGate(clock().now);
    // Nothing was placed by this tab: the page was just loaded and the backend
    // is still offering an accepted ring from yesterday.
    expect(gate.decide(GHOST)).toBe('stale');
    expect(gate.isAbandoned(GHOST.callId)).toBe(true);
  });

  it('still joins for a caller who reloaded the page mid-ring', () => {
    const gate = new AutoJoinGate(clock().now);
    // Not placed by this page load, but the ring is alive: this is the caller
    // whose tab reloaded while it was ringing, and he must still be connected.
    expect(gate.decide({ callId: 'c_bbbbbbbbbbbb', secondsRemaining: 12 })).toBe('go');
  });

  it('keeps its per-call ids apart', () => {
    const t = clock();
    const gate = new AutoJoinGate(t.now);
    gate.place('c_cccccccccccc');
    gate.place('c_dddddddddddd');
    expect(gate.decide({ callId: 'c_cccccccccccc', secondsRemaining: 30 })).toBe('go');
    // A different call is a fresh budget, not the tail of the previous one.
    expect(gate.decide({ callId: 'c_dddddddddddd', secondsRemaining: 30 })).toBe('go');
    gate.abandon('c_cccccccccccc');
    expect(gate.isAbandoned('c_dddddddddddd')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The other half of "give up": the poll must stop offering the call.
// ---------------------------------------------------------------------------

function outgoing(callId: string): RingView {
  return {
    callId,
    roomName: `call-${callId}`,
    mode: 'TRANSLATED',
    reason: 'languages_differ',
    ringState: 'accepted',
    callState: 'active',
    from: { userId: 'u_alex', displayName: 'Alex', lang: 'ru', gender: 'm', tone: 'neutral' },
    to: { userId: 'u_noa', displayName: 'Noa', lang: 'he', gender: 'f', tone: 'friendly' },
    startedAt: '2026-08-24T17:48:00.000Z',
    expiresAt: '2026-08-24T17:48:45.000Z',
    respondedAt: '2026-08-24T17:48:10.000Z',
    secondsRemaining: 0,
  };
}

describe('outgoing_abandon', () => {
  it('marks the call handled so the next poll cannot offer it again', () => {
    const answered: RingState = ringReducer(initialRingState, {
      type: 'polled',
      poll: {
        now: '2026-08-25T08:38:00.000Z',
        self: { userId: 'u_alex', online: true, lastSeenAt: null, ttlSeconds: 15 },
        peers: [],
        incoming: null,
        outgoing: outgoing('c_f74783a70042'),
        pollIntervalMs: 2000,
      },
    });
    expect(answered.outgoingPhase).toBe('answered');

    const abandoned = ringReducer(answered, { type: 'outgoing_abandon' });
    expect(abandoned.outgoingPhase).toBe('idle');
    expect(abandoned.outgoing).toBe(null);
    // No epitaph: the user never placed this call, so there is nothing to tell them.
    expect(abandoned.outgoingClosed).toBe(null);

    const polledAgain = ringReducer(abandoned, {
      type: 'polled',
      poll: {
        now: '2026-08-25T08:38:02.000Z',
        self: { userId: 'u_alex', online: true, lastSeenAt: null, ttlSeconds: 15 },
        peers: [],
        incoming: null,
        outgoing: outgoing('c_f74783a70042'),
        pollIntervalMs: 2000,
      },
    });
    expect(polledAgain.outgoingPhase).toBe('idle');
  });
});
