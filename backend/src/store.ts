import { randomBytes } from "node:crypto";
import {
  CALL_ID_RE,
  isRingLive,
  roomNameFor,
  type Call,
  type CallAgentInfo,
  type CallMode,
  type CallParticipant,
  type CallRing,
  type CallState,
  type ContactOverrides,
  type ContactOverridesPatch,
  type ModeReason,
  type RingState,
  type UserProfile,
} from "./types.js";

export interface ContactRecord {
  ownerId: string;
  contactUserId: string;
  forceTranslate: boolean;
  overrides: ContactOverrides;
}

export interface PresenceRecord {
  userId: string;
  lastSeenMs: number;
}

const users = new Map<string, UserProfile>();
/** key = `${ownerId}->${contactUserId}` */
const contacts = new Map<string, ContactRecord>();
const calls = new Map<string, Call>();
const presence = new Map<string, PresenceRecord>();
/** Real-number identities only. Seeded test identities deliberately have no phone. */
const userIdByPhone = new Map<string, string>();

function contactKey(ownerId: string, contactUserId: string): string {
  return `${ownerId}->${contactUserId}`;
}

function seed(): void {
  users.clear();
  contacts.clear();
  calls.clear();
  presence.clear();
  userIdByPhone.clear();

  const alex: UserProfile = {
    id: "u_alex",
    handle: "alex",
    displayName: "Alex",
    lang: "ru",
    gender: "m",
    tone: "neutral",
  };
  const noa: UserProfile = {
    id: "u_noa",
    handle: "noa",
    displayName: "Noa",
    lang: "he",
    gender: "f",
    tone: "friendly",
  };
  // Omri is the second Hebrew tester and specifically a MALE one. Hebrew
  // inflects on the speaker's gender as well as the addressee's, so testing a
  // male Hebrew speaker by patching Noa's gender at runtime was wrong twice
  // over: that patch lives in memory and silently reverts on the next backend
  // restart, and the female cloned voice kept speaking his words. Gender is a
  // property of a person, so he gets his own profile.
  const omri: UserProfile = {
    id: "u_omri",
    handle: "omri",
    displayName: "Omri",
    lang: "he",
    gender: "m",
    tone: "friendly",
  };
  // Maya completes the grid. The web client no longer hands out one link per
  // person: a tester opens the bare URL and picks gender, then language, and
  // that pair resolves to a seeded profile. Both axes have two values, so all
  // FOUR combinations must exist or a tester picks a valid pair and lands
  // nowhere. She is the (ru, f) corner.
  const maya: UserProfile = {
    id: "u_maya",
    handle: "maya",
    displayName: "Maya",
    lang: "ru",
    gender: "f",
    tone: "friendly",
  };

  users.set(alex.id, alex);
  users.set(noa.id, noa);
  users.set(omri.id, omri);
  users.set(maya.id, maya);

  // Everyone is everyone's contact. With the role picker there is no way to
  // predict which two corners of the grid a session will use, so a hand-picked
  // pair list would leave testers unable to reach each other.
  for (const owner of users.keys()) {
    for (const contact of users.keys()) {
      if (owner === contact) continue;
      contacts.set(contactKey(owner, contact), {
        ownerId: owner,
        contactUserId: contact,
        forceTranslate: false,
        overrides: {},
      });
    }
  }
}

seed();

/** Test-only: restore the Stage-0 seed and drop every call. */
export function resetStore(): void {
  seed();
}

export function listUsers(): UserProfile[] {
  return [...users.values()];
}

export function getUser(userId: string): UserProfile | undefined {
  return users.get(userId);
}

export function getUserByPhone(phone: string): UserProfile | undefined {
  const userId = userIdByPhone.get(phone);
  return userId ? users.get(userId) : undefined;
}

export function createUserFromPhone(input: {
  phone: string;
  displayName: string;
  lang: UserProfile["lang"];
  gender: UserProfile["gender"];
}): UserProfile {
  const existing = getUserByPhone(input.phone);
  if (existing) return existing;
  let id: string;
  do {
    id = `u_${randomBytes(8).toString("hex")}`;
  } while (users.has(id));
  const user: UserProfile = {
    id,
    handle: `user_${id.slice(2, 10)}`,
    displayName: input.displayName.trim(),
    lang: input.lang,
    gender: input.gender,
    tone: "friendly",
  };
  users.set(id, user);
  userIdByPhone.set(input.phone, id);
  return user;
}

