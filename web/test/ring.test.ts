import { describe, expect, it } from 'vitest';
import {
  initialRingState,
  outgoingText,
  ringPollDelayMs,
  ringReducer,
  RING_FAILURES_BEFORE_VISIBLE,
  RING_POLL_ACTIVE_MS,
  RING_POLL_HIDDEN_MS,
  RING_POLL_IDLE_MS,
  RING_POLL_MAX_MS,
  RING_POLL_MIN_MS,
  type RingEvent,
  type RingState,
} from '../src/ring';
import { parseRingPoll, parseRingView } from '../src/types';
import type { RingLifecycle, RingPollResponse, RingView } from '../src/types';

const ALEX = { userId: 'u_alex', displayName: 'Alex', lang: 'ru', gender: 'm', tone: 'neutral' } as const;
const NOA = { userId: 'u_noa', displayName: 'Noa', lang: 'he', gender: 'f', tone: 'friendly' } as const;

function ring(callId: string, ringState: RingLifecycle = 'ringing'): RingView {
  return {
    callId,
    roomName: `call-${callId}`,
    mode: 'TRANSLATED',
    reason: 'languages_differ',
    ringState,
    callState: ringState === 'ringing' ? 'created' : 'active',
    from: { ...ALEX },
    to: { ...NOA },
    startedAt: '2026-08-23T10:00:00.000Z',
    expiresAt: '2026-08-23T10:00:45.000Z',
    respondedAt: null,
    secondsRemaining: 42,
  };
}

function poll(over: Partial<RingPollResponse> = {}): RingPollResponse {
  return {
    now: '2026-08-23T10:00:01.000Z',
    self: { userId: 'u_noa', online: true, lastSeenAt: null, ttlSeconds: 15 },
    peers: [],
    incoming: null,
    outgoing: null,
    pollIntervalMs: 2000,
    ...over,
  };
}

const polled = (over: Partial<RingPollResponse> = {}): RingEvent => ({
  type: 'polled',
  poll: poll(over),
});

function run(events: RingEvent[], from: RingState = initialRingState): RingState {
  return events.reduce(ringReducer, from);
}

