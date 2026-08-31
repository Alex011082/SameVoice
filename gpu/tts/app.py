"""SameVoice local TTS quality/latency A/B service.

This first open-source path uses Chatterbox Multilingual V3 because it covers
both Hebrew and Russian. It is deliberately labelled BATCH: the official Python
`generate()` API returns a completed waveform, so this service must not be
mistaken for the eventual speculative/streaming TTS path. Cartesia remains the
streaming control until a local engine proves lower TTFA at acceptable quality.
"""

from __future__ import annotations

import os
import re
import threading
import time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

Lang = Literal["ru", "he"]
MODEL_ID = "ResembleAI/chatterbox"
VOICE_ROOT = Path(os.getenv("LOCAL_TTS_VOICE_ROOT", "/workspace/voices"))
_VOICE_ID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    lang: Lang
    voice_id: str | None = None


class ChatterboxEngine:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._model = None
        self._device = "unloaded"

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def device(self) -> str:
        return self._device

    @property
    def sample_rate(self) -> int | None:
        return int(self._model.sr) if self._model is not None else None

    def _load(self) -> float:
        if self.loaded:
            return 0.0
        with self._lock:
            if self.loaded:
                return 0.0
            started = time.perf_counter()
            try:
                import torch
                from chatterbox.mtl_tts import ChatterboxMultilingualTTS
            except ImportError as exc:  # pragma: no cover - GPU image only
                raise RuntimeError(
                    "local TTS dependencies are not installed; build with INSTALL_TTS_ENGINE=1"
                ) from exc

            device = "cuda" if torch.cuda.is_available() else "cpu"
            # Без t3_model="v3": установленный chatterbox-tts 0.1.x такого
            # аргумента не знает (TypeError на поде b0jxilt07hcur3, 31.08) —
            # мультиязычная модель в пакете одна, выбирать нечего.
            model = ChatterboxMultilingualTTS.from_pretrained(device=device)
            self._model = model
            self._device = device
            return (time.perf_counter() - started) * 1000.0

    def warmup(self) -> dict[str, object]:
        load_ms = self._load()
        return {
            "ok": True,
            "model": MODEL_ID,
            "device": self.device,
            "sample_rate": self.sample_rate,
            "load_ms": load_ms,
            "streaming": False,
            "watermarked": True,
        }

    def synthesize(self, req: SynthesizeRequest) -> tuple[bytes, int, float, float, str]:
        text = req.text.strip()
        if not text:
            raise ValueError("text must not be blank")
        load_ms = self._load()
        model = self._model
        assert model is not None

        voice_path: Path | None = None
        if req.voice_id:
            if not _VOICE_ID.fullmatch(req.voice_id):
                raise ValueError("voice_id contains unsupported characters")
            candidate = VOICE_ROOT / req.lang / f"{req.voice_id}.wav"
            if not candidate.is_file():
                raise ValueError(f"voice_id {req.voice_id!r} is not installed for {req.lang}")
            voice_path = candidate

        started = time.perf_counter()
        kwargs: dict[str, object] = {"language_id": req.lang}
        if voice_path is not None:
            kwargs["audio_prompt_path"] = str(voice_path)
        with self._lock:
            wav = model.generate(text, **kwargs)
        latency_ms = (time.perf_counter() - started) * 1000.0

        try:
            import numpy as np
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("numpy is missing from local TTS runtime") from exc

        array = wav.detach().float().cpu().numpy()
        array = np.asarray(array).reshape(-1)
        pcm = (np.clip(array, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        if not pcm:
            raise RuntimeError("local TTS returned empty audio")
        voice = req.voice_id or "builtin"
        return pcm, int(model.sr), latency_ms, load_ms, voice


engine = ChatterboxEngine()
app = FastAPI(title="SameVoice Local TTS A/B", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "service": "local-tts-ab",
        "model": MODEL_ID,
        "loaded": engine.loaded,
        "device": engine.device,
        "sample_rate": engine.sample_rate,
        "streaming": False,
        "watermarked": True,
    }


@app.post("/v1/warmup")
def warmup() -> dict[str, object]:
    try:
        return engine.warmup()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/synthesize")
def synthesize(req: SynthesizeRequest) -> Response:
    try:
        pcm, sample_rate, latency_ms, load_ms, voice = engine.synthesize(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return Response(
        content=pcm,
        media_type="application/octet-stream",
        headers={
            "X-SameVoice-PCM": "s16le",
            "X-SameVoice-Sample-Rate": str(sample_rate),
            "X-SameVoice-Channels": "1",
            "X-SameVoice-Model": MODEL_ID,
            "X-SameVoice-Voice": voice,
            "X-SameVoice-Latency-Ms": f"{latency_ms:.3f}",
            "X-SameVoice-Load-Ms": f"{load_ms:.3f}",
            "X-SameVoice-Streaming": "false",
            "X-SameVoice-Watermarked": "true",
        },
    )