export function updateUser(
  userId: string,
  patch: Partial<Pick<UserProfile, "displayName" | "lang" | "gender" | "tone">>,
): UserProfile | undefined {
  const existing = users.get(userId);
  if (!existing) return undefined;
  const next: UserProfile = { ...existing, ...patch };
  users.set(userId, next);
  return next;
}

export function listContacts(ownerId: string): ContactRecord[] {
  return [...contacts.values()].filter((c) => c.ownerId === ownerId);
}

export function getContact(ownerId: string, contactUserId: string): ContactRecord | undefined {
  return contacts.get(contactKey(ownerId, contactUserId));
}

export function updateContact(
  ownerId: string,
  contactUserId: string,
  patch: { forceTranslate?: boolean; overrides?: ContactOverridesPatch },
): ContactRecord | undefined {
  const existing = contacts.get(contactKey(ownerId, contactUserId));
  if (!existing) return undefined;
  const overrides: Record<string, unknown> = { ...existing.overrides };
  for (const [key, value] of Object.entries(patch.overrides ?? {})) {
    if (value === null) delete overrides[key];
    else if (value !== undefined) overrides[key] = value;
  }
  const next: ContactRecord = {
    ...existing,
    forceTranslate: patch.forceTranslate ?? existing.forceTranslate,
    overrides: overrides as ContactOverrides,
  };
  contacts.set(contactKey(ownerId, contactUserId), next);
  return next;
}

function newCallId(): string {
  for (;;) {
    const id = `c_${randomBytes(6).toString("hex")}`;
    if (CALL_ID_RE.test(id) && !calls.has(id)) return id;
  }
}

export function createCall(input: {
  mode: CallMode;
  reason: ModeReason;
  participants: CallParticipant[];
  ring?: CallRing | null;
}): Call {
  const id = newCallId();
  const createdAt = new Date().toISOString();
  const call: Call = {
    id,
    roomName: roomNameFor(id),
    mode: input.mode,
    reason: input.reason,
    state: "created",
    createdAt,
    lastActivityAt: createdAt,
    endedAt: null,
    participants: input.participants,
    agent: { required: input.mode !== "DIRECT", dispatched: false, identity: null, error: null },
    ring: input.ring ?? null,
  };
  calls.set(id, call);
  return call;
}

export function getCall(callId: string): Call | undefined {
  return calls.get(callId);
}

/**
 * "Somebody is still interested in this call." Every mutation below records it,
 * and so does a join — which is the only signal the backend ever gets that a
 * human is actually in the room. The idle reaper measures against it.
 */
export function touchCall(callId: string): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.lastActivityAt = new Date().toISOString();
  return call;
}

export function setCallState(callId: string, state: CallState): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.state = state;
  call.lastActivityAt = new Date().toISOString();
  if (state === "ended" && call.endedAt === null) {
    call.endedAt = call.lastActivityAt;
  }
  return call;
}

export function setCallMode(callId: string, mode: CallMode, reason: ModeReason): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.mode = mode;
  call.reason = reason;
  call.agent.required = mode !== "DIRECT";
  call.lastActivityAt = new Date().toISOString();
  return call;
}

export function setCallParticipants(callId: string, participants: CallParticipant[]): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.participants = participants;
  call.lastActivityAt = new Date().toISOString();
  return call;
}

export function setCallAgent(callId: string, agent: CallAgentInfo): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.agent = agent;
  return call;
}

export function callParticipant(call: Call, userId: string): CallParticipant | undefined {
  return call.participants.find((p) => p.userId === userId);
}

export function callPeer(call: Call, userId: string): CallParticipant | undefined {
  return call.participants.find((p) => p.userId !== userId);
}

export function callCaller(call: Call): CallParticipant {
  return call.participants.find((p) => p.role === "caller")!;
}

export function callCallee(call: Call): CallParticipant {
  return call.participants.find((p) => p.role === "callee")!;
}

// ---------------------------------------------------------------------------
// Ringing
// ---------------------------------------------------------------------------

/** Newest first. The ring flow always wants the most recent match, never the oldest. */
function callsNewestFirst(): Call[] {
  return [...calls.values()].reverse();
}

