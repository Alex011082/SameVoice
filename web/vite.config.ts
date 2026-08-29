// `vitest/config` re-exports vite's `defineConfig` widened with the `test`
// block, but it does NOT re-export `loadEnv` — that one has to come from vite
// itself, or vitest fails to load this file at startup.
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// The repo root holds the single shared .env (see .env.example). Vite resolves
// `envDir` relative to the project root, which is this directory.
const REPO_ROOT = '..';

/**
 * Hostnames the dev/preview server will answer to on top of the ones Vite
 * always allows (localhost, *.localhost and bare IPs).
 *
 * Vite 8 refuses any other Host header — the DNS-rebinding guard — and the
 * refusal is a bare "Blocked request" page that says nothing about tunnels, so
 * without this line a remote tester sees a broken site and the cause is
 * invisible. The leading dot covers every subdomain, which matters because a
 * Cloudflare quick tunnel gets a fresh random name on each start.
 *
 * Deliberately NOT `true`: that would let any website on the internet make
 * requests to this dev server and read the source.
 */
const TUNNEL_HOSTS = ['.trycloudflare.com', '.ngrok-free.app', '.ngrok-free.dev', '.ts.net'];

// This file is transpiled by esbuild, never type-checked, and is therefore
// deliberately excluded from tsconfig.json's `include`.
export default defineConfig(({ mode }) => {
  // Empty prefix so non-VITE_ vars (WEB_PORT) are readable here at config time.
  // Only VITE_-prefixed vars are ever exposed to browser code.
  // `loadEnv`'s envDir is resolved from the process cwd, which npm sets to this
  // package directory for every `npm --prefix web run <script>` invocation.
  const env = loadEnv(mode, REPO_ROOT, '');
  const port = Number(env.WEB_PORT) || 5173;
  const backendPort = Number(env.BACKEND_PORT) || 8787;

  // Same-origin API. Run the client as `VITE_BACKEND_URL=/ npm run dev` and
  // every fetch becomes a relative one that lands here and is forwarded to the
  // backend on loopback. That is what makes ONE public https origin enough:
  // one tunnel, no second hostname, no CORS entry to widen, and no mixed
  // content when the page is served over https.
  const proxy = {
    '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false },
    '/healthz': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false },
  };

  return {
    envDir: REPO_ROOT,
    // host:true binds 0.0.0.0 so a phone on the LAN can load the page.
    // iOS Safari will still refuse getUserMedia over plain http://<lan-ip>
    // because that is not a secure context - see docs/04-runbook.md. The client
    // detects that case explicitly (web/src/secure.ts) instead of letting it
    // surface as a generic "microphone blocked".
    // strictPort: a silent fallback to 5174 would strand the tester on the
    // hard-coded :5173 links in the README, the runbook and scripts/dev.sh.
    server: { host: true, port, strictPort: true, allowedHosts: TUNNEL_HOSTS, proxy },
    preview: { host: true, port, allowedHosts: TUNNEL_HOSTS, proxy },
    build: { target: 'es2022', sourcemap: true },
    test: {
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  };
});
