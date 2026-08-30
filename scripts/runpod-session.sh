#!/usr/bin/env bash
set -euo pipefail

# One command for the "First paid session acceptance test" of
# docs/RUNPOD_READINESS.md, to be run once a Pod has booted. That list is the
# contract and it is numbered 1-8; steps 3-8 are the ones a post-boot script can
# perform, so those are the numbers used on screen here. Its steps 1 (choose the
# smallest engines before boot) and 2 (get a shell) happen before this script can
# run: step 1 is verified after the fact below, and step 2 is why this script
# sources the runtime config itself.
#
# WHY this file exists: the closing rule of that document is that package names,
# dependency conflicts, missing environment variables and container boot problems
# must never be discovered while two RTX 4090s are billing. Hand-typed steps in a
# web terminal are exactly how that rule gets broken -- and "stop the Pod" is the
# step a human forgets precisely when the step before it failed.
#
# This script ORCHESTRATES; it does not reimplement. The real work stays in:
#   scripts/runpod-preflight.sh      GPU inventory, venvs, package presence
#   scripts/runpod-warmup.sh         health wait + explicit weight loading
#   scripts/runpod-stage1-bench.py   predictor + local MT loopback latency
#   scripts/acoustic-pruning-bench.py Stage-2 next-word window benchmark
#   agent/scripts/summarize_prediction_shadow.py  shadow records -> p50/p90/p95
#   scripts/runpod-export.sh         copy the evidence off the Pod
# What is added here is only the assertions none of those make, the ordering,
# and the guarantee that the export step runs even when a step above fails.
#
# The image chmods only entrypoint.sh, healthcheck.sh, runpod-preflight.sh and
# runpod-warmup.sh (Dockerfile.runpod), so invoke this as:
#   bash /opt/samevoice/scripts/runpod-session.sh
#
# Comments in this file are English to match runpod-preflight.sh / entrypoint.sh.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

PREFLIGHT_SCRIPT="$SCRIPT_DIR/runpod-preflight.sh"
WARMUP_SCRIPT="$SCRIPT_DIR/runpod-warmup.sh"
STAGE1_BENCH="$SCRIPT_DIR/runpod-stage1-bench.py"
PRUNING_BENCH="$SCRIPT_DIR/acoustic-pruning-bench.py"
SCORER_COST_BENCH="$SCRIPT_DIR/scorer-cost-bench.py"
EXPORT_SCRIPT="$SCRIPT_DIR/runpod-export.sh"
AGENT_DIR="$REPO_ROOT/agent"
SUMMARIZE_SHADOW="$AGENT_DIR/scripts/summarize_prediction_shadow.py"

WORKSPACE="${WORKSPACE_ROOT:-/workspace}"
EXPECTED_GPU_COUNT="${EXPECTED_GPU_COUNT:-2}"
# Policy floor, not a measured requirement. The only checkpoint size the repo
# actually states is ~1.62 GB for the Hebrew CT2 model (gpu/model_manifest.toml),
# so this is a "you will not run out mid-download" guard, nothing more.
MIN_FREE_GB="${SESSION_MIN_FREE_GB:-20}"
ITERATIONS="${SESSION_BENCH_ITERATIONS:-7}"

# An unattended hang costs the same per hour as useful work. Every child gets a
# ceiling so a wedged service cannot silently bill overnight.
TIMEOUT_PREFLIGHT="${SESSION_TIMEOUT_PREFLIGHT:-300}"
TIMEOUT_WARMUP="${SESSION_TIMEOUT_WARMUP:-3600}"
TIMEOUT_CALLTEST="${SESSION_TIMEOUT_CALLTEST:-600}"
TIMEOUT_SHADOW="${SESSION_TIMEOUT_SHADOW:-900}"
TIMEOUT_BENCH="${SESSION_TIMEOUT_BENCH:-1800}"
TIMEOUT_PRUNING="${SESSION_TIMEOUT_PRUNING:-1800}"
TIMEOUT_SCORER="${SESSION_TIMEOUT_SCORER:-1800}"
TIMEOUT_EXPORT="${SESSION_TIMEOUT_EXPORT:-900}"

STAGES="preflight workspace engines warmup placement calltest bench pruning shadow scorer"
SKIPPED=""
DRY_RUN=0
ALLOW_HEAVY=0
ALLOW_EPHEMERAL_WORKSPACE=0
ALLOW_UNVERIFIED_PLACEMENT=0

# The shadow call test is the only step here that makes the agent itself talk to
# a GPU service, so it is opt-in by name rather than on by default: it is also
# the only step whose failure means the predictor was rented for nothing.
case "${SESSION_SHADOW_CALL_TEST:-0}" in
  1 | true | yes | on) SHADOW_CALL_TEST=1 ;;
  *) SHADOW_CALL_TEST=0 ;;
esac

CALL_TEST_CMD="${SESSION_CALL_TEST_CMD:-}"
PRUNING_WAV="${SESSION_PRUNING_WAV:-}"
# Реальная речь лучше синтетического тона, а другой записи в репозитории нет:
# eval/voice-refs/ единственное живое, и оно вне git (биометрия).
SCORER_LANG="${SESSION_SCORER_LANG:-ru}"
SCORER_WAV="${SESSION_SCORER_WAV:-}"
PRUNING_CANDIDATES="${SESSION_PRUNING_CANDIDATES:-}"
PRUNING_TRUTH="${SESSION_PRUNING_TRUTH:-}"
PRUNING_LANG="${SESSION_PRUNING_LANG:-}"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SESSION_DIR=""
LOG_FILE=""
STEP_INDEX="-"
# Captured when a step fails, because STEP_INDEX keeps moving: the export step
# runs afterwards and would otherwise rename the failure to step 7.
# Values are the acceptance-test numbers of docs/RUNPOD_READINESS.md.
FAILED_STEP=""
STATUS="incomplete"
FAIL_REASON=""
EXPORT_DONE=0
EXPORT_FAILED=0
# The manifest is written once BEFORE the export so the export bundles it, and
# once after so the copy left on the Pod records how the export ended.
EXPORT_STATE="pending"
ENABLED_ENGINES=""
EXPECTED_GPUS=""
PLACEMENT_VERDICT="not run"
SHADOW_VERDICT="not run"
PYTHON_CMD=""
TIMEOUT_BIN=""

usage() {
  cat <<'USAGE'
Usage: bash scripts/runpod-session.sh [options]

Runs the post-boot part of the acceptance test in docs/RUNPOD_READINESS.md.
Step numbers below are that document's, which is the contract:
  1 smallest engines only    verified after boot; hooks start with the container
  2 shell + runtime config   done for you: this script sources the config file
  3 preflight + both GPUs    scripts/runpod-preflight.sh
  4 /workspace is a volume   mount assertion + write test + free-space floor
  5 warmup and placement     scripts/runpod-warmup.sh + per-GPU memory around it
  6 call test + benchmarks   mock pipeline (every shadow off), then
                             scripts/runpod-stage1-bench.py [+ pruning bench],
                             then the shadow call test if it was asked for
  7 export the evidence      scripts/runpod-export.sh -- ALWAYS runs
  8 stop the Pod             yours to do; the last thing printed says so

Options:
  --dry-run                 validate the plan and exit; touches no GPU, loads no
                            model, starts no request, writes nothing
  --skip <a,b,...>          skip stages: preflight workspace engines warmup
                            placement calltest bench pruning scorer shadow
  --skip-<stage>            same, one stage per flag (e.g. --skip-calltest)
  --iterations <n>          iterations for runpod-stage1-bench.py (default 7)
  --allow-heavy-engines     proceed although engines outside the smallest set
                            are enabled (step 1 refuses by default)
  --allow-ephemeral-workspace
                            proceed although /workspace is not a separate mount
                            (you accept losing every artifact on Pod stop)
  --allow-unverified-placement
                            proceed although no per-GPU evidence was obtainable
  --call-test-cmd <cmd>     shell command for step 6 instead of the mock demo
  --shadow-call-test        run the pipeline a SECOND time with predictor shadow
                            mode on, against the local services (:8101, plus
                            :8105 when ACOUSTIC_PRUNER_CMD is set), then write
                            the prediction_shadow records and their summary into
                            the session directory. Refuses to run when those
                            services are unconfigured, dead or still cold.
                            Without it this session records nothing at all about
                            the predictor as the agent actually calls it.
  --pruning-wav <path>      Stage-2 corpus: 16 kHz mono s16 WAV
  --pruning-candidates <path>  Stage-2 corpus: candidate JSON
  --pruning-truth <word>    Stage-2: expected next word
  --pruning-lang <ru|he>    Stage-2: language
  -h, --help                this text

Every option also has an env form (SESSION_BENCH_ITERATIONS, SESSION_CALL_TEST_CMD,
SESSION_SHADOW_CALL_TEST, SESSION_PRUNING_WAV, SESSION_MIN_FREE_GB,
SESSION_TIMEOUT_*, WORKSPACE_ROOT, EXPECTED_GPU_COUNT).

Worth exporting before a paid run: SAMEVOICE_IMAGE_TAG. Nothing in this
repository sets it, and inside a Pod the git SHA is unknowable (.dockerignore
keeps .git out of the image), so it is the only handle that ties this session's
manifest to the image that produced it -- copy the tag/digest from the RunPod
console. Left unset, the manifest records "unknown" and says why.
USAGE
}

# ---------------------------------------------------------------- output ----

emit() {
  # Neither write may abort the caller. The whole exit handler -- manifest,
  # export, STOP-THE-POD banner -- speaks through emit, and a closed RunPod web
  # terminal takes stdout with it. Under `set -e` a printf that cannot reach a
  # dead tty would kill the teardown and leave the Pod billing with nothing
  # exported, which is the exact outcome this script exists to prevent.
  printf '%s\n' "$*" || true
  if [[ -n "$LOG_FILE" ]]; then printf '%s\n' "$*" >>"$LOG_FILE" || true; fi
}
rule() { emit "------------------------------------------------------------------"; }
step() {
  STEP_INDEX="$1"
  emit ""
  rule
  emit "ACCEPTANCE STEP $1  $2"
  rule
}
why() { emit "  why: $1"; }
info() { emit "  .  $1"; }
ok() { emit "  OK  $1"; }
warn() { emit "  !!  $1"; }
plan() { emit "  ->  $1"; }

fail() {
  FAIL_REASON="$1"
  FAILED_STEP="$STEP_INDEX"
  emit ""
  emit "  XX  ACCEPTANCE STEP ${STEP_INDEX} FAILED"
  emit "  XX  $1"
  if [[ -n "${2:-}" ]]; then emit "  XX  fix: $2"; fi
  exit 1
}

