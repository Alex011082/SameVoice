import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { createCallArchive } from "./archive.js";
import { registerAuth } from "./auth.js";
import { loadConfig, type Config, type OriginRule } from "./config.js";
import { createCallSweeper } from "./ringing.js";
import { archiveRoutes } from "./routes/archive.js";
import { authRoutes } from "./routes/auth.js";
import { callRoutes } from "./routes/calls.js";
import { contactRoutes } from "./routes/contacts.js";
import { healthRoutes, VERSION } from "./routes/health.js";
import { presenceRoutes } from "./routes/presence.js";
import { userRoutes } from "./routes/users.js";
import {
  loadIdentityStore,
  STAGE0_AUTO_JOIN_TEST_IDENTITIES,
  stage0TestIdentityIdList,
} from "./store.js";
import { apiError } from "./types.js";

const LOCAL_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+\.local)(:\d+)?$/i;

/** scheme://host[:port] — an Origin header never carries a path, so no path is parsed. */
const ORIGIN_HEADER_RE = /^(https?):\/\/([^/:]+|\[[^\]]+\])(?::(\d{1,5}))?$/i;

function matches(rule: OriginRule, scheme: string, host: string, port: string): boolean {
  if (rule.scheme !== scheme || rule.port !== port) return false;
  if (!rule.wildcard) return rule.host === host;
  // "*.trycloudflare.com" matches "abc.trycloudflare.com" but NOT the bare apex,
  // and not "evil.com/x.trycloudflare.com" — the suffix check is anchored on the dot.
  return host.endsWith(`.${rule.host}`) && host.length > rule.host.length + 1;
}

/**
 * Exported for the smoke test. Two origins are allowed at once by design: the local
 * dev origin AND one public HTTPS origin, so the same process serves a laptop tab and
 * a remote tester through a tunnel without an env swap between them.
 */
export function originAllowed(cfg: Config, origin: string): boolean {
  const m = ORIGIN_HEADER_RE.exec(origin.trim());
  if (!m) return false;
  const scheme = m[1]!.toLowerCase();
  const host = m[2]!.toLowerCase();
  const port = m[3] ?? "";
  if (cfg.allowLocalOrigins && LOCAL_ORIGIN_RE.test(`${scheme}://${host}${port ? `:${port}` : ""}`)) {
    return true;
  }
  return cfg.webOrigins.some((rule) => matches(rule, scheme, host, port));
}

/**
 * `logStream` exists for exactly one assertion: that a confirmation code goes
 * to the log and the phone number does NOT. Pino writes straight to file
 * descriptor 1, past anything a test can hook from inside the process, so
 * without somewhere to point it the personal-data invariant is untestable and
 * would be enforced by review alone. Production never passes it.
 */
