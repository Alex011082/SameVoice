#!/usr/bin/env bash
set -euo pipefail

# Explicitly download/load the selected local models after a Pod starts. This is
# intentionally NOT part of container startup: first-boot weight downloads can
# take minutes and should be visible, interruptible work rather than a hidden
# healthcheck side effect.

PREDICTOR_URL="${PREDICTOR_URL:-http://127.0.0.1:8101}"
ACOUSTIC_URL="${ACOUSTIC_SCOUT_URL:-http://127.0.0.1:8102}"
MT_URL="${LOCAL_MT_URL:-http://127.0.0.1:8103}"
TTS_URL="${LOCAL_TTS_URL:-http://127.0.0.1:8104}"

wait_health() {
  local name="$1" url="$2"
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "$url/healthz" >/dev/null 2>&1; then
      printf 'ready: %s (%s)\n' "$name" "$url"
      return 0
    fi
    sleep 1
  done
  printf 'ERROR: %s did not become healthy: %s\n' "$name" "$url" >&2
  return 1
}

post() {
  local label="$1" url="$2" body="${3:-{}}"
  printf '\n==> %s\n' "$label"
  time curl -fsS --max-time 1800 \
    -H 'content-type: application/json' \
    -d "$body" \
    "$url"
  printf '\n'
}

[[ -n "${PREDICTOR_CMD:-}" ]] && wait_health predictor "$PREDICTOR_URL"
[[ -n "${ACOUSTIC_SCOUT_CMD:-}" ]] && wait_health acoustic "$ACOUSTIC_URL"
[[ -n "${LOCAL_MT_CMD:-}" ]] && wait_health local-mt "$MT_URL"
[[ -n "${LOCAL_TTS_CMD:-}" ]] && wait_health local-tts "$TTS_URL"

if [[ -n "${PREDICTOR_CMD:-}" ]]; then
  post 'warm predictor' "$PREDICTOR_URL/v1/warmup"
fi

if [[ -n "${ACOUSTIC_SCOUT_CMD:-}" ]]; then
  post 'warm acoustic Russian (Nemotron streaming)' "$ACOUSTIC_URL/v1/warmup" '{"lang":"ru"}'
  post 'warm acoustic Hebrew (ivrit.ai Whisper)' "$ACOUSTIC_URL/v1/warmup" '{"lang":"he"}'
fi

if [[ -n "${LOCAL_MT_CMD:-}" ]]; then
  post 'warm RU<->HE local MT' "$MT_URL/v1/warmup"
fi

if [[ -n "${LOCAL_TTS_CMD:-}" ]]; then
  post 'warm local TTS A/B' "$TTS_URL/v1/warmup"
fi

printf '\nGPU memory after warmup:\n'
nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv,noheader