export function setCallRing(callId: string, ring: CallRing | null): Call | undefined {
  const call = calls.get(callId);
  if (!call) return undefined;
  call.ring = ring;
  call.lastActivityAt = new Date().toISOString();
  return call;
}

export function setRingState(callId: string, state: RingState, atIso: string): Call | undefined {
  const call = calls.get(callId);
  if (!call || call.ring === null) return undefined;
  call.ring = { ...call.ring, state, respondedAt: atIso };
  call.lastActivityAt = new Date().toISOString();
  return call;
}

/**
 * Rings whose deadline has passed while the call has still not gone `active`.
 * Pure query: the caller performs the transition, because expiring a ring also
 * has to stop a dispatched agent and that is I/O the store must not own.
 */
export function dueRingCalls(nowMs: number): Call[] {
  return [...calls.values()].filter((c) => {
    if (c.ring === null || c.state === "ended") return false;
    if (Date.parse(c.ring.expiresAt) > nowMs) return false;
    // Unanswered: expires even though the caller has already joined the room and
    // flipped the call to `active` while listening to his own ringback.
    if (c.ring.state === "ringing") return true;
    // Answered but nobody actually joined: only meaningful while still `created`.
    // Once anyone joins, the call is live and the ring deadline stops applying.
    return c.ring.state === "accepted" && c.state === "created";
  });
}

/** A ring this user must answer: they are the callee and it is still ringing. */
export function findIncomingRing(userId: string, nowMs: number): Call | undefined {
  return callsNewestFirst().find(
    (c) =>
      c.ring !== null &&
      c.ring.state === "ringing" &&
      c.state !== "ended" &&
      Date.parse(c.ring.expiresAt) > nowMs &&
      callCallee(c).userId === userId,
  );
}

/**
 * A ring this user started. Live ones always; terminal ones only inside a grace
 * window, so the caller's UI can say "declined" / "no answer" instead of the
 * ring silently disappearing.
 */
export function findOutgoingRing(userId: string, nowMs: number, graceMs: number): Call | undefined {
  return callsNewestFirst().find((c) => {
    if (c.ring === null || callCaller(c).userId !== userId) return false;
    if (isRingLive(c.ring.state)) return c.state !== "ended";
    const at = c.ring.respondedAt === null ? 0 : Date.parse(c.ring.respondedAt);
    return nowMs - at <= graceMs;
  });
}

/**
 * "Busy" is deliberately narrow: only a LIVE ring blocks a new one. An `active`
 * call does not, because a tester who closes a tab without hanging up would
 * otherwise be locked out forever — and the lockout would look like a backend bug.
 */
export function findBusyCall(userId: string, nowMs: number): Call | undefined {
  return callsNewestFirst().find(
    (c) =>
      c.ring !== null &&
      isRingLive(c.ring.state) &&
      c.state === "created" &&
      Date.parse(c.ring.expiresAt) > nowMs &&
      c.participants.some((p) => p.userId === userId),
  );
}

// ---------------------------------------------------------------------------
// Call lifetime
// ---------------------------------------------------------------------------
//
// This store is in-memory and the process runs for weeks, so a call that never
// reaches `ended` is immortal and a call that reaches it is still remembered
// forever. Both bit us on 25.08.2026: c_f74783a70042 was created at 17:48 the
// previous day and was still live the next morning, the caller's client kept
// finding it and re-joining it, and the two testers sat in different rooms
// hearing nothing while the pipeline itself worked perfectly.
//
// Nothing here can be driven by "who is in the room": the browser tells the
// backend neither "I am still here" nor "I closed the tab" once it is in one
// (web/src/main.ts hangs up the media on pagehide but posts no /end). So the
// bounds below are deliberately generous — they are a backstop against
// immortality, not a call-duration policy.

/** A call with no live ring that has outlived one of the two bounds. */
export interface DeadCall {
  call: Call;
  /** `idle` — nobody ever joined; `max_lifetime` — joined, but never hung up. */
  reason: "idle" | "max_lifetime";
}

export interface CallLifetimeLimits {
  /** How long a call nobody has joined may sit there. Measured from lastActivityAt. */
  idleMs: number;
  /** Ceiling on a joined call, measured from createdAt. */
  maxLifetimeMs: number;
}

