#!/usr/bin/env bash
# Замер своего стека на T4 в ТЕЛЬ-АВИВЕ (GCP me-west1). Поднять, замерить, удалить.
#
# SPOT ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН. Проверено 27.08.2026: в проекте квота
# PREEMPTIBLE_CPUS = 0, поэтому spot-машина просто не создастся, сколько бы ни
# было квоты на саму карту. Обычная стоит $0.385/час — четверть часа замера это
# десять центов. Включить spot, когда/если выдадут квоту: SPOT=1 ./measure_gcp.sh
#
# Почему именно тут: это единственная найденная карта, которая стоит в Израиле
# и стоит копейки — $0.385/час on-demand, **$0.13/час spot**. То есть замер
# заодно проверяет боевую площадку, а не абстрактную.
#
# Региональной квоты T4 в me-west1 достаточно (выдана 27.08.2026); глобальную
# GPUs (all regions) ждать не обязательно.
#
# Машина УДАЛЯЕТСЯ в любом случае — по ошибке, по Ctrl-C, по выходу.
set -euo pipefail

export PATH=/opt/homebrew/share/google-cloud-sdk/bin:"$PATH"

PROJECT="${PROJECT:-}"
# T4 живёт в me-west1-b и me-west1-c (проверено `gcloud compute accelerator-types list`).
ZONE="${ZONE:-me-west1-b}"
NAME="${NAME:-samevoice-bench}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIO="${AUDIO:-$HERE/../voice-refs/alex_ref.wav}"
CREATED=""

log() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mОСТАНОВ: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  [ -z "$CREATED" ] && return
  log "удаляю машину $NAME (карта перестаёт тикать)"
  gcloud compute instances delete "$NAME" --zone "$ZONE" --quiet 2>/dev/null || \
    printf 'НЕ УДАЛИЛАСЬ — снеси руками: gcloud compute instances delete %s --zone %s\n' "$NAME" "$ZONE"
}
trap cleanup EXIT INT TERM

gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q . \
  || die "нет авторизации. Выполни: gcloud auth login"

[ -n "$PROJECT" ] || PROJECT="$(gcloud config get-value project 2>/dev/null)"
[ -n "$PROJECT" ] && [ "$PROJECT" != "(unset)" ] || die "не задан проект: gcloud config set project <ID>"
[ -f "$AUDIO" ] || die "нет файла $AUDIO"
log "проект $PROJECT, зона $ZONE"

# Образ Deep Learning VM: CUDA, драйвер и torch уже стоят. Ставить их на
# работающей карте — это ровно та ошибка, которая 26.08 стоила $7.
#
# Семейство проверено 27.08.2026 через `gcloud compute images list
# --project deeplearning-platform-release`: доступны только cu129 с драйвером
# 580, никаких cu124. Поэтому torch тут 2.9/cu129 — и трогать его НЕ НАДО,
# он уже согласован с драйвером. Наш прежний пин на 2.6/cu124 здесь только
# сломал бы то, что работает.
log "создаю машину с T4${SPOT:+ (spot)}"
gcloud compute instances create "$NAME" \
  --project="$PROJECT" --zone="$ZONE" \
  --machine-type=n1-standard-8 \
  --accelerator=type=nvidia-tesla-t4,count=1 \
  ${SPOT:+--provisioning-model=SPOT --instance-termination-action=DELETE} \
`# Машина с картой НЕ УМЕЕТ живую миграцию — GCP отвергает создание без этого` \
  --image-family="${IMAGE_FAMILY:-pytorch-2-9-cu129-ubuntu-2204-nvidia-580}" \
  --image-project=deeplearning-platform-release \
  --boot-disk-size=100GB --boot-disk-type=pd-balanced \
  --metadata="install-nvidia-driver=True" \
  --maintenance-policy=TERMINATE --restart-on-failure \
  --scopes=https://www.googleapis.com/auth/cloud-platform \
  || die "машина не создалась. Частые причины: не выдана квота T4 в этой зоне (попробуй ZONE=me-west1-a или -c), либо нет мест под spot — тогда убери --provisioning-model=SPOT"
CREATED=1

log "жду SSH (драйвер доустанавливается при первом старте, 2-4 минуты)"
for i in $(seq 1 40); do
  gcloud compute ssh "$NAME" --zone "$ZONE" --command "true" --quiet 2>/dev/null && break
  sleep 15
  [ "$i" = 40 ] && die "SSH не поднялся за 10 минут"
done

log "везу замерялку и запись"
gcloud compute scp "$HERE/kaggle_bench.py" "$AUDIO" "$NAME":~ --zone "$ZONE" --quiet

log "проверяю, что карта видна"
gcloud compute ssh "$NAME" --zone "$ZONE" --quiet --command \
  "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader" \
  || die "nvidia-smi не отвечает — драйвер не встал, смотри /var/log/syslog на машине"

log "ЗАМЕР (первый прогон качает веса, это несколько минут)"
gcloud compute ssh "$NAME" --zone "$ZONE" --quiet --command \
  "cd ~ && python3 kaggle_bench.py" 2>&1 | tee "$HERE/gcp-result-$(date +%Y%m%d-%H%M).txt"

log "готово — машина удаляется автоматически"
