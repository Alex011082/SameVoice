#!/usr/bin/env node
/**
 * SameVoice development panel — a local-only split screen: the running app on
 * the left, the things you need while building it on the right.
 *
 * WHY THIS IS A SERVER AND NOT A FILE:// PAGE
 * The panel reads the repo (handoff documents), reads and writes `.env`, and
 * asks both the local and the production backend how they are. A browser page
 * opened from disk can do none of that. The Jarvis roadmap panel works from
 * file:// because it only ever touches localStorage; this one touches the
 * machine, so it needs a process.
 *
 * WHY IT BINDS TO 127.0.0.1
 * It can write provider credentials. Bound to anything else it becomes a
 * credential-writing endpoint on the network, and this machine sits on the same
 * networks as everyone else's. `HOST` is deliberately NOT configurable.
 *
 * WHAT IT WILL NOT DO
 * It does not write to the production server, and it does not read secret
 * values back out (see lib/env.mjs). Production config is shown, never edited:
 * for the server the panel prints the exact command to run, so the privileged
 * step stays in a terminal where it is visible and logged.
 */

import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  normalizeRepoMarkdownPath,
  parseHandoffMarkdown,
  formatTaskHandoff,
  formatTaskPrompt,
} from "./lib/handoff.mjs";
import { describeEnv, patchEnvText, readEnvFile, writeEnvFile, isSecretName } from "./lib/env.mjs";

const run = promisify(execFile);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
const PUBLIC = join(HERE, "public");
const ENV_PATH = join(REPO, ".env");

const HOST = "127.0.0.1"; // not configurable, see the header comment
const PORT = Number(process.env.PANEL_PORT || 5178);

const PROD_ORIGIN = "https://samevoice.0110.digital";
const LOCAL_APP = process.env.PANEL_APP_ORIGIN || "http://127.0.0.1:5173";
const LOCAL_BACKEND = process.env.PANEL_BACKEND_ORIGIN || "http://127.0.0.1:8787";

