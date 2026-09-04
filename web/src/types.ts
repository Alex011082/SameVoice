// Shared DTOs. The block down to ApiError must stay byte-compatible with
// backend/src/types.ts; SubtitleMessage / StateMessage are web-only additions
// that mirror the agent's wire format.

export type Lang = 'ru' | 'he';
export type Gender = 'm' | 'f' | 'u';
export type Tone = 'neutral' | 'friendly' | 'formal';
export type CallMode = 'DIRECT' | 'TRANSLATED' | 'FORCED';
export type CallState = 'created' | 'active' | 'ended';
export type ModeReason = 'languages_match' | 'languages_differ' | 'forced_by_user';

export interface UserProfile {
  id: string;
  handle: string;
  displayName: string;
  lang: Lang;
  gender: Gender;
  tone: Tone;
}

export interface ContactCard {
  userId: string;
  displayName: string;
  lang: Lang;
  gender: Gender;
  tone: Tone;
  forceTranslate: boolean;
  overrides: { lang?: Lang; gender?: Gender; tone?: Tone };
}

export interface CallParticipant {
  userId: string;
  displayName: string;
  lang: Lang;
  gender: Gender;
  tone: Tone;
  role: 'caller' | 'callee';
}

export interface CallAgentInfo {
  required: boolean;
  dispatched: boolean;
  identity: string | null;
  error: string | null;
}

export interface Call {
  id: string;
  roomName: string;
  mode: CallMode;
  reason: ModeReason;
  state: CallState;
  createdAt: string;
  endedAt: string | null;
  participants: CallParticipant[];
  agent: CallAgentInfo;
}

export interface JoinResponse {
  token: string;
  livekitUrl: string;
  roomName: string;
  callId: string;
  mode: CallMode;
  self: Omit<CallParticipant, 'role'>;
  peer: Omit<CallParticipant, 'role'>;
  agentIdentity: string | null;
  expectedAgentTrackName: string | null;
  ttlSeconds: number;
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface PhoneChallengeResponse {
  challengeId: string;
  phone: string;
  /** Development-only delivery channel. Replaced by SMS later. */
  devCode: string;
  expiresInSeconds: number;
}

export interface PhoneVerifiedResponse {
  verified: true;
  phone: string;
  registrationToken: string;
  existingUser: UserProfile | null;
}

export interface RegisterProfileResponse {
  created: boolean;
  user: UserProfile;
}

// --- ringing ---------------------------------------------------------------
// Presence + ring notification, mirroring backend/src/types.ts. One POST
// /api/presence is both the heartbeat and the poll; there are no websockets in
// this stack by design.

/** Backend ring lifecycle. Only `ringing` and `accepted` are live. */
export type RingLifecycle = 'ringing' | 'accepted' | 'declined' | 'cancelled' | 'timeout';

export const RING_TERMINAL: readonly RingLifecycle[] = ['declined', 'cancelled', 'timeout'];

export interface RingView {
  callId: string;
  roomName: string;
  mode: CallMode;
  reason: ModeReason;
  ringState: RingLifecycle;
  callState: CallState;
  /** The caller — "Alex is calling" on the callee's screen. */
  from: Omit<CallParticipant, 'role'>;
  /** The callee. */
  to: Omit<CallParticipant, 'role'>;
  startedAt: string;
  expiresAt: string;
  respondedAt: string | null;
  /** Server-computed and clamped at 0, so the client needs no clock-skew maths. */
  secondsRemaining: number;
}

export interface PresenceView {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
  ttlSeconds: number;
}

export interface RingPollResponse {
  now: string;
  self: PresenceView;
  peers: PresenceView[];
  /** Someone is ringing me. */
  incoming: RingView | null;
  /** A ring I started — including a terminal one, inside the server's grace window. */
  outgoing: RingView | null;
  pollIntervalMs: number;
}

// --- judge verdicts --------------------------------------------------------

export type JudgeVerdict = 'wrong' | 'ok';

/** Body of POST /api/calls/:callId/verdict. */
export interface JudgeVerdictInput {
  userId: string;
  verdict: JudgeVerdict;
  /** Omit to label the most recent translated utterance the agent logged. */
  utteranceId?: string;
  expected?: string;
  note?: string;
}

export interface AppConfig {
  livekitUrl: string;
  providers: { stt: string; mt: string; tts: string };
  agentIdentity: string;
  subtitleTopic: string;
  stateTopic: string;
  /** Present once the backend has ringing; absent on an older backend. */
  ring?: {
    timeoutSeconds: number;
    presenceTtlSeconds: number;
    pollIntervalMs: number;
  };
}

// --- in-room messages (LiveKit text streams) -------------------------------

export interface SubtitleMessage {
  v: 1;
  callId: string;
  /** Stable across the partial -> final lifetime of one utterance fragment. */
  segmentId: string;
  /**
   * Key of this utterance's row in the eval JSONL, when the agent sends one.
   * Absent on older agents; flags.ts falls back to segmentId, which is the same
   * stable identity.
   */
  utteranceId?: string;
  /** Monotonically increasing per segment, starts at 0. */
  seq: number;
  speakerId: string;
  /** The only recipient of this message. */
  listenerId: string;
  srcLang: Lang;
  dstLang: Lang;
  srcText: string;
  /** "" while isFinal === false, and also when MT failed. */
  dstText: string;
  isFinal: boolean;
  /** Seconds since call start. */
  tStart: number;
  tEnd: number;
}

export interface StateMessage {
  v: 1;
  callId: string;
  event: 'agent_ready' | 'agent_error' | 'agent_left';
  mode: CallMode;
  /** "" unless event === "agent_error". */
  detail: string;
  providers: { stt: string; mt: string; tts: string };
}

// --- narrow runtime guards for anything crossing the network ---------------

export function isSubtitleMessage(value: unknown): value is SubtitleMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m['callId'] === 'string' &&
    typeof m['segmentId'] === 'string' &&
    typeof m['seq'] === 'number' &&
    typeof m['speakerId'] === 'string' &&
    typeof m['srcLang'] === 'string' &&
    typeof m['dstLang'] === 'string' &&
    typeof m['srcText'] === 'string' &&
    typeof m['dstText'] === 'string' &&
    typeof m['isFinal'] === 'boolean'
  );
}

