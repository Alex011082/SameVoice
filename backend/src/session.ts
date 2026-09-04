import { createHmac, timingSafeEqual } from "node:crypto";

import { USER_ID_RE } from "./types.js";

/**
 * Who is making this request.
 *
 * Until 31.08.2026 the answer was the `?me=<userId>` query parameter: whoever
 * held the URL was that person, and every `/api/users/:userId/...` route
 * trusted the path. Registering by phone made it worse rather than better —
 * `/api/auth/phone/start` handed the confirmation code back in its own JSON
 * response, so anyone could "verify" anyone's number, read the profile id out
 * of the answer and open the app as them.
 *
 * A session token is what replaces it. It is signed, it carries an expiry, and
 * the only thing it names is a user id — never the phone number, because the
 * token travels through headers and cookies that end up in proxy logs and
 * browser storage, and a phone number is the credential this whole flow is
 * built around.
 *
 * Deliberately NOT a JWT library and NOT a stored session table:
 *   * livekit-server-sdk is already the only JWT in this repo and it mints
 *     tokens for LiveKit, not for us; a second JWT stack would be a second set
 *     of algorithm choices to get wrong.
 *   * a stored table would have to survive a restart, and nothing in this
 *     backend does yet (users themselves live in a Map — backend/src/store.ts).
 *     A signed, self-contained token is exactly as durable as the user it
 *     names, which is the honest guarantee here.
 */

/**
 * Format: `sv1.<base64url(payload)>.<base64url(hmac-sha256 of "sv1.<payload>")>`
 *
 * The version prefix is inside the signed input, so a future `sv2` with
 * different rules cannot be replayed as an `sv1` token by rewriting the prefix.
 */
const VERSION = "sv1";

/** The cookie name. Short and boring; it is not a secret which one it is. */
export const SESSION_COOKIE = "sv_session";

export interface IssuedSession {
  token: string;
  expiresAtMs: number;
}

export interface SessionClaims {
  userId: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

interface SessionPayload {
  u: string;
  i: number;
  e: number;
}

function sign(secret: string, signedInput: string): Buffer {
  return createHmac("sha256", secret).update(signedInput, "utf8").digest();
}

export function issueSession(
  secret: string,
  userId: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): IssuedSession {
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const payload: SessionPayload = { u: userId, i: issuedAt, e: expiresAt };
  const body = `${VERSION}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return {
    token: `${body}.${sign(secret, body).toString("base64url")}`,
    expiresAtMs: expiresAt * 1000,
  };
}

/**
 * The token, or null for every kind of failure — forged, truncated, expired,
 * signed with a different secret, or naming something that is not a user id.
 *
 * One null for all of them on purpose: the caller answers 401 either way, and
 * telling a forger WHICH part he got wrong is free help.
 */
export function readSession(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const body = `${parts[0]}.${parts[1]}`;

  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[2] as string, "base64url");
  } catch {
    return null;
  }

  const expected = sign(secret, body);
  // Length must be compared first: timingSafeEqual THROWS on a length mismatch,
  // and a thrown error inside a request hook is a 500 where a 401 belongs.
  if (supplied.length !== expected.length) return null;
  if (!timingSafeEqual(supplied, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.u !== "string" || !USER_ID_RE.test(payload.u)) return null;
  if (typeof payload.i !== "number" || typeof payload.e !== "number") return null;
  if (payload.e * 1000 <= nowMs) return null;

  return { userId: payload.u, issuedAtMs: payload.i * 1000, expiresAtMs: payload.e * 1000 };
}

/**
 * The bearer half of the contract. The cookie is the primary carrier, but a
 * `SameSite=Lax` cookie is NOT sent on a cross-origin fetch, and the dev setup
 * is exactly that: the page is on :5173 and the API on :8787. Without a bearer
 * fallback the whole app would work in production (same origin behind Caddy)
 * and be unusable on the laptop it is written on.
 *
 * It is also what carries the session in an embedded messenger browser, which
 * throws cookies away between visits (web/public/sv-session.js).
 */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return m ? (m[1] as string) : null;
}

/** Minimal Cookie-header parser: one pair per `;`, first occurrence wins. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === "" || name in out) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/**
 * `Path=/` because the API and the page share an origin behind Caddy.
 * `SameSite=Lax` and not `Strict`: the invite link is a top-level navigation
 * from a messenger, and Strict would drop the cookie on exactly that hop —
 * the tester would land on the call screen logged out.
 */
export function sessionCookie(
  token: string,
  opts: { secure: boolean; maxAgeSeconds: number },
): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

const LOCAL_HOST_RE =
  /^(localhost|127\.0\.0\.1|\[::1\]|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+\.local)(:\d+)?$/i;

/**
 * Whether to stamp `Secure` on the cookie, decided from the request's own Host.
 *
 * It cannot be decided from the request's protocol: the deployed backend sits
 * behind Caddy, which terminates TLS and forwards plain http on loopback, so
 * `req.protocol` says "http" on the very deployment that must have `Secure`.
 * It cannot be a fixed `true` either — a `Secure` cookie on http://localhost is
 * dropped by the browser without a word, and "logging in does nothing" is the
 * least debuggable failure this file could produce.
 *
 * So: everything gets `Secure` except a host that is unmistakably a local dev
 * address. `SESSION_COOKIE_SECURE` overrides both ways for the deployment this
 * heuristic gets wrong.
 */
export function cookieShouldBeSecure(
  override: boolean | "auto",
  hostHeader: string | undefined,
): boolean {
  if (override !== "auto") return override;
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (host === "") return true;
  return !LOCAL_HOST_RE.test(host);
}
