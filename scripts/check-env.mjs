#!/usr/bin/env node
// Validates .env against .env.example and against the config it has to agree
// with (livekit.yaml, the selected providers, the transport profile in force).
// Exits 1 with a readable list.
//
// This exists because the most expensive failure modes in this stack are all
// silent: a livekit.yaml key that does not match .env rejects every token with
// an opaque auth error; a provider selected without its API key fails only once
// a real call is already in progress; and a cloud profile with a ws:// URL or an
// http:// public origin produces a room that connects, a participant list that
// populates, and no audio and no microphone prompt — with nothing in any log.
//
//   node scripts/check-env.mjs                    # profile taken from .env
//   SPEAKEASY_PROFILE=cloud node scripts/check-env.mjs   # override for one run

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const EXAMPLE_PATH = join(ROOT, ".env.example");
const LIVEKIT_YAML_PATH = join(ROOT, "livekit.yaml");

const C = {
  reset: "\u001b[0m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
};

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/** Parse a KEY=value dotenv file. Strips one layer of surrounding quotes. */
function parseEnvFile(path) {
  const out = new Map();
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out.set(m[1], value);
  }
  return out;
}

/** Extract the `keys:` map from livekit.yaml without a YAML dependency. */
function parseLivekitKeys(path) {
  const keys = new Map();
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  let inKeys = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^keys:\s*$/.test(line)) {
      inKeys = true;
      continue;
    }
    if (!inKeys) continue;
    if (/^\S/.test(line)) break; // dedent ends the block
    const m = /^\s+([A-Za-z0-9_-]+)\s*:\s*(\S+)\s*$/.exec(line);
    if (m) keys.set(m[1], m[2]);
    else if (line.trim() !== "" && !line.trim().startsWith("#")) break;
  }
  return keys;
}

// ---------------------------------------------------------------- load files
if (!existsSync(EXAMPLE_PATH)) {
  console.error(`${C.red}error:${C.reset} .env.example is missing from ${ROOT}`);
  process.exit(1);
}
if (!existsSync(ENV_PATH)) {
  console.error(
    `${C.red}error:${C.reset} .env is missing.\n` +
      `        Create it with:  cp .env.example .env\n` +
      `        The defaults are a complete keyless mock configuration.`
  );
  process.exit(1);
}

const example = parseEnvFile(EXAMPLE_PATH);
const env = parseEnvFile(ENV_PATH);

const get = (k) => (env.get(k) ?? "").trim();

// ------------------------------------------------------------------ profile
// A process-environment value wins over the file, so `SPEAKEASY_PROFILE=cloud
// npm run dev` validates the cloud profile without editing .env.
const PROFILES = ["local", "cloud"];
const profileSource = (process.env.SPEAKEASY_PROFILE ?? "").trim()
  ? "environment"
  : get("SPEAKEASY_PROFILE")
    ? ".env"
    : "default";
const profile = ((process.env.SPEAKEASY_PROFILE ?? "").trim() || get("SPEAKEASY_PROFILE") || "local").toLowerCase();

if (!PROFILES.includes(profile)) {
  console.error(
    `${C.red}error:${C.reset} SPEAKEASY_PROFILE="${profile}" is not valid; ` +
      `expected one of: ${PROFILES.join(", ")}`
  );
  process.exit(1);
}
const isCloudProfile = profile === "cloud";

// ------------------------------------------------------------- completeness
const missingKeys = [...example.keys()].filter((k) => !env.has(k));
const extraKeys = [...env.keys()].filter((k) => !example.has(k));

// Required in every profile; the rest have working defaults in code.
const REQUIRED_ALWAYS = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "VITE_BACKEND_URL",
  "AGENT_URL",
  "AGENT_SHARED_SECRET",
  "STT_PROVIDER",
  "MT_PROVIDER",
  "TTS_PROVIDER",
];
// Required only when the cloud profile is in force. These are exactly the
// values that have no sensible default because they are minted per-session.
const REQUIRED_CLOUD = ["PUBLIC_WEB_ORIGIN"];

