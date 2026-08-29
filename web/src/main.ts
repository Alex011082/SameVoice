import './styles.css';

import { ConnectionState } from 'livekit-client';
import { api, ApiRequestError, BACKEND_URL } from './api';
import { startRingingAttention, stopRingingAttention } from './attention';
import { AutoJoinGate } from './autojoin';
import { CallSession, micFailureText, type CallMetrics, type MicFailureKind } from './call';
import { FlagLog, type FlagTarget } from './flags';
import { RingPoller } from './ringpoll';
import type { RingState } from './ring';
import { diagnoseCurrentOrigin, insecureContextMessage } from './secure';
import { SubtitleModel } from './subtitles';
import type {
  AppConfig,
  ContactCard,
  JoinResponse,
  StateMessage,
  SubtitleMessage,
  UserProfile,
} from './types';
import * as ui from './ui';

/** How long a TRANSLATED call waits for the agent before saying it is degraded. */
const AGENT_READY_TIMEOUT_MS = 6000;
/** How long the "X stopped calling" epitaph stays before the panel clears. */
const RING_EPITAPH_MS = 3500;
/** How long a judge confirmation stays on screen. */
const JUDGE_STATUS_MS = 4000;

interface JudgeState {
  log: FlagLog;
  /** Utterance whose correction field is open, if any. */
  correcting: FlagTarget | null;
  status: { text: string; tone: 'ok' | 'error' | 'info' } | null;
  statusTimer: number | null;
}

interface AppState {
  me: UserProfile | null;
  config: AppConfig | null;
  session: CallSession | null;
  subtitles: SubtitleModel;
  repaintTimer: number | null;
  agentReadyTimer: number | null;
  agentReady: boolean;
  /**
   * The relay is IN the room (a participant with the agent identity), whether or
   * not we caught its one-shot `agent_ready` message. The agent is dispatched
   * when the call is created and announces itself once, so everybody who joins
   * afterwards — which, in the ringing flow, is both humans — never sees that
   * message. Presence is what tells them the agent is there.
   */
  agentPresent: boolean;
  muted: boolean;
  micFailure: MicFailureKind | null;
  lastMetrics: CallMetrics;
  judge: JudgeState;
  ringEpitaphTimer: number | null;
}

const state: AppState = {
  me: null,
  config: null,
  session: null,
  subtitles: new SubtitleModel(),
  repaintTimer: null,
  agentReadyTimer: null,
  agentReady: false,
  agentPresent: false,
  muted: false,
  micFailure: null,
  lastMetrics: { rttMs: null, jitterBufferMs: null, segmentMs: null, quality: null },
  judge: { log: new FlagLog(), correcting: null, status: null, statusTimer: null },
  ringEpitaphTimer: null,
};

// --- url helpers ----------------------------------------------------------

function param(name: string): string | null {
  return new URL(window.location.href).searchParams.get(name);
}

/**
 * `?debug=1` возвращает на экран диагностику, спрятанную от обычного глаза:
 * режим звонка, состояние соединения, замеры задержки по стадиям, адреса
 * провайдеров в подвале, пол/тон контакта и переключатель принудительного
 * перевода.
 *
 * Спрятано, а не удалено, намеренно. Продукт должен выглядеть как телефон, но
 * именно по этим числам ловятся настоящие поломки — три сорванных звонка
 * 25.08.2026 разбирались по ним. Интерфейс без диагностики красив ровно до
 * первого отчёта «просто не работает».
 */
function applyDebugFlag(): void {
  const on = param('debug') === '1';
  if (on) document.body.dataset['debug'] = '1';
  else delete document.body.dataset['debug'];
}

function setParams(next: Record<string, string | null>): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(next)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState({}, '', url);
}

