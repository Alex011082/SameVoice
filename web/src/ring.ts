import { byGender } from './russian';
import {
  RING_TERMINAL,
  type CallMode,
  type Gender,
  type RingPollResponse,
  type RingView,
} from './types';

/**
 * Pure state machine for ringing, both directions.
 *
 * One `POST /api/presence` answers both channels at once (backend/src/routes/
 * presence.ts), so one reducer owns both:
 *
 *   incoming — someone is ringing me: ring, accept, decline, or watch the
 *              caller give up.
 *   outgoing — a ring I started: wait, cancel, or learn it was declined /
 *              unanswered. The backend keeps a terminal outgoing ring visible
 *              for a grace window precisely so this side can say WHY the ring
 *              stopped instead of going blank.
 *
 * No DOM, no timers, no fetch: every input is an event and every output is a
 * new state. Tested in web/test/ring.test.ts; driven by ringpoll.ts.
 */

/** While anything is ringing we poll fast — someone is staring at the screen. */
export const RING_POLL_ACTIVE_MS = 1200;
/** Idle poll rate. Also the presence heartbeat rate, so it must stay under the
 *  server's PRESENCE_TTL_SECONDS or the peer will flicker offline. */
export const RING_POLL_IDLE_MS = 2500;
/** Backgrounded tab: browsers throttle timers anyway, so ask for less. */
export const RING_POLL_HIDDEN_MS = 5000;
/** Hard floor. Nothing may ever schedule a poll faster than this. */
export const RING_POLL_MIN_MS = 750;
/** Ceiling for the error backoff. */
export const RING_POLL_MAX_MS = 30000;
/** How many consecutive failures before the user is told anything. */
export const RING_FAILURES_BEFORE_VISIBLE = 3;

// --- incoming --------------------------------------------------------------

export type RingPhase = 'idle' | 'ringing' | 'accepting' | 'declining' | 'closed';

export type RingClosedReason = 'caller_cancelled' | 'declined' | 'accepted' | 'already_ended';

// --- outgoing --------------------------------------------------------------

export type OutgoingPhase =
  | 'idle'
  /** Waiting for the callee to pick up. */
  | 'ringing'
  /** She accepted; the caller should now join. */
  | 'answered'
  | 'cancelling'
  /** We are joining the answered call. */
  | 'joining'
  | 'closed';

export type OutgoingClosedReason = 'declined' | 'timeout' | 'cancelled' | 'joined' | 'ended';

export interface RingState {
  // incoming
  phase: RingPhase;
  call: RingView | null;
  closed: RingClosedReason | null;
  /** Last incoming call this client acted on, so it cannot ring twice. */
  handledCallId: string | null;

  // outgoing
  outgoingPhase: OutgoingPhase;
  outgoing: RingView | null;
  outgoingClosed: OutgoingClosedReason | null;
  outgoingHandledCallId: string | null;

  // presence
  /** userId -> online, from the server's TTL view. */
  peers: Readonly<Record<string, boolean>>;

  // plumbing
  failures: number;
  error: string | null;
  /** Polling is off: we are in a call. */
  suspended: boolean;
  /** False once the backend has told us these routes do not exist. */
  supported: boolean;
}

export const initialRingState: RingState = {
  phase: 'idle',
  call: null,
  closed: null,
  handledCallId: null,
  outgoingPhase: 'idle',
  outgoing: null,
  outgoingClosed: null,
  outgoingHandledCallId: null,
  peers: {},
  failures: 0,
  error: null,
  suspended: false,
  supported: true,
};

export type RingEvent =
  | { type: 'polled'; poll: RingPollResponse }
  | { type: 'poll_failed'; message: string }
  /** The backend has no ringing endpoints. Degrade to the invite-link flow. */
  | { type: 'unsupported' }
  // incoming
  | { type: 'accept' }
  | { type: 'accepted' }
  | { type: 'accept_failed'; code: string; message: string }
  | { type: 'decline' }
  | { type: 'declined' }
  | { type: 'decline_failed'; message: string }
  | { type: 'dismiss' }
  // outgoing
  | { type: 'calling'; ring: RingView }
  | { type: 'cancel' }
  | { type: 'cancelled' }
  | { type: 'cancel_failed'; message: string }
  | { type: 'joining' }
  | { type: 'joined' }
  | { type: 'join_failed'; message: string }
  /** Stop offering this outgoing call, with nothing to say about it. */
  | { type: 'outgoing_abandon' }
  | { type: 'outgoing_dismiss' }
  // lifecycle
  | { type: 'suspend' }
  | { type: 'resume' };