const REQUIRED = [...REQUIRED_ALWAYS, ...(isCloudProfile ? REQUIRED_CLOUD : [])];

for (const key of missingKeys) {
  if (REQUIRED.includes(key)) err(`${key} is missing from .env (required by the ${profile} profile)`);
  else warn(`${key} is missing from .env — .env.example has it; code default will be used`);
}
for (const key of REQUIRED) {
  if (env.has(key) && env.get(key).trim() === "") {
    err(`${key} is empty in .env (required by the ${profile} profile)`);
  }
}
for (const key of extraKeys) {
  warn(`${key} is in .env but not in .env.example — add it there so it stays documented`);
}

// ------------------------------------------------------------------ livekit
const livekitUrl = get("LIVEKIT_URL");
if (livekitUrl && !/^wss?:\/\//.test(livekitUrl)) {
  err(`LIVEKIT_URL must start with ws:// or wss:// (got "${livekitUrl}")`);
}

const isLocalLivekit = /^wss?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(livekitUrl);

const secret = get("LIVEKIT_API_SECRET");
if (secret && secret.length < 32) {
  warn(
    `LIVEKIT_API_SECRET is ${secret.length} chars; livekit-server logs an ERROR below 32. ` +
      `Generate a pair with: livekit-server generate-keys`
  );
}

// The committed development pair. Harmless locally, meaningless against Cloud.
const DEV_KEY = "devkey";
const DEV_SECRET = "devsecret0000000000000000000000000000000000";

if (isLocalLivekit) {
  if (!existsSync(LIVEKIT_YAML_PATH)) {
    err("livekit.yaml is missing but LIVEKIT_URL points at a local server");
  } else {
    const yamlKeys = parseLivekitKeys(LIVEKIT_YAML_PATH);
    if (yamlKeys.size === 0) {
      err(
        "livekit.yaml has no `keys:` map. With a config file livekit-server does NOT " +
          "inject a dev key, so no token would ever authenticate."
      );
    } else {
      const apiKey = get("LIVEKIT_API_KEY");
      if (!yamlKeys.has(apiKey)) {
        err(
          `LIVEKIT_API_KEY="${apiKey}" is not declared in livekit.yaml ` +
            `(it declares: ${[...yamlKeys.keys()].join(", ")}). Every token would be rejected.`
        );
      } else if (yamlKeys.get(apiKey) !== secret) {
        err(
          `LIVEKIT_API_SECRET does not match the secret for "${apiKey}" in livekit.yaml. ` +
            `Every token would be rejected with an opaque auth error.`
        );
      }
    }
  }
}

// --------------------------------------------------------------- providers
const PROVIDERS = {
  STT_PROVIDER: {
    mock: [],
    deepgram: ["DEEPGRAM_API_KEY"],
    runpod: ["RUNPOD_STT_URL"],
  },
  MT_PROVIDER: {
    mock: [],
    gemini: ["GEMINI_API_KEY"],
    runpod: ["RUNPOD_MT_URL"],
  },
  TTS_PROVIDER: {
    mock: [],
    cartesia: ["CARTESIA_API_KEY"],
    runpod: ["RUNPOD_TTS_URL"],
  },
};

for (const [varName, table] of Object.entries(PROVIDERS)) {
  const chosen = get(varName);
  if (!chosen) continue; // already reported as missing/empty above
  const needs = table[chosen];
  if (needs === undefined) {
    err(`${varName}="${chosen}" is not a valid provider; valid: ${Object.keys(table).join(", ")}`);
    continue;
  }
  for (const need of needs) {
    if (!get(need)) {
      err(`${varName}=${chosen} requires ${need}, which is empty in .env`);
    }
  }
  if (chosen === "runpod") {
    warn(`${varName}=runpod selects a Stage-1 stub that raises NotImplementedError`);
  }
}

