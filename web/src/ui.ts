import { ConnectionQuality, ConnectionState } from 'livekit-client';
import type { CallMetrics } from './call';
import { flagPreview, type FlagTarget } from './flags';
import type { PhoneAuthState } from './phone-auth';
import { outgoingText, ringClosedText, ringModeText, type RingState } from './ring';
import { dirForLang, langLabel, type SubtitleLine, type SubtitleView } from './subtitles';
import type { CallMode, ContactCard, Gender, JoinResponse, Lang, Tone, UserProfile } from './types';

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

const el = {
  banner: () => must<HTMLDivElement>('banner'),
  whoami: () => must<HTMLDivElement>('whoami'),
  footer: () => must<HTMLElement>('footer'),

  screenIdentity: () => must<HTMLElement>('screen-identity'),
  identityList: () => must<HTMLUListElement>('identity-list'),
  identityError: () => must<HTMLParagraphElement>('identity-error'),
  phoneAuth: () => must<HTMLDivElement>('phone-auth'),
  phoneForm: () => must<HTMLFormElement>('phone-form'),
  phoneInput: () => must<HTMLInputElement>('phone-input'),
  phoneCodeForm: () => must<HTMLFormElement>('phone-code-form'),
  phoneCodeInput: () => must<HTMLInputElement>('phone-code-input'),
  phoneDestination: () => must<HTMLElement>('phone-destination'),
  phoneDevCode: () => must<HTMLElement>('phone-dev-code'),
  phoneChange: () => must<HTMLButtonElement>('phone-change'),
  phoneAuthError: () => must<HTMLParagraphElement>('phone-auth-error'),
  profileForm: () => must<HTMLFormElement>('profile-form'),
  profilePhone: () => must<HTMLElement>('profile-phone'),
  profileName: () => must<HTMLInputElement>('profile-name'),
  profileLang: () => must<HTMLSelectElement>('profile-lang'),
  profileGender: () => must<HTMLSelectElement>('profile-gender'),

  screenContacts: () => must<HTMLElement>('screen-contacts'),
  contactList: () => must<HTMLUListElement>('contact-list'),
  contactsError: () => must<HTMLParagraphElement>('contacts-error'),
  joinForm: () => must<HTMLFormElement>('join-form'),
  joinInput: () => must<HTMLInputElement>('join-input'),

  screenCall: () => must<HTMLElement>('screen-call'),
  peerName: () => must<HTMLElement>('call-peer-name'),
  peerLang: () => must<HTMLElement>('call-peer-lang'),
  modeBadge: () => must<HTMLElement>('mode-badge'),
  connBadge: () => must<HTMLElement>('conn-badge'),
  modeExplainer: () => must<HTMLParagraphElement>('mode-explainer'),
  invite: () => must<HTMLDivElement>('invite'),
  inviteLink: () => must<HTMLInputElement>('invite-link'),
  inviteCopy: () => must<HTMLButtonElement>('invite-copy'),
  audioUnlock: () => must<HTMLButtonElement>('audio-unlock'),
  audioHint: () => must<HTMLDivElement>('audio-hint'),
  audioHintOk: () => must<HTMLButtonElement>('audio-hint-ok'),
  subtitleCommitted: () => must<HTMLDivElement>('subtitle-committed'),
  subtitlePartial: () => must<HTMLDivElement>('subtitle-partial'),
  subtitleEmpty: () => must<HTMLParagraphElement>('subtitle-empty'),
  selfmon: () => must<HTMLElement>('selfmon'),
  selfmonSrc: () => must<HTMLParagraphElement>('selfmon-src'),
  selfmonDst: () => must<HTMLParagraphElement>('selfmon-dst'),
  metrics: () => must<HTMLDivElement>('metrics'),
  btnMute: () => must<HTMLButtonElement>('btn-mute'),
  btnHangup: () => must<HTMLButtonElement>('btn-hangup'),
  callError: () => must<HTMLParagraphElement>('call-error'),

  audioSink: () => must<HTMLDivElement>('audio-sink'),

  incoming: () => must<HTMLDivElement>('incoming'),
  incomingEyebrow: () => must<HTMLSpanElement>('incoming-eyebrow'),
  incomingTitle: () => must<HTMLElement>('incoming-title'),
  incomingMeta: () => must<HTMLDivElement>('incoming-meta'),
  incomingExplainer: () => must<HTMLParagraphElement>('incoming-explainer'),
  incomingActions: () => must<HTMLDivElement>('incoming-actions'),
  incomingAccept: () => must<HTMLButtonElement>('incoming-accept'),
  incomingDecline: () => must<HTMLButtonElement>('incoming-decline'),
  incomingDismiss: () => must<HTMLButtonElement>('incoming-dismiss'),
  incomingNote: () => must<HTMLParagraphElement>('incoming-note'),

  outgoing: () => must<HTMLDivElement>('outgoing'),
  outgoingTitle: () => must<HTMLElement>('outgoing-title'),
  outgoingDetail: () => must<HTMLParagraphElement>('outgoing-detail'),
  outgoingCancel: () => must<HTMLButtonElement>('outgoing-cancel'),

  judge: () => must<HTMLDivElement>('judge'),
  judgeWrong: () => must<HTMLButtonElement>('judge-wrong'),
  judgePrev: () => must<HTMLButtonElement>('judge-prev'),
  judgeTarget: () => must<HTMLParagraphElement>('judge-target'),
  judgeFix: () => must<HTMLFormElement>('judge-fix'),
  judgeFixInput: () => must<HTMLInputElement>('judge-fix-input'),
  judgeStatus: () => must<HTMLParagraphElement>('judge-status'),
};