/** Accepts a bare call id or a full invite link and returns the call id. */
function parseCallRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^c_[0-9a-f]{12}$/.test(trimmed)) return trimmed;
  try {
    const fromLink = new URL(trimmed).searchParams.get('call');
    if (fromLink && /^c_[0-9a-f]{12}$/.test(fromLink)) return fromLink;
  } catch {
    // Not a URL.
  }
  return null;
}

function inviteUrl(callId: string, peerUserId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('me', peerUserId);
  url.searchParams.set('call', callId);
  return url.toString();
}

function describeError(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** VITE_BACKEND_URL=/ resolves to "", which as a footer entry reads as a bug. */
function backendLabel(): string {
  return BACKEND_URL === '' ? 'backend same-origin' : `backend ${BACKEND_URL}`;
}

/**
 * The origin diagnosis (insecure context / mixed content) is not news that
 * scrolls past — it is a standing condition that makes calling impossible, so
 * it must survive every ordinary `setBanner(null)`.
 */
let stickyBanner: string | null = null;

function clearBanner(): void {
  if (stickyBanner) ui.setBanner(stickyBanner, 'error');
  else ui.setBanner(null);
}

// --- ringing --------------------------------------------------------------

const ringer = new RingPoller({
  poll: async () => {
    const me = state.me;
    if (!me) throw new ApiRequestError('bad_request', 'no identity yet', 0);
    return api.presence(me.id, true);
  },
  isUnsupported: (err) => err instanceof ApiRequestError && err.isRouteMissing,
  hidden: () => document.visibilityState === 'hidden',
  onState: (next) => paintRing(next),
});

/** Call id the ringtone is currently running for, so it is started exactly once. */
let ringingFor: string | null = null;

/** Decides whether an answered call may be joined without the user pressing anything. */
const autoJoin = new AutoJoinGate();

/**
 * "That call is over" — 409 conflict / ring_conflict, or 404 for a call the
 * backend has already forgotten. Retrying any of these is pointless: the answer
 * will not change, and the client that keeps asking is the client that spends a
 * whole test session hammering a call from yesterday.
 */
function isCallGone(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 409 || err.status === 404);
}

function paintRing(ringState: RingState): void {
  ui.renderIncoming(ringState, {
    onAccept: () => {
      void acceptRinging();
    },
    onDecline: () => {
      void declineRinging();
    },
    onDismiss: () => ringer.dispatch({ type: 'dismiss' }),
  });

  ui.renderOutgoing(ringState, () => {
    void cancelOutgoing();
  });
  ui.updatePresence(ringState.peers);

  // Restarting the ringtone on every poll would beep at the poll rate; start
  // it once per offered call and stop it the moment that call stops ringing.
  const ringingId = ringState.phase === 'ringing' ? (ringState.call?.callId ?? null) : null;
  if (ringingId !== ringingFor) {
    ringingFor = ringingId;
    if (ringingId && ringState.call) startRingingAttention(ringState.call.from.displayName);
    else stopRingingAttention();
  }

  // The callee answered: the caller's client joins on its own, so nobody has to
  // press anything twice.
  if (ringState.outgoingPhase === 'answered' && ringState.outgoing !== null) {
    switch (autoJoin.decide(ringState.outgoing)) {
      case 'go':
        void joinAnswered();
        break;
      case 'exhausted':
        ui.setContactsError(
          'Could not join the answered call after several attempts. Reload the page and call again.',
        );
        ringer.dispatch({ type: 'outgoing_abandon' });
        break;
      case 'stale':
        // A call this tab never placed, already past its deadline, or one the
        // backend has told us is over. Drop it instead of joining a room the
        // other side left hours ago.
        ringer.dispatch({ type: 'outgoing_abandon' });
        break;
      case 'wait':
        break;
    }
  }

  scheduleEpitaphs(ringState);
}

