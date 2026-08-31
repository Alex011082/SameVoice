#!/bin/bash
# Bootstrap ОБУЧАЮЩЕГО пода (схема без SSH — см. runpod-bootstrap.sh).
# Отличие от бенч-пода: сначала LoRA-дообучение угадывателя на данных
# фабрики v1, затем честный A/B в том же поде — recall база vs адаптер
# на одних и тех же строках, том же железе, тех же настройках.
# Перед выкладкой на сервер подставить RD_TOKEN.
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

step "старт train-bootstrap"
cd /workspace/out
nohup python3 -m http.server 8000 --bind 0.0.0.0 >/dev/null 2>&1 &

step "проверяю GPU"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || fail "нет nvidia-smi"
PY=python3
cuda_ok=""
for t in 1 2 3 4 5; do
  $PY -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" \
    && { $PY -c "import torch; print('CUDA ок:', torch.cuda.get_device_name(0))"; cuda_ok=1; break; }
  echo "попытка $t: CUDA не инициализируется, жду 15 с"; sleep 15
done
[ -n "$cuda_ok" ] || fail "torch не видит GPU (вероятно битый хост — пересоздать под)"

step "зависимости (torch из образа не трогаю)"
$PY -m pip install -q --no-input \
  "fastapi>=0.116,<1" "uvicorn[standard]>=0.35,<1" "transformers>=4.56,<6" \
  "peft>=0.17,<1" "accelerate>=1.10,<2" "safetensors>=0.5,<1" \
  "sentencepiece>=0.2,<1" "numpy>=2,<3" || fail "pip install упал"

step "код и данные"
mkdir -p /workspace/code && cd /workspace/code
( curl -fsSL "$PAYLOAD_URL" -o /tmp/payload.tgz || wget -qO /tmp/payload.tgz "$PAYLOAD_URL" ) || fail "код не скачался"
tar xzf /tmp/payload.tgz || fail "tar упал"
mkdir -p /workspace/data
for f in train-v1.jsonl val-v1.jsonl; do
  curl -fsSL "$BASE_URL/$f" -o /workspace/data/$f || fail "нет $f"
  head -c 200 /workspace/data/$f | grep -q '"system"' || fail "$f не похож на данные (Caddy отдал index?)"
done
wc -l /workspace/data/*.jsonl

export HF_HOME=/workspace/hf
export PYTHONPATH=/workspace/code

# Батч 8, не 16: на данных v2 (память + длинные диалоги) батч 16 дал CUDA OOM
# на 4090 — логиты 151-тысячного словаря на длинных примерах не влезают
# (под xvnhclbwj2tpcl, 01.09, чинилось живым патчем). expandable_segments —
# против фрагментации. Имена файлов данных подставляет sed при выкладке.
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
step "ОБУЧЕНИЕ: LoRA на Qwen3-0.6B, 3 эпохи, батч 8"
$PY scripts/predictor-finetune.py \
  --train /workspace/data/train-v1.jsonl --val /workspace/data/val-v1.jsonl \
  --out /workspace/ft --model Qwen/Qwen3-0.6B --epochs 3 --batch 8 \
  || fail "обучение упало"
[ -f /workspace/ft/adapter/adapter_model.safetensors ] || fail "адаптер не сохранился"
( cd /workspace/ft && tar czf /workspace/out/adapter.tgz adapter train-log.jsonl )

run_recall(){ # $1 метка, $2 доп. env-строка (PREDICTOR_ADAPTER=... или пусто)
  step "предиктор ($1)"
  pkill -f "uvicorn gpu.predictor" 2>/dev/null; sleep 3
  env $2 PREDICTOR_MODEL=Qwen/Qwen3-0.6B PREDICTOR_PROMPT_STYLE=chat \
    nohup $PY -m uvicorn gpu.predictor.app:app --host 127.0.0.1 --port 8101 \
    > /workspace/out/predictor-$1.log 2>&1 &
  ok=""
  for i in $(seq 1 90); do
    curl -fsS --max-time 2 http://127.0.0.1:8101/healthz >/dev/null 2>&1 && { ok=1; break; }
    sleep 2
  done
  [ -n "$ok" ] || { tail -30 /workspace/out/predictor-$1.log; fail "предиктор ($1) не поднялся"; }
  curl -fsS --max-time 900 -X POST http://127.0.0.1:8101/v1/warmup >/dev/null || fail "warmup ($1)"
  for ls in ru-m1 ru-m1-mem; do
    step "recall $1 / $ls"
    $PY scripts/predictor-recall-bench.py --lines eval/corpus/linesets/$ls.json \
      --use-context --output /workspace/out/results/recall-$1-$ls.json \
      || fail "recall-бенч $1/$ls упал"
  done
}

# Порядок: сначала база, потом адаптер — если что-то умрёт на второй руке,
# базовая рука уже лежит в results и сравнение с историей возможно.
run_recall base ""
run_recall tuned "PREDICTOR_ADAPTER=/workspace/ft/adapter"

step "ГОТОВО"
ls -la /workspace/out/results/ /workspace/out/adapter.tgz
echo done > /workspace/out/DONE
patch_loop