describe('ringReducer — incoming', () => {
  it('rings when an offer appears', () => {
    const state = run([polled({ incoming: ring('c_1') })]);
    expect(state.phase).toBe('ringing');
    expect(state.call?.from.displayName).toBe('Alex');
  });

  it('returns the identical object when nothing is happening, so no repaint runs', () => {
    expect(ringReducer(initialRingState, polled())).toBe(initialRingState);
  });

  it('closes with caller_cancelled when the caller hangs up mid-ring', () => {
    const state = run([polled({ incoming: ring('c_1') }), polled()]);
    expect(state.phase).toBe('closed');
    expect(state.closed).toBe('caller_cancelled');
    expect(state.handledCallId).toBe('c_1');
  });

  it('treats a non-ringing incoming state as the ring being over', () => {
    const state = run([
      polled({ incoming: ring('c_1') }),
      polled({ incoming: ring('c_1', 'timeout') }),
    ]);
    expect(state.phase).toBe('closed');
    expect(state.closed).toBe('caller_cancelled');
  });

  it('does not ring again for a call it already handled', () => {
    const state = run([
      polled({ incoming: ring('c_1') }),
      { type: 'decline' },
      { type: 'declined' },
      { type: 'dismiss' },
      polled({ incoming: ring('c_1') }),
    ]);
    expect(state.phase).toBe('idle');
  });

  it('rings for a genuinely new call after one was declined', () => {
    const state = run([
      polled({ incoming: ring('c_1') }),
      { type: 'decline' },
      { type: 'declined' },
      polled({ incoming: ring('c_2') }),
    ]);
    expect(state.phase).toBe('ringing');
    expect(state.call?.callId).toBe('c_2');
  });

  it('refreshes the countdown in place rather than restarting the ring', () => {
    const later = { ...ring('c_1'), secondsRemaining: 12 };
    const state = run([polled({ incoming: ring('c_1') }), polled({ incoming: later })]);
    expect(state.phase).toBe('ringing');
    expect(state.call?.secondsRemaining).toBe(12);
  });

  it('does not let a poll landing mid-accept undo the press', () => {
    const state = run([polled({ incoming: ring('c_1') }), { type: 'accept' }, polled()]);
    expect(state.phase).toBe('accepting');
    expect(state.call?.callId).toBe('c_1');
  });

  it('reports "already over" when accepting a call that ended', () => {
    const state = run([
      polled({ incoming: ring('c_1') }),
      { type: 'accept' },
      { type: 'accept_failed', code: 'ring_conflict', message: 'no longer ringing' },
    ]);
    expect(state.phase).toBe('closed');
    expect(state.closed).toBe('already_ended');
    expect(state.handledCallId).toBe('c_1');
  });

  it('lets the user retry after a transient accept failure', () => {
    const state = run([
      polled({ incoming: ring('c_1') }),
      { type: 'accept' },
      { type: 'accept_failed', code: 'network', message: 'backend unreachable' },
    ]);
    expect(state.phase).toBe('ringing');
    expect(state.error).toBe('backend unreachable');
    expect(state.handledCallId).toBeNull();
  });

  it('honours a decline locally even when the request failed', () => {
    const state = run([
      polled({ incoming: ring('c_1') }),
      { type: 'decline' },
      { type: 'decline_failed', message: 'offline' },
    ]);
    expect(state.phase).toBe('closed');
    expect(state.closed).toBe('declined');
    expect(state.handledCallId).toBe('c_1');
    expect(state.error).toBe('offline');
  });

  it('marks an accepted call handled even though suspend came first', () => {
    // enterCall() suspends polling before the accept resolves; the call must
    // survive that so 'accepted' can record it.
    const state = run([
      polled({ incoming: ring('c_1') }),
      { type: 'accept' },
      { type: 'suspend' },
      { type: 'accepted' },
    ]);
    expect(state.handledCallId).toBe('c_1');
    expect(state.suspended).toBe(true);
  });

  it('leaves no panel on top of the call screen after answering', () => {
    const state = run([polled({ incoming: ring('c_1') }), { type: 'accept' }, { type: 'accepted' }]);
    expect(state.phase).toBe('idle');
    expect(state.closed).toBeNull();
  });
});

