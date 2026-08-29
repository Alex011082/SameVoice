#!/usr/bin/env bash
# Install livekit-server (and the optional `lk` CLI) on macOS. Idempotent.
#
# Homebrew is the ONLY supported path on macOS: LiveKit's install.sh hard-aborts
# on Darwin and there is no darwin binary in the GitHub releases. The remaining
# alternative would be compiling from source with a Go toolchain.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MIN_SERVER_VERSION="1.13.5"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m ok\033[0m %s\n' "$*"; }

if [ "$(uname -s)" != "Darwin" ]; then
  die "this installer supports macOS only (found $(uname -s)).
     On Linux use LiveKit's official install script:
       curl -sSL https://get.livekit.io | bash"
fi

if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew not found and it is the only supported macOS install path.
     Install it from https://brew.sh, then re-run: npm run deps:livekit"
fi

if command -v livekit-server >/dev/null 2>&1; then
  ok "livekit-server already installed: $(livekit-server --version 2>&1 | head -1)"
else
  info "installing livekit-server (expecting >= ${MIN_SERVER_VERSION}) ..."
  brew install livekit
  command -v livekit-server >/dev/null 2>&1 \
    || die "brew install livekit finished but livekit-server is not on PATH.
     Check that $(brew --prefix)/bin is in your PATH."
  ok "installed $(livekit-server --version 2>&1 | head -1)"
fi

# `lk` is not required by any SpeakEasy code path — it is only a convenience for
# minting throwaway tokens and joining rooms by hand while debugging.
if command -v lk >/dev/null 2>&1; then
  ok "livekit-cli already installed: $(lk --version 2>&1 | head -1)"
else
  info "installing livekit-cli (optional debugging tool) ..."
  brew install livekit-cli || printf '\033[33mwarn:\033[0m livekit-cli install failed; this is optional, continuing.\n'
fi

info "validating livekit.yaml against the installed server ..."
livekit-server --config "$ROOT/livekit.yaml" ports

cat <<'EOF'

Next:
  npm run dev:livekit     # start the SFU on its own
  npm run dev             # start the whole stack

Note: `livekit-server generate-keys` prints a fresh key/secret pair. If you use
one, change it in BOTH livekit.yaml and .env — they must match exactly.
EOF
