import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { normalizePhone } from "./phoneVerification.js";

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

  // --- identity: who is making this request ---------------------------------

  /**
   * HMAC key for session tokens (backend/src/session.ts). Absent from the
   * environment means a random key per boot — see sessionSecretEphemeral.
   */
  sessionSecret: string;
  /**
   * True when SESSION_SECRET was not set and a random key was generated at
   * boot, which invalidates every existing session on every restart. It is
   * warned about rather than hidden, because the day users become durable is
   * the day "you were logged out again" stops being explainable.
   */
  sessionSecretEphemeral: boolean;
  sessionTtlSeconds: number;
  /** "auto" decides per request from the Host header — see session.ts. */
  sessionCookieSecure: boolean | "auto";
  /**
   * Whether POST /api/auth/phone/start returns the confirmation code in its own
   * response. OFF by default: with it on, anyone who can reach the server can
   * verify anyone's number and open the app as them.
   */
  authDevCodeInResponse: boolean;
  /**
   * Numbers allowed to START verification, already normalized to E.164 so the
   * comparison cannot fail on notation. Empty means anyone may register — the
   * pre-31.08.2026 behaviour, kept as the default and warned about at boot.
   */
  authPhoneAllowlist: readonly string[];
  /**
   * Whether POST /api/auth/seeded-login hands out a session as one of the four
   * seeded test identities with no proof at all. OFF by default.
   */
  authSeededLogin: boolean;
  /**
   * Where the identity snapshot (users, the phone index, contacts) is kept.
   * Same anchoring rule as callArchiveDir: a relative path is resolved against
   * the REPO root, never against the working directory of whatever started the
   * process. Separate from callArchiveDir because the contents are different in
   * kind — a call archive is a record of something that happened, this is the
   * live account data the server needs to answer the next request at all.
   */
  identityDir: string;
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

/** Same as boolFromEnv, plus the literal "auto" that session.ts resolves per request. */
function boolOrAutoFromEnv(name: string, fallback: "auto"): boolean | "auto" {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "auto") return fallback;
  return boolFromEnv(name, true);
}

/**
 * The allowlist goes through the SAME normalizer an incoming number does.
 * Written any other way, `0501234567` in the file would never match
 * `+972501234567` on the wire, and the failure would read as "the allowlist
 * blocks everybody" rather than "the notation differs".
 */
function parsePhoneAllowlist(raw: string): string[] {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const allowed: string[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const normalized = normalizePhone(entry);
    // The rejected entry is echoed back here and NOWHERE else in the backend:
    // this is a startup crash on the operator's own terminal, quoting his own
    // config file. It is not a log line and not an API response, which is where
    // the "a phone number is personal data" rule bites.
    if (normalized === null) problems.push(`  - "${entry}" is not a phone number`);
    else if (!allowed.includes(normalized)) allowed.push(normalized);
  }
  if (problems.length > 0) {
    throw new Error(
      [
        "SpeakEasy backend cannot start: AUTH_PHONE_ALLOWLIST contains invalid entries.",
        ...problems,
        "",
        "AUTH_PHONE_ALLOWLIST is a comma-separated list of the numbers allowed to",
        "start phone verification. Israeli mobile notation and +E.164 both work:",
        "  AUTH_PHONE_ALLOWLIST=050-123-4567,+972527654321",
        "Leave it empty to let anyone register (the pre-31.08.2026 behaviour).",
      ].join("\n"),
    );
  }
  return allowed;
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

  // A random key beats a committed default: a default secret in .env.example is
  // a secret every deployment that never changed it shares with the internet.
  // The cost is that sessions do not survive a restart, which is what the boot
  // warning in buildApp() says out loud.
  const configuredSecret = process.env.SESSION_SECRET?.trim() ?? "";
  const sessionSecretEphemeral = configuredSecret.length === 0;
  const sessionSecret = sessionSecretEphemeral ? randomBytes(32).toString("hex") : configuredSecret;
  if (!sessionSecretEphemeral && configuredSecret.length < 32) {
    process.emitWarning(
      `SESSION_SECRET is ${configuredSecret.length} chars; use at least 32 (openssl rand -hex 32).`,
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
    sessionSecret,
    sessionSecretEphemeral,
    // 30 days. An app you have to log into every week is an app nobody carries,
    // and the token names a user id and nothing else; the logout button revokes
    // it on the spot for the case that matters.
    sessionTtlSeconds: intFromEnv("SESSION_TTL_SECONDS", 30 * 24 * 3600),
    sessionCookieSecure: boolOrAutoFromEnv("SESSION_COOKIE_SECURE", "auto"),
    authDevCodeInResponse: boolFromEnv("AUTH_DEV_CODE_IN_RESPONSE", false),
    authPhoneAllowlist: parsePhoneAllowlist(process.env.AUTH_PHONE_ALLOWLIST ?? ""),
    authSeededLogin: boolFromEnv("AUTH_SEEDED_LOGIN", false),
    // Under data/ rather than logs/: the file holds phone numbers, and
    // .gitignore's "Datasets / user data" section is where user data belongs.
    identityDir: pathFromEnv("IDENTITY_DIR", "data/identity"),
  };
}