describe('ringReducer — outgoing', () => {
  const calling = (id = 'c_1'): RingEvent => ({ type: 'calling', ring: ring(id) });

  it('enters the ringing state as soon as the call is created', () => {
    const state = run([calling()]);
    expect(state.outgoingPhase).toBe('ringing');
    expect(outgoingText(state)).toBe('Звоним: Noa… 42 с');
  });

  it('moves to answered when she accepts', () => {
    const state = run([calling(), polled({ outgoing: ring('c_1', 'accepted') })]);
    expect(state.outgoingPhase).toBe('answered');
  });

  it('reports a decline rather than going blank', () => {
    const state = run([calling(), polled({ outgoing: ring('c_1', 'declined') })]);
    expect(state.outgoingPhase).toBe('closed');
    expect(state.outgoingClosed).toBe('declined');
    // Noa — женщина; русское прошедшее время согласуется по роду.
    expect(outgoingText(state)).toBe('Noa отклонила звонок.');
  });

  it('distinguishes no-answer from declined', () => {
    const state = run([calling(), polled({ outgoing: ring('c_1', 'timeout') })]);
    expect(state.outgoingClosed).toBe('timeout');
    expect(outgoingText(state)).toBe('Noa не ответила.');
  });

  it('agrees the verb with the gender of the person being called', () => {
    // Тот же экран, мужчина вместо женщины: род берётся у участника, а не
    // зашит в строку. Половина постоянной сетки — женщины, и «Maya отклонил
    // звонок» в продукте про род собеседника — это его собственный баг.
    const male = ring('c_2');
    male.to = { ...ALEX };
    const state = run([
      { type: 'calling', ring: male },
      polled({ outgoing: { ...male, ringState: 'declined' } }),
    ]);
    expect(outgoingText(state)).toBe('Alex отклонил звонок.');
  });

  it('closes when the ring disappears without a verdict', () => {
    const state = run([calling(), polled()]);
    expect(state.outgoingPhase).toBe('closed');
    expect(state.outgoingClosed).toBe('ended');
  });

  it('ignores a stale terminal ring left over from before this screen', () => {
    const state = run([polled({ outgoing: ring('c_old', 'declined') })]);
    expect(state.outgoingPhase).toBe('idle');
    expect(state.outgoingHandledCallId).toBe('c_old');
  });

  it('only joins once, even if more polls land during the join', () => {
    let state = run([calling(), polled({ outgoing: ring('c_1', 'accepted') })]);
    state = ringReducer(state, { type: 'joining' });
    expect(state.outgoingPhase).toBe('joining');
    // A second attempt is refused because we are no longer in 'answered'.
    const again = ringReducer(state, { type: 'joining' });
    expect(again).toBe(state);
    // And a poll during the join cannot move us backwards.
    expect(ringReducer(state, polled({ outgoing: ring('c_1', 'accepted') }))).toBe(state);
  });

  it('leaves no stale outgoing panel behind once the caller is in the call', () => {
    const state = run([
      calling(),
      polled({ outgoing: ring('c_1', 'accepted') }),
      { type: 'joining' },
      { type: 'joined' },
    ]);
    expect(state.outgoingPhase).toBe('idle');
    expect(state.outgoing).toBeNull();
    expect(state.outgoingHandledCallId).toBe('c_1');
    expect(state.suspended).toBe(true);
  });

  it('honours a cancel locally even when the request failed', () => {
    const state = run([calling(), { type: 'cancel' }, { type: 'cancel_failed', message: 'offline' }]);
    expect(state.outgoingPhase).toBe('closed');
    expect(state.outgoingClosed).toBe('cancelled');
    expect(state.outgoingHandledCallId).toBe('c_1');
  });

  it('does not resurrect a cancelled ring on the next poll', () => {
    const state = run([
      calling(),
      { type: 'cancel' },
      { type: 'cancelled' },
      polled({ outgoing: ring('c_1', 'cancelled') }),
    ]);
    expect(state.outgoingClosed).toBe('cancelled');
    expect(state.outgoingPhase).toBe('closed');
  });
});

describe('ringReducer — presence and failures', () => {
  it('tracks which peers the server considers online', () => {
    const state = run([
      polled({
        peers: [
          { userId: 'u_alex', online: true, lastSeenAt: null, ttlSeconds: 15 },
          { userId: 'u_zed', online: false, lastSeenAt: null, ttlSeconds: 15 },
        ],
      }),
    ]);
    expect(state.peers).toEqual({ u_alex: true, u_zed: false });
  });

  it('does not churn state when presence is unchanged', () => {
    const peers = [{ userId: 'u_alex', online: true, lastSeenAt: null, ttlSeconds: 15 }];
    const first = run([polled({ peers })]);
    expect(ringReducer(first, polled({ peers }))).toBe(first);
  });

  it('hides poll failures until they are worth reporting', () => {
    let state = initialRingState;
    for (let i = 1; i < RING_FAILURES_BEFORE_VISIBLE; i += 1) {
      state = ringReducer(state, { type: 'poll_failed', message: 'boom' });
      expect(state.error).toBeNull();
    }
    state = ringReducer(state, { type: 'poll_failed', message: 'boom' });
    expect(state.error).toBe('boom');
  });

  it('clears the failure streak on the next good poll', () => {
    const state = run([
      { type: 'poll_failed', message: 'a' },
      { type: 'poll_failed', message: 'b' },
      { type: 'poll_failed', message: 'c' },
      polled(),
    ]);
    expect(state.failures).toBe(0);
    expect(state.error).toBeNull();
  });

  it('stops entirely when the backend has no ringing routes', () => {
    const state = run([{ type: 'unsupported' }]);
    expect(state.supported).toBe(false);
    expect(ringPollDelayMs(state, { hidden: false })).toBeNull();
  });
});

