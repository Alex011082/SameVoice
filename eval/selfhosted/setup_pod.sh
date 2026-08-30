#!/usr/bin/env bash
# Установка стека WhisperLiveKit + VoxCPM2 на свежий RunPod-под.
#
# Запускать НА ПОДЕ. Идемпотентен — можно перезапускать.
#
# Почему всё в одном скрипте и с прогревом в конце: под тарифицируется
# поминутно, и разбираться в зависимостях на работающем счётчике — это платить
# за чтение документации. Скрипт доводит машину до состояния «модели в
# видеопамяти, можно мерить».
set -euo pipefail

log() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

log "GPU и окружение"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
python3 --version

log "системные пакеты"
apt-get update -qq
apt-get install -y -qq ffmpeg git curl >/dev/null

# ВЕРСИИ ПРИБИТЫ НАМЕРЕННО. За одну ночь 26.08.2026 это ломалось трижды:
#   1. `whisperlivekit` поднял torch до сборки под CUDA 13 при драйвере 12.4 —
#      torch молча свалился на CPU, и замер показал 7.9 с вместо 0.06 с;
#   2. `nllw` откатил torch до 2.4.1, а transformers>=5 требует >=2.5 —
#      сервер падал с "AutoModelForSeq2SeqLM requires the PyTorch library";
#   3. torchvision от старого torch ломал импорт transformers.
# Поэтому: сначала torch под cu124, потом всё остальное, потом torch ещё раз
# (пакеты выше по цепочке любят его переустановить), и только затем проверка.
log "PyTorch под CUDA 12.4 — ДО остальных пакетов"
pip install -q --upgrade pip
pip install -q torch==2.6.0 torchvision==0.21.0 torchaudio==2.6.0 \
  --index-url https://download.pytorch.org/whl/cu124

log "WhisperLiveKit (инкрементальные распознавание + перевод)"
# [nllb] — потоковый перевод; `nllw` он требует отдельно. Иврит есть в обоих
# списках языков, проверено в docs/supported_languages.md репозитория.
pip install -q "transformers>=4.45,<5" "whisperlivekit[nllb]" nllw

log "возвращаем torch — установка выше его переустанавливает"
pip install -q torch==2.6.0 --index-url https://download.pytorch.org/whl/cu124
python3 - <<'CHECK'
import sys, torch
from transformers.utils import is_torch_available
ok = torch.cuda.is_available() and is_torch_available()
print(f"torch {torch.__version__} | CUDA {torch.cuda.is_available()} | transformers видит torch: {is_torch_available()}")
if not ok:
    print("ОСТАНОВ: без CUDA замер бессмысленен — модель уйдёт считать на CPU.")
    sys.exit(1)
CHECK

log "VoxCPM2 (синтез с клонированием, иврит CER 2.98%)"
pip install -q voxcpm || {
  git clone -q https://github.com/OpenBMB/VoxCPM2.git /workspace/VoxCPM2 || true
  pip install -q -e /workspace/VoxCPM2
}

log "веса: ivrit.ai Whisper (иврит вдвое точнее стокового) + NLLB + VoxCPM2"
python3 - <<'PY'
import os
os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
from huggingface_hub import snapshot_download

# Дообученный на израильской речи: FLEURS WER 0.174 против 0.262 у стокового.
# Русскую сторону оставляем стоковому Whisper — там он и так хорош.
for repo in [
    "ivrit-ai/whisper-large-v3-turbo-ct2",
    "facebook/nllb-200-distilled-600M",
]:
    print("качаю", repo, flush=True)
    try:
        snapshot_download(repo)
    except Exception as e:
        print("  НЕ СКАЧАЛОСЬ:", repr(e)[:160])
PY

log "прогрев VoxCPM2 — модель в видеопамять"
python3 - <<'PY'
import time
try:
    from voxcpm import VoxCPM
except Exception as e:
    print("VoxCPM не импортируется:", repr(e)[:200]); raise SystemExit(1)
t = time.perf_counter()
# load_denoiser=False намеренно: шумодав тянет modelscope, который ломается
# о версию transformers в этом образе, а на синтез никак не влияет.
m = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
print(f"модель загружена за {time.perf_counter()-t:.1f} с")
PY

log "готово — можно запускать eval/selfhosted/bench.py"
