import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import type { CallArchive } from "../archive.js";
import { getUser } from "../store.js";
import { apiError, CALL_ID_RE, USER_ID_RE } from "../types.js";

/**
 * Reading finished calls back.
 *
 * Scoped under the user on purpose: an archived call is readable by the two
 * people who were on it and by nobody else, and putting the acting user in the
 * path makes that the shape of the route rather than a check somebody can
 * forget to write. A call this user was not on is reported as `not_found`, not
 * `forbidden` — otherwise the 403 itself confirms the call exists.
 *
 * Storage only for now: the record is the call, its participants and its
 * timings. Transcripts and playback join to it by call id (the agent's eval log
 * already writes `logs/calls/<callId>.jsonl` under the same id).
 */

const userIdSchema = z.string().regex(USER_ID_RE, "must match ^u_[a-z0-9_]{1,30}$");
const callIdSchema = z.string().regex(CALL_ID_RE, "must match ^c_[0-9a-f]{12}$");

const userParams = z.object({ userId: userIdSchema });
const recordParams = z.object({ userId: userIdSchema, callId: callIdSchema });

function issues(err: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

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

export function archiveRoutes(archive: CallArchive): FastifyPluginAsync {
  return async (app) => {
    app.get("/api/users/:userId/calls", async (req, reply) => {
      const params = parse(userParams, req.params, reply, "path");
      if (!params) return reply;
      if (!getUser(params.userId)) {
        return reply.code(404).send(apiError("not_found", `user ${params.userId} does not exist`));
      }
      return { calls: archive.listFor(params.userId) };
    });

    app.get("/api/users/:userId/calls/:callId", async (req, reply) => {
      const params = parse(recordParams, req.params, reply, "path");
      if (!params) return reply;
      if (!getUser(params.userId)) {
        return reply.code(404).send(apiError("not_found", `user ${params.userId} does not exist`));
      }
      const record = await archive.get(params.callId, params.userId);
      if (record === undefined) {
        return reply
          .code(404)
          .send(
            apiError(
              "not_found",
              `no archived call ${params.callId} for ${params.userId} — it is not archived yet, or it was somebody else's call`,
            ),
          );
      }
      return record;
    });
  };
}