/** Codes that mean "that call is not answerable any more", not "we broke". */
const GONE_CODES = new Set([
  'not_found',
  'gone',
  'conflict',
  'ring_conflict',
  'call_ended',
  'already_ended',
]);

function isTerminal(ringState: RingView['ringState']): boolean {
  return (RING_TERMINAL as readonly string[]).includes(ringState);
}

function closeIncoming(
  state: RingState,
  reason: RingClosedReason,
  error: string | null = null,
): RingState {
  return {
    ...state,
    phase: 'closed',
    closed: reason,
    error,
    handledCallId: state.call?.callId ?? state.handledCallId,
  };
}

function closeOutgoing(
  state: RingState,
  reason: OutgoingClosedReason,
  error: string | null = null,
): RingState {
  return {
    ...state,
    outgoingPhase: 'closed',
    outgoingClosed: reason,
    error: error ?? state.error,
    outgoingHandledCallId: state.outgoing?.callId ?? state.outgoingHandledCallId,
  };
}

/** Fold one poll's incoming half into the state. */
function applyIncoming(state: RingState, incoming: RingView | null): RingState {
  // A poll that lands mid-accept/mid-decline must not undo the user's press.
  if (state.phase === 'accepting' || state.phase === 'declining') return state;

  if (!incoming || incoming.ringState !== 'ringing') {
    if (state.phase === 'ringing') return closeIncoming(state, 'caller_cancelled');
    return state;
  }
  if (incoming.callId === state.handledCallId) return state;
  if (state.phase === 'ringing' && state.call?.callId === incoming.callId) {
    // Same call, refreshed countdown.
    return { ...state, call: incoming };
  }
  return { ...state, phase: 'ringing', call: incoming, closed: null, error: null };
}

/** Fold one poll's outgoing half into the state. */
function applyOutgoing(state: RingState, outgoing: RingView | null): RingState {
  if (state.outgoingPhase === 'cancelling' || state.outgoingPhase === 'joining') return state;

  if (!outgoing) {
    if (state.outgoingPhase === 'ringing' || state.outgoingPhase === 'answered') {
      // The ring vanished without a visible verdict (server restart, or the
      // grace window elapsed while this tab was asleep).
      return closeOutgoing(state, 'ended');
    }
    return state;
  }
  if (outgoing.callId === state.outgoingHandledCallId) return state;

  if (isTerminal(outgoing.ringState)) {
    if (state.outgoingPhase === 'idle' || state.outgoingPhase === 'closed') {
      // A leftover terminal ring from before this screen existed; do not
      // resurrect it as news.
      return { ...state, outgoingHandledCallId: outgoing.callId };
    }
    const reason: OutgoingClosedReason =
      outgoing.ringState === 'declined'
        ? 'declined'
        : outgoing.ringState === 'timeout'
          ? 'timeout'
          : 'cancelled';
    return closeOutgoing({ ...state, outgoing }, reason);
  }

  if (outgoing.ringState === 'accepted') {
    return { ...state, outgoing, outgoingPhase: 'answered', outgoingClosed: null };
  }
  return { ...state, outgoing, outgoingPhase: 'ringing', outgoingClosed: null };
}

function peerMap(poll: RingPollResponse): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const peer of poll.peers) out[peer.userId] = peer.online;
  return out;
}

