"""Кладёт веса всех моделей движка в HF-кэш образа.

Список моделей — из gpu/acoustic/engines.py и gpu/mt/app.py (те же имена
по умолчанию). Если там поменяли модель, а здесь нет, под с образом тихо
скачает новую при прогреве — образ не сломается, но и выигрыша не даст.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

MODELS = [
    os.getenv("ACOUSTIC_RU_MODEL", "nvidia/nemotron-3.5-asr-streaming-0.6b"),
    os.getenv("ACOUSTIC_HE_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2"),
    os.getenv("LOCAL_MT_MODEL_RU_HE", "Helsinki-NLP/opus-mt-ru-he"),
    os.getenv("LOCAL_MT_MODEL_HE_RU", "Helsinki-NLP/opus-mt-he-ru"),
]


def size_of(path: Path) -> float:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) / 1e9


def main() -> int:
    total = 0.0
    for model in MODELS:
        # Всё, кроме заведомо чужих форматов: .nemo/.gguf/.onnx движку не нужны,
        # а весят как сама модель.
        path = Path(
            snapshot_download(model, ignore_patterns=["*.nemo", "*.onnx", "*.ckpt", "*.msgpack", "*.h5", "*.gguf", "*.png"])
        )
        gb = size_of(path)
        total += gb
        print(f"{model}: {gb:.2f} ГБ -> {path}", flush=True)
    print(f"итого моделей: {total:.2f} ГБ", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
