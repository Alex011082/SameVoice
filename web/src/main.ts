import './styles.css';

import { ConnectionState } from 'livekit-client';
import { api, ApiRequestError, BACKEND_URL } from './api';
import { startRingingAttention, stopRingingAttention } from './attention';
import { AutoJoinGate } from './autojoin';
import { CallSession, micFailureText, type CallMetrics, type MicFailureKind } from './call';
import { renderAddContact } from './contacts-add';
import { contactsModel } from './contact-directory';
import { authErrorText, callErrorText, contactsErrorText } from './errors';
import { FlagLog, type FlagTarget } from './flags';
import { phoneAuthInitial, reducePhoneAuth, type PhoneAuthState } from './phone-auth';
import { loginWithPasskey, passkeysSupported, registerPasskey } from './passkeys';
import { profileUrl } from './profile-navigation';
import { byGender } from './russian';
import { RingPoller } from './ringpoll';
import { selectSeededIdentities } from './seeded-identities';
import { mountSettingsButton } from './settings';
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

let phoneAuth: PhoneAuthState = phoneAuthInitial();

// --- url helpers ----------------------------------------------------------

function param(name: string): string | null {
  return new URL(window.location.href).searchParams.get(name);
}

/**
 * `?debug=1` возвращает на экран диагностику, спрятанную от обычного глаза:
 * состояние соединения, замеры задержки по стадиям, адреса провайдеров в
 * подвале, переключатель принудительного перевода и панель самоконтроля.
 *
 * ЧТО ИЗ ЭТОГО СПИСКА УШЛО НАРУЖУ 31.08.2026 и почему. Режим звонка и пол
 * контакта раньше прятались здесь же — и оказалось, что без них карточка
 * четырёх тестовых аккаунтов вырождается в четыре одинаковых имени. Основатель
 * не мог понять, кому звонить, чтобы проверить русский→иврит с женским родом,
 * то есть диагностика прятала ровно ту вещь, ради которой эти аккаунты и
 * существуют. Теперь направление перевода и род видны всегда; под флагом
 * осталось то, что действительно нужно только при разборе поломки.
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
          'Не удалось войти в отвеченный звонок за несколько попыток. Обновите страницу и позвоните снова.',
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
    ui.setContactsError(`Не удалось войти в отвеченный звонок: ${describeError(err)}`);
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
    // Без /api/config клиент не знает ни адреса медиасервера, ни провайдеров:
    // звонить физически нечем, поэтому это не предупреждение, а диагноз.
    ui.setBanner(authErrorText('phone', err), 'error');
    ui.setIdentityError(`Технические подробности: ${describeError(err)}`);
    return;
  }
  state.config = cfg;

  ui.setFooter([
    backendLabel(),
    `livekit ${cfg.livekitUrl}`,
    `stt:${cfg.providers.stt} mt:${cfg.providers.mt} tts:${cfg.providers.tts}`,
  ]);

  // Вход помнится САМИМ БРАУЗЕРОМ: сессия живёт в куке 30 дней и привязана
  // к устройству. Раньше приложение смотрело только на ?me= в адресе, поэтому
  // обычное обновление страницы выбрасывало человека на ввод кода заново.
  let meId = param('me');
  if (!meId) {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'include' });
      if (res.ok) {
        const body = (await res.json()) as { user?: { id?: string } };
        if (body.user?.id) meId = body.user.id;
      }
    } catch {
      // сеть подведёт — покажем обычный вход, это не авария
    }
  }
  if (!meId) {
    await showIdentityPicker();
    return;
  }

  try {
    state.me = await api.getUser(meId);
  } catch (err) {
    await showIdentityPicker();
    ui.setIdentityError(`Профиль «${meId}» сервер не знает: ${describeError(err)}`);
    return;
  }

  ui.renderWhoami(state.me, () => {
    setParams({ me: null, call: null });
    window.location.reload();
  });
  mountSettingsButton(state.me, () => {
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
  if (param('debug') === '1') {
    ui.showSeededIdentitySetup();
    await renderSeededIdentities();
    return;
  }
  ui.renderPhoneAuth(phoneAuth, {
    onStart: (phone) => {
      void startPhoneConfirmation(phone);
    },
    onVerify: (code) => {
      void verifyPhoneConfirmation(code);
    },
    onRestart: () => {
      phoneAuth = reducePhoneAuth(phoneAuth, { type: 'restart' });
      void showIdentityPicker();
    },
  });
  mountPasskeyLogin();
  if (phoneAuth.phase !== 'verified') return;
  ui.renderProfileRegistration((profile) => {
    void registerProfile(profile);
  });
}

/* Вход без кода. Кнопка появляется там, где браузер умеет пасскеи, —
 * заранее знать, есть ли у человека ключ, экран входа не может, поэтому
 * отказ выбора в системном окне просто возвращает на телефонный вход. */
