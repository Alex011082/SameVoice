#!/usr/bin/env bash
# Start the local LiveKit SFU with the committed config.
#
# Skips entirely (exit 0) when LIVEKIT_URL does not point at this machine —
# that is LiveKit Cloud mode, where no local SFU should be running at all.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# `. .env` below overwrites every variable it declares, so an explicit
# `SPEAKEASY_PROFILE=cloud bash scripts/livekit.sh` has to be remembered first or
# the file silently wins and a local SFU starts anyway.
PROFILE_OVERRIDE="${SPEAKEASY_PROFILE:-}"

# .env is a plain KEY=value file; values containing spaces must be quoted there.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
PROFILE="${PROFILE_OVERRIDE:-${SPEAKEASY_PROFILE:-local}}"

# The profile is the declared intent; the URL is the mechanism. Honour the
# declared intent first, so `npm run dev:livekit` in the cloud profile does not
# quietly bind 7880/7881/50000-50100 for a server nothing will ever connect to.
if [ "$PROFILE" = "cloud" ]; then
  printf '\033[33mskip:\033[0m SPEAKEASY_PROFILE=cloud — LiveKit Cloud is the SFU. Not starting livekit-server.\n'
  exit 0
fi

case "$LIVEKIT_URL" in
  *localhost*|*127.0.0.1*|*0.0.0.0*)
    ;;
  *)
    printf '\033[33mskip:\033[0m LIVEKIT_URL=%s is not local — using a remote SFU (LiveKit Cloud). Not starting livekit-server.\n' "$LIVEKIT_URL"
    exit 0
    ;;
esac

if ! command -v livekit-server >/dev/null 2>&1; then
  die "livekit-server not found on PATH.
     Install it with:  npm run deps:livekit
     (that runs \`brew install livekit\` — Homebrew is the only supported macOS path;
      the curl installer from get.livekit.io aborts on Darwin)"
fi

[ -f "$ROOT/livekit.yaml" ] || die "livekit.yaml missing from the repo root"

printf '\033[36m==>\033[0m livekit-server %s  config=%s\n' \
  "$(livekit-server --version 2>&1 | head -1)" "$ROOT/livekit.yaml"

# exec so signals from the parent (scripts/dev.sh, Ctrl-C) reach the server
# directly instead of being swallowed by this wrapper.
exec livekit-server --config "$ROOT/livekit.yaml"
