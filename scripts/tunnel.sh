#!/usr/bin/env bash
# Open a public HTTPS origin in front of the local Vite dev server, so a second
# tester on another machine and another network can load the page AND be allowed
# to use their microphone.
#
# Why this exists at all: getUserMedia only runs in a "secure context".
# http://localhost and http://127.0.0.1 qualify; http://<your-lan-ip>:5173 does
# NOT, and no browser flag or self-signed certificate changes that. Without a
# real https origin the second tester never sees a microphone prompt, and the
# failure looks like a LiveKit problem.
#
# What this tunnel does NOT do, and must not be expected to do: carry audio.
# WebRTC media is UDP/ICE/SRTP and goes straight from each browser to a LiveKit
# Cloud edge. A tunnel carries HTTP and WebSocket only — the page, its assets,
# and the JSON REST API. That is exactly why the cloud profile pairs this tunnel
# with LiveKit Cloud rather than with the local SFU: a tunnel in front of a local
# livekit-server produces the most deceptive failure in the whole stack — the
# room connects, the participant list populates, and there is simply no audio.
#
#   bash scripts/tunnel.sh            # ==  npm run tunnel
#
# Ctrl-C stops the tunnel. Nothing is left running.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'

die()  { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
info() { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }

# Remember an explicit override before .env clobbers it.
PROFILE_OVERRIDE="${SPEAKEASY_PROFILE:-}"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

PROFILE="${PROFILE_OVERRIDE:-${SPEAKEASY_PROFILE:-local}}"
WEB_PORT="${WEB_PORT:-5173}"
TARGET="http://127.0.0.1:${WEB_PORT}"

LOGS="$ROOT/logs"
mkdir -p "$LOGS"
TUNNEL_LOG="$LOGS/tunnel.log"
PID_FILE="$LOGS/tunnel.pid"

# ---------------------------------------------------------------- pre-flight
# A previous run that was killed with SIGKILL (or whose terminal was destroyed
# before the trap could fire) leaves cloudflared alive, still serving the dev
# server to the open internet with no authentication. Close it before opening
# another one, rather than accumulating tunnels nobody remembers starting.
if [ -f "$PID_FILE" ]; then
  STALE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null &&
     ps -o command= -p "$STALE_PID" 2>/dev/null | grep -q cloudflared; then
    printf '%swarn:%s a tunnel from an earlier run is still up (pid %s) — closing it.\n' \
      "$C_YELLOW" "$C_RESET" "$STALE_PID"
    kill -TERM "$STALE_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  die "cloudflared not found on PATH.

     Install it with:

         brew install cloudflared

     No Cloudflare account, no signup and no payment method are required — a
     'quick tunnel' is anonymous by design. (ngrok is deliberately NOT used
     here: it requires an account and shows an interstitial warning page that
     a non-technical second tester has to click through, and which would break
     same-origin API calls.)"
fi

if [ "$PROFILE" != "cloud" ]; then
  printf '%swarn:%s SPEAKEASY_PROFILE=%s. A public origin is only useful in the cloud\n' \
    "$C_YELLOW" "$C_RESET" "$PROFILE"
  printf '       profile — in the local profile the browser talks to a livekit-server on this\n'
  printf '       Mac over ws://, which an https page cannot open (mixed content). Set\n'
  printf '       SPEAKEASY_PROFILE=cloud in .env before using the URL below.\n\n'
fi

# The tunnel is useless if nothing is listening: cloudflared happily connects
# and every request 502s, which reads as "the tunnel is broken".
if ! curl -s -o /dev/null --max-time 2 "$TARGET"; then
  printf '%swarn:%s nothing is answering on %s yet.\n' "$C_YELLOW" "$C_RESET" "$TARGET"
  printf '       Start the stack first (npm run dev:cloud) or the tunnel will serve 502s.\n'
  printf '       Continuing anyway — cloudflared will pick it up once Vite is listening.\n\n'
fi

# ----------------------------------------------------------------- teardown
TUNNEL_PID=""
TAIL_PID=""
cleanup() {
  trap - EXIT INT TERM HUP
  # Kill the log follower first, or it keeps this script's stdout open and the
  # shell prompt never comes back. The `wait` inside the braces reaps it so bash
  # does not print its own "Terminated: 15" job-control line, which reads like a
  # crash at the end of an otherwise clean shutdown.
  if [ -n "$TAIL_PID" ]; then
    { kill -TERM "$TAIL_PID"; wait "$TAIL_PID"; } 2>/dev/null || true
  fi
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    printf '\n%s==>%s closing tunnel ...\n' "$C_CYAN" "$C_RESET"
    kill -TERM "$TUNNEL_PID" 2>/dev/null || true
    # cloudflared unregisters the hostname on SIGTERM; give it a moment, then
    # make sure. A left-running tunnel publishes the dev server to the open
    # internet with no authentication.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$TUNNEL_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "$TUNNEL_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  printf '%s==>%s tunnel closed. The URL above is dead — the next run gets a new one.\n' \
    "$C_CYAN" "$C_RESET"
  printf '%s    remember to clear PUBLIC_WEB_ORIGIN in .env, or paste the new URL next time.%s\n' \
    "$C_DIM" "$C_RESET"
}
trap cleanup EXIT INT TERM HUP

# -------------------------------------------------------------------- launch
info "cloudflared $(cloudflared --version 2>&1 | head -1 | awk '{print $3}')  ->  $TARGET"
: >"$TUNNEL_LOG"

# --no-autoupdate: an update mid-session would restart the tunnel and change the
# hostname, invalidating a link that has already been sent.
cloudflared tunnel --no-autoupdate --url "$TARGET" >>"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!
printf '%s\n' "$TUNNEL_PID" >"$PID_FILE"

# cloudflared prints the assigned hostname to its log within ~10 s.
URL=""
for _ in $(seq 1 60); do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    printf '%s---- cloudflared output ----%s\n' "$C_DIM" "$C_RESET" >&2
    cat "$TUNNEL_LOG" >&2
    die "cloudflared exited before it published a hostname (log: $TUNNEL_LOG)"
  fi
  URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 0.5
done

if [ -z "$URL" ]; then
  printf '%s---- cloudflared output ----%s\n' "$C_DIM" "$C_RESET" >&2
  tail -40 "$TUNNEL_LOG" >&2
  die "cloudflared did not print a https://<...>.trycloudflare.com hostname within 30 s (log: $TUNNEL_LOG)"
fi

# ------------------------------------------------------------------ operator
cat <<EOF

${C_GREEN}==>${C_RESET} public HTTPS origin is live

    ${C_BOLD}${URL}${C_RESET}

${C_CYAN}==>${C_RESET} now do exactly this, in this order:

  1. Put the URL in .env (and nothing else about it):

         ${C_BOLD}PUBLIC_WEB_ORIGIN=${URL}${C_RESET}

     While you are in .env, the cloud profile also needs:

         SPEAKEASY_PROFILE=cloud
         VITE_BACKEND_URL=/          ${C_DIM}# same origin; Vite proxies /api + /healthz${C_RESET}
         LIVEKIT_URL=wss://<your-project>.livekit.cloud

  2. ${C_BOLD}Restart the web dev server.${C_RESET} Vite reads .env once, at start-up — a running
     Vite will not pick up the new value, and the page will keep pointing at
     the old origin with no visible error. Backend and agent do NOT need a
     restart; nothing they do depends on this URL.

  3. Verify:  ${C_BOLD}npm run check:env${C_RESET}      ${C_DIM}(with SPEAKEASY_PROFILE=cloud it enforces
                                     https + wss and refuses the dev keys)${C_RESET}

  4. Open the ${C_BOLD}tunnel${C_RESET} URL on this Mac too — not localhost. The invite link is
     built from window.location, so from localhost you would copy a localhost
     link that cannot work on her machine.

         you    ${URL}/?me=u_alex
         her    ${URL}/?me=u_noa

       (both need AUTH_SEEDED_LOGIN=true — ?me= names a seeded test profile,
        it does not sign anyone in on its own)

  ${C_YELLOW}Notes that cost time if you learn them the hard way:${C_RESET}
    - This hostname is ${C_BOLD}single-use${C_RESET}. Restarting this script gets a different one,
      invalidates the link you already sent, and makes the browser treat it as
      a new origin — so it will ask for microphone permission again. Start it
      once and leave it up for the whole session.
    - web/vite.config.ts must allow this host (\`allowedHosts: ['.trycloudflare.com']\`).
      Without it Vite answers a bare "Blocked request" page that says nothing
      about tunnels.
    - This tunnel carries the page and the REST API only. Audio never touches
      it — that is LiveKit Cloud's job, over UDP, directly.

  Ctrl-C here closes the tunnel.

EOF

# Stream cloudflared's own output from here on, so connection errors are visible.
# Both this follower and cloudflared itself are torn down by cleanup(), which
# runs on Ctrl-C, on SIGTERM, and on any exit of this script.
tail -f "$TUNNEL_LOG" &
TAIL_PID=$!
wait "$TUNNEL_PID" 2>/dev/null || true
