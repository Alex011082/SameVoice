#!/usr/bin/env bash
set -euo pipefail

# Get a paid session's measurements OFF the Pod before it is stopped.
#
# docs/RUNPOD_RND.md already states the rule -- "Do not treat a RunPod Pod as
# the only copy of anything important" -- but nothing implemented it. Every
# artifact path in Dockerfile.runpod points inside /workspace, and
# docker/entrypoint.sh's cleanup() only kills child PIDs, so a stop signal
# flushes and copies nothing. docs/RUNPOD_READINESS.md step 7 already *requires*
# this -- "export the artifacts off the Pod BEFORE stopping it, and write a run
# manifest next to them (GPU model/driver, image tag/digest, git SHA, enabled
# engines, env profile)" -- and step 8 is "stop the Pod". Nothing in the
# repository implemented step 7. This script is that implementation, and it runs
# BEFORE the Pod is stopped, not after.
#
# It only reads and packs. It never uploads anywhere: an export that needs a
# credential would put one more secret on a machine that is about to be
# destroyed. The operator pulls the tarball with the command printed at the end.

WORKSPACE="${WORKSPACE_ROOT:-/workspace}"
EXPORT_DIR="${SAMEVOICE_EXPORT_DIR:-${WORKSPACE}/exports}"
REPO_ROOT="${SAMEVOICE_ROOT:-/opt/samevoice}"

BENCH_DIR="${BENCHMARK_DIR:-${WORKSPACE}/benchmarks}"
EVAL_DIR="${EVAL_LOG_DIR:-${WORKSPACE}/logs/calls}"
# docker/entrypoint.sh inherits stdout for every service, so unless the operator
# redirected them by hand this directory is empty and the only copy of a crash
# is the RunPod console stream. The bundle records that fact rather than hiding
# it -- see the note written into NOTES.txt below.
SERVICE_LOG_DIR="${SAMEVOICE_SERVICE_LOG_DIR:-${WORKSPACE}/logs/services}"

# Voice is biometrics in this repo (README.md, docs/RUNPOD_RND.md "Data
# persistence"). These trees are never opened and never walked.
#
# CALL_ARCHIVE_DIR is on the list for a different reason and it is the one that
# actually bites. .env.example ("Call archive") describes it as one JSON file
# per finished call -- the record of a conversation two people had, readable by
# exactly those two -- and it sits at ${WORKSPACE}/logs/archive, the sibling of
# the ${WORKSPACE}/logs/calls this script does export. .json is on the allowed
# extension list, so an EVAL_LOG_DIR pointed one level up at ${WORKSPACE}/logs
# would sweep every archived private call into the tarball and the extension
# gate would not stop it. Nothing here is worth that.
FORBIDDEN_ROOTS=(
  "${MODEL_DIR:-${WORKSPACE}/models}"
  "${CHECKPOINT_DIR:-${WORKSPACE}/checkpoints}"
  "${DATASET_DIR:-${WORKSPACE}/datasets}"
  "${HF_HOME:-${WORKSPACE}/hf-cache}"
  "${TORCH_HOME:-${WORKSPACE}/torch-cache}"
  "${WORKSPACE}/voices"
  "${CALL_ARCHIVE_DIR:-${WORKSPACE}/logs/archive}"
  # IDENTITY_DIR is the sharpest one on this list. Its single identities.json
  # holds every phone-registered profile AND the phone->user index -- the
  # numbers themselves, in plain text, because that index is what stops one
  # number minting a second profile. .json is an allowed extension, so a source
  # pointed at ${WORKSPACE}/data would carry a directory of real people's phone
  # numbers off the Pod inside an otherwise ordinary bundle.
  "${IDENTITY_DIR:-${WORKSPACE}/data/identity}"
)

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { NOTES+=("$*"); }

NOTES=()

# ---------------------------------------------------------------------------
# Portability helpers. GNU stat and BSD stat disagree on flags; the script has
# to run both inside the CUDA image and on a maintainer laptop, because an
# export script that can only be tested on a paid Pod is tested nowhere.
# ---------------------------------------------------------------------------

device_id() { stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null; }
mtime_epoch() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
abs_path() { (cd "$1" 2>/dev/null && pwd -P); }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

utc_from_epoch() {
  date -u -d "@$1" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || date -u -r "$1" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || printf 'unknown'
}

