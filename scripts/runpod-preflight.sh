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
printf '  python: %s\n' "$(cd /opt/samevoice/agent 2>/dev/null && uv run python --version 2>/dev/null || python3 --version 2>/dev/null || echo missing)"

echo
printf 'GPU split:\n'
printf '  GPU %s -> acoustic scout / predictor / local MT\n' "${PREDICTOR_CUDA_VISIBLE_DEVICES:-0}"
printf '  GPU %s -> local TTS\n' "${TTS_CUDA_VISIBLE_DEVICES:-1}"

echo
printf 'PASS preflight\n'
