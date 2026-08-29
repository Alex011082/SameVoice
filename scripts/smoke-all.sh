#!/usr/bin/env bash
# The day-one "does the skeleton work" gate.
#
# Runs the three offline test suites in sequence and exits non-zero on the first
# failure. No network, no API keys, no LiveKit server, no browser.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_CYAN=$'\033[36m'

fail() { printf '%sFAIL%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
step() { printf '\n%s==> %s%s\n' "$C_CYAN" "$*" "$C_RESET"; }

step "env"
node "$ROOT/scripts/check-env.mjs" || fail "check-env"

step "backend  (node:test)"
[ -d "$ROOT/backend/node_modules" ] || fail "backend deps missing — run: npm run deps:backend"
npm --prefix "$ROOT/backend" test || fail "backend tests"

step "agent    (pytest)"
[ -d "$ROOT/agent/.venv" ] || fail "agent venv missing — run: npm run deps:agent"
( cd "$ROOT/agent" && uv run pytest -q ) || fail "agent tests"

step "web      (vitest)"
[ -d "$ROOT/web/node_modules" ] || fail "web deps missing — run: npm run deps:web"
npm --prefix "$ROOT/web" test || fail "web tests"

# The panel has no dependencies to install: plain node:test over plain .mjs.
step "panel    (node:test)"
node --test "$ROOT/panel/test/*.mjs" || fail "panel tests"

printf '\n%sPASS%s all smoke tests green\n' "$C_GREEN" "$C_RESET"
