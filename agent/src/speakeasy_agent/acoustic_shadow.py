"""Live-safe acoustic-pruner shadow integration.

This module samples a small fraction of rolling predictor attempts and captures
raw PCM *after the predictor is armed*. Once enough audio is buffered, the same
Top-K linguistic candidates are sent to the Stage-2 CTC pruner at several short
windows. Results are logged only; they cannot change STT, MT, TTS, subtitles or
audible output.

`reference=prediction_arm` is intentionally explicit. This is not yet perfect
word-onset PLT: the stable linguistic prefix may arrive before, at, or after the
physical onset of the next word. Offline exact-onset tests remain the clean
component benchmark; this live shadow tells us how the scorer behaves under the
real timing and GPU-contention envelope.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Protocol, Sequence

import aiohttp
from livekit import rtc

from .evallog import CallEvalLog
from .httpclient import shared_session
from .providers.base import Lang, SttEvent, SttSession
from .speculation import (
    HttpPredictorClient,
    PredictionCandidate,
    PredictionResult,
    PredictorClient,
    ShadowSttSession,
    common_prefix_len,
    words,
)

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
CHANNELS = 1


@dataclass(frozen=True)
class AcousticWindowResult:
    window_ms: int
    evidence: str
    raw_evidence: str
    inference_ms: float | None
    ranked: tuple[dict[str, Any], ...]


class AcousticPrunerClient(Protocol):
    async def prune(
        self,
        *,
        lang: Lang,
        pcm_s16le: bytes,
        candidates: Sequence[PredictionCandidate],
    ) -> AcousticWindowResult: ...

    async def aclose(self) -> None: ...


class HttpAcousticPrunerClient:
    def __init__(self, url: str, *, timeout_ms: int = 1500) -> None:
        base = url.strip().rstrip("/")
        self._url = base if base.endswith("/v1/prune") else base + "/v1/prune"
        self._timeout = aiohttp.ClientTimeout(total=max(0.1, timeout_ms / 1000.0))

    async def prune(
        self,
        *,
        lang: Lang,
        pcm_s16le: bytes,
        candidates: Sequence[PredictionCandidate],
    ) -> AcousticWindowResult:
        async with shared_session().post(
            self._url,
            json={
                "lang": lang,
                "pcm_s16le_b64": base64.b64encode(pcm_s16le).decode("ascii"),
                "candidates": [
                    {"word": item.word, "probability": item.probability}
                    for item in candidates
                ],
            },
            timeout=self._timeout,
        ) as response:
            payload: Any = await response.json(content_type=None)
            if response.status >= 400:
                raise RuntimeError(f"acoustic pruner HTTP {response.status}: {str(payload)[:300]}")
        if not isinstance(payload, dict):
            raise RuntimeError("acoustic pruner returned a non-object response")
        ranked_raw = payload.get("ranked")
        ranked = tuple(item for item in ranked_raw if isinstance(item, dict)) if isinstance(ranked_raw, list) else ()
        audio_ms = payload.get("audio_ms")
        return AcousticWindowResult(
            window_ms=int(round(float(audio_ms))) if isinstance(audio_ms, (int, float)) else 0,
            evidence=str(payload.get("evidence") or ""),
            raw_evidence=str(payload.get("raw_evidence") or ""),
            inference_ms=(
                float(payload["inference_ms"])
                if isinstance(payload.get("inference_ms"), (int, float))
                else None
            ),
            ranked=ranked,
        )

    async def aclose(self) -> None:
        return None


@dataclass
class _Arm:
    id: int
    prefix: tuple[str, ...]
    armed_at: float
    start_sample: int
    audio: bytearray = field(default_factory=bytearray)
    candidates: tuple[PredictionCandidate, ...] = ()
    predictor_model: str = ""
    predictor_completed_at: float | None = None
    truth: str | None = None
    truth_stable_at: float | None = None
    status: str = "armed"
    scores: list[AcousticWindowResult] = field(default_factory=list)
    score_error: str | None = None
    scoring_started: bool = False
    logged: bool = False


class LiveAcousticPruningCollector:
    """Capture arm-relative audio for one STT direction and score it in shadow."""

    def __init__(
        self,
        *,
        call_id: str,
        lang: Lang,
        eval_log: CallEvalLog | None,
        client: AcousticPrunerClient,
        windows_ms: Sequence[int] = (50, 100, 150, 200, 250),
        every_n: int = 3,
        max_active: int = 1,
    ) -> None:
        clean = sorted({max(20, min(500, int(value))) for value in windows_ms})
        self.call_id = call_id
        self.lang = lang
        self.eval_log = eval_log
        self.client = client
        self.windows_ms = tuple(clean or (100, 150, 200))
        self.every_n = max(1, int(every_n))
        self.max_active = max(1, int(max_active))
        self._max_bytes = self.windows_ms[-1] * SAMPLE_RATE // 1000 * 2
        self._samples_seen = 0
        self._arm_seq = 0
        self._attempt_seq = 0
        self._arms: list[_Arm] = []
        self._previous_words: tuple[str, ...] = ()
        self._tasks: set[asyncio.Task] = set()
        self._closed = False

    def arm(self, prefix: str) -> int | None:
        if self._closed:
            return None
        self._attempt_seq += 1
        if (self._attempt_seq - 1) % self.every_n != 0:
            return None
        active = sum(1 for item in self._arms if not item.logged and item.status in ("armed", "resolved"))
        if active >= self.max_active:
            return None
        prefix_words = words(prefix)
        if not prefix_words:
            return None
        self._arm_seq += 1
        arm = _Arm(
            id=self._arm_seq,
            prefix=prefix_words,
            armed_at=time.monotonic(),
            start_sample=self._samples_seen,
        )
        self._arms.append(arm)
        return arm.id

    def predictor_result(self, arm_id: int | None, result: PredictionResult) -> None:
        arm = self._find(arm_id)
        if arm is None or arm.logged:
            return
        arm.candidates = result.candidates
        arm.predictor_model = result.model
        arm.predictor_completed_at = time.monotonic()
        self._maybe_start_scoring(arm)

    def predictor_error(self, arm_id: int | None, exc: BaseException) -> None:
        arm = self._find(arm_id)
        if arm is None or arm.logged:
            return
        arm.status = "predictor_error"
        arm.score_error = str(exc)[:400]
        self._maybe_log(arm)

    def feed_pcm(self, payload: bytes, *, sample_rate: int = SAMPLE_RATE, channels: int = CHANNELS) -> None:
        if self._closed or not payload:
            return
        if sample_rate != SAMPLE_RATE or channels != CHANNELS or len(payload) % 2:
            return
        samples = len(payload) // 2
        self._samples_seen += samples
        for arm in self._arms:
            if arm.logged or len(arm.audio) >= self._max_bytes:
                continue
            remaining = self._max_bytes - len(arm.audio)
            arm.audio.extend(payload[:remaining])
            self._maybe_start_scoring(arm)

    def feed_frame(self, frame: rtc.AudioFrame) -> None:
        self.feed_pcm(
            bytes(frame.data),
            sample_rate=int(frame.sample_rate),
            channels=int(frame.num_channels),
        )

    def observe_stt(self, event: SttEvent, *, now: float | None = None) -> None:
        if self._closed:
            return
        observed_at = time.monotonic() if now is None else now
        if event.type == "speech_start":
            self._previous_words = ()
            return
        if event.type not in ("partial", "final"):
            return
        current = words(event.text)
        stable_count = len(current) if event.type == "final" else common_prefix_len(self._previous_words, current)

        for arm in self._arms:
            if arm.logged or arm.truth is not None or arm.status not in ("armed", "resolved"):
                continue
            index = len(arm.prefix)
            if stable_count <= index or len(current) <= index:
                continue
            if tuple(current[:index]) != arm.prefix:
                arm.status = "prefix_revised"
                self._maybe_log(arm)
                continue
            arm.truth = current[index]
            arm.truth_stable_at = observed_at
            arm.status = "resolved"
            self._maybe_log(arm)

        self._previous_words = () if event.type == "final" else current
        if event.type == "final":
            for arm in self._arms:
                if not arm.logged and arm.truth is None and arm.status == "armed":
                    arm.status = "no_next_word"
                    self._maybe_log(arm)
        self._prune()

    def _find(self, arm_id: int | None) -> _Arm | None:
        if arm_id is None:
            return None
        return next((item for item in self._arms if item.id == arm_id), None)

    def _maybe_start_scoring(self, arm: _Arm) -> None:
        if arm.logged or arm.scoring_started or not arm.candidates:
            return
        if len(arm.audio) < self._max_bytes:
            return
        arm.scoring_started = True
        task = asyncio.create_task(self._score(arm), name=f"acoustic-prune-shadow:{self.lang}:{arm.id}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _score(self, arm: _Arm) -> None:
        try:
            for window_ms in self.windows_ms:
                byte_count = window_ms * SAMPLE_RATE // 1000 * 2
                result = await self.client.prune(
                    lang=self.lang,
                    pcm_s16le=bytes(arm.audio[:byte_count]),
                    candidates=arm.candidates,
                )
                # The server reports rounded audio_ms; preserve the requested
                # window exactly for stable aggregation.
                arm.scores.append(
                    AcousticWindowResult(
                        window_ms=window_ms,
                        evidence=result.evidence,
                        raw_evidence=result.raw_evidence,
                        inference_ms=result.inference_ms,
                        ranked=result.ranked,
                    )
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            arm.score_error = str(exc)[:400]
            logger.debug("acoustic pruning shadow failed lang=%s: %s", self.lang, exc)
        finally:
            self._maybe_log(arm)

    def _maybe_log(self, arm: _Arm) -> None:
        if arm.logged:
            return
        if arm.status in ("armed",):
            return
        if arm.scoring_started and len(arm.scores) < len(self.windows_ms) and arm.score_error is None:
            return
        if not arm.scoring_started and arm.status == "resolved" and arm.candidates and len(arm.audio) < self._max_bytes:
            # Wait for enough future audio to finish the configured arm-relative
            # windows; the actual next word may stabilize before +250 ms after arm.
            return

        rows: list[dict[str, Any]] = []
        for score in arm.scores:
            truth_rank = None
            if arm.truth is not None:
                for item in score.ranked:
                    word = item.get("word")
                    if isinstance(word, str) and word.casefold() == arm.truth.casefold():
                        rank = item.get("rank")
                        truth_rank = int(rank) if isinstance(rank, int) else None
                        break
            estimated_lead = None
            if arm.truth_stable_at is not None and score.inference_ms is not None:
                estimated_lead = round(
                    (arm.truth_stable_at - arm.armed_at) * 1000.0
                    - score.window_ms
                    - score.inference_ms,
                    1,
                )
            rows.append(
                {
                    "windowMs": score.window_ms,
                    "evidence": score.evidence,
                    "rawEvidence": score.raw_evidence,
                    "inferenceMs": round(score.inference_ms, 1) if score.inference_ms is not None else None,
                    "truthRank": truth_rank,
                    "retained": {
                        "top3": truth_rank is not None and truth_rank <= 3,
                        "top5": truth_rank is not None and truth_rank <= 5,
                        "top10": truth_rank is not None and truth_rank <= 10,
                        "top20": truth_rank is not None and truth_rank <= 20,
                    },
                    # Positive is a *component estimate*: window availability +
                    # CTC inference would precede ordinary STT truth stability if
                    # scheduled immediately. HTTP/queue contention is represented
                    # only insofar as the pruner's inferenceMs includes it.
                    "estimatedLeadVsSttMs": estimated_lead,
                    "top5": list(score.ranked[:5]),
                }
            )

        record = {
            "kind": "acoustic_pruning_shadow",
            "v": 1,
            "ts": round(time.time(), 3),
            "callId": self.call_id,
            "srcLang": self.lang,
            "armId": arm.id,
            "status": arm.status,
            "reference": "prediction_arm",
            "prefix": " ".join(arm.prefix),
            "actualNextWord": arm.truth,
            "armToTruthStableMs": (
                round((arm.truth_stable_at - arm.armed_at) * 1000.0, 1)
                if arm.truth_stable_at is not None
                else None
            ),
            "predictorModel": arm.predictor_model,
            "candidateCount": len(arm.candidates),
            "scoreError": arm.score_error,
            "windows": rows,
        }
        logger.info("speakeasy.acoustic_pruning %s", record)
        if self.eval_log is not None:
            self.eval_log.append(record)
        arm.logged = True
        self._prune()

    def _prune(self) -> None:
        if len(self._arms) > 128:
            unresolved = [item for item in self._arms if not item.logged]
            done_tail = [item for item in self._arms if item.logged][-32:]
            self._arms = done_tail + unresolved

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._tasks:
            _, pending = await asyncio.wait(self._tasks, timeout=2.0)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        for arm in self._arms:
            if not arm.logged:
                if arm.status == "armed":
                    arm.status = "closed"
                self._maybe_log(arm)
        await self.client.aclose()


class AcousticAwarePredictorClient:
    """Predictor client decorator that arms the PCM collector per sampled request."""

    def __init__(self, inner: PredictorClient, collector: LiveAcousticPruningCollector) -> None:
        self._inner = inner
        self.collector = collector

    async def predict(
        self,
        *,
        prefix: str,
        lang: Lang,
        top_k: int,
        context_terms: Sequence[str],
    ) -> PredictionResult:
        arm_id = self.collector.arm(prefix)
        try:
            result = await self._inner.predict(
                prefix=prefix,
                lang=lang,
                top_k=top_k,
                context_terms=context_terms,
            )
        except BaseException as exc:
            self.collector.predictor_error(arm_id, exc)
            raise
        self.collector.predictor_result(arm_id, result)
        return result

    async def aclose(self) -> None:
        await self._inner.aclose()


class AcousticShadowSttSession(ShadowSttSession):
    """Transparent session: tap PCM + STT events while base shadow keeps semantics."""

    def __init__(
        self,
        inner: SttSession,
        shadow,
        collector: LiveAcousticPruningCollector,
    ) -> None:
        super().__init__(inner, shadow)
        self._collector = collector

    def push_frame(self, frame: rtc.AudioFrame) -> None:
        try:
            self._collector.feed_frame(frame)
        except Exception as exc:
            logger.debug("acoustic shadow PCM tap failed: %s", exc)
        super().push_frame(frame)

    async def _iterate(self) -> AsyncIterator[SttEvent]:
        async for event in super()._iterate():
            try:
                self._collector.observe_stt(event, now=time.monotonic())
            except Exception as exc:
                logger.debug("acoustic shadow STT observation failed: %s", exc)
            yield event

    async def aclose(self) -> None:
        try:
            await super().aclose()
        finally:
            await self._collector.aclose()


def build_acoustic_aware_predictor(
    *,
    predictor_url: str,
    predictor_timeout_ms: int,
    pruner_url: str,
    pruner_timeout_ms: int,
    call_id: str,
    lang: Lang,
    eval_log: CallEvalLog | None,
    windows_ms: Sequence[int],
    every_n: int,
) -> tuple[PredictorClient, LiveAcousticPruningCollector]:
    collector = LiveAcousticPruningCollector(
        call_id=call_id,
        lang=lang,
        eval_log=eval_log,
        client=HttpAcousticPrunerClient(pruner_url, timeout_ms=pruner_timeout_ms),
        windows_ms=windows_ms,
        every_n=every_n,
    )
    predictor = AcousticAwarePredictorClient(
        HttpPredictorClient(predictor_url, timeout_ms=predictor_timeout_ms),
        collector,
    )
    return predictor, collector


__all__ = [
    "AcousticAwarePredictorClient",
    "AcousticPrunerClient",
    "AcousticShadowSttSession",
    "AcousticWindowResult",
    "HttpAcousticPrunerClient",
    "LiveAcousticPruningCollector",
    "build_acoustic_aware_predictor",
]
