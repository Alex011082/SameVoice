#!/usr/bin/env bash
# Один запуск: поднять под, замерить, погасить под. Ничего вручную.
#
# ЗАЧЕМ ИМЕННО ТАК. 26.08.2026 замер стоил $7 и не дал числа: время ушло на
# `pip install` при включённой карте и на три раунда войны версий. Здесь всё,
# что можно сделать бесплатно, сделано заранее — образ собран на раннерах
# GitHub, зависимости прибиты, аудио лежит рядом. Карта включается только на то
# время, пока реально считает, и гасится в любом случае, даже при ошибке.
#
# Требуется:
#   1. Образ ghcr.io/alex011082/whisperlivekit-ruhe:latest должен быть ПУБЛИЧНЫМ.
#   2. Баланс RunPod > $1.
#   3. ~/.ssh/id_ed25519_runpod.pub — ключ прокидывается в под.
set -euo pipefail

# A40 — та же Ampere, что у A10G в AWS g5.xlarge (единственное GPU-семейство,
# реально доступное в il-central-1, Тель-Авив). Не тот же чип, но ближайший
# доступный родственник. Дешевле и почти так же близко: RTX 3090 (тот же GA102).
GPU_ID="${GPU_ID:-NVIDIA A40}"
IMAGE="ghcr.io/alex011082/whisperlivekit-ruhe:latest"
NAME="samevoice-bench-$(date +%H%M)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIO="${AUDIO:-$HERE/../voice-refs/alex_ref.wav}"
POD_ID=""

log() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mОСТАНОВ: %s\033[0m\n' "$*" >&2; exit 1; }

# Гасим под ВСЕГДА: при ошибке, при Ctrl-C, при выходе. Счётчик идёт поминутно,
# и забытый включённым под — это ровно та ошибка, которая уже стоила денег.
cleanup() {
  [ -z "$POD_ID" ] && return
  log "гашу под $POD_ID"
  gql "mutation { podStop(input:{podId:\"$POD_ID\"}) { id desiredStatus } }" >/dev/null || true
  printf 'под остановлен. Удалить совсем (диск тоже): runpodctl remove pod %s\n' "$POD_ID"
}
trap cleanup EXIT INT TERM

KEY="$(python3 - <<'PY'
import zipfile, re, sys
try:
    z = zipfile.ZipFile('/Users/davidov/Projects/SameVoice/Deepgramm.docx')
    t = re.sub(r'<[^>]+>', '\n', z.read('word/document.xml').decode('utf8', 'ignore'))
    for line in t.split('\n'):
        line = line.strip()
        if line.startswith('rpa_'):
            print(line); sys.exit(0)
except Exception as e:
    print('', end='')
sys.exit(1)
PY
)" || die "не нашёл ключ RunPod в Deepgramm.docx"

gql() {
  curl -sS -X POST https://api.runpod.io/graphql \
    -H "Content-Type: application/json" -H "Authorization: Bearer $KEY" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$1")"
}

log "баланс"
BAL="$(gql 'query { myself { clientBalance } }' | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["myself"]["clientBalance"])')"
printf 'на счету: $%s\n' "$BAL"
python3 -c "import sys; sys.exit(0 if float('$BAL') > 1 else 1)" \
  || die "меньше \$1 на счету — пополни, иначе под не поднимется"

[ -f "$AUDIO" ] || die "нет файла $AUDIO"
PUBKEY="$(cat ~/.ssh/id_ed25519_runpod.pub 2>/dev/null)" || die "нет ~/.ssh/id_ed25519_runpod.pub"

# sshd поднимается ВМЕСТЕ с сервером: замер должен идти ВНУТРИ пода, иначе в
# цифру попадёт интернет между Тель-Авивом и Румынией, а мы меряем модель.
# PUBLIC_KEY обязателен — без него sshd не пустит, это уже проверено.
START='mkdir -p /run/sshd && /usr/sbin/sshd && whisperlivekit-server --host 0.0.0.0 --port 8000 --model large-v3-turbo --backend faster-whisper --lan ru --target-language he --backend-policy simulstreaming --translation-backend nllb --pcm-input'

log "создаю под ($GPU_ID)"
CREATE="mutation { podFindAndDeployOnDemand(input:{
  cloudType: ALL, gpuCount: 1, volumeInGb: 0, containerDiskInGb: 40,
  minMemoryInGb: 16, minVcpuCount: 4,
  gpuTypeId: \"$GPU_ID\", name: \"$NAME\", imageName: \"$IMAGE\",
  ports: \"8000/http,22/tcp\",
  dockerArgs: \"bash -c '$START'\",
  env: [{key:\"PUBLIC_KEY\", value:\"$PUBKEY\"}]
}) { id machineId } }"
POD_ID="$(gql "$CREATE" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if d.get("errors"): print("ОШИБКА:", d["errors"][0]["message"], file=sys.stderr); sys.exit(1)
print(d["data"]["podFindAndDeployOnDemand"]["id"])
')" || die "под не создался (чаще всего: нет свободных карт этого типа — попробуй GPU_ID='NVIDIA GeForce RTX 4090')"
log "под $POD_ID создан, карта тикает"

log "жду SSH (образ тянется, веса качаются — 3-6 минут)"
SSH_HOST=""; SSH_PORT=""
for i in $(seq 1 60); do
  R="$(gql "query { pod(input:{podId:\"$POD_ID\"}) { runtime { ports { ip publicPort privatePort isIpPublic } } } }")"
  read -r SSH_HOST SSH_PORT <<<"$(printf '%s' "$R" | python3 -c '
import sys, json
try: ports = json.load(sys.stdin)["data"]["pod"]["runtime"]["ports"] or []
except Exception: ports = []
for p in ports:
    if p["privatePort"] == 22 and p["isIpPublic"]:
        print(p["ip"], p["publicPort"]); break
')"
  [ -n "${SSH_HOST:-}" ] && break
  sleep 10
done
[ -n "${SSH_HOST:-}" ] || die "SSH так и не поднялся за 10 минут"

SSHOPT="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i $HOME/.ssh/id_ed25519_runpod -p $SSH_PORT"
log "везу замерялку и запись на под"
scp $SSHOPT "$HERE/bench.py" "$AUDIO" "root@$SSH_HOST:/app/" >/dev/null

log "жду, пока модель прогреется"
# shellcheck disable=SC2086
ssh $SSHOPT "root@$SSH_HOST" 'for i in $(seq 1 60); do curl -sf localhost:8000 >/dev/null && exit 0; sleep 5; done; exit 1' \
  || die "whisperlivekit-server не ответил — смотри логи пода в консоли RunPod"

log "ЗАМЕР"
# shellcheck disable=SC2086
ssh $SSHOPT "root@$SSH_HOST" "cd /app && python3 bench.py --audio $(basename "$AUDIO") --host 127.0.0.1:8000 --src ru --dst he" \
  | tee "$HERE/result-$(date +%Y%m%d-%H%M).json"

log "готово — под гасится автоматически"