/** Closed panels are epitaphs, not states to live in — clear them on their own. */
function scheduleEpitaphs(ringState: RingState): void {
  if (state.ringEpitaphTimer !== null) {
    window.clearTimeout(state.ringEpitaphTimer);
    state.ringEpitaphTimer = null;
  }
  const incomingDone = ringState.phase === 'closed' && ringState.closed !== 'accepted';
  const outgoingDone = ringState.outgoingPhase === 'closed' && ringState.outgoingClosed !== 'joined';
  if (!incomingDone && !outgoingDone) return;

  state.ringEpitaphTimer = window.setTimeout(() => {
    state.ringEpitaphTimer = null;
    if (incomingDone) ringer.dispatch({ type: 'dismiss' });
    if (outgoingDone) ringer.dispatch({ type: 'outgoing_dismiss' });
  }, RING_EPITAPH_MS);
}

async function acceptRinging(): Promise<void> {
  const call = ringer.current.call;
  const me = state.me;
  if (!call || !me) return;
  ringer.dispatch({ type: 'accept' });
  try {
    // Accept first so the caller's screen updates immediately, then join. The
    // backend also treats a callee's join as an accept, so the two cannot race
    // into an inconsistent state whichever order they land in.
    await api.acceptRing(call.callId, me.id);
    await enterCall(call.callId, false, true);
    setParams({ call: call.callId });
    ringer.dispatch({ type: 'accepted' });
  } catch (err) {
    const code = err instanceof ApiRequestError ? err.code : 'internal';
    ringer.dispatch({ type: 'accept_failed', code, message: describeError(err) });
  }
}

async function declineRinging(): Promise<void> {
  const call = ringer.current.call;
  const me = state.me;
  if (!call || !me) return;
  ringer.dispatch({ type: 'decline' });
  try {
    await api.declineRing(call.callId, me.id);
    ringer.dispatch({ type: 'declined' });
  } catch (err) {
    ringer.dispatch({ type: 'decline_failed', message: describeError(err) });
  }
}

async function cancelOutgoing(): Promise<void> {
  const ring = ringer.current.outgoing;
  const me = state.me;
  if (!ring || !me) return;
  ringer.dispatch({ type: 'cancel' });
  try {
    await api.cancelRing(ring.callId, me.id);
    ringer.dispatch({ type: 'cancelled' });
  } catch (err) {
    ringer.dispatch({ type: 'cancel_failed', message: describeError(err) });
  }
}

async function joinAnswered(): Promise<void> {
  const ring = ringer.current.outgoing;
  if (!ring) return;
  // 'joining' is a no-op unless we are in 'answered', so a second poll landing
  // during the join cannot start a second one.
  const next = ringer.dispatch({ type: 'joining' });
  if (next.outgoingPhase !== 'joining') return;
  try {
    await enterCall(ring.callId, true, true);
    setParams({ call: ring.callId });
    ringer.dispatch({ type: 'joined' });
  } catch (err) {
    ringer.dispatch({ type: 'join_failed', message: describeError(err) });
    ui.setContactsError(`Could not join the answered call: ${describeError(err)}`);
  }
}

// --- boot -----------------------------------------------------------------

async function boot(): Promise<void> {
  applyDebugFlag();
  ui.setFooter([backendLabel(), 'загрузка…']);

  let cfg: AppConfig;
  try {
    cfg = await api.config();
  } catch (err) {
    ui.showScreen('identity');
    ui.setBanner(describeError(err), 'error');
    ui.setIdentityError('The backend must be running before the client can do anything.');
    return;
  }
  state.config = cfg;

  ui.setFooter([
    backendLabel(),
    `livekit ${cfg.livekitUrl}`,
    `stt:${cfg.providers.stt} mt:${cfg.providers.mt} tts:${cfg.providers.tts}`,
  ]);

  const meId = param('me');
  if (!meId) {
    await showIdentityPicker();
    return;
  }

  try {
    state.me = await api.getUser(meId);
  } catch (err) {
    await showIdentityPicker();
    ui.setIdentityError(`Unknown user "${meId}": ${describeError(err)}`);
    return;
  }

  ui.renderWhoami(state.me, () => {
    setParams({ me: null, call: null });
    window.location.reload();
  });

  // Say the awkward thing before the microphone is asked for, not after: an
  // http:// LAN address has no microphone at all, and an https:// page talking
  // to an http:// backend has no API at all. Both are invisible otherwise.
  const origin = diagnoseCurrentOrigin(BACKEND_URL);
  if (!origin.ok && origin.message) {
    stickyBanner = origin.message;
    ui.setBanner(stickyBanner, 'error');
  }

  // Presence starts as soon as we know who we are, so the other side can ring.
  ringer.start();

  const pendingCall = param('call');
  if (pendingCall) {
    await joinExistingCall(pendingCall);
    return;
  }

  await showContacts();
}

