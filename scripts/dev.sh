#!/usr/bin/env bash
# Start the whole SpeakEasy dev stack.
#
#   local profile:  livekit-server + backend + agent + web
#   cloud profile:  backend + agent + web        (LiveKit Cloud is the SFU, so
#                                                 no local server is started)
#
#   bash scripts/dev.sh                    # profile from .env
#   SPEAKEASY_PROFILE=cloud bash scripts/dev.sh   # == npm run dev:cloud
#
# Every service streams to the console with a [name] prefix and, at the same
# time, to logs/<name>.log. Ctrl-C (or any exit of this script) tears down the
# entire process tree — including grandchildren such as tsx/vite/python, which
# a plain `kill $!` would leave orphaned and holding their ports.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOGS="$ROOT/logs"
mkdir -p "$LOGS"

C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_MAGENTA=$'\033[35m'; C_CYAN=$'\033[36m'
C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'

die()  { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
info() { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }

CHILD_PIDS=()

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  # Nothing was started yet (a pre-flight check failed) — exit quietly.
  [ "${#CHILD_PIDS[@]}" -eq 0 ] && return 0
  printf '\n%s==>%s shutting down ...\n' "$C_CYAN" "$C_RESET"
  local pid
  for pid in "${CHILD_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill_tree "$pid"
  done
  # Give everything a moment to release ports before the shell prompt returns.
  sleep 1
  for pid in "${CHILD_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true
  done
  printf '%s==>%s stopped. logs kept in %s\n' "$C_CYAN" "$C_RESET" "$LOGS"
  printf '%s    eval logs (source, translation, judge verdicts) are NOT deleted: %s%s\n' \
    "$C_DIM" "${EVAL_LOG_DIR:-logs/calls}" "$C_RESET"
}
trap cleanup EXIT INT TERM

# start <name> <color> <command...>
start() {
  local name="$1" color="$2"; shift 2
  local log="$LOGS/$name.log"
  : >"$log"
  # `2>&1` inside merges the service's stderr into the prefixed stream; the
  # `2>/dev/null` outside silences only the subshell's own job-control chatter
  # ("Terminated: 15"), which would otherwise make a clean Ctrl-C look like a crash.
  (
    "$@" 2>&1 | awk -v p="${color}[${name}]${C_RESET} " '{ print p $0; fflush() }' | tee -a "$log"
  ) 2>/dev/null &
  CHILD_PIDS+=("$!")
  printf '%s==>%s started %-8s -> %s\n' "$C_CYAN" "$C_RESET" "$name" "$log"
}

# ---------------------------------------------------------------- pre-flight
# An explicit SPEAKEASY_PROFILE on the command line must survive `. .env`.
PROFILE_OVERRIDE="${SPEAKEASY_PROFILE:-}"

if [ ! -f "$ROOT/.env" ]; then
  info "no .env found — creating one from .env.example (local profile, mock providers, no keys)"
  cp "$ROOT/.env.example" "$ROOT/.env"
fi

# check-env.mjs honours the same override, so the profile it validates is the
# profile this script is about to run.
SPEAKEASY_PROFILE="$PROFILE_OVERRIDE" node "$ROOT/scripts/check-env.mjs" \
  || die "environment check failed — fix .env and retry"

set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

PROFILE="${PROFILE_OVERRIDE:-${SPEAKEASY_PROFILE:-local}}"
export SPEAKEASY_PROFILE="$PROFILE"

# The eval log is the point of a test session; make sure the directory exists
# before the agent needs it, so a first call never fails on a missing path.
EVAL_LOG_DIR="${EVAL_LOG_DIR:-logs/calls}"
mkdir -p "$ROOT/$EVAL_LOG_DIR"

MISSING=()
[ -d "$ROOT/backend/node_modules" ] || MISSING+=("backend/node_modules  (npm run deps:backend)")
[ -d "$ROOT/web/node_modules" ]     || MISSING+=("web/node_modules      (npm run deps:web)")
[ -d "$ROOT/agent/.venv" ]          || MISSING+=("agent/.venv           (npm run deps:agent)")
if [ "${#MISSING[@]}" -gt 0 ]; then
  printf '%serror:%s dependencies are not installed:\n' "$C_RED" "$C_RESET" >&2
  printf '         %s\n' "${MISSING[@]}" >&2
  die "run:  npm run deps"
