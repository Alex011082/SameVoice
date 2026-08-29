import { describe, expect, it } from 'vitest';
import { diagnoseOrigin, type OriginInput } from '../src/secure';

function input(over: Partial<OriginInput> = {}): OriginInput {
  return {
    isSecureContext: true,
    protocol: 'https:',
    hostname: 'four-random-words.trycloudflare.com',
    port: '',
    backendUrl: '',
    ...over,
  };
}

describe('diagnoseOrigin', () => {
  it('is happy on a tunnel origin with a same-origin API', () => {
    expect(diagnoseOrigin(input())).toEqual({ problem: 'none', ok: true, message: null });
  });

  it('is happy on http://localhost, which browsers trust', () => {
    const diag = diagnoseOrigin(
      input({
        isSecureContext: true,
        protocol: 'http:',
        hostname: 'localhost',
        port: '5173',
        backendUrl: 'http://127.0.0.1:8787',
      }),
    );
    expect(diag.ok).toBe(true);
  });

  it('names the LAN address that has no microphone', () => {
    const diag = diagnoseOrigin(
      input({
        isSecureContext: false,
        protocol: 'http:',
        hostname: '192.168.1.20',
        port: '5173',
        backendUrl: 'http://192.168.1.20:8787',
      }),
    );
    expect(diag.problem).toBe('insecure_origin');
    expect(diag.ok).toBe(false);
    expect(diag.message).toContain('http://192.168.1.20:5173');
    // The actionable part: it is not a permission the tester can grant.
    expect(diag.message).toContain('secure context');
  });

  it('flags file:// separately', () => {
    const diag = diagnoseOrigin(input({ isSecureContext: false, protocol: 'file:', hostname: '' }));
    expect(diag.problem).toBe('file_origin');
  });

  it('catches an https page pointed at an http backend', () => {
    const diag = diagnoseOrigin(input({ backendUrl: 'http://127.0.0.1:8787' }));
    expect(diag.problem).toBe('mixed_content');
    expect(diag.message).toContain('VITE_BACKEND_URL=/');
  });

  it('accepts an https backend on another host', () => {
    const diag = diagnoseOrigin(input({ backendUrl: 'https://api.example.com' }));
    expect(diag.ok).toBe(true);
  });

  it('reports the insecure origin first when both problems are present', () => {
    const diag = diagnoseOrigin(
      input({
        isSecureContext: false,
        protocol: 'http:',
        hostname: '10.0.0.4',
        port: '5173',
        backendUrl: 'http://10.0.0.4:8787',
      }),
    );
    // Mixed content is moot on an http page; the missing microphone is the
    // thing that actually stops the call.
    expect(diag.problem).toBe('insecure_origin');
  });
});