skipped() {
  case " $SKIPPED " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

announce_skip() {
  step "$1" "$2 -- SKIPPED (--skip $3)"
  warn "$4"
}

# --------------------------------------------------------------- helpers ----

guard() {
  local secs="$1"
  shift
  if [[ -n "$TIMEOUT_BIN" ]]; then
    "$TIMEOUT_BIN" --kill-after=30s "$secs" "$@"
  else
    "$@"
  fi
}

run_child() {
  local secs="$1"
  shift
  if [[ -n "$LOG_FILE" ]]; then
    guard "$secs" "$@" 2>&1 | tee -a "$LOG_FILE"
  else
    guard "$secs" "$@" 2>&1
  fi
}

# Same escaping rule as jstr() in runpod-export.sh: every C0 control character
# goes, not only CR/LF. A stray control byte in a failure message -- they come
# straight out of child stderr -- would otherwise produce a manifest no JSON
# parser accepts, and the manifest is the only thing that attributes the run.
json_str() {
  printf '%s' "${1:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'
}

gpu_memory_used() {
  nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits 2>/dev/null |
    awk -F'[,[:space:]]+' -v idx="$1" '$1 == idx { print $2 + 0; found = 1 } END { if (!found) print -1 }'
}

engine_cmd() {
  case "$1" in
    predictor) printf '%s' "${PREDICTOR_CMD:-}" ;;
    local-mt) printf '%s' "${LOCAL_MT_CMD:-}" ;;
    acoustic-scout) printf '%s' "${ACOUSTIC_SCOUT_CMD:-}" ;;
    acoustic-pruner) printf '%s' "${ACOUSTIC_PRUNER_CMD:-}" ;;
    local-tts) printf '%s' "${LOCAL_TTS_CMD:-}" ;;
  esac
}

engine_env_var() {
  case "$1" in
    predictor) printf 'PREDICTOR_CMD' ;;
    local-mt) printf 'LOCAL_MT_CMD' ;;
    acoustic-scout) printf 'ACOUSTIC_SCOUT_CMD' ;;
    acoustic-pruner) printf 'ACOUSTIC_PRUNER_CMD' ;;
    local-tts) printf 'LOCAL_TTS_CMD' ;;
  esac
}

engine_url() {
  case "$1" in
    predictor) printf '%s' "${PREDICTOR_URL:-http://127.0.0.1:8101}" ;;
    local-mt) printf '%s' "${LOCAL_MT_URL:-http://127.0.0.1:8103}" ;;
    acoustic-scout) printf '%s' "${ACOUSTIC_SCOUT_URL:-http://127.0.0.1:8102}" ;;
    acoustic-pruner) printf '%s' "${ACOUSTIC_PRUNER_URL:-http://127.0.0.1:8105}" ;;
    local-tts) printf '%s' "${LOCAL_TTS_URL:-http://127.0.0.1:8104}" ;;
  esac
}

# Physical card each hook is pinned to by docker/entrypoint.sh.
engine_gpu() {
  case "$1" in
    predictor) printf '%s' "${PREDICTOR_CUDA_VISIBLE_DEVICES:-0}" ;;
    local-mt) printf '%s' "${LOCAL_MT_CUDA_VISIBLE_DEVICES:-0}" ;;
    acoustic-scout) printf '%s' "${ACOUSTIC_CUDA_VISIBLE_DEVICES:-0}" ;;
    acoustic-pruner) printf '%s' "${ACOUSTIC_PRUNER_CUDA_VISIBLE_DEVICES:-0}" ;;
    local-tts) printf '%s' "${TTS_CUDA_VISIBLE_DEVICES:-1}" ;;
  esac
}

# "Smallest" is read off gpu/model_manifest.toml, not guessed: the predictor is
# Qwen3-0.6B-Base and local MT is a pair-specific Marian baseline the manifest
# itself calls small. Everything else pulls a large checkpoint on first use
# (the Hebrew CT2 model alone is ~1.62 GB there), which is what step 1 of the
# acceptance test says to keep out of the first session.
engine_class() {
  case "$1" in
    predictor | local-mt) printf 'small' ;;
    *) printf 'heavy' ;;
  esac
}

resolve_python() {
  # No layer of Dockerfile.runpod installs a system python3, so the interpreter
  # for the two .py benchmarks has to be resolved explicitly rather than assumed.
  if [[ -n "${SESSION_PYTHON:-}" ]]; then
    PYTHON_CMD="$SESSION_PYTHON"
    return 0
  fi
  if [[ -x /opt/venvs/think/bin/python ]]; then
    PYTHON_CMD="/opt/venvs/think/bin/python"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python3"
    return 0
  fi
  if command -v uv >/dev/null 2>&1 && [[ -d "$AGENT_DIR" ]]; then
    PYTHON_CMD="uv run --directory $AGENT_DIR python"
    return 0
  fi
  return 1
}

# --------------------------------------------------------- argument parse ----

add_skip() {
  local name
  for name in $(printf '%s' "$1" | tr ',' ' '); do
    case " $STAGES " in
      *" $name "*) SKIPPED="$SKIPPED $name" ;;
      *)
        printf 'ERROR: unknown stage %s. Known stages: %s\n' "$name" "$STAGES" >&2
        exit 2
        ;;
    esac
  done
}

# Every value-taking flag goes through this. Without it a trailing `--iterations`
# with no number left $# at 1, the inner `shift` emptied it and the loop's own
# `shift` then failed under `set -e`: the script exited 1 having printed nothing
# at all. Silence is the worst possible answer here -- the operator cannot tell
# "typo in my command" from "the run started and died".
need_value() {
  (($2 >= 2)) || {
    printf 'ERROR: %s needs a value\n\n' "$1" >&2
    usage >&2
    exit 2
  }
}

while (($# > 0)); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip)
      need_value "$1" $#
      add_skip "$2"
      shift
      ;;
    --skip-*) add_skip "${1#--skip-}" ;;
    --iterations)
      need_value "$1" $#
      ITERATIONS="$2"
      shift
      ;;
    --allow-heavy-engines) ALLOW_HEAVY=1 ;;
    --shadow-call-test) SHADOW_CALL_TEST=1 ;;
    --allow-ephemeral-workspace) ALLOW_EPHEMERAL_WORKSPACE=1 ;;
    --allow-unverified-placement) ALLOW_UNVERIFIED_PLACEMENT=1 ;;
    --call-test-cmd)
      need_value "$1" $#
      CALL_TEST_CMD="$2"
      shift
      ;;
    --pruning-wav)
      need_value "$1" $#
      PRUNING_WAV="$2"
      shift
      ;;
    --pruning-candidates)
      need_value "$1" $#
      PRUNING_CANDIDATES="$2"
      shift
      ;;
    --pruning-truth)
      need_value "$1" $#
      PRUNING_TRUTH="$2"
      shift
      ;;
    --pruning-lang)
      need_value "$1" $#
      PRUNING_LANG="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR: unknown option %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$ITERATIONS" in
  '' | *[!0-9]*)
    printf 'ERROR: --iterations must be an integer\n' >&2
    exit 2
    ;;
esac
if ((ITERATIONS < 3)); then
  printf 'ERROR: --iterations must be >= 3 (runpod-stage1-bench.py rejects less)\n' >&2
  exit 2
fi

# --------------------------------------------------------------- manifest ----

write_manifest() {
  [[ -n "$SESSION_DIR" ]] || return 0
  # WHY a manifest: a recovered JSON with no record of driver, image, git SHA and
  # enabled engines cannot be attributed to a configuration afterwards, which
  # makes the paid measurement unusable even though it survived.
  #
  # Both "unknown" fields carry the reason they are unknown, the way
  # runpod-export.sh does for its own git_sha. A bare "unknown" tells the reader
  # nothing and, for the image tag, hides the fact that they could have set it.
  local git_sha git_note image_tag image_note
  git_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf '')"
  git_note=""
  if [[ -z "$git_sha" ]]; then
    git_sha="unknown"
    git_note=".dockerignore excludes .git from the RunPod image and no build argument records a commit, so the SHA is not knowable inside a Pod; attribute this run by image tag/digest from the RunPod console"
  fi
  image_tag="${SAMEVOICE_IMAGE_TAG:-}"
  image_note=""
  if [[ -z "$image_tag" ]]; then
    image_tag="unknown"
    image_note="nothing in this repository sets SAMEVOICE_IMAGE_TAG; export it yourself from the RunPod console image tag/digest before running this script if the run has to be attributable to an image"
  fi

  # A failed write must not abort the exit handler: the export below and the
  # STOP-THE-POD banner after it matter more than the manifest, and the most
  # likely reason this write fails -- a full or read-only volume -- is exactly
  # when they matter most.
  if ! cat >"$SESSION_DIR/session-manifest.json" <<EOF
{
  "schema_version": 1,
  "run_id": "$(json_str "$RUN_ID")",
  "started_at": "$(json_str "$STARTED_AT")",
  "finished_at": "$(json_str "$(date -u +%Y-%m-%dT%H:%M:%SZ)")",
  "status": "$(json_str "$STATUS")",
  "last_step_reached": "$(json_str "$STEP_INDEX")",
  "failed_step": "$(json_str "$FAILED_STEP")",
  "failure_reason": "$(json_str "$FAIL_REASON")",
  "export": "$(json_str "$EXPORT_STATE")",
  "workspace": "$(json_str "$WORKSPACE")",
  "workspace_mount": "$(json_str "${WORKSPACE_MOUNT_VERDICT:-unknown}")",
  "benchmark_dir": "$(json_str "${BENCHMARK_DIR:-}")",
  "session_dir": "$(json_str "$SESSION_DIR")",
  "git_sha": "$(json_str "$git_sha")",
  "git_sha_note": "$(json_str "$git_note")",
  "image_tag": "$(json_str "$image_tag")",
  "image_tag_note": "$(json_str "$image_note")",
  "gpu_inventory": "$(json_str "${GPU_INVENTORY:-unknown}")",
  "enabled_engines": "$(json_str "$ENABLED_ENGINES")",
  "expected_gpu_indices": "$(json_str "$EXPECTED_GPUS")",
  "placement_verdict": "$(json_str "$PLACEMENT_VERDICT")",
  "shadow_call_test": "$(json_str "$SHADOW_VERDICT")",
  "skipped_stages": "$(json_str "${SKIPPED# }")",
  "bench_iterations": $ITERATIONS,
  "known_missing_instrumentation": "per-stage GPU queue wait and t0..t9 are NOT in any artifact of this run; the readiness blocker 'Add per-stage queue-wait and t0..t9 instrumentation to the benchmark record' is still open"
}
EOF
  then
    warn "could not write $SESSION_DIR/session-manifest.json (full or read-only volume?). Continuing: the export and the stop reminder matter more."
  fi
  return 0
}

