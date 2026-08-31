import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
// Statically imported where config.ts is not: session.ts reads no environment
// variable, so importing it before `before()` sets them changes nothing.
import { issueSession } from "../src/session.js";

/**
 * Offline smoke test: no LiveKit, no network, no credentials.
 * A throwaway HTTP server stands in for the agent so that "DIRECT never contacts the agent"
 * is asserted by counting real outbound requests, not by trusting a flag.
 */

interface AgentHit {
  method: string;
  url: string;
  key: string | undefined;
  body: unknown;
}

const agentHits: AgentHit[] = [];
let agentServer: Server;
let app: FastifyInstance;
/** Finished calls are written to disk; nothing here may touch the real logs/. */
let archiveDir: string;
/**
 * Profiles, the phone index and contacts are written to disk too — and that
 * file holds real phone numbers, so it gets its own throwaway directory for the
 * same reason the archive does: nothing here may touch the repo's data/.
 */
let identityDir: string;
/**
 * The real Stage-0 test-identity list, read from the store the seed fills.
 * Recognising them by the SHAPE of their id ("looks hand-written") was a third
 * source of truth for the very fact this suite exists to keep single: a phone
 * user's id is `u_` + 16 hex characters, and hex is spelled with letters too,
 * so `u_deadbeefdecaface` reads as "seeded" to any such heuristic and the test
 * then quietly asserts the wrong invariant. Asking the store costs nothing.
 */
let seededIds: readonly string[];

/** Flipped by the verdict tests to make the stand-in agent reject a verdict. */
let verdictStatus = 200;

function startFakeAgent(): Promise<number> {
  return new Promise((resolve, reject) => {
    agentServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: unknown = raw;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          /* keep raw */
        }
        agentHits.push({
          method: req.method ?? "",
          url: req.url ?? "",
          key: req.headers["x-speakeasy-agent-key"] as string | undefined,
          body,
        });
        if (req.url?.endsWith("/stop")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ stopped: true }));
          return;
        }
        if (req.url?.endsWith("/verdict")) {
          res.writeHead(verdictStatus, { "content-type": "application/json" });
          res.end(
            JSON.stringify(
              verdictStatus === 200
                ? { recorded: true, utteranceId: "utt_000007", evalLog: "logs/eval/c_x.jsonl" }
                : { recorded: false, reason: "no_utterance" },
            ),
          );
          return;
        }
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      });
    });
    agentServer.on("error", reject);
    agentServer.listen(0, "127.0.0.1", () => {
      const addr = agentServer.address();
      if (addr === null || typeof addr === "string") return reject(new Error("no port"));
      resolve(addr.port);
    });
  });
}

/**
 * A fixed key so `as()` below and the app under test agree on what a signature
 * means. loadConfig() would otherwise invent a random one per boot, and every
 * token this file mints would be a forgery.
 */
const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789";

/**
 * A real, signed session for `userId`, as a bearer header.
 *
 * Every route that acts on behalf of a user now needs one, so a test that is
 * not ABOUT authorization still has to say whose session it is acting under.
 * It mints the token with the production function and the production secret:
 * there is no test-only bypass in the backend, because a bypass is exactly the
 * hole this whole change closes.
 *
 * The bearer header rather than the cookie because both are accepted and this
 * one needs no cookie jar; the cookie has its own tests.
 */
function as(userId: string): Record<string, string> {
  return { authorization: `Bearer ${issueSession(TEST_SESSION_SECRET, userId, 3600).token}` };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "token must be a 3-segment JWT");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

before(async () => {
  const agentPort = await startFakeAgent();

  // Set before importing config.ts: dotenv never overrides an already-set variable,
  // so these win over any real repo-root .env.
  process.env.LIVEKIT_URL = "ws://127.0.0.1:7880";
  process.env.LIVEKIT_API_KEY = "devkey";
  process.env.LIVEKIT_API_SECRET = "devsecret0000000000000000000000000000000000";
  process.env.AGENT_URL = `http://127.0.0.1:${agentPort}`;
  process.env.AGENT_SHARED_SECRET = "dev-agent-secret";
  process.env.STT_PROVIDER = "mock";
  process.env.MT_PROVIDER = "mock";
  process.env.TTS_PROVIDER = "mock";
  process.env.TOKEN_TTL_SECONDS = "3600";
  process.env.LOG_LEVEL = "silent";
  process.env.RING_TIMEOUT_SECONDS = "45";
  process.env.PRESENCE_TTL_SECONDS = "15";
  process.env.PRESENCE_POLL_MS = "2000";
  archiveDir = mkdtempSync(join(tmpdir(), "speakeasy-archive-"));
  process.env.CALL_ARCHIVE_DIR = archiveDir;
  identityDir = mkdtempSync(join(tmpdir(), "speakeasy-identity-"));
  process.env.IDENTITY_DIR = identityDir;
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  // The phone tests below read the confirmation code out of the response, which
  // is exactly what this switch turns on. Its OFF state — the default — has its
  // own app and its own tests further down, because "the code is NOT in the
  // response" cannot be asserted against a server that puts it there.
  process.env.AUTH_DEV_CODE_IN_RESPONSE = "true";
  // Left at their defaults on purpose: an empty allowlist and no seeded login is
  // what a fresh checkout does, and each is exercised against its own app.
  delete process.env.AUTH_PHONE_ALLOWLIST;
  delete process.env.AUTH_SEEDED_LOGIN;
  delete process.env.SESSION_TTL_SECONDS;
  delete process.env.SESSION_COOKIE_SECURE;
  delete process.env.WEB_ORIGINS;
  delete process.env.ALLOW_LOCAL_ORIGINS;

  const { loadConfig } = await import("../src/config.js");
  const { buildApp } = await import("../src/index.js");
  const { resetStore, stage0TestIdentityIdList } = await import("../src/store.js");
  const { resetPhoneVerification } = await import("../src/phoneVerification.js");
  resetStore();
  // Challenges, verified-phone proofs and the per-number guess budget all live
  // in module state for the life of the process, so a suite that reuses this
  // process inherits whatever a previous run spent.
  resetPhoneVerification();
  seededIds = stage0TestIdentityIdList();
  app = await buildApp(loadConfig());
  await app.ready();
});

after(async () => {
  await app?.close();
  await new Promise<void>((resolve) => agentServer.close(() => resolve()));
  if (archiveDir) rmSync(archiveDir, { recursive: true, force: true });
  if (identityDir) rmSync(identityDir, { recursive: true, force: true });
});

describe("health and config", () => {
  it("GET /healthz reports ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, "backend");
    assert.ok(typeof body.time === "string" && !Number.isNaN(Date.parse(body.time)));
  });

  it("GET /api/config exposes the LiveKit url, providers and topics", async () => {
    const res = await app.inject({ method: "GET", url: "/api/config" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.livekitUrl, "ws://127.0.0.1:7880");
    assert.deepEqual(body.providers, { stt: "mock", mt: "mock", tts: "mock" });
    assert.equal(body.agentIdentity, "agent-relay");
    assert.equal(body.subtitleTopic, "speakeasy.subtitle");
    assert.equal(body.stateTopic, "speakeasy.state");
    assert.deepEqual(body.ring, {
      timeoutSeconds: 45,
      presenceTtlSeconds: 15,
      pollIntervalMs: 2000,
    });
  });

  it("echoes a request id header", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    assert.ok(res.headers["x-request-id"], "x-request-id must be present");
  });
});

describe("development phone verification", () => {
  it("normalizes an Israeli mobile number and returns a six-digit code for the web prototype", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "050-123-4567" },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.json().phone, "+972501234567");
    assert.match(res.json().challengeId, /^pv_[0-9a-f]{24}$/);
    assert.match(res.json().devCode, /^\d{6}$/);
    assert.equal(res.json().expiresInSeconds, 300);
  });

  it("rejects a wrong code, accepts the displayed code once, and rejects replay", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "+972 52 765 4321" },
    });
    const challenge = started.json();
    const wrongCode = challenge.devCode === "000000" ? "999999" : "000000";

    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: challenge.challengeId, code: wrongCode },
    });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error.code, "invalid_code");

    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: challenge.challengeId, code: challenge.devCode },
    });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.json().verified, true);
    assert.equal(verified.json().phone, "+972527654321");
    assert.match(verified.json().registrationToken, /^vr_[0-9a-f]{48}$/);
    assert.equal(verified.json().existingUser, null);

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: challenge.challengeId, code: challenge.devCode },
    });
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.json().error.code, "invalid_challenge");
  });

  it("creates a real profile from a verified number and recognizes it on the next verification", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "054-222-3344" },
    });
    const challenge = started.json();
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: challenge.challengeId, code: challenge.devCode },
    });
    const registrationToken = verified.json().registrationToken as string;

    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        registrationToken,
        displayName: "Давид",
        lang: "ru",
        gender: "m",
      },
    });
    assert.equal(registered.statusCode, 201);
    assert.equal(registered.json().created, true);
    assert.match(registered.json().user.id, /^u_[0-9a-f]{16}$/);
    assert.deepEqual(
      {
        displayName: registered.json().user.displayName,
        lang: registered.json().user.lang,
        gender: registered.json().user.gender,
        tone: registered.json().user.tone,
      },
      { displayName: "Давид", lang: "ru", gender: "m", tone: "friendly" },
    );

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { registrationToken, displayName: "Другой", lang: "he", gender: "f" },
    });
    assert.equal(replay.statusCode, 400);
    assert.equal(replay.json().error.code, "invalid_verification");

    const startedAgain = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "+972542223344" },
    });
    const againChallenge = startedAgain.json();
    const verifiedAgain = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: againChallenge.challengeId, code: againChallenge.devCode },
    });
    assert.equal(verifiedAgain.statusCode, 200);
    assert.equal(verifiedAgain.json().existingUser.id, registered.json().user.id);
    assert.equal(verifiedAgain.json().existingUser.displayName, "Давид");
  });

  it("rejects phone input that cannot be normalized", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "123" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "bad_request");
  });
});

/**
 * Stage-0 auto-join. The founder verified his number against the live server,
 * got a profile, and his contact list came back empty — no test call, no
 * recording, nothing to translate. These tests pin the whole reason the four
 * test identities are handed out, and they die together with the constant
 * STAGE0_AUTO_JOIN_TEST_IDENTITIES once invites exist.
 */
