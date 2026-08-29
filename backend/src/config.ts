import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// The repo-root .env is the single source of truth shared by backend, agent and vite.
// Resolved relative to this module so it works from src/ (tsx) and from dist/ (node) alike.
const rootEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath, quiet: true });
} else {
  dotenv.config({ quiet: true });
}

/**
 * One entry of WEB_ORIGINS, already parsed and validated at startup so that the
 * per-request check is a string compare and never a surprise.
 * `wildcard` means the entry was written as `https://*.trycloudflare.com`, which
 * matches exactly one extra label ("*.example.com" does NOT match "example.com").
 */
export interface OriginRule {
  raw: string;
  scheme: "http" | "https";
  host: string;
  port: string;
  wildcard: boolean;
}

export interface Config {
  port: number;
  host: string;
  webPort: number;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  agentUrl: string;
  agentSharedSecret: string;
  tokenTtlSeconds: number;
  providers: { stt: string; mt: string; tts: string };
  logLevel: string;
  /** Extra browser origins allowed through CORS, on top of the local ones. */
  webOrigins: OriginRule[];
  /** localhost / 127.0.0.1 / ::1 / LAN IP / *.local — on unless explicitly disabled. */
  allowLocalOrigins: boolean;
  ringTimeoutSeconds: number;
  presenceTtlSeconds: number;
  presencePollIntervalMs: number;
  /**
   * Where finished calls are kept, one JSON file per call. Relative paths are
   * anchored to the REPO root, not to whatever directory the process was
   * started in — the same trap the agent's EVAL_LOG_DIR already documents.
   */
  callArchiveDir: string;
}

const REQUIRED = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "AGENT_URL",
  "AGENT_SHARED_SECRET",
  "STT_PROVIDER",
  "MT_PROVIDER",
  "TTS_PROVIDER",
] as const;

/**
 * scheme://host[:port] with an optional single leading `*.` label on the host.
 * No path, no query, no userinfo, no credentials — an Origin header never has them,
 * so accepting them would only ever silently fail to match.
 */
const ORIGIN_ENTRY_RE =
  /^(https?):\/\/(\*\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i;

function parseOriginEntry(raw: string): OriginRule | string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "is empty";
  const m = ORIGIN_ENTRY_RE.exec(trimmed);
  if (!m) {
    return "must look like https://host[:port] (optionally https://*.host) — no path, no trailing slash";
  }
  const [, scheme, star, host, port] = m;
  const wildcard = star !== undefined;
  if (wildcard && !host!.includes(".")) {
    return "a wildcard needs at least two labels after it, e.g. https://*.trycloudflare.com";
  }
  if (port !== undefined && Number.parseInt(port, 10) > 65535) return "port is out of range";
  return {
    raw: trimmed,
    scheme: scheme!.toLowerCase() as "http" | "https",
    host: host!.toLowerCase(),
    port: port ?? "",
    wildcard,
  };
}

/** Exported for the smoke test; `loadConfig` is the only production caller. */
export function parseWebOrigins(rawList: string): OriginRule[] {
  const entries = rawList
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const rules: OriginRule[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const parsed = parseOriginEntry(entry);
    if (typeof parsed === "string") problems.push(`  - "${entry}" ${parsed}`);
    else rules.push(parsed);
  }
  if (problems.length > 0) {
    throw new Error(
      [
        "SpeakEasy backend cannot start: WEB_ORIGINS contains invalid entries.",
        ...problems,
        "",
        "WEB_ORIGINS is a comma-separated list of browser origins allowed through CORS.",
        "Examples:",
        "  WEB_ORIGINS=https://my-tunnel.trycloudflare.com",
        "  WEB_ORIGINS=https://*.trycloudflare.com,https://speakeasy.example.com",
        "Leave it empty when the page and the API share one origin (Vite proxy): CORS never runs.",
      ].join("\n"),
    );
  }
  return rules;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Invalid ${name}="${raw}": expected true or false.`);
}

/** A path from the environment, anchored to the repo root when it is relative. */
function pathFromEnv(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback;
  return isAbsolute(raw) ? raw : fileURLToPath(new URL(`../../${raw}`, import.meta.url));
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}="${raw}": expected a positive integer.`);
  }
  return n;
}