export const audioSink = (): HTMLElement => el.audioSink();

export type Screen = 'identity' | 'contacts' | 'call';

export function showScreen(screen: Screen): void {
  el.screenIdentity().hidden = screen !== 'identity';
  el.screenContacts().hidden = screen !== 'contacts';
  el.screenCall().hidden = screen !== 'call';
}

export function setBanner(text: string | null, tone: 'info' | 'error' = 'info'): void {
  const node = el.banner();
  if (!text) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.hidden = false;
  node.dataset['tone'] = tone;
  node.textContent = text;
}

function setError(node: HTMLElement, text: string | null): void {
  node.hidden = text === null;
  node.textContent = text ?? '';
}

export const setIdentityError = (text: string | null): void => setError(el.identityError(), text);
export const setContactsError = (text: string | null): void => setError(el.contactsError(), text);
export const setCallError = (text: string | null): void => setError(el.callError(), text);

export function setFooter(parts: string[]): void {
  el.footer().textContent = parts.join('  ·  ');
}

export interface PhoneAuthHandlers {
  onStart(phone: string): void;
  onVerify(code: string): void;
  onRestart(): void;
}

export function renderPhoneAuth(state: PhoneAuthState, handlers: PhoneAuthHandlers): void {
  const title = must<HTMLElement>('setup-title');
  const hint = must<HTMLElement>('setup-hint');
  const setup = must<HTMLElement>('setup');
  const phoneForm = el.phoneForm();
  const codeForm = el.phoneCodeForm();

  el.phoneAuth().hidden = state.phase === 'verified';
  phoneForm.hidden = state.phase !== 'phone';
  codeForm.hidden = state.phase !== 'code';
  setup.hidden = true;
  el.profileForm().hidden = state.phase !== 'verified';
  setError(el.phoneAuthError(), state.error);

  phoneForm.onsubmit = (event) => {
    event.preventDefault();
    handlers.onStart(el.phoneInput().value);
  };
  codeForm.onsubmit = (event) => {
    event.preventDefault();
    handlers.onVerify(el.phoneCodeInput().value.trim());
  };
  el.phoneChange().onclick = () => handlers.onRestart();

  if (state.phase === 'code') {
    title.textContent = 'Подтвердите номер';
    hint.textContent = 'Шесть цифр — и номер ваш.';
    el.phoneDestination().textContent = state.phone;
    el.phoneDevCode().textContent = state.devCode;
    queueMicrotask(() => el.phoneCodeInput().focus());
  } else if (state.phase === 'verified') {
    title.textContent = 'Создайте профиль';
    hint.textContent = 'Имя увидят люди, которые добавят вас в контакты.';
    el.profilePhone().textContent = state.phone;
  } else {
    title.textContent = 'Ваш номер';
    hint.textContent = 'Он станет вашим адресом в SameVoice.';
  }
}

