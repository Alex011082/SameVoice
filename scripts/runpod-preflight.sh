#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${WORKSPACE_ROOT:-/workspace}"
EXPECTED_GPU_COUNT="${EXPECTED_GPU_COUNT:-2}"

printf 'SameVoice RunPod preflight\n'
printf 'workspace: %s\n' "$WORKSPACE"
printf 'expected GPUs: %s\n\n' "$EXPECTED_GPU_COUNT"

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo 'ERROR: nvidia-smi is not available. This is not a GPU-ready runtime.' >&2
  exit 1
fi

gpu_count="$(nvidia-smi --query-gpu=name --format=csv,noheader | sed '/^$/d' | wc -l | tr -d ' ')"
if (( gpu_count < EXPECTED_GPU_COUNT )); then
  echo "ERROR: expected at least ${EXPECTED_GPU_COUNT} GPU(s), found ${gpu_count}." >&2
  nvidia-smi -L >&2 || true
  exit 1
fi

echo 'GPUs:'
nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader

echo
mkdir -p \
  "$WORKSPACE/models" \
  "$WORKSPACE/checkpoints" \
  "$WORKSPACE/datasets" \
  "$WORKSPACE/benchmarks" \
  "$WORKSPACE/hf-cache" \
  "$WORKSPACE/voices/ru" \
  "$WORKSPACE/voices/he" \
  "$WORKSPACE/logs/archive" \
  "$WORKSPACE/logs/calls" \
  "$WORKSPACE/config"

test_file="$WORKSPACE/.samevoice-write-test-$$"
printf 'ok\n' > "$test_file"
rm -f "$test_file"
echo "persistent workspace is writable: $WORKSPACE"

echo
printf 'disk:\n'
df -h "$WORKSPACE" | tail -n 1

echo
printf 'runtime:\n'
printf '  node:   %s\n' "$(node --version 2>/dev/null || echo missing)"
printf '  npm:    %s\n' "$(npm --version 2>/dev/null || echo missing)"
printf '  uv:     %s\n' "$(uv --version 2>/dev/null || echo missing)"
printf '  agent:  %s\n' "$(cd /opt/samevoice/agent 2>/dev/null && uv run python --version 2>/dev/null || python3 --version 2>/dev/null || echo missing)"

if [[ -n "${ACOUSTIC_SCOUT_CMD:-}" || -n "${PREDICTOR_CMD:-}" || -n "${LOCAL_MT_CMD:-}" ]]; then
  if [[ ! -x /opt/venvs/think/bin/python ]]; then
    echo 'ERROR: a GPU0 THINK hook is enabled but /opt/venvs/think is missing.' >&2
    echo 'Build the image with INSTALL_GPU_ENGINES=1.' >&2
    exit 1
  fi
  printf '  think:  %s\n' "$(/opt/venvs/think/bin/python --version)"
  /opt/venvs/think/bin/python - <<'PY'
import importlib.util
required = ["torch", "transformers", "fastapi", "uvicorn"]
missing = [name for name in required if importlib.util.find_spec(name) is None]
if missing:
    raise SystemExit("ERROR: THINK runtime missing packages: " + ", ".join(missing))
print("  think packages: present")
PY
fi

if [[ -n "${ACOUSTIC_SCOUT_CMD:-}" ]]; then
  /opt/venvs/think/bin/python - <<'PY'
import importlib.util
required = ["silero_vad", "faster_whisper", "numpy"]
missing = [name for name in required if importlib.util.find_spec(name) is None]
if missing:
    raise SystemExit("ERROR: acoustic runtime missing packages: " + ", ".join(missing))
print("  acoustic packages: present")
PY
fi

if [[ -n "${LOCAL_TTS_CMD:-}" ]]; then
  if [[ ! -x /opt/venvs/speak/bin/python ]]; then
    echo 'ERROR: local-TTS hook is enabled but /opt/venvs/speak is missing.' >&2
    echo 'Build the image with INSTALL_TTS_ENGINE=1.' >&2
    exit 1
  fi
  printf '  speak:  %s\n' "$(/opt/venvs/speak/bin/python --version)"
  /opt/venvs/speak/bin/python - <<'PY'
import importlib.util
missing = [name for name in ("torch", "chatterbox", "fastapi", "uvicorn") if importlib.util.find_spec(name) is None]
if missing:
    raise SystemExit("ERROR: SPEAK runtime missing packages: " + ", ".join(missing))
print("  speak packages: present")
PY
fi

echo
printf 'GPU split:\n'
printf '  GPU %s -> acoustic scout / predictor / local MT\n' "${PREDICTOR_CUDA_VISIBLE_DEVICES:-0}"
printf '  GPU %s -> local TTS\n' "${TTS_CUDA_VISIBLE_DEVICES:-1}"

echo
printf 'enabled local engines:\n'
printf '  predictor: %s\n' "$([[ -n "${PREDICTOR_CMD:-}" ]] && echo yes || echo no)"
printf '  acoustic:  %s\n' "$([[ -n "${ACOUSTIC_SCOUT_CMD:-}" ]] && echo yes || echo no)"
printf '  local MT:  %s\n' "$([[ -n "${LOCAL_MT_CMD:-}" ]] && echo yes || echo no)"
printf '  local TTS: %s\n' "$([[ -n "${LOCAL_TTS_CMD:-}" ]] && echo yes || echo no)"

echo
printf 'PASS preflight\n'