export function loadConfig(): Config {
  const missing = REQUIRED.filter((k) => {
    const v = process.env[k];
    return v === undefined || v.trim() === "";
  });

  if (missing.length > 0) {
    throw new Error(
      [
        "SpeakEasy backend cannot start: missing required environment variables.",
        ...missing.map((k) => `  - ${k}`),
        "",
        `Fix: cp .env.example .env   (repo root: ${fileURLToPath(new URL("../../", import.meta.url))})`,
        "The committed .env.example has working mock defaults and needs no API keys.",
      ].join("\n"),
    );
  }

  // A LiveKit API secret shorter than 32 chars makes livekit-server log a scary
  // non-fatal ERROR and is a common cause of "why is my token rejected".
  const secret = process.env.LIVEKIT_API_SECRET!;
  if (secret.length < 32) {
    process.emitWarning(
      `LIVEKIT_API_SECRET is ${secret.length} chars; livekit-server wants >= 32. Tokens still sign, but the server logs an error.`,
    );
  }

  const webOrigins = parseWebOrigins(process.env.WEB_ORIGINS ?? "");
  const allowLocalOrigins = boolFromEnv("ALLOW_LOCAL_ORIGINS", true);
  if (webOrigins.length === 0 && !allowLocalOrigins) {
    throw new Error(
      [
        "SpeakEasy backend cannot start: ALLOW_LOCAL_ORIGINS=false with an empty WEB_ORIGINS",
        "would reject every browser origin, leaving the API reachable only by curl.",
        "Set WEB_ORIGINS to the public page origin, or leave ALLOW_LOCAL_ORIGINS at its default.",
      ].join("\n"),
    );
  }

  // An https page cannot open a ws:// LiveKit signal connection, and a public
  // origin implies an https page. Catching it here beats debugging a room that
  // never connects with no error the user can see.
  const livekitUrl = process.env.LIVEKIT_URL!.trim();
  const hasPublicHttpsOrigin = webOrigins.some((o) => o.scheme === "https");
  if (hasPublicHttpsOrigin && livekitUrl.startsWith("ws://")) {
    process.emitWarning(
      `WEB_ORIGINS contains an https origin but LIVEKIT_URL is ${livekitUrl} — ` +
        "an https page cannot open a ws:// connection (mixed content). Use wss://.",
    );
  }

  return {
    port: intFromEnv("BACKEND_PORT", 8787),
    host: process.env.BACKEND_HOST?.trim() || "0.0.0.0",
    webPort: intFromEnv("WEB_PORT", 5173),
    livekitUrl,
    livekitApiKey: process.env.LIVEKIT_API_KEY!.trim(),
    livekitApiSecret: secret,
    agentUrl: process.env.AGENT_URL!.trim().replace(/\/+$/, ""),
    agentSharedSecret: process.env.AGENT_SHARED_SECRET!,
    tokenTtlSeconds: intFromEnv("TOKEN_TTL_SECONDS", 3600),
    providers: {
      stt: process.env.STT_PROVIDER!.trim(),
      mt: process.env.MT_PROVIDER!.trim(),
      tts: process.env.TTS_PROVIDER!.trim(),
    },
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    webOrigins,
    allowLocalOrigins,
    ringTimeoutSeconds: intFromEnv("RING_TIMEOUT_SECONDS", 45),
    presenceTtlSeconds: intFromEnv("PRESENCE_TTL_SECONDS", 15),
    presencePollIntervalMs: intFromEnv("PRESENCE_POLL_MS", 2000),
    callArchiveDir: pathFromEnv("CALL_ARCHIVE_DIR", "logs/archive"),
  };
}
