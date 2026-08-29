#!/usr/bin/env bash
set -euo pipefail

curl -fsS --max-time 2 "http://127.0.0.1:${BACKEND_PORT:-8787}/healthz" >/dev/null
curl -fsS --max-time 2 "http://127.0.0.1:${AGENT_PORT:-8788}/healthz" >/dev/null
curl -fsS --max-time 2 "http://127.0.0.1:${WEB_PORT:-5173}/" >/dev/null

# Local GPU engines are optional. If a command hook is enabled, its service must
# also answer health checks; otherwise Docker must not report a half-working R&D
# Pod as healthy.
if [[ -n "${PREDICTOR_CMD:-}" ]]; then
  curl -fsS --max-time 2 "${PREDICTOR_URL:-http://127.0.0.1:8101}/healthz" >/dev/null
fi
if [[ -n "${ACOUSTIC_SCOUT_CMD:-}" ]]; then
  curl -fsS --max-time 2 "${ACOUSTIC_SCOUT_URL:-http://127.0.0.1:8102}/healthz" >/dev/null
fi
if [[ -n "${LOCAL_MT_CMD:-}" ]]; then
  curl -fsS --max-time 2 "${LOCAL_MT_URL:-http://127.0.0.1:8103}/healthz" >/dev/null
fi
if [[ -n "${LOCAL_TTS_CMD:-}" ]]; then
  curl -fsS --max-time 2 "${LOCAL_TTS_URL:-http://127.0.0.1:8104}/healthz" >/dev/null
fi