const LANGS = new Set<string>(['ru', 'he']);
const GENDERS = new Set<string>(['m', 'f', 'u']);
const TONES = new Set<string>(['neutral', 'friendly', 'formal']);
const MODES = new Set<string>(['DIRECT', 'TRANSLATED', 'FORCED']);

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const RING_STATES = new Set<string>(['ringing', 'accepted', 'declined', 'cancelled', 'timeout']);

function party(value: unknown, fallbackLang: Lang): Omit<CallParticipant, 'role'> | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  const userId = str(p['userId']) ?? str(p['id']);
  if (!userId) return null;
  const lang = str(p['lang']);
  const gender = str(p['gender']);
  const tone = str(p['tone']);
  return {
    userId,
    displayName: str(p['displayName']) ?? userId,
    lang: lang && LANGS.has(lang) ? (lang as Lang) : fallbackLang,
    gender: gender && GENDERS.has(gender) ? (gender as Gender) : 'u',
    tone: tone && TONES.has(tone) ? (tone as Tone) : 'neutral',
  };
}

/**
 * Tolerant parser for one ring.
 *
 * Deliberately forgiving about everything except identity: a ring whose tone
 * chip is unreadable can still be answered, so unknown enum values are clamped
 * instead of rejecting the whole payload. Anything without a call id and both
 * parties is refused, because that cannot be rendered or acted on at all.
 */
export function parseRingView(value: unknown): RingView | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;

  const callId = str(m['callId']) ?? str(m['id']);
  if (!callId) return null;

  const from = party(m['from'] ?? m['caller'], 'ru');
  const to = party(m['to'] ?? m['callee'], 'he');
  if (!from || !to) return null;

  const mode = str(m['mode']);
  const ringState = str(m['ringState']);
  const callState = str(m['callState']);
  const remaining = m['secondsRemaining'];

  return {
    callId,
    roomName: str(m['roomName']) ?? `call-${callId}`,
    mode: mode && MODES.has(mode) ? (mode as CallMode) : 'TRANSLATED',
    reason: (str(m['reason']) as ModeReason | null) ?? 'languages_differ',
    ringState: ringState && RING_STATES.has(ringState) ? (ringState as RingLifecycle) : 'ringing',
    callState: (callState as CallState | null) ?? 'created',
    from,
    to,
    startedAt: str(m['startedAt']) ?? '',
    expiresAt: str(m['expiresAt']) ?? '',
    respondedAt: str(m['respondedAt']),
    secondsRemaining: typeof remaining === 'number' && remaining >= 0 ? Math.round(remaining) : 0,
  };
}

/** Whole poll payload. Missing halves degrade to null/empty, never to a throw. */
export function parseRingPoll(value: unknown): RingPollResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  const self = m['self'] as PresenceView | undefined;
  const rawPeers = Array.isArray(m['peers']) ? (m['peers'] as unknown[]) : [];
  const interval = m['pollIntervalMs'];
  return {
    now: str(m['now']) ?? new Date().toISOString(),
    self:
      typeof self === 'object' && self !== null
        ? self
        : { userId: '', online: true, lastSeenAt: null, ttlSeconds: 0 },
    peers: rawPeers.filter(
      (p): p is PresenceView =>
        typeof p === 'object' && p !== null && typeof (p as PresenceView).userId === 'string',
    ),
    incoming: parseRingView(m['incoming']),
    outgoing: parseRingView(m['outgoing']),
    pollIntervalMs: typeof interval === 'number' && interval > 0 ? interval : 2000,
  };
}

export function isStateMessage(value: unknown): value is StateMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m['callId'] === 'string' &&
    (m['event'] === 'agent_ready' || m['event'] === 'agent_error' || m['event'] === 'agent_left')
  );
}