# Minimal JSON string escaping. The manifest is written by hand because the
# image has no guaranteed system python3 (Dockerfile.runpod installs none) and
# the export must still work when the uv environment is broken -- a broken
# environment is exactly when the logs are worth the most.
jstr() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | tr -d '\000-\037'
}

# ---------------------------------------------------------------------------
# Gate: the destination must be on the persistent volume.
#
# scripts/runpod-preflight.sh proves only that /workspace is *writable*, which
# is equally true of the ephemeral container overlay. Writing the one copy of a
# paid session onto container disk and then stopping the Pod destroys it, so
# this check compares device ids instead of trying a write.
# ---------------------------------------------------------------------------

[[ -d "$WORKSPACE" ]] || die "workspace root does not exist: ${WORKSPACE}. No persistent volume is mounted; there is nowhere safe to write an export."

mkdir -p "$EXPORT_DIR"

root_dev="$(device_id /)" || true
dest_dev="$(device_id "$EXPORT_DIR")" || true
[[ -n "$root_dev" && -n "$dest_dev" ]] \
  || die "cannot read filesystem device ids for / and ${EXPORT_DIR}; refusing to write an export whose persistence cannot be proven."

EPHEMERAL_DEST=false
if [[ "$dest_dev" == "$root_dev" ]]; then
  EPHEMERAL_DEST=true
fi

if [[ "$EPHEMERAL_DEST" == true && "${SAMEVOICE_EXPORT_ALLOW_EPHEMERAL:-0}" != "1" ]]; then
  cat >&2 <<EOF
ERROR: ${EXPORT_DIR} is on the same filesystem as / -- it is container disk, not
the persistent volume.

Why this is fatal: container disk is part of the Pod image layer. Everything
written there disappears when the Pod is stopped or terminated, which is the
exact moment this script exists to survive. Writing the bundle here would
produce a green "export complete" and still lose the whole paid session.

Fix: attach the volume at ${WORKSPACE} in the RunPod Pod configuration and run
this again. If the Pod is already running without a volume, pull the raw
directories out over ssh right now (see docs/RUNPOD_RND.md) and do not stop the
Pod until they are on your laptop.

Set SAMEVOICE_EXPORT_ALLOW_EPHEMERAL=1 only to test this script off a Pod.
EOF
  # Leave no empty export directory behind on container disk: the next operator
  # must not find one and read it as evidence that an export ever ran.
  rmdir "$EXPORT_DIR" 2>/dev/null || true
  exit 1
fi

if [[ "$EPHEMERAL_DEST" == true ]]; then
  printf 'WARNING: destination is on container disk and SAMEVOICE_EXPORT_ALLOW_EPHEMERAL=1 was set.\n' >&2
  printf 'WARNING: this bundle does NOT survive a Pod stop. It is recorded as ephemeral in the manifest.\n' >&2
  note "destination_was_container_disk: SAMEVOICE_EXPORT_ALLOW_EPHEMERAL=1 was set; this bundle was not written to a persistent volume."
fi

# ---------------------------------------------------------------------------
# Bundle identity. The timestamp is the name; the counter only exists so that a
# second run inside the same second cannot overwrite the first one's tarball.
# "Safe to run twice" has to mean "the first bundle is still there".
#
# The name is claimed with mkdir rather than with a `[[ -e ]]` test, because a
# test is not atomic: three runs started in the same second all pass it, all
# pick the same name and two of the three bundles are then silently lost. mkdir
# either creates the directory or fails, so exactly one run owns a name.
# ---------------------------------------------------------------------------

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
BUNDLE=""
suffix=1
while (( suffix <= 99 )); do
  candidate="samevoice-export-${STAMP}"
  if (( suffix > 1 )); then candidate="samevoice-export-${STAMP}-${suffix}"; fi
  if [[ ! -e "${EXPORT_DIR}/${candidate}.tar.gz" ]] && mkdir "${EXPORT_DIR}/.claim-${candidate}" 2>/dev/null; then
    BUNDLE="$candidate"
    break
  fi
  suffix=$((suffix + 1))
done
[[ -n "$BUNDLE" ]] || die "could not claim an export name under ${EXPORT_DIR} after 99 attempts. Remove stale .claim-* directories left by a killed run."

