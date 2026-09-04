"""Боевой движок одним приложением на ОДНОМ порту.

Зачем: под RunPod, созданный с тремя http-портами, не запускает контейнер
вовсе — 4 попытки подряд молчали, а тот же bootstrap с одним портом ожил с
первой (01.09.2026, опыт с подом vfa1ryl4zqdwvi). Поэтому STT и перевод
больше не висят на 8102/8103, а монтируются в одно приложение на 8000:

    /stt/...   — акустический STT-стрим, вебсокет /stt/v1/stream
    /mt/...    — локальный Marian, /mt/v1/translate
    /...       — файлы /workspace/out: log.txt, DONE, FAILED, results/

Порядок монтирования важен: статика встаёт последней, иначе она перехватит
пути сервисов.

Запуск: uvicorn gpu.engine_app:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .acoustic.app import app as stt_app
from .mt.app import app as mt_app

OUT_DIR = Path(os.getenv("ENGINE_OUT_DIR", "/workspace/out"))

app = FastAPI(title="SameVoice Engine", version="0.1.0")


@app.get("/engine/healthz")
def healthz() -> dict[str, object]:
    """Один ответ на вопрос «движок жив и что в нём» — чтобы серверу не
    приходилось опрашивать два сервиса по разным адресам."""
    return {
        "ok": True,
        "service": "engine",
        "mounts": {"stt": "/stt", "mt": "/mt"},
        "out_dir": str(OUT_DIR),
    }


app.mount("/stt", stt_app)
app.mount("/mt", mt_app)

# Статика последней: иначе "/" перехватит /stt и /mt.
OUT_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/", StaticFiles(directory=str(OUT_DIR), html=False), name="out")
