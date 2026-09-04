"""HTTP benchmark surface for SameVoice acoustic candidate re-ranking.

Port 8105 is intentionally separate from the live acoustic websocket in Stage 2.
That lets us benchmark +50/+100/+150/+200 ms windows and model contention before
adding any control messages to the realtime ASR transport.
"""

from __future__ import annotations

import base64
import binascii
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from ..queueing import GpuQueue, concurrency_from_env
from .pruner import CandidateInput, engine_for, rank_candidates

GPU_CONCURRENCY = concurrency_from_env("ACOUSTIC_PRUNER_GPU_CONCURRENCY")


class CandidatePayload(BaseModel):
    word: str = Field(min_length=1, max_length=128)
    probability: float = Field(default=0.0, ge=0.0, le=1.0)


class PruneRequest(BaseModel):
    lang: str
    pcm_s16le_b64: str = Field(min_length=4, max_length=100000)
    candidates: list[CandidatePayload] = Field(min_length=1, max_length=50)


class WarmupRequest(BaseModel):
    lang: str


# RU and HE share one engine slot because they share one card with the
# predictor. Before this gate the CTC forward pass ran with no admission control
# and the +50/+100/+150/+200 ms window comparison could not tell a slow model
# from a contended card.
gpu_queue = GpuQueue("acoustic-pruner", limit=GPU_CONCURRENCY)

app = FastAPI(title="SameVoice Acoustic Candidate Pruner", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "service": "acoustic-pruner",
        "gpu_concurrency": gpu_queue.limit,
        "gpu_queue_waiting": gpu_queue.waiting,
        "engines": {
            lang: {
                "model": engine.model_id,
                "loaded": engine.loaded,
                "device": engine.device,
                "load_ms": round(engine.load_ms, 1),
            }
            for lang, engine in (("ru", engine_for("ru")), ("he", engine_for("he")))
        },
    }


@app.post("/v1/warmup")
async def warmup(req: WarmupRequest) -> dict[str, object]:
    if req.lang not in ("ru", "he"):
        raise HTTPException(status_code=400, detail="lang must be ru or he")
    engine = engine_for(req.lang)  # type: ignore[arg-type]
    # Through the same gate as /v1/prune. Moving weights onto the card is GPU
    # work: outside the semaphore, a prune request arriving during warmup blocks
    # on `CtcEvidenceEngine._lock` inside its own timed section and reports the
    # contention as `inference_ms` with `queue_wait_ms ~ 0`.
    entered_at = time.perf_counter()
    try:
        load_ms, _timing = await gpu_queue.run(engine.load, entered_at=entered_at)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "ok": True,
        "lang": req.lang,
        "model": engine.model_id,
        "load_ms": load_ms,
        "device": engine.device,
    }


@app.post("/v1/prune")
async def prune(req: PruneRequest) -> dict[str, object]:
    # Request entry, not "just before acquire": the wait we have to publish is
    # the one the caller actually experienced. Decoding a <=100 kB base64 window
    # below is bounded and sub-millisecond, so folding it into the wait keeps
    # queue_wait_ms + inference_ms <= total_ms readable as a whole.
    entered_at = time.perf_counter()
    if req.lang not in ("ru", "he"):
        raise HTTPException(status_code=400, detail="lang must be ru or he")
    try:
        pcm = base64.b64decode(req.pcm_s16le_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="pcm_s16le_b64 is not valid base64") from exc
    if not pcm or len(pcm) % 2:
        raise HTTPException(status_code=400, detail="PCM must be non-empty signed 16-bit LE")

    import numpy as np

    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    engine = engine_for(req.lang)  # type: ignore[arg-type]
    try:
        evidence, timing = await gpu_queue.run(engine.infer, audio, entered_at=entered_at)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    # Re-ranking is pure Python over <=50 short strings and touches no GPU, so it
    # runs after the card is released. Holding the semaphore here would push this
    # cost into the next request's queue_wait_ms and hide it again.
    ranked = rank_candidates(
        [CandidateInput(word=item.word, probability=item.probability) for item in req.candidates],
        evidence=evidence.evidence,
    )
    return {
        "lang": req.lang,
        "model": evidence.model,
        "audio_ms": round(evidence.audio_ms, 1),
        # inference_ms now covers the whole blocking section held under the
        # semaphore (feature extraction + forward + greedy decode, plus the lazy
        # weight load on the first call), so that queue_wait_ms/inference_ms/
        # total_ms add up. The narrower forward-only number that used to be
        # published under this name is kept as model_forward_ms, and both
        # scripts/acoustic-pruning-bench.py and scripts/acoustic-replay-bench.py
        # were switched to read model_forward_ms -- otherwise their per-window
        # `inferenceMs` column would silently change meaning across this commit
        # and old artifacts would look comparable to new ones when they are not.
        **timing.as_metrics(),
        "model_forward_ms": round(evidence.inference_ms, 1),
        "raw_evidence": evidence.raw_text,
        "evidence": evidence.evidence,
        "ranked": [
            {
                "rank": index,
                "word": item.word,
                "probability": item.probability,
                "acoustic_score": item.acoustic_score,
                "combined_score": item.combined_score,
            }
            for index, item in enumerate(ranked, start=1)
        ],
    }