async function showIdentityPicker(): Promise<void> {
  ui.showScreen('identity');
  ui.renderWhoami(null, () => undefined);
  try {
    const users = await api.listUsers();
    const pick = (userId: string): void => {
      setParams({ me: userId });
      window.location.reload();
    };
    // Обычный путь — два вопроса. Полный список профилей остаётся, но виден
    // только под ?debug=1: он нужен, чтобы войти конкретным пользователем при
    // разборе звонка, а не чтобы им пользовались тестеры.
    ui.renderRolePicker(users, pick);
    ui.renderIdentityPicker(users, pick);
  } catch (err) {
    ui.setIdentityError(describeError(err));
  }
}

async function showContacts(): Promise<void> {
  const me = state.me;
  if (!me) return;
  ui.showScreen('contacts');
  clearBanner();
  ui.setContactsError(null);
  try {
    const contacts = await api.listContacts(me.id);
    ui.renderContacts(
      me,
      contacts,
      {
        onCall: (contact) => {
          void startCall(contact);
        },
        onToggleForce: (contact, force) => {
          void (async () => {
            try {
              await api.updateContact(me.id, contact.userId, { forceTranslate: force });
              await showContacts();
            } catch (err) {
              ui.setContactsError(describeError(err));
            }
          })();
        },
      },
      ringer.current.peers,
    );
    // The list was just rebuilt, so re-attach whatever the ring state knows.
    ui.renderOutgoing(ringer.current, () => {
      void cancelOutgoing();
    });
  } catch (err) {
    ui.setContactsError(describeError(err));
  }
}

// --- call lifecycle -------------------------------------------------------

async function startCall(contact: ContactCard): Promise<void> {
  const me = state.me;
  if (!me) return;
  ui.setContactsError(null);

  // Ring only when the backend supports it AND polling is actually running; a
  // ring nobody can hear is worse than the invite link it replaced.
  const canRing = state.config?.ring !== undefined && ringer.current.supported;

  try {
    const { call, ring } = await api.createCall(me.id, contact.userId, { ring: canRing });
    // This tab placed this call, so its answer is worth joining on sight — even
    // if the page is reloaded while it is still ringing.
    autoJoin.place(call.id);
    if (call.agent.required && !call.agent.dispatched) {
      ui.setBanner(
        `Translation is needed but the agent did not accept the job (${call.agent.error ?? 'no reason given'}). ` +
          'The call will connect without translation.',
        'error',
      );
    }

    if (ring) {
      // Wait on the contacts screen: the caller has nothing to do in a room
      // until the other side picks up, and a "connecting" screen that hangs for
      // 45 seconds reads as a bug.
      ringer.dispatch({ type: 'calling', ring });
      ringer.wake();
      if (ringer.current.peers[contact.userId] === false) {
        ui.setBanner(
          `${contact.displayName} does not look connected right now — the phone will ring, but ` +
            'nobody may be there to answer.',
        );
      }
      return;
    }

    setParams({ call: call.id });
    await enterCall(call.id, true);
  } catch (err) {
    ui.setContactsError(describeError(err));
  }
}