/** The env keys the panel manages. Order is the order shown in the UI. */
const MANAGED = [
  "STT_PROVIDER", "DEEPGRAM_API_KEY", "DEEPGRAM_MODEL", "DEEPGRAM_BASE_URL",
  "MT_PROVIDER", "OPENAI_API_KEY", "OPENAI_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL",
  "TTS_PROVIDER", "CARTESIA_API_KEY", "CARTESIA_MODEL", "CARTESIA_VOICE_RU", "CARTESIA_VOICE_HE",
  "LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
  "PUBLIC_WEB_ORIGIN", "AGENT_SHARED_SECRET",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("тело запроса слишком велико");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Health of one backend, never throwing: unreachable is a state, not an error. */
async function probe(origin, path = "/healthz") {
  const started = Date.now();
  try {
    const ctl = AbortSignal.timeout(4000);
    const res = await fetch(`${origin}${path}`, { signal: ctl });
    const ms = Date.now() - started;
    const body = await res.json().catch(() => ({}));
    return { origin, ok: res.ok, status: res.status, ms, body };
  } catch (err) {
    return { origin, ok: false, status: 0, ms: Date.now() - started, error: String(err.message || err) };
  }
}

async function gitInfo() {
  const git = async (...args) => {
    try {
      const { stdout } = await run("git", args, { cwd: REPO });
      return stdout.trim();
    } catch {
      return "";
    }
  };
  const [branch, log, dirty] = await Promise.all([
    git("rev-parse", "--abbrev-ref", "HEAD"),
    git("log", "-8", "--pretty=%h|%ad|%s", "--date=short"),
    git("status", "--porcelain"),
  ]);
  return {
    branch,
    dirty: dirty ? dirty.split("\n").filter(Boolean).length : 0,
    commits: log ? log.split("\n").map(line => {
      const [hash, date, ...rest] = line.split("|");
      return { hash, date, subject: rest.join("|") };
    }) : [],
  };
}

/** Every .md in the repo the panel is willing to open, excluding build output. */
async function listDocs() {
  const skip = new Set(["node_modules", ".git", "dist", ".venv", "__pycache__", "logs", ".vite"]);
  const found = [];
  async function walk(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (extname(entry.name).toLowerCase() === ".md") {
        const info = await stat(full).catch(() => null);
        found.push({
          path: relative(REPO, full).split(sep).join("/"),
          size: info?.size ?? 0,
          modified: info?.mtime?.toISOString() ?? "",
        });
      }
    }
  }
  await walk(REPO);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function serveStatic(req, res, pathname) {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (name.includes("..") || name.startsWith("/")) {
    json(res, 400, { error: "bad path" });
    return;
  }
  const file = join(PUBLIC, name);
  if (!file.startsWith(PUBLIC)) {
    json(res, 400, { error: "bad path" });
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const routes = {
  async "GET /api/state"(_req, res) {
    const [envText, git, local, prod, agent] = await Promise.all([
      readEnvFile(ENV_PATH),
      gitInfo(),
      probe(LOCAL_BACKEND),
      probe(PROD_ORIGIN),
      probe(PROD_ORIGIN, "/api/config").catch(() => null),
    ]);
    json(res, 200, {
      repo: REPO,
      env: describeEnv(envText, MANAGED),
      git,
      health: { local, prod, agent },
      origins: { prod: PROD_ORIGIN, localApp: LOCAL_APP },
    });
  },

  async "GET /api/users"(_req, res) {
    // Users come from whichever backend is reachable; production first, because
    // that is the one the preview iframe will actually be calling through.
    for (const origin of [PROD_ORIGIN, LOCAL_BACKEND]) {
      const probed = await probe(origin, "/api/users");
      if (probed.ok && Array.isArray(probed.body?.users)) {
        json(res, 200, { origin, users: probed.body.users });
        return;
      }
    }
    json(res, 200, { origin: null, users: [] });
  },

  async "POST /api/env"(req, res) {
    const body = await readBody(req);
    const patch = body?.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      json(res, 400, { error: "нужен объект patch" });
      return;
    }
    for (const name of Object.keys(patch)) {
      if (!MANAGED.includes(name)) {
        json(res, 400, { error: `переменная ${name} не управляется панелью` });
        return;
      }
    }
    const current = await readEnvFile(ENV_PATH);
    const next = patchEnvText(current, patch);
    await writeEnvFile(ENV_PATH, next);
    json(res, 200, {
      env: describeEnv(next, MANAGED),
      // The panel writes the LOCAL env only. Production is deliberately a
      // terminal step, so say so rather than letting the user assume it landed.
      note: "Записано в локальный .env. Продакшн не тронут — он меняется только через терминал.",
      changed: Object.keys(patch).map(name => (isSecretName(name) ? `${name} (секрет)` : name)),
    });
  },

  async "GET /api/docs"(_req, res) {
    json(res, 200, { docs: await listDocs() });
  },

  async "GET /api/doc"(req, res, url) {
    let rel;
    try {
      rel = normalizeRepoMarkdownPath(url.searchParams.get("path") ?? "");
    } catch (err) {
      json(res, 400, { error: String(err.message || err) });
      return;
    }
    const file = resolve(REPO, rel);
    if (!file.startsWith(REPO + sep)) {
      json(res, 400, { error: "путь вне репозитория" });
      return;
    }
    try {
      const markdown = await readFile(file, "utf8");
      // Both copy outputs are produced here, not in the browser: they are the
      // point of the panel, and keeping them server-side means they are covered
      // by panel/test/panel.test.mjs rather than only by clicking.
      const tasks = parseHandoffMarkdown(markdown, rel).map(task => ({
        ...task,
        handoff: formatTaskHandoff(task),
        prompt: formatTaskPrompt(task, { repo: REPO }),
      }));
      json(res, 200, { path: rel, tasks });
    } catch {
      json(res, 404, { error: `не найден: ${rel}` });
    }
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  try {
    if (handler) {
      await handler(req, res, url);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res, url.pathname);
      return;
    }
    json(res, 404, { error: "no route" });
  } catch (err) {
    json(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `\n  Панель разработки SameVoice\n` +
    `  http://${HOST}:${PORT}\n\n` +
    `  репозиторий : ${REPO}\n` +
    `  продакшн    : ${PROD_ORIGIN}\n` +
    `  локальный   : ${LOCAL_APP}\n\n` +
    `  Только 127.0.0.1 — панель пишет в .env и наружу не выставляется.\n\n`,
  );
});
