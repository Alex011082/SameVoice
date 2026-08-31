import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../src/api';
import { readSessionToken, type TokenStore } from '../src/session-token';

/**
 * Сессия должна ехать в КАЖДОМ запросе, а не в тех, которые кто-то не забыл
 * обернуть. Раньше личность приезжала параметром `?me=` прямо в пути, и любая
 * пропущенная ручка снова открывала чужой профиль; теперь носителей два —
 * httpOnly-cookie и bearer-копия — и оба ставятся в одном месте.
 *
 * Тесты идут в node-окружении, где нет ни DOM, ни localStorage, поэтому
 * `window` подставляется руками — ровно теми двумя свойствами, которые
 * клиент трогает.
 */

interface Sent {
  url: string;
  init: RequestInit;
}

function memoryStore(seed?: string): TokenStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set('speakeasy.session.token', seed);
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

let sent: Sent[];
let realFetch: typeof globalThis.fetch;
let store: ReturnType<typeof memoryStore>;

function answerWith(body: unknown, status = 200): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function headerOf(index: number, name: string): string | undefined {
  return (sent[index]!.init.headers as Record<string, string> | undefined)?.[name];
}

beforeEach(() => {
  sent = [];
  realFetch = globalThis.fetch;
  store = memoryStore();
  (globalThis as unknown as { window: unknown }).window = { localStorage: store };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('каждый запрос несёт сессию', () => {
  it('шлёт cookie и bearer вместе, потому что поодиночке не хватает ни того, ни другого', async () => {
    store.map.set('speakeasy.session.token', 'sv1.payload.signature');
    answerWith({ user: { id: 'u_maya' } });

    await api.session();

    expect(sent[0]!.init.credentials).toBe('include');
    expect(headerOf(0, 'Authorization')).toBe('Bearer sv1.payload.signature');
  });

  it('без сохранённого токена всё равно отправляет cookie, а решает сервер', async () => {
    answerWith({ user: { id: 'u_maya' } });

    await api.session();

    expect(sent[0]!.init.credentials).toBe('include');
    expect(headerOf(0, 'Authorization')).toBeUndefined();
  });

  it('обычные ручки идут тем же путём, а не отдельной «защищённой» обёрткой', async () => {
    store.map.set('speakeasy.session.token', 'sv1.payload.signature');
    answerWith({ contacts: [] });

    await api.listContacts('u_maya');

    expect(sent[0]!.url).toContain('/api/users/u_maya/contacts');
    expect(headerOf(0, 'Authorization')).toBe('Bearer sv1.payload.signature');
  });

  it('регистрация запоминает выданный токен — иначе кросс-origin вход держался бы один запрос', async () => {
    answerWith({
      created: true,
      user: { id: 'u_new' },
      session: { token: 'sv1.fresh.signature', expiresAt: '2026-10-01T00:00:00.000Z' },
    });

    await api.registerProfile('vr_token', { displayName: 'Дов', lang: 'ru', gender: 'm' });

    expect(readSessionToken(store)).toBe('sv1.fresh.signature');
  });

  it('подтверждение уже известного номера — это тоже вход, и токен тоже сохраняется', async () => {
    answerWith({
      verified: true,
      phone: '+972500000000',
      registrationToken: 'vr_token',
      existingUser: { id: 'u_old' },
      session: { token: 'sv1.returning.signature', expiresAt: '2026-10-01T00:00:00.000Z' },
    });

    await api.verifyPhone('pv_challenge', '123456');

    expect(readSessionToken(store)).toBe('sv1.returning.signature');
  });

  it('номер, у которого профиля ещё нет, сессии не даёт и ничего не запоминает', async () => {
    answerWith({
      verified: true,
      phone: '+972500000000',
      registrationToken: 'vr_token',
      existingUser: null,
      session: null,
    });

    await api.verifyPhone('pv_challenge', '123456');

    expect(readSessionToken(store)).toBeNull();
  });

  it('выход стирает bearer-копию, а не только серверную cookie', async () => {
    store.map.set('speakeasy.session.token', 'sv1.payload.signature');
    answerWith({ ok: true });

    await api.logout();

    expect(readSessionToken(store)).toBeNull();
  });

  it('выход стирает токен даже когда сервер не ответил — иначе «выйти» врало бы', async () => {
    store.map.set('speakeasy.session.token', 'sv1.payload.signature');
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof globalThis.fetch;

    await expect(api.logout()).rejects.toThrow();
    expect(readSessionToken(store)).toBeNull();
  });
});
