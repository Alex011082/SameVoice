"""SameVoice rolling next-SOURCE-word predictor benchmark service.

This service intentionally predicts only the next source word. It does not
branch whole future sentences. Incoming acoustic evidence will later prune the
returned Top-K list in the acoustic service before any irreversible commit.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from ..queueing import GpuQueue, concurrency_from_env
from .text import RawCandidate, collapse_candidates

Lang = Literal["ru", "he"]
MODEL_ID = os.getenv("PREDICTOR_MODEL", "Qwen/Qwen3-0.6B-Base")
GPU_CONCURRENCY = concurrency_from_env("PREDICTOR_GPU_CONCURRENCY")


class PredictRequest(BaseModel):
    prefix: str = Field(min_length=1, max_length=12000)
    lang: Lang
    top_k: int = Field(default=20, ge=1, le=50)
    context_terms: list[str] = Field(default_factory=list, max_length=256)
    max_new_tokens: int = Field(default=6, ge=2, le=12)


class Candidate(BaseModel):
    word: str
    probability: float
    log_score: float


class PredictResponse(BaseModel):
    candidates: list[Candidate]
    model: str
    # Stamped inside PredictorEngine.predict around beam search + decode +
    # candidate collapsing; it excludes tokenisation and the lazy `_load()`.
    # Kept unchanged because scripts/runpod-stage1-bench.py:66 reads this field,
    # but it cannot answer "model or queue?" on its own, which is what the three
    # fields below exist for.
    latency_ms: float
    load_ms: float = 0.0
    beam_count: int
    queue_wait_ms: float = 0.0
    # The whole blocking call held under the semaphore. On the first request
    # after boot that includes the lazy weight load, which is why `load_ms` is
    # published next to it rather than folded in.
    inference_ms: float = 0.0
    total_ms: float = 0.0


class PredictorEngine:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._tokenizer = None
        self._model = None
        self._device = "unloaded"

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def device(self) -> str:
        return self._device

    def _load(self) -> float:
        if self.loaded:
            return 0.0
        with self._lock:
            if self.loaded:
                return 0.0
            started = time.perf_counter()
            try:
                import torch
                from transformers import AutoModelForCausalLM, AutoTokenizer
            except ImportError as exc:  # pragma: no cover - GPU image only
                raise RuntimeError(
                    "predictor dependencies are not installed; build the R&D image "
                    "with INSTALL_GPU_ENGINES=1"
                ) from exc

            tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
            model = AutoModelForCausalLM.from_pretrained(MODEL_ID)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            if device == "cuda":
                model = model.to(device=device, dtype=torch.float16)
            else:
                model = model.to(device=device)
            model.eval()
            self._tokenizer = tokenizer
            self._model = model
            self._device = device
            return (time.perf_counter() - started) * 1000.0

    def warmup(self) -> dict[str, object]:
        load_ms = self._load()
        return {
            "ok": True,
            "model": MODEL_ID,
            "device": self.device,
            "load_ms": load_ms,
        }

    def predict(self, req: PredictRequest) -> PredictResponse:
        prefix = req.prefix.rstrip()
        if not prefix:
            raise ValueError("prefix must contain non-whitespace text")
        load_ms = self._load()

        import torch

        tokenizer = self._tokenizer
        model = self._model
        assert tokenizer is not None and model is not None

        encoded = tokenizer(prefix, return_tensors="pt")
        input_ids = encoded["input_ids"].to(self._device)
        attention_mask = encoded.get("attention_mask")
        if attention_mask is not None:
            attention_mask = attention_mask.to(self._device)

        # We deliberately over-generate beams because multiple token sequences
        # often collapse to the same visible first word. This is bounded: even
        # top_k=50 never creates a sentence tree; every sequence is cut after a
        # handful of tokens and only its first Unicode word survives.
        beam_count = min(max(req.top_k * 2, 8), 64)
        started = time.perf_counter()
        with torch.inference_mode():
            generated = model.generate(
                input_ids=input_ids,
                attention_mask=attention_mask,
                do_sample=False,
                num_beams=beam_count,
                num_return_sequences=beam_count,
                max_new_tokens=req.max_new_tokens,
                return_dict_in_generate=True,
                output_scores=True,
                early_stopping=False,
            )

        continuation_ids = generated.sequences[:, input_ids.shape[1] :]
        decoded = tokenizer.batch_decode(continuation_ids, skip_special_tokens=True)
        sequence_scores = getattr(generated, "sequences_scores", None)
        if sequence_scores is None:
            scores = [0.0] * len(decoded)
        else:
            scores = [float(value) for value in sequence_scores.detach().cpu().tolist()]

        raw = [
            RawCandidate(continuation=text, log_score=score)
            for text, score in zip(decoded, scores, strict=True)
        ]
        collapsed = collapse_candidates(
            raw,
            top_k=req.top_k,
            context_terms=req.context_terms,
        )
        latency_ms = (time.perf_counter() - started) * 1000.0
        return PredictResponse(
            candidates=[
                Candidate(
                    word=item.word,
                    probability=item.probability,
                    log_score=item.log_score,
                )
                for item in collapsed
            ],
            model=MODEL_ID,
            latency_ms=latency_ms,
            load_ms=load_ms,
            beam_count=beam_count,
        )


engine = PredictorEngine()

# The predictor shares GPU 0 with the acoustic pruner, so its own beam search is
# not the only thing that can delay an answer. Without this gate `predict` was a
# plain `def` handler, i.e. Starlette ran `generate()` in its threadpool with no
# bound below the pool size, so no request ever queued and any `queue_wait_ms`
# it published would have been ~0 by construction. The gate covers this process
# only; contention with the pruner on the same card is still invisible here.
gpu_queue = GpuQueue("predictor", limit=GPU_CONCURRENCY)

app = FastAPI(title="SameVoice Rolling Predictor", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "service": "predictor",
        "model": MODEL_ID,
        "loaded": engine.loaded,
        "device": engine.device,
        "gpu_concurrency": gpu_queue.limit,
        "gpu_queue_waiting": gpu_queue.waiting,
    }


@app.post("/v1/warmup")
async def warmup() -> dict[str, object]:
    # Warmup goes through the same gate as /v1/predict. Moving several hundred
    # MB of weights onto the card is GPU work like any other: run it outside the
    # semaphore and a predict request landing during warmup waits on
    # `PredictorEngine._lock` *inside* its own timed section, which reports the
    # contention as `inference_ms` with `queue_wait_ms ~ 0` -- the mixture this
    # queue exists to prevent. `scripts/runpod-warmup.sh` calls this at boot.
    entered_at = time.perf_counter()
    try:
        result, _timing = await gpu_queue.run(engine.warmup, entered_at=entered_at)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return result


@app.post("/v1/predict", response_model=PredictResponse)
async def predict(req: PredictRequest) -> PredictResponse:
    entered_at = time.perf_counter()
    try:
        response, timing = await gpu_queue.run(engine.predict, req, entered_at=entered_at)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not response.candidates:
        raise HTTPException(status_code=422, detail="predictor produced no word candidates")
    # Built after the card is released, so the copy below is never charged to
    # the GPU; the difference shows up as total_ms - (queue_wait_ms + inference_ms).
    return response.model_copy(update=timing.as_metrics())