function mountPasskeyLogin(): void {
  const btn = document.getElementById('passkey-login') as HTMLButtonElement | null;
  const note = document.getElementById('passkey-login-note');
  if (!btn || !passkeysSupported()) return;
  btn.hidden = false;
  if (btn.dataset['wired']) return;
  btn.dataset['wired'] = '1';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    if (note) note.hidden = true;
    loginWithPasskey()
      .then(() => {
        // сессия уже стоит (кука + копия в памяти устройства) — просто входим
        setParams({ me: null });
        window.location.reload();
      })
      .catch((err) => {
        btn.disabled = false;
        if (note) {
          note.textContent = `Не вышло: ${describeError(err)}. Войдите по номеру — и включите вход без кода заново.`;
          note.hidden = false;
        }
      });
  });
}

/* Предложение включить вход без кода — один раз после входа по номеру. */
const PASSKEY_SNOOZE = 'sv-passkey-snooze';
async function maybeOfferPasskey(): Promise<void> {
  if (!passkeysSupported()) return;
  try {
    if (Number(localStorage.getItem(PASSKEY_SNOOZE) ?? 0) > Date.now()) return;
  } catch {
    return;
  }
  try {
    const res = await fetch('/api/auth/passkey', { credentials: 'include' });
    if (!res.ok) return;
    const mine = (await res.json()) as { count: number };
    if (mine.count > 0) return;
  } catch {
    return;
  }
  if (document.getElementById('passkey-offer')) return;
  const card = document.createElement('div');
  card.id = 'passkey-offer';
  card.className = 'banner';
  card.innerHTML =
    'Устали от кодов? Включите вход по Face ID или отпечатку — код больше не понадобится. ' +
    '<span class="passkey-offer-acts"></span>';
  const acts = card.querySelector('.passkey-offer-acts') as HTMLElement;
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'btn';
  yes.textContent = 'Включить';
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'btn btn-ghost';
  later.textContent = 'Позже';
  acts.append(yes, later);
  const screen = document.getElementById('screen-contacts');
  screen?.prepend(card);
  later.addEventListener('click', () => {
    try {
      localStorage.setItem(PASSKEY_SNOOZE, String(Date.now() + 3 * 24 * 60 * 60 * 1000));
    } catch {
      /* некритично */
    }
    card.remove();
  });
  yes.addEventListener('click', () => {
    yes.disabled = true;
    registerPasskey()
      .then(() => {
        card.textContent = 'Готово. В следующий раз — просто Face ID или отпечаток.';
        setTimeout(() => card.remove(), 6000);
      })
      .catch((err) => {
        yes.disabled = false;
        card.append(` Не вышло: ${describeError(err)}`);
      });
  });
}