# ----------------------------------------------------------------- export ----

run_export() {
  [[ "$EXPORT_DONE" -eq 0 ]] || return 0
  EXPORT_DONE=1
  step 7 "Export the evidence off the Pod"
  why "docs/RUNPOD_RND.md: do not treat a Pod as the only copy of anything important. /workspace survives a stop only if it is a volume, and nothing survives a terminate unless it was copied off. This step runs even when a step above failed: a failed session still cost money, and its log is the only evidence of why."
  info "session directory: ${SESSION_DIR:-<none>}"
  info "status handed to the export script: $STATUS"

  if [[ ! -f "$EXPORT_SCRIPT" ]]; then
    EXPORT_FAILED=1
    EXPORT_STATE="missing script"
    warn "$EXPORT_SCRIPT does not exist. NOTHING has been copied off this Pod."
    warn "Everything from this run lives only in ${SESSION_DIR:-the terminal scrollback}."
    warn "Copy it out by hand before stopping, or the paid measurement is gone."
    return 0
  fi

  # Called with no positional arguments on purpose: runpod-export.sh takes none.
  #
  # Nothing else is invented into its environment either. An earlier version
  # passed RUNPOD_SESSION_DIR/RUN_ID/STATUS/LOG "harmlessly"; they were read by
  # nothing, and runpod-export.sh's is_secret_env_name() matches *SESSION*, so
  # all four landed in the bundle's env/withheld-names.txt as though the session
  # runner had four secrets. A list of withheld secret names that is mostly
  # fiction is worse than no list. This session's own context reaches the bundle
  # the only way that is real: SESSION_DIR lives under BENCHMARK_DIR, which the
  # export collects, so session.log and session-manifest.json are packed as files.
  #
  # SAMEVOICE_EXPORT_ALLOW_EPHEMERAL is forwarded because the export does read
  # it, and only when step 4 already put that decision in front of the operator.
  # Without it the two scripts disagree: the operator knowingly accepts an
  # ephemeral workspace, and then the export refuses and leaves them with no
  # bundle at all to copy out.
  if run_child "$TIMEOUT_EXPORT" env \
    "SAMEVOICE_EXPORT_ALLOW_EPHEMERAL=${SAMEVOICE_EXPORT_ALLOW_EPHEMERAL:-$ALLOW_EPHEMERAL_WORKSPACE}" \
    bash "$EXPORT_SCRIPT"; then
    EXPORT_STATE="ok"
    ok "export finished"
  else
    EXPORT_FAILED=1
    EXPORT_STATE="failed"
    warn "export FAILED. Do not stop the Pod until you have copied ${SESSION_DIR:-the artifacts} out by hand."
  fi
}

