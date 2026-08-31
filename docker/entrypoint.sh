#!/usr/bin/env bash
set -euo pipefail

ROOT="/opt/samevoice"
WORKSPACE="${WORKSPACE_ROOT:-/workspace}"
CONFIG_FILE="${SAMEVOICE_CONFIG_FILE:-${WORKSPACE}/config/samevoice.env}"

cd "$ROOT"

log() { printf '[samevoice] %s\n' "$*"; }
truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

# Optional persistent runtime config. Prefer RunPod Secrets/environment for
# secrets; this file is only a convenience for non-secret deployment settings.
if [[ -f "$CONFIG_FILE" ]]; then
  log "loading runtime config from $CONFIG_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
fi

mkdir -p \
  "${MODEL_DIR:-${WORKSPACE}/models}" \
  "${CHECKPOINT_DIR:-${WORKSPACE}/checkpoints}" \
  "${DATASET_DIR:-${WORKSPACE}/datasets}" \
  "${BENCHMARK_DIR:-${WORKSPACE}/benchmarks}" \
  "${HF_HOME:-${WORKSPACE}/hf-cache}" \
  "${TORCH_HOME:-${WORKSPACE}/torch-cache}" \
  "${XDG_CACHE_HOME:-${WORKSPACE}/cache}" \
  "${UV_CACHE_DIR:-${WORKSPACE}/uv-cache}" \
  "${CALL_ARCHIVE_DIR:-${WORKSPACE}/logs/archive}" \
  "${EVAL_LOG_DIR:-${WORKSPACE}/logs/calls}" \
  "${IDENTITY_DIR:-${WORKSPACE}/data/identity}" \
  "${WORKSPACE}/config"

# One directory on that list is tightened, and only this one: its
# identities.json holds the phone numbers — the phone->user index that stops one
# number minting a second profile IS the numbers. The backend writes that file
# 0600 and would create the directory 0700, but the mkdir -p above gets there
# first with the umask default, and mkdir does not re-chmod a directory that is
# already present. Doing it here also covers the mounted-volume case, where the
# directory outlives every container that has ever written to it.
chmod 700 "${IDENTITY_DIR:-${WORKSPACE}/data/identity}"

# Explicit opt-in only. This makes a keyless mock container bootable for local
# smoke tests without silently using development credentials in a real Pod.
if truthy "${SAMEVOICE_BOOTSTRAP_MOCK_ENV:-0}" && [[ ! -f "$ROOT/.env" ]]; then
  log "bootstrapping mock .env from .env.example"
  cp "$ROOT/.env.example" "$ROOT/.env"
fi

# Keep persistent paths out of the ephemeral container filesystem even if a
# copied .env still contains the historical repo-relative defaults.
export MODEL_DIR="${MODEL_DIR:-${WORKSPACE}/models}"
export CHECKPOINT_DIR="${CHECKPOINT_DIR:-${WORKSPACE}/checkpoints}"
export DATASET_DIR="${DATASET_DIR:-${WORKSPACE}/datasets}"
export BENCHMARK_DIR="${BENCHMARK_DIR:-${WORKSPACE}/benchmarks}"
export HF_HOME="${HF_HOME:-${WORKSPACE}/hf-cache}"
export TORCH_HOME="${TORCH_HOME:-${WORKSPACE}/torch-cache}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${WORKSPACE}/cache}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-${WORKSPACE}/uv-cache}"
export CALL_ARCHIVE_DIR="${CALL_ARCHIVE_DIR:-${WORKSPACE}/logs/archive}"
export EVAL_LOG_DIR="${EVAL_LOG_DIR:-${WORKSPACE}/logs/calls}"
# The identity snapshot — every phone-registered profile and the contact graph.
# Left at its repo-relative default it would sit on the container overlay and
# die with the container, which is the exact failure it was written to end.
export IDENTITY_DIR="${IDENTITY_DIR:-${WORKSPACE}/data/identity}"

export BACKEND_HOST="${BACKEND_HOST:-0.0.0.0}"
export AGENT_HOST="${AGENT_HOST:-127.0.0.1}"
export BACKEND_PORT="${BACKEND_PORT:-8787}"
export AGENT_PORT="${AGENT_PORT:-8788}"
export WEB_PORT="${WEB_PORT:-5173}"

PIDS=()
NAMES=()

start_process() {
  local name="$1"
  shift
  log "starting ${name}: $*"
  "$@" &
  PIDS+=("$!")
  NAMES+=("$name")
}

start_gpu_hook() {
  local name="$1"
  local gpu="$2"
  local command="$3"
  [[ -z "$command" ]] && return 0
  log "starting ${name} on CUDA_VISIBLE_DEVICES=${gpu}"
  env CUDA_VISIBLE_DEVICES="$gpu" bash -lc "$command" &
  PIDS+=("$!")
  NAMES+=("$name")
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if ((${#PIDS[@]} > 0)); then
    log "stopping child services"
    kill "${PIDS[@]}" 2>/dev/null || true
    wait "${PIDS[@]}" 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

# GPU hooks are explicit so every experiment can be switched independently.
# The acoustic pruner is a separate Stage-2 benchmark service on GPU0; it does
# not become part of the audible path merely because it is running.
start_gpu_hook "acoustic-scout" "${ACOUSTIC_CUDA_VISIBLE_DEVICES:-0}" "${ACOUSTIC_SCOUT_CMD:-}"
start_gpu_hook "acoustic-pruner" "${ACOUSTIC_PRUNER_CUDA_VISIBLE_DEVICES:-0}" "${ACOUSTIC_PRUNER_CMD:-}"
start_gpu_hook "predictor" "${PREDICTOR_CUDA_VISIBLE_DEVICES:-0}" "${PREDICTOR_CMD:-}"
start_gpu_hook "local-mt" "${LOCAL_MT_CUDA_VISIBLE_DEVICES:-0}" "${LOCAL_MT_CMD:-}"
start_gpu_hook "local-tts" "${TTS_CUDA_VISIBLE_DEVICES:-1}" "${LOCAL_TTS_CMD:-}"

if truthy "${SAMEVOICE_START_AGENT:-1}"; then
  start_process "agent" bash -lc 'cd /opt/samevoice/agent && uv run python -m speakeasy_agent.main'
fi

if truthy "${SAMEVOICE_START_BACKEND:-1}"; then
  start_process "backend" node /opt/samevoice/backend/dist/index.js
fi

if truthy "${SAMEVOICE_START_WEB:-1}"; then
  start_process "web" npm --prefix /opt/samevoice/web run preview -- --host 0.0.0.0
fi

if ((${#PIDS[@]} == 0)); then
  log "nothing was configured to start"
  exit 1
fi

log "services started; web=${WEB_PORT} backend=${BACKEND_PORT} agent=${AGENT_PORT}"

# Any long-running service exiting is considered a failed Pod. The outer
# orchestrator can then restart it rather than leaving a half-alive benchmark.
set +e
wait -n "${PIDS[@]}"
status=$?
set -e

for i in "${!PIDS[@]}"; do
  if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
    log "service exited: ${NAMES[$i]} (pid=${PIDS[$i]}, status=${status})"
  fi
done

exit "$status"