describe("Stage-0 auto-join: a phone user can actually call someone", () => {
  /** The grid a new user must land in, sorted the way contactIdsOf() sorts. */
  const SEEDED_IDS = ["u_alex", "u_maya", "u_noa", "u_omri"];

  /** The three real steps a phone user goes through: start -> verify -> register. */
  async function registerByPhone(
    phone: string,
    profile: { displayName: string; lang: "ru" | "he"; gender: "m" | "f" | "u" },
  ): Promise<{ statusCode: number; created: boolean; userId: string }> {
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone },
    });
    assert.equal(started.statusCode, 201);
    const challenge = started.json();
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: challenge.challengeId, code: challenge.devCode },
    });
    assert.equal(verified.statusCode, 200);
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { registrationToken: verified.json().registrationToken, ...profile },
    });
    return {
      statusCode: registered.statusCode,
      created: registered.json().created as boolean,
      userId: registered.json().user.id as string,
    };
  }

  /** Reads the list through the very route that answered `[]` on the live server. */
  async function contactIdsOf(userId: string): Promise<string[]> {
    const res = await app.inject({ headers: as(userId), method: "GET", url: `/api/users/${userId}/contacts` });
    assert.equal(res.statusCode, 200);
    return (res.json().contacts as Array<{ userId: string }>).map((c) => c.userId).sort();
  }

  it("gives a freshly created phone user exactly the four seeded accounts, and never himself", async () => {
    const { statusCode, created, userId } = await registerByPhone("053-111-2233", {
      displayName: "Женя",
      lang: "ru",
      gender: "m",
    });
    assert.equal(statusCode, 201);
    assert.equal(created, true);

    // Exactly the grid: all four directions reachable, no self-row, and no
    // other phone user swept in — those are strangers, not test identities.
    assert.deepEqual(await contactIdsOf(userId), SEEDED_IDS);
  });

  it("puts the new user into every seeded account's list, so the call works both ways", async () => {
    const { userId } = await registerByPhone("058-777-8899", {
      displayName: "Дина",
      lang: "he",
      gender: "f",
    });

    // A one-way list would let him dial out and never receive: the seeded
    // tester would have nobody to call back and would not see him in presence.
    for (const seededId of SEEDED_IDS) {
      assert.ok(
        (await contactIdsOf(seededId)).includes(userId),
        `${seededId} must be able to call the new user back`,
      );
    }

    // And the card carries the profile the MT prompt inflects Hebrew on.
    const res = await app.inject({ headers: as("u_alex"), method: "GET", url: "/api/users/u_alex/contacts" });
    const card = (res.json().contacts as Array<Record<string, unknown>>).find(
      (c) => c.userId === userId,
    )!;
    assert.equal(card.displayName, "Дина");
    assert.equal(card.lang, "he");
    assert.equal(card.gender, "f");
    assert.equal(card.forceTranslate, false);
    assert.deepEqual(card.overrides, {});
  });

  it("does not duplicate contacts when the same phone registers again", async () => {
    const phone = "052-000-1122";
    const first = await registerByPhone(phone, { displayName: "Игорь", lang: "ru", gender: "m" });
    assert.equal(first.created, true);

    const alexBefore = await contactIdsOf("u_alex");
    const ownBefore = await contactIdsOf(first.userId);
    // Pin the starting point, otherwise "unchanged" would also hold for the
    // empty list this whole fix exists to prevent.
    assert.deepEqual(ownBefore, SEEDED_IDS);

    const second = await registerByPhone(phone, { displayName: "Игорь", lang: "he", gender: "f" });
    assert.equal(second.created, false);
    assert.equal(second.userId, first.userId, "the number identifies the person, not the attempt");

    assert.deepEqual(await contactIdsOf(first.userId), ownBefore);
    assert.deepEqual(await contactIdsOf("u_alex"), alexBefore);
  });

  it("hands the phone user a real contact row, not just a name in a list", async () => {
    const { userId } = await registerByPhone("054-909-0909", {
      displayName: "Рома",
      lang: "ru",
      gender: "m",
    });

    // Pinning a language on the card is how a tester steers a call, and the
    // route 404s when the row behind the card does not exist. A call itself
    // would NOT catch that: the mode decision falls back to the raw profiles
    // when a card is missing, so it answers TRANSLATED either way.
    const patch = await app.inject({
      headers: as(userId),
      method: "PATCH",
      url: `/api/users/${userId}/contacts/u_noa`,
      payload: { lang: "ru" },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.json().contact.lang, "ru");

    const direct = await app.inject({
      headers: as(userId),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: userId, calleeId: "u_noa" },
    });
    assert.equal(direct.statusCode, 201);
    assert.equal(direct.json().call.mode, "DIRECT", "the override on his own card decides the mode");
    await hangUp(direct.json().call.id, userId);

    // Cleared, the real direction comes back — ru -> he, which is the whole
    // reason he was given the grid.
    await app.inject({
      headers: as(userId),
      method: "PATCH",
      url: `/api/users/${userId}/contacts/u_noa`,
      payload: { lang: null },
    });
    const translated = await app.inject({
      headers: as(userId),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: userId, calleeId: "u_noa" },
    });
    assert.equal(translated.json().call.mode, "TRANSLATED");

    // Leave nothing live behind: this file shares one store, and an immortal
    // call is exactly the bug the lifetime tests below exist for.
    await hangUp(translated.json().call.id, userId);
  });

  /**
   * The list of test identities used to be written out by hand next to the seed
   * that creates them. Two sources of truth for one fact: a fifth seeded profile
   * that nobody remembered to add to the list was born with an empty contact
   * list and invisible to everyone else — the exact symptom this whole suite
   * exists to prevent, reintroduced by the fix for it.
   *
   * So the invariant is pinned instead of the literal four ids: whatever the
   * seed creates is fully wired, and it is the same set new phone users join.
   */
  it("wires every seeded profile into the grid, whatever the seed happens to contain", async () => {
    const users = (
      (await app.inject({ method: "GET", url: "/api/users" })).json().users as Array<{
        id: string;
      }>
    ).map((u) => u.id);
    const seeded = [...seededIds];

    assert.ok(seeded.length >= 4, "the seed must still hand out the 2x2 grid");
    assert.deepEqual(
      seeded.filter((id) => !users.includes(id)),
      [],
      "the store lists a test identity that GET /api/users does not serve",
    );

    for (const id of seeded) {
      const peers = await contactIdsOf(id);
      assert.deepEqual(
        seeded.filter((other) => other !== id && !peers.includes(other)),
        [],
        `${id} is missing seeded peers — the seed and the test-identity list have drifted apart`,
      );
    }

    // And a new phone user reaches all of them, not a hand-copied subset.
    const { userId } = await registerByPhone("055-321-6547", {
      displayName: "Лена",
      lang: "ru",
      gender: "f",
    });
    assert.deepEqual(await contactIdsOf(userId), [...seeded].sort());
  });
});

describe("seeded users and contacts", () => {
  it("seeds the Stage-0 testers with gender and tone", async () => {
    const res = await app.inject({ method: "GET", url: "/api/users" });
    assert.equal(res.statusCode, 200);
    const users = res.json().users as Array<Record<string, string>>;
    const alex = users.find((u) => u.id === "u_alex");
    const noa = users.find((u) => u.id === "u_noa");
    assert.deepEqual(alex, {
      id: "u_alex",
      handle: "alex",
      displayName: "Alex",
      lang: "ru",
      gender: "m",
      tone: "neutral",
    });
    assert.deepEqual(noa, {
      id: "u_noa",
      handle: "noa",
      displayName: "Noa",
      lang: "he",
      gender: "f",
      tone: "friendly",
    });
    // Omri exists so that a MALE Hebrew speaker can be tested without patching
    // Noa's gender at runtime: Hebrew inflects on the speaker's gender, that
    // patch reverts on every restart, and her cloned voice is female.
    assert.deepEqual(
      users.find((u) => u.id === "u_omri"),
      {
        id: "u_omri",
        handle: "omri",
        displayName: "Omri",
        lang: "he",
        gender: "m",
        tone: "friendly",
      },
    );
    // Четвёртый угол сетки «пол × язык». Без него выбор «женщина + русский»
    // в клиенте ведёт в никуда.
    assert.deepEqual(
      users.find((u) => u.id === "u_maya"),
      {
        id: "u_maya",
        handle: "maya",
        displayName: "Maya",
        lang: "ru",
        gender: "f",
        tone: "friendly",
      },
    );
  });

  /**
   * THE GRID, AND NOBODY ELSE — the one route left without a session.
   *
   * It stays open because the identity picker reads it before anyone has a
   * session. What it must not stay is `listUsers()`: that answered with the
   * display name, language and gender of every phone-registered person, to
   * anyone who could reach the port. Reproduced on 31.08.2026 against a running
   * backend — `curl -s http://host/api/users` came back naming both registered
   * testers — which is the membership oracle POST /api/contacts/by-phone goes
   * to such trouble to avoid one path segment away, on data that now survives
   * restarts and only grows.
   *
   * Registering here rather than trusting the users other tests left behind:
   * this must fail if the route ever widens again, not depend on execution
   * order to have somebody to leak.
   */
  it("hands an anonymous caller the seeded grid and no phone-registered person", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "058-700-0001" },
    });
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: started.json().challengeId, code: started.json().devCode },
    });
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        registrationToken: verified.json().registrationToken,
        displayName: "Незаметная",
        lang: "he",
        gender: "f",
      },
    });
    assert.equal(registered.statusCode, 201);
    const hiddenId = registered.json().user.id as string;

    const anon = await app.inject({ method: "GET", url: "/api/users" });
    assert.equal(anon.statusCode, 200);
    const body = JSON.stringify(anon.json());
    assert.deepEqual(
      (anon.json().users as Array<{ id: string }>).map((u) => u.id).sort(),
      [...seededIds].sort(),
      "an unauthenticated caller must see the four test identities and no one else",
    );
    assert.ok(!body.includes(hiddenId), "a phone user's id must not be in the public list");
    assert.ok(!body.includes("Незаметная"), "nor their name");

    // And a session does not widen it either: contacts is the route that names
    // real people, and it has an owner check on it.
    const withSession = await app.inject({
      headers: { authorization: `Bearer ${registered.json().session.token}` },
      method: "GET",
      url: "/api/users",
    });
    assert.deepEqual(
      (withSession.json().users as Array<{ id: string }>).map((u) => u.id).sort(),
      [...seededIds].sort(),
    );

    // The client is unaffected: both of its call sites feed this straight into
    // selectSeededIdentities() (web/src/seeded-identities.ts), so the grid is
    // all it has ever read out of this answer.
    assert.ok((await app.inject({
      headers: { authorization: `Bearer ${registered.json().session.token}` },
      method: "GET",
      url: `/api/users/${hiddenId}/contacts`,
    })).statusCode === 200, "real peers still arrive on the route that has a session behind it");
  });

  it("returns the peer's effective language on the contact card", async () => {
    const res = await app.inject({ headers: as("u_alex"), method: "GET", url: "/api/users/u_alex/contacts" });
    assert.equal(res.statusCode, 200);
    const contacts = res.json().contacts as Array<Record<string, unknown>>;
    // Все со всеми: комбинация «пол + язык» из ролевого выбора может дать
    // любую пару, поэтому список контактов не может быть выборочным.
    // Считаем именно посевных: к этому моменту в списке лежат ещё и профили,
    // созданные по номеру телефона выше в этом файле, — они теперь тоже
    // попадают в сетку, иначе новому юзеру звонить некуда.
    const seededPeers = contacts.filter((c) =>
      ["u_noa", "u_omri", "u_maya"].includes(c.userId as string),
    );
    assert.equal(seededPeers.length, 3);
    assert.ok(
      !contacts.some((c) => c.userId === "u_alex"),
      "владелец списка не может быть собственным контактом",
    );
    const noaCard = contacts.find((c) => c.userId === "u_noa")!;
    assert.equal(noaCard.lang, "he");
    assert.equal(noaCard.gender, "f");
    assert.equal(noaCard.forceTranslate, false);
    assert.deepEqual(noaCard.overrides, {});
    // The male Hebrew peer must reach the card as male: this is the value the
    // MT prompt inflects the whole Hebrew side of the call on.
    const omriCard = contacts.find((c) => c.userId === "u_omri")!;
    assert.equal(omriCard.lang, "he");
    assert.equal(omriCard.gender, "m");
  });

  it("answers 403 for an id that is not the session's, existing or not", async () => {
    // Deliberately NOT the 404 this used to be. The ownership check runs before
    // the lookup, so "u_zzz does not exist" and "u_zzz is somebody else" produce
    // the same status — the code stops being an existence oracle for user ids.
    const res = await app.inject({ headers: as("u_alex"), method: "GET", url: "/api/users/u_zzz" });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "forbidden");
  });

  it("rejects a malformed userId with a typed 400", async () => {
    const res = await app.inject({ headers: as("u_alex"), method: "GET", url: "/api/users/NOPE" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "bad_request");
  });
});

describe("call creation and the mode decision", () => {
  it("ru + he yields TRANSLATED and dispatches the agent exactly once", async () => {
    const before = agentHits.length;
    const res = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa", force: false },
    });
    assert.equal(res.statusCode, 201);
    const call = res.json().call;
    assert.equal(call.mode, "TRANSLATED");
    assert.equal(call.reason, "languages_differ");
    assert.equal(call.state, "created");
    assert.equal(call.roomName, `call-${call.id}`);
    assert.match(call.id, /^c_[0-9a-f]{12}$/);
    assert.equal(call.agent.required, true);
    assert.equal(call.agent.dispatched, true);
    assert.equal(call.agent.identity, "agent-relay");
    assert.equal(call.agent.error, null);

    assert.equal(agentHits.length, before + 1, "exactly one outbound agent call");
    const hit = agentHits.at(-1)!;
    assert.equal(hit.method, "POST");
    assert.equal(hit.url, "/jobs");
    assert.equal(hit.key, "dev-agent-secret");
    const job = hit.body as Record<string, unknown>;
    assert.equal(job.callId, call.id);
    assert.equal(job.roomName, call.roomName);
    assert.equal(job.mode, "TRANSLATED");
    assert.equal(job.livekitUrl, "ws://127.0.0.1:7880");
    assert.ok(typeof job.token === "string" && (job.token as string).split(".").length === 3);
    const jobParticipants = job.participants as Array<Record<string, string>>;
    assert.equal(jobParticipants.length, 2);
    assert.deepEqual(
      jobParticipants.map((p) => [p.userId, p.lang, p.gender, p.tone]),
      [
        ["u_alex", "ru", "m", "neutral"],
        ["u_noa", "he", "f", "friendly"],
      ],
    );
    for (const p of jobParticipants) {
      assert.equal(p.role, undefined, "agent job participants carry no caller/callee role");
    }

    const agentClaims = decodeJwtPayload(job.token as string);
    assert.equal(agentClaims.sub, "agent-relay");
    assert.equal((agentClaims.video as Record<string, unknown>).room, call.roomName);
    assert.equal((agentClaims.video as Record<string, unknown>).agent, true);
  });

  it("force:true yields FORCED even when the languages differ", async () => {
    const res = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa", force: true },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().call.mode, "FORCED");
    assert.equal(res.json().call.reason, "forced_by_user");
  });

  it("rejects a self-call with 409 self_call", async () => {
    const res = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_alex" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "self_call");
  });

  it("rejects an unknown participant with 404", async () => {
    const res = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_ghost" },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, "not_found");
  });

  it("ru + ru yields DIRECT and makes NO outbound agent call at all", async () => {
    const patch = await app.inject({
      headers: as("u_noa"),
      method: "PATCH",
      url: "/api/users/u_noa",
      payload: { lang: "ru" },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.json().user.lang, "ru");

    const before = agentHits.length;
    const res = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa", force: false },
    });
    assert.equal(res.statusCode, 201);
    const call = res.json().call;
    assert.equal(call.mode, "DIRECT");
    assert.equal(call.reason, "languages_match");
    assert.deepEqual(call.agent, {
      required: false,
      dispatched: false,
      identity: null,
      error: null,
    });
    assert.equal(agentHits.length, before, "DIRECT must not contact the agent");

    // restore the seeded Hebrew profile for the remaining tests
    await app.inject({ headers: as("u_noa"), method: "PATCH", url: "/api/users/u_noa", payload: { lang: "he" } });
  });

  it("a contact-level forceTranslate override alone produces FORCED", async () => {
    const patch = await app.inject({
      headers: as("u_noa"),
      method: "PATCH",
      url: "/api/users/u_noa/contacts/u_alex",
      payload: { forceTranslate: true },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.json().contact.forceTranslate, true);

    const res = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    assert.equal(res.json().call.mode, "FORCED");

    await app.inject({
      headers: as("u_noa"),
      method: "PATCH",
      url: "/api/users/u_noa/contacts/u_alex",
      payload: { forceTranslate: false },
    });
  });
});