on_exit() {
  local code=$?
  trap - EXIT INT TERM
  if ((code == 0)); then
    STATUS="passed"
  elif [[ "$STATUS" == "incomplete" ]]; then
    STATUS="failed"
  fi

  if ((DRY_RUN == 0)); then
    write_manifest
    run_export
  fi

  # A measurement that never left the Pod is not a green run, so a failed export
  # turns a passing session into a non-zero exit.
  if ((EXPORT_FAILED == 1)); then
    STATUS="$STATUS, export failed"
    if ((code == 0)); then code=1; fi
  fi

  # Rewritten so the copy left on disk records how the export ended; the copy
  # inside the bundle keeps the honest "pending" it had at pack time.
  if ((DRY_RUN == 0)); then write_manifest; fi

  emit ""
  rule
  if ((DRY_RUN == 1 && code == 0)); then
    emit "DRY RUN: plan validated. No GPU was touched, no model loaded, nothing written."
  elif ((DRY_RUN == 1)); then
    emit "DRY RUN: the plan is NOT runnable as configured. Fix the problems above first."
  elif [[ -n "$FAIL_REASON" ]]; then
    # A step failure is always reported first; a failed export is an extra line,
    # never a replacement for the reason the session stopped.
    emit "SESSION FAILED at acceptance step ${FAILED_STEP}. Artifacts: ${SESSION_DIR:-<none>}"
    emit "Reason: $FAIL_REASON"
    if ((EXPORT_FAILED == 1)); then emit "The export ALSO failed: nothing left this Pod."; fi
  elif ((EXPORT_FAILED == 1)); then
    emit "EVERY STEP RAN, BUT THE EXPORT FAILED."
    emit "The only copy of this session is still on the Pod: ${SESSION_DIR:-<none>}"
  else
    emit "SESSION PASSED. Artifacts: ${SESSION_DIR:-<none>}"
  fi
  rule
  # Acceptance step 8, and the last line on screen is the one a tired operator
  # acts on -- so it is the only one that must never be anything else. It prints
  # on the failure path too: a failed session bills at exactly the same rate.
  emit ""
  emit "##################################################################"
  emit ">>> ACCEPTANCE STEP 8 -- the one step no script here can do for you:"
  if ((EXPORT_FAILED == 1)); then
    emit ">>> COPY ${SESSION_DIR:-THE ARTIFACTS} TO YOUR LAPTOP FIRST -- the export failed."
    emit ">>> THEN STOP THE POD."
  else
    emit ">>> STOP THE POD NOW."
  fi
  emit ">>> GPU time bills continuously for as long as the Pod runs,"
  emit ">>> whether or not anything is using the cards (docs/RUNPOD_RND.md)."
  emit "##################################################################"
  emit ""
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ------------------------------------------------------------------ start ----

emit "SameVoice RunPod session runner"
emit "run id:    $RUN_ID"
emit "repo:      $REPO_ROOT"
emit "workspace: $WORKSPACE"
emit "mode:      $( ((DRY_RUN == 1)) && printf 'DRY RUN' || printf 'live')"
if [[ -n "$SKIPPED" ]]; then emit "skipping:${SKIPPED}"; fi

# WHY this is loaded here and not left to each child: docker/entrypoint.sh
# sources the runtime config into ITS OWN process tree only. A human who opens a
# separate terminal has none of the *_CMD variables, so runpod-preflight.sh
# skips every engine check and still prints "PASS preflight", and
# runpod-warmup.sh warms nothing. That false PASS is the most expensive thing
# this script can prevent.
CONFIG_FILE="${SAMEVOICE_CONFIG_FILE:-$WORKSPACE/config/samevoice.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  emit "config:    $CONFIG_FILE (loaded)"
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
else
  emit "config:    $CONFIG_FILE (absent; using the environment of this shell)"
fi

if command -v timeout >/dev/null 2>&1 && timeout --version >/dev/null 2>&1; then
  TIMEOUT_BIN="$(command -v timeout)"
else
  TIMEOUT_BIN=""
fi

for name in predictor local-mt acoustic-scout acoustic-pruner local-tts; do
  if [[ -n "$(engine_cmd "$name")" ]]; then ENABLED_ENGINES="$ENABLED_ENGINES $name"; fi
done
ENABLED_ENGINES="${ENABLED_ENGINES# }"

# --------------------------------------------------------------- dry run -----

if ((DRY_RUN == 1)); then
  emit ""
  rule
  emit "PLAN VALIDATION (no GPU access, no HTTP request, no file written)"
  rule

  plan_errors=0
  check_file() {
    if [[ -f "$1" ]]; then
      ok "$2: $1"
    else
      warn "$2 MISSING: $1"
      plan_errors=$((plan_errors + 1))
    fi
  }
  check_file "$PREFLIGHT_SCRIPT" "step 3 preflight"
  check_file "$WARMUP_SCRIPT" "step 5 warmup"
  check_file "$STAGE1_BENCH" "step 6 stage-1 bench"
  check_file "$PRUNING_BENCH" "step 6 pruning bench"
  # Not a step this runner executes -- it is checked here because the operator
  # runs it by hand during the same paid hour, and a missing file discovered
  # then costs card time that this free validation already had the chance to
  # spend instead.
  check_file "$SCORER_COST_BENCH" "step 6 scorer cost bench"
  if [[ -f "$EXPORT_SCRIPT" ]]; then
    ok "step 7 export: $EXPORT_SCRIPT"
  else
    warn "step 7 export MISSING: $EXPORT_SCRIPT (the run would finish with nothing copied off the Pod)"
  fi

  if resolve_python; then
    ok "python for the .py benchmarks: $PYTHON_CMD"
  else
    warn "no usable python. Build the image with INSTALL_GPU_ENGINES=1 (/opt/venvs/think) or set SESSION_PYTHON."
    plan_errors=$((plan_errors + 1))
  fi

  if [[ -n "$TIMEOUT_BIN" ]]; then
    ok "child timeouts enforced by $TIMEOUT_BIN"
  else
    warn "no GNU timeout: a wedged service can hang this run while the Pod bills"
  fi

  if [[ -d "$WORKSPACE" ]]; then
    ok "workspace exists: $WORKSPACE"
  else
    warn "workspace does not exist: $WORKSPACE"
    plan_errors=$((plan_errors + 1))
  fi

  if [[ -z "$ENABLED_ENGINES" ]]; then
    warn "no local engine is enabled (*_CMD all empty). Step 3 would refuse: an idle GPU is pure cost."
    plan_errors=$((plan_errors + 1))
  else
    ok "enabled engines: $ENABLED_ENGINES"
    for name in $ENABLED_ENGINES; do
      info "$name -> GPU $(engine_gpu "$name") | $(engine_url "$name") | $(engine_class "$name")"
      if [[ "$(engine_class "$name")" == "heavy" && $ALLOW_HEAVY -eq 0 ]]; then
        warn "$name is outside the smallest-first set; step 1 would stop without --allow-heavy-engines"
        plan_errors=$((plan_errors + 1))
      fi
    done
  fi

  emit ""
  emit "  commands this run would execute:"
  skipped preflight || plan "bash $PREFLIGHT_SCRIPT"
  skipped warmup || plan "bash $WARMUP_SCRIPT"
  skipped calltest || plan "${CALL_TEST_CMD:-STT_PROVIDER=mock MT_PROVIDER=mock TTS_PROVIDER=mock PREDICTOR_SHADOW_ENABLED=0 ACOUSTIC_PRUNER_SHADOW_ENABLED=0; cd $AGENT_DIR && uv run python scripts/mock_pipeline_demo.py}"
  if ! skipped bench; then
    plan "${PYTHON_CMD:-<python>} $STAGE1_BENCH --iterations $ITERATIONS"
    for pair in "PREDICTOR_CMD:$(engine_cmd predictor)" "LOCAL_MT_CMD:$(engine_cmd local-mt)"; do
      if [[ -z "${pair#*:}" ]]; then
        warn "stage-1 bench drives predictor :8101 AND local MT :8103 unconditionally, but ${pair%%:*} is empty: it would abort mid-run"
        plan_errors=$((plan_errors + 1))
      fi
    done
  fi
  if ! skipped pruning && [[ -n "$PRUNING_WAV$PRUNING_CANDIDATES$PRUNING_TRUTH$PRUNING_LANG" ]]; then
    for pair in "wav:$PRUNING_WAV" "candidates:$PRUNING_CANDIDATES" "truth:$PRUNING_TRUTH" "lang:$PRUNING_LANG"; do
      if [[ -z "${pair#*:}" ]]; then
        warn "stage-2 pruning bench is half-configured: --pruning-${pair%%:*} is missing"
        plan_errors=$((plan_errors + 1))
      fi
    done
    for path in "$PRUNING_WAV" "$PRUNING_CANDIDATES"; do
      if [[ -n "$path" && ! -f "$path" ]]; then
        warn "stage-2 corpus file does not exist: $path"
        plan_errors=$((plan_errors + 1))
      fi
    done
    if [[ -z "$(engine_cmd acoustic-pruner)" ]]; then
      warn "stage-2 pruning bench was requested but ACOUSTIC_PRUNER_CMD is empty, so :8105 is not running"
      plan_errors=$((plan_errors + 1))
    fi
    plan "${PYTHON_CMD:-<python>} $PRUNING_BENCH --wav $PRUNING_WAV --candidates $PRUNING_CANDIDATES --truth $PRUNING_TRUTH --lang $PRUNING_LANG --output <session>/acoustic-pruning.json"
  else
    plan "(pruning bench not scheduled: no --pruning-wav given; the corpus it needs is not in this repo)"
  fi
  if skipped scorer; then
    plan "(scorer cost bench skipped by --skip scorer)"
  elif [[ -z "$(engine_cmd predictor)" || -z "$(engine_cmd acoustic-pruner)" ]]; then
    plan "!!  scorer cost bench needs BOTH predictor and acoustic-pruner enabled; with one of them empty it would answer half the question"
  else
    plan "${PYTHON_CMD:-<python>} $SCORER_COST_BENCH --lang $SCORER_LANG --predictor-url <predictor> --pruner-url <pruner> --output <session>/scorer-cost.json"
  fi
  if ((SHADOW_CALL_TEST == 1)) && ! skipped shadow; then
    check_file "$SUMMARIZE_SHADOW" "step 6 shadow summary"
    if [[ -z "$(engine_cmd predictor)" ]]; then
      warn "the shadow call test needs the predictor, but PREDICTOR_CMD is empty: nothing is listening on :8101 and the step would refuse"
      plan_errors=$((plan_errors + 1))
    fi
    if ! command -v uv >/dev/null 2>&1; then
      warn "the shadow call test drives the agent itself, and uv is not on PATH: there would be nothing to run"
      plan_errors=$((plan_errors + 1))
    fi
    if [[ ! -d "$AGENT_DIR" ]]; then
      warn "the shadow call test needs the agent, and $AGENT_DIR does not exist"
      plan_errors=$((plan_errors + 1))
    fi
    # The real step refuses without curl. Free validation has to cover every
    # refusal the paid run can hit, not most of them: a refusal discovered down
    # there is discovered while the cards bill.
    if ! command -v curl >/dev/null 2>&1; then
      warn "the shadow call test verifies service health with curl, and curl is not on PATH: the step would refuse before running anything"
      plan_errors=$((plan_errors + 1))
    fi
    # Not a plan error: a Pod that was warmed by an earlier run of this script
    # still reports loaded=true, and refusing the plan for that case would push
    # the operator into --skip-shadow, which is the outcome to avoid.
    if skipped warmup; then
      warn "warmup is skipped: the predictor loads its weights inside the first request, so the shadow step will refuse unless something else already warmed :8101"
    fi
    shadow_pruner_plan=""
    if [[ -n "$(engine_cmd acoustic-pruner)" ]]; then
      shadow_pruner_plan=" ACOUSTIC_PRUNER_SHADOW_ENABLED=1 ACOUSTIC_PRUNER_URL=$(engine_url acoustic-pruner) ACOUSTIC_PRUNER_SHADOW_EVERY_N=1"
    else
      info "ACOUSTIC_PRUNER_CMD is empty: the shadow step would record linguistic prediction only, no acoustic_pruning_shadow rows"
    fi
    plan "STT_PROVIDER=mock MT_PROVIDER=mock TTS_PROVIDER=mock PREDICTOR_SHADOW_ENABLED=1 PREDICTOR_URL=$(engine_url predictor)${shadow_pruner_plan} EVAL_LOG_ENABLED=1 EVAL_LOG_DIR=<session>/prediction-shadow/eval-log; cd $AGENT_DIR && uv run python scripts/mock_pipeline_demo.py"
    plan "${PYTHON_CMD:-<python>} $SUMMARIZE_SHADOW <session>/prediction-shadow/eval-log/<callId>.jsonl > <session>/prediction-shadow/summary-<callId>.json"
  elif skipped shadow; then
    plan "(shadow call test skipped by --skip shadow: this run would write ZERO prediction_shadow records)"
  else
    plan "(shadow call test not scheduled: this run would write ZERO prediction_shadow records and answer nothing about the predictor as the agent calls it -- add --shadow-call-test)"
  fi
  plan "bash $EXPORT_SCRIPT   [always, including on failure]"

  emit ""
  if ((plan_errors > 0)); then
    rule
    emit "DRY RUN: $plan_errors problem(s) above would stop a real run."
    rule
    exit 1
  fi
  exit 0
fi

# ------------------------------------------------- session directory setup ----

export BENCHMARK_DIR="${BENCHMARK_DIR:-$WORKSPACE/benchmarks}"
SESSION_DIR="$BENCHMARK_DIR/sessions/$RUN_ID"
if ! mkdir -p "$SESSION_DIR" 2>/dev/null; then
  printf 'ERROR: cannot create session directory %s\n' "$SESSION_DIR" >&2
  printf 'Set BENCHMARK_DIR/WORKSPACE_ROOT to a writable path before paying for GPU time.\n' >&2
  exit 1
fi
LOG_FILE="$SESSION_DIR/session.log"
: >"$LOG_FILE"
emit ""
emit "session dir: $SESSION_DIR"
emit "log:         $LOG_FILE"

# ACCEPTANCE STEP 1 -- smallest engines only =================================

if skipped engines; then
  announce_skip 1 "Smallest engines only (verified after boot)" engines \
    "The engine set was not checked. A large checkpoint may be downloading right now on paid time."
else
  step 1 "Smallest engines only (verified after boot)"
  why "the first Pod session is infrastructure validation, not a latency claim (docs/RUNPOD_READINESS.md, 'First paid session acceptance test'). A large checkpoint turns a boot problem into a multi-minute download you only learn about afterwards, so the smallest engines go first: the predictor (Qwen3-0.6B-Base) and the pair-specific Marian MT baselines, per gpu/model_manifest.toml."

  # This script cannot start an engine. docker/entrypoint.sh launches the hooks
  # once, at container boot, from the *_CMD variables; there is no per-engine
  # start/stop path. So the honest job here is to verify the set that IS running
  # and stop before any weight is pulled if it is the wrong set.
  info "engines are started only by docker/entrypoint.sh at container boot; this step verifies the set, it cannot change it"

  [[ -n "$ENABLED_ENGINES" ]] || fail "no local engine is enabled: every *_CMD is empty" \
    "an idle 2x4090 Pod is pure cost. Set PREDICTOR_CMD/LOCAL_MT_CMD in $CONFIG_FILE (see docker/runpod-gpu.env.example) and recreate the Pod"

  heavy_found=""
  for name in $ENABLED_ENGINES; do
    info "$name  ->  GPU $(engine_gpu "$name")  $(engine_url "$name")  [$(engine_class "$name")]"
    if [[ "$(engine_class "$name")" == "heavy" ]]; then heavy_found="$heavy_found $name"; fi
  done

  if [[ -n "$heavy_found" ]]; then
    if ((ALLOW_HEAVY == 1)); then
      warn "engines outside the smallest-first set are enabled:$heavy_found (allowed by --allow-heavy-engines)"
    else
      vars=""
      for name in $heavy_found; do vars="$vars $(engine_env_var "$name")"; done
      fail "engines outside the smallest-first set are enabled:$heavy_found" \
        "blank$vars in $CONFIG_FILE and recreate the Pod (hooks only start at container boot), or pass --allow-heavy-engines if loading them now is the deliberate experiment"
    fi
  else
    ok "only the smallest engines are enabled: $ENABLED_ENGINES"
  fi

  EXPECTED_GPUS=""
  for name in $ENABLED_ENGINES; do
    gpu="$(engine_gpu "$name")"
    case " $EXPECTED_GPUS " in *" $gpu "*) : ;; *) EXPECTED_GPUS="$EXPECTED_GPUS $gpu" ;; esac
  done
  EXPECTED_GPUS="${EXPECTED_GPUS# }"
  info "cards these engines should occupy: $EXPECTED_GPUS"

  # Placement evidence in step 5 is a memory delta, so the "before" snapshot has
  # to be taken before any weight is loaded.
  nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv \
    >"$SESSION_DIR/gpu-before-warmup.csv" 2>/dev/null || true
  for gpu in $EXPECTED_GPUS; do
    printf 'gpu%s_before_mib=%s\n' "$gpu" "$(gpu_memory_used "$gpu")" >>"$SESSION_DIR/gpu-memory-deltas.txt"
  done
fi

# ACCEPTANCE STEP 3 -- preflight and both GPUs ===============================

if skipped preflight; then
  announce_skip 3 "Preflight and both GPUs" preflight \
    "No GPU inventory, no venv check and no package check was made. A missing package will now surface mid-benchmark instead of before it."