export interface ProfileRegistrationInput {
  displayName: string;
  lang: Lang;
  gender: Gender;
}

export function renderProfileRegistration(
  onSubmit: (profile: ProfileRegistrationInput) => void,
): void {
  const form = el.profileForm();
  form.onsubmit = (event) => {
    event.preventDefault();
    onSubmit({
      displayName: el.profileName().value.trim(),
      lang: el.profileLang().value as Lang,
      gender: el.profileGender().value as Gender,
    });
  };
  queueMicrotask(() => el.profileName().focus());
}

export function showSeededIdentitySetup(): void {
  el.phoneAuth().hidden = true;
  el.profileForm().hidden = true;
  must<HTMLElement>('setup').hidden = false;
  must<HTMLElement>('setup-title').textContent = 'Быстрый тест';
  must<HTMLElement>('setup-hint').textContent = 'Выберите одну из предустановленных личностей.';
}

/**
 * Пол и тон нужны переводу (в иврите это грамматика, а не стиль), но человеку
 * на экране телефона они не нужны — контакт узнаётся по имени. Строка остаётся
 * только под `body[data-debug]`, где её и читают при разборе звонка.
 */
function genderTone(gender: Gender, tone: Tone): string {
  if (!document.body.dataset['debug']) return '';
  const g = gender === 'm' ? 'муж.' : gender === 'f' ? 'жен.' : 'пол неизвестен';
  return ` · ${g} · ${tone}`;
}

/** Инициал для аватара: первая буква имени. */
function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

/**
 * Цвет аватара выводится из имени, а не выдаётся по кругу: один и тот же
 * человек должен иметь один и тот же цвет в любом списке и после перезагрузки.
 */
function avatarFor(name: string): HTMLSpanElement {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const el = document.createElement('span');
  el.className = 'avatar';
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--avatar', `linear-gradient(160deg,hsl(${hue} 58% 46%),hsl(${(hue + 32) % 360} 58% 36%))`);
  el.textContent = initialOf(name);
  return el;
}

function langChip(lang: Lang): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'lang-chip';
  chip.dir = dirForLang(lang);
  chip.lang = lang;
  chip.textContent = langLabel(lang);
  return chip;
}

// --- role picker ----------------------------------------------------------

/**
 * Два вопроса вместо списка профилей: пол, затем язык.
 *
 * Почему так, а не ссылка на каждого: раздавать «твоя ссылка / её ссылка» —
 * это способ перепутать, кто ты, и получить двух одинаковых участников в одной
 * комнате. Одна голая ссылка на всех, а личность собирается из двух ответов и
 * только потом закрепляется в URL, чтобы пережить перезагрузку.
 *
 * Обе оси двоичные, поэтому в сиде обязаны существовать все ЧЕТЫРЕ угла
 * (см. `backend/src/store.ts`); если пара не разрешается, это ошибка сида, и
 * она показывается прямо, а не молча возвращает на первый шаг.
 */
export function renderRolePicker(
  users: UserProfile[],
  onResolved: (userId: string) => void,
): void {
  const root = document.getElementById('setup');
  if (!root) return;

  const stepOf = (name: string) => root.querySelector<HTMLElement>(`[data-step="${name}"]`);
  const gender = stepOf('gender');
  const lang = stepOf('lang');
  const back = document.getElementById('setup-back');
  const title = document.getElementById('setup-title');
  const hint = document.getElementById('setup-hint');
  if (!gender || !lang) return;

  let chosenGender: Gender | null = null;

  const show = (step: 'gender' | 'lang'): void => {
    gender.hidden = step !== 'gender';
    lang.hidden = step !== 'lang';
    if (title) title.textContent = step === 'gender' ? 'Говорите на своём' : 'Почти всё';
    if (hint) {
      hint.textContent =
        step === 'gender'
          ? 'Собеседник услышит свой язык. Вашим голосом.'
          : 'На каком языке говорите вы?';
    }
  };

  for (const btn of gender.querySelectorAll<HTMLButtonElement>('[data-gender]')) {
    btn.addEventListener('click', () => {
      chosenGender = btn.dataset['gender'] as Gender;
      show('lang');
    });
  }

  back?.addEventListener('click', () => {
    chosenGender = null;
    show('gender');
  });

  for (const btn of lang.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
    btn.addEventListener('click', () => {
      const wanted = btn.dataset['lang'] as Lang;
      const match = users.find((u) => u.gender === chosenGender && u.lang === wanted);
      if (!match) {
        setIdentityError(
          `Нет профиля для этой пары (${chosenGender}/${wanted}). Это ошибка данных на сервере, а не ваш выбор.`,
        );
        return;
      }
      setIdentityError(null);
      onResolved(match.id);
    });
  }

  show('gender');
}