describe("join", () => {
  it("mints a decodable JWT scoped to the call room", async () => {
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const call = created.json().call;

    const res = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${call.id}/join`,
      payload: { userId: "u_alex" },
    });
    assert.equal(res.statusCode, 200);
    const join = res.json();

    assert.equal(join.callId, call.id);
    assert.equal(join.roomName, `call-${call.id}`);
    assert.equal(join.mode, "TRANSLATED");
    assert.equal(join.livekitUrl, "ws://127.0.0.1:7880");
    assert.equal(join.agentIdentity, "agent-relay");
    assert.equal(join.expectedAgentTrackName, "tx-u_alex");
    assert.equal(join.ttlSeconds, 3600);
    assert.deepEqual(join.self, {
      userId: "u_alex",
      displayName: "Alex",
      lang: "ru",
      gender: "m",
      tone: "neutral",
    });
    assert.deepEqual(join.peer, {
      userId: "u_noa",
      displayName: "Noa",
      lang: "he",
      gender: "f",
      tone: "friendly",
    });

    const claims = decodeJwtPayload(join.token);
    assert.equal(claims.sub, "u_alex", "identity must be the userId, never a random uuid");
    assert.equal(claims.name, "Alex");
    const video = claims.video as Record<string, unknown>;
    assert.equal(video.room, `call-${call.id}`);
    assert.equal(video.roomJoin, true);
    assert.equal(video.canPublish, true);
    assert.equal(video.canSubscribe, true);
    assert.equal(video.canPublishData, true);
    const attrs = claims.attributes as Record<string, string>;
    assert.equal(attrs.lang, "ru");
    assert.equal(attrs.gender, "m");
    assert.equal(attrs.tone, "neutral");
    assert.equal(attrs.role, "human");

    const state = await app.inject({ method: "GET", url: `/api/calls/${call.id}` });
    assert.equal(state.json().call.state, "active");
  });

  it("a DIRECT join advertises no agent", async () => {
    await app.inject({ headers: as("u_noa"), method: "PATCH", url: "/api/users/u_noa", payload: { lang: "ru" } });
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const call = created.json().call;
    const res = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${call.id}/join`,
      payload: { userId: "u_noa" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().mode, "DIRECT");
    assert.equal(res.json().agentIdentity, null);
    assert.equal(res.json().expectedAgentTrackName, null);
    await app.inject({ headers: as("u_noa"), method: "PATCH", url: "/api/users/u_noa", payload: { lang: "he" } });
  });

  it("refuses a non-participant with 403", async () => {
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const call = created.json().call;
    // Maya is a real user with a real session who is simply not on this call.
    // "u_someone" used to stand here, and it stopped being a useful stranger the
    // moment a session had to name a user the store actually has.
    const res = await app.inject({
      headers: as("u_maya"),
      method: "POST",
      url: `/api/calls/${call.id}/join`,
      payload: { userId: "u_maya" },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "forbidden");
  });

  it("returns 404 for an unknown call", async () => {
    const res = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls/c_000000000000/join",
      payload: { userId: "u_alex" },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, "not_found");
  });
});

describe("mode change and end", () => {
  it("returns 409 mode_locked once someone has joined", async () => {
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const call = created.json().call;

    const beforeJoin = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${call.id}/mode`,
      payload: { userId: "u_alex", force: true },
    });
    assert.equal(beforeJoin.statusCode, 200);
    assert.equal(beforeJoin.json().call.mode, "FORCED");

    await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${call.id}/join`,
      payload: { userId: "u_alex" },
    });

    const afterJoin = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${call.id}/mode`,
      payload: { userId: "u_alex", force: false },
    });
    assert.equal(afterJoin.statusCode, 409);
    assert.equal(afterJoin.json().error.code, "mode_locked");
  });

  it("ends a call, stops the agent and then refuses further joins", async () => {
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const call = created.json().call;
    const before = agentHits.length;

    const ended = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${call.id}/end`,
      payload: { userId: "u_alex" },
    });
    assert.equal(ended.statusCode, 200);
    assert.equal(ended.json().call.state, "ended");
    assert.ok(ended.json().call.endedAt);

    assert.equal(agentHits.length, before + 1);
    assert.equal(agentHits.at(-1)!.url, `/jobs/${call.id}/stop`);

    const rejoin = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${call.id}/join`,
      payload: { userId: "u_alex" },
    });
    assert.equal(rejoin.statusCode, 409);
    assert.equal(rejoin.json().error.code, "conflict");
  });
});

// ---------------------------------------------------------------------------
// Presence + ringing
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ringCall(
  extra: Record<string, unknown> = {},
): Promise<{ id: string; ring: Record<string, unknown> }> {
  const res = await app.inject({
    headers: as("u_alex"),
    method: "POST",
    url: "/api/calls",
    payload: { callerId: "u_alex", calleeId: "u_noa", ring: true, ...extra },
  });
  assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
  return { id: res.json().call.id, ring: res.json().ring };
}

async function poll(userId: string): Promise<Record<string, any>> {
  const res = await app.inject({ headers: as(userId), method: "POST", url: "/api/presence", payload: { userId } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  return res.json();
}

/** Leaves no live ring behind, so the next test's busy check starts clean. */
async function hangUp(callId: string, userId = "u_alex"): Promise<void> {
  await app.inject({ headers: as(userId), method: "POST", url: `/api/calls/${callId}/end`, payload: { userId } });
}

describe("presence", () => {
  it("a heartbeat marks the user online and reports contact presence", async () => {
    const alex = await poll("u_alex");
    assert.equal(alex.self.userId, "u_alex");
    assert.equal(alex.self.online, true);
    assert.equal(alex.self.ttlSeconds, 15);
    assert.ok(typeof alex.self.lastSeenAt === "string");
    assert.equal(alex.pollIntervalMs, 2000);
    assert.equal(alex.incoming, null);

    // Noa's presence is visible to Alex only after she heartbeats.
    const peerBefore = alex.peers.find((p: any) => p.userId === "u_noa");
    assert.ok(peerBefore, "the contact must appear in peers even when offline");
    await poll("u_noa");
    const after = await poll("u_alex");
    assert.equal(after.peers.find((p: any) => p.userId === "u_noa").online, true);
  });

  it("online:false is an explicit goodbye", async () => {
    await poll("u_noa");
    const bye = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: "/api/presence",
      payload: { userId: "u_noa", online: false },
    });
    assert.equal(bye.statusCode, 200);
    assert.equal(bye.json().self.online, false);
    assert.equal(bye.json().self.lastSeenAt, null);
  });

  it("GET /api/ring/:userId returns the same shape without heartbeating", async () => {
    await app.inject({ headers: as("u_alex"), method: "POST", url: "/api/presence", payload: { userId: "u_alex", online: false } });
    const res = await app.inject({ headers: as("u_alex"), method: "GET", url: "/api/ring/u_alex" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().self.online, false, "a read must not mark the user online");
    assert.equal(res.json().incoming, null);
    assert.equal(res.json().outgoing, null);
  });

  it("refuses somebody else's userId and a malformed body", async () => {
    // This request is both the heartbeat and the ring poll, so an unchecked
    // userId here handed a stranger the callee's incoming calls — the caller's
    // name included — twice a second.
    const other = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/presence",
      payload: { userId: "u_noa" },
    });
    assert.equal(other.statusCode, 403);
    assert.equal(other.json().error.code, "forbidden");

    const bad = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/presence",
      payload: { userId: "u_alex", nope: 1 },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, "bad_request");

    const badPath = await app.inject({ headers: as("u_alex"), method: "GET", url: "/api/ring/NOPE" });
    assert.equal(badPath.statusCode, 400);
  });
});

describe("ringing state machine", () => {
  it("ring:true makes the call discoverable by the callee and answerable", async () => {
    const { id, ring } = await ringCall();
    assert.equal(ring.ringState, "ringing");
    assert.equal(ring.from.displayName, "Alex");
    assert.equal(ring.from.userId, "u_alex");
    assert.equal(ring.to.userId, "u_noa");
    assert.equal(ring.mode, "TRANSLATED");
    assert.ok((ring.secondsRemaining as number) > 40);

    const callee = await poll("u_noa");
    assert.equal(callee.incoming.callId, id);
    assert.equal(callee.incoming.ringState, "ringing");
    assert.equal(callee.incoming.from.displayName, "Alex");
    assert.equal(callee.outgoing, null);

    const caller = await poll("u_alex");
    assert.equal(caller.outgoing.callId, id);
    assert.equal(caller.incoming, null);

    const accept = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_noa" },
    });
    assert.equal(accept.statusCode, 200);
    assert.equal(accept.json().ring.ringState, "accepted");
    assert.equal(accept.json().alreadyAccepted, false);
    assert.equal(accept.json().call.state, "created", "accept does not join; /join still does that");

    // The callee stops being rung; the caller learns it was answered.
    assert.equal((await poll("u_noa")).incoming, null);
    assert.equal((await poll("u_alex")).outgoing.ringState, "accepted");

    const join = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/join`,
      payload: { userId: "u_noa" },
    });
    assert.equal(join.statusCode, 200);
    assert.equal(join.json().mode, "TRANSLATED");
    await hangUp(id);
  });

  it("a second accept is idempotent, not an error", async () => {
    const { id } = await ringCall();
    const first = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_noa" },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().alreadyAccepted, false);

    const second = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_noa" },
    });
    assert.equal(second.statusCode, 200, "a double accept must not tell the callee the call is gone");
    assert.equal(second.json().alreadyAccepted, true);
    assert.equal(second.json().ring.ringState, "accepted");
    await hangUp(id);
  });

  it("only the callee may accept or decline, only the caller may cancel", async () => {
    const { id } = await ringCall();
    const callerAccept = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_alex" },
    });
    assert.equal(callerAccept.statusCode, 403);
    assert.equal(callerAccept.json().error.code, "forbidden");

    const calleeCancel = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/cancel`,
      payload: { userId: "u_noa" },
    });
    assert.equal(calleeCancel.statusCode, 403);

    const stranger = await app.inject({
      headers: as("u_maya"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_maya" },
    });
    assert.equal(stranger.statusCode, 403);
    await hangUp(id);
  });

  it("declining ends the call and stops the agent", async () => {
    const { id } = await ringCall();
    const before = agentHits.length;

    const declined = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/decline`,
      payload: { userId: "u_noa" },
    });
    assert.equal(declined.statusCode, 200);
    assert.equal(declined.json().ring.ringState, "declined");
    assert.equal(declined.json().call.state, "ended");
    assert.ok(declined.json().call.endedAt);

    assert.equal(agentHits.length, before + 1, "a declined ring must stop the dispatched agent");
    assert.equal(agentHits.at(-1)!.url, `/jobs/${id}/stop`);

    // The caller still sees WHY it stopped (grace window), the callee no longer rings.
    assert.equal((await poll("u_alex")).outgoing.ringState, "declined");
    assert.equal((await poll("u_noa")).incoming, null);

    // Accepting after a decline is a conflict, not a resurrection.
    const late = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_noa" },
    });
    assert.equal(late.statusCode, 409);
    assert.equal(late.json().error.code, "ring_conflict");

    // A repeated decline is idempotent and does NOT stop the agent twice.
    const again = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/decline`,
      payload: { userId: "u_noa" },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(agentHits.length, before + 1);
  });

  it("the caller hanging up while ringing cancels the ring and stops the agent", async () => {
    const { id } = await ringCall();
    const before = agentHits.length;

    // /end and /ring/cancel are the same transition; the tester's hang-up button
    // must not leave the agent in the room just because the call never connected.
    const ended = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${id}/end`,
      payload: { userId: "u_alex" },
    });
    assert.equal(ended.statusCode, 200);
    assert.equal(ended.json().ring.ringState, "cancelled");
    assert.equal(ended.json().call.state, "ended");
    assert.equal(agentHits.length, before + 1);
    assert.equal(agentHits.at(-1)!.url, `/jobs/${id}/stop`);

    // The callee, still polling with a stale screen, must be told to stop ringing.
    assert.equal((await poll("u_noa")).incoming, null);
    const late = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_noa" },
    });
    assert.equal(late.statusCode, 409);
    assert.equal(late.json().error.code, "ring_conflict");

    // And a join on the cancelled call explains itself.
    const join = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/join`,
      payload: { userId: "u_noa" },
    });
    assert.equal(join.statusCode, 409);
    assert.match(join.json().error.message, /cancelled/);
  });

  it("hanging up a call that was actually answered does NOT relabel it as cancelled", async () => {
    const { id } = await ringCall();
    const accepted = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_noa" },
    });
    const answeredAt = accepted.json().call.ring.respondedAt as string;
    assert.ok(answeredAt);

    // Both sides join: the call is now live, and the ring is history.
    await app.inject({ headers: as("u_noa"), method: "POST", url: `/api/calls/${id}/join`, payload: { userId: "u_noa" } });
    await app.inject({ headers: as("u_alex"), method: "POST", url: `/api/calls/${id}/join`, payload: { userId: "u_alex" } });

    const before = agentHits.length;
    const ended = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${id}/end`,
      payload: { userId: "u_alex" },
    });
    assert.equal(ended.statusCode, 200);
    assert.equal(ended.json().call.state, "ended");

    // The ring must still say the call was ANSWERED. Relabelling it
    // cancelled/declined would make a completed call indistinguishable from a
    // refused one, and would overwrite the accept timestamp with the hang-up.
    assert.equal(ended.json().call.ring.state, "accepted");
    assert.equal(ended.json().call.ring.respondedAt, answeredAt);
    assert.equal(agentHits.length, before + 1, "a normal hang-up still stops the agent");
    assert.equal(agentHits.at(-1)!.url, `/jobs/${id}/stop`);

    // The caller must not be shown a terminal ring epitaph for a call they
    // just successfully completed. (Other tests leave their own cancelled rings
    // inside the grace window, so assert about THIS call, not about emptiness.)
    const outgoing = (await poll("u_alex")).outgoing;
    assert.notEqual(
      outgoing?.callId,
      id,
      "a completed call must not come back as an outgoing ring result",
    );

    // /end is idempotent: a double-click must not fire a second stop.
    const twice = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${id}/end`,
      payload: { userId: "u_alex" },
    });
    assert.equal(twice.statusCode, 200);
    assert.equal(twice.json().call.agent.dispatched, false);
    assert.equal(agentHits.length, before + 1, "the second hang-up must not stop the agent again");
  });

  it("POST /ring/cancel does the same thing explicitly", async () => {
    const { id } = await ringCall();
    const before = agentHits.length;
    const res = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${id}/ring/cancel`,
      payload: { userId: "u_alex" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ring.ringState, "cancelled");
    assert.equal(res.json().call.state, "ended");
    assert.equal(agentHits.length, before + 1);
  });

  it("an unanswered ring times out on its own, ends the call and stops the agent", async () => {
    const { id } = await ringCall({ ringTimeoutSeconds: 1 });
    const before = agentHits.length;

    await sleep(1150);

    // A poll is enough: expiry is enforced lazily on every ring-facing request,
    // so a callee can never accept a ring that should already be dead.
    const callee = await poll("u_noa");
    assert.equal(callee.incoming, null);

    const state = await app.inject({ method: "GET", url: `/api/calls/${id}` });
    assert.equal(state.json().call.state, "ended");
    assert.equal(state.json().call.ring.state, "timeout");
    assert.equal(agentHits.length, before + 1, "the timed-out ring must stop the agent exactly once");
    assert.equal(agentHits.at(-1)!.url, `/jobs/${id}/stop`);

    const late = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_noa" },
    });
    assert.equal(late.statusCode, 409);
    assert.equal(late.json().error.code, "ring_conflict");
  });

  it("an accepted ring that nobody joins also expires rather than stranding the agent", async () => {
    const { id } = await ringCall({ ringTimeoutSeconds: 1 });
    const accept = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_noa" },
    });
    assert.equal(accept.statusCode, 200);
    const before = agentHits.length;

    await sleep(1150);
    await poll("u_alex");

    const state = await app.inject({ method: "GET", url: `/api/calls/${id}` });
    assert.equal(state.json().call.state, "ended");
    assert.equal(state.json().call.ring.state, "timeout");
    assert.equal(agentHits.length, before + 1);
  });

  it("a callee who joins a still-ringing call has answered it", async () => {
    const { id } = await ringCall();
    const join = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/join`,
      payload: { userId: "u_noa" },
    });
    assert.equal(join.statusCode, 200);

    const state = await app.inject({ method: "GET", url: `/api/calls/${id}` });
    assert.equal(state.json().call.ring.state, "accepted");
    assert.equal(state.json().call.state, "active");
    assert.equal((await poll("u_noa")).incoming, null);
    await hangUp(id);
  });

  it("a live ring makes both parties busy, and the busy flag clears when it ends", async () => {
    const { id } = await ringCall();
    for (const payload of [
      { callerId: "u_alex", calleeId: "u_noa", ring: true },
      { callerId: "u_noa", calleeId: "u_alex", ring: true },
    ]) {
      const dup = await app.inject({ headers: as(payload.callerId), method: "POST", url: "/api/calls", payload });
      assert.equal(dup.statusCode, 409, "a double-dial must not create a second ring");
      assert.equal(dup.json().error.code, "busy");
    }

    // A link-invite call is unaffected: busy only guards the ring flow.
    const link = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    assert.equal(link.statusCode, 201);
    assert.equal(link.json().call.ring, null);
    assert.equal(link.json().ring, null);

    await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/decline`,
      payload: { userId: "u_noa" },
    });
    const retry = await ringCall();
    assert.ok(retry.id);
    await hangUp(retry.id);
  });

  it("a busy ring that has already timed out does not block the retry", async () => {
    const stale = await ringCall({ ringTimeoutSeconds: 1 });
    await sleep(1150);
    const retry = await ringCall();
    assert.notEqual(retry.id, stale.id);
    await hangUp(retry.id);
  });

  it("a DIRECT call can ring, and declining it contacts no agent at all", async () => {
    await app.inject({ headers: as("u_noa"), method: "PATCH", url: "/api/users/u_noa", payload: { lang: "ru" } });
    const { id, ring } = await ringCall();
    assert.equal(ring.mode, "DIRECT");
    const before = agentHits.length;

    const declined = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/decline`,
      payload: { userId: "u_noa" },
    });
    assert.equal(declined.statusCode, 200);
    assert.equal(declined.json().ring.ringState, "declined");
    assert.equal(agentHits.length, before, "DIRECT never contacts the agent, not even to stop it");

    await app.inject({ headers: as("u_noa"), method: "PATCH", url: "/api/users/u_noa", payload: { lang: "he" } });
  });

  it("ring endpoints refuse a link-invite call and an unknown call", async () => {
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const id = created.json().call.id;
    const res = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/ring/accept`,
      payload: { userId: "u_noa" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "ring_conflict");
    assert.match(res.json().error.message, /without a ring/);

    const missing = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: "/api/calls/c_000000000000/ring/decline",
      payload: { userId: "u_noa" },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "not_found");
  });
});