describe('ringPollDelayMs', () => {
  it('polls faster while ringing than while idle', () => {
    const ringingState = run([polled({ incoming: ring('c_1') })]);
    expect(ringPollDelayMs(ringingState, { hidden: false })).toBe(RING_POLL_ACTIVE_MS);
    expect(ringPollDelayMs(initialRingState, { hidden: false })).toBe(RING_POLL_IDLE_MS);
  });

  it('also polls fast while our own ring is out', () => {
    const state = run([{ type: 'calling', ring: ring('c_1') }]);
    expect(ringPollDelayMs(state, { hidden: false })).toBe(RING_POLL_ACTIVE_MS);
  });

  it('backs off in a hidden tab', () => {
    expect(ringPollDelayMs(initialRingState, { hidden: true })).toBe(RING_POLL_HIDDEN_MS);
  });

  it('keeps ringing at full rate even when hidden', () => {
    const ringingState = run([polled({ incoming: ring('c_1') })]);
    expect(ringPollDelayMs(ringingState, { hidden: true })).toBe(RING_POLL_ACTIVE_MS);
  });

  it('backs off exponentially on failures and never spins', () => {
    let state = initialRingState;
    let previous = 0;
    for (let i = 0; i < 12; i += 1) {
      state = ringReducer(state, { type: 'poll_failed', message: 'x' });
      const delay = ringPollDelayMs(state, { hidden: false });
      expect(delay).not.toBeNull();
      expect(delay as number).toBeGreaterThanOrEqual(RING_POLL_MIN_MS);
      expect(delay as number).toBeLessThanOrEqual(RING_POLL_MAX_MS);
      expect(delay as number).toBeGreaterThanOrEqual(previous);
      previous = delay as number;
    }
    expect(previous).toBe(RING_POLL_MAX_MS);
  });

  it('stops while suspended (i.e. during a call)', () => {
    expect(ringPollDelayMs(run([{ type: 'suspend' }]), { hidden: false })).toBeNull();
  });
});

describe('parseRingView', () => {
  it('accepts the backend shape', () => {
    const parsed = parseRingView(ring('c_abc'));
    expect(parsed?.callId).toBe('c_abc');
    expect(parsed?.to.tone).toBe('friendly');
    expect(parsed?.secondsRemaining).toBe(42);
  });

  it('clamps unknown enum values instead of dropping the whole ring', () => {
    const parsed = parseRingView({
      callId: 'c_abc',
      from: { userId: 'u_x', lang: 'klingon', gender: 'x', tone: 'shouty' },
      to: { userId: 'u_y' },
      mode: 'WEIRD',
      ringState: 'confused',
      secondsRemaining: -4,
    });
    expect(parsed?.from.lang).toBe('ru');
    expect(parsed?.from.gender).toBe('u');
    expect(parsed?.from.tone).toBe('neutral');
    expect(parsed?.mode).toBe('TRANSLATED');
    expect(parsed?.ringState).toBe('ringing');
    expect(parsed?.secondsRemaining).toBe(0);
    expect(parsed?.from.displayName).toBe('u_x');
  });

  it('rejects payloads it cannot identify or render', () => {
    expect(parseRingView(null)).toBeNull();
    expect(parseRingView({})).toBeNull();
    expect(parseRingView({ callId: 'c_abc' })).toBeNull();
    expect(parseRingView({ callId: 'c_abc', from: { userId: 'u_x' } })).toBeNull();
  });
});

describe('parseRingPoll', () => {
  it('survives a truncated payload without throwing into the poll loop', () => {
    const parsed = parseRingPoll({});
    expect(parsed).not.toBeNull();
    expect(parsed?.incoming).toBeNull();
    expect(parsed?.outgoing).toBeNull();
    expect(parsed?.peers).toEqual([]);
    expect(parsed?.pollIntervalMs).toBe(2000);
  });

  it('drops peer entries that are not readable', () => {
    const parsed = parseRingPoll({
      peers: [{ userId: 'u_alex', online: true }, null, 'nope', {}],
    });
    expect(parsed?.peers).toHaveLength(1);
  });

  it('rejects a non-object body', () => {
    expect(parseRingPoll(null)).toBeNull();
    expect(parseRingPoll('nope')).toBeNull();
  });
});
