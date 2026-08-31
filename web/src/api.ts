import type {
  AppConfig,
  Call,
  CallMode,
  ContactCard,
  Gender,
  JoinResponse,
  JudgeVerdictInput,
  Lang,
  PhoneChallengeResponse,
  PhoneVerifiedResponse,
  RegisterProfileResponse,
  RingPollResponse,
  RingView,
  Tone,
  UserProfile,
} from './types';
import {
  forgetSessionToken,
  rememberSessionToken,
  sessionAuthHeaders,
  type TokenStore,
} from './session-token';
import { parseRingPoll, parseRingView } from './types';

const DEFAULT_BASE = 'http://127.0.0.1:8787';

export const BACKEND_URL: string = (import.meta.env.VITE_BACKEND_URL ?? DEFAULT_BASE).replace(
  /\/+$/,
  '',
);

/**
 * Code used when the backend answered 404 with its own default not-found body
 * rather than the app's { error: { code, message } } envelope — i.e. the route
 * does not exist. The ringing and judge features are optional extensions, so
 * the client degrades instead of erroring when they are not deployed.
 */
export const ROUTE_MISSING = 'route_missing';

/** Every non-2xx from the backend arrives as { error: { code, message } }. */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }

  get isRouteMissing(): boolean {
    return this.code === ROUTE_MISSING;
  }
}

/**
 * localStorage, когда он есть.
 *
 * Тесты клиента идут в node-окружении, где `window` не существует вовсе, а
 * Safari в приватном режиме бросает исключение при самом обращении к свойству.
 * Оба случая означают одно: bearer-копии нет, запрос уйдёт с одной cookie.
 */
function browserTokenStore(): TokenStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> {
  const store = browserTokenStore();
  return store === null ? {} : sessionAuthHeaders(store);
}

/**
 * ВСЕ запросы идут с сессией — оба носителя сразу, потому что ни одного не
 * хватает по отдельности.
 *
 * `credentials: 'include'` отправляет httpOnly-cookie `sv_session`, которую
 * ставит backend; на боевом домене (страница и API за одним Caddy) этого
 * достаточно и заголовка не будет вовсе. Bearer — единственное, что доезжает
 * при разработке: страница на :5173, API на :8787, а cookie с `SameSite=Lax`
 * в кросс-origin fetch не уходит.
 *
 * Это общий путь, а не отдельная «защищённая» обёртка: раньше личность
 * приезжала параметром `?me=` в пути запроса, и любая ручка, которую забыли
 * обернуть, снова становилась дырой. Теперь забыть нечего.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiRequestError(
      'network',
      `cannot reach the backend at ${BACKEND_URL} - is it running?`,
      0,
    );
  }

  const raw = await res.text();
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const envelope = parsed as { error?: unknown; message?: unknown } | null;
    const err = envelope?.error;
    if (typeof err === 'object' && err !== null) {
      const shaped = err as { code?: string; message?: string };
      throw new ApiRequestError(
        shaped.code ?? 'internal',
        shaped.message ?? `${res.status} ${res.statusText}`,
        res.status,
      );
    }
    // Fastify's own shape is { statusCode, error: "Not Found", message }, i.e.
    // `error` is a string. On 404 that means the ROUTE is absent, which is a
    // different thing from "this call id is unknown" and is handled differently.
    const message =
      typeof envelope?.message === 'string' ? envelope.message : `${res.status} ${res.statusText}`;
    throw new ApiRequestError(res.status === 404 ? ROUTE_MISSING : 'internal', message, res.status);
  }

  return parsed as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Сохранить bearer-копию токена, который сервер только что выдал.
 *
 * Cookie он поставил сам и она главная; эта копия нужна лишь там, где cookie
 * не доедет. Хранится только токен — ни номера, ни имени.
 */
