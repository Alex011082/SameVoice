import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  consumeVerifiedPhone,
  normalizePhone,
  startPhoneVerification,
  verifyPhoneCode,
} from "../phoneVerification.js";
import { createUserFromPhone, getUserByPhone } from "../store.js";
import { apiError } from "../types.js";

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

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/auth/phone/start", async (req, reply) => {
    const parsed = startBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(apiError("bad_request", "enter a phone number"));
    }
    const phone = normalizePhone(parsed.data.phone);
    if (!phone) {
      return reply
        .code(400)
        .send(apiError("bad_request", "enter an Israeli mobile number or an international number with +"));
    }
    return reply.code(201).send(startPhoneVerification(phone));
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
    return {
      verified: true,
      phone: result.phone,
      registrationToken: result.registrationToken,
      existingUser: getUserByPhone(result.phone) ?? null,
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
        .send(apiError("invalid_verification", "phone verification is missing, expired, or already used"));
    }
    const existing = getUserByPhone(phone);
    if (existing) return { created: false, user: existing };
    const user = createUserFromPhone({
      phone,
      displayName: parsed.data.displayName,
      lang: parsed.data.lang,
      gender: parsed.data.gender,
    });
    return reply.code(201).send({ created: true, user });
  });
};
