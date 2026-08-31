#!/bin/bash
# Bootstrap пода RunPod БЕЗ SSH. Шаблон: перед выкладкой на сервер подставить
# RD_TOKEN (scripts/runpod-nossh-launch.sh делает это сам).
#
# Схема, родившаяся из 18 провалов SSH-захода 31.08.2026:
#  - под создаётся с dockerArgs, которые скачивают ЭТОТ скрипт и исполняют;
#  - весь ход пишется в /workspace/out/log.txt и виден снаружи через
#    HTTP-прокси пода (порт 8000, https://<pod>-8000.proxy.runpod.net/log.txt);
#  - результаты — JSON в /workspace/out/results/, маркеры DONE / FAILED;
#  - при падении под НЕ умирает: раз в 20 с тянет patch.sh с нашего сервера
#    и исполняет новое содержимое — живая отладка без пересоздания пода.
#
# Образ: runpod/pytorch (torch собран и проверен площадкой). Голый runpod/base
# + pip-torch дал "CUDA unknown error" (под 38e2j684pmplz0, 31.08) — доустановка
# torch поверх сырого хоста ненадёжна.
mkdir -p /workspace/out/results
exec >> /workspace/out/log.txt 2>&1
step(){ echo; echo "=== $(date -u +%H:%M:%S) $*"; }

BASE_URL="https://samevoice.0110.digital/RD_TOKEN"
PATCH_URL="$BASE_URL/patch.sh"
PAYLOAD_URL="$BASE_URL/payload.tgz"
patch_loop(){
  local seen=""
  while true; do
    sleep 20
    local p h
    p=$(curl -fsSL --max-time 10 "$PATCH_URL" 2>/dev/null) || continue
    [ -z "$p" ] && continue
    # Caddy на отсутствующий файл отвечает 200 с index.html (try_files) —
    # исполнять HTML нельзя. Патч обязан начинаться с маркера.
    echo "$p" | head -1 | grep -q '^#!/bin/bash' || continue
    echo "$p" | sed -n 2p | grep -q '^# SVPATCH' || continue
    h=$(echo "$p" | md5sum | cut -d' ' -f1)
    [ "$h" = "$seen" ] && continue
    seen="$h"
    echo; echo "=== $(date -u +%H:%M:%S) исполняю патч $h"
    echo "$p" | bash
  done
}
fail(){ echo "FATAL: $*"; echo "$*" > /workspace/out/FAILED; patch_loop; }

step "старт bootstrap, окружение:"
cat /etc/os-release | head -2
command -v python3 pip curl wget || true

step "поднимаю http-отдачу лога (порт 8000)"
cd /workspace/out
nohup python3 -m http.server 8000 --bind 0.0.0.0 >/dev/null 2>&1 &

step "проверяю GPU"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || fail "нет nvidia-smi"
echo "-- диагностика CUDA:"; ls -la /dev/nvidia* 2>&1; env | grep -i -E 'nvidia|cuda' | sort

PY=python3
$PY -c "import torch; print('torch', torch.__version__, '| cuda build', torch.version.cuda)" || fail "в образе нет torch"
cuda_ok=""
for t in 1 2 3 4 5; do
  $PY -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" \
    && { $PY -c "import torch; print('CUDA ок:', torch.cuda.get_device_name(0))"; cuda_ok=1; break; }
  echo "попытка $t: CUDA не инициализируется, жду 15 с"; sleep 15
done
[ -n "$cuda_ok" ] || fail "torch не видит GPU (вероятно битый хост — пересоздать под)"

step "доустанавливаю лёгкие зависимости (torch НЕ трогаю)"
export DEBIAN_FRONTEND=noninteractive
$PY -m pip install -q --no-input \
  "fastapi>=0.116,<1" "uvicorn[standard]>=0.35,<1" "transformers>=5.13,<6" \
  "sentencepiece>=0.2,<1" "safetensors>=0.5,<1" "accelerate>=1.10,<2" \
  "numpy>=2,<3" sacremoses || fail "pip install упал"

step "раскладываю код"
mkdir -p /workspace/code && cd /workspace/code
( curl -fsSL "$PAYLOAD_URL" -o /tmp/payload.tgz || wget -qO /tmp/payload.tgz "$PAYLOAD_URL" ) || fail "код не скачался"
tar xzf /tmp/payload.tgz 2>/dev/null || fail "tar упал"

step "запускаю сервисы"
export HF_HOME=/workspace/hf
export PYTHONPATH=/workspace/code
nohup $PY -m uvicorn gpu.predictor.app:app  --host 127.0.0.1 --port 8101 > /workspace/out/predictor.log 2>&1 &
nohup $PY -m uvicorn gpu.acoustic.prune_app:app --host 127.0.0.1 --port 8105 > /workspace/out/pruner.log 2>&1 &
nohup $PY -m uvicorn gpu.mt.app:app         --host 127.0.0.1 --port 8103 > /workspace/out/mt.log 2>&1 &
for port in 8101 8105; do
  ok=""
  for i in $(seq 1 60); do
    curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && { ok=1; break; }
    sleep 2
  done
  [ -n "$ok" ] || { tail -40 /workspace/out/predictor.log /workspace/out/pruner.log; fail "сервис на $port не поднялся"; }
  echo "порт $port жив"
done

step "БЕНЧ: scorer-cost RU (модели скачаются при warmup — это минуты)"
cd /workspace/code
$PY scripts/scorer-cost-bench.py --lang ru --warmup-timeout 900 \
  --output /workspace/out/results/scorer-cost-ru.json 2>&1 || fail "бенч RU упал"

step "БЕНЧ: scorer-cost HE"
$PY scripts/scorer-cost-bench.py --lang he --warmup-timeout 900 \
  --output /workspace/out/results/scorer-cost-he.json 2>&1 || echo "бенч HE упал — не фатально, RU уже есть"

step "БЕНЧ: stage1 predictor+MT (не фатально)"
BENCHMARK_DIR=/workspace/out/results $PY scripts/runpod-stage1-bench.py 2>&1 || echo "stage1 не прошёл — не фатально"

step "ГОТОВО"
nvidia-smi --query-gpu=memory.used --format=csv,noheader
echo done > /workspace/out/DONE
patch_loop