// ---------------------------------------------------------------------------
// Call lifetime
// ---------------------------------------------------------------------------

/**
 * Regression cover for 25.08.2026: c_f74783a70042 was created at 17:48 the day
 * before and was STILL live the next morning, because nothing in an in-memory
 * store ever expires. The caller's client kept finding that call and re-joining
 * it while the other tester created fresh ones, so the two of them were never
 * in the same LiveKit room and neither heard a word — with a translation
 * pipeline that was working perfectly.
 *
 * Time is passed in rather than slept through: these bounds are minutes and
 * hours, and a test that waits them out is a test nobody runs.
 */
describe("call lifetime", () => {
  async function lifetime() {
    const { loadConfig } = await import("../src/config.js");
    const ringing = await import("../src/ringing.js");
    const store = await import("../src/store.js");
    return { cfg: loadConfig(), ...ringing, ...store };
  }

  async function linkCall(): Promise<string> {
    const res = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.json()));
    return res.json().call.id;
  }

  it("a call left idle is ended, releases its agent, and is no longer joinable", async () => {
    const { cfg, reapDeadCalls, CALL_LIFETIME_LIMITS } = await lifetime();
    const id = await linkCall();
    const before = agentHits.length;

    // Just short of the bound: still a perfectly good invite link.
    const nowMs = Date.now();
    await reapDeadCalls(cfg, nowMs + CALL_LIFETIME_LIMITS.idleMs - 1000);
    const early = await app.inject({ method: "GET", url: `/api/calls/${id}` });
    assert.equal(early.json().call.state, "created");

    const reaped = await reapDeadCalls(cfg, nowMs + CALL_LIFETIME_LIMITS.idleMs + 1000);
    assert.ok(
      reaped.some((c) => c.id === id),
      "the idle call must be reaped",
    );

    const state = await app.inject({ method: "GET", url: `/api/calls/${id}` });
    assert.equal(state.json().call.state, "ended");
    assert.ok(state.json().call.endedAt, "an ended call must carry the time it ended");
    const stops = agentHits.slice(before).filter((h) => h.url === `/jobs/${id}/stop`);
    assert.equal(stops.length, 1, "the idle call must release its agent exactly once");

    const join = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${id}/join`,
      payload: { userId: "u_alex" },
    });
    assert.equal(join.statusCode, 409, "the client must be told the stale call is gone, not let in");
    assert.equal(join.json().error.code, "conflict");
  });

  it("joining resets the idle clock; only the max lifetime ends a joined call", async () => {
    const { cfg, reapDeadCalls, CALL_LIFETIME_LIMITS } = await lifetime();
    const id = await linkCall();
    const joined = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: `/api/calls/${id}/join`,
      payload: { userId: "u_alex" },
    });
    assert.equal(joined.statusCode, 200);

    // Two people can talk for an hour without making a single request; a call
    // somebody is IN must never be reaped for being quiet.
    const nowMs = Date.now();
    await reapDeadCalls(cfg, nowMs + CALL_LIFETIME_LIMITS.idleMs * 2);
    const live = await app.inject({ method: "GET", url: `/api/calls/${id}` });
    assert.equal(live.json().call.state, "active");

    // But a tab closed without hanging up leaves no trace at all, so there is a
    // ceiling: nothing may be live forever.
    await reapDeadCalls(cfg, nowMs + CALL_LIFETIME_LIMITS.maxLifetimeMs + 1000);
    const dead = await app.inject({ method: "GET", url: `/api/calls/${id}` });
    assert.equal(dead.json().call.state, "ended");
  });

  it("a live ring is left to its own deadline, not reaped by the lifetime bounds", async () => {
    const { cfg, reapDeadCalls, CALL_LIFETIME_LIMITS } = await lifetime();
    const { id } = await ringCall();

    // Far past every lifetime bound: the ring deadline is much shorter and owns
    // this call, and two mechanisms racing to end the same call is how an agent
    // gets stopped twice.
    const reaped = await reapDeadCalls(cfg, Date.now() + CALL_LIFETIME_LIMITS.maxLifetimeMs * 2);
    assert.equal(
      reaped.some((c) => c.id === id),
      false,
    );
    const state = await app.inject({ method: "GET", url: `/api/calls/${id}` });
    assert.equal(state.json().call.state, "created");
    assert.equal(state.json().call.ring.state, "ringing");
    await hangUp(id);
  });

  it("an ended call moves to the archive instead of being thrown away", async () => {
    const { archivableCalls, forgetCalls, callCounts, CALL_ARCHIVE_LIMITS } = await lifetime();
    const archive = app.callArchive;
    const id = await linkCall();
    await hangUp(id);

    // Inside the window the record is still on the ordinary call route, so a
    // client that lost the race can still be told WHY its call ended.
    const nowMs = Date.now();
    assert.deepEqual(archivableCalls(nowMs, CALL_ARCHIVE_LIMITS), []);
    const fresh = await app.inject({ method: "GET", url: `/api/calls/${id}` });
    assert.equal(fresh.statusCode, 200);
    assert.equal(fresh.json().call.state, "ended");

    const due = archivableCalls(nowMs + CALL_ARCHIVE_LIMITS.archiveAfterMs + 1000, CALL_ARCHIVE_LIMITS);
    assert.ok(
      due.some((c) => c.id === id),
      "an ended call past its window belongs in the archive",
    );
    const liveIds = due.filter((c) => c.state !== "ended").map((c) => c.id);
    assert.deepEqual(liveIds, [], "a live call must never be archived out from under two people");

    const stored: string[] = [];
    for (const call of due) if (await archive.put(call)) stored.push(call.id);
    forgetCalls(stored);

    // Gone from memory...
    const inMemory = await app.inject({ method: "GET", url: `/api/calls/${id}` });
    assert.equal(inMemory.statusCode, 404);
    assert.equal(callCounts().ended, 0);

    // ...and readable from the archive by BOTH people who were on the call.
    for (const userId of ["u_alex", "u_noa"]) {
      const res = await app.inject({ headers: as(userId), method: "GET", url: `/api/users/${userId}/calls/${id}` });
      assert.equal(res.statusCode, 200, `${userId} was on this call`);
      assert.equal(res.json().call.id, id);
      assert.equal(res.json().call.state, "ended");
      assert.ok(res.json().archivedAt, "the record records when it left memory");
    }

    const listed = await app.inject({ headers: as("u_alex"), method: "GET", url: "/api/users/u_alex/calls" });
    assert.equal(listed.statusCode, 200);
    const entry = listed.json().calls.find((c: any) => c.callId === id);
    assert.ok(entry, "an archived call must show up in its participants' listing");
    assert.deepEqual(
      entry.participants.map((p: any) => p.userId).sort(),
      ["u_alex", "u_noa"],
    );
  });

  it("an archived call is readable only by the two people who were on it", async () => {
    const { archivableCalls, forgetCalls, CALL_ARCHIVE_LIMITS } = await lifetime();
    const archive = app.callArchive;
    const id = await linkCall();
    await hangUp(id);

    const due = archivableCalls(Date.now() + CALL_ARCHIVE_LIMITS.archiveAfterMs + 1000, CALL_ARCHIVE_LIMITS);
    const stored: string[] = [];
    for (const call of due) if (await archive.put(call)) stored.push(call.id);
    forgetCalls(stored);

    // Omri is a real user and was on no such call. He is told the record does
    // not exist, NOT that he may not see it: a 403 would confirm it exists.
    const stranger = await app.inject({ headers: as("u_omri"), method: "GET", url: `/api/users/u_omri/calls/${id}` });
    assert.equal(stranger.statusCode, 404);
    assert.equal(stranger.json().error.code, "not_found");
    assert.deepEqual((await app.inject({ headers: as("u_omri"), method: "GET", url: "/api/users/u_omri/calls" })).json().calls, []);

    // A correctly signed token naming a user the store does not have is not a
    // session at all. That is not a contrived case: the store is in memory, so
    // it is what every browser holds after a restart, and it must land on the
    // login screen rather than one status code away from the archive.
    const ghost = await app.inject({
      headers: as("u_nobody"),
      method: "GET",
      url: `/api/users/u_nobody/calls/${id}`,
    });
    assert.equal(ghost.statusCode, 401, "an unknown user is not a way to browse the archive");
  });

  it("the archive survives a restart, because it is on disk and not in the map", async () => {
    const { createCallArchive } = await import("../src/archive.js");
    const { archivableCalls, forgetCalls, CALL_ARCHIVE_LIMITS } = await lifetime();
    const id = await linkCall();
    await hangUp(id);

    const due = archivableCalls(Date.now() + CALL_ARCHIVE_LIMITS.archiveAfterMs + 1000, CALL_ARCHIVE_LIMITS);
    const stored: string[] = [];
    for (const call of due) if (await app.callArchive.put(call)) stored.push(call.id);
    forgetCalls(stored);

    // A fresh process reading the same directory: this is the whole point of
    // not keeping the archive in a second Map. Restarting the backend is what
    // cleared the stale call on 25.08.2026, and it must not clear the record.
    const reopened = createCallArchive(archiveDir);
    await reopened.load();
    const record = await reopened.get(id, "u_alex");
    assert.ok(record, "an archived call must outlive the process that wrote it");
    assert.equal(record.call.id, id);
    assert.equal(await reopened.get(id, "u_omri"), undefined);
  });

  it("the live map has a hard ceiling even before the window is up", async () => {
    const { archivableCalls, forgetCalls, callCounts } = await lifetime();
    const liveId = await linkCall();
    for (let i = 0; i < 3; i += 1) await hangUp(await linkCall());

    // Nothing is due yet by time, but the map is over its ceiling, so the
    // oldest ended calls leave early. They are still archived, not dropped.
    const due = archivableCalls(Date.now(), { archiveAfterMs: 60 * 60_000, maxCalls: 1 });
    assert.ok(due.length >= 3, "the ceiling must move ended calls out ahead of their window");
    assert.equal(
      due.some((c) => c.id === liveId),
      false,
      "and it must stop at the live ones",
    );
    for (const call of due) assert.ok(await app.callArchive.put(call));
    forgetCalls(due.map((c) => c.id));
    assert.ok(callCounts().live >= 1);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.deepEqual(health.json().calls, callCounts());
    await hangUp(liveId);
  });
});

// ---------------------------------------------------------------------------
// Judge verdict
// ---------------------------------------------------------------------------

describe("judge verdict", () => {
  it("forwards a WRONG verdict to the agent with the shared secret and returns its answer", async () => {
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const id = created.json().call.id;
    const before = agentHits.length;

    const res = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/verdict`,
      payload: {
        userId: "u_noa",
        verdict: "wrong",
        expected: "אני הולכת הביתה",
        note: "masculine verb for a female speaker",
      },
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
    assert.equal(res.json().ok, true);
    assert.equal(res.json().callId, id);
    assert.equal(res.json().verdict, "wrong");
    assert.equal(res.json().agent.utteranceId, "utt_000007");

    assert.equal(agentHits.length, before + 1);
    const hit = agentHits.at(-1)!;
    assert.equal(hit.method, "POST");
    assert.equal(hit.url, `/jobs/${id}/verdict`);
    assert.equal(hit.key, "dev-agent-secret");
    const sent = hit.body as Record<string, unknown>;
    assert.equal(sent.callId, id);
    assert.equal(sent.userId, "u_noa");
    assert.equal(sent.verdict, "wrong");
    assert.equal(sent.utteranceId, null, "omitting the id means 'the most recent utterance'");
    assert.equal(sent.expected, "אני הולכת הביתה");
    assert.equal(sent.note, "masculine verb for a female speaker");
    assert.ok(typeof sent.receivedAt === "string" && !Number.isNaN(Date.parse(sent.receivedAt as string)));
    await hangUp(id);
  });

  it("passes an explicit utteranceId through unchanged", async () => {
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const id = created.json().call.id;
    const res = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/verdict`,
      payload: { userId: "u_noa", utteranceId: "u_he_ru_000012" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().verdict, "wrong", "verdict defaults to wrong — the one-click case");
    assert.equal((agentHits.at(-1)!.body as Record<string, unknown>).utteranceId, "u_he_ru_000012");
    await hangUp(id);
  });

  it("refuses a non-participant, an unknown call and a malformed body", async () => {
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const id = created.json().call.id;

    const stranger = await app.inject({
      headers: as("u_maya"),
      method: "POST",
      url: `/api/calls/${id}/verdict`,
      payload: { userId: "u_maya" },
    });
    assert.equal(stranger.statusCode, 403);
    assert.equal(stranger.json().error.code, "forbidden");

    const missing = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: "/api/calls/c_000000000000/verdict",
      payload: { userId: "u_noa" },
    });
    assert.equal(missing.statusCode, 404);

    const bad = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/verdict`,
      payload: { userId: "u_noa", verdict: "maybe" },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, "bad_request");
    await hangUp(id);
  });

  it("a DIRECT call has nothing to judge and contacts no agent", async () => {
    await app.inject({ headers: as("u_noa"), method: "PATCH", url: "/api/users/u_noa", payload: { lang: "ru" } });
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const id = created.json().call.id;
    const before = agentHits.length;

    const res = await app.inject({
      headers: as("u_noa"),
      method: "POST",
      url: `/api/calls/${id}/verdict`,
      payload: { userId: "u_noa" },
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "no_agent");
    assert.match(res.json().error.message, /DIRECT/);
    assert.equal(agentHits.length, before, "no agent exists for a DIRECT call — do not call one");

    await app.inject({ headers: as("u_noa"), method: "PATCH", url: "/api/users/u_noa", payload: { lang: "he" } });
  });

  it("surfaces an agent 404 as a 404 instead of pretending the label landed", async () => {
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    const id = created.json().call.id;
    verdictStatus = 404;
    try {
      const res = await app.inject({
        headers: as("u_noa"),
        method: "POST",
        url: `/api/calls/${id}/verdict`,
        payload: { userId: "u_noa" },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error.code, "not_found");
      assert.match(res.json().error.message, /no eval log/);
    } finally {
      verdictStatus = 200;
    }
    await hangUp(id);
  });

  it("reports 502 when the agent cannot be reached", async () => {
    const { loadConfig } = await import("../src/config.js");
    const { buildApp } = await import("../src/index.js");
    // A port nothing listens on: the verdict must fail loudly, not silently succeed.
    const offline = await buildApp({ ...loadConfig(), agentUrl: "http://127.0.0.1:9" });
    await offline.ready();
    try {
      const created = await app.inject({
        headers: as("u_alex"),
        method: "POST",
        url: "/api/calls",
        payload: { callerId: "u_alex", calleeId: "u_noa" },
      });
      const id = created.json().call.id;
      const res = await offline.inject({
        headers: as("u_noa"),
        method: "POST",
        url: `/api/calls/${id}/verdict`,
        payload: { userId: "u_noa" },
      });
      assert.equal(res.statusCode, 502);
      assert.equal(res.json().error.code, "agent_unreachable");
      await hangUp(id);
    } finally {
      await offline.close();
    }
  });

  it("a dispatch failure blocks the verdict with a clear reason, not a crash", async () => {
    const { loadConfig } = await import("../src/config.js");
    const { buildApp } = await import("../src/index.js");
    const offline = await buildApp({ ...loadConfig(), agentUrl: "http://127.0.0.1:9" });
    await offline.ready();
    try {
      const created = await offline.inject({
        headers: as("u_alex"),
        method: "POST",
        url: "/api/calls",
        payload: { callerId: "u_alex", calleeId: "u_noa" },
      });
      assert.equal(created.statusCode, 201);
      const call = created.json().call;
      assert.equal(call.agent.required, true);
      assert.equal(call.agent.dispatched, false);
      assert.ok(call.agent.error);

      const res = await offline.inject({
        headers: as("u_noa"),
        method: "POST",
        url: `/api/calls/${call.id}/verdict`,
        payload: { userId: "u_noa" },
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error.code, "no_agent");
      assert.match(res.json().error.message, /no utterance was logged/);
    } finally {
      await offline.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CORS / public origin
// ---------------------------------------------------------------------------

describe("allowed origins", () => {
  it("parses and normalizes WEB_ORIGINS entries", async () => {
    const { parseWebOrigins } = await import("../src/config.js");
    const rules = parseWebOrigins(
      " https://calm-river-1234.trycloudflare.com/ , https://*.trycloudflare.com , http://box.local:5173 ",
    );
    assert.deepEqual(
      rules.map((r) => [r.scheme, r.host, r.port, r.wildcard]),
      [
        ["https", "calm-river-1234.trycloudflare.com", "", false],
        ["https", "trycloudflare.com", "", true],
        ["http", "box.local", "5173", false],
      ],
    );
    assert.deepEqual(parseWebOrigins(""), []);
  });

  it("refuses malformed entries with an actionable message", async () => {
    const { parseWebOrigins } = await import("../src/config.js");
    for (const bad of [
      "https://example.com/app",
      "example.com",
      "wss://example.com",
      "https://*",
      "https://*.com",
    ]) {
      assert.throws(() => parseWebOrigins(bad), /WEB_ORIGINS/, `"${bad}" must be rejected`);
    }
  });

  it("allows local origins and the configured public origin, and nothing else", async () => {
    const { loadConfig, parseWebOrigins } = await import("../src/config.js");
    const { originAllowed } = await import("../src/index.js");
    const cfg = {
      ...loadConfig(),
      webOrigins: parseWebOrigins("https://*.trycloudflare.com,https://speakeasy.example.com"),
    };

    for (const ok of [
      "http://localhost:5173",
      "http://127.0.0.1:8787",
      "http://192.168.1.20:5173",
      "http://mac.local:5173",
      "https://calm-river-1234.trycloudflare.com",
      "https://speakeasy.example.com",
    ]) {
      assert.equal(originAllowed(cfg, ok), true, `${ok} must be allowed`);
    }

    for (const no of [
      "https://trycloudflare.com", // the apex is not a subdomain
      "http://calm-river.trycloudflare.com", // wrong scheme
      "https://calm-river.trycloudflare.com:8443", // wrong port
      "https://evil.com",
      "https://speakeasy.example.com.evil.com",
      "null",
      "",
    ]) {
      assert.equal(originAllowed(cfg, no), false, `${no} must be refused`);
    }
  });

  it("ALLOW_LOCAL_ORIGINS=false narrows the allowlist to WEB_ORIGINS only", async () => {
    const { loadConfig, parseWebOrigins } = await import("../src/config.js");
    const { originAllowed } = await import("../src/index.js");
    const cfg = {
      ...loadConfig(),
      allowLocalOrigins: false,
      webOrigins: parseWebOrigins("https://speakeasy.example.com"),
    };
    assert.equal(originAllowed(cfg, "http://localhost:5173"), false);
    assert.equal(originAllowed(cfg, "https://speakeasy.example.com"), true);
  });

  it("refuses to start when the config would reject every browser", async () => {
    const { loadConfig } = await import("../src/config.js");
    process.env.ALLOW_LOCAL_ORIGINS = "false";
    try {
      assert.throws(() => loadConfig(), /ALLOW_LOCAL_ORIGINS=false/);
      process.env.WEB_ORIGINS = "https://ok.example.com";
      assert.equal(loadConfig().webOrigins.length, 1);
      process.env.ALLOW_LOCAL_ORIGINS = "maybe";
      assert.throws(() => loadConfig(), /ALLOW_LOCAL_ORIGINS/);
    } finally {
      delete process.env.ALLOW_LOCAL_ORIGINS;
      delete process.env.WEB_ORIGINS;
    }
  });

  it("sends the CORS header for a configured tunnel origin and withholds it otherwise", async () => {
    const { loadConfig, parseWebOrigins } = await import("../src/config.js");
    const { buildApp } = await import("../src/index.js");
    const tunnelApp = await buildApp({
      ...loadConfig(),
      webOrigins: parseWebOrigins("https://*.trycloudflare.com"),
    });
    await tunnelApp.ready();
    try {
      const allowed = await tunnelApp.inject({
        method: "GET",
        url: "/healthz",
        headers: { origin: "https://calm-river-1234.trycloudflare.com" },
      });
      assert.equal(allowed.statusCode, 200);
      assert.equal(
        allowed.headers["access-control-allow-origin"],
        "https://calm-river-1234.trycloudflare.com",
      );
      // Load-bearing for the two-tunnel cloud profile: without this header the
      // browser drops the session cookie on every cross-origin call, and the
      // page silently behaves as if nobody were signed in. It is also why the
      // origin above must be the reflected one and never "*" — a wildcard and
      // credentials are mutually exclusive, and the browser would refuse both.
      assert.equal(allowed.headers["access-control-allow-credentials"], "true");
      assert.notEqual(allowed.headers["access-control-allow-origin"], "*");

      const preflight = await tunnelApp.inject({
        method: "OPTIONS",
        url: "/api/users/u_alex",
        headers: {
          origin: "https://calm-river-1234.trycloudflare.com",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
      assert.ok(
        String(preflight.headers["access-control-allow-headers"] ?? "")
          .toLowerCase()
          .includes("authorization"),
        "the bearer half of the session must survive the preflight",
      );

      const refused = await tunnelApp.inject({
        method: "GET",
        url: "/healthz",
        headers: { origin: "https://evil.example.com" },
      });
      // @fastify/cors omits the header rather than failing the request; the browser
      // is what enforces it. The point is that the header is absent.
      assert.equal(refused.headers["access-control-allow-origin"], undefined);
    } finally {
      await tunnelApp.close();
    }
  });
});


/**
 * IDENTITY. Until 31.08.2026 the answer to "who is making this request" was the
 * `?me=<userId>` query parameter: whoever held the URL was that person, every
 * /api/users/:userId/... route trusted the path, and POST /api/auth/phone/start
 * returned the confirmation code in its own response so anyone could mint the
 * URL for anyone's number.
 *
 * What follows is the whole contract in one block: no session is 401, somebody
 * else's session is 403, a token this server did not sign is 401, and a real
 * session does everything a user is supposed to be able to do.
 */
describe("session: identity is a signed token, not a query parameter", () => {
  /**
   * One row per route that acts on behalf of a user — the same list the routes
   * themselves guard. Written out rather than derived, because a table built
   * from the router would go green by agreeing with a bug.
   */
  function actingAsAlex(callId: string): Array<{
    method: "GET" | "POST" | "PATCH";
    url: string;
    payload?: Record<string, unknown>;
  }> {
    return [
      { method: "GET", url: "/api/users/u_alex" },
      { method: "PATCH", url: "/api/users/u_alex", payload: { tone: "neutral" } },
      { method: "GET", url: "/api/users/u_alex/contacts" },
      {
        method: "PATCH",
        url: "/api/users/u_alex/contacts/u_noa",
        payload: { forceTranslate: false },
      },
      { method: "GET", url: "/api/users/u_alex/calls" },
      { method: "GET", url: `/api/users/u_alex/calls/${callId}` },
      { method: "POST", url: "/api/presence", payload: { userId: "u_alex" } },
      { method: "GET", url: "/api/ring/u_alex" },
      { method: "POST", url: "/api/calls", payload: { callerId: "u_alex", calleeId: "u_noa" } },
      { method: "POST", url: `/api/calls/${callId}/join`, payload: { userId: "u_alex" } },
      {
        method: "POST",
        url: `/api/calls/${callId}/mode`,
        payload: { userId: "u_alex", force: false },
      },
      { method: "POST", url: `/api/calls/${callId}/end`, payload: { userId: "u_alex" } },
      { method: "POST", url: `/api/calls/${callId}/verdict`, payload: { userId: "u_alex" } },
      { method: "POST", url: `/api/calls/${callId}/ring/accept`, payload: { userId: "u_alex" } },
      { method: "POST", url: `/api/calls/${callId}/ring/decline`, payload: { userId: "u_alex" } },
      { method: "POST", url: `/api/calls/${callId}/ring/cancel`, payload: { userId: "u_alex" } },
    ];
  }

  /** A call that exists, so a 401/403 cannot be a 404 wearing a disguise. */
  async function aliveCallId(): Promise<string> {
    const created = await app.inject({
      headers: as("u_alex"),
      method: "POST",
      url: "/api/calls",
      payload: { callerId: "u_alex", calleeId: "u_noa" },
    });
    assert.equal(created.statusCode, 201);
    return created.json().call.id as string;
  }

  it("answers 401 on every user route when there is no session at all", async () => {
    const callId = await aliveCallId();
    for (const req of actingAsAlex(callId)) {
      const res = await app.inject({ method: req.method, url: req.url, payload: req.payload });
      assert.equal(
        res.statusCode,
        401,
        `${req.method} ${req.url} must be 401 without a session, got ${res.statusCode}`,
      );
      assert.equal(res.json().error.code, "unauthorized");
    }
    await hangUp(callId);
  });

  it("answers 403 on every one of them for a session that belongs to someone else", async () => {
    const callId = await aliveCallId();
    // Maya is real, signed in, and none of this is hers. This is the `?me=`
    // hole stated as a test: holding the URL is no longer holding the identity.
    for (const req of actingAsAlex(callId)) {
      const res = await app.inject({
        headers: as("u_maya"),
        method: req.method,
        url: req.url,
        payload: req.payload,
      });
      assert.equal(
        res.statusCode,
        403,
        `${req.method} ${req.url} must be 403 for another user, got ${res.statusCode}`,
      );
      assert.equal(res.json().error.code, "forbidden");
    }
    await hangUp(callId);
  });

  it("refuses a forged token: wrong key, edited payload, or mangled signature", async () => {
    const url = "/api/users/u_alex";

    const wrongKey = issueSession("a-different-secret-entirely-0000000000", "u_alex", 3600).token;
    const wrongKeyRes = await app.inject({
      headers: { authorization: `Bearer ${wrongKey}` },
      method: "GET",
      url,
    });
    assert.equal(wrongKeyRes.statusCode, 401, "a token signed with another key is not a session");

    // The interesting forgery: take a session you legitimately hold and rewrite
    // whose it is. The signature covers the payload, so it stops being valid.
    const mine = issueSession(TEST_SESSION_SECRET, "u_maya", 3600).token;
    const signature = mine.split(".")[2]!;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const swapped = Buffer.from(
      JSON.stringify({ u: "u_alex", i: nowSeconds, e: nowSeconds + 3600 }),
      "utf8",
    ).toString("base64url");
    const tampered = await app.inject({
      headers: { authorization: `Bearer sv1.${swapped}.${signature}` },
      method: "GET",
      url,
    });
    assert.equal(tampered.statusCode, 401, "an edited payload must not keep an old signature");

    const mangled = await app.inject({
      headers: { authorization: `Bearer ${mine.slice(0, -3)}xyz` },
      method: "GET",
      url: "/api/users/u_maya",
    });
    assert.equal(mangled.statusCode, 401);

    const nonsense = await app.inject({
      headers: { authorization: "Bearer not-a-token" },
      method: "GET",
      url,
    });
    assert.equal(nonsense.statusCode, 401);
  });

  it("refuses an expired token, however well signed", async () => {
    const expired = issueSession(TEST_SESSION_SECRET, "u_alex", -1).token;
    const res = await app.inject({
      headers: { authorization: `Bearer ${expired}` },
      method: "GET",
      url: "/api/users/u_alex",
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "unauthorized");
  });

  it("carries a real phone user from registration through a call on his own session", async () => {
    // The end-to-end shape of the founder's own path: verify a number, get a
    // profile AND a session in the same response, then use nothing but that
    // session for everything after it. No ?me=, no user id in a header.
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "056-400-0001" },
    });
    assert.equal(started.statusCode, 201);
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: started.json().challengeId, code: started.json().devCode },
    });
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        registrationToken: verified.json().registrationToken,
        displayName: "Основатель",
        lang: "ru",
        gender: "m",
      },
    });
    assert.equal(registered.statusCode, 201);
    const me = registered.json().user.id as string;
    const token = registered.json().session.token as string;
    assert.ok(token, "registration must hand back a session");
    assert.ok(
      Date.parse(registered.json().session.expiresAt) > Date.now(),
      "a session must carry an expiry, and it must be in the future",
    );
    const mine = { authorization: `Bearer ${token}` };

    const who = await app.inject({ headers: mine, method: "GET", url: "/api/auth/session" });
    assert.equal(who.statusCode, 200);
    assert.equal(who.json().user.id, me, "the session answers who it is without being told");

    const profile = await app.inject({ headers: mine, method: "GET", url: `/api/users/${me}` });
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.json().user.displayName, "Основатель");

    const renamed = await app.inject({
      headers: mine,
      method: "PATCH",
      url: `/api/users/${me}`,
      payload: { tone: "friendly" },
    });
    assert.equal(renamed.statusCode, 200);

    const contacts = await app.inject({
      headers: mine,
      method: "GET",
      url: `/api/users/${me}/contacts`,
    });
    assert.equal(contacts.statusCode, 200);
    assert.ok(
      contacts.json().contacts.some((c: { userId: string }) => c.userId === "u_noa"),
      "the seeded grid must still be reachable after the session check",
    );

    const card = await app.inject({
      headers: mine,
      method: "PATCH",
      url: `/api/users/${me}/contacts/u_noa`,
      payload: { forceTranslate: true },
    });
    assert.equal(card.statusCode, 200);
    assert.equal(card.json().contact.forceTranslate, true);

    const heartbeat = await app.inject({
      headers: mine,
      method: "POST",
      url: "/api/presence",
      payload: { userId: me },
    });
    assert.equal(heartbeat.statusCode, 200);
    assert.equal(heartbeat.json().self.online, true);

    const ring = await app.inject({ headers: mine, method: "GET", url: `/api/ring/${me}` });
    assert.equal(ring.statusCode, 200);

    const created = await app.inject({
      headers: mine,
      method: "POST",
      url: "/api/calls",
      payload: { callerId: me, calleeId: "u_noa" },
    });
    assert.equal(created.statusCode, 201);
    const callId = created.json().call.id as string;

    const joined = await app.inject({
      headers: mine,
      method: "POST",
      url: `/api/calls/${callId}/join`,
      payload: { userId: me },
    });
    assert.equal(joined.statusCode, 200);
    assert.ok(joined.json().token, "a joined call still mints a LiveKit token");

    const ended = await app.inject({
      headers: mine,
      method: "POST",
      url: `/api/calls/${callId}/end`,
      payload: { userId: me },
    });
    assert.equal(ended.statusCode, 200);

    const history = await app.inject({ headers: mine, method: "GET", url: `/api/users/${me}/calls` });
    assert.equal(history.statusCode, 200);

    // Undo the override so the rest of the file sees the contact grid it expects.
    await app.inject({
      headers: mine,
      method: "PATCH",
      url: `/api/users/${me}/contacts/u_noa`,
      payload: { forceTranslate: false },
    });
  });

  it("sets an httpOnly SameSite=Lax cookie, Secure everywhere but a local host", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "056-400-0002" },
    });
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: started.json().challengeId, code: started.json().devCode },
    });
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        registrationToken: verified.json().registrationToken,
        displayName: "Куки",
        lang: "ru",
        gender: "f",
      },
    });
    const cookie = registered.headers["set-cookie"] as string;
    assert.match(cookie, /^sv_session=/);
    assert.match(cookie, /HttpOnly/, "script must not be able to read the session");
    assert.match(cookie, /SameSite=Lax/, "Strict would drop the cookie on an invite link");
    assert.match(cookie, /Max-Age=\d+/);
    assert.match(cookie, /Path=\//);
    // inject() speaks to localhost, where a Secure cookie is silently dropped
    // and "logging in does nothing" is the least debuggable failure there is.
    assert.ok(!/Secure/.test(cookie), `no Secure on a local host: ${cookie}`);

    const me = registered.json().user.id as string;
    const token = cookie.slice("sv_session=".length).split(";")[0]!;
    const byCookie = await app.inject({
      headers: { cookie: `sv_session=${token}` },
      method: "GET",
      url: `/api/users/${me}`,
    });
    assert.equal(byCookie.statusCode, 200, "the cookie alone must be a session");
    assert.equal(byCookie.json().user.id, me);

    // The deployed page is https behind Caddy, which forwards plain http on
    // loopback — so the decision is taken from the Host, never the protocol.
    const publicHost = await app.inject({
      headers: { host: "samevoice.0110.digital" },
      method: "POST",
      url: "/api/auth/logout",
    });
    assert.match(publicHost.headers["set-cookie"] as string, /Secure/);

    const loggedOut = await app.inject({ method: "POST", url: "/api/auth/logout" });
    assert.match(loggedOut.headers["set-cookie"] as string, /sv_session=;/);
    assert.match(loggedOut.headers["set-cookie"] as string, /Max-Age=0/);
  });

  it("treats verifying a number that already has a profile as the login itself", async () => {
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "056-400-0001" },
    });
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: again.json().challengeId, code: again.json().devCode },
    });
    assert.equal(verified.statusCode, 200);
    assert.ok(verified.json().existingUser, "the number is already known");
    assert.ok(verified.json().session?.token, "a returning user must not have to register again");
    assert.match(verified.headers["set-cookie"] as string, /^sv_session=/);

    const who = await app.inject({
      headers: { authorization: `Bearer ${verified.json().session.token}` },
      method: "GET",
      url: "/api/auth/session",
    });
    assert.equal(who.json().user.id, verified.json().existingUser.id);
  });

  it("answers GET /api/auth/session with 401 when there is nothing to answer from", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/session" });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "unauthorized");
  });
});