// --- identity picker (отладочный список) ----------------------------------

export function renderIdentityPicker(users: UserProfile[], onPick: (userId: string) => void): void {
  const list = el.identityList();
  list.replaceChildren();
  for (const user of users) {
    const li = document.createElement('li');
    li.className = 'card';

    const main = document.createElement('div');
    main.className = 'card-main';

    const name = document.createElement('span');
    name.className = 'card-name';
    name.textContent = user.displayName;

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.append(langChip(user.lang), document.createTextNode(genderTone(user.gender, user.tone)));

    // Идентификатор — диагностика; в CSS `code` внутри карточки скрыт вне отладки.
    const id = document.createElement('code');
    id.textContent = user.id;
    meta.append(id);

    main.append(name, meta);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost';
    btn.textContent = 'Это я';
    btn.addEventListener('click', () => onPick(user.id));

    li.append(avatarFor(user.displayName), main, btn);
    list.append(li);
  }
}

export function renderWhoami(me: UserProfile | null, onSwitch: () => void): void {
  const node = el.whoami();
  node.replaceChildren();
  if (!me) return;
  node.append(document.createTextNode(`${me.displayName} `));
  node.append(langChip(me.lang));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'сменить';
  btn.addEventListener('click', onSwitch);
  node.append(btn);
}

// --- contacts -------------------------------------------------------------

export interface ContactHandlers {
  onCall(contact: ContactCard): void;
  onToggleForce(contact: ContactCard, force: boolean): void;
}

/**
 * userId -> online. Absent means "the backend has not said", which is rendered
 * as unknown rather than offline: claiming someone is offline when we simply do
 * not know would stop a tester from even trying to call.
 */
export type PresenceMap = Readonly<Record<string, boolean>>;

let lastContacts: { me: UserProfile; contacts: ContactCard[]; handlers: ContactHandlers } | null =
  null;

function presenceDot(state: boolean | undefined): HTMLSpanElement {
  const dot = document.createElement('span');
  dot.className = 'presence';
  dot.dataset['state'] = state === undefined ? 'unknown' : state ? 'online' : 'offline';
  // Глазами читается точка (текст скрыт в CSS), но скринридеру нужно слово.
  dot.textContent = state === undefined ? 'нет данных' : state ? 'в сети' : 'не в сети';
  return dot;
}

/** Repaints presence dots without rebuilding the list (which would fight a click). */
export function updatePresence(presence: PresenceMap): void {
  if (!lastContacts) return;
  const list = el.contactList();
  for (const li of Array.from(list.children)) {
    const userId = (li as HTMLElement).dataset['userId'];
    if (!userId) continue;
    const dot = li.querySelector('.presence');
    if (!dot) continue;
    const state = presence[userId];
    (dot as HTMLElement).dataset['state'] =
      state === undefined ? 'unknown' : state ? 'online' : 'offline';
    dot.textContent = state === undefined ? 'нет данных' : state ? 'в сети' : 'не в сети';
  }
}

