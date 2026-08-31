import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { grantSession, revokeSession } from "../auth.js";
import type { Config } from "../config.js";
import {
  consumeVerifiedPhone,
  normalizePhone,
  startPhoneVerification,
  verifyPhoneCode,
} from "../phoneVerification.js";
import {
  createUserFromPhone,
  getUser,
  getUserByPhone,
  stage0TestIdentityIdList,
  STAGE0_AUTO_JOIN_TEST_IDENTITIES,
} from "../store.js";
import { apiError, USER_ID_RE } from "../types.js";

const startBody = z.object({ phone: z.string().min(1).max(40) }).strict();
const verifyBody = z
  .object({
    challengeId: z.string().regex(/^pv_[0-9a-f]{24}$/),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();
const registerBody = z
  .object({
    registrationToken: z.string().regex(/^vr_[0-9a-f]{48}$/),
    displayName: z.string().trim().min(1).max(64),
    lang: z.enum(["ru", "he"]),
    gender: z.enum(["m", "f", "u"]),
  })
  .strict();
const seededLoginBody = z.object({ userId: z.string().regex(USER_ID_RE) }).strict();

export function authRoutes(cfg: Config): FastifyPluginAsync {
  return async (app) => {
    /**
     * Who may even ASK for a confirmation code.
     *
     * An empty allowlist means anyone, which is what the server does today and
     * is why buildApp() shouts about it at boot. It is a separate switch from
     * AUTH_DEV_CODE_IN_RESPONSE because the two close different halves of one
     * hole: the allowlist bounds who can START, the code switch bounds who can
     * FINISH. With SMS unwired, only the pair of them adds up to a login.
     */
    function phoneAllowed(phone: string): boolean {
      return cfg.authPhoneAllowlist.length === 0 || cfg.authPhoneAllowlist.includes(phone);
    }

    app.post("/api/auth/phone/start", async (req, reply) => {
      const parsed = startBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(apiError("bad_request", "enter a phone number"));
      }
      const phone = normalizePhone(parsed.data.phone);
      if (!phone) {
        return reply
          .code(400)
          .send(
            apiError(
              "bad_request",
              "enter an Israeli mobile number or an international number with +",
            ),
          );
      }
      if (!phoneAllowed(phone)) {
        // Neither the log line nor the message repeats the number back: the
        // rejection is about the allowlist, and echoing it would put somebody's
        // personal data into the log of a request they did not make.
        req.log.warn("phone verification refused — the number is not on AUTH_PHONE_ALLOWLIST");
        return reply
          .code(403)
          .send(apiError("forbidden", "this number is not on the tester allowlist"));
      }

      const challenge = startPhoneVerification(phone);
      if (!cfg.authDevCodeInResponse) {
        // SMS is not wired, so the code has to come out somewhere. The log is
        // the somewhere: reading it needs access to the machine, which is a
        // real boundary, unlike a response body that needs only a browser.
        // challengeId and code only — the phone number stays out of the log.
        req.log.warn(
          { challengeId: challenge.challengeId, code: challenge.code },
          "confirmation code issued (SMS is not wired; AUTH_DEV_CODE_IN_RESPONSE is off)",
        );
      }
      return reply.code(201).send({
        challengeId: challenge.challengeId,
        phone: challenge.phone,
        expiresInSeconds: challenge.expiresInSeconds,
        // Absent rather than empty when the switch is off: the client tests for
        // the field, and an empty string would render as a blank code box.
        ...(cfg.authDevCodeInResponse ? { devCode: challenge.code } : {}),
        codeDelivery: cfg.authDevCodeInResponse ? "response" : "server_log",
      });
    });

    app.post("/api/auth/phone/verify", async (req, reply) => {
      const parsed = verifyBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(apiError("bad_request", "enter the six-digit confirmation code"));
      }
      const result = verifyPhoneCode(parsed.data.challengeId, parsed.data.code);
      if (!result.ok) {
        const message =
          result.reason === "invalid_code"
            ? "the confirmation code is incorrect"
            : "the confirmation request is missing, expired, or already used";
        return reply.code(400).send(apiError(result.reason, message));
      }
      const existingUser = getUserByPhone(result.phone) ?? null;
      // A number that already has a profile has just proved it owns that
      // profile, so this IS the login — there is nothing left to register.
      const session = existingUser ? grantSession(cfg, req, reply, existingUser.id) : null;
      return {
        verified: true,
        phone: result.phone,
        registrationToken: result.registrationToken,
        existingUser,
        session,
      };
    });

    app.post("/api/auth/register", async (req, reply) => {
      const parsed = registerBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(apiError("bad_request", "complete the profile fields"));
      }
      const phone = consumeVerifiedPhone(parsed.data.registrationToken);
      if (!phone) {
        return reply
          .code(400)
          .send(
            apiError("invalid_verification", "phone verification is missing, expired, or already used"),
          );
      }
      const existing = getUserByPhone(phone);
      if (existing) {
        return {
          created: false,
          user: existing,
          session: grantSession(cfg, req, reply, existing.id),
        };
      }
      const user = createUserFromPhone({
        phone,
        displayName: parsed.data.displayName,
        lang: parsed.data.lang,
        gender: parsed.data.gender,
      });
      // The auto-join is the one side effect of registering that nobody asked
      // for, so it is stated where an operator will actually see it. The phone
      // number is deliberately NOT logged: it is the credential this whole route
      // is built around.
      req.log.info(
        {
          userId: user.id,
          lang: user.lang,
          gender: user.gender,
          autoJoinedTestIdentities: STAGE0_AUTO_JOIN_TEST_IDENTITIES
            ? stage0TestIdentityIdList()
            : [],
        },
        "phone user registered",
      );
      return reply
        .code(201)
        .send({ created: true, user, session: grantSession(cfg, req, reply, user.id) });
    });

    /**
     * A session as one of the four seeded test identities, with no proof at all.
     *
     * It exists because the 2x2 grid (ru/he x m/f) is how any translation
     * direction gets tested and those profiles have no phone number by design,
     * so there is otherwise no way to be Noa. It is OFF by default, and it is
     * not a back door left ajar: with the switch off it refuses everyone, and
     * with it on it still refuses every id that is not seeded — a session as a
     * REAL, phone-registered person can only ever come from that person's own
     * number.
     *
     * Why it must stay off on a box that has real users, stated plainly: a
     * seeded identity is auto-joined to every phone user who registers
     * (STAGE0_AUTO_JOIN_TEST_IDENTITIES in store.ts), so a session as u_alex is
     * a session over every real tester's contact card and a licence to ring
     * them. That is why this is a switch and not a constant.
     */
    app.post("/api/auth/seeded-login", async (req, reply) => {
      const parsed = seededLoginBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(apiError("bad_request", "name a seeded test identity"));
      }
      if (!cfg.authSeededLogin) {
        return reply
          .code(403)
          .send(apiError("forbidden", "seeded test-identity login is disabled here (AUTH_SEEDED_LOGIN)"));
      }
      if (!stage0TestIdentityIdList().includes(parsed.data.userId)) {
        return reply
          .code(403)
          .send(apiError("forbidden", "only the seeded test identities can be signed into this way"));
      }
      const user = getUser(parsed.data.userId)!;
      req.log.warn({ userId: user.id }, "seeded test-identity session issued (AUTH_SEEDED_LOGIN)");
      return { user, session: grantSession(cfg, req, reply, user.id) };
    });

    /**
     * "Who am I?" — the one route that answers from the session alone.
     *
     * This is what lets `?me=` stop being an identity: the client no longer
     * decides who it is from the URL, it asks. A URL opened by somebody else's
     * session answers with somebody else's profile, or with 401 — never with
     * the profile the URL named.
     */
    app.get("/api/auth/session", async (req, reply) => {
      const user = req.actor ? getUser(req.actor.userId) : undefined;
      if (!req.actor || !user) {
        return reply.code(401).send(apiError("unauthorized", "sign in first — no valid session"));
      }
      return { user, expiresAt: new Date(req.actor.expiresAtMs).toISOString() };
    });

    /**
     * Idempotent on purpose: "log me out" from a client that has no session
     * must clear the cookie and say so, not fail. The token itself stays valid
     * until it expires — there is no revocation list, and building one needs
     * the durable storage this backend does not have.
     */
    app.post("/api/auth/logout", async (req, reply) => {
      revokeSession(cfg, req, reply);
      return { ok: true };
    });
  };
}
