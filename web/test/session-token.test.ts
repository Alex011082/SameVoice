import { describe, expect, it } from 'vitest';
import {
  forgetSessionToken,
  readSessionToken,
  rememberSessionToken,
  sessionAuthHeaders,
  type TokenStore,
} from '../src/session-token';

function memoryStore(): TokenStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** Safari в приватном режиме бросает прямо из getItem/setItem. */
function throwingStore(): TokenStore {
  return {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('SecurityError');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    },
  };
}

describe('bearer-копия сессии', () => {
  it('запоминает токен и отдаёт его заголовком', () => {
    const store = memoryStore();
    rememberSessionToken(store, 'sv1.payload.signature');

    expect(readSessionToken(store)).toBe('sv1.payload.signature');
    expect(sessionAuthHeaders(store)).toEqual({ Authorization: 'Bearer sv1.payload.signature' });
  });

  it('без токена не шлёт заголовок вовсе — решает сервер, а не клиент', () => {
    expect(sessionAuthHeaders(memoryStore())).toEqual({});
  });

  it('забывает токен', () => {
    const store = memoryStore();
    rememberSessionToken(store, 'sv1.a.b');
    forgetSessionToken(store);

    expect(readSessionToken(store)).toBeNull();
  });

  it('хранит только токен: ни номера, ни имени рядом с ним', () => {
    const store = memoryStore();
    rememberSessionToken(store, 'sv1.a.b');

    expect([...store.map.values()]).toEqual(['sv1.a.b']);
  });

  it('запрет на хранилище не роняет приложение', () => {
    const store = throwingStore();

    expect(() => rememberSessionToken(store, 'sv1.a.b')).not.toThrow();
    expect(() => forgetSessionToken(store)).not.toThrow();
    expect(readSessionToken(store)).toBeNull();
    expect(sessionAuthHeaders(store)).toEqual({});
  });
});
