"""Non-invasive rolling next-word prediction shadow runtime.

This module measures whether the next-source-word predictor is useful before it
is ever allowed to influence translation or audible output. It observes STT
hypotheses, waits for a prefix to become stable across consecutive hypotheses,
asks the local predictor for Top-K candidates, then scores those candidates once
the following source word itself becomes stable.

Important: this is *not* the acoustic-pruning layer yet. ``sttLeadMs`` measures
how early the linguistic predictor finished relative to the next word becoming
stable in the normal STT stream. Later acoustic scoring can add a separate
``acousticLeadMs`` without changing this contract.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol, Sequence

import aiohttp

from .evallog import CallEvalLog
from .httpclient import shared_session
from .providers.base import Lang, Speaker

if TYPE_CHECKING:  # pragma: no cover
    from .config import Config

logger = logging.getLogger(__name__)

_WORD_RE = re.compile(r"[^\W_]+(?:['’־-][^\W_]+)*", re.UNICODE)


def words(text: str) -> tuple[str, ...]:
    """Unicode words suitable for RU/HE prefix comparison."""
    return tuple(match.group(0).casefold() for match in _WORD_RE.finditer(text))


def common_prefix_len(left: Sequence[str], right: Sequence[str]) -> int:
    limit = min(len(left), len(right))
    for index in range(limit):
        if left[index] != right[index]:
            return index
    return limit


@dataclass(frozen=True)
class PredictionCandidate:
    word: str
    probability: float = 0.0


@dataclass(frozen=True)
class PredictionResult:
    candidates: tuple[PredictionCandidate, ...]
    model: str
    model_latency_ms: float | None
    round_trip_ms: float


class PredictorClient(Protocol):
    async def predict(
        self,
        *,
        prefix: str,
        lang: Lang,
        top_k: int,
        context_terms: Sequence[str],
    ) -> PredictionResult: ...

    async def aclose(self) -> None: ...


class HttpPredictorClient:
    def __init__(self, url: str, *, timeout_ms: int = 600) -> None:
        base = url.strip().rstrip("/")
        self._url = base if base.endswith("/v1/predict") else base + "/v1/predict"
        self._timeout = aiohttp.ClientTimeout(total=max(0.05, timeout_ms / 1000.0))

    async def predict(
        self,
        *,
        prefix: str,
        lang: Lang,
        top_k: int,
        context_terms: Sequence[str],
    ) -> PredictionResult:
        started = time.monotonic()
        async with shared_session().post(
            self._url,
            json={
                "prefix": prefix,
                "lang": lang,
                "top_k": top_k,
                "context_terms": list(context_terms),
                "max_new_tokens": 6,
            },
            timeout=self._timeout,
        ) as response:
            payload: Any = await response.json(content_type=None)
            if response.status >= 400:
                raise RuntimeError(f"predictor HTTP {response.status}: {str(payload)[:300]}")
        if not isinstance(payload, dict):
            raise RuntimeError("predictor returned a non-object response")
        raw_candidates = payload.get("candidates")
        if not isinstance(raw_candidates, list):
            raise RuntimeError("predictor response is missing candidates")
        candidates: list[PredictionCandidate] = []
        for item in raw_candidates:
            if not isinstance(item, dict):
                continue
            word = item.get("word")
            if not isinstance(word, str) or not word.strip():
                continue
            probability = item.get("probability")
            candidates.append(
                PredictionCandidate(
                    word=word.strip().casefold(),
                    probability=float(probability) if isinstance(probability, (int, float)) else 0.0,
                )
            )
        return PredictionResult(
            candidates=tuple(candidates),
            model=str(payload.get("model") or ""),
            model_latency_ms=(
                float(payload["latency_ms"])
                if isinstance(payload.get("latency_ms"), (int, float))
                else None
            ),
            round_trip_ms=(time.monotonic() - started) * 1000.0,
        )

    async def aclose(self) -> None:
        # The process-owned shared aiohttp session is closed by main.py.
        return None


@dataclass
class _Attempt:
    prefix: tuple[str, ...]
    requested_at: float
    completed_at: float | None = None
    result: PredictionResult | None = None
    actual_word: str | None = None
    confirmed_at: float | None = None
    status: str = "pending"
    logged: bool = False


@dataclass
class PredictionShadowStats:
    requested: int = 0
    resolved: int = 0
    errors: int = 0
    top1_hits: int = 0
    top5_hits: int = 0
    top20_hits: int = 0


class PredictionShadow:
    """One direction's zero-impact predictor evaluator."""

    def __init__(
        self,
        *,
        call_id: str,
        speaker: Speaker,
        client: PredictorClient,
        eval_log: CallEvalLog | None,
        top_k: int = 20,
        min_prefix_words: int = 3,
        context_terms: Sequence[str] = (),
    ) -> None:
        self.call_id = call_id
        self.speaker = speaker
        self.client = client
        self.eval_log = eval_log
        self.top_k = max(1, min(50, int(top_k)))
        self.min_prefix_words = max(1, int(min_prefix_words))
        self.context_terms = tuple(dict.fromkeys(term.strip() for term in context_terms if term.strip()))
        self.stats = PredictionShadowStats()
        self._previous_words: tuple[str, ...] = ()
        self._attempts: list[_Attempt] = []
        self._tasks: set[asyncio.Task] = set()
        self._closed = False

    def observe(self, text: str, *, now: float | None = None, final: bool = False) -> None:
        """Observe an STT hypothesis without awaiting network/model work."""
        if self._closed:
            return
        observed_at = time.monotonic() if now is None else now
        current = words(text)
        stable_count = len(current) if final else common_prefix_len(self._previous_words, current)

        # Resolve older predictions only when the next word is itself stable.
        for attempt in self._attempts:
            if attempt.actual_word is not None or attempt.logged:
                continue
            index = len(attempt.prefix)
            if stable_count <= index or len(current) <= index:
                continue
            if tuple(current[:index]) != attempt.prefix:
                attempt.status = "prefix_revised"
                self._emit_if_ready(attempt)
                continue
            attempt.actual_word = current[index]
            attempt.confirmed_at = observed_at
            attempt.status = "resolved"
            self._emit_if_ready(attempt)

        if final:
            for attempt in self._attempts:
                if not attempt.logged and attempt.actual_word is None and attempt.status == "pending":
                    attempt.status = "no_next_word"
                    self._emit_if_ready(attempt)
            self._previous_words = ()
            return

        stable_prefix = tuple(current[:stable_count])
        self._previous_words = current
        if len(stable_prefix) < self.min_prefix_words:
            return
        if any(attempt.prefix == stable_prefix for attempt in self._attempts):
            return

        attempt = _Attempt(prefix=stable_prefix, requested_at=observed_at)
        self._attempts.append(attempt)
        self.stats.requested += 1
        task = asyncio.create_task(self._run(attempt), name=f"predict-shadow:{self.speaker.user_id}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def reset(self, *, reason: str = "reset") -> None:
        """Reset STT agreement state between utterances without cancelling model work."""
        self._previous_words = ()
        for attempt in self._attempts:
            if not attempt.logged and attempt.actual_word is None and attempt.status == "pending":
                attempt.status = reason
                self._emit_if_ready(attempt)

    async def _run(self, attempt: _Attempt) -> None:
        try:
            attempt.result = await self.client.predict(
                prefix=" ".join(attempt.prefix),
                lang=self.speaker.lang,
                top_k=self.top_k,
                context_terms=self.context_terms,
            )
            attempt.completed_at = time.monotonic()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            attempt.completed_at = time.monotonic()
            attempt.status = "error"
            self.stats.errors += 1
            logger.debug("prediction shadow failed %s: %s", self.speaker.user_id, exc)
            self._append(
                {
                    "kind": "prediction_shadow_error",
                    "v": 1,
                    "ts": round(time.time(), 3),
                    "callId": self.call_id,
                    "speakerId": self.speaker.user_id,
                    "srcLang": self.speaker.lang,
                    "prefix": " ".join(attempt.prefix),
                    "error": str(exc)[:400],
                }
            )
            attempt.logged = True
            return
        self._emit_if_ready(attempt)

    def _emit_if_ready(self, attempt: _Attempt) -> None:
        if attempt.logged or attempt.result is None:
            return
        # A result can arrive before the next word; keep it pending until the STT
        # stream verifies the word or closes/revises the prefix.
        if attempt.status == "pending" and attempt.actual_word is None:
            return

        result = attempt.result
        candidate_words = [candidate.word for candidate in result.candidates]
        actual = attempt.actual_word
        rank = candidate_words.index(actual) + 1 if actual in candidate_words else None
        hits = {
            "top1": rank is not None and rank <= 1,
            "top3": rank is not None and rank <= 3,
            "top5": rank is not None and rank <= 5,
            "top10": rank is not None and rank <= 10,
            "top20": rank is not None and rank <= 20,
        }
        if attempt.status == "resolved":
            self.stats.resolved += 1
            self.stats.top1_hits += int(hits["top1"])
            self.stats.top5_hits += int(hits["top5"])
            self.stats.top20_hits += int(hits["top20"])
        stt_lead_ms = None
        if attempt.confirmed_at is not None and attempt.completed_at is not None:
            stt_lead_ms = round((attempt.confirmed_at - attempt.completed_at) * 1000.0, 1)

        self._append(
            {
                "kind": "prediction_shadow",
                "v": 1,
                "ts": round(time.time(), 3),
                "callId": self.call_id,
                "speakerId": self.speaker.user_id,
                "srcLang": self.speaker.lang,
                "status": attempt.status,
                "prefix": " ".join(attempt.prefix),
                "prefixWords": len(attempt.prefix),
                "actualNextWord": actual,
                "rank": rank,
                "hits": hits,
                "candidates": [
                    {"word": candidate.word, "probability": round(candidate.probability, 6)}
                    for candidate in result.candidates
                ],
                "model": result.model,
                "predictorModelLatencyMs": (
                    round(result.model_latency_ms, 1)
                    if result.model_latency_ms is not None
                    else None
                ),
                "predictorRoundTripMs": round(result.round_trip_ms, 1),
                # Positive means the predictor answer existed before conventional
                # STT stabilized the actual next source word. Negative means it
                # was too late. This is deliberately NOT called acoustic PLT.
                "sttLeadMs": stt_lead_ms,
            }
        )
        attempt.logged = True

    def _append(self, record: dict[str, Any]) -> None:
        logger.info("speakeasy.prediction %s", record)
        if self.eval_log is not None:
            self.eval_log.append(record)

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.reset(reason="closed")
        if self._tasks:
            done, pending = await asyncio.wait(self._tasks, timeout=1.0)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        await self.client.aclose()


def build_prediction_shadow(
    cfg: "Config",
    *,
    call_id: str,
    speaker: Speaker,
    eval_log: CallEvalLog | None,
    glossary: dict[str, str] | None = None,
) -> PredictionShadow | None:
    if not cfg.predictor_shadow_enabled:
        return None
    if not cfg.predictor_url.strip():
        logger.warning("PREDICTOR_SHADOW_ENABLED=1 but PREDICTOR_URL is empty; shadow disabled")
        return None
    context = list((glossary or {}).keys()) + list((glossary or {}).values())
    return PredictionShadow(
        call_id=call_id,
        speaker=speaker,
        client=HttpPredictorClient(cfg.predictor_url, timeout_ms=cfg.predictor_timeout_ms),
        eval_log=eval_log,
        top_k=cfg.predictor_top_k,
        min_prefix_words=cfg.predictor_min_prefix_words,
        context_terms=context,
    )


__all__ = [
    "HttpPredictorClient",
    "PredictionCandidate",
    "PredictionResult",
    "PredictionShadow",
    "PredictionShadowStats",
    "build_prediction_shadow",
    "common_prefix_len",
    "words",
]
