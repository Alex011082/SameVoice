#!/bin/bash
# Bootstrap БОЕВОГО движка: STT-стрим (Nemotron) + Marian на ОДНОМ порту 8000.
# Агент на samevoice-сервере ходит сюда по proxy-URL пода: /stt и /mt.
#
# Почему один порт, а не три: под, созданный с ports "8000/http,8102/http,
# 8103/http", НЕ ЗАПУСКАЕТ контейнер вовсе — 4 попытки молчали по 25-30 минут
# (01.09.2026). Тот же bootstrap с одним портом ожил с первой проверки
# (под vfa1ryl4zqdwvi). Сервисы сведены в gpu/engine_app.py.
# Перед выкладкой подставить RD_TOKEN; CARTESIA_API_KEY приходит через POD_ENV.
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

step "старт pipeline-bootstrap"
cd /workspace/out
nohup python3 -m http.server 8000 --bind 0.0.0.0 >/dev/null 2>&1 &

step "проверяю GPU"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || fail "нет nvidia-smi"
PY=python3
cuda_ok=""
for t in 1 2 3 4 5; do
  $PY -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" \
    && { cuda_ok=1; break; }
  echo "попытка $t: CUDA не инициализируется, жду 15 с"; sleep 15
done
[ -n "$cuda_ok" ] || fail "torch не видит GPU (битый хост — пересоздать)"

step "зависимости"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -q ffmpeg >/dev/null 2>&1 || apt-get update -q >/dev/null && apt-get install -y -q ffmpeg >/dev/null || fail "нет ffmpeg"
$PY -m pip install -q --no-input \
  "fastapi>=0.116,<1" "uvicorn[standard]>=0.35,<1" "transformers>=4.56,<6" \
  "sentencepiece>=0.2,<1" "safetensors>=0.5,<1" "accelerate>=1.10,<2" \
  "numpy>=2,<3" sacremoses websockets silero-vad librosa || fail "pip упал"

step "код и тестовое аудио"
mkdir -p /workspace/code /workspace/data/pipeline-test && cd /workspace/code
( curl -fsSL "$PAYLOAD_URL" -o /tmp/payload.tgz || wget -qO /tmp/payload.tgz "$PAYLOAD_URL" ) || fail "код не скачался"
tar xzf /tmp/payload.tgz || fail "tar упал"

export HF_HOME=/workspace/hf
export PYTHONPATH=/workspace/code

step "движок: STT и перевод одним приложением на 8000"
# лог-раздачу гасим: файлы из /workspace/out теперь отдаёт само приложение
pkill -f "http.server 8000"; sleep 1
nohup $PY -m uvicorn gpu.engine_app:app --host 0.0.0.0 --port 8000 > /workspace/out/engine.log 2>&1 &
ok=""
for i in $(seq 1 90); do
  curl -fsS --max-time 2 "http://127.0.0.1:8000/engine/healthz" >/dev/null 2>&1 && { ok=1; break; }
  sleep 2
done
[ -n "$ok" ] || { tail -30 /workspace/out/engine.log; fail "движок на 8000 не поднялся"; }
step "warmup STT (модель качается — минуты)"
curl -fsS --max-time 1200 -X POST http://127.0.0.1:8000/stt/v1/warmup \
  -H 'Content-Type: application/json' -d '{"lang":"ru"}' || fail "warmup STT"
curl -fsS --max-time 600 -X POST http://127.0.0.1:8000/mt/v1/warmup || echo "warmup MT не критичен"

step "ГОТОВО"
echo done > /workspace/out/DONE
patch_loop