async function renderSeededIdentities(): Promise<void> {
  try {
    const users = selectSeededIdentities(await api.listUsers());
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

async function startPhoneConfirmation(phone: string): Promise<void> {
  try {
    const challenge = await api.startPhoneVerification(phone);
    phoneAuth = reducePhoneAuth(phoneAuth, {
      type: 'code_sent',
      challengeId: challenge.challengeId,
      phone: challenge.phone,
      devCode: challenge.devCode,
    });
  } catch (err) {
    phoneAuth = reducePhoneAuth(phoneAuth, { type: 'failed', message: authErrorText('phone', err) });
  }
  await showIdentityPicker();
}

async function verifyPhoneConfirmation(code: string): Promise<void> {
  if (phoneAuth.phase !== 'code') return;
  try {
    const verified = await api.verifyPhone(phoneAuth.challengeId, code);
    if (verified.existingUser) {
      window.location.assign(profileUrl(window.location.href, verified.existingUser.id));
      return;
    }
    phoneAuth = reducePhoneAuth(phoneAuth, {
      type: 'verified',
      registrationToken: verified.registrationToken,
    });
  } catch (err) {
    phoneAuth = reducePhoneAuth(phoneAuth, { type: 'failed', message: authErrorText('code', err) });
  }
  await showIdentityPicker();
}

async function registerProfile(profile: ui.ProfileRegistrationInput): Promise<void> {
  if (phoneAuth.phase !== 'verified') return;
  try {
    const registered = await api.registerProfile(phoneAuth.registrationToken, profile);
    window.location.assign(profileUrl(window.location.href, registered.user.id));
  } catch (err) {
    phoneAuth = reducePhoneAuth(phoneAuth, {
      type: 'failed',
      message: authErrorText('profile', err),
    });
    await showIdentityPicker();
  }
}

/* ИИ-собеседники: звонок им должен идти через ДВИЖОК, ради этого они и
 * существуют. Если движок ещё не поднят, «позвонить» превращается в бронь на
 * ближайший срок: оркестратор греет карту, бот сам подтверждает, а в срок
 * приходит пуш и звонок начинается сам (sv-booking.js). Те же id живут в
 * store.js бэкенда (DRILL_SPEAKER_IDS). */
const AI_COMPANIONS = new Set(['u_141560d817f7c1af', 'u_6df46c7f61d47836']);

async function callOrWarmForBot(contact: ContactCard): Promise<void> {
  if (!AI_COMPANIONS.has(contact.userId)) {
    void startCall(contact);
    return;
  }
  // Автосозвон в срок брони: время пришло, движок грет (или почти) — звоним
  // сразу. Заводить отсюда новую бронь = бег по кругу (18:32, 03.09).
  if ((window as { __svAutoCallNow?: string | null }).__svAutoCallNow) {
    void startCall(contact);
    return;
  }
  try {
    const res = await fetch('/orch/call-bot', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botUserId: contact.userId }),
    });
    const data = (await res.json()) as { ready?: boolean; booking?: { startsAt: number } };
    if (res.ok && data.ready) {
      void startCall(contact);
      return;
    }
    if (res.ok && data.booking) {
      const dt = new Date(data.booking.startsAt);
      const hh = `${dt.getHours()}`.padStart(2, '0');
      const mm = `${dt.getMinutes()}`.padStart(2, '0');
      ui.setBanner(
        `Поднимаю движок под этот разговор. В ${hh}:${mm} соединю с ${contact.displayName} сам — ` +
          'можно свернуть приложение, придёт пуш.',
      );
      return;
    }
    throw new Error('оркестратор не ответил');
  } catch {
    // Оркестратор недоступен — не блокировать человека, зовём облаком.
    void startCall(contact);
  }
}

/**
 * Экран контактов.
 *
 * Оба запроса уходят вместе и падают порознь. Список пользователей нужен не для
 * красоты: пока `GET /api/users` отвечает, четыре тестовых аккаунта остаются на
 * экране и звонить есть куда — даже если контакты этого пользователя сервер не
 * отдал. Жалоба основателя, ради которой это написано: после подтверждения
 * номера контактов не было вовсе, и позвонить было НЕКУДА.
 */