export function renderContacts(
  me: UserProfile,
  contacts: ContactCard[],
  handlers: ContactHandlers,
  presence: PresenceMap = {},
): void {
  lastContacts = { me, contacts, handlers };
  const list = el.contactList();
  list.replaceChildren();

  if (contacts.length === 0) {
    const li = document.createElement('li');
    li.className = 'card';
    li.textContent = 'Пока никого нет.';
    list.append(li);
    return;
  }

  for (const contact of contacts) {
    const li = document.createElement('li');
    li.className = 'card';
    li.dataset['userId'] = contact.userId;

    const main = document.createElement('div');
    main.className = 'card-main';

    const name = document.createElement('span');
    name.className = 'card-name';
    name.textContent = contact.displayName;

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.append(presenceDot(presence[contact.userId]));
    meta.append(langChip(contact.lang));
    meta.append(document.createTextNode(genderTone(contact.gender, contact.tone)));

    if (Object.keys(contact.overrides).length > 0) {
      const override = document.createElement('code');
      override.textContent = 'override';
      meta.append(override);
    }

    // Predicted mode. The backend is the only authority (POST /api/calls), so
    // this is a preview, not a decision.
    const predicted = document.createElement('span');
    predicted.className = 'badge';
    const willTranslate = contact.forceTranslate || contact.lang !== me.lang;
    predicted.dataset['mode'] = willTranslate
      ? contact.forceTranslate
        ? 'FORCED'
        : 'TRANSLATED'
      : 'DIRECT';
    predicted.textContent = willTranslate ? 'с переводом' : 'без перевода';
    meta.append(predicted);

    const toggle = document.createElement('label');
    toggle.className = 'card-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = contact.forceTranslate;
    checkbox.addEventListener('change', () => handlers.onToggleForce(contact, checkbox.checked));
    toggle.append(checkbox, document.createTextNode('всегда переводить'));
    meta.append(toggle);

    main.append(name, meta);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    // Подпись читает скринридер; глазами видна иконка трубки из CSS.
    btn.setAttribute('aria-label', `Позвонить: ${contact.displayName}`);
    btn.addEventListener('click', () => handlers.onCall(contact));

    li.append(avatarFor(contact.displayName), main, btn);
    list.append(li);
  }
}

export function onJoinById(handler: (raw: string) => void): void {
  const form = el.joinForm();
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = el.joinInput().value.trim();
    if (value.length > 0) handler(value);
  });
}

// --- call screen ----------------------------------------------------------

const MODE_EXPLAINER: Record<CallMode, string> = {
  DIRECT:
    'Same language on both sides, so this is plain WebRTC. No AI is in the audio path and no agent joins the room — that is the healthy state, not a missing service.',
  TRANSLATED:
    'Different languages, so a relay agent sits in the path: speech recognition, translation, then speech. You hear only the translated track.',
  FORCED:
    'Translation was forced on for this contact, so the relay agent is in the path even though it might not be needed.',
};

export function renderCallHeader(join: JoinResponse): void {
  el.peerName().textContent = join.peer.displayName;

  const chip = el.peerLang();
  chip.dir = dirForLang(join.peer.lang);
  chip.lang = join.peer.lang;
  chip.textContent = langLabel(join.peer.lang);

  const badge = el.modeBadge();
  badge.dataset['mode'] = join.mode;
  badge.textContent = join.mode === 'FORCED' ? 'translated · forced' : join.mode.toLowerCase();

  el.modeExplainer().textContent = MODE_EXPLAINER[join.mode];
  el.subtitleEmpty().textContent =
    join.mode === 'DIRECT'
      ? 'No subtitles in direct mode — nothing is transcribing this call.'
      : 'Waiting for the first words…';
}

export function setConnectionState(state: ConnectionState): void {
  const badge = el.connBadge();
  badge.dataset['conn'] = state;
  badge.textContent = state === ConnectionState.SignalReconnecting ? 'reconnecting' : state;
}

export function setInviteLink(url: string | null, onCopy: () => void): void {
  const box = el.invite();
  if (!url) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const field = el.inviteLink();
  field.value = url;
  field.onfocus = () => field.select();
  const copy = el.inviteCopy();
  copy.onclick = () => {
    onCopy();
    copy.textContent = 'Скопировано';
    window.setTimeout(() => {
      copy.textContent = 'Копировать';
    }, 1500);
  };
}

export function setAudioUnlock(visible: boolean, onUnlock: () => void): void {
  const btn = el.audioUnlock();
  btn.hidden = !visible;
  btn.onclick = onUnlock;
}

