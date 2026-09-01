import { describe, expect, it } from 'vitest';
import { resolveBackendUrl } from '../src/api';

/**
 * Guards the resolution of the API base. The dev/prod split itself lives in a
 * statically-foldable ternary in api.ts (a vitest run always sees DEV=true,
 * so the prod branch is unreachable here); its real guard is
 * scripts/check-web-dist.sh, which fails the prod build if the localhost
 * address survives into the bundle — the 31.08.2026 outage, when a bundle
 * built without VITE_BACKEND_URL sent every phone's API calls to 127.0.0.1.
 */
describe('resolveBackendUrl', () => {
  it('prod fallback "" stays "" — relative, same-origin fetches', () => {
    expect(resolveBackendUrl(undefined, '')).toBe('');
  });

  it('dev fallback is used only when VITE_BACKEND_URL is unset', () => {
    expect(resolveBackendUrl(undefined, 'http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(resolveBackendUrl('/', 'http://127.0.0.1:8787')).toBe('');
  });

  it('VITE_BACKEND_URL=/ resolves to "" (trailing slashes stripped)', () => {
    expect(resolveBackendUrl('/', '')).toBe('');
    expect(resolveBackendUrl('https://api.example.com//', '')).toBe('https://api.example.com');
  });
});