else
  step 3 "Preflight and both GPUs"
  why "docs/RUNPOD_READINESS.md's rule: package names, dependency conflicts, missing env vars and boot problems must be found in CI or a CPU build, never on paid GPU time. runpod-preflight.sh is the last check that costs nothing."
  [[ -f "$PREFLIGHT_SCRIPT" ]] || fail "$PREFLIGHT_SCRIPT is missing" "check out the full repo at $REPO_ROOT"

  if ! command -v nvidia-smi >/dev/null 2>&1; then
    fail "nvidia-smi is not available: this is not a GPU-ready runtime" \
      "you are on the wrong Pod or the wrong image; do not continue paying for it"
  fi

  info "running $PREFLIGHT_SCRIPT"
  if ! run_child "$TIMEOUT_PREFLIGHT" bash "$PREFLIGHT_SCRIPT"; then
    fail "runpod-preflight.sh failed (or timed out after ${TIMEOUT_PREFLIGHT}s)" \
      "read its last ERROR line above; it names the missing venv or package"
  fi

  # Preflight asserts a MINIMUM GPU count. The acceptance test says "verify both
  # GPUs", so each expected index is queried on its own here: a card that is
  # present in the count but does not answer its own query is a card that will
  # fail halfway through a benchmark instead of now.
  GPU_INVENTORY=""
  index=0
  while ((index < EXPECTED_GPU_COUNT)); do
    line="$(nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader -i "$index" 2>/dev/null || true)"
    [[ -n "$line" ]] || fail "GPU $index did not answer nvidia-smi" \
      "the Pod does not actually have ${EXPECTED_GPU_COUNT} usable cards; recreate it or set EXPECTED_GPU_COUNT"
    ok "GPU $index: $line"
    GPU_INVENTORY="$GPU_INVENTORY${GPU_INVENTORY:+ | }$line"
    index=$((index + 1))
  done
  nvidia-smi --query-gpu=index,name,memory.total,memory.used,driver_version --format=csv \
    >"$SESSION_DIR/gpu-inventory.csv" 2>/dev/null || true
  ok "both GPUs answered; inventory saved to $SESSION_DIR/gpu-inventory.csv"
fi

# ACCEPTANCE STEP 4 -- /workspace is a real mounted volume ===================

WORKSPACE_MOUNT_VERDICT="unknown"

if skipped workspace; then
  announce_skip 4 "/workspace is a real mounted volume" workspace \
    "Nobody verified that this run's artifacts are on a volume. If they are on the container overlay, stopping the Pod deletes all of them."
else
  step 4 "/workspace is a real mounted volume"
  why "everything this session measures is written under $WORKSPACE. runpod-preflight.sh proves only that the path is WRITABLE -- which the ephemeral container overlay also is -- so a forgotten volume passes it. This step proves the path is a separate mount, because the difference is 100% of a paid session's evidence."

  [[ -d "$WORKSPACE" ]] || fail "$WORKSPACE does not exist" "attach the volume at $WORKSPACE and recreate the Pod"

  if command -v mountpoint >/dev/null 2>&1; then
    if mountpoint -q "$WORKSPACE"; then
      WORKSPACE_MOUNT_VERDICT="separate mount (mountpoint)"
    else
      WORKSPACE_MOUNT_VERDICT="NOT a mount point (mountpoint)"
    fi
  else
    ws_dev="$(stat -c %d "$WORKSPACE" 2>/dev/null || printf 'x')"
    root_dev="$(stat -c %d / 2>/dev/null || printf 'y')"
    if [[ "$ws_dev" == "x" || "$root_dev" == "y" ]]; then
      WORKSPACE_MOUNT_VERDICT="undetermined (no mountpoint, no stat -c)"
    elif [[ "$ws_dev" != "$root_dev" ]]; then
      WORKSPACE_MOUNT_VERDICT="separate device from / (stat)"
    else
      WORKSPACE_MOUNT_VERDICT="same device as / (stat)"
    fi
  fi
  info "mount verdict: $WORKSPACE_MOUNT_VERDICT"

  case "$WORKSPACE_MOUNT_VERDICT" in
    separate*) ok "$WORKSPACE is a distinct mount" ;;
    *)
      if ((ALLOW_EPHEMERAL_WORKSPACE == 1)); then
        warn "$WORKSPACE is not a distinct mount and you passed --allow-ephemeral-workspace."
        warn "Every artifact of this run dies when the Pod stops. Export must succeed."
      else
        fail "$WORKSPACE could not be confirmed as a distinct mount ($WORKSPACE_MOUNT_VERDICT): the results may sit on the ephemeral container filesystem and disappear on Pod stop" \
          "attach a RunPod volume at $WORKSPACE and recreate the Pod, or pass --allow-ephemeral-workspace to accept losing the results on stop"
      fi
      ;;
  esac

  probe="$WORKSPACE/.samevoice-session-write-$$"
  if printf 'ok\n' >"$probe" 2>/dev/null; then
    rm -f "$probe"
    ok "$WORKSPACE is writable"
  else
    fail "$WORKSPACE is not writable" "fix the volume permissions before loading any model"
  fi

  free_gb="$(df -Pk "$WORKSPACE" 2>/dev/null | awk 'NR == 2 { printf "%d", $4 / 1048576 }')"
  if [[ -n "$free_gb" ]]; then
    info "free space: ${free_gb} GB (floor: ${MIN_FREE_GB} GB)"
    if ((free_gb < MIN_FREE_GB)); then
      fail "only ${free_gb} GB free on $WORKSPACE, below the ${MIN_FREE_GB} GB floor" \
        "a weight download that dies half-way wastes the whole session; grow the volume or raise SESSION_MIN_FREE_GB deliberately"
    fi
  else
    warn "could not read free space for $WORKSPACE"
  fi
  df -h "$WORKSPACE" >"$SESSION_DIR/workspace-df.txt" 2>/dev/null || true
fi

# ACCEPTANCE STEP 5 -- load the weights, capture the memory around it =======

if skipped warmup; then
  announce_skip 5 "Load the weights and capture the memory around it" warmup \
    "Nothing waited for the services and no weight was preloaded. The first request of every later step will pay the full model load, and the agent's MT client gives up after 4 s."
  # An unhealthy engine is only fatal if a stage that actually talks to one is
  # still scheduled. runpod-stage1-bench.py drives :8101 and :8103 and
  # acoustic-pruning-bench.py drives :8105; the default call test is the mock
  # pipeline and touches none of them. Failing regardless made `--skip-warmup`
  # together with `--skip-bench` -- the salvage run whose only goal is to get an
  # export off a Pod whose hooks are already dead -- abort at a stage the
  # operator had explicitly skipped.
  if [[ -n "$ENABLED_ENGINES" ]]; then
    engines_needed=0
    if ! skipped bench || ! skipped pruning; then engines_needed=1; fi
    for name in $ENABLED_ENGINES; do
      url="$(engine_url "$name")"
      if curl -fsS --max-time 5 "$url/healthz" >/dev/null 2>&1; then
        ok "$name answers $url/healthz"
      elif ((engines_needed == 1)); then
        fail "$name does not answer $url/healthz, warmup was skipped so nothing is waiting for it, and a benchmark stage that needs a live service is still scheduled" \
          "drop --skip-warmup so runpod-warmup.sh can wait for the service, add --skip-bench --skip-pruning if you only want the export, or check the Pod log for a crashed hook"
      else
        warn "$name does not answer $url/healthz. No remaining stage needs it, so the run continues -- but nothing measurable will come out of this session."
      fi
    done
  fi
else
  step 5 "Load the weights and capture the memory around it"
  why "both GPU services load their weights INSIDE the first request (gpu/mt/app.py calls _load in the request path), while the agent's MT client deadline is 4.0 s (providers/mt_runpod.py). Without an out-of-band warmup the first real call times out and every number recorded afterwards is a cold-start artifact. runpod-warmup.sh also owns the health wait, so this is where a dead hook surfaces."
  [[ -f "$WARMUP_SCRIPT" ]] || fail "$WARMUP_SCRIPT is missing" "check out the full repo at $REPO_ROOT"

  # KNOWN BUG GUARD. runpod-warmup.sh:29 reads body="${3:-{}}": bash ends the
  # expansion at the first '}', so every warmup called WITH a body posts a
  # trailing stray '}'. The acoustic and pruner warmups are exactly those calls;
  # FastAPI 422s the malformed JSON, curl -fsS fails and set -e aborts the
  # script, so local MT is never warmed and the closing nvidia-smi never runs.
  # Catching it here costs nothing; discovering it after a weight download costs
  # GPU minutes, which is the failure mode docs/RUNPOD_READINESS.md forbids.
  #
  # -F, not a regex. The pattern is `${3:-{}}`, and `{`/`}` are exactly the
  # characters a basic regular expression reserves for intervals: POSIX leaves
  # an unmatched `{` undefined and implementations disagree. Verified: this
  # guard silently found nothing under a non-GNU grep, which turned the loudest
  # check in the file into a no-op and let the run walk into the broken warmup.
  if grep -qF 'body="${3:-{}}"' "$WARMUP_SCRIPT" 2>/dev/null; then
    if [[ "$ENABLED_ENGINES" == *acoustic* ]]; then
      fail "runpod-warmup.sh:29 has the body=\"\${3:-{}}\" bug and an acoustic engine is enabled: its warmup will POST {\"lang\":\"ru\"}} and abort the script mid-run" \
        "fix that line (for example: local body=\"\${3-}\"; [[ -z \$body ]] && body='{}'), or re-run with --skip-warmup and accept cold-start numbers"
    else
      warn "runpod-warmup.sh:29 has the body=\"\${3:-{}}\" bug. Harmless for this engine set (no bodied warmup is called), fatal as soon as an acoustic engine is enabled."
    fi
  fi

  info "running $WARMUP_SCRIPT (first run downloads weights; this can take minutes)"
  if ! run_child "$TIMEOUT_WARMUP" bash "$WARMUP_SCRIPT"; then
    fail "runpod-warmup.sh failed (or timed out after ${TIMEOUT_WARMUP}s)" \
      "a hook is not healthy or a weight download failed; the Pod log names the crashed service"
  fi
  ok "weights loaded and every enabled service answered its health check"
fi

# ACCEPTANCE STEP 5 -- GPU 0 / GPU 1 process placement =======================

if skipped placement; then
  announce_skip 5 "GPU 0 / GPU 1 process placement" placement \
    "No card-level evidence was captured, so any latency recorded later cannot be told apart from GPU contention."