export function setMuteButton(muted: boolean, disabled: boolean): void {
  const btn = el.btnMute();
  btn.dataset['muted'] = String(muted);
  btn.setAttribute('aria-label', muted ? 'Включить микрофон' : 'Выключить микрофон');
  const lbl = btn.querySelector('.round-label');
  if (lbl) lbl.textContent = muted ? 'Включить' : 'Микрофон';
  const use = btn.querySelector('use');
  if (use) use.setAttribute('href', muted ? '#i-mic-off' : '#i-mic');
  btn.dataset['active'] = String(muted);
  btn.disabled = disabled;
}

export function onMute(handler: () => void): void {
  el.btnMute().addEventListener('click', handler);
}

export function onHangup(handler: () => void): void {
  el.btnHangup().addEventListener('click', handler);
}

export function setHangupEnabled(enabled: boolean): void {
  el.btnHangup().disabled = !enabled;
}

// --- subtitles ------------------------------------------------------------

function renderLine(line: SubtitleLine, isFinal: boolean, flagged = false): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'sub-line';
  wrap.dataset['final'] = String(isFinal);
  wrap.dataset['flagged'] = String(flagged);

  // The translation is what the listener is meant to read, so it leads and it
  // carries the destination language's direction.
  const translation = document.createElement('p');
  translation.className = 'sub-translation';
  translation.dir = dirForLang(line.dstLang);
  translation.lang = line.dstLang;
  translation.textContent = line.dstText || (isFinal ? '—' : '…');
  wrap.dir = dirForLang(line.dstLang);

  const original = document.createElement('p');
  original.className = 'sub-original';
  original.dir = dirForLang(line.srcLang);
  original.lang = line.srcLang;
  original.textContent = line.srcText;

  if (flagged) {
    const mark = document.createElement('span');
    mark.className = 'sub-flag';
    mark.textContent = '⚑ marked wrong';
    wrap.append(mark);
  }

  wrap.append(translation, original);
  return wrap;
}

export function renderSubtitles(view: SubtitleView, flagged?: ReadonlySet<string>): void {
  const committed = el.subtitleCommitted();
  committed.replaceChildren(
    ...view.committed.map((line) => renderLine(line, true, flagged?.has(line.segmentId) ?? false)),
  );

  const partial = el.subtitlePartial();
  partial.replaceChildren(...(view.partial ? [renderLine(view.partial, false)] : []));

  el.subtitleEmpty().hidden = view.committed.length > 0 || view.partial !== null;
}

export function clearSubtitles(): void {
  el.subtitleCommitted().replaceChildren();
  el.subtitlePartial().replaceChildren();
  el.subtitleEmpty().hidden = false;
}

// --- speaker self-monitor (debug builds only) -----------------------------
// Answers the one question the 26.08.2026 call could not: "is it hearing me?"
// Deliberately shows the SOURCE text first - a speaker who sees their own words
// recognised knows the microphone and the recogniser are fine, and that anything
// still broken lives further down the chain.

export function renderSelfMonitor(src: string, dst: string, dstLang: Lang): void {
  const node = el.selfmon();
  el.selfmonSrc().textContent = src;
  const dstNode = el.selfmonDst();
  dstNode.textContent = dst;
  dstNode.lang = dstLang;
  dstNode.dir = dirForLang(dstLang);
  node.dataset.live = src || dst ? '1' : '0';
}

// --- loudspeaker warning --------------------------------------------------
// Only on touch devices: on a laptop nobody presses the screen to their ear.

const AUDIO_HINT_SEEN = 'samevoice.audioHintSeen';

export function maybeShowAudioHint(): void {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  let seen = false;
  try {
    seen = window.localStorage.getItem(AUDIO_HINT_SEEN) === '1';
  } catch {
    seen = false; // private mode: better to warn twice than never
  }
  el.audioHint().hidden = !touch || seen;
}

export function dismissAudioHint(): void {
  el.audioHint().hidden = true;
  try {
    window.localStorage.setItem(AUDIO_HINT_SEEN, '1');
  } catch {
    /* nothing to remember it in; the hint simply returns next call */
  }
}

export function onAudioHintDismissed(handler: () => void): void {
  el.audioHintOk().addEventListener('click', handler);
}

export function clearSelfMonitor(): void {
  el.selfmonSrc().textContent = '';
  el.selfmonDst().textContent = '';
  el.selfmon().dataset.live = '0';
}