/**
 * A ring is still the thing deciding this call's fate, so the lifetime bounds
 * must keep their hands off it. Exactly the set dueRingCalls() watches: while a
 * ring is `ringing` it owns the call whatever state the call is in (the caller
 * may already have joined and be listening to his own ringback), and an
 * `accepted` ring owns it until somebody actually joins.
 */
function ringStillGoverns(call: Call): boolean {
  if (call.ring === null || !isRingLive(call.ring.state)) return false;
  return call.ring.state === "ringing" || call.state === "created";
}

/**
 * Calls that should be ended. Pure query, for the same reason dueRingCalls() is
 * one: ending a call also has to stop a dispatched agent, and that is I/O the
 * store must not own.
 *
 * `created` means nobody has ever joined — the join handler is what flips a
 * call to `active` — so "no participants" and "state is created" are the same
 * statement here, and it is the one the rest of the backend already reasons in.
 */
export function deadCalls(nowMs: number, limits: CallLifetimeLimits): DeadCall[] {
  const out: DeadCall[] = [];
  for (const call of calls.values()) {
    if (call.state === "ended" || ringStillGoverns(call)) continue;
    if (call.state === "created") {
      if (nowMs - Date.parse(call.lastActivityAt) >= limits.idleMs) {
        out.push({ call, reason: "idle" });
      }
    } else if (nowMs - Date.parse(call.createdAt) >= limits.maxLifetimeMs) {
      out.push({ call, reason: "max_lifetime" });
    }
  }
  return out;
}

export interface ArchiveLimits {
  /**
   * How long an ended call stays in the live map before it moves to the
   * archive. It is over the moment it ends — this window only keeps it
   * queryable through the ordinary call route, so a client that lost the race
   * can still be told WHY it ended.
   */
  archiveAfterMs: number;
  /** Hard ceiling on the size of the live map, whatever the window says. */
  maxCalls: number;
}

/**
 * Ended calls ready to leave the live map. Pure query: the records are written
 * to durable storage before they are dropped from memory, and that write is I/O
 * the store must not own. The caller hands the ids back to forgetCalls() once
 * they are safely stored.
 *
 * Oldest first, so a store over its ceiling sheds the least interesting calls.
 */
export function archivableCalls(nowMs: number, limits: ArchiveLimits): Call[] {
  const due: Call[] = [];
  const rest: Call[] = [];
  // Map entries stay in insertion order, so this walks oldest-first.
  for (const call of calls.values()) {
    if (call.state !== "ended") continue;
    const endedMs = Date.parse(call.endedAt ?? call.lastActivityAt);
    if (nowMs - endedMs >= limits.archiveAfterMs) due.push(call);
    else rest.push(call);
  }
  // Over the ceiling, ended calls leave early rather than waiting out their
  // window: a burst inside one window must not be able to grow the map without
  // limit. Live calls are never touched — dropping one would 404 a call two
  // people are in — so a store full of live calls simply stops shrinking, which
  // is a bounded and visible condition rather than a leak.
  let over = calls.size - due.length - limits.maxCalls;
  for (const call of rest) {
    if (over <= 0) break;
    due.push(call);
    over -= 1;
  }
  return due;
}

/** Drop calls from the live map. Returns how many were actually there. */
export function forgetCalls(callIds: readonly string[]): number {
  let dropped = 0;
  for (const id of callIds) {
    if (calls.delete(id)) dropped += 1;
  }
  return dropped;
}

/** How many calls the store is holding, split by whether they are still live. */
export function callCounts(): { live: number; ended: number } {
  let live = 0;
  let ended = 0;
  for (const call of calls.values()) {
    if (call.state === "ended") ended += 1;
    else live += 1;
  }
  return { live, ended };
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export function touchPresence(userId: string, nowMs: number): PresenceRecord {
  const record: PresenceRecord = { userId, lastSeenMs: nowMs };
  presence.set(userId, record);
  return record;
}

/** Explicit goodbye (tab close / "I am leaving"), so the peer does not wait out the TTL. */
export function dropPresence(userId: string): void {
  presence.delete(userId);
}

export function getPresence(userId: string): PresenceRecord | undefined {
  return presence.get(userId);
}