async function showContacts(): Promise<void> {
  const me = state.me;
  if (!me) return;
  ui.showScreen('contacts');
  clearBanner();
  void maybeOfferPasskey();
  ui.setContactsError(null);

  const [contactsResult, usersResult] = await Promise.allSettled([
    api.listContacts(me.id),
    api.listUsers(),
  ]);

  const contacts = contactsResult.status === 'fulfilled' ? contactsResult.value : null;
  const users = usersResult.status === 'fulfilled' ? usersResult.value : null;
  const failure =
    contactsResult.status === 'rejected'
      ? contactsErrorText(contactsResult.reason)
      : usersResult.status === 'rejected'
        ? contactsErrorText(usersResult.reason)
        : null;

  const model = contactsModel({ me, contacts, users, failure });

  ui.renderContacts(
    me,
    model,
    {
      onCall: (contact) => {
        void callOrWarmForBot(contact);
      },
      onToggleForce: (contact, force) => {
        void (async () => {
          try {
            await api.updateContact(me.id, contact.userId, { forceTranslate: force });
            await showContacts();
          } catch (err) {
            ui.setContactsError(contactsErrorText(err));
          }
        })();
      },
    },
    ringer.current.peers,
  );

  // Как в списке появляется новый живой человек: по номеру, приглашением или
  // из книги там, где браузер её отдаёт. Панель живёт под списком и
  // перерисовывается вместе с ним.
  renderAddContact(document.getElementById('screen-contacts') as HTMLElement, () => {
    void showContacts();
  });

  // Когда список всё-таки есть, отказ показывается отдельной строкой: список
  // неполон, и молчать об этом нельзя. Когда списка нет, тот же текст уже стоит
  // на месте пустого экрана, и повторять его второй раз незачем.
  ui.setContactsError(failure !== null && model.kind === 'list' ? failure : null);

  // The list was just rebuilt, so re-attach whatever the ring state knows.
  ui.renderOutgoing(ringer.current, () => {
    void cancelOutgoing();
  });
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
        `Перевод нужен, но агент не взял задачу (${call.agent.error ?? 'причина не названа'}). ` +
          'Звонок соединится без перевода.',
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
          `${contact.displayName} сейчас не в сети — звонок пойдёт, но отвечать может быть некому.`,
        );
      }
      return;
    }

    setParams({ call: call.id });
    await enterCall(call.id, true);
  } catch (err) {
    ui.setContactsError(callErrorText(err));
  }
}

async function joinExistingCall(rawRef: string): Promise<void> {
  const callId = parseCallRef(rawRef);
  if (!callId) {
    ui.setContactsError(`«${rawRef}» — это не код звонка и не ссылка-приглашение.`);
    await showContacts();
    return;
  }
  // The `?call=` parameter outlives the call: it is still in the address bar
  // after a reload, a restored tab, or a night's sleep. Once the backend has
  // said that call is over, asking again is not going to help.
  if (autoJoin.isAbandoned(callId)) {
    setParams({ call: null });
    ui.setContactsError(`Звонок ${callId} уже завершён. Начните новый.`);
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
    ui.setBanner('Не удалось войти в этот звонок.', 'error');
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
          ui.setBanner(
            `${join.peer.displayName} ${byGender(join.peer.gender, 'вышел', 'вышла')} из звонка.`,
          );
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
    ui.setBanner('Не удалось соединиться с медиасервером.', 'error');
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
        `Перевод сломался: ${msg.detail || 'агент-передатчик сообщил об ошибке'}. ` +
          'Пока он не восстановится, вы не услышите собеседника.',
        'error',
      );
      break;
    case 'agent_left':
      state.agentReady = false;
      state.agentPresent = false;
      ui.setBanner('Агент-передатчик вышел из звонка. Перевод остановлен.', 'error');
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
      'Агент-передатчик так и не подключился. Этому звонку нужен перевод, поэтому без агента ' +
        'вы ничего не услышите — проверьте, запущен ли процесс агента.',
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
      ui.setBanner('Звонок завершён.');
      break;
    case 'peer_left':
      ui.setBanner(
        `${join.peer.displayName} ${byGender(join.peer.gender, 'положил', 'положила')} трубку.`,
      );
      break;
    case 'connection_lost':
      ui.setBanner('Связь потеряна.', 'error');
      break;
    case 'server':
      ui.setBanner('Звонок закрыт сервером.');
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