function keepSession(session: { token: string } | null | undefined): void {
  const store = browserTokenStore();
  if (store !== null && session?.token) rememberSessionToken(store, session.token);
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export const api = {
  health: () => request<{ ok: boolean; service: string; version: string; time: string }>('/healthz'),

  config: () => request<AppConfig>('/api/config'),

  startPhoneVerification: (phone: string): Promise<PhoneChallengeResponse> =>
    post<PhoneChallengeResponse>('/api/auth/phone/start', { phone }),

  /**
   * Подтверждённый номер, у которого УЖЕ есть профиль, — это и есть вход:
   * регистрировать нечего, сервер сразу выдаёт сессию.
   */
  verifyPhone: async (challengeId: string, code: string): Promise<PhoneVerifiedResponse> => {
    const body = await post<PhoneVerifiedResponse>('/api/auth/phone/verify', { challengeId, code });
    keepSession(body.session);
    return body;
  },

  registerProfile: async (
    registrationToken: string,
    profile: { displayName: string; lang: Lang; gender: Gender },
  ): Promise<RegisterProfileResponse> => {
    const body = await post<RegisterProfileResponse>('/api/auth/register', {
      registrationToken,
      ...profile,
    });
    keepSession(body.session);
    return body;
  },

  /**
   * Кто я — по сессии, а не по адресной строке.
   *
   * Это и есть замена `?me=`: раньше клиент решал, кем он вошёл, читая параметр
   * URL, и сервер ему верил. Теперь он спрашивает. 401 означает «войдите», а не
   * «такого пользователя нет».
   */
  session: async (): Promise<UserProfile> =>
    (await request<{ user: UserProfile }>('/api/auth/session')).user,

  /**
   * Вход одной из четырёх посевных тестовых личностей — только для разбора
   * поломок и только когда backend это разрешает (AUTH_SEEDED_LOGIN). На
   * сервере без флага ответ 403, и экран честно это скажет.
   */
  seededLogin: async (userId: string): Promise<UserProfile> => {
    const body = await post<{ user: UserProfile; session: { token: string } }>(
      '/api/auth/seeded-login',
      { userId },
    );
    keepSession(body.session);
    return body.user;
  },

  /**
   * Выход. Cookie снимает сервер, bearer-копию — мы: оставить её значило бы,
   * что «выйти» работает на боевом домене и молча не работает при разработке.
   */
  logout: async (): Promise<void> => {
    try {
      await post<{ ok: boolean }>('/api/auth/logout', {});
    } finally {
      const store = browserTokenStore();
      if (store !== null) forgetSessionToken(store);
    }
  },

  listUsers: async (): Promise<UserProfile[]> => (await request<{ users: UserProfile[] }>('/api/users')).users,

  getUser: async (userId: string): Promise<UserProfile> =>
    (await request<{ user: UserProfile }>(`/api/users/${encodeURIComponent(userId)}`)).user,

  updateUser: async (
    userId: string,
    body: { displayName?: string; lang?: Lang; gender?: Gender; tone?: Tone },
  ): Promise<UserProfile> =>
    (await patch<{ user: UserProfile }>(`/api/users/${encodeURIComponent(userId)}`, body)).user,

  listContacts: async (userId: string): Promise<ContactCard[]> =>
    (await request<{ contacts: ContactCard[] }>(`/api/users/${encodeURIComponent(userId)}/contacts`))
      .contacts,

  /**
   * Добавить контакт ПО НОМЕРУ ТЕЛЕФОНА — единственный способ для двух людей,
   * зарегистрированных по своим номерам, найти друг друга: новый профиль
   * автоматически связывается только с четырьмя тестовыми аккаунтами.
   *
   * Ответ намеренно не читается, потому что читать в нём нечего. Сервер отвечает
   * одинаково и на чужой зарегистрированный номер, и на номер, за которым никого
   * нет: иначе ручка становится справочником «кто здесь есть» — тем самым, каким
   * до 31.08.2026 был GET /api/users, отдававший имя, язык и пол каждого
   * зарегистрировавшегося по номеру любому, кто дотянулся до порта. Теперь тот
   * список сузили до четырёх посевных личностей на сервере, а не в клиенте.
   * Результат виден только по списку контактов.
   */
  addContactByPhone: async (phone: string): Promise<void> => {
    await post<{ requested: boolean }>('/api/contacts/by-phone', { phone });
  },

  updateContact: async (
    userId: string,
    contactUserId: string,
    body: { lang?: Lang; gender?: Gender; tone?: Tone; forceTranslate?: boolean },
  ): Promise<ContactCard> =>
    (
      await patch<{ contact: ContactCard }>(
        `/api/users/${encodeURIComponent(userId)}/contacts/${encodeURIComponent(contactUserId)}`,
        body,
      )
    ).contact,

  /**
   * `ring: true` makes the callee's client show an incoming-call panel instead
   * of requiring an invite link. `ring: false` is the pre-existing link flow and
   * stays byte-for-byte what it was.
   */
  createCall: async (
    callerId: string,
    calleeId: string,
    opts: { force?: boolean; ring?: boolean } = {},
  ): Promise<{ call: Call; ring: RingView | null }> => {
    const body = await post<{ call: Call; ring?: unknown }>('/api/calls', {
      callerId,
      calleeId,
      force: opts.force ?? false,
      ring: opts.ring ?? false,
    });
    return { call: body.call, ring: parseRingView(body.ring) };
  },

  getCall: async (callId: string): Promise<Call> =>
    (await request<{ call: Call }>(`/api/calls/${encodeURIComponent(callId)}`)).call,

  joinCall: (callId: string, userId: string): Promise<JoinResponse> =>
    post<JoinResponse>(`/api/calls/${encodeURIComponent(callId)}/join`, { userId }),

  setCallMode: async (callId: string, userId: string, force: boolean): Promise<Call> =>
    (await post<{ call: Call }>(`/api/calls/${encodeURIComponent(callId)}/mode`, { userId, force }))
      .call,

  endCall: async (callId: string, userId: string): Promise<Call> =>
    (await post<{ call: Call }>(`/api/calls/${encodeURIComponent(callId)}/end`, { userId })).call,

  // --- presence + ringing --------------------------------------------------

  /**
   * Heartbeat and poll in one request, exactly as the backend intends: the
   * client that must report presence is the client that must learn about an
   * incoming call, so splitting them would double the request rate for nothing.
   *
   * Throws ApiRequestError with code ROUTE_MISSING when ringing is not
   * deployed; the caller turns polling off rather than showing an error.
   */
  presence: async (userId: string, online = true): Promise<RingPollResponse> => {
    const body = await post<unknown>('/api/presence', { userId, online });
    const parsed = parseRingPoll(body);
    if (!parsed) throw new ApiRequestError('internal', 'unreadable presence response', 0);
    return parsed;
  },

  /** Answer a ringing call. Idempotent server-side; a double press is fine. */
  acceptRing: async (callId: string, userId: string): Promise<RingView | null> => {
    const body = await post<{ ring?: unknown }>(
      `/api/calls/${encodeURIComponent(callId)}/ring/accept`,
      { userId },
    );
    return parseRingView(body?.ring);
  },

  /** Refuse a ringing call. Ends the call and stops any dispatched agent. */
  declineRing: async (callId: string, userId: string): Promise<void> => {
    await post<unknown>(`/api/calls/${encodeURIComponent(callId)}/ring/decline`, { userId });
  },

  /** Caller-side "never mind". Also stops the agent, so it is not optional. */
  cancelRing: async (callId: string, userId: string): Promise<void> => {
    await post<unknown>(`/api/calls/${encodeURIComponent(callId)}/ring/cancel`, { userId });
  },

  /**
   * Fire-and-forget "I am gone" on tab close. sendBeacon survives unload where
   * fetch does not; without it the peer waits out the full presence TTL before
   * the dot goes grey.
   */
  goodbye: (userId: string): void => {
    const url = `${BACKEND_URL}/api/presence`;
    const body = JSON.stringify({ userId, online: false });
    // sendBeacon шлёт cookie, но заголовок к нему не приложить. Значит он
    // годится ровно там, где cookie доезжает, — на одном origin со страницей.
    // При разработке (страница :5173, API :8787) сессию несёт только bearer,
    // и beacon получил бы 401: прощание молча не сработало бы, а собеседник
    // ждал бы полного TTL присутствия.
    if (BACKEND_URL === '') {
      try {
        if (navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))) return;
      } catch {
        // Fall through to the best-effort fetch below.
      }
    }
    void fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body,
      keepalive: true,
    }).catch(() => undefined);
  },

  // --- judge verdicts -----------------------------------------------------

  /**
   * Record a verdict against one utterance of the eval log. The backend passes
   * the agent's answer through rather than swallowing it, so a rejection here
   * is real: the label did NOT land in the JSONL and the tester must be told
   * while she still remembers what she heard.
   */
  sendVerdict: async (callId: string, input: JudgeVerdictInput): Promise<void> => {
    await post<unknown>(`/api/calls/${encodeURIComponent(callId)}/verdict`, input);
  },
};

export function modeLabel(mode: CallMode): string {
  switch (mode) {
    case 'DIRECT':
      return 'Direct';
    case 'TRANSLATED':
      return 'Translated';
    case 'FORCED':
      return 'Translated (forced)';
  }
}