async function joinExistingCall(rawRef: string): Promise<void> {
  const callId = parseCallRef(rawRef);
  if (!callId) {
    ui.setContactsError(`"${rawRef}" is not a call id or an invite link.`);
    await showContacts();
    return;
  }
  // The `?call=` parameter outlives the call: it is still in the address bar
  // after a reload, a restored tab, or a night's sleep. Once the backend has
  // said that call is over, asking again is not going to help.
  if (autoJoin.isAbandoned(callId)) {
    setParams({ call: null });
    ui.setContactsError(`Call ${callId} is over. Start a new one.`);
    await showContacts();
    return;
  }
  setParams({ call: callId });
  await enterCall(callId, false);
}

/**
 * @param propagateJoinError when true a failed POST /join is rethrown instead
 * of being turned into a banner. The ring panel needs the error code to tell
 * "that call already ended" apart from "the backend hiccuped".
 */
async function enterCall(
  callId: string,
  isCaller: boolean,
  propagateJoinError = false,
): Promise<void> {
  const me = state.me;
  const config = state.config;
  if (!me || !config) return;

  ui.showScreen('call');
  ui.setCallError(null);
  ui.clearSubtitles();
  ui.clearSelfMonitor();
  ui.maybeShowAudioHint();
  ui.setConnectionState(ConnectionState.Connecting);
  ui.setMuteButton(false, true);
  ui.setHangupEnabled(true);
  ui.renderMetrics(state.lastMetrics);

  let join: JoinResponse;
  try {
    join = await api.joinCall(callId, me.id);
  } catch (err) {
    // One 409 is the whole answer: both the poll-driven auto-join and the
    // `?call=` link stop trying this id from here on.
    if (isCallGone(err)) autoJoin.abandon(callId);
    if (propagateJoinError) {
      ui.showScreen('contacts');
      setParams({ call: null });
      throw err;
    }
    ui.setCallError(describeError(err));
    ui.setConnectionState(ConnectionState.Disconnected);
    ui.setBanner('Could not join that call.', 'error');
    setParams({ call: null });
    await showContacts();
    return;
  }

  // In a call there is nothing to ring: a second offer would fight the audio
  // that is already playing. Presence resumes the moment the call ends.
  ringer.dispatch({ type: 'suspend' });

  state.subtitles.reset();
  resetJudge(join);
  state.agentReady = false;
  state.agentPresent = false;
  state.muted = false;
  ui.renderCallHeader(join);
  ui.setInviteLink(isCaller ? inviteUrl(callId, join.peer.userId) : null, () => {
    void copyToClipboard(inviteUrl(callId, join.peer.userId));
  });

  const session = new CallSession({
    join,
    config,
    audioSink: ui.audioSink(),
    handlers: {
      onConnectionState: (s) => ui.setConnectionState(s),
      onSubtitle: (msg) => {
        const me = state.me;
        // The agent now echoes each line back to its own speaker. It is not for
        // them to read the conversation - it is so they can see that the system
        // heard them at all. Never reaches the product subtitle area.
        if (me && msg.listenerId && msg.listenerId !== me.id) {
          if (msg.speakerId === me.id) {
            ui.renderSelfMonitor(msg.srcText, msg.dstText, msg.dstLang);
          }
          return;
        }
        state.subtitles.push(msg);
        recordJudgeCandidate(msg);
        repaintSubtitles();
      },
      onAgentState: (msg) => handleAgentState(msg),
      onPeerPresence: (present) => {
        if (present) {
          clearBanner();
        } else {
          ui.setBanner(`${join.peer.displayName} left the call.`);
        }
      },
      onAgentPresence: (present) => {
        state.agentPresent = present;
        if (present) clearAgentReadyTimer();
      },
      onAudioBlocked: (blocked) => {
        ui.setAudioUnlock(blocked, () => {
          void state.session?.unlockAudio();
        });
      },
      onMicState: ({ enabled, failure }) => {
        state.micFailure = failure;
        state.muted = !enabled;
        ui.setMuteButton(!enabled, failure !== null);
        if (failure) {
          // The insecure-context case gets the diagnosis that names the actual
          // origin; the generic "microphone blocked" text sends people hunting
          // through browser settings for a permission that was never asked for.
          ui.setBanner(
            failure === 'insecure_context'
              ? insecureContextMessage(BACKEND_URL)
              : micFailureText(failure),
            'error',
          );
        }
      },
      onMetrics: (metrics) => {
        state.lastMetrics = metrics;
        ui.renderMetrics(metrics, {
          mode: join.mode.toLowerCase(),
          agent:
            join.mode === 'DIRECT'
              ? 'none'
              : state.agentReady || state.agentPresent
                ? 'ready'
                : 'waiting',
        });
      },
      onEnded: (reason) => handleEnded(reason, join),
    },
  });
  state.session = session;

  try {
    await session.start();
  } catch (err) {
    // Tear the half-open session down before reporting. A Room whose connect
    // failed keeps retrying on its own: observed here as ~40 rejoins/second
    // that eventually SUCCEED, putting this tab back in a room it believes it
    // left, publishing its microphone there, and finally — when that zombie
    // room dies — running handleEnded, whose delayed showContacts() drags the
    // UI off whatever screen the tester has since reached.
    // abort() is the silent teardown: no "Call ended." banner and no delayed
    // showContacts() to wipe the diagnosis this tester needs to read.
    try {
      await session.abort();
    } catch {
      // Already gone; the diagnosis below is what matters.
    }
    state.session = null;
    ui.setCallError(describeError(err));
    ui.setBanner('Could not connect to the media server.', 'error');
    ui.setConnectionState(ConnectionState.Disconnected);
    // We are not actually in a call, so presence must not stay suspended —
    // otherwise one failed connect silently makes this tester unreachable for
    // the rest of the session.
    ringer.dispatch({ type: 'resume' });
    ringer.wake();
    return;
  }

  // A DIRECT call has no agent by design, so there is nothing to wait for.
  if (join.mode !== 'DIRECT') startAgentReadyTimer();
}

