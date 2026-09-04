#!/usr/bin/env bash
# Fails if the dev backend address leaked into the production web bundle.
#
# Guard against the 31.08.2026 outage: web/dist was built without
# VITE_BACKEND_URL, http://127.0.0.1:8787 got baked into the .js, and every
# phone that opened samevoice.0110.digital sent its API calls to itself.
# api.ts now defaults to same-origin outside dev, but this check catches the
# whole class (a stray .env value, a future regression) at build time instead
# of on the tester's phone.
#
# Only *.js is checked. The *.js.map files legitimately contain the literal —
# they embed the sources, where the address remains as the dev-only fallback.
set -euo pipefail
cd "$(dirname "$0")/.."

DIST="web/dist/assets"
if [ ! -d "$DIST" ]; then
  echo "check-web-dist: $DIST not found — run the build first (npm run build:web)" >&2
  exit 1
fi

if grep -l '127\.0\.0\.1:8787' "$DIST"/*.js 2>/dev/null; then
  echo "check-web-dist: FAILED — the dev backend address is baked into the bundle above." >&2
  echo "Rebuild via 'npm run build:web' (it forces VITE_BACKEND_URL=/) and do not deploy this dist." >&2
  exit 1
fi

echo "check-web-dist: OK — web/dist is same-origin, no dev backend address in the bundle"
