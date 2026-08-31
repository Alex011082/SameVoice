export type Lang = "ru" | "he";
export type Gender = "m" | "f" | "u";
export type Tone = "neutral" | "friendly" | "formal";
export type CallMode = "DIRECT" | "TRANSLATED" | "FORCED";
export type CallState = "created" | "active" | "ended";
export type ModeReason = "languages_match" | "languages_differ" | "forced_by_user";

/**
 * Ringing state. A call may carry no ring at all (the Stage-0 invite-link flow,
 * `ring: false`), in which case none of this applies and the call behaves exactly
 * as it did before ringing existed.
 *
 *   ringing ──accept──►  accepted ──(first join)──► (ring is history, call is active)
 *      │                    │
 *      │                    └──cancel / no-join-before-expiry──► cancelled | timeout  (call ended)
 *      ├──decline──► declined   (call ended)
 *      ├──cancel───► cancelled  (call ended)
 *      └──expiry───► timeout    (call ended)
 *
 * Every terminal state except `accepted` ends the call and stops the agent if one
 * was dispatched. `accepted` keeps the expiry running until somebody actually
 * joins, so an accepted-but-abandoned call cannot strand an agent in a room.
 */
export type RingState = "ringing" | "accepted" | "declined" | "cancelled" | "timeout";

export function isRingLive(state: RingState): boolean {
  return state === "ringing" || state === "accepted";
}

export interface UserProfile {
  id: string;
  handle: string;
  displayName: string;
  lang: Lang;
  gender: Gender;
  tone: Tone;
}

export interface ContactOverrides {
  lang?: Lang;
  gender?: Gender;
  tone?: Tone;
}

/** A patch value of `null` removes that override rather than setting it. */
export type ContactOverridesPatch = {
  [K in keyof ContactOverrides]?: ContactOverrides[K] | null;
};

export interface ContactCard {
  userId: string;
  displayName: string;
  lang: Lang;
  gender: Gender;
  tone: Tone;
  forceTranslate: boolean;
  overrides: ContactOverrides;
}

export interface CallParticipant {
  userId: string;
  displayName: string;
  lang: Lang;
  gender: Gender;
  tone: Tone;
  role: "caller" | "callee";
}

export interface CallAgentInfo {
  required: boolean;
  dispatched: boolean;
  identity: string | null;
  error: string | null;
}

export interface CallRing {
  state: RingState;
  /** ISO-8601. When the ring started. */
  startedAt: string;
  /**
   * ISO-8601 deadline for the CURRENT ring state. While `ringing` it is the
   * no-answer deadline; it is pushed forward on accept and then becomes the
   * "accepted but nobody joined" deadline.
   */
  expiresAt: string;
  /** ISO-8601 of the accept/decline/cancel/timeout, or null while still ringing. */
  respondedAt: string | null;
  timeoutSeconds: number;
}

export interface Call {
  id: string;
  roomName: string;
  mode: CallMode;
  reason: ModeReason;
  state: CallState;
  createdAt: string;
  /**
   * ISO-8601 of the last thing that happened to this call: created, joined,
   * mode recomputed, ring answered. The store has no other way to tell a call
   * two people are in from one nobody ever came back to — the browser reports
   * neither "I am still here" nor "I closed the tab" once it is in a room —
   * so this is what the idle reaper measures against (backend/src/store.ts).
   */
  lastActivityAt: string;
  endedAt: string | null;
  participants: CallParticipant[];
  agent: CallAgentInfo;
  /** null for a link-invite call (`ring:false`, the pre-existing flow). */
  ring: CallRing | null;
}

/** What a polling client is shown about one ring. Never contains a token. */
export interface RingView {
  callId: string;
  roomName: string;
  mode: CallMode;
  reason: ModeReason;
  ringState: RingState;
  callState: CallState;
  /** The caller — this is the "Alex is calling" name on the callee's screen. */
  from: Omit<CallParticipant, "role">;
  /** The callee. */
  to: Omit<CallParticipant, "role">;
  startedAt: string;
  expiresAt: string;
  respondedAt: string | null;
  /** Clamped at 0. Lets the client render a countdown without clock-skew maths. */
  secondsRemaining: number;
}

export interface PresenceView {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
  ttlSeconds: number;
}

/**
 * One poll answers both sides: a callee learns someone is ringing them, and a
 * caller learns their ring was answered, declined or timed out. Terminal
 * outgoing results linger for a short grace window so the caller's UI can say
 * *why* the ring stopped instead of just going blank.
 */
export interface RingPollResponse {
  now: string;
  self: PresenceView;
  peers: PresenceView[];
  incoming: RingView | null;
  outgoing: RingView | null;
  pollIntervalMs: number;
}

export type JudgeVerdict = "wrong" | "ok";

/** Backend -> agent, `POST /jobs/:callId/verdict`. */
export interface AgentVerdict {
  callId: string;
  userId: string;
  verdict: JudgeVerdict;
  /** Omitted means "the most recent translated utterance the judge could have heard". */
  utteranceId: string | null;
  expected: string | null;
  note: string | null;
  receivedAt: string;
}

export interface JoinResponse {
  token: string;
  livekitUrl: string;
  roomName: string;
  callId: string;
  mode: CallMode;
  self: Omit<CallParticipant, "role">;
  peer: Omit<CallParticipant, "role">;
  agentIdentity: string | null;
  expectedAgentTrackName: string | null;
  ttlSeconds: number;
}

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

export type ApiErrorCode =
  | "bad_request"
  | "invalid_code"
  | "invalid_challenge"
  | "invalid_verification"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "self_call"
  | "mode_locked"
  | "ring_conflict"
  | "busy"
  | "no_agent"
  | "agent_unreachable"
  | "internal";

export function apiError(code: ApiErrorCode, message: string): ApiError {
  return { error: { code, message } };
}

/** Backend -> agent control-plane job (contracts section 3.2). */
export interface AgentJob {
  callId: string;
  roomName: string;
  mode: CallMode;
  livekitUrl: string;
  token: string;
  participants: Omit<CallParticipant, "role">[];
}

export const AGENT_IDENTITY = "agent-relay" as const;
export const AGENT_DISPLAY_NAME = "SpeakEasy Relay" as const;
export const SUBTITLE_TOPIC = "speakeasy.subtitle" as const;
export const STATE_TOPIC = "speakeasy.state" as const;

export const USER_ID_RE = /^u_[a-z0-9_]{1,30}$/;
export const CALL_ID_RE = /^c_[0-9a-f]{12}$/;

export function roomNameFor(callId: string): string {
  return `call-${callId}`;
}

export function agentTrackNameFor(listenerUserId: string): string {
  return `tx-${listenerUserId}`;
}