function samePeers(a: Readonly<Record<string, boolean>>, b: Record<string, boolean>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

export function ringReducer(state: RingState, event: RingEvent): RingState {
  switch (event.type) {
    case 'polled': {
      const peers = peerMap(event.poll);
      const peersChanged = !samePeers(state.peers, peers);
      // The common case is "nothing is happening". Returning the identical
      // object lets the driver skip a repaint, which matters because this runs
      // every couple of seconds for the whole session.
      let next: RingState =
        state.failures === 0 && state.error === null && !peersChanged
          ? state
          : { ...state, failures: 0, error: null, peers };
      if (peersChanged && next === state) next = { ...state, peers };

      next = applyIncoming(next, event.poll.incoming);
      next = applyOutgoing(next, event.poll.outgoing);
      return next;
    }

    case 'poll_failed': {
      const failures = state.failures + 1;
      return {
        ...state,
        failures,
        error: failures >= RING_FAILURES_BEFORE_VISIBLE ? event.message : state.error,
      };
    }

    case 'unsupported':
      return {
        ...state,
        supported: false,
        phase: 'idle',
        call: null,
        closed: null,
        outgoingPhase: 'idle',
        outgoing: null,
        outgoingClosed: null,
        error: null,
      };

    // --- incoming ---------------------------------------------------------

    case 'accept':
      if (state.phase !== 'ringing') return state;
      return { ...state, phase: 'accepting', error: null };

    case 'accepted':
      // No epitaph: the call screen IS the confirmation, and a leftover panel
      // would sit on top of it with nothing useful to say.
      return {
        ...closeIncoming(state, 'accepted'),
        phase: 'idle',
        closed: null,
        suspended: true,
      };

    case 'accept_failed':
      if (GONE_CODES.has(event.code)) return closeIncoming(state, 'already_ended');
      // A transient failure: let them press Accept again.
      return { ...state, phase: state.call ? 'ringing' : 'idle', error: event.message };

    case 'decline':
      if (state.phase !== 'ringing') return state;
      return { ...state, phase: 'declining', error: null };

    case 'declined':
      return closeIncoming(state, 'declined');

    case 'decline_failed':
      // The user's intent is honoured locally regardless: the panel goes away
      // and the call is marked handled, so a still-open offer will not re-ring.
      return closeIncoming(state, 'declined', event.message);

    case 'dismiss':
      return { ...state, phase: 'idle', call: null, closed: null, error: null };

    // --- outgoing ---------------------------------------------------------

    case 'calling':
      return {
        ...state,
        outgoing: event.ring,
        outgoingPhase: event.ring.ringState === 'accepted' ? 'answered' : 'ringing',
        outgoingClosed: null,
        error: null,
      };

    case 'cancel':
      if (state.outgoingPhase !== 'ringing' && state.outgoingPhase !== 'answered') return state;
      return { ...state, outgoingPhase: 'cancelling', error: null };

    case 'cancelled':
      return closeOutgoing(state, 'cancelled');

    case 'cancel_failed':
      // Same reasoning as decline_failed: honour the intent locally.
      return closeOutgoing(state, 'cancelled', event.message);

    case 'joining':
      if (state.outgoingPhase !== 'answered') return state;
      return { ...state, outgoingPhase: 'joining', error: null };

    case 'joined':
      // Same reasoning as 'accepted': the call screen is the confirmation, and
      // the panel must not be waiting on the contacts screen afterwards.
      return {
        ...closeOutgoing(state, 'joined'),
        outgoingPhase: 'idle',
        outgoingClosed: null,
        outgoing: null,
        suspended: true,
      };

    case 'join_failed':
      return closeOutgoing(state, 'ended', event.message);

    case 'outgoing_abandon':
      // Marking it handled is the point: without that, the very next poll
      // offers the same ring again and the client that just decided not to
      // join it decides all over again, every 1.2 seconds. No epitaph — a ring
      // this tab never placed has nothing to report to the user.
      return {
        ...state,
        outgoingPhase: 'idle',
        outgoing: null,
        outgoingClosed: null,
        outgoingHandledCallId: state.outgoing?.callId ?? state.outgoingHandledCallId,
      };

    case 'outgoing_dismiss':
      return { ...state, outgoingPhase: 'idle', outgoing: null, outgoingClosed: null, error: null };

    // --- lifecycle --------------------------------------------------------

    case 'suspend':
      // `call`/`outgoing` are deliberately kept: entering a call suspends
      // polling, and the 'accepted'/'joined' event that follows needs them to
      // mark the call handled so a backend a beat behind cannot ring us for the
      // call we are already in.
      return {
        ...state,
        suspended: true,
        phase: 'idle',
        closed: null,
        outgoingPhase: 'idle',
        outgoingClosed: null,
        error: null,
      };

    case 'resume':
      return { ...state, suspended: false, failures: 0, error: null };
  }
}

/**
 * How long to wait before the next poll, or null when polling must stop.
 * Never returns anything below RING_POLL_MIN_MS, so a bug upstream cannot turn
 * this into a hot loop against the backend.
 */
export function ringPollDelayMs(state: RingState, opts: { hidden: boolean }): number | null {
  if (!state.supported || state.suspended) return null;

  if (state.failures > 0) {
    const backoff = RING_POLL_IDLE_MS * 2 ** Math.min(state.failures, 8);
    return Math.min(RING_POLL_MAX_MS, Math.max(RING_POLL_MIN_MS, backoff));
  }
  const busy =
    state.phase === 'ringing' ||
    state.phase === 'accepting' ||
    state.phase === 'declining' ||
    state.outgoingPhase === 'ringing' ||
    state.outgoingPhase === 'answered' ||
    state.outgoingPhase === 'cancelling';
  if (busy) return RING_POLL_ACTIVE_MS;
  return opts.hidden ? RING_POLL_HIDDEN_MS : RING_POLL_IDLE_MS;
}

// --- text -----------------------------------------------------------------

/** Имя и род собеседника: русское прошедшее время согласуется по роду. */
export interface Named {
  displayName: string;
  gender: Gender;
}

export function ringClosedText(state: RingState, caller: Named): string {
  const callerName = caller.displayName;
  switch (state.closed) {
    case 'caller_cancelled':
      return `${callerName} ${byGender(caller.gender, 'перестал', 'перестала')} звонить.`;
    case 'declined':
      return `Вы отклонили: ${callerName}.`;
    case 'accepted':
      return `Соединяем с ${callerName}…`;
    case 'already_ended':
      return 'Этот звонок уже завершён.';
    case null:
      return '';
  }
}

export function outgoingText(state: RingState): string {
  const name = state.outgoing?.to.displayName ?? 'абонент';
  // Род берётся у того же участника, что и имя; без звонка в работе род
  // неизвестен, и немаркированная мужская форма — единственный выбор.
  const gender: Gender = state.outgoing?.to.gender ?? 'u';
  switch (state.outgoingPhase) {
    case 'ringing': {
      const left = state.outgoing?.secondsRemaining ?? 0;
      return left > 0 ? `Звоним: ${name}… ${left} с` : `Звоним: ${name}…`;
    }
    case 'answered':
      return `${name} ${byGender(gender, 'ответил', 'ответила')}.`;
    case 'joining':
      return `Соединяем с ${name}…`;
    case 'cancelling':
      return 'Отменяем…';
    case 'closed':
      switch (state.outgoingClosed) {
        case 'declined':
          return `${name} ${byGender(gender, 'отклонил', 'отклонила')} звонок.`;
        case 'timeout':
          return `${name} не ${byGender(gender, 'ответил', 'ответила')}.`;
        case 'cancelled':
          return 'Звонок отменён.';
        case 'joined':
          return `Соединено с ${name}.`;
        case 'ended':
        case null:
          return 'Звонок завершился, не начавшись.';
      }
    // eslint-disable-next-line no-fallthrough -- every case above returns
    case 'idle':
      return '';
  }
}

export function ringModeText(mode: CallMode): string {
  switch (mode) {
    case 'DIRECT':
      return 'Один язык — слышите друг друга напрямую.';
    case 'TRANSLATED':
      return 'Разные языки — включится перевод. Вы услышите только перевод.';
    case 'FORCED':
      return 'Для этого контакта перевод включён всегда.';
  }
}
