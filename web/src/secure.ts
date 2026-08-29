/**
 * Origin diagnostics.
 *
 * Two failures look identical to a non-technical tester ("the mic does not
 * work" / "nothing loads") and are impossible to guess at:
 *
 *  1. The page is served over http:// from a LAN IP. That is not a secure
 *     context, so `navigator.mediaDevices` is simply ABSENT — there is no
 *     permission prompt to allow, and no browser setting to flip. Only https://
 *     or http://localhost work. This is the exact trap a second tester falls
 *     into if she is handed http://192.168.x.x:5173.
 *  2. The page is https:// (a tunnel) but VITE_BACKEND_URL still points at
 *     http://127.0.0.1:8787. The browser blocks that as mixed content, so every
 *     API call fails with a network error that names the right URL for the
 *     wrong reason.
 *
 * Pure and input-driven so both can be unit-tested (web/test/secure.test.ts).
 */

export type OriginProblem = 'none' | 'insecure_origin' | 'file_origin' | 'mixed_content';

export interface OriginInput {
  isSecureContext: boolean;
  /** e.g. "https:" */
  protocol: string;
  /** e.g. "abc-def.trycloudflare.com" or "192.168.1.20" */
  hostname: string;
  port: string;
  /** The resolved API base. "" means same-origin relative fetches. */
  backendUrl: string;
}

export interface OriginDiagnosis {
  problem: OriginProblem;
  ok: boolean;
  /** Ready to show to a human. Names the cause and the fix. */
  message: string | null;
}

function origin(input: OriginInput): string {
  return input.port ? `${input.protocol}//${input.hostname}:${input.port}` : `${input.protocol}//${input.hostname}`;
}

export function diagnoseOrigin(input: OriginInput): OriginDiagnosis {
  if (input.protocol === 'file:') {
    return {
      problem: 'file_origin',
      ok: false,
      message:
        'This page was opened from a file:// path, so it has no origin the browser trusts and ' +
        'the microphone is unavailable. Load it from the dev server instead.',
    };
  }

  if (!input.isSecureContext) {
    return {
      problem: 'insecure_origin',
      ok: false,
      message:
        `This page is being served from ${origin(input)}. Browsers only expose the microphone ` +
        'in a secure context — https://, or http:// on localhost. A plain http:// address on the ' +
        'local network is NOT one, so there is no permission prompt to accept and no setting to ' +
        'change: getUserMedia does not exist here at all. Open the https link (the tunnel URL) ' +
        'instead, or http://localhost:5173 on the machine running the server.',
    };
  }

  if (input.protocol === 'https:' && input.backendUrl.startsWith('http://')) {
    return {
      problem: 'mixed_content',
      ok: false,
      message:
        `This page is https:// but the API base is ${input.backendUrl}, and the browser blocks ` +
        'plain http:// requests from an https:// page. Start the web client with ' +
        'VITE_BACKEND_URL=/ so the API is same-origin through the Vite proxy, or point it at an ' +
        'https:// address.',
    };
  }

  return { problem: 'none', ok: true, message: null };
}

/** Reads the live browser context. Thin wrapper so main.ts stays declarative. */
export function diagnoseCurrentOrigin(backendUrl: string): OriginDiagnosis {
  return diagnoseOrigin({
    isSecureContext: window.isSecureContext,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    port: window.location.port,
    backendUrl,
  });
}

/**
 * The message shown when the microphone failed specifically because of the
 * context. Falls back to a generic explanation if the page somehow is secure.
 */
export function insecureContextMessage(backendUrl: string): string {
  const diag = diagnoseCurrentOrigin(backendUrl);
  if (diag.problem === 'insecure_origin' || diag.problem === 'file_origin') {
    return diag.message ?? '';
  }
  return (
    'The browser refused to expose the microphone because this page is not a secure context. ' +
    'Use the https:// link, or http://localhost on the machine running the server.'
  );
}
