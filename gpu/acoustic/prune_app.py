"""HTTP benchmark surface for SameVoice acoustic candidate re-ranking.

Port 8105 is intentionally separate from the live acoustic websocket in Stage 2.
That lets us benchmark +50/+100/+150/+200 ms windows and model contention before
adding any control messages to the realtime ASR transport.
"""

from __future__ import annotations

import asyncio
import base64
import binascii

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .pruner import CandidateInput, engine_for, rank_candidates


class CandidatePayload(BaseModel):
    word: str = Field(min_length=1, max_length=128)
    probability: float = Field(default=0.0, ge=0.0, le=1.0)


class PruneRequest(BaseModel):
    lang: str
    pcm_s16le_b64: str = Field(min_length=4, max_length=100000)
    candidates: list[CandidatePayload] = Field(min_length=1, max_length=50)


class WarmupRequest(BaseModel):
    lang: str


app = FastAPI(title="SameVoice Acoustic Candidate Pruner", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "service": "acoustic-pruner",
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
    try:
        load_ms = await asyncio.to_thread(engine.load)
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
        evidence = await asyncio.to_thread(engine.infer, audio)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    ranked = rank_candidates(
        [CandidateInput(word=item.word, probability=item.probability) for item in req.candidates],
        evidence=evidence.evidence,
    )
    return {
        "lang": req.lang,
        "model": evidence.model,
        "audio_ms": round(evidence.audio_ms, 1),
        "inference_ms": round(evidence.inference_ms, 1),
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