else
  step 5 "GPU 0 / GPU 1 process placement"
  why "two RTX 4090s are two separate 24 GB pools, not one 48 GB device (gpu/README.md). If THINK and SPEAK land on the same card, step 6 measures contention rather than a model. And the delay is structural, not linguistic -- English and Russian time-to-first-hypothesis differ by 1 ms in this project's own measurements -- so a slow number has to be attributed to a stage and a card, never to a language."

  nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv \
    >"$SESSION_DIR/gpu-after-warmup.csv" 2>/dev/null || true
  emit ""
  if [[ -s "$SESSION_DIR/gpu-after-warmup.csv" ]]; then
    while IFS= read -r line; do emit "  $line"; done <"$SESSION_DIR/gpu-after-warmup.csv"
  fi

  # Truth, when the driver exposes it inside a container. It often does not,
  # which is why the memory delta below is the assertion and this is evidence.
  nvidia-smi --query-compute-apps=gpu_uuid,pid,used_gpu_memory --format=csv \
    >"$SESSION_DIR/gpu-compute-apps.csv" 2>/dev/null || true
  apps_rows="$(sed -n '2,$p' "$SESSION_DIR/gpu-compute-apps.csv" 2>/dev/null | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "${apps_rows:-0}" -gt 0 ]]; then
    ok "nvidia-smi attributed $apps_rows compute process(es); see $SESSION_DIR/gpu-compute-apps.csv"
  else
    info "nvidia-smi listed no compute processes (common inside a container); falling back to per-process intent and memory deltas"
  fi

  # Intent as the kernel sees it: entrypoint.sh pins each hook with
  # CUDA_VISIBLE_DEVICES, and that is readable per PID from /proc.
  : >"$SESSION_DIR/process-placement.txt"
  for proc in /proc/[0-9]*; do
    [[ -r "$proc/environ" ]] || continue
    cvd="$(tr '\0' '\n' <"$proc/environ" 2>/dev/null | sed -n 's/^CUDA_VISIBLE_DEVICES=//p' | head -n 1)"
    [[ -n "$cvd" ]] || continue
    cmd="$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null | cut -c1-160)"
    printf 'pid=%s CUDA_VISIBLE_DEVICES=%s cmd=%s\n' "${proc#/proc/}" "$cvd" "$cmd" >>"$SESSION_DIR/process-placement.txt"
  done
  if [[ -s "$SESSION_DIR/process-placement.txt" ]]; then
    while IFS= read -r line; do info "$line"; done <"$SESSION_DIR/process-placement.txt"
  else
    info "no process exposed CUDA_VISIBLE_DEVICES in /proc"
  fi

  if [[ -z "$EXPECTED_GPUS" ]]; then
    for name in $ENABLED_ENGINES; do
      gpu="$(engine_gpu "$name")"
      case " $EXPECTED_GPUS " in *" $gpu "*) : ;; *) EXPECTED_GPUS="$EXPECTED_GPUS $gpu" ;; esac
    done
    EXPECTED_GPUS="${EXPECTED_GPUS# }"
  fi

  if [[ -z "$EXPECTED_GPUS" ]]; then
    warn "no engine is enabled, so there is no placement to verify. Both cards are idle and billing."
  fi

  unverified=""
  for gpu in $EXPECTED_GPUS; do
    before="$(sed -n "s/^gpu${gpu}_before_mib=//p" "$SESSION_DIR/gpu-memory-deltas.txt" 2>/dev/null | head -n 1)"
    after="$(gpu_memory_used "$gpu")"
    printf 'gpu%s_after_mib=%s\n' "$gpu" "$after" >>"$SESSION_DIR/gpu-memory-deltas.txt"
    if [[ "$after" == "-1" ]] || ((after <= 0)); then
      warn "GPU $gpu shows no memory in use: nothing verifiable is resident on this card"
      unverified="$unverified $gpu"
    elif [[ -n "$before" && "$before" != "-1" ]] && ((after > before)); then
      ok "GPU $gpu: ${before} -> ${after} MiB used; the weights really landed on this card"
    elif [[ -n "$before" && "$before" != "-1" ]]; then
      ok "GPU $gpu: ${after} MiB resident, unchanged since the before-snapshot (already warm, or another process owns it)"
    else
      ok "GPU $gpu: ${after} MiB resident (no before-snapshot to compare against)"
    fi
  done

  if [[ -n "$unverified" ]]; then
    PLACEMENT_VERDICT="unverified for GPU:$unverified"
    if skipped warmup; then
      warn "placement is unverified for GPU:$unverified, but warmup was skipped so no weight was expected to be resident yet"
    elif ((ALLOW_UNVERIFIED_PLACEMENT == 1)); then
      warn "placement is unverified for GPU:$unverified (allowed by --allow-unverified-placement). Step 6 numbers cannot be attributed to a card."
    else
      fail "no evidence that anything is resident on GPU:$unverified after warmup" \
        "the hook for that card is dead or pinned elsewhere -- check *_CUDA_VISIBLE_DEVICES and the Pod log. Measuring now would produce numbers you cannot attribute; pass --allow-unverified-placement only if you accept that"
    fi
  elif [[ -z "$EXPECTED_GPUS" ]]; then
    PLACEMENT_VERDICT="nothing to verify (no engine enabled)"
  else
    PLACEMENT_VERDICT="confirmed for GPU: $EXPECTED_GPUS"
    ok "placement confirmed for GPU: $EXPECTED_GPUS"
  fi
fi

# ACCEPTANCE STEP 6 -- baseline call test ====================================

if skipped calltest; then
  announce_skip 6 "Baseline call test" calltest \
    "The agent state machine was never exercised on this Pod, so a wiring break will surface as a confusing benchmark failure."
else
  step 6 "Baseline call test"
  why "a service that answers /healthz is not a pipeline. This exercises the agent's state machine end to end -- speech_start, partials, chunker commit, MT, TTS, barge-in -- before any number is recorded. Note what it does NOT prove: the mock providers invent transcripts and synthesize a tone, so nothing here touches ports 8101-8105, a GPU, or real endpointing. Endpointing is where the real time goes (Deepgram: 300 ms -> 980 ms to first hypothesis, 100 -> 678, 50 -> 580), and a test that moves no real audio cannot see any of it. The readiness doc's own blocker \"Finish the one-command post-boot scenario\" says the same thing."

  if [[ -n "$CALL_TEST_CMD" ]]; then
    info "running operator-supplied call test: $CALL_TEST_CMD"
    if ! run_child "$TIMEOUT_CALLTEST" bash -lc "$CALL_TEST_CMD"; then
      fail "the call test command failed (or timed out after ${TIMEOUT_CALLTEST}s)" "read its output above"
    fi
  else
    # write_manifest runs from the EXIT trap, so setting this before each refusal
  # is what makes the manifest say WHY the step did not happen. Left at "not
  # run" a refusal reads like nobody asked for the step, which is the opposite
  # of what happened.
  SHADOW_VERDICT="refused: repo or tooling incomplete"
  [[ -d "$AGENT_DIR" ]] || fail "$AGENT_DIR is missing" "check out the full repo at $REPO_ROOT"
    command -v uv >/dev/null 2>&1 || fail "uv is not on PATH, so the agent's mock pipeline cannot run" \
      "pass --call-test-cmd with the invocation that works on this image, or --skip-calltest"
    info "running the agent mock pipeline (npm run demo:pipeline)"
    # The mock trio is PINNED here, not assumed. mock_pipeline_demo.py builds
    # its providers from Config.from_env(), which reads STT_PROVIDER /
    # MT_PROVIDER / TTS_PROVIDER (agent/src/speakeasy_agent/config.py:192-194),
    # and this script sourced the Pod's runtime config with `set -a` a few
    # hundred lines above. A Pod configured the way
    # docker/runpod-gpu.env.example:55-57 documents would therefore send this
    # "mock" step at the live services -- or worse, at Deepgram, Gemini and
    # Cartesia, spending vendor money inside a step whose own screen text
    # promises "no GPU involved". Pinning makes the claim printed below true.
    #
    # The three provider variables were not enough. build_stt() wraps whatever
    # recognizer it just built with the predictor shadow whenever
    # PREDICTOR_SHADOW_ENABLED=1 and PREDICTOR_URL are in the environment
    # (agent/src/speakeasy_agent/providers/__init__.py:78 ->
    # speculation_provider.py:202), and docker/runpod-gpu.env.example:41 sets
    # exactly that. Measured off-Pod against a stub predictor: the same demo
    # command with those two variables left alone issues real /v1/predict calls
    # and drops 6 prediction_shadow records into EVAL_LOG_DIR that nothing in
    # this session reads, under a line promising no GPU. Both shadows are
    # pinned off here so the line printed below is true; producing those records
    # on purpose, and then checking them, is the shadow call test's job.
    info "providers pinned to mock and both shadows pinned off for this step (the Pod config's own STT/MT/TTS_PROVIDER and PREDICTOR_SHADOW_ENABLED are ignored here)"
    if ! run_child "$TIMEOUT_CALLTEST" env \
      STT_PROVIDER=mock MT_PROVIDER=mock TTS_PROVIDER=mock \
      PREDICTOR_SHADOW_ENABLED=0 ACOUSTIC_PRUNER_SHADOW_ENABLED=0 \
      bash -lc "cd '$AGENT_DIR' && uv run python scripts/mock_pipeline_demo.py"; then
      fail "the mock pipeline demo failed (or timed out after ${TIMEOUT_CALLTEST}s)" \
        "the agent cannot complete a call with MOCK providers, so the break is in the agent or its install, not in the GPU services"
    fi
  fi
  ok "the pipeline completed a simulated exchange (mock providers, no GPU involved)"
fi

# ACCEPTANCE STEP 6 -- record the measurements ===============================

if skipped bench && skipped pruning; then
  announce_skip 6 "Record the measurements" bench \
    "Nothing was measured. This session produced no latency evidence at all."
