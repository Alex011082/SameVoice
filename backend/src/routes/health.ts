import type { FastifyPluginAsync } from "fastify";
import type { Config } from "../config.js";
import { callCounts } from "../store.js";
import { AGENT_IDENTITY, STATE_TOPIC, SUBTITLE_TOPIC } from "../types.js";

export const VERSION = "0.1.0";

export function healthRoutes(cfg: Config): FastifyPluginAsync {
  return async (app) => {
    app.get("/healthz", async () => ({
      ok: true,
      service: "backend",
      version: VERSION,
      time: new Date().toISOString(),
      // The store is in-memory and the process runs for weeks. These two numbers
      // are how a growing leak, or a call that refuses to die, becomes visible
      // from outside — which is exactly what was missing on 25.08.2026.
      calls: callCounts(),
    }));

    app.get("/api/config", async () => ({
      livekitUrl: cfg.livekitUrl,
      providers: { stt: cfg.providers.stt, mt: cfg.providers.mt, tts: cfg.providers.tts },
      agentIdentity: AGENT_IDENTITY,
      subtitleTopic: SUBTITLE_TOPIC,
      stateTopic: STATE_TOPIC,
      // So the web client's poll loop and ring countdown come from the server,
      // not from a duplicated constant that can silently drift out of agreement.
      ring: {
        timeoutSeconds: cfg.ringTimeoutSeconds,
        presenceTtlSeconds: cfg.presenceTtlSeconds,
        pollIntervalMs: cfg.presencePollIntervalMs,
      },
    }));
  };
}
