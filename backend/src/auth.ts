import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import {
  bearerToken,
  clearedSessionCookie,
  cookieShouldBeSecure,
  issueSession,
  parseCookies,
  readSession,
  sessionCookie,
  SESSION_COOKIE,
  type Session,
} from "./session.js";
import { getUser } from "./store.js";
import { apiError } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The verified session, or null. Never derived from the path or the body. */
    actor: Session | null;
  }
}

/**
 * Resolves the session ONCE per request, in one place, so that no route can
 * accidentally invent its own idea of who is calling. Routes only ever ask
 * `requireSelf`; they never look at a header.
 *
 * The cookie is preferred over the bearer header because it is the httpOnly
 * one — a page that can read its own token can leak it, and the bearer copy
 * exists only for the cross-origin dev setup where a SameSite=Lax cookie is
 * never sent (see session.ts).
 */
export function registerAuth(app: FastifyInstance, cfg: Config): void {
  app.decorateRequest("actor", null);

  app.addHook("onRequest", async (req) => {
    const cookieToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const token = cookieToken ?? bearerToken(req.headers.authorization);
    if (!token) return;
    const session = readSession(cfg.sessionSecret, token);
    // A token that outlives its user authorizes nothing. This is not
    // hypothetical: users live in a Map (backend/src/store.ts), so every
    // restart wipes them while the tokens in people's browsers survive. 401
    // sends the client back to the login screen, which is the truth; without
    // this check it would instead get a 404 from deep inside the app.
    if (!session || !getUser(session.userId)) return;
    req.actor = session;
  });
}

/**
 * The session's user id, or null after having sent 401.
 *
 * "No session" and "a session I cannot verify" are the same answer on purpose:
 * a forged token, an expired one and no token at all are all just "you are not
 * logged in", and distinguishing them out loud only helps whoever is forging.
 */
export function requireActor(req: FastifyRequest, reply: FastifyReply): string | null {
  if (req.actor) return req.actor.userId;
  reply.code(401).send(apiError("unauthorized", "sign in first — no valid session"));
  return null;
}

/**
 * True when the session may act as `userId`; otherwise 401/403 has been sent.
 *
 * 403 is returned for a user id that does not exist as well as for somebody
 * else's, and that is the point: the answer must not depend on whether the
 * resource is there, or the status code becomes an existence oracle for user
 * ids. The archive keeps the opposite convention one level down — a CALL you
 * were not on is 404, not 403 (backend/src/routes/archive.ts) — and that stays
 * exactly as it was, because it is protecting the same thing by the same logic.
 */
export function requireSelf(req: FastifyRequest, reply: FastifyReply, userId: string): boolean {
  const actor = requireActor(req, reply);
  if (actor === null) return false;
  if (actor === userId) return true;
  reply
    .code(403)
    .send(apiError("forbidden", "this session belongs to a different user"));
  return false;
}

/**
 * Hands a freshly minted session to one response: the cookie for the ordinary
 * same-origin case, and the same token in the body for the cross-origin one.
 */
export function grantSession(
  cfg: Config,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): { token: string; expiresAt: string } {
  const issued = issueSession(cfg.sessionSecret, userId, cfg.sessionTtlSeconds);
  const secure = cookieShouldBeSecure(cfg.sessionCookieSecure, req.headers.host);
  reply.header(
    "set-cookie",
    sessionCookie(issued.token, { secure, maxAgeSeconds: cfg.sessionTtlSeconds }),
  );
  return { token: issued.token, expiresAt: new Date(issued.expiresAtMs).toISOString() };
}

export function revokeSession(cfg: Config, req: FastifyRequest, reply: FastifyReply): void {
  const secure = cookieShouldBeSecure(cfg.sessionCookieSecure, req.headers.host);
  reply.header("set-cookie", clearedSessionCookie(secure));
}