// Cartesia's `voice` field is required by the API; the plugin substitutes its
// own en-US female voice when it is absent, for every language and both people.
if (get("TTS_PROVIDER") === "cartesia") {
  for (const [name, who] of [
    ["CARTESIA_VOICE_HE", "Hebrew (speaks the male founder's words to the Hebrew listener)"],
    ["CARTESIA_VOICE_RU", "Russian (speaks the female tester's words to the Russian listener)"],
  ]) {
    if (!get(name)) {
      err(
        `TTS_PROVIDER=cartesia but ${name} is empty. Blank does NOT mean "model default voice" — ` +
          `the plugin falls back to a hardcoded en-US female voice for ${who}.`
      );
    }
  }
}

// -------------------------------------------------- transport profile gates
const backendUrl = get("VITE_BACKEND_URL");
const publicWebOrigin = get("PUBLIC_WEB_ORIGIN");

// "/" is a legal, meaningful value: web/src/api.ts strips trailing slashes, so
// it collapses to "" and every request becomes a same-origin relative fetch
// that the Vite dev server proxies to the backend. That is what keeps the cloud
// profile down to one public URL.
const backendIsSameOrigin = backendUrl === "/";

if (backendUrl && !backendIsSameOrigin && !/^https?:\/\//.test(backendUrl)) {
  err(
    `VITE_BACKEND_URL must be "/" (same origin, proxied by the Vite dev server) ` +
      `or an absolute http(s) URL (got "${backendUrl}")`
  );
}

if (isCloudProfile) {
  // --- the SFU must be reachable from another machine, over TLS -------------
  if (livekitUrl.startsWith("ws://")) {
    err(
      `cloud profile requires a TLS LiveKit URL, but LIVEKIT_URL="${livekitUrl}" is ws://. ` +
        `The page is served over https and a browser refuses to open a ws:// signal ` +
        `connection from it (mixed content) — the room simply never connects. ` +
        `Use wss://<your-project>.livekit.cloud`
    );
  }
  if (isLocalLivekit) {
    err(
      `cloud profile but LIVEKIT_URL="${livekitUrl}" points at this machine. ` +
        `A second tester on another network cannot reach it, and a tunnel cannot carry ` +
        `WebRTC media (it is UDP/ICE, not HTTP). Point LIVEKIT_URL at LiveKit Cloud, ` +
        `or set SPEAKEASY_PROFILE=local.`
    );
  }
  if (get("LIVEKIT_API_KEY") === DEV_KEY || secret === DEV_SECRET) {
    err(
      `cloud profile is still using the committed local dev LiveKit credentials ` +
        `(devkey/devsecret...). LiveKit Cloud rejects them. Paste the project key and ` +
        `secret from the LiveKit Cloud dashboard (Settings -> Keys).`
    );
  }

  // --- the page must be a secure context, or there is no microphone ---------
  if (publicWebOrigin) {
    if (!/^https:\/\//.test(publicWebOrigin)) {
      err(
        `cloud profile requires PUBLIC_WEB_ORIGIN to be https:// (got "${publicWebOrigin}"). ` +
          `getUserMedia only runs in a secure context: http://localhost qualifies, ` +
          `http://<lan-ip> and any other plain-http origin does NOT — the second tester ` +
          `never even sees a microphone prompt. Run: npm run tunnel`
      );
    }
    if (/\/$/.test(publicWebOrigin)) {
      err(`PUBLIC_WEB_ORIGIN must not end with a slash (got "${publicWebOrigin}")`);
    } else if (/^https?:\/\/[^/]+\/.+/.test(publicWebOrigin)) {
      err(`PUBLIC_WEB_ORIGIN must be an origin, not a URL with a path (got "${publicWebOrigin}")`);
    }
  }

  // --- the API must be same-origin or https, never http ---------------------
  if (backendUrl.startsWith("http://")) {
    err(
      `cloud profile but VITE_BACKEND_URL="${backendUrl}" is http://. An https page cannot ` +
        `fetch an http API (mixed content) and ${
          /127\.0\.0\.1|localhost/.test(backendUrl)
            ? "127.0.0.1 means the SECOND TESTER'S machine, not yours"
            : "the browser will block every request"
        }. ` +
        `Set VITE_BACKEND_URL=/ and let the Vite dev server proxy /api and /healthz to the backend.`
    );
  }
  if (backendUrl.startsWith("https://") && publicWebOrigin && backendUrl !== publicWebOrigin) {
    warn(
      `VITE_BACKEND_URL and PUBLIC_WEB_ORIGIN are different origins, so every API call is a ` +
        `cross-origin request. That works only if the backend's CORS allowlist contains ` +
        `${publicWebOrigin}. VITE_BACKEND_URL=/ avoids the problem entirely.`
    );
  }
  if (get("AGENT_SHARED_SECRET") === "dev-agent-secret") {
    warn(
      "AGENT_SHARED_SECRET is still the committed default. Harmless while the agent stays on " +
        "127.0.0.1 (it must), but change it if the agent is ever moved off this machine."
    );
  }
} else {
  // ------------------------------- local profile ---------------------------
  if (!isLocalLivekit && livekitUrl) {
    err(
      `local profile but LIVEKIT_URL="${livekitUrl}" is remote. scripts/livekit.sh will not ` +
        `start a local SFU and nothing here matches livekit.yaml. Set SPEAKEASY_PROFILE=cloud ` +
        `if that is what you meant.`
    );
  }
  if (backendIsSameOrigin) {
    err(
      `VITE_BACKEND_URL=/ relies on the Vite dev server proxying /api to the backend, which is ` +
        `the cloud-profile setup. In the local profile use http://127.0.0.1:${get("BACKEND_PORT") || "8787"}.`
    );
  }
  if (publicWebOrigin) {
    warn(
      `PUBLIC_WEB_ORIGIN="${publicWebOrigin}" is set but the profile is local, so it is ignored. ` +
        `Quick-tunnel hostnames are single-use — clear it, or switch to SPEAKEASY_PROFILE=cloud.`
    );
  }
  if (backendUrl.startsWith("https://") && livekitUrl.startsWith("ws://")) {
    err(
      "mixed content: an https page cannot open a ws:// signal connection. " +
        "Use wss:// for LIVEKIT_URL, or http:// for VITE_BACKEND_URL."
    );
  }
}

