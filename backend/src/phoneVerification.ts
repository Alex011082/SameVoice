import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const CODE_TTL_MS = 5 * 60 * 1000;
const VERIFIED_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/**
 * GUESSES PER NUMBER, not per challenge — and this distinction is an account
 * takeover, not a nicety.
 *
 * MAX_ATTEMPTS above bounds one challenge to five tries at a six-digit code,
 * which reads like 1-in-200,000 and is not, because minting a challenge is a
 * single unauthenticated POST and nothing bounded how many. Guess five, ask for
 * a new code, guess five more: the search is over the whole 10^6 space at five
 * guesses per two requests, so a script reaches even odds against a chosen
 * number in about 140,000 guesses — an hour or two at an unremarkable request
 * rate. Landing it on a number that already has a profile is not a
 * registration; POST /api/auth/phone/verify treats a known number as the login
 * and hands back that person's session (see routes/auth.ts), which is their
 * contacts, their call archive and the right to ring people as them.
 *
 * Keyed on the NUMBER, so a fresh challenge does not buy a fresh budget — the
 * per-challenge counter is what a fresh challenge resets, and that was the
 * hole. Twenty an hour leaves a person who mistypes the code four times and
 * asks for a new one plenty of room, and leaves a script 50,000 hours.
 *
 * It does not bound guessing across MANY numbers — that is what
 * AUTH_PHONE_ALLOWLIST is for, and what buildApp() warns about when it is
 * empty. It bounds guessing at ONE number, which is what taking one account
 * requires.
 */
export const MAX_ATTEMPTS_PER_PHONE = 20;
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Live challenges kept for one number. Not a refusal — asking for a new code
 * must always work, or "resend" is broken — but the oldest is dropped, so an
 * unauthenticated POST loop cannot grow the map without limit.
 */
const MAX_LIVE_CHALLENGES_PER_PHONE = 5;

interface PhoneChallenge {
  phone: string;
  codeHash: Buffer;
  expiresAtMs: number;
  attemptsLeft: number;
  createdAtMs: number;
}

const challenges = new Map<string, PhoneChallenge>();
const verifiedPhones = new Map<string, { phone: string; expiresAtMs: number }>();
/** phone -> guesses spent in the current window. Survives a new challenge. */
const attemptBudgets = new Map<string, { windowStartMs: number; used: number }>();

/**
 * Expired rows never used to be removed at all: `challenges` only ever shrank
 * when somebody verified, so an unauthenticated POST loop grew it forever. Both
 * maps are swept whenever a challenge starts, which is the only path that adds
 * to either of them.
 */
function sweepExpired(nowMs: number): void {
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAtMs <= nowMs) challenges.delete(id);
  }
  for (const [token, verified] of verifiedPhones) {
    if (verified.expiresAtMs <= nowMs) verifiedPhones.delete(token);
  }
  for (const [phone, budget] of attemptBudgets) {
    if (nowMs - budget.windowStartMs >= ATTEMPT_WINDOW_MS) attemptBudgets.delete(phone);
  }
}

/** Charges one guess against the number. False once the number is out. */
function spendAttempt(phone: string, nowMs: number): boolean {
  const budget = attemptBudgets.get(phone);
  if (!budget || nowMs - budget.windowStartMs >= ATTEMPT_WINDOW_MS) {
    attemptBudgets.set(phone, { windowStartMs: nowMs, used: 1 });
    return true;
  }
  if (budget.used >= MAX_ATTEMPTS_PER_PHONE) return false;
  budget.used += 1;
  return true;
}

/** Test-only: the module keeps its maps for the life of the process. */
export function resetPhoneVerification(): void {
  challenges.clear();
  verifiedPhones.clear();
  attemptBudgets.clear();
}

function hashCode(challengeId: string, code: string): Buffer {
  return createHash("sha256").update(`${challengeId}:${code}`, "utf8").digest();
}

/**
 * Stage-0 accepts ordinary Israeli mobile notation and already-international
 * E.164 input. The UI can later add a country picker without changing the
 * stored format or the verification API.
 */
