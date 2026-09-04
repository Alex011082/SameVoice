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
import { parseRingPoll, parseRingView } from './types';

/**
 * Resolves the API base from VITE_BACKEND_URL. Trailing slashes are stripped,
 * so "/" becomes "" — every fetch is relative and lands on the page's own
 * origin (in prod Caddy proxies /api and /healthz to the backend). Pure so
 * the stripping is unit-testable (web/test/backend-url.test.ts).
 */
export function resolveBackendUrl(raw: string | undefined, fallback: string): string {
  return (raw ?? fallback).replace(/\/+$/, '');
}

/**
 * The localhost fallback applies ONLY to the dev server; a production build
 * falls back to same-origin. The 31.08.2026 deploy was built without
 * VITE_BACKEND_URL, baked http://127.0.0.1:8787 into the bundle, and every
 * phone that opened samevoice.0110.digital talked to itself.
 *
 * The ternary must stay directly on `import.meta.env.DEV` (not behind a
 * runtime parameter): the build replaces DEV with false, the branch becomes
 * dead code, and the address vanishes from the bundle entirely — which is
 * exactly what scripts/check-web-dist.sh verifies after every prod build.
 */
export const BACKEND_URL: string = resolveBackendUrl(
  import.meta.env.VITE_BACKEND_URL,
  import.meta.env.DEV ? 'http://127.0.0.1:8787' : '',
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
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

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export const api = {
  health: () => request<{ ok: boolean; service: string; version: string; time: string }>('/healthz'),

  config: () => request<AppConfig>('/api/config'),

  startPhoneVerification: (phone: string): Promise<PhoneChallengeResponse> =>
    post<PhoneChallengeResponse>('/api/auth/phone/start', { phone }),

  verifyPhone: (challengeId: string, code: string): Promise<PhoneVerifiedResponse> =>
    post<PhoneVerifiedResponse>('/api/auth/phone/verify', { challengeId, code }),

  registerProfile: (
    registrationToken: string,
    profile: { displayName: string; lang: Lang; gender: Gender },
  ): Promise<RegisterProfileResponse> =>
    post<RegisterProfileResponse>('/api/auth/register', { registrationToken, ...profile }),

  listUsers: async (): Promise<UserProfile[]> => (await request<{ users: UserProfile[] }>('/api/users')).users,

  getUser: async (userId: string): Promise<UserProfile> =>
    (await request<{ user: UserProfile }>(`/api/users/${encodeURIComponent(userId)}`)).user,

  updateUser: async (
    userId: string,
    body: { displayName?: string; lang?: Lang; gender?: Gender; tone?: Tone },
  ): Promise<UserProfile> =>
    (await patch<{ user: UserProfile }>(`/api/users/${encodeURIComponent(userId)}`, body)).user,

  /**
   * Добавить контакт по номеру телефона.
   *
   * Ответ намеренно одинаков и для номера, который нашёлся, и для того, что не
   * нашёлся: иначе маршрут стал бы способом узнать, зарегистрирован ли человек
   * — по номеру, который он не выбирал публиковать. Экран говорит то же самое.
   */
  addContactByPhone: async (phone: string): Promise<void> => {
    await post<{ requested: boolean }>('/api/contacts/by-phone', { phone });
  },

  listContacts: async (userId: string): Promise<ContactCard[]> =>
    (await request<{ contacts: ContactCard[] }>(`/api/users/${encodeURIComponent(userId)}/contacts`))
      .contacts,

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
    try {
      if (navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' }))) return;
    } catch {
      // Fall through to the best-effort fetch below.
    }
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