function handleAgentState(msg: StateMessage): void {
  switch (msg.event) {
    case 'agent_ready':
      state.agentReady = true;
      clearAgentReadyTimer();
      clearBanner();
      break;
    case 'agent_error':
      state.agentReady = false;
      clearAgentReadyTimer();
      ui.setBanner(
        `Translation is degraded: ${msg.detail || 'the relay agent reported an error'}. ` +
          'You will not hear the other side until it recovers.',
        'error',
      );
      break;
    case 'agent_left':
      state.agentReady = false;
      state.agentPresent = false;
      ui.setBanner('The relay agent left the call. Translation has stopped.', 'error');
      break;
  }
}

function startAgentReadyTimer(): void {
  clearAgentReadyTimer();
  // The presence callbacks for participants who were already in the room fire
  // during session.start(), i.e. BEFORE this timer is armed, so an early
  // clearAgentReadyTimer() had nothing to clear. Checking presence at the
  // moment the alarm would ring is what keeps a working call from being told
  // that the relay never joined.
  state.agentReadyTimer = window.setTimeout(() => {
    if (state.agentReady || state.agentPresent) return;
    ui.setBanner(
      'The relay agent has not joined. This call needs translation, so you will hear nothing ' +
        'until it does — check that the agent process is running.',
      'error',
    );
  }, AGENT_READY_TIMEOUT_MS);
}

function clearAgentReadyTimer(): void {
  if (state.agentReadyTimer !== null) {
    window.clearTimeout(state.agentReadyTimer);
    state.agentReadyTimer = null;
  }
}

// --- judge (bilingual verdicts) -------------------------------------------

function resetJudge(join: JoinResponse): void {
  state.judge.log.reset();
  state.judge.correcting = null;
  setJudgeStatus(null);
  ui.setJudgeHandlers({
    onFlag: (offset) => {
      void flagUtterance(offset, join);
    },
    onCorrection: (text) => {
      void saveCorrection(text, join);
    },
  });
  paintJudge(join.mode !== 'DIRECT');
}

