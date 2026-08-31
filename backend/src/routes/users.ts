import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { requireActor, requireSelf } from "../auth.js";
import { effectiveGender, effectiveLang, effectiveTone } from "../mode.js";
import {
  getContact,
  getUser,
  listContacts,
  stage0TestIdentityIdList,
  updateContact,
  updateUser,
} from "../store.js";
import {
  apiError,
  USER_ID_RE,
  type ContactCard,
  type ContactOverridesPatch,
  type UserProfile,
} from "../types.js";

const langSchema = z.enum(["ru", "he"]);
const genderSchema = z.enum(["m", "f", "u"]);
const toneSchema = z.enum(["neutral", "friendly", "formal"]);
const userIdSchema = z.string().regex(USER_ID_RE, "must match ^u_[a-z0-9_]{1,30}$");

const userParams = z.object({ userId: userIdSchema });
const contactParams = z.object({ userId: userIdSchema, contactUserId: userIdSchema });

const patchUserBody = z
  .object({
    displayName: z.string().min(1).max(64).optional(),
    lang: langSchema.optional(),
    gender: genderSchema.optional(),
    tone: toneSchema.optional(),
  })
  .strict();

// `null` clears an override and falls back to the contact's own profile value.
// Without it a language set for one test stays pinned until the backend
// restarts, which silently poisons every later call with that contact.
const patchContactBody = z
  .object({
    lang: langSchema.nullable().optional(),
    gender: genderSchema.nullable().optional(),
    tone: toneSchema.nullable().optional(),
    forceTranslate: z.boolean().optional(),
  })
  .strict();

function issues(err: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

/** Returns the parsed value, or null after having already sent a 400. */
function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
  what: string,
): z.output<S> | null {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    reply.code(400).send(apiError("bad_request", `invalid ${what} — ${issues(result.error)}`));
    return null;
  }
  return result.data;
}

function toContactCard(ownerId: string, contactUserId: string): ContactCard | undefined {
  const record = getContact(ownerId, contactUserId);
  const peer = getUser(contactUserId);
  if (!record || !peer) return undefined;
  return {
    userId: peer.id,
    displayName: peer.displayName,
    lang: effectiveLang(peer, record.overrides),
    gender: effectiveGender(peer, record.overrides),
    tone: effectiveTone(peer, record.overrides),
    forceTranslate: record.forceTranslate,
    overrides: { ...record.overrides },
  };
}

/**
 * ORDER OF CHECKS, and it is the same in every route that acts for a user:
 * session first (401), then the shape of the request (400), then ownership
 * (403). Session before shape so an anonymous caller learns nothing about which
 * ids are well-formed; ownership last because it needs the parsed id.
 *
 * 403 covers "not yours" AND "does not exist", so the status code is not an
 * existence oracle for user ids. Where the repository already answers 404 to
 * protect a resource — an archived CALL you were not on, see archive.ts — that
 * 404 is left exactly as it was.
 */