else
  step 6 "Record the measurements"
  why "local GPU is not automatically faster: a self-hosted WhisperLiveKit on an L4 measured 3647 ms to translation against 2095 ms for the cloud chain, and the MT control is gemini-3.5-flash-lite at 635 ms median with 0 failures out of 24 (gemini-3.7-flash: 1133 ms, 3 failures / 24). Those are the numbers the local stack has to beat, and a number that is not written into an artifact does not exist once the Pod is gone."

  resolve_python || fail "no usable python interpreter for the benchmarks" \
    "no layer of Dockerfile.runpod installs a system python3. Build the image with INSTALL_GPU_ENGINES=1 so /opt/venvs/think/bin/python exists, or set SESSION_PYTHON to a working interpreter"
  info "interpreter: $PYTHON_CMD"

  if skipped bench; then
    warn "stage-1 bench skipped: no predictor/MT latency will be recorded"
  else
    [[ -f "$STAGE1_BENCH" ]] || fail "$STAGE1_BENCH is missing" "check out the full repo at $REPO_ROOT"
    # runpod-stage1-bench.py warms and benchmarks BOTH services unconditionally
    # (its lines 85-91 and its four cases), so half the smallest-engine set is
    # not a runnable configuration for it. Saying so here costs nothing;
    # discovering it inside the bench means the predictor's weights were already
    # pulled and the run dies with no artifact, on paid time.
    for pair in "PREDICTOR_CMD:$(engine_cmd predictor)" "LOCAL_MT_CMD:$(engine_cmd local-mt)"; do
      [[ -n "${pair#*:}" ]] || fail "stage-1 bench needs both the predictor and local MT, but ${pair%%:*} is empty" \
        "set ${pair%%:*} in $CONFIG_FILE and recreate the Pod (hooks only start at container boot), or pass --skip-bench"
    done
    info "runpod-stage1-bench.py x${ITERATIONS} (predictor :8101 and local MT :8103 over loopback)"
    # BENCHMARK_DIR is pointed at the session directory so the artifact lands
    # next to the log and the manifest that explain what produced it; the
    # session directory is itself under the benchmark root. PYTHON_CMD may be a
    # multi-word uv invocation, so word splitting is intended here.
    # shellcheck disable=SC2086
    if ! run_child "$TIMEOUT_BENCH" env "BENCHMARK_DIR=$SESSION_DIR" $PYTHON_CMD "$STAGE1_BENCH" --iterations "$ITERATIONS"; then
      fail "runpod-stage1-bench.py failed (or timed out after ${TIMEOUT_BENCH}s)" \
        "the artifact is written only after ALL cases finish, so a failure here means no stage-1 JSON exists for this run"
    fi
    ok "stage-1 artifact written under $SESSION_DIR"
  fi

  if skipped pruning; then
    info "stage-2 acoustic pruning bench skipped by flag"
  elif [[ -z "$PRUNING_WAV" && -z "$PRUNING_CANDIDATES" && -z "$PRUNING_TRUTH" ]]; then
    info "stage-2 acoustic pruning bench not scheduled: it needs --pruning-wav/--pruning-candidates/--pruning-truth/--pruning-lang, and that corpus is not in this repository"
  else
    [[ -f "$PRUNING_BENCH" ]] || fail "$PRUNING_BENCH is missing" "check out the full repo at $REPO_ROOT"
    for pair in "wav:$PRUNING_WAV" "candidates:$PRUNING_CANDIDATES" "truth:$PRUNING_TRUTH" "lang:$PRUNING_LANG"; do
      [[ -n "${pair#*:}" ]] || fail "stage-2 pruning bench needs --pruning-${pair%%:*} as well" \
        "give all four of --pruning-wav --pruning-candidates --pruning-truth --pruning-lang, or none"
    done
    [[ -n "$(engine_cmd acoustic-pruner)" ]] || fail "stage-2 pruning bench was requested but ACOUSTIC_PRUNER_CMD is empty, so :8105 is not running" \
      "enable the pruner hook in $CONFIG_FILE and recreate the Pod, or drop the --pruning-* flags"
    # --output is optional in that script, and without it the report exists only
    # on stdout; on a Pod that is the same as not having run it.
    info "acoustic-pruning-bench.py (${PRUNING_LANG}, truth=${PRUNING_TRUTH})"
    # shellcheck disable=SC2086
    if ! run_child "$TIMEOUT_PRUNING" $PYTHON_CMD "$PRUNING_BENCH" \
      --wav "$PRUNING_WAV" \
      --candidates "$PRUNING_CANDIDATES" \
      --truth "$PRUNING_TRUTH" \
      --lang "$PRUNING_LANG" \
      --url "$(engine_url acoustic-pruner)/v1/prune" \
      --output "$SESSION_DIR/acoustic-pruning.json"; then
      fail "acoustic-pruning-bench.py failed (or timed out after ${TIMEOUT_PRUNING}s)" "read its output above"
    fi
    ok "stage-2 artifact written to $SESSION_DIR/acoustic-pruning.json"
  fi

  # ГЛАВНЫЙ артефакт первой платной сессии, и потому он запускается САМ, а не
  # "руками". Первая сессия отвечает на вопрос, стоит ли механизм угадывания
  # дороже, чем экономит; корпуса для этого не нужно, и оставлять такой замер на
  # память оператора — это ровно тот способ потерять его, от которого мы уже
  # лечили summarize_prediction_shadow.py (печатал только в stdout).
  if ! skipped scorer; then
    if [[ -z "$(engine_cmd predictor)" || -z "$(engine_cmd acoustic-pruner)" ]]; then
      warn "scorer cost bench skipped: it needs BOTH the predictor and the pruner running. Half of it would answer half the question, and a half-answer about latency is worse than none."
    else
      info "scorer-cost-bench.py (${SCORER_LANG}) -- сколько стоит сама машинка угадывания"
      # shellcheck disable=SC2086
      if ! run_child "$TIMEOUT_SCORER" $PYTHON_CMD "$SCORER_COST_BENCH" \
        --lang "$SCORER_LANG" \
        --predictor-url "$(engine_url predictor)" \
        --pruner-url "$(engine_url acoustic-pruner)" \
        ${SCORER_WAV:+--wav "$SCORER_WAV"} \
        --output "$SESSION_DIR/scorer-cost.json"; then
        fail "scorer-cost-bench.py failed (or timed out after ${TIMEOUT_SCORER}s)" "read its output above"
      fi
      ok "cost-only artifact written to $SESSION_DIR/scorer-cost.json"
    fi
  fi

  nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu --format=csv \
    >"$SESSION_DIR/gpu-after-bench.csv" 2>/dev/null || true
  ok "GPU memory after the benchmark saved to $SESSION_DIR/gpu-after-bench.csv"

  # State the gap instead of letting a reader assume the artifact is complete.
  warn "this artifact contains loopback and server-reported latency only. Per-stage GPU queue wait and the t0..t9 timestamps of docs/RUNPOD_RND.md are NOT in it: the readiness blocker 'Add per-stage queue-wait and t0..t9 instrumentation to the benchmark record' is still open. Do not present these numbers as end-to-end."
fi

# ACCEPTANCE STEP 6 -- shadow call test against the local GPU services =======

# WHY this sits AFTER the measurements instead of next to the mock call test:
# runpod-stage1-bench.py drives :8101 directly and is the artifact this session
# is rented to produce, while this step depends on the whole agent chain
# (Config.from_env -> build_stt -> maybe_wrap_stt -> CallEvalLog). A break
# anywhere in that chain must not cost the run its predictor latency JSON.

SHADOW_DIR="$SESSION_DIR/prediction-shadow"
SHADOW_LOG_DIR="$SHADOW_DIR/eval-log"

if ((SHADOW_CALL_TEST == 0)) || skipped shadow; then
  step 6 "Shadow call test against the local GPU services -- NOT RUN"
  if skipped shadow; then
    SHADOW_VERDICT="skipped by --skip shadow"
    warn "asked for and then skipped with --skip shadow."
  else
    SHADOW_VERDICT="not requested"
    warn "not requested. Pass --shadow-call-test (or SESSION_SHADOW_CALL_TEST=1)."
  fi
  warn "Nothing in this session asks the predictor for a prediction the way a call does: the call test above pins the shadow off, and the stage-1 bench, when it runs, talks to :8101 over loopback without the agent."
  warn "Consequence: zero prediction_shadow records, so no artifact of this run says whether the prediction machinery produces a usable record at all -- on a Pod that billed for the predictor the whole time."