/** There is something to judge only inside a call that actually translates. */
function judgeEnabled(): boolean {
  return state.session !== null && state.session.mode !== 'DIRECT';
}

function paintJudge(enabled: boolean): void {
  ui.renderJudge({
    enabled,
    latest: state.judge.log.target(0),
    previous: state.judge.log.target(1),
    correcting: state.judge.correcting,
    status: state.judge.status,
  });
}

/** Only utterances addressed to me are judgeable — those are the ones I heard. */
function recordJudgeCandidate(msg: SubtitleMessage): void {
  const me = state.me;
  if (me && msg.listenerId && msg.listenerId !== me.id) return;
  const before = state.judge.log.size;
  state.judge.log.push(msg);
  if (state.judge.log.size !== before || msg.isFinal) {
    paintJudge(judgeEnabled());
  }
}

function setJudgeStatus(status: JudgeState['status']): void {
  if (state.judge.statusTimer !== null) {
    window.clearTimeout(state.judge.statusTimer);
    state.judge.statusTimer = null;
  }
  state.judge.status = status;
  if (status && status.tone !== 'error') {
    state.judge.statusTimer = window.setTimeout(() => {
      state.judge.statusTimer = null;
      state.judge.status = null;
      paintJudge(judgeEnabled());
    }, JUDGE_STATUS_MS);
  }
}

async function flagUtterance(offset: number, join: JoinResponse): Promise<void> {
  const me = state.me;
  const target = state.judge.log.target(offset);
  if (!me || !target) return;

  if (target.flagged) {
    // A second press on an utterance already marked wrong re-opens the
    // correction field instead of writing a duplicate verdict — a doubled row
    // would look like two independent judgements of the same sentence.
    state.judge.correcting = target;
    setJudgeStatus({ text: 'Already marked wrong. Add a correction if you want.', tone: 'info' });
    paintJudge(true);
    ui.focusCorrection();
    return;
  }

  // Optimistic by design: the verdict is recorded on screen the instant it is
  // pressed, because the tester is mid-sentence and must not wait for a POST.
  state.judge.log.markFlagged(target.utteranceId);
  state.judge.correcting = state.judge.log.byId(target.utteranceId);
  setJudgeStatus({ text: 'Marked wrong. Add what it should have said, or keep talking.', tone: 'ok' });
  paintJudge(true);
  ui.focusCorrection();
  repaintSubtitles();

  try {
    await api.sendVerdict(join.callId, {
      userId: me.id,
      verdict: 'wrong',
      utteranceId: target.utteranceId,
      // The heard text travels with the verdict so the report can still show
      // what was judged even if the id no longer resolves in the agent's log.
      note: `heard: ${target.dstText}`,
    });
  } catch (err) {
    setJudgeStatus({
      text: `NOT saved — ${describeError(err)}. Say it out loud so it is on the recording.`,
      tone: 'error',
    });
    paintJudge(true);
  }
}

async function saveCorrection(text: string, join: JoinResponse): Promise<void> {
  const me = state.me;
  const target = state.judge.correcting;
  state.judge.correcting = null;
  if (!me || !target) {
    paintJudge(judgeEnabled());
    return;
  }
  if (text.length === 0) {
    setJudgeStatus(null);
    paintJudge(true);
    return;
  }

  state.judge.log.markFlagged(target.utteranceId, text);
  setJudgeStatus({ text: 'Correction saved.', tone: 'ok' });
  paintJudge(true);

  try {
    await api.sendVerdict(join.callId, {
      userId: me.id,
      verdict: 'wrong',
      utteranceId: target.utteranceId,
      expected: text,
      note: `heard: ${target.dstText}`,
    });
  } catch (err) {
    setJudgeStatus({
      text: `The correction was NOT saved: ${describeError(err)}`,
      tone: 'error',
    });
    paintJudge(true);
  }
}

