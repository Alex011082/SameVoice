import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const CODE_TTL_MS = 5 * 60 * 1000;
const VERIFIED_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

interface PhoneChallenge {
  phone: string;
  codeHash: Buffer;
  expiresAtMs: number;
  attemptsLeft: number;
}

const challenges = new Map<string, PhoneChallenge>();
const verifiedPhones = new Map<string, { phone: string; expiresAtMs: number }>();

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

export function startPhoneVerification(
  phone: string,
  nowMs = Date.now(),
): { challengeId: string; phone: string; devCode: string; expiresInSeconds: number } {
  const challengeId = `pv_${randomBytes(12).toString("hex")}`;
  const devCode = randomInt(0, 1_000_000).toString().padStart(6, "0");
  challenges.set(challengeId, {
    phone,
    codeHash: hashCode(challengeId, devCode),
    expiresAtMs: nowMs + CODE_TTL_MS,
    attemptsLeft: MAX_ATTEMPTS,
  });
  return { challengeId, phone, devCode, expiresInSeconds: CODE_TTL_MS / 1000 };
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