else
  step 6 "Shadow call test against the local GPU services"
  why "the predictor's numbers with the agent in the path exist in exactly one place: the prediction_shadow rows of logs/calls/<callId>.jsonl, which agent/scripts/summarize_prediction_shadow.py turns into RTT and STT-lead p50/p90/p95 -- per docs/12-latency-timestamps.md:186 the only complete p95 set this repository can compute today. No corpus and no labels are needed to learn whether those rows appear at all, and that is the whole question here: a session that ends with none of them has paid for a predictor nobody asked anything."

  [[ -d "$AGENT_DIR" ]] || fail "$AGENT_DIR is missing" "check out the full repo at $REPO_ROOT"
  [[ -f "$SUMMARIZE_SHADOW" ]] || fail "$SUMMARIZE_SHADOW is missing" "check out the full repo at $REPO_ROOT"
  command -v uv >/dev/null 2>&1 || fail "uv is not on PATH, so the agent's pipeline cannot be started" \
    "this step drives the agent, not a service: pass the invocation that works on this image via --call-test-cmd for the step above and re-run without --shadow-call-test if uv cannot be fixed"
  command -v curl >/dev/null 2>&1 || fail "curl is missing, so no service health can be verified" \
    "without it this step would start a run that cannot produce a record and would only be found out afterwards"

  # REFUSALS, not warnings. Everything below is knowable in seconds and each one
  # of them turns the run into a demo that writes nothing: the pipeline itself
  # exits 0 whether or not a single prediction succeeded, because shadow mode is
  # observational by construction (speculation.py:411-413 swallows its own
  # errors so a bug there can never damage a call). Measured off-Pod: with the
  # predictor port closed the demo still exits 0 and writes 6
  # prediction_shadow_error rows and 0 prediction_shadow rows.
  SHADOW_VERDICT="refused: PREDICTOR_CMD empty"
  [[ -n "$(engine_cmd predictor)" ]] || fail "the shadow call test needs the predictor, but PREDICTOR_CMD is empty so nothing is listening on :8101" \
    "set PREDICTOR_CMD in $CONFIG_FILE and recreate the Pod (docker/entrypoint.sh starts hooks only at container boot), or drop --shadow-call-test"

  SHADOW_PREDICTOR_URL="$(engine_url predictor)"
  SHADOW_VERDICT="refused: predictor dead or cold"
  predictor_health="$(curl -fsS --max-time 5 "$SHADOW_PREDICTOR_URL/healthz" 2>/dev/null || true)"
  [[ -n "$predictor_health" ]] || fail "the predictor does not answer $SHADOW_PREDICTOR_URL/healthz" \
    "PREDICTOR_CMD is set, so the hook died or never started; the Pod log names it. Do not run this step against a dead service: the pipeline would exit 0 and record only errors"
  info "predictor /healthz: $predictor_health"

  # gpu/predictor/app.py:196-206 publishes `loaded`, and the weights are pulled
  # inside the first request (PredictorEngine._load). The agent abandons a
  # prediction after PREDICTOR_TIMEOUT_MS -- 600 ms by default
  # (docker/runpod-gpu.env.example:44) -- so against a cold predictor every
  # attempt becomes a prediction_shadow_error and the step measures the download.
  if ! printf '%s' "$predictor_health" | grep -Eq '"loaded"[[:space:]]*:[[:space:]]*true'; then
    fail "the predictor answers, but its /healthz reports loaded=false: the weights are not on the card yet" \
      "run without --skip-warmup so runpod-warmup.sh POSTs $SHADOW_PREDICTOR_URL/v1/warmup, or warm it by hand and re-run; a cold predictor turns every attempt of this step into a timeout"
  fi
  ok "predictor is up and its weights are resident"
  SHADOW_VERDICT="refused: pruner unhealthy or session directory unwritable"

  # The mock trio stays pinned. Vendor money is one reason; the other is that the
  # demo feeds a 220 Hz tone (mock_pipeline_demo.py:voiced_frame), so a real
  # recognizer would return nothing, no partial hypothesis would grow, and the
  # shadow would issue zero predictions -- the step would fail for a reason that
  # has nothing to do with the machinery it is testing. The mock recognizer's
  # word-by-word partials (providers/stt_mock.py:_on_voiced) are exactly the
  # growing prefixes PredictionShadow needs, and the shadow wraps whichever
  # recognizer is selected, so the predictor traffic is real either way.
  shadow_env=(
    STT_PROVIDER=mock MT_PROVIDER=mock TTS_PROVIDER=mock
    PREDICTOR_SHADOW_ENABLED=1
    "PREDICTOR_URL=$SHADOW_PREDICTOR_URL"
    # Pinned because a Pod profile that turned the eval log off would produce a
    # green run with an empty directory, which is the failure this step exists
    # to make impossible. EVAL_LOG_DIR points into the session directory so the
    # records leave the Pod with everything else runpod-export.sh collects under
    # BENCHMARK_DIR; the Pod's own logs/calls tree is left alone.
    EVAL_LOG_ENABLED=1
    "EVAL_LOG_DIR=$SHADOW_LOG_DIR"
  )

  if [[ -n "$(engine_cmd acoustic-scout)" ]]; then
    info "ACOUSTIC_SCOUT_CMD is set, but STT stays mock here: :8102 would be asked to transcribe a synthetic tone and would return no words, so there would be no prefix to predict from"
  fi

  if [[ -n "$(engine_cmd acoustic-pruner)" ]]; then
    SHADOW_PRUNER_URL="$(engine_url acoustic-pruner)"
    pruner_health="$(curl -fsS --max-time 5 "$SHADOW_PRUNER_URL/healthz" 2>/dev/null || true)"
    [[ -n "$pruner_health" ]] || fail "ACOUSTIC_PRUNER_CMD is set but $SHADOW_PRUNER_URL/healthz does not answer" \
      "the pruner hook died or never started; the Pod log names it. Blank ACOUSTIC_PRUNER_CMD and recreate the Pod to run the linguistic half alone, or fix the hook"
    info "acoustic-pruner /healthz: $pruner_health"
    if ! printf '%s' "$pruner_health" | grep -Eq '"loaded"[[:space:]]*:[[:space:]]*true'; then
      warn "the pruner reports no loaded CTC engine: its first scoring pays the model load and can exceed ACOUSTIC_PRUNER_TIMEOUT_MS (1500 ms by default). The linguistic records below are unaffected."
    fi
    # every_n=1 for this step only. In production every third attempt is sampled
    # (ACOUSTIC_PRUNER_SHADOW_EVERY_N, docker/runpod-gpu.env.example:64), and
    # this run produces single-digit attempts in total, so at the production rate
    # zero acoustic rows would be indistinguishable from a broken pruner path.
    shadow_env+=(
      ACOUSTIC_PRUNER_SHADOW_ENABLED=1
      "ACOUSTIC_PRUNER_URL=$SHADOW_PRUNER_URL"
      ACOUSTIC_PRUNER_SHADOW_EVERY_N=1
    )
    ok "acoustic pruning shadow enabled against $SHADOW_PRUNER_URL"
  else
    info "ACOUSTIC_PRUNER_CMD is empty, so :8105 is not running: this step records linguistic prediction only (kind=prediction_shadow)"
  fi

  mkdir -p "$SHADOW_LOG_DIR" || fail "cannot create $SHADOW_LOG_DIR" \
    "the session directory is not writable; fix that before spending more GPU time"

  SHADOW_VERDICT="pipeline started, no verdict yet"
  info "running the agent pipeline with predictor shadow ON (eval log -> $SHADOW_LOG_DIR)"
  if ! run_child "$TIMEOUT_SHADOW" env "${shadow_env[@]}" \
    bash -lc "cd '$AGENT_DIR' && uv run python scripts/mock_pipeline_demo.py"; then
    SHADOW_VERDICT="pipeline failed"
    fail "the shadow call test failed (or timed out after ${TIMEOUT_SHADOW}s)" \
      "the same demo ran with every shadow off in the call test above; if that one passed and this one did not, the break is in the shadow path or in the services it calls, not in the agent"
  fi

  # THE assertion of this step. The demo exits 0 even when every single
  # prediction failed, so the record count is the only thing that separates
  # "the machinery works" from "the Pod billed for nothing". The pattern has no
  # space after the colon because evallog.py's _dumps() writes with the compact
  # separators (",", ":"), and it cannot match prediction_shadow_error: that
  # kind has _error before the closing quote.
  shadow_rows="$(cat "$SHADOW_LOG_DIR"/*.jsonl 2>/dev/null | grep -c '"kind":"prediction_shadow"' || true)"
  shadow_errors="$(cat "$SHADOW_LOG_DIR"/*.jsonl 2>/dev/null | grep -c '"kind":"prediction_shadow_error"' || true)"
  acoustic_rows="$(cat "$SHADOW_LOG_DIR"/*.jsonl 2>/dev/null | grep -c '"kind":"acoustic_pruning_shadow"' || true)"

  for shadow_log in "$SHADOW_LOG_DIR"/*.jsonl; do
    [[ -f "$shadow_log" ]] || continue
    info "eval log: $shadow_log ($(wc -l <"$shadow_log" | tr -d ' ') lines)"
  done

  if ((shadow_errors > 0)); then
    warn "$shadow_errors prediction_shadow_error record(s). The first of them:"
    grep -h '"kind":"prediction_shadow_error"' "$SHADOW_LOG_DIR"/*.jsonl 2>/dev/null |
      head -n 3 | while IFS= read -r line; do info "${line:0:400}"; done
  fi

  if ((shadow_rows == 0)); then
    SHADOW_VERDICT="0 prediction_shadow records"
    fail "the pipeline ran but not one prediction_shadow record reached $SHADOW_LOG_DIR" \
      "the predictor answered /healthz, so the break is between the agent and it. Read the error lines above; with no error lines either, the recognizer was never wrapped (providers/__init__.py:78) or every hypothesis stayed under PREDICTOR_MIN_PREFIX_WORDS"
  fi

  # The whole reason ACOUSTIC_PRUNER_SHADOW_EVERY_N was pinned to 1 above is that
  # at the production sampling rate zero acoustic rows would be indistinguishable
  # from a broken pruner path. With every_n=1 that ambiguity is gone, so zero
  # rows is a finding and must not slide past inside a verdict string. Measured
  # off-Pod against a stub pruner: the same demo writes 4 acoustic_pruning_shadow
  # records. Not a `fail`: the raw prediction records and their summary are still
  # worth writing, and aborting here would throw them away.
  if [[ -n "$(engine_cmd acoustic-pruner)" ]] && ((acoustic_rows == 0)); then
    warn "ACOUSTIC_PRUNER_CMD is set, :8105 answered /healthz and sampling was pinned to every_n=1, yet ZERO acoustic_pruning_shadow records were written."
    warn "Consequence: this session says nothing about the pruner as the agent calls it. Either no candidate arm ever collected ACOUSTIC_PRUNER_SHADOW_WINDOWS_MS worth of PCM, or the scoring path is broken (acoustic_shadow.py:_maybe_start_scoring / _score)."
  fi

  SHADOW_VERDICT="$shadow_rows prediction_shadow, $acoustic_rows acoustic_pruning_shadow, $shadow_errors error record(s)"
  ok "$SHADOW_VERDICT"

  resolve_python || fail "no usable python interpreter to summarize the shadow records" \
    "the raw records are already in $SHADOW_LOG_DIR; set SESSION_PYTHON and re-run the summary by hand before stopping the Pod"

  # summarize_prediction_shadow.py has NO output flag: its parser takes the JSONL
  # path and --compact, nothing else (agent/scripts/summarize_prediction_shadow.py:215-217),
  # and "give it a file destination under $BENCHMARK_DIR" is still an open item
  # in the export blocker of docs/RUNPOD_READINESS.md. Redirecting its stdout
  # here is therefore the whole of "the numbers survive the Pod" -- do not
  # invent a flag, and do not leave the report on a terminal that closes.
  for shadow_log in "$SHADOW_LOG_DIR"/*.jsonl; do
    [[ -f "$shadow_log" ]] || continue
    shadow_summary="$SHADOW_DIR/summary-$(basename "$shadow_log" .jsonl).json"
    # PYTHON_CMD may be a multi-word uv invocation, so word splitting is intended.
    # shellcheck disable=SC2086
    if guard "$TIMEOUT_SHADOW" $PYTHON_CMD "$SUMMARIZE_SHADOW" "$shadow_log" >"$shadow_summary"; then
      ok "summary written to $shadow_summary"
      while IFS= read -r line; do emit "    $line"; done <"$shadow_summary"
    else
      rm -f "$shadow_summary"
      warn "summarize_prediction_shadow.py failed on $shadow_log. The raw records survive in $SHADOW_LOG_DIR; summarize them off the Pod."
    fi
  done

  # State what these numbers are not, next to them, so nobody has to remember it
  # later. Round-trip and lead are real; recall is not a measurement at all here.
  warn "recall in the summary above is meaningless: the mock recognizer invents its transcripts from fixtures (providers/stt_mock.py), so Top-K hits describe fixture text, not prediction quality. What this step establishes is that records appear and what the predictor round trip costs with the agent in the path."
fi

STATUS="passed"
exit 0
