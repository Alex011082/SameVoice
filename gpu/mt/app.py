"""SameVoice local MT benchmark service.

The first GPU baseline deliberately uses small pair-specific Marian models
instead of a large instruction model. The objective of Stage 1 is to measure
how much latency can be removed without sacrificing an acceptable translation
floor. Model weights are loaded lazily from Hugging Face into /workspace caches.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

Lang = Literal["ru", "he"]

MODEL_IDS: dict[tuple[str, str], str] = {
    ("ru", "he"): os.getenv("LOCAL_MT_MODEL_RU_HE", "Helsinki-NLP/opus-mt-ru-he"),
    ("he", "ru"): os.getenv("LOCAL_MT_MODEL_HE_RU", "Helsinki-NLP/opus-mt-he-ru"),
}


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    src_lang: Lang
    dst_lang: Lang


class TranslateResponse(BaseModel):
    text: str
    model: str
    latency_ms: float
    load_ms: float = 0.0


class WarmupResponse(BaseModel):
    loaded: list[str]
    load_ms: float


@dataclass
class _Bundle:
    tokenizer: object
    model: object
    device: str


class MarianEngine:
    """Lazy, process-local pair model cache.

    The service is bound to GPU 0 by CUDA_VISIBLE_DEVICES in the outer
    container. Inside this process the selected card therefore appears as
    cuda:0; no physical GPU index is hard-coded here.
    """

    def __init__(self) -> None:
        self._bundles: dict[tuple[str, str], _Bundle] = {}
        self._lock = threading.RLock()

    @property
    def loaded_models(self) -> list[str]:
        return [MODEL_IDS[key] for key in sorted(self._bundles)]

    def _load(self, src_lang: str, dst_lang: str) -> tuple[_Bundle, float]:
        key = (src_lang, dst_lang)
        if key not in MODEL_IDS:
            raise ValueError(f"unsupported local MT direction: {src_lang}->{dst_lang}")

        with self._lock:
            existing = self._bundles.get(key)
            if existing is not None:
                return existing, 0.0

            started = time.perf_counter()
            try:
                import torch
                from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
            except ImportError as exc:  # pragma: no cover - GPU image only
                raise RuntimeError(
                    "local MT dependencies are not installed; build the R&D image "
                    "with INSTALL_GPU_ENGINES=1"
                ) from exc

            model_id = MODEL_IDS[key]
            tokenizer = AutoTokenizer.from_pretrained(model_id)
            model = AutoModelForSeq2SeqLM.from_pretrained(model_id)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            if device == "cuda":
                model = model.to(device=device, dtype=torch.float16)
            else:
                model = model.to(device=device)
            model.eval()

            bundle = _Bundle(tokenizer=tokenizer, model=model, device=device)
            self._bundles[key] = bundle
            return bundle, (time.perf_counter() - started) * 1000.0

    def translate(self, text: str, src_lang: str, dst_lang: str) -> TranslateResponse:
        normalized = text.strip()
        if not normalized:
            raise ValueError("text must not be blank")
        if src_lang == dst_lang:
            return TranslateResponse(
                text=normalized,
                model="passthrough",
                latency_ms=0.0,
                load_ms=0.0,
            )

        bundle, load_ms = self._load(src_lang, dst_lang)
        started = time.perf_counter()

        import torch

        encoded = bundle.tokenizer(  # type: ignore[operator]
            normalized,
            return_tensors="pt",
            truncation=True,
            max_length=512,
        )
        encoded = {name: tensor.to(bundle.device) for name, tensor in encoded.items()}

        with torch.inference_mode():
            generated = bundle.model.generate(  # type: ignore[attr-defined]
                **encoded,
                do_sample=False,
                num_beams=1,
                max_new_tokens=256,
            )
        translated = bundle.tokenizer.batch_decode(  # type: ignore[attr-defined]
            generated,
            skip_special_tokens=True,
        )[0].strip()
        latency_ms = (time.perf_counter() - started) * 1000.0
        if not translated:
            raise RuntimeError("local MT returned an empty translation")

        return TranslateResponse(
            text=translated,
            model=MODEL_IDS[(src_lang, dst_lang)],
            latency_ms=latency_ms,
            load_ms=load_ms,
        )

    def warmup(self) -> WarmupResponse:
        started = time.perf_counter()
        for src_lang, dst_lang in MODEL_IDS:
            self._load(src_lang, dst_lang)
        return WarmupResponse(
            loaded=self.loaded_models,
            load_ms=(time.perf_counter() - started) * 1000.0,
        )


engine = MarianEngine()
app = FastAPI(title="SameVoice Local MT", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "service": "local-mt",
        "loaded_models": engine.loaded_models,
        "directions": [f"{src}->{dst}" for src, dst in MODEL_IDS],
    }


@app.post("/v1/translate", response_model=TranslateResponse)
def translate(req: TranslateRequest) -> TranslateResponse:
    try:
        return engine.translate(req.text, req.src_lang, req.dst_lang)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/warmup", response_model=WarmupResponse)
def warmup() -> WarmupResponse:
    try:
        return engine.warmup()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