// --- latency readout ------------------------------------------------------

export function renderMetrics(metrics: CallMetrics, extra: Record<string, string> = {}): void {
  const node = el.metrics();
  node.replaceChildren();

  const items: Array<[string, string, boolean]> = [
    ['rtt', metrics.rttMs === null ? '—' : `${metrics.rttMs} ms`, (metrics.rttMs ?? 0) > 150],
    [
      'jitterbuf',
      metrics.jitterBufferMs === null ? '—' : `${metrics.jitterBufferMs} ms`,
      (metrics.jitterBufferMs ?? 0) > 200,
    ],
    [
      'segment',
      metrics.segmentMs === null ? '—' : `${metrics.segmentMs} ms`,
      (metrics.segmentMs ?? 0) > 1500,
    ],
    ['link', metrics.quality ?? '—', metrics.quality === ConnectionQuality.Poor],
  ];

  for (const [key, value] of Object.entries(extra)) {
    items.push([key, value, false]);
  }

  for (const [label, value, warn] of items) {
    const span = document.createElement('span');
    span.className = 'metric';
    span.dataset['warn'] = String(warn);
    const strong = document.createElement('strong');
    strong.textContent = value;
    span.append(document.createTextNode(`${label} `), strong);
    node.append(span);
  }
}

// --- incoming call --------------------------------------------------------

export interface IncomingHandlers {
  onAccept(): void;
  onDecline(): void;
  onDismiss(): void;
}

let incomingWired = false;
let incomingHandlers: IncomingHandlers | null = null;

function wireIncoming(): void {
  if (incomingWired) return;
  incomingWired = true;
  el.incomingAccept().addEventListener('click', () => incomingHandlers?.onAccept());
  el.incomingDecline().addEventListener('click', () => incomingHandlers?.onDecline());
  el.incomingDismiss().addEventListener('click', () => incomingHandlers?.onDismiss());
}

/**
 * Paints the whole ring panel from one immutable state. Every visible variant
 * — ringing, accepting, declining, caller gave up, call already over, backend
 * unreachable — is a branch here rather than a scattered set of imperative
 * toggles, so no combination can leave a stale button on screen.
 */
export function renderIncoming(state: RingState, handlers: IncomingHandlers): void {
  wireIncoming();
  incomingHandlers = handlers;

  const box = el.incoming();
  const showRing = state.phase !== 'idle' && state.call !== null;
  if (!showRing) {
    box.hidden = true;
    return;
  }
  const call = state.call;
  if (!call) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.dataset['phase'] = state.phase;

  const busy = state.phase === 'accepting' || state.phase === 'declining';
  const closed = state.phase === 'closed';

  el.incomingEyebrow().textContent = closed
    ? 'Call'
    : state.phase === 'accepting'
      ? 'Answering…'
      : state.phase === 'declining'
        ? 'Declining…'
        : 'Входящий звонок';

  el.incomingTitle().textContent = closed
    ? ringClosedText(state, call.from.displayName)
    : `${call.from.displayName} is calling`;

  const meta = el.incomingMeta();
  meta.replaceChildren();
  if (!closed) {
    meta.append(langChip(call.from.lang));
    meta.append(document.createTextNode(genderTone(call.from.gender, call.from.tone)));
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.dataset['mode'] = call.mode;
    badge.textContent = call.mode === 'FORCED' ? 'translated · forced' : call.mode.toLowerCase();
    meta.append(badge);
    if (call.secondsRemaining > 0) {
      const countdown = document.createElement('span');
      countdown.className = 'incoming-countdown';
      countdown.textContent = `${call.secondsRemaining}s`;
      meta.append(countdown);
    }
  }

  const explainer = el.incomingExplainer();
  explainer.hidden = closed;
  explainer.textContent = closed ? '' : ringModeText(call.mode);

  el.incomingActions().hidden = closed;
  el.incomingAccept().disabled = busy;
  el.incomingDecline().disabled = busy;
  el.incomingAccept().textContent = state.phase === 'accepting' ? 'Answering…' : 'Accept';

  const dismiss = el.incomingDismiss();
  dismiss.hidden = !closed;

  setError(el.incomingNote(), state.error);
}