export async function buildApp(
  cfg: Config,
  opts: { logStream?: NodeJS.WritableStream } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      base: { service: "backend" },
      ...(opts.logStream ? { stream: opts.logStream } : {}),
    },
    genReqId: () => randomUUID().slice(0, 8),
    requestIdHeader: "x-request-id",
    // requestIdLogLabel ("reqId") and disableRequestLogging (false) are already
    // the Fastify defaults; naming them here is what triggered FSTDEP023/024 on
    // every boot under fastify 5.12 and would hard-fail on fastify 6.
  });

  await app.register(cors, {
    origin(origin, cb) {
      // No Origin header: curl, the smoke test, server-to-server. Always allowed.
      if (!origin) return cb(null, true);
      cb(null, originAllowed(cfg, origin));
    },
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    // `authorization` is the bearer half of the session (backend/src/session.ts):
    // a SameSite=Lax cookie is not sent on a cross-origin fetch, and the dev
    // setup is exactly that — page on :5173, API on :8787.
    allowedHeaders: ["content-type", "x-request-id", "authorization"],
    exposedHeaders: ["x-request-id"],
    // Needed for the cookie to travel at all on a cross-origin request. Safe
    // only because the origin callback above is an allowlist and never `*`;
    // the two settings are one decision and must be read together.
    credentials: true,
  });

  // Before any route: this is what turns `?me=` from an identity into a hint.
  registerAuth(app, cfg);

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", String(req.id));
  });

  // Before any route can answer: the seeded four exist in code, but every
  // phone-registered profile exists only in this file, and a request that
  // arrives before it is read would be told the user does not exist. Throws on a
  // corrupt file rather than starting with an empty store — see store.ts.
  loadIdentityStore(cfg.identityDir, app.log);

  const archive = createCallArchive(cfg.callArchiveDir, app.log);
  // Whatever previous runs of this process wrote is part of the archive too.
  await archive.load();
  app.decorate("callArchive", archive);

  const sweeper = createCallSweeper(cfg, app.log, archive);
  sweeper.start();
  app.addHook("onClose", async () => sweeper.stop());

  await app.register(healthRoutes(cfg));
  await app.register(authRoutes(cfg));
  await app.register(userRoutes);
  await app.register(contactRoutes);
  await app.register(archiveRoutes(archive));
  await app.register(presenceRoutes(cfg, sweeper));
  await app.register(callRoutes(cfg, sweeper));

  // Said at boot, not in a doc: every one of these is a deliberate opening that
  // somebody has to close again before real people are on this server, and an
  // opening nobody can see is one nobody closes.
  if (cfg.authPhoneAllowlist.length === 0) {
    app.log.warn(
      "AUTH_PHONE_ALLOWLIST is empty — ANYONE who can reach this server can register a profile. " +
        "Set it to the testers' numbers before this URL is shared.",
    );
  }
  if (cfg.authDevCodeInResponse) {
    app.log.warn(
      "AUTH_DEV_CODE_IN_RESPONSE is on — the confirmation code is returned to the browser, " +
        "so anyone can verify anyone's number. Development boxes only.",
    );
  }
  if (cfg.authSeededLogin) {
    app.log.warn(
      "AUTH_SEEDED_LOGIN is on — anyone can take a session as a seeded test identity, " +
        "and those identities are contacts of every registered user.",
    );
  }
  if (cfg.sessionSecretEphemeral) {
    app.log.warn(
      "SESSION_SECRET is not set — a random key was generated, so every session ends at the " +
        "next restart. Set it to keep people signed in (openssl rand -hex 32).",
    );
  }

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(apiError("not_found", `no route for ${req.method} ${req.url}`));
  });

  app.setErrorHandler<FastifyError>((err, req, reply) => {
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, "unhandled error");
      reply.code(500).send(apiError("internal", "internal server error"));
      return;
    }
    reply.code(status).send(apiError(status === 400 ? "bad_request" : "conflict", err.message));
  });

  return app;
}

async function start(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  let app: FastifyInstance;
  try {
    app = await buildApp(cfg);
  } catch (err) {
    // A corrupt identity store lands here. It is a startup failure like a
    // missing env var, so it gets the same treatment: the message, no stack.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  try {
    await app.listen({ port: cfg.port, host: cfg.host });
  } catch (err) {
    app.log.error({ err }, "failed to listen");
    process.exit(1);
  }

  app.log.info(
    {
      version: VERSION,
      livekitUrl: cfg.livekitUrl,
      agentUrl: cfg.agentUrl,
      providers: cfg.providers,
      tokenTtlSeconds: cfg.tokenTtlSeconds,
      webOrigin: `http://localhost:${cfg.webPort}`,
      allowLocalOrigins: cfg.allowLocalOrigins,
      webOrigins: cfg.webOrigins.map((o) => o.raw),
      ringTimeoutSeconds: cfg.ringTimeoutSeconds,
      presenceTtlSeconds: cfg.presenceTtlSeconds,
      callArchiveDir: cfg.callArchiveDir,
      sessionTtlSeconds: cfg.sessionTtlSeconds,
      sessionCookieSecure: cfg.sessionCookieSecure,
      authDevCodeInResponse: cfg.authDevCodeInResponse,
      // The COUNT, never the numbers: this line is a log line, and a phone
      // number in a log line is the thing the whole auth flow is protecting.
      authPhoneAllowlistSize: cfg.authPhoneAllowlist.length,
      authSeededLogin: cfg.authSeededLogin,
      identityDir: cfg.identityDir,
      // Every other operationally surprising setting is printed here, and this
      // is the most surprising one: a number that passes verification is joined
      // to the test identities in BOTH directions. Whoever wonders why
      // strangers are in u_alex's contact list should find the answer in the
      // log rather than in a comment in store.ts.
      stage0AutoJoinTestIdentities: STAGE0_AUTO_JOIN_TEST_IDENTITIES,
      stage0TestIdentities: stage0TestIdentityIdList(),
    },
    "speakeasy backend ready",
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "shutting down");
      void app.close().then(() => process.exit(0));
    });
  }
}

const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedAs === import.meta.url) {
  await start();
}