function repaintSubtitles(): void {
  const view = state.subtitles.view();
  ui.renderSubtitles(view, state.judge.log.flaggedSegmentIds());

  if (state.repaintTimer !== null) {
    window.clearTimeout(state.repaintTimer);
    state.repaintTimer = null;
  }
  if (view.nextChangeAt !== null) {
    const delay = Math.max(0, view.nextChangeAt - Date.now());
    state.repaintTimer = window.setTimeout(repaintSubtitles, delay + 10);
  }
}

function handleEnded(
  reason: 'local' | 'peer_left' | 'connection_lost' | 'server',
  join: JoinResponse,
): void {
  state.session = null;
  clearAgentReadyTimer();
  if (state.repaintTimer !== null) {
    window.clearTimeout(state.repaintTimer);
    state.repaintTimer = null;
  }
  ui.setConnectionState(ConnectionState.Disconnected);
  ui.setAudioUnlock(false, () => undefined);
  ui.setMuteButton(false, true);
  ui.setHangupEnabled(false);
  setParams({ call: null });

  // Back to watching for the next ring. The panel stays suspended until the
  // call screen is actually gone, so an offer cannot appear over a hangup.
  ringer.dispatch({ type: 'resume' });
  ringer.wake();

  switch (reason) {
    case 'local':
      ui.setBanner('Call ended.');
      break;
    case 'peer_left':
      ui.setBanner(`${join.peer.displayName} hung up.`);
      break;
    case 'connection_lost':
      ui.setBanner('Connection lost.', 'error');
      break;
    case 'server':
      ui.setBanner('The call was closed by the server.');
      break;
  }

  window.setTimeout(() => {
    void showContacts();
  }, 1200);
}

async function hangUp(): Promise<void> {
  const session = state.session;
  const me = state.me;
  ui.setHangupEnabled(false);
  if (!session) {
    await showContacts();
    return;
  }
  const callId = session.join.callId;
  await session.hangUp();
  if (me) {
    try {
      await api.endCall(callId, me.id);
    } catch {
      // The media session is already down; a failed bookkeeping call must not
      // strand the user on a dead screen.
    }
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access is gated in some contexts; the input is selectable as a
    // fallback, so there is nothing useful to report here.
  }
}

// --- static wiring --------------------------------------------------------

ui.onMute(() => {
  const session = state.session;
  if (!session || state.micFailure !== null) return;
  const next = !state.muted;
  state.muted = next;
  ui.setMuteButton(next, true);
  void session
    .setMuted(next)
    .finally(() => ui.setMuteButton(state.muted, state.micFailure !== null));
});

ui.onAudioHintDismissed(() => ui.dismissAudioHint());

ui.onHangup(() => {
  void hangUp();
});

ui.onJoinById((raw) => {
  void joinExistingCall(raw);
});

// iOS suspends media when the tab is backgrounded and often needs a fresh
// gesture to resume, so re-check playback on return instead of assuming the
// audio survived. Backgrounding must NOT drop the call - that is what a user
// switching apps mid-conversation does.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // A backgrounded tab polls slowly and its timers are throttled; check for a
  // ring immediately on return rather than making the caller wait it out.
  ringer.wake();
  const session = state.session;
  if (session && !session.canPlaybackAudio) {
    ui.setAudioUnlock(true, () => {
      void session.unlockAudio();
    });
  }
});

// pagehide with persisted=true means the page went into the back/forward cache
// (which iOS also uses when backgrounding), so only a real teardown hangs up.
window.addEventListener('pagehide', (ev) => {
  if (ev.persisted) return;
  stopRingingAttention();
  ringer.stop();
  // Explicit goodbye: without it the peer waits out the full presence TTL
  // before this tester's dot goes grey.
  if (state.me) api.goodbye(state.me.id);
  void state.session?.hangUp();
});

void boot();