TARBALL="${EXPORT_DIR}/${BUNDLE}.tar.gz"
CLAIM="${EXPORT_DIR}/.claim-${BUNDLE}"
PARTIAL="${TARBALL}.partial.$$"

STAGE="${EXPORT_DIR}/.staging-${BUNDLE}-$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"
# A killed run must not leave half a bundle looking like a real one.
trap 'rm -rf "$STAGE" "$PARTIAL" "$CLAIM"' EXIT INT TERM

EXCLUDED="${STAGE}/EXCLUDED.txt"
: > "$EXCLUDED"

# ---------------------------------------------------------------------------
# Collection policy.
#
# Allow-list by extension rather than deny-list by extension: a deny-list is one
# unknown file format away from shipping raw audio or a voice embedding off the
# Pod, and this repo treats voice as biometrics. Everything skipped is named in
# EXCLUDED.txt, so nothing disappears silently.
# ---------------------------------------------------------------------------

ALLOWED_EXT="json jsonl ndjson csv tsv txt log md toml yaml yml"

is_allowed_ext() {
  local ext="$1" candidate
  for candidate in $ALLOWED_EXT; do
    [[ "$ext" == "$candidate" ]] && return 0
  done
  return 1
}

# Second gate, on the file name. It deliberately over-rejects: a benchmark file
# that happens to contain "key" in its name is cheaper to lose than one leaked
# credential, and EXCLUDED.txt tells the operator it happened.
is_secret_name() {
  case "$1" in
    .env|.env.*|*.env|*secret*|*token*|*credential*|*password*|*apikey*|*api_key*|*key*|id_rsa*|id_ed25519*|*.pem|*.pfx|*.p12|*.key)
      return 0 ;;
  esac
  return 1
}

