import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { createCallArchive } from "./archive.js";
import { loadConfig, type Config, type OriginRule } from "./config.js";
import { createCallSweeper } from "./ringing.js";
import { archiveRoutes } from "./routes/archive.js";
import { authRoutes } from "./routes/auth.js";
import { registerAuth } from "./auth.js";
import { callRoutes } from "./routes/calls.js";
import { contactRoutes } from "./routes/contacts.js";
import { passkeyRoutes } from "./routes/passkeys.js";
import { healthRoutes, VERSION } from "./routes/health.js";
import { presenceRoutes } from "./routes/presence.js";
import { userRoutes } from "./routes/users.js";
import { STAGE0_AUTO_JOIN_TEST_IDENTITIES, stage0TestIdentityIdList,
  loadIdentityStore,
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
 * `logStream` существует ровно ради одного утверждения: код подтверждения
 * уходит в журнал, а номер телефона — нет. Pino пишет прямо в дескриптор 1,
 * мимо всего, что тест может перехватить изнутри процесса, поэтому без точки
 * перенаправления правило о личных данных держалось бы только на ревью.
 * Продакшен его никогда не передаёт.
 */
export async function buildApp(cfg: Config, opts: { logStream?: NodeJS.WritableStream } = {}): Promise<FastifyInstance> {
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
    // `authorization` — бортовая половина сессии (backend/src/session.ts):
    // кука SameSite=Lax не уходит на кросс-оригин, а разработка именно такая —
    // страница на :5173, API на :8787. И тем же заголовком живёт вход внутри
    // встроенного браузера мессенджера, который теряет куки.
    allowedHeaders: ["content-type", "x-request-id", "authorization"],
    exposedHeaders: ["x-request-id"],
    // Без этого кука вообще не поедет на кросс-оригин. Безопасно только
    // потому, что список источников выше — белый список, а не `*`; эти две
    // настройки — одно решение и читаются вместе.
    credentials: true,
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", String(req.id));
  });

  const archive = createCallArchive(cfg.callArchiveDir, app.log);
  // Whatever previous runs of this process wrote is part of the archive too.
  await archive.load();
  app.decorate("callArchive", archive);

  const sweeper = createCallSweeper(cfg, app.log, archive);
  sweeper.start();
  app.addHook("onClose", async () => sweeper.stop());

  // До любого маршрута: именно это превращает `?me=` из личности в подсказку.
  // Снимок личностей читается ДО маршрутов: без него перезапуск стирал всех
  // зарегистрированных, и API честно отвечал «нет такого пользователя».
  loadIdentityStore(cfg.identityDir, app.log);

  registerAuth(app, cfg);

  await app.register(healthRoutes(cfg));
  await app.register(authRoutes(cfg));
  await app.register(passkeyRoutes(cfg));
  await app.register(contactRoutes);
  await app.register(userRoutes);
  await app.register(archiveRoutes(archive));
  await app.register(presenceRoutes(cfg, sweeper));
  await app.register(callRoutes(cfg, sweeper));

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

  const app = await buildApp(cfg);

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