// ---------------------------------------------------------- numeric fields
for (const [name, value] of [
  ["BACKEND_PORT", get("BACKEND_PORT")],
  ["WEB_PORT", get("WEB_PORT")],
  ["AGENT_PORT", get("AGENT_PORT")],
  ["TOKEN_TTL_SECONDS", get("TOKEN_TTL_SECONDS")],
  ["CHUNK_MIN_WORDS", get("CHUNK_MIN_WORDS")],
  ["CHUNK_MAX_SILENCE_MS", get("CHUNK_MAX_SILENCE_MS")],
  ["CHUNK_TIMEOUT_MS", get("CHUNK_TIMEOUT_MS")],
  ["CHUNK_WEAK_BOUNDARY_MIN_WORDS", get("CHUNK_WEAK_BOUNDARY_MIN_WORDS")],
  ["MT_HISTORY_TURNS", get("MT_HISTORY_TURNS")],
  ["VITE_POLL_INTERVAL_MS", get("VITE_POLL_INTERVAL_MS")],
  ["PRESENCE_TTL_SECONDS", get("PRESENCE_TTL_SECONDS")],
  ["RING_TIMEOUT_SECONDS", get("RING_TIMEOUT_SECONDS")],
]) {
  if (value !== "" && !/^\d+$/.test(value)) err(`${name} must be a positive integer (got "${value}")`);
}