# Containment is checked in BOTH directions, because only one of them is the
# obvious mistake. A source pointed *into* a forbidden tree is the loud error
# everyone thinks of; a source pointed at a *parent* of one -- EVAL_LOG_DIR set
# to ${WORKSPACE}/logs instead of ${WORKSPACE}/logs/calls -- is the quiet one,
# and it is the one that walks straight into the private call archive. Both
# abort. Silently pruning the forbidden subtree instead would be worse: the
# operator would get a bundle that looks complete and never learn that the
# source they configured was not the one they meant.
assert_not_forbidden() {
  local dir="$1" resolved forbidden f_resolved
  resolved="$(abs_path "$dir")" || return 0
  [[ -n "$resolved" ]] || return 0
  for forbidden in "${FORBIDDEN_ROOTS[@]}"; do
    f_resolved="$(abs_path "$forbidden")" || continue
    [[ -n "$f_resolved" ]] || continue
    if [[ "$resolved" == "$f_resolved" || "$resolved" == "$f_resolved"/* ]]; then
      die "refusing to export ${dir}: it resolves inside ${f_resolved}, which holds model weights, datasets, voice references or archived calls. None of that leaves the Pod through this script."
    fi
    if [[ "$f_resolved" == "$resolved"/* ]]; then
      die "refusing to export ${dir}: ${f_resolved} lies inside it, and that tree holds model weights, datasets, voice references or archived calls. Point the source at the specific results directory (${WORKSPACE}/logs/calls, not ${WORKSPACE}/logs) and run again."
    fi
  done
}

SRC_NAMES=()
SRC_PATHS=()
SRC_FILES=()
SRC_BYTES=()
SRC_NEWEST=()

collect_tree() {
  local label="$1" src="$2" dest="${STAGE}/$3"
  local files=0 bytes=0 newest=0 rel base lbase ext size mt

  SRC_NAMES+=("$label")
  SRC_PATHS+=("$src")

  if [[ ! -d "$src" ]]; then
    SRC_FILES+=(0); SRC_BYTES+=(0); SRC_NEWEST+=(0)
    note "missing_source: ${label} (${src}) did not exist at export time."
    printf '  %-16s %s\n' "$label" "MISSING ($src)"
    return 0
  fi

  src="$(abs_path "$src")"
  assert_not_forbidden "$src"
  mkdir -p "$dest"

  while IFS= read -r -d '' path; do
    rel="${path#"$src"/}"
    base="$(basename "$path")"
    lbase="$(lower "$base")"

    if is_secret_name "$lbase"; then
      printf '%s\tskipped: name matches the secret/credential pattern\n' "$path" >> "$EXCLUDED"
      continue
    fi

    case "$base" in
      *.*) ext="$(lower "${base##*.}")" ;;
      *)   ext="" ;;
    esac

    if ! is_allowed_ext "$ext"; then
      printf '%s\tskipped: .%s is not a text/measurement extension (audio, embeddings and weights are excluded by construction)\n' "$path" "${ext:-none}" >> "$EXCLUDED"
      continue
    fi

    mkdir -p "$(dirname "${dest}/${rel}")"
    cp -p "$path" "${dest}/${rel}"

    files=$((files + 1))
    size="$(wc -c < "$path" | tr -d ' ')"
    bytes=$((bytes + size))
    mt="$(mtime_epoch "$path")" || mt=0
    [[ -n "$mt" ]] || mt=0
    if (( mt > newest )); then newest="$mt"; fi
  done < <(find "$src" -type f -print0)

  SRC_FILES+=("$files"); SRC_BYTES+=("$bytes"); SRC_NEWEST+=("$newest")
  printf '  %-16s %s file(s), %s byte(s)\n' "$label" "$files" "$bytes"
}

printf 'SameVoice RunPod export\n'
printf 'workspace: %s\n' "$WORKSPACE"
printf 'bundle:    %s\n\n' "$TARBALL"

printf 'collecting:\n'
collect_tree "eval-logs" "$EVAL_DIR" "eval-logs"
collect_tree "benchmarks" "$BENCH_DIR" "benchmarks"
collect_tree "service-logs" "$SERVICE_LOG_DIR" "service-logs"

if [[ ! -d "$SERVICE_LOG_DIR" ]]; then
  note "service_logs_not_on_disk: docker/entrypoint.sh starts every service with inherited stdout and redirects nothing, so process/crash output exists only in the RunPod console stream. Copy it out of the console by hand if the session had a failure."
fi

# ---------------------------------------------------------------------------
# GPU snapshot. Taken now rather than read from a file, because nothing in the
# repo ever writes one: scripts/runpod-warmup.sh prints post-warmup VRAM to
# stdout only, so it dies with the terminal session.
#
# A missing nvidia-smi is recorded, not fatal. The whole point of this script is
# salvage, and a Pod whose GPU stack has fallen over is exactly when the eval
# logs matter most.
# ---------------------------------------------------------------------------

mkdir -p "${STAGE}/gpu"
GPU_CSV="${STAGE}/gpu/nvidia-smi.csv"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu,driver_version \
    --format=csv,noheader > "$GPU_CSV" 2>/dev/null || true
  nvidia-smi -L > "${STAGE}/gpu/nvidia-smi-L.txt" 2>/dev/null || true
  nvidia-smi > "${STAGE}/gpu/nvidia-smi.txt" 2>/dev/null || true
  # GPU 0 / GPU 1 process placement is step 5 of the acceptance test, and
  # runpod-preflight.sh:111-113 only echoes the *intended* split from env vars.
  # docs/RUNPOD_READINESS.md warns that nvidia-smi inside a container generally
  # cannot attribute processes, so this may well come back empty -- it is
  # captured anyway because when it is not empty it is the only such evidence.
  nvidia-smi --query-compute-apps=pid,process_name,used_memory \
    --format=csv,noheader > "${STAGE}/gpu/nvidia-smi-compute-apps.csv" 2>/dev/null || true
  printf '  gpu              nvidia-smi captured\n'
else
  : > "$GPU_CSV"
  note "nvidia_smi_unavailable: nvidia-smi was not on PATH at export time; the bundle carries no GPU inventory."
  printf '  gpu              nvidia-smi UNAVAILABLE\n'
fi

# ---------------------------------------------------------------------------
# Resolved model manifest.
#
# gpu/model_manifest.toml is the *selection*; every service's /healthz reports
# what actually loaded (gpu/predictor/app.py, gpu/mt/app.py, gpu/tts/app.py,
# gpu/acoustic/app.py, gpu/acoustic/prune_app.py all return their model ids and
# load state). A benchmark number attributed to the wrong checkpoint is worse
# than no number, so the bundle carries both.
# ---------------------------------------------------------------------------

mkdir -p "${STAGE}/manifest"
if [[ -f "${REPO_ROOT}/gpu/model_manifest.toml" ]]; then
  cp -p "${REPO_ROOT}/gpu/model_manifest.toml" "${STAGE}/manifest/model_manifest.toml"
else
  note "model_manifest_missing: ${REPO_ROOT}/gpu/model_manifest.toml was not found; set SAMEVOICE_ROOT if the checkout lives elsewhere."
fi

# Each service is probed at its loopback default, exactly as docker/healthcheck.sh
# and scripts/runpod-warmup.sh do, rather than only when a *_URL happens to be
# exported.
#
# That distinction decides whether this section works at all. Neither
# Dockerfile.runpod nor docker/entrypoint.sh exports PREDICTOR_URL and friends;
# they live in .env, which the agent's own process loads, and in
# ${SAMEVOICE_CONFIG_FILE}, which docs/RUNPOD_READINESS.md step 2 has to remind
# the operator to source by hand. An operator who opens a shell to run this
# script therefore has none of them set. Reading "${PREDICTOR_URL:-}" and
# returning early on empty would skip all five services in the ordinary case and
# say nothing about it -- a bundle silently missing the only evidence of which
# checkpoint actually produced the numbers.
#
# A service that was not enabled this session simply does not answer, costs one
# 3-second timeout, and is recorded as a note. Unreachable is worth recording:
# the alternative is a benchmark number with no attribution.
HEALTHZ_OK=0
HEALTHZ_MISS=0

capture_healthz() {
  local name="$1" url="$2" out="${STAGE}/manifest/healthz-${1}.json"
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  if curl -fsS --max-time 3 "${url}/healthz" > "$out" 2>/dev/null; then
    printf '\n' >> "$out"
    HEALTHZ_OK=$((HEALTHZ_OK + 1))
  else
    rm -f "$out"
    HEALTHZ_MISS=$((HEALTHZ_MISS + 1))
    note "healthz_unreachable: ${name} did not answer ${url}/healthz at export time -- either it was not enabled for this session, or it was down. Its resolved model id is not in this bundle; do not attribute a number to a checkpoint on the strength of gpu/model_manifest.toml alone."
  fi
}

if command -v curl >/dev/null 2>&1; then
  capture_healthz predictor "${PREDICTOR_URL:-http://127.0.0.1:8101}"
  capture_healthz acoustic "${ACOUSTIC_SCOUT_URL:-http://127.0.0.1:8102}"
  capture_healthz local-mt "${LOCAL_MT_URL:-http://127.0.0.1:8103}"
  capture_healthz local-tts "${LOCAL_TTS_URL:-http://127.0.0.1:8104}"
  capture_healthz acoustic-pruner "${ACOUSTIC_PRUNER_URL:-http://127.0.0.1:8105}"
  printf '  manifest         model manifest + %s/%s service(s) answered /healthz\n' \
    "$HEALTHZ_OK" "$((HEALTHZ_OK + HEALTHZ_MISS))"
else
  note "curl_unavailable: curl was not on PATH at export time, so no service /healthz was captured and no model id in this bundle is confirmed as loaded."
  printf '  manifest         model manifest only (curl UNAVAILABLE)\n'
fi

# ---------------------------------------------------------------------------
# Environment, without secrets.
#
# Allow-list by name, and a deny-list on top of it, in that order -- RunPod
# injects RUNPOD_* variables that include credentials, so the prefix alone is
# not safe. Withheld names are listed (never their values): knowing that
# DEEPGRAM_API_KEY was set is part of the provenance of a latency number.
# ---------------------------------------------------------------------------

mkdir -p "${STAGE}/env"
ENV_OUT="${STAGE}/env/environment.txt"
ENV_WITHHELD="${STAGE}/env/withheld-names.txt"
: > "$ENV_OUT"
: > "$ENV_WITHHELD"

is_secret_env_name() {
  case "$1" in
    *KEY*|*TOKEN*|*SECRET*|*PASSWORD*|*PASSWD*|*CREDENTIAL*|*AUTH*|*COOKIE*|*PRIVATE*|*SIGNATURE*|*SESSION*|*_SID|*DSN*)
      return 0 ;;
  esac
  return 1
}

is_reportable_env_name() {
  case "$1" in
    WORKSPACE_ROOT|EXPECTED_GPU_COUNT|TZ|HOSTNAME|LANG|CUDA_VERSION) return 0 ;;
    SAMEVOICE_*|ACOUSTIC_*|PREDICTOR_*|LOCAL_MT_*|LOCAL_TTS_*|RUNPOD_*|NVIDIA_*|CUDA_VISIBLE_DEVICES|TTS_CUDA_VISIBLE_DEVICES) return 0 ;;
    STT_PROVIDER|MT_PROVIDER|TTS_PROVIDER) return 0 ;;
    MODEL_DIR|CHECKPOINT_DIR|DATASET_DIR|BENCHMARK_DIR|HF_HOME|TORCH_HOME|XDG_CACHE_HOME|UV_CACHE_DIR|CALL_ARCHIVE_DIR|EVAL_LOG_DIR|IDENTITY_DIR) return 0 ;;
    BACKEND_HOST|BACKEND_PORT|AGENT_HOST|AGENT_PORT|WEB_PORT) return 0 ;;
    EVAL_LOG_ENABLED|DEEPGRAM_ENDPOINTING_MS|*_MODEL|*_MODEL_*|*_LOOKAHEAD) return 0 ;;
  esac
  return 1
}

while IFS= read -r line; do
  case "$line" in
    *=*) ;;
    # A line without '=' is the continuation of a multi-line value. It is
    # dropped rather than guessed at, because a wrapped value is exactly the
    # shape a pasted private key has.
    *) continue ;;
  esac
  env_name="${line%%=*}"
  env_value="${line#*=}"
  if is_secret_env_name "$env_name"; then
    printf '%s\n' "$env_name" >> "$ENV_WITHHELD"
    continue
  fi
  if is_reportable_env_name "$env_name"; then
    printf '%s=%s\n' "$env_name" "$env_value" >> "$ENV_OUT"
  fi
done < <(env)

LC_ALL=C sort -o "$ENV_OUT" "$ENV_OUT"
LC_ALL=C sort -u -o "$ENV_WITHHELD" "$ENV_WITHHELD"
printf '  env              %s reported, %s name(s) withheld\n' \
  "$(wc -l < "$ENV_OUT" | tr -d ' ')" "$(wc -l < "$ENV_WITHHELD" | tr -d ' ')"

# ---------------------------------------------------------------------------
# Run manifest.
#
# .dockerignore excludes .git from the image and no build argument records a
# commit, so inside a Pod the git SHA is genuinely unknowable. The manifest says
# so instead of inventing one -- an artifact that claims a wrong commit is worse
# than one that admits it has none.
# ---------------------------------------------------------------------------

GIT_SHA=""
GIT_SHA_REASON=""
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
if [[ -z "$GIT_SHA" ]]; then
  GIT_SHA_REASON="unavailable: .dockerignore excludes .git from the RunPod image and no build argument records a commit"
  note "git_sha_unknown: ${GIT_SHA_REASON}. Attribute this bundle by image tag/digest from the RunPod console instead."
fi

POD_UPTIME_S=""
if [[ -r /proc/uptime ]]; then
  POD_UPTIME_S="$(cut -d' ' -f1 < /proc/uptime)"
fi

MANIFEST="${STAGE}/run-manifest.json"
{
  printf '{\n'
  printf '  "schema_version": 1,\n'
  printf '  "kind": "samevoice-runpod-export",\n'
  printf '  "bundle": "%s",\n' "$(jstr "$BUNDLE")"
  printf '  "created_at": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '  "created_at_unix": %s,\n' "$(date -u '+%s')"
  printf '  "pod_uptime_s": %s,\n' "${POD_UPTIME_S:-null}"
  printf '  "host": {\n'
  printf '    "hostname": "%s",\n' "$(jstr "$(hostname 2>/dev/null || echo unknown)")"
  printf '    "uname": "%s"\n' "$(jstr "$(uname -a 2>/dev/null || echo unknown)")"
  printf '  },\n'
  if [[ -n "$GIT_SHA" ]]; then
    printf '  "git_sha": "%s",\n' "$(jstr "$GIT_SHA")"
  else
    printf '  "git_sha": null,\n'
    printf '  "git_sha_note": "%s",\n' "$(jstr "$GIT_SHA_REASON")"
  fi
  printf '  "workspace": {\n'
  printf '    "root": "%s",\n' "$(jstr "$WORKSPACE")"
  printf '    "export_dir": "%s",\n' "$(jstr "$EXPORT_DIR")"
  printf '    "root_device_id": "%s",\n' "$(jstr "$root_dev")"
  printf '    "export_device_id": "%s",\n' "$(jstr "$dest_dev")"
  printf '    "on_persistent_volume": %s\n' "$([[ "$EPHEMERAL_DEST" == true ]] && echo false || echo true)"
  printf '  },\n'

  printf '  "gpus": ['
  gpu_first=1
  while IFS= read -r gpu_line; do
    [[ -n "$gpu_line" ]] || continue
    g_index="$(printf '%s' "$gpu_line" | cut -d, -f1 | sed 's/^ *//;s/ *$//')"
    g_name="$(printf '%s' "$gpu_line" | cut -d, -f2 | sed 's/^ *//;s/ *$//')"
    g_total="$(printf '%s' "$gpu_line" | cut -d, -f3 | sed 's/^ *//;s/ *$//')"
    g_used="$(printf '%s' "$gpu_line" | cut -d, -f4 | sed 's/^ *//;s/ *$//')"
    g_util="$(printf '%s' "$gpu_line" | cut -d, -f5 | sed 's/^ *//;s/ *$//')"
    g_driver="$(printf '%s' "$gpu_line" | cut -d, -f6 | sed 's/^ *//;s/ *$//')"
    (( gpu_first )) || printf ','
    gpu_first=0
    printf '\n    {"index": "%s", "name": "%s", "memory_total": "%s", "memory_used": "%s", "utilization_gpu": "%s", "driver_version": "%s"}' \
      "$(jstr "$g_index")" "$(jstr "$g_name")" "$(jstr "$g_total")" "$(jstr "$g_used")" "$(jstr "$g_util")" "$(jstr "$g_driver")"
  done < "$GPU_CSV"
  (( gpu_first )) || printf '\n  '
  printf '],\n'

  printf '  "sources": ['
  src_i=0
  while (( src_i < ${#SRC_NAMES[@]} )); do
    (( src_i == 0 )) || printf ','
    printf '\n    {"name": "%s", "path": "%s", "files": %s, "bytes": %s, "newest_file_utc": "%s"}' \
      "$(jstr "${SRC_NAMES[$src_i]}")" \
      "$(jstr "${SRC_PATHS[$src_i]}")" \
      "${SRC_FILES[$src_i]}" \
      "${SRC_BYTES[$src_i]}" \
      "$([[ "${SRC_NEWEST[$src_i]}" == 0 ]] && echo none || utc_from_epoch "${SRC_NEWEST[$src_i]}")"
    src_i=$((src_i + 1))
  done
  (( src_i == 0 )) || printf '\n  '
  printf '],\n'

  printf '  "policy": {\n'
  printf '    "allowed_extensions": "%s",\n' "$(jstr "$ALLOWED_EXT")"
  printf '    "secrets_included": false,\n'
  printf '    "raw_audio_included": false,\n'
  printf '    "voice_embeddings_included": false,\n'
  printf '    "excluded_file_list": "EXCLUDED.txt"\n'
  printf '  },\n'

  printf '  "notes": ['
  note_i=0
  while (( note_i < ${#NOTES[@]} )); do
    (( note_i == 0 )) || printf ','
    printf '\n    "%s"' "$(jstr "${NOTES[$note_i]}")"
    note_i=$((note_i + 1))
  done
  (( note_i == 0 )) || printf '\n  '
  printf ']\n'
  printf '}\n'
} > "$MANIFEST"

{
  printf 'SameVoice RunPod export bundle\n'
  printf '\n'
  printf 'run-manifest.json  what produced this bundle: timestamps, GPU inventory,\n'
  printf '                   non-secret environment summary, per-source counts.\n'
  printf 'eval-logs/         per-call utterance JSONL written by the agent.\n'
  printf 'benchmarks/        benchmark artifacts written under BENCHMARK_DIR.\n'
  printf 'service-logs/      only present if service stdout was redirected to disk.\n'
  printf 'gpu/               nvidia-smi taken at export time.\n'
  printf 'manifest/          gpu/model_manifest.toml plus each service /healthz,\n'
  printf '                   which reports the model id that actually loaded.\n'
  printf 'env/               allow-listed environment; withheld-names.txt lists the\n'
  printf '                   names (never values) of variables held back as secrets.\n'
  printf 'EXCLUDED.txt       every file this export deliberately left on the Pod.\n'
  printf '\n'
  printf 'No secrets, no raw audio and no voice embeddings are in this bundle.\n'
  if (( ${#NOTES[@]} > 0 )); then
    printf '\nNotes recorded at export time:\n'
    note_i=0
    while (( note_i < ${#NOTES[@]} )); do
      printf '  - %s\n' "${NOTES[$note_i]}"
      note_i=$((note_i + 1))
    done
  fi
} > "${STAGE}/NOTES.txt"

# ---------------------------------------------------------------------------
# Pack. Write to .partial first: an interrupted tar must never leave a file that
# looks like a finished bundle next to the ones that are.
# ---------------------------------------------------------------------------

stage_kb="$(du -sk "$STAGE" | awk '{print $1}')"
avail_kb="$(df -Pk "$EXPORT_DIR" | awk 'NR==2 {print $4}')"
if [[ -n "$avail_kb" ]] && (( avail_kb <= stage_kb )); then
  die "not enough free space on ${EXPORT_DIR}: staged ${stage_kb} KiB, available ${avail_kb} KiB. Free space or pull the raw directories over ssh before stopping the Pod."
fi

tar -czf "$PARTIAL" -C "$STAGE" .
mv "$PARTIAL" "$TARBALL"

SHA=""
if command -v sha256sum >/dev/null 2>&1; then
  SHA="$(sha256sum "$TARBALL" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
fi
if [[ -n "$SHA" ]]; then
  printf '%s  %s\n' "$SHA" "$(basename "$TARBALL")" > "${TARBALL}.sha256"
fi

SIZE="$(du -h "$TARBALL" | awk '{print $1}')"

# ---------------------------------------------------------------------------
# The pull command.
#
# RunPod's ssh host and port are console values, not repo values. When the Pod
# injects them they are used verbatim; otherwise the line is printed with
# placeholders and says where the real values come from, because a copy-pasted
# wrong host is a silent failure at the worst possible moment.
# ---------------------------------------------------------------------------

POD_HOST="${RUNPOD_PUBLIC_IP:-}"
POD_PORT="${RUNPOD_TCP_PORT_22:-}"
host_note=""
if [[ -z "$POD_HOST" || -z "$POD_PORT" ]]; then
  POD_HOST="${POD_HOST:-<POD_HOST>}"
  POD_PORT="${POD_PORT:-<SSH_PORT>}"
  host_note="host/port are not exposed to this container: take them from the RunPod console 'Connect -> SSH' line."
fi

SCP_LINE="scp -P ${POD_PORT} root@${POD_HOST}:${TARBALL} ."
RSYNC_LINE="rsync -avP -e 'ssh -p ${POD_PORT}' root@${POD_HOST}:${TARBALL} ."

{
  printf 'bundle:  %s\n' "$TARBALL"
  printf 'sha256:  %s\n' "${SHA:-unavailable}"
  printf 'pull:    %s\n' "$SCP_LINE"
  printf 'resume:  %s\n' "$RSYNC_LINE"
  if [[ -n "$host_note" ]]; then printf 'note:    %s\n' "$host_note"; fi
} > "${EXPORT_DIR}/LATEST-EXPORT.txt"

printf '\n==> export complete\n'
printf 'bundle:  %s\n' "$TARBALL"
printf 'size:    %s\n' "$SIZE"
printf 'sha256:  %s\n' "${SHA:-unavailable}"
if (( ${#NOTES[@]} > 0 )); then
  printf '\nnotes recorded in the manifest:\n'
  note_i=0
  while (( note_i < ${#NOTES[@]} )); do
    printf '  - %s\n' "${NOTES[$note_i]}"
    note_i=$((note_i + 1))
  done
fi

printf '\nPull it from your laptop (one line):\n'
printf '  %s\n' "$SCP_LINE"
printf '\nResumable alternative for a large bundle or a flaky link:\n'
printf '  %s\n' "$RSYNC_LINE"
if [[ -n "$host_note" ]]; then printf '\n%s\n' "$host_note"; fi
if command -v runpodctl >/dev/null 2>&1; then
  printf '\nrunpodctl is installed on this Pod, so this also works without ssh:\n'
  printf '  runpodctl send %s\n' "$TARBALL"
fi

printf '\nThe Pod is still billing. Stop it only after this file is on your laptop\n'
printf 'and its sha256 matches. Command line above is also in %s/LATEST-EXPORT.txt\n' "$EXPORT_DIR"