export function normalizePhone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s().-]/g, "");
  const international = /^05\d{8}$/.test(compact) ? `+972${compact.slice(1)}` : compact;
  return /^\+[1-9]\d{7,14}$/.test(international) ? international : null;
}

/**
 * Creates a challenge and returns the plaintext `code` to its CALLER — never
 * straight to the browser.
 *
 * The distinction is the whole point. This function used to call the field
 * `devCode` and the route used to put it in the response, which meant anyone
 * who could reach the server could verify anyone's number. Delivery is now a
 * decision the route makes from config (AUTH_DEV_CODE_IN_RESPONSE): SMS is
 * still not wired, so the code goes either into the response — on a box where
 * that is an accepted risk — or into the server log, where it needs an
 * operator with access to the machine.
 */
export function startPhoneVerification(
  phone: string,
  nowMs = Date.now(),
): { challengeId: string; phone: string; code: string; expiresInSeconds: number } {
  sweepExpired(nowMs);

  const challengeId = `pv_${randomBytes(12).toString("hex")}`;
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  challenges.set(challengeId, {
    phone,
    codeHash: hashCode(challengeId, code),
    expiresAtMs: nowMs + CODE_TTL_MS,
    attemptsLeft: MAX_ATTEMPTS,
    createdAtMs: nowMs,
  });

  // Oldest first, so the code the caller was just given is the one that
  // survives. Insertion order is what a Map iterates, and createdAtMs is what
  // decides — the two agree, and the explicit field is what keeps them
  // agreeing if this ever stops being one map.
  const live = [...challenges.entries()].filter(([, c]) => c.phone === phone);
  if (live.length > MAX_LIVE_CHALLENGES_PER_PHONE) {
    live.sort((a, b) => a[1].createdAtMs - b[1].createdAtMs);
    for (const [id] of live.slice(0, live.length - MAX_LIVE_CHALLENGES_PER_PHONE)) {
      challenges.delete(id);
    }
  }

  return { challengeId, phone, code, expiresInSeconds: CODE_TTL_MS / 1000 };
}

export type VerifyPhoneResult =
  | { ok: true; phone: string; registrationToken: string }
  | { ok: false; reason: "invalid_challenge" | "invalid_code" };

export function verifyPhoneCode(
  challengeId: string,
  code: string,
  nowMs = Date.now(),
): VerifyPhoneResult {
  const challenge = challenges.get(challengeId);
  if (!challenge || challenge.expiresAtMs <= nowMs || challenge.attemptsLeft <= 0) {
    challenges.delete(challengeId);
    return { ok: false, reason: "invalid_challenge" };
  }

  // Charged BEFORE the comparison, and against the number rather than this
  // challenge: a guess costs the same whether it lands or not, and abandoning
  // the challenge for a fresh one does not refund it. `invalid_challenge` is
  // the same answer a lapsed challenge gets, on the same reasoning the rest of
  // this file follows — telling a script that it has hit the ceiling tells it
  // the number is worth coming back to.
  if (!spendAttempt(challenge.phone, nowMs)) {
    return { ok: false, reason: "invalid_challenge" };
  }

  const supplied = hashCode(challengeId, code);
  if (!timingSafeEqual(supplied, challenge.codeHash)) {
    challenge.attemptsLeft -= 1;
    if (challenge.attemptsLeft <= 0) challenges.delete(challengeId);
    return { ok: false, reason: "invalid_code" };
  }

  challenges.delete(challengeId);
  const registrationToken = `vr_${randomBytes(24).toString("hex")}`;
  verifiedPhones.set(registrationToken, {
    phone: challenge.phone,
    expiresAtMs: nowMs + VERIFIED_TTL_MS,
  });
  return { ok: true, phone: challenge.phone, registrationToken };
}

/** Consumes the proof exactly once when a profile is created. */
export function consumeVerifiedPhone(token: string, nowMs = Date.now()): string | null {
  const verified = verifiedPhones.get(token);
  verifiedPhones.delete(token);
  if (!verified || verified.expiresAtMs <= nowMs) return null;
  return verified.phone;
}