// ------------------------------------------------------------ ringing sanity
// The number that actually decides whether a tester blinks offline is the
// SLOWEST poll the browser performs, and that is a constant in web/src/ring.ts
// (RING_POLL_HIDDEN_MS), not VITE_POLL_INTERVAL_MS — which, as of 2026-08-23,
// no code reads at all. Checking the dotenv value alone let a configuration
// through that looked safe (TTL 8 s vs "2000 ms") while a backgrounded tab
// polled every 5 s and went grey mid-ring. Keep both checks: the real one, and
// the declared one, so an edited .env still gets told it is inconsistent.
const RING_POLL_HIDDEN_MS = 5000; // keep in sync with web/src/ring.ts
const pollMs = Number(get("VITE_POLL_INTERVAL_MS") || 0);
const presenceTtl = Number(get("PRESENCE_TTL_SECONDS") || 0);
if (presenceTtl > 0 && presenceTtl * 1000 < RING_POLL_HIDDEN_MS * 3) {
  warn(
    `PRESENCE_TTL_SECONDS=${presenceTtl}s is less than 3x the browser's hidden-tab poll ` +
      `(${RING_POLL_HIDDEN_MS}ms, RING_POLL_HIDDEN_MS in web/src/ring.ts) — a tester whose ` +
      `tab is in the background will flicker offline and go grey in the contact list. ` +
      `Use at least ${(RING_POLL_HIDDEN_MS * 3) / 1000}s.`
  );
}
if (pollMs > 0 && presenceTtl > 0 && presenceTtl * 1000 < pollMs * 3) {
  warn(
    `PRESENCE_TTL_SECONDS=${presenceTtl}s is less than 3x the declared ` +
      `VITE_POLL_INTERVAL_MS=${pollMs}ms. (Note: nothing reads VITE_POLL_INTERVAL_MS — ` +
      `the client's real intervals are constants in web/src/ring.ts.)`
  );
}

// ------------------------------------------------------------------ eval log
const evalEnabled = get("EVAL_LOG_ENABLED");
if (evalEnabled && !["true", "false"].includes(evalEnabled.toLowerCase())) {
  err(`EVAL_LOG_ENABLED must be true or false (got "${evalEnabled}")`);
}
if (evalEnabled.toLowerCase() === "false") {
  warn(
    "EVAL_LOG_ENABLED=false — no utterances are recorded, so the judge flag has nothing to " +
      "attach to and `agent/scripts/review_call.py` will find nothing. Only correct for perf work."
  );
}
const evalDir = get("EVAL_LOG_DIR");
if (evalDir.startsWith("/") || evalDir.includes("..")) {
  err(`EVAL_LOG_DIR must be a path relative to the repo root without ".." (got "${evalDir}")`);
}

// -------------------------------------------------------------------- misc
const logLevel = get("LOG_LEVEL");
if (logLevel && !["debug", "info", "warn", "error"].includes(logLevel)) {
  warn(`LOG_LEVEL="${logLevel}" is not one of debug|info|warn|error`);
}

// -------------------------------------------------------------------- report
for (const w of warnings) console.log(`${C.yellow}warn ${C.reset} ${w}`);
for (const e of errors) console.log(`${C.red}error${C.reset} ${e}`);

if (errors.length > 0) {
  console.log(
    `\n${C.red}check:env failed${C.reset} — profile=${C.bold}${profile}${C.reset} ` +
      `(from ${profileSource}) — ${errors.length} error(s), ${warnings.length} warning(s)`
  );
  if (isCloudProfile) {
    console.log(
      `${C.dim}        cloud profile checklist:\n` +
        `          LIVEKIT_URL        wss://<project>.livekit.cloud   (not ws://, not localhost)\n` +
        `          LIVEKIT_API_KEY    from the LiveKit Cloud dashboard (not devkey)\n` +
        `          LIVEKIT_API_SECRET from the same dialog, shown once\n` +
        `          PUBLIC_WEB_ORIGIN  https://<...>.trycloudflare.com  (npm run tunnel prints it)\n` +
        `          VITE_BACKEND_URL   /                                (same origin, Vite proxies it)${C.reset}`
    );
  }
  process.exit(1);
}

console.log(
  `${C.green}check:env ok${C.reset} ` +
    `${C.dim}profile=${profile} ` +
    `livekit=${livekitUrl}${isLocalLivekit ? " (local)" : " (remote)"} ` +
    `web=${isCloudProfile ? publicWebOrigin || "(no PUBLIC_WEB_ORIGIN)" : `http://localhost:${get("WEB_PORT") || "5173"}`} ` +
    `providers: stt=${get("STT_PROVIDER")} mt=${get("MT_PROVIDER")} tts=${get("TTS_PROVIDER")}` +
    `${warnings.length ? ` — ${warnings.length} warning(s)` : ""}${C.reset}`
);