// --- outgoing ring (the caller's side) ------------------------------------

let outgoingWired = false;
let outgoingCancel: (() => void) | null = null;

export function renderOutgoing(state: RingState, onCancel: () => void): void {
  if (!outgoingWired) {
    outgoingWired = true;
    el.outgoingCancel().addEventListener('click', () => outgoingCancel?.());
  }
  outgoingCancel = onCancel;

  const box = el.outgoing();
  if (state.outgoingPhase === 'idle' || !state.outgoing) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.dataset['phase'] = state.outgoingPhase;

  el.outgoingTitle().textContent = outgoingText(state);

  const detail = el.outgoingDetail();
  const closed = state.outgoingPhase === 'closed';
  detail.textContent = closed ? '' : ringModeText(state.outgoing.mode);
  detail.hidden = closed;

  const cancel = el.outgoingCancel();
  const cancellable = state.outgoingPhase === 'ringing' || state.outgoingPhase === 'answered';
  cancel.hidden = closed;
  cancel.disabled = !cancellable;
}

// --- judge (bilingual verdicts) -------------------------------------------

export interface JudgeView {
  /** DIRECT calls have nothing to judge — no translation happened. */
  enabled: boolean;
  latest: FlagTarget | null;
  previous: FlagTarget | null;
  /** Utterance currently accepting a written correction, if any. */
  correcting: FlagTarget | null;
  status: { text: string; tone: 'ok' | 'error' | 'info' } | null;
}

export interface JudgeHandlers {
  /** offset 0 = the most recent utterance, 1 = the one before it. */
  onFlag(offset: number): void;
  onCorrection(text: string): void;
}

let judgeWired = false;
let judgeHandlers: JudgeHandlers | null = null;

function wireJudge(): void {
  if (judgeWired) return;
  judgeWired = true;
  el.judgeWrong().addEventListener('click', () => judgeHandlers?.onFlag(0));
  el.judgePrev().addEventListener('click', () => judgeHandlers?.onFlag(1));
  el.judgeFix().addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = el.judgeFixInput();
    const value = input.value.trim();
    input.value = '';
    judgeHandlers?.onCorrection(value);
  });
}

export function setJudgeHandlers(handlers: JudgeHandlers): void {
  wireJudge();
  judgeHandlers = handlers;
}

function targetLabel(prefix: string, target: FlagTarget | null): string {
  const preview = flagPreview(target);
  return preview ? `${prefix} “${preview}”` : '';
}

export function renderJudge(view: JudgeView): void {
  wireJudge();
  const box = el.judge();
  if (!view.enabled) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const wrong = el.judgeWrong();
  wrong.disabled = view.latest === null;
  wrong.dataset['flagged'] = String(view.latest?.flagged ?? false);

  const prev = el.judgePrev();
  prev.hidden = view.previous === null;
  prev.disabled = view.previous === null;
  prev.dataset['flagged'] = String(view.previous?.flagged ?? false);
  prev.title = targetLabel('Marks:', view.previous);

  const target = el.judgeTarget();
  if (view.latest === null) {
    target.textContent = 'Пока нечего отмечать.';
  } else {
    target.textContent = targetLabel('Marks:', view.latest);
    target.dir = dirForLang(view.latest.dstLang);
    target.lang = view.latest.dstLang;
  }

  const fix = el.judgeFix();
  fix.hidden = view.correcting === null;
  if (view.correcting) {
    const input = el.judgeFixInput();
    input.dir = dirForLang(view.correcting.dstLang);
    input.lang = view.correcting.dstLang;
  }

  const status = el.judgeStatus();
  if (!view.status) {
    status.hidden = true;
    status.textContent = '';
  } else {
    status.hidden = false;
    status.dataset['tone'] = view.status.tone;
    status.textContent = view.status.text;
  }
}

export function focusCorrection(): void {
  // On a touch device focusing this field throws up the on-screen keyboard,
  // which covers the subtitles mid-conversation — exactly what the one-tap
  // control exists to avoid. Only take focus where a keyboard is already there.
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const input = el.judgeFixInput();
  // Focus, but never scroll the subtitles out of view to do it: the words on
  // screen matter more than the field.
  input.focus({ preventScroll: true });
}