export const userRoutes: FastifyPluginAsync = async (app) => {
  /**
   * THE FOUR SEEDED TEST IDENTITIES, AND NOBODY ELSE.
   *
   * Left unauthenticated on purpose — the identity picker reads it BEFORE
   * anyone has a session, so a session check here would lock the test grid out
   * of its own login screen. What is NOT justified by that is the answer it
   * used to give: `listUsers()`, i.e. the display name, language and gender of
   * every phone-registered person, to anyone who could reach the port, with no
   * session at all. Reproduced on 31.08.2026 with two registered testers:
   * `curl -s http://host/api/users` returned both of them by name.
   *
   * That was the membership oracle the rest of this change is built to avoid.
   * POST /api/contacts/by-phone goes to real trouble to answer identically for
   * a registered and an unregistered number, and a route one path segment away
   * was handing out the whole membership list for free — and, since identities
   * became durable (backend/src/store.ts), a list that now survives restarts
   * and only grows.
   *
   * Narrowing it costs the client nothing: BOTH call sites feed the answer
   * straight into selectSeededIdentities() (web/src/seeded-identities.ts, via
   * renderSeededIdentities() and buildDirectory()), so the four is all it has
   * ever used. Real peers arrive on GET /api/users/:userId/contacts, which has
   * a session behind it.
   *
   * The seeded ids come from the store rather than a list written out here, for
   * the reason stage0TestIdentityIdList() exists: a hand-copied grid drifts the
   * first time a fifth profile is seeded, and this one would drift into a login
   * screen missing a corner.
   */
  app.get("/api/users", async () => ({
    users: stage0TestIdentityIdList()
      .map((id) => getUser(id))
      .filter((u): u is UserProfile => u !== undefined),
  }));

  app.get("/api/users/:userId", async (req, reply) => {
    if (requireActor(req, reply) === null) return reply;
    const params = parse(userParams, req.params, reply, "path");
    if (!params) return reply;
    if (!requireSelf(req, reply, params.userId)) return reply;
    const user = getUser(params.userId);
    if (!user) return reply.code(404).send(apiError("not_found", `user ${params.userId} does not exist`));
    return { user };
  });

  app.patch("/api/users/:userId", async (req, reply) => {
    if (requireActor(req, reply) === null) return reply;
    const params = parse(userParams, req.params, reply, "path");
    if (!params) return reply;
    if (!requireSelf(req, reply, params.userId)) return reply;
    const body = parse(patchUserBody, req.body, reply, "body");
    if (!body) return reply;
    const user = updateUser(params.userId, body);
    if (!user) return reply.code(404).send(apiError("not_found", `user ${params.userId} does not exist`));
    req.log.info({ userId: user.id, patch: body }, "user profile updated");
    return { user };
  });

  app.get("/api/users/:userId/contacts", async (req, reply) => {
    if (requireActor(req, reply) === null) return reply;
    const params = parse(userParams, req.params, reply, "path");
    if (!params) return reply;
    if (!requireSelf(req, reply, params.userId)) return reply;
    if (!getUser(params.userId)) {
      return reply.code(404).send(apiError("not_found", `user ${params.userId} does not exist`));
    }
    const cards = listContacts(params.userId)
      .map((c) => toContactCard(params.userId, c.contactUserId))
      .filter((c): c is ContactCard => c !== undefined);
    return { contacts: cards };
  });

  app.patch("/api/users/:userId/contacts/:contactUserId", async (req, reply) => {
    if (requireActor(req, reply) === null) return reply;
    const params = parse(contactParams, req.params, reply, "path");
    if (!params) return reply;
    // :userId only. The CONTACT is somebody else by definition — the card being
    // edited is this user's private view of that person, not that person.
    if (!requireSelf(req, reply, params.userId)) return reply;
    const body = parse(patchContactBody, req.body, reply, "body");
    if (!body) return reply;

    const overrides: ContactOverridesPatch = {};
    if (body.lang !== undefined) overrides.lang = body.lang;
    if (body.gender !== undefined) overrides.gender = body.gender;
    if (body.tone !== undefined) overrides.tone = body.tone;

    const patch: { forceTranslate?: boolean; overrides?: ContactOverridesPatch } = { overrides };
    if (body.forceTranslate !== undefined) patch.forceTranslate = body.forceTranslate;

    const updated = updateContact(params.userId, params.contactUserId, patch);
    if (!updated) {
      return reply
        .code(404)
        .send(apiError("not_found", `contact ${params.contactUserId} of ${params.userId} does not exist`));
    }
    const card = toContactCard(params.userId, params.contactUserId);
    if (!card) {
      return reply.code(404).send(apiError("not_found", `user ${params.contactUserId} does not exist`));
    }
    req.log.info({ ownerId: params.userId, contactUserId: params.contactUserId, patch: body }, "contact updated");
    return { contact: card };
  });
};
