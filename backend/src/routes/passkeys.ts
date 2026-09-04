/* Пасскеи: вход по Face ID / отпечатку вместо кода.
 *
 * Номер и код нужны один раз — при регистрации. Дальше владельца
 * подтверждает само устройство (WebAuthn): ключ живёт в связке ключей
 * телефона, не покидает его и не подсматривается. Это и есть «ключ,
 * привязанный к устройству».
 *
 * Хранилище доверенных ключей — файл рядом с пользователями: пасскей
 * обязан переживать перезапуск сервера, иначе вход «без кода» умирал бы
 * с каждой выкладкой. Челленджи, наоборот, живут в памяти: им пять минут
 * от роду, потерять их при рестарте — значит попросить нажать кнопку ещё раз.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { FastifyPluginAsync } from "fastify";

import { grantSession, requireActor } from "../auth.js";
import type { Config } from "../config.js";
import { getUser } from "../store.js";
import { apiError } from "../types.js";

const RP_ID = process.env.PASSKEY_RP_ID || "samevoice.0110.digital";
const ORIGIN = process.env.PASSKEY_ORIGIN || `https://${RP_ID}`;
const STORE_PATH =
  process.env.PASSKEY_STORE || "/opt/samevoice/data/identity/passkeys.json";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface StoredCredential {
  credId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  userId: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface CredentialStore {
  version: number;
  credentials: StoredCredential[];
}

/* ------------------------------ хранилище ------------------------------ */

function loadStore(): CredentialStore {
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8")) as CredentialStore;
  } catch {
    return { version: 1, credentials: [] };
  }
}

function saveStore(store: CredentialStore): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

/* Челленджи: одноразовые, короткоживущие, в памяти. */
const pending = new Map<string, { challenge: string; expiresAt: number }>();

function putChallenge(kind: string, key: string, challenge: string): void {
  pending.set(`${kind}:${key}`, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

function takeChallenge(kind: string, key: string): string | null {
  const k = `${kind}:${key}`;
  const rec = pending.get(k);
  pending.delete(k);
  if (!rec || rec.expiresAt < Date.now()) return null;
  return rec.challenge;
}

function shortLabel(ua: string | undefined): string {
  if (!ua) return "устройство";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  return "устройство";
}

export function passkeyRoutes(cfg: Config): FastifyPluginAsync {
  return async (app) => {
    /* Сколько пасскеев у текущего пользователя — чтобы веб знал,
       предлагать ли «включить вход по Face ID». */
    app.get("/api/auth/passkey", async (req, reply) => {
      const userId = requireActor(req, reply);
      if (userId === null) return reply;
      const mine = loadStore().credentials.filter((c) => c.userId === userId);
      return {
        count: mine.length,
        devices: mine.map((c) => ({ label: c.label, createdAt: c.createdAt })),
      };
    });

    app.post("/api/auth/passkey/register/options", async (req, reply) => {
      const userId = requireActor(req, reply);
      if (userId === null) return reply;
      const user = getUser(userId);
      if (!user) return reply.code(401).send(apiError("unauthorized", "sign in first"));
      const store = loadStore();
      const options = await generateRegistrationOptions({
        rpName: "SameVoice",
        rpID: RP_ID,
        userName: user.displayName || userId,
        userDisplayName: user.displayName || userId,
        // Ключ обязан находиться сам (discoverable): на экране входа мы не
        // знаем, кто пришёл, и списка «разрешённых» предъявить не можем.
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        excludeCredentials: store.credentials
          .filter((c) => c.userId === userId)
          .map((c) => ({ id: c.credId, transports: c.transports as never })),
      });
      putChallenge("reg", userId, options.challenge);
      return { options };
    });

    app.post("/api/auth/passkey/register/verify", async (req, reply) => {
      const userId = requireActor(req, reply);
      if (userId === null) return reply;
      const challenge = takeChallenge("reg", userId);
      if (!challenge) {
        return reply.code(400).send(apiError("expired", "запрос устарел — попробуйте ещё раз"));
      }
      const body = req.body as { response?: unknown } | undefined;
      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: body?.response as never,
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRPID: RP_ID,
          requireUserVerification: false,
        });
      } catch (err) {
        req.log.warn({ err: String(err) }, "passkey registration failed verification");
        return reply
          .code(400)
          .send(apiError("invalid_passkey", "устройство не смогло подтвердить ключ"));
      }
      if (!verification.verified || !verification.registrationInfo) {
        return reply
          .code(400)
          .send(apiError("invalid_passkey", "устройство не смогло подтвердить ключ"));
      }
      const { credential } = verification.registrationInfo;
      const store = loadStore();
      store.credentials = store.credentials.filter((c) => c.credId !== credential.id);
      store.credentials.push({
        credId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: (credential.transports as string[] | undefined) ?? [],
        userId,
        label: shortLabel(req.headers["user-agent"]),
        createdAt: new Date().toISOString(),
      });
      saveStore(store);
      req.log.info({ userId }, "passkey registered");
      return { ok: true };
    });

    app.post("/api/auth/passkey/login/options", async () => {
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: "preferred",
        allowCredentials: [],
      });
      const optionsId = randomBytes(16).toString("hex");
      putChallenge("login", optionsId, options.challenge);
      return { optionsId, options };
    });

    app.post("/api/auth/passkey/login/verify", async (req, reply) => {
      const body = (req.body ?? {}) as { optionsId?: string; response?: { id?: string } };
      const challenge = body.optionsId ? takeChallenge("login", body.optionsId) : null;
      if (!challenge) {
        return reply.code(400).send(apiError("expired", "запрос устарел — попробуйте ещё раз"));
      }
      const response = body.response;
      const credId = response?.id;
      const store = loadStore();
      const cred = store.credentials.find((c) => c.credId === credId);
      if (!cred || !getUser(cred.userId)) {
        return reply
          .code(403)
          .send(apiError("unknown_passkey", "этот ключ здесь не зарегистрирован"));
      }
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: response as never,
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRPID: RP_ID,
          requireUserVerification: false,
          credential: {
            id: cred.credId,
            publicKey: Buffer.from(cred.publicKey, "base64url"),
            counter: cred.counter,
            transports: cred.transports as never,
          },
        });
      } catch (err) {
        req.log.warn({ err: String(err) }, "passkey login failed verification");
        return reply
          .code(403)
          .send(apiError("invalid_passkey", "устройство не смогло подтвердить ключ"));
      }
      if (!verification.verified) {
        return reply
          .code(403)
          .send(apiError("invalid_passkey", "устройство не смогло подтвердить ключ"));
      }
      cred.counter = verification.authenticationInfo.newCounter;
      cred.lastUsedAt = new Date().toISOString();
      saveStore(store);
      const user = getUser(cred.userId);
      if (!user) {
        return reply
          .code(403)
          .send(apiError("unknown_passkey", "этот ключ здесь не зарегистрирован"));
      }
      req.log.info({ userId: user.id }, "passkey login");
      return { user, session: grantSession(cfg, req, reply, user.id) };
    });
  };
}
