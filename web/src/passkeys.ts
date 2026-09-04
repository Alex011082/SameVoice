/* Пасскеи на стороне браузера: Face ID / отпечаток вместо кода.
 *
 * Здесь только преобразования и два вызова WebAuthn. Никакой логики входа:
 * сервер выпускает вызов (challenge), устройство подписывает его связкой
 * ключей, сервер проверяет подпись и выдаёт обычную сессию — ту же, что
 * при входе по коду.
 */

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window;
}

// base64url <-> байты: WebAuthn говорит байтами, сервер — base64url-строками.
export function b64uToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
export function bytesToB64u(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Json = Record<string, unknown>;

async function post(path: string, body: Json): Promise<Json> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) {
    const err = (data as { error?: { message?: string } }).error;
    throw new Error(err?.message ?? `HTTP ${res.status}`);
  }
  return data;
}

/** Создать пасскей для уже вошедшего пользователя. */
export async function registerPasskey(): Promise<void> {
  const { options } = (await post('/api/auth/passkey/register/options', {})) as {
    options: Json & {
      challenge: string;
      user: { id: string; name: string; displayName: string };
      excludeCredentials?: Array<{ id: string; type: string }>;
    };
  };
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...(options as unknown as PublicKeyCredentialCreationOptions),
    challenge: b64uToBytes(options.challenge).buffer as ArrayBuffer,
    user: {
      ...(options.user as unknown as PublicKeyCredentialUserEntity),
      id: b64uToBytes(options.user.id as unknown as string).buffer as ArrayBuffer,
    },
    excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({
      type: 'public-key' as const,
      id: b64uToBytes(c.id).buffer as ArrayBuffer,
    })),
  };
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('устройство не выдало ключ');
  const att = cred.response as AuthenticatorAttestationResponse;
  await post('/api/auth/passkey/register/verify', {
    response: {
      id: cred.id,
      rawId: bytesToB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        attestationObject: bytesToB64u(att.attestationObject),
        clientDataJSON: bytesToB64u(att.clientDataJSON),
        transports: (att as { getTransports?: () => string[] }).getTransports?.() ?? [],
      },
    },
  });
}

/** Вход пасскеем; возвращает профиль вошедшего. */
export async function loginWithPasskey(): Promise<{ id: string; displayName: string }> {
  const { optionsId, options } = (await post('/api/auth/passkey/login/options', {})) as {
    optionsId: string;
    options: Json & { challenge: string };
  };
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...(options as unknown as PublicKeyCredentialRequestOptions),
    challenge: b64uToBytes(options.challenge).buffer as ArrayBuffer,
    allowCredentials: [],
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('вход отменён');
  const auth = cred.response as AuthenticatorAssertionResponse;
  const out = (await post('/api/auth/passkey/login/verify', {
    optionsId,
    response: {
      id: cred.id,
      rawId: bytesToB64u(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        authenticatorData: bytesToB64u(auth.authenticatorData),
        clientDataJSON: bytesToB64u(auth.clientDataJSON),
        signature: bytesToB64u(auth.signature),
        userHandle: auth.userHandle ? bytesToB64u(auth.userHandle) : null,
      },
    },
  })) as { user: { id: string; displayName: string } };
  return out.user;
}