/**
 * THE CODE IN THE RESPONSE, and who may ask for one.
 *
 * devCode is not removed: SMS is not wired, and removing it would leave nobody
 * able to log in at all. It is a switch that defaults to off, and the other
 * half of the fix is an allowlist of numbers permitted to start verification.
 */
describe("confirmation-code delivery and the tester allowlist", () => {
  async function withApp(
    overrides: Record<string, unknown>,
    fn: (built: FastifyInstance) => Promise<void>,
    logStream?: NodeJS.WritableStream,
  ): Promise<void> {
    const { loadConfig } = await import("../src/config.js");
    const { buildApp } = await import("../src/index.js");
    const built = await buildApp({ ...loadConfig(), ...overrides } as never, { logStream });
    try {
      await fn(built);
    } finally {
      await built.close();
    }
  }

  it("keeps the code out of the response by default and puts it in the log — without the number", async () => {
    const lines: string[] = [];
    const stream = {
      write(chunk: string): boolean {
        lines.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    await withApp(
      { authDevCodeInResponse: false, logLevel: "warn" },
      async (built) => {
        const started = await built.inject({
          method: "POST",
          url: "/api/auth/phone/start",
          payload: { phone: "056-400-0003" },
        });
        assert.equal(started.statusCode, 201);
        assert.equal(started.json().devCode, undefined, "the code must NOT be in the response");
        assert.equal(started.json().codeDelivery, "server_log");
        assert.match(started.json().challengeId, /^pv_[0-9a-f]{24}$/);

        const logged = lines.join("");
        assert.ok(
          logged.includes(started.json().challengeId),
          "the operator must be able to find the challenge in the log",
        );
        const code = /"code":"(\d{6})"/.exec(logged)?.[1];
        assert.ok(code, `a six-digit code must reach the log: ${logged}`);
        // The invariant, asserted rather than promised: a phone number is
        // personal data and must never appear in a log line.
        assert.ok(
          !logged.includes("+972564000003") && !logged.includes("0564000003"),
          `the phone number must never reach the log: ${logged}`,
        );

        const verified = await built.inject({
          method: "POST",
          url: "/api/auth/phone/verify",
          payload: { challengeId: started.json().challengeId, code },
        });
        assert.equal(verified.statusCode, 200, "the logged code is the real one");
      },
      stream,
    );
  });

  it("lets anyone start when the allowlist is empty — the behaviour the boot warning is about", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "056-400-0009" },
    });
    assert.equal(res.statusCode, 201);
  });

  it("refuses a number that is not on a non-empty allowlist, and says nothing about it", async () => {
    await withApp({ authPhoneAllowlist: ["+972564000004"] }, async (built) => {
      const allowed = await built.inject({
        method: "POST",
        url: "/api/auth/phone/start",
        // Israeli notation on the wire, E.164 in the config: one normalizer,
        // so the two forms are the same number rather than two.
        payload: { phone: "056-400-0004" },
      });
      assert.equal(allowed.statusCode, 201);

      const refused = await built.inject({
        method: "POST",
        url: "/api/auth/phone/start",
        payload: { phone: "056-400-0005" },
      });
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.json().error.code, "forbidden");
      assert.ok(
        !JSON.stringify(refused.json()).includes("564000005"),
        "a rejection must not echo the number back",
      );
    });
  });

  /**
   * FIVE GUESSES PER CHALLENGE IS NOT FIVE GUESSES.
   *
   * The per-challenge counter is exactly what a new challenge resets, and
   * minting one is a single unauthenticated POST. Guess five, ask for a fresh
   * code, guess five more: the search covers the whole six-digit space at five
   * guesses per two requests, so a script reaches even odds against a chosen
   * number in roughly 140,000 guesses. Landing on a number that already has a
   * profile is not a registration — POST /api/auth/phone/verify treats a known
   * number as the login and returns that person's session.
   *
   * This walks that attack in miniature: the budget is keyed on the NUMBER, so
   * fresh challenges buy nothing, and once it is out even the RIGHT code is
   * refused.
   */
  it("bounds guesses per number, so a fresh challenge does not buy fresh tries", async () => {
    const phone = "058-400-0011";
    const start = async (): Promise<{ challengeId: string; devCode: string }> => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/phone/start",
        payload: { phone },
      });
      assert.equal(res.statusCode, 201);
      return res.json();
    };
    const guess = async (challengeId: string, code: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/phone/verify",
        payload: { challengeId, code },
      });

    const { MAX_ATTEMPTS_PER_PHONE } = await import("../src/phoneVerification.js");
    // Only a guess against a LIVE challenge costs anything — one against a
    // challenge that has run out is not a guess at the code, and is free. So
    // `invalid_code` is what counts, and `invalid_challenge` is the signal to
    // mint another one, which is exactly the loop the attack runs.
    let spent = 0;
    let latest = await start();
    for (let i = 0; spent < MAX_ATTEMPTS_PER_PHONE && i < MAX_ATTEMPTS_PER_PHONE * 4; i += 1) {
      const wrong = latest.devCode === "000000" ? "999999" : "000000";
      const res = await guess(latest.challengeId, wrong);
      assert.equal(res.statusCode, 400);
      if (res.json().error.code === "invalid_code") spent += 1;
      else latest = await start();
    }
    assert.equal(spent, MAX_ATTEMPTS_PER_PHONE, "the budget must actually have been spent");

    // The budget is spent. A brand-new challenge and its OWN correct code —
    // everything a legitimate login has — must still not get through, or the
    // ceiling is per challenge again and bounds nothing.
    const fresh = await start();
    const refused = await guess(fresh.challengeId, fresh.devCode);
    assert.equal(refused.statusCode, 400, "the number is out of guesses for this window");
    assert.equal(
      refused.json().error.code,
      "invalid_challenge",
      "and it must not announce that the ceiling is what stopped it",
    );

    // Per number, not global: a different number is untouched by the first
    // one's spending, or one script locks every tester out of logging in.
    const other = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "058-400-0012" },
    });
    const otherOk = await guess(other.json().challengeId, other.json().devCode);
    assert.equal(otherOk.statusCode, 200);
    assert.equal(otherOk.json().verified, true);
  });

  it("rejects an unparseable allowlist at startup instead of silently blocking everyone", async () => {
    const { loadConfig } = await import("../src/config.js");
    process.env.AUTH_PHONE_ALLOWLIST = "not-a-number";
    try {
      assert.throws(() => loadConfig(), /AUTH_PHONE_ALLOWLIST/);
    } finally {
      delete process.env.AUTH_PHONE_ALLOWLIST;
    }
  });

  it("hands out no seeded session by default, and only seeded ones when switched on", async () => {
    const off = await app.inject({
      method: "POST",
      url: "/api/auth/seeded-login",
      payload: { userId: "u_alex" },
    });
    assert.equal(off.statusCode, 403, "the debug login must be off unless asked for");

    await withApp({ authSeededLogin: true }, async (built) => {
      const on = await built.inject({
        method: "POST",
        url: "/api/auth/seeded-login",
        payload: { userId: "u_noa" },
      });
      assert.equal(on.statusCode, 200);
      assert.equal(on.json().user.id, "u_noa");
      assert.ok(on.json().session.token);

      // Even switched on it is a login for the four test fixtures and nothing
      // else: a real person's profile is reachable only through their number.
      const phoneUser = await built.inject({
        method: "POST",
        url: "/api/auth/phone/start",
        payload: { phone: "056-400-0006" },
      });
      const verified = await built.inject({
        method: "POST",
        url: "/api/auth/phone/verify",
        payload: { challengeId: phoneUser.json().challengeId, code: phoneUser.json().devCode },
      });
      const registered = await built.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          registrationToken: verified.json().registrationToken,
          displayName: "Настоящий",
          lang: "he",
          gender: "f",
        },
      });
      const realUserId = registered.json().user.id as string;

      const stolen = await built.inject({
        method: "POST",
        url: "/api/auth/seeded-login",
        payload: { userId: realUserId },
      });
      assert.equal(stolen.statusCode, 403, "a phone-registered profile is never a seeded identity");
    });
  });
});