fi
command -v uv >/dev/null 2>&1 || die "uv not found on PATH (needed to run the agent). See https://docs.astral.sh/uv/"

# ------------------------------------------------------------------ services
# Order matters only for readability: the SFU and backend are up before the
# agent tries to accept a job and before the web client can fetch /api/config.
if [ "$PROFILE" = "cloud" ]; then
  info "cloud profile — LiveKit Cloud is the SFU; not starting a local livekit-server"
  info "               (nothing would connect to it, and it would hold 7880/7881/50000-50100)"
else
  start livekit "$C_MAGENTA" bash "$ROOT/scripts/livekit.sh"
  sleep 1
fi

start backend "$C_GREEN"   npm --prefix "$ROOT/backend" run dev
sleep 1
start agent   "$C_BLUE"    sh -c "cd '$ROOT/agent' && exec uv run python -m speakeasy_agent.main"
sleep 1
start web     "$C_YELLOW"  npm --prefix "$ROOT/web" run dev -- --host

# -------------------------------------------------------------------- banner
if [ "$PROFILE" = "cloud" ]; then
  if [ -n "${PUBLIC_WEB_ORIGIN:-}" ]; then
    WEB_BASE="$PUBLIC_WEB_ORIGIN"
    ORIGIN_NOTE=""
  else
    # check-env makes this unreachable in the cloud profile, but a hand-edited
    # .env plus an env override could still get here.
    WEB_BASE="http://localhost:${WEB_PORT:-5173}"
    ORIGIN_NOTE="  ${C_RED}PUBLIC_WEB_ORIGIN is empty — run 'npm run tunnel' in another terminal.${C_RESET}"
  fi
else
  WEB_BASE="http://localhost:${WEB_PORT:-5173}"
  ORIGIN_NOTE=""
fi

cat <<EOF

${C_CYAN}==>${C_RESET} SpeakEasy dev stack  ${C_BOLD}profile=${PROFILE}${C_RESET}
${ORIGIN_NOTE}
  you (u_alex)   ${C_BOLD}${WEB_BASE}/?me=u_alex${C_RESET}     (ru, male,   neutral)
  her (u_noa)    ${C_BOLD}${WEB_BASE}/?me=u_noa${C_RESET}      (he, female, friendly)

  These two need ${C_BOLD}AUTH_SEEDED_LOGIN=true${C_RESET} in .env: ?me= names a seeded
  test profile, it no longer signs you in by itself. Without the flag, the
  page shows the phone login instead (docs/04-runbook.md).
EOF

if [ "$PROFILE" = "cloud" ]; then
  cat <<EOF

  ${C_YELLOW}Send her this link${C_RESET} — it is the whole deployment:

      ${C_BOLD}${WEB_BASE}/?me=u_noa${C_RESET}

  Tell her: open it in Chrome or Safari on a laptop, click Allow when it asks
  for the microphone, and ${C_BOLD}use headphones${C_RESET}. Without headphones her speaker
  output re-enters her microphone and the agent transcribes the Russian
  translation back into the Hebrew->Russian direction.

  Open the same public origin on THIS Mac too (not localhost): the in-app
  invite link is built from window.location, so from localhost you would copy
  a link that cannot work on her machine.
EOF
fi

cat <<EOF

  backend        ${BACKEND_PUBLIC_URL:-http://127.0.0.1:8787}/healthz
  agent          http://127.0.0.1:${AGENT_PORT:-8788}/healthz      (activeCalls must stay 0 during a DIRECT call)
  livekit        ${LIVEKIT_URL:-ws://127.0.0.1:7880}$( [ "$PROFILE" = "cloud" ] && printf '  (LiveKit Cloud — no local SFU)' || printf '  (local SFU, this Mac)' )
  providers      stt=${STT_PROVIDER:-mock}  mt=${MT_PROVIDER:-mock}  tts=${TTS_PROVIDER:-mock}
  eval log       ${EVAL_LOG_DIR}/<callId>.jsonl
                 ${C_DIM}read it back: cd agent && uv run python scripts/review_call.py <callId>
                 (not 'npm run review' — that wrapper reads different field names
                  than the agent writes and prints 0 utterances; runbook §12.3)${C_RESET}

  Ctrl-C stops everything.

EOF

# `wait` on the whole job table; the EXIT trap does the actual teardown.
wait || true
