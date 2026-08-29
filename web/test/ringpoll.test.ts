import { describe, expect, it } from 'vitest';
import { RingPoller } from '../src/ringpoll';
import { RING_POLL_IDLE_MS, RING_POLL_MIN_MS, type RingState } from '../src/ring';
import type { RingPollResponse, RingView } from '../src/types';

/** Minimal deterministic timer queue: run() fires whatever is due, in order. */
class FakeClock {
  private handle = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  now = 0;

  set = (fn: () => void, ms: number): number => {
    this.handle += 1;
    this.timers.set(this.handle, { at: this.now + ms, fn });
    return this.handle;
  };

  clear = (handle: number): void => {
    this.timers.delete(handle);
  };

  get pending(): number {
    return this.timers.size;
  }

  /** Advance to the next due timer and fire it. Returns false when idle. */
  tick(): boolean {
    let nextId: number | null = null;
    let nextAt = Number.POSITIVE_INFINITY;
    for (const [id, timer] of this.timers) {
      if (timer.at < nextAt) {
        nextAt = timer.at;
        nextId = id;
      }
    }
    if (nextId === null) return false;
    const timer = this.timers.get(nextId)!;
    this.timers.delete(nextId);
    this.now = timer.at;
    timer.fn();
    return true;
  }
}

const OFFER: RingView = {
  callId: 'c_1',
  roomName: 'call-c_1',
  mode: 'TRANSLATED',
  reason: 'languages_differ',
  ringState: 'ringing',
  callState: 'created',
  from: { userId: 'u_alex', displayName: 'Alex', lang: 'ru', gender: 'm', tone: 'neutral' },
  to: { userId: 'u_noa', displayName: 'Noa', lang: 'he', gender: 'f', tone: 'friendly' },
  startedAt: '2026-08-23T10:00:00.000Z',
  expiresAt: '2026-08-23T10:00:45.000Z',
  respondedAt: null,
  secondsRemaining: 40,
};

function response(incoming: RingView | null): RingPollResponse {
  return {
    now: '2026-08-23T10:00:01.000Z',
    self: { userId: 'u_noa', online: true, lastSeenAt: null, ttlSeconds: 15 },
    peers: [],
    incoming,
    outgoing: null,
    pollIntervalMs: 2000,
  };
}

function build(poll: () => Promise<RingPollResponse>, isUnsupported = () => false) {
  const clock = new FakeClock();
  const states: RingState[] = [];
  const poller = new RingPoller({
    poll,
    isUnsupported,
    onState: (s) => states.push(s),
    setTimer: clock.set,
    clearTimer: clock.clear,
  });
  return { clock, states, poller };
}

/** Fire timers until the queue drains or `limit` is hit, letting promises settle. */
async function drain(clock: FakeClock, limit = 20): Promise<number> {
  let fired = 0;
  while (fired < limit && clock.tick()) {
    fired += 1;
    await Promise.resolve();
    await Promise.resolve();
  }
  return fired;
}

describe('RingPoller', () => {
  it('polls, reports a ring, and keeps a timer armed', async () => {
    let calls = 0;
    const { clock, states, poller } = build(async () => {
      calls += 1;
      return response(calls === 1 ? null : OFFER);
    });
    poller.start();
    await drain(clock, 2);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(poller.current.phase).toBe('ringing');
    expect(states.at(-1)?.call?.callId).toBe('c_1');
    expect(clock.pending).toBe(1);
    poller.stop();
    expect(clock.pending).toBe(0);
  });

  it('never schedules faster than the floor, even while failing', async () => {
    const gaps: number[] = [];
    const clock = new FakeClock();
    let last = 0;
    const poller = new RingPoller({
      poll: async () => {
        gaps.push(clock.now - last);
        last = clock.now;
        throw new Error('backend down');
      },
      isUnsupported: () => false,
      onState: () => undefined,
      setTimer: clock.set,
      clearTimer: clock.clear,
    });
    poller.start();
    await drain(clock, 8);
    // The first poll is immediate; every one after it respects the floor and
    // grows, so a dead backend can never be hammered.
    expect(gaps.slice(1).every((gap) => gap >= RING_POLL_MIN_MS)).toBe(true);
    expect(gaps.at(-1)!).toBeGreaterThan(RING_POLL_IDLE_MS);
    poller.stop();
  });

  it('stops for good when the backend has no ringing routes', async () => {
    let calls = 0;
    const { clock, poller } = build(
      async () => {
        calls += 1;
        throw new Error('Route POST:/api/presence not found');
      },
      () => true,
    );
    poller.start();
    await drain(clock);
    expect(calls).toBe(1);
    expect(poller.current.supported).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it('does not poll while suspended and resumes on demand', async () => {
    let calls = 0;
    const { clock, poller } = build(async () => {
      calls += 1;
      return response(null);
    });
    poller.start();
    await drain(clock, 1);
    expect(calls).toBe(1);

    poller.dispatch({ type: 'suspend' });
    expect(clock.pending).toBe(0);
    await drain(clock, 5);
    expect(calls).toBe(1);

    poller.dispatch({ type: 'resume' });
    await drain(clock, 1);
    expect(calls).toBe(2);
    poller.stop();
  });

  it('discards a poll that resolves after stop()', async () => {
    let release: (value: RingPollResponse) => void = () => undefined;
    const { clock, states, poller } = build(
      () => new Promise<RingPollResponse>((resolve) => (release = resolve)),
    );
    poller.start();
    clock.tick(); // start the in-flight request
    poller.stop();
    release(response(OFFER));
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toHaveLength(0);
    expect(poller.current.phase).toBe('idle');
    expect(clock.pending).toBe(0);
  });

  it('keeps at most one request in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { clock, poller } = build(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return response(null);
    });
    poller.start();
    poller.wake();
    poller.wake();
    await drain(clock, 6);
    expect(maxInFlight).toBe(1);
    poller.stop();
  });
});