/**
 * Persistence. Users, the phone index and contacts used to live only in Maps, so
 * `systemctl restart` deleted every identity that had passed phone verification
 * while the seeded four — recreated by code on every boot — kept working. The
 * founder's own ?me= link answered "user not found"; the failure therefore read
 * as a broken link rather than as a wiped store, and stayed unexplained.
 *
 * A restart is reproduced by calling loadIdentityStore() again on the same
 * directory. That is not an imitation of a boot: it is the function buildApp()
 * calls, with the argument buildApp() passes.
 *
 * This block runs LAST on purpose — its final test resets the store to the bare
 * seed, which any test after it would inherit.
 */
describe("identity persistence: profiles and contacts survive a restart", () => {
  /** Unused by every other test in this file: one number, one profile, forever. */
  const PHONE_E164 = "+972524044040";
  const SEEDED_IDS = ["u_alex", "u_maya", "u_noa", "u_omri"];

  function snapshotFile(): string {
    return join(identityDir, "identities.json");
  }

  it("writes the profile, the phone index and BOTH contact directions on registration", async () => {
    const store = await import("../src/store.js");
    assert.equal(store.identityStorePath(), snapshotFile());

    // createUserFromPhone() rather than the three auth requests: this is the
    // function POST /api/auth/register calls once verification has passed, and
    // it is the boundary that owns persistence. Driving it directly keeps this
    // block measuring the store instead of the delivery of a confirmation code.
    const user = store.createUserFromPhone({
      phone: PHONE_E164,
      displayName: "Дов",
      lang: "ru",
      gender: "m",
    });
    const userId = user.id;
    assert.match(userId, /^u_[0-9a-f]{16}$/);

    assert.ok(existsSync(snapshotFile()), `registration must have written ${snapshotFile()}`);
    const snapshot = JSON.parse(readFileSync(snapshotFile(), "utf8"));
    assert.equal(snapshot.version, 1);
    assert.ok(
      snapshot.users.some((u: { id: string; displayName: string }) => u.id === userId && u.displayName === "Дов"),
      "the profile must be in the file, not only in memory",
    );
    assert.deepEqual(
      snapshot.phones.filter((p: { userId: string }) => p.userId === userId),
      [{ phone: PHONE_E164, userId }],
      "the phone index is what stops one number minting a second profile at the next login",
    );
    // Both directions. A one-way row lets him dial out and never be reachable,
    // which is the shape the auto-join exists to prevent.
    assert.ok(
      snapshot.contacts.some(
        (c: { ownerId: string; contactUserId: string }) => c.ownerId === userId && c.contactUserId === "u_alex",
      ),
    );
    assert.ok(
      snapshot.contacts.some(
        (c: { ownerId: string; contactUserId: string }) => c.ownerId === "u_alex" && c.contactUserId === userId,
      ),
    );
    // The write goes to a temporary file and is renamed onto the snapshot; a
    // leftover .tmp beside it would mean the rename never happened.
    assert.equal(existsSync(`${snapshotFile()}.tmp`), false);
  });

  it("brings the user, his number and his contact settings back after a restart", async () => {
    const store = await import("../src/store.js");
    const userId = store.getUserByPhone(PHONE_E164)!.id;

    // A per-contact override, because a contact ROW surviving is not the same as
    // the settings on it surviving — the pinned language is what a tester loses.
    store.updateContact(userId, "u_noa", { forceTranslate: true, overrides: { tone: "formal" } });

    store.loadIdentityStore(identityDir);

    const user = store.getUser(userId);
    assert.ok(user, `${userId} must exist after a restart — this is the founder's ?me= link`);
    assert.equal(user!.displayName, "Дов");
    assert.equal(store.getUserByPhone(PHONE_E164)?.id, userId, "the phone index must survive too");

    assert.deepEqual(
      store.listContacts(userId).map((c) => c.contactUserId).sort(),
      SEEDED_IDS,
      "an empty contact list after a restart is the bug that hid for days",
    );
    assert.ok(store.listContacts("u_alex").some((c) => c.contactUserId === userId));

    const noa = store.getContact(userId, "u_noa");
    assert.equal(noa?.forceTranslate, true);
    assert.deepEqual(noa?.overrides, { tone: "formal" });
  });

  it("does not duplicate the seeded accounts by loading the snapshot on top of the seed", async () => {
    const store = await import("../src/store.js");
    const before = store.listUsers().length;

    store.loadIdentityStore(identityDir);
    store.loadIdentityStore(identityDir);

    assert.equal(store.listUsers().length, before, "a second boot must not add a second Alex");
    assert.equal(store.listUsers().filter((u) => u.id === "u_alex").length, 1);
    assert.deepEqual([...store.stage0TestIdentityIdList()].sort(), SEEDED_IDS);

    const alexContacts = store.listContacts("u_alex").map((c) => c.contactUserId);
    assert.equal(new Set(alexContacts).size, alexContacts.length, "u_alex must not hold a contact twice");
    for (const id of SEEDED_IDS) {
      assert.ok(store.getUser(id), `seeded ${id} must still exist after a restart`);
    }
  });

  it("refuses to start on a truncated snapshot instead of coming up empty", async () => {
    const store = await import("../src/store.js");
    const dir = mkdtempSync(join(tmpdir(), "speakeasy-identity-corrupt-"));
    const file = join(dir, "identities.json");
    // Exactly what a crash between write and rename would leave if the write
    // were not staged through a temporary file: a real snapshot, tail missing.
    const good = readFileSync(snapshotFile(), "utf8");
    writeFileSync(file, good.slice(0, Math.floor(good.length / 2)), "utf8");

    try {
      assert.throws(
        () => store.loadIdentityStore(dir),
        (err: Error) => {
          assert.match(err.message, /is not valid JSON/);
          // The path, or the operator has nothing to go and look at.
          assert.ok(err.message.includes(file), `message must name ${file}: ${err.message}`);
          return true;
        },
        "a corrupt store must stop the process, never start it with the seed alone",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Loud AND harmless: the failed load changed nothing. Memory still holds the
    // registered user, and the store still points at the good directory — a
    // caller that swallowed the error cannot overwrite the file an operator now
    // has to go and read. Production does not swallow it: index.ts prints the
    // message and exits.
    assert.equal(store.identityStorePath(), snapshotFile());
    assert.ok(store.getUserByPhone(PHONE_E164), "a failed load must not empty the store it had");
  });

  it("refuses a snapshot that parses but is not one, naming the field", async () => {
    const store = await import("../src/store.js");
    const dir = mkdtempSync(join(tmpdir(), "speakeasy-identity-wrong-shape-"));
    const file = join(dir, "identities.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        savedAt: "2026-08-31T00:00:00.000Z",
        users: [{ id: "alex", handle: "alex", displayName: "Alex", lang: "ru", gender: "m", tone: "neutral" }],
        phones: [],
        contacts: [],
      }),
      "utf8",
    );

    try {
      assert.throws(
        () => store.loadIdentityStore(dir),
        (err: Error) => {
          assert.match(err.message, /does not match snapshot v1/);
          assert.ok(err.message.includes(file), `message must name ${file}: ${err.message}`);
          assert.match(err.message, /users\.0\.id/);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(store.identityStorePath(), snapshotFile());
  });

  /**
   * TWO BACKENDS, ONE IDENTITY_DIR — the case that cost 390 profiles.
   *
   * saveIdentities() serializes this process's whole memory, so before the
   * guard the file was replaced by whoever wrote last. Measured on 31.08.2026
   * with two backends sharing one directory: a 545,725-byte snapshot holding
   * 404 profiles became a 15,834-byte one holding 14 — silently, by a write
   * that reported success and logged nothing.
   *
   * The other process is played by writing the file underneath this one, which
   * is exactly what its rename(2) does; it needs no second node to be the same
   * event.
   */
  it("does not delete rows another process wrote into the same snapshot", async () => {
    const store = await import("../src/store.js");
    const mine = store.getUserByPhone(PHONE_E164)!.id;

    const theirs = {
      id: "u_00000000deadbeef",
      handle: "user_00000000",
      displayName: "Другой процесс",
      lang: "ru",
      gender: "f",
      tone: "friendly",
    };
    const onDisk = JSON.parse(readFileSync(snapshotFile(), "utf8"));
    onDisk.users.push(theirs);
    onDisk.phones.push({ phone: "+972529999001", userId: theirs.id });
    onDisk.contacts.push({
      ownerId: theirs.id,
      contactUserId: "u_alex",
      forceTranslate: false,
      overrides: {},
    });
    writeFileSync(snapshotFile(), `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");

    // Any mutation will do; the point is the save it triggers.
    store.updateUser(mine, { tone: "formal" });

    const saved = JSON.parse(readFileSync(snapshotFile(), "utf8"));
    const ids = saved.users.map((u: { id: string }) => u.id);
    assert.ok(
      ids.includes(theirs.id),
      "the other process's profile must survive this process's save, not be silently deleted",
    );
    assert.ok(ids.includes(mine), "and this process's own profiles must still be there");
    assert.ok(
      saved.phones.some((p: { phone: string }) => p.phone === "+972529999001"),
      "the phone index is what stops that number minting a second profile — it must survive too",
    );
    // Add-only: the merge must not undo the edit whose save it runs inside.
    assert.equal(
      saved.users.find((u: { id: string }) => u.id === mine).tone,
      "formal",
      "merging the file in must not revert the edit that is being saved",
    );

    // The row that came back from the file must be usable, not just present:
    // a merge that loaded it somewhere the API cannot see would pass the
    // assertions above and still leave that person unreachable.
    assert.equal(store.getUserByPhone("+972529999001")?.id, theirs.id);
  });

  /**
   * The file holds the phone numbers — the index that stops one number minting
   * a second profile IS the numbers. 0644 published them to every account on
   * the box, from the one file that works hardest to keep them out of the log.
   */
  it("keeps the snapshot readable only by its owner", async () => {
    const { statSync } = await import("node:fs");
    assert.equal(
      statSync(snapshotFile()).mode & 0o777,
      0o600,
      "the snapshot carries phone numbers and must not be world-readable",
    );
  });

  it("resetStore() leaves no file behind, and the emptied directory boots as a first boot", async () => {
    const store = await import("../src/store.js");
    assert.ok(existsSync(snapshotFile()));

    store.resetStore();

    assert.equal(
      existsSync(snapshotFile()),
      false,
      "a leftover snapshot would leak one test's phone users into the next test's contact lists",
    );
    assert.equal(existsSync(`${snapshotFile()}.tmp`), false);
    assert.equal(store.getUserByPhone(PHONE_E164), undefined);
    assert.deepEqual(store.listUsers().map((u) => u.id).sort(), SEEDED_IDS);

    // A directory with no snapshot is the ordinary first boot, not an error.
    store.loadIdentityStore(identityDir);
    assert.deepEqual(store.listUsers().map((u) => u.id).sort(), SEEDED_IDS);
    assert.deepEqual(store.listContacts("u_alex").map((c) => c.contactUserId).sort(), ["u_maya", "u_noa", "u_omri"]);
  });
});


/**
 * Adding a contact BY PHONE NUMBER.
 *
 * The gap it closes: a phone-registered user is auto-joined to the four seeded
 * test identities and to nothing else (deliberately not transitively — see
 * STAGE0_AUTO_JOIN_TEST_IDENTITIES), so two humans on real numbers were
 * invisible to each other and could not dial each other from the contacts
 * screen at all. These tests pin the three things that make the fix honest:
 * both directions, one answer for every number, and a bounded number of tries.
 */
describe("adding a contact by phone number", () => {
  /** The three real steps: start -> verify -> register. Returns the new user id. */
  async function registerByPhone(
    phone: string,
    profile: { displayName: string; lang: "ru" | "he"; gender: "m" | "f" | "u" },
  ): Promise<string> {
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone },
    });
    assert.equal(started.statusCode, 201);
    const challenge = started.json();
    assert.ok(
      typeof challenge.devCode === "string",
      "these tests need the confirmation code back in the response (AUTH_DEV_CODE_IN_RESPONSE)",
    );
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: challenge.challengeId, code: challenge.devCode },
    });
    assert.equal(verified.statusCode, 200);
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { registrationToken: verified.json().registrationToken, ...profile },
    });
    assert.equal(registered.statusCode, 201);
    return registered.json().user.id as string;
  }

  async function addByPhone(actorId: string, phone: string) {
    return app.inject({
      method: "POST",
      url: "/api/contacts/by-phone",
      headers: as(actorId),
      payload: { phone },
    });
  }

  async function contactsOf(userId: string): Promise<Array<Record<string, unknown>>> {
    const res = await app.inject({
      method: "GET",
      url: `/api/users/${userId}/contacts`,
      headers: as(userId),
    });
    assert.equal(res.statusCode, 200);
    return res.json().contacts as Array<Record<string, unknown>>;
  }

  async function contactIdsOf(userId: string): Promise<string[]> {
    return (await contactsOf(userId)).map((c) => c.userId as string).sort();
  }

  it("puts each of them in the other's list, in BOTH directions", async () => {
    const anna = await registerByPhone("057-100-0001", {
      displayName: "Анна",
      lang: "ru",
      gender: "f",
    });
    const boris = await registerByPhone("057-100-0002", {
      displayName: "Борис",
      lang: "he",
      gender: "m",
    });

    // Before: the auto-join gave each of them the seeded grid and nothing else.
    assert.equal((await contactIdsOf(anna)).includes(boris), false);
    assert.equal((await contactIdsOf(boris)).includes(anna), false);

    assert.equal((await addByPhone(anna, "057-100-0002")).statusCode, 200);

    assert.ok((await contactIdsOf(anna)).includes(boris), "Anna must now be able to dial Boris");
    // The direction that gets forgotten when a row is written out by hand:
    // without it Anna can dial out and never receive, because Boris never sees
    // her in his list and presence never reports her to him.
    assert.ok((await contactIdsOf(boris)).includes(anna), "Boris must be able to call back");

    // And it is a real contact row on both sides, carrying the profile the MT
    // prompt inflects Hebrew on — not just an id in a list.
    const card = (await contactsOf(anna)).find((c) => c.userId === boris)!;
    assert.equal(card.displayName, "Борис");
    assert.equal(card.lang, "he");
    assert.equal(card.gender, "m");
    assert.equal(card.forceTranslate, false);

    // Idempotent: adding the same number again must not duplicate the row nor
    // reset the per-contact overrides a tester has already set on that card.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/users/${anna}/contacts/${boris}`,
      headers: as(anna),
      payload: { lang: "ru" },
    });
    assert.equal(patched.statusCode, 200);
    const before = await contactIdsOf(anna);
    assert.equal((await addByPhone(anna, "+972571000002")).statusCode, 200);
    assert.deepEqual(await contactIdsOf(anna), before);
    const again = (await contactsOf(anna)).find((c) => c.userId === boris)!;
    assert.deepEqual(again.overrides, { lang: "ru" });
  });

  /**
   * The privacy property, and the reason this endpoint is not a directory: an
   * answer that differed for an unregistered number would make it a membership
   * oracle — feed it numbers, keep the hits, walk away with a list of who uses
   * the product. It is the leak the GET /api/users directory is called out for,
   * opened a second door and keyed on phone numbers.
   */
  it("answers a number nobody registered exactly as it answers a known one", async () => {
    const dana = await registerByPhone("057-100-0003", {
      displayName: "Дана",
      lang: "ru",
      gender: "f",
    });
    const egor = await registerByPhone("057-100-0004", {
      displayName: "Егор",
      lang: "he",
      gender: "m",
    });

    const hit = await addByPhone(dana, "057-100-0004");
    const miss = await addByPhone(dana, "059-800-0000");

    assert.equal(hit.statusCode, miss.statusCode, "the status code must not separate the two");
    assert.deepEqual(miss.json(), hit.json(), "the body must not separate the two either");
    assert.deepEqual(Object.keys(hit.json()).sort(), ["requested"]);

    // Nothing about the other person leaks through the envelope: no id, no
    // name, and not even the number the caller typed — a phone number goes to
    // its owner and to nobody else, and the caller is not its owner.
    const rendered = JSON.stringify(hit.json());
    assert.equal(rendered.includes(egor), false);
    assert.equal(rendered.includes("Егор"), false);
    assert.equal(rendered.includes("57100"), false);

    // Own number: the same answer once more, and no self-row — a card that
    // could "call" its owner would show up in his own list.
    const self = await addByPhone(dana, "057-100-0003");
    assert.equal(self.statusCode, hit.statusCode);
    assert.deepEqual(self.json(), hit.json());
    assert.equal((await contactIdsOf(dana)).includes(dana), false);

    // The hit did land, which is what makes the equality above mean "you cannot
    // tell them apart" rather than "the route does nothing".
    assert.ok((await contactIdsOf(dana)).includes(egor));
  });

  it("takes the number in the local notation the account was created with", async () => {
    const fima = await registerByPhone("+972 57 100 0005", {
      displayName: "Фима",
      lang: "ru",
      gender: "m",
    });
    const galya = await registerByPhone("057-100-0006", {
      displayName: "Галя",
      lang: "he",
      gender: "f",
    });

    // Typed the way a person types it, matched against a number stored in
    // E.164. One parser (phoneVerification.normalizePhone) decides both ends,
    // so "057 100 0005" and "+972571000005" are the same person; a second
    // parser here would miss a user who is plainly there.
    assert.equal((await addByPhone(galya, "057 100 0005")).statusCode, 200);
    assert.ok((await contactIdsOf(galya)).includes(fima));
  });

  it("refuses a string that is not a phone number, without looking anyone up", async () => {
    const igor = await registerByPhone("057-100-0007", {
      displayName: "Игорь",
      lang: "ru",
      gender: "m",
    });
    // Safe to answer honestly: this reply depends only on what the caller typed,
    // never on who else exists.
    const res = await addByPhone(igor, "123");
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "bad_request");
  });

  it("requires a session: the caller is never taken from the body or the path", async () => {
    const anon = await app.inject({
      method: "POST",
      url: "/api/contacts/by-phone",
      payload: { phone: "057-100-0002" },
    });
    assert.equal(anon.statusCode, 401);
    assert.equal(anon.json().error.code, "unauthorized");

    const forged = await app.inject({
      method: "POST",
      url: "/api/contacts/by-phone",
      headers: { authorization: "Bearer sv1.eyJ1IjoidV9hbGV4In0.bm90YXNpZ25hdHVyZQ" },
      payload: { phone: "057-100-0002" },
    });
    assert.equal(forged.statusCode, 401);

    // And the token a browser actually receives is accepted. as() mints its own,
    // so without this the whole block could pass against a login that hands out
    // a credential this route does not take.
    const started = await app.inject({
      method: "POST",
      url: "/api/auth/phone/start",
      payload: { phone: "057-100-0010" },
    });
    const challenge = started.json();
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/phone/verify",
      payload: { challengeId: challenge.challengeId, code: challenge.devCode },
    });
    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        registrationToken: verified.json().registrationToken,
        displayName: "Нина",
        lang: "ru",
        gender: "f",
      },
    });
    const fromLogin = await app.inject({
      method: "POST",
      url: "/api/contacts/by-phone",
      headers: { authorization: `Bearer ${registered.json().session.token}` },
      payload: { phone: "057-100-0002" },
    });
    assert.equal(fromLogin.statusCode, 200);
  });

  /**
   * Unlimited, this endpoint is a phone book: an Israeli mobile number is a
   * fixed prefix plus seven digits, so a script that may ask as often as it
   * likes walks that space and keeps the hits — and every hit also inserts it
   * into a stranger's contact list, where it can be rung by name.
   */
  it("stops at the rate limit and says how long to wait", async () => {
    const { ADD_BY_PHONE_LIMIT } = await import("../src/routes/contacts.js");
    const lena = await registerByPhone("057-100-0008", {
      displayName: "Лена",
      lang: "ru",
      gender: "f",
    });

    // Misses on purpose: enumeration is made of misses, so a budget that only
    // charged for hits would refund the whole attack.
    for (let i = 0; i < ADD_BY_PHONE_LIMIT; i += 1) {
      const res = await addByPhone(lena, `059-900-${String(1000 + i).padStart(4, "0")}`);
      assert.equal(res.statusCode, 200, `attempt ${i + 1} of the budget must be allowed`);
    }

    const blocked = await addByPhone(lena, "059-900-9999");
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, "rate_limited");
    assert.ok(
      Number(blocked.headers["retry-after"]) > 0,
      "a 429 without retry-after leaves the client guessing when to try again",
    );

    // Per user, not global: another tester is unaffected by Lena's spending.
    const misha = await registerByPhone("057-100-0009", {
      displayName: "Миша",
      lang: "he",
      gender: "m",
    });
    assert.equal((await addByPhone(misha, "059-900-7777")).statusCode, 200);
  });
});
