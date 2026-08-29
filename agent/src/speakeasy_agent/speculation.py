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
import os
import re
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Protocol, Sequence

import aiohttp
from livekit import rtc

from .evallog import CallEvalLog
from .httpclient import shared_session
from .providers.base import Lang, Speaker, SttEvent, SttProvider, SttSession

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


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("%s=%r is not an integer; using %d", name, raw, default)
        return default
    return max(minimum, min(maximum, value))


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

        # Resolve older predictions only when the following word is itself stable.
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
            self._prune()
            return

        stable_prefix = tuple(current[:stable_count])
        self._previous_words = current
        if len(stable_prefix) < self.min_prefix_words:
            return
        if any(attempt.prefix == stable_prefix and not attempt.logged for attempt in self._attempts):
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
        self._prune()

    def _prune(self) -> None:
        # Long calls can produce thousands of hypotheses. Once an attempt has
        # been logged it has no runtime value; keep only a small diagnostic tail.
        if len(self._attempts) > 512:
            unresolved = [attempt for attempt in self._attempts if not attempt.logged]
            logged_tail = [attempt for attempt in self._attempts if attempt.logged][-128:]
            self._attempts = logged_tail + unresolved

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
        self.reset(reason="closed")
        self._closed = True
        if self._tasks:
            _, pending = await asyncio.wait(self._tasks, timeout=1.0)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        await self.client.aclose()


class ShadowSttSession:
    """Transparent STT session wrapper; yielded events are never modified."""

    def __init__(self, inner: SttSession, shadow: PredictionShadow) -> None:
        self._inner = inner
        self._shadow = shadow

    def push_frame(self, frame: rtc.AudioFrame) -> None:
        self._inner.push_frame(frame)

    async def flush(self) -> None:
        await self._inner.flush()

    def __aiter__(self) -> AsyncIterator[SttEvent]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[SttEvent]:
        async for event in self._inner:
            now = time.monotonic()
            try:
                if event.type == "speech_start":
                    self._shadow.reset(reason="speech_start")
                elif event.type == "partial":
                    self._shadow.observe(event.text, now=now, final=False)
                elif event.type == "final":
                    self._shadow.observe(event.text, now=now, final=True)
            except Exception as exc:
                # Shadow mode is observational. A bug here must never damage a call.
                logger.warning("prediction shadow observation failed: %s", exc)
            yield event

    async def aclose(self) -> None:
        try:
            await self._shadow.aclose()
        finally:
            await self._inner.aclose()


class ShadowSttProvider:
    """Per-direction wrapper that preserves the actual STT provider identity."""

    def __init__(
        self,
        inner: SttProvider,
        *,
        call_id: str,
        speaker: Speaker,
        eval_log: CallEvalLog | None,
        predictor_url: str,
        top_k: int,
        min_prefix_words: int,
        timeout_ms: int,
        context_terms: Sequence[str],
    ) -> None:
        self._inner = inner
        self._call_id = call_id
        self._speaker = speaker
        self._eval_log = eval_log
        self._predictor_url = predictor_url
        self._top_k = top_k
        self._min_prefix_words = min_prefix_words
        self._timeout_ms = timeout_ms
        self._context_terms = tuple(context_terms)
        self.name = getattr(inner, "name", "stt")
        self.preferred_sample_rate = inner.preferred_sample_rate
        self.preferred_num_channels = inner.preferred_num_channels

    @property
    def variant(self) -> str | None:
        return getattr(self._inner, "variant", None)

    async def start(self, *, lang: Lang) -> SttSession:
        inner_session = await self._inner.start(lang=lang)
        shadow = PredictionShadow(
            call_id=self._call_id,
            speaker=self._speaker,
            client=HttpPredictorClient(self._predictor_url, timeout_ms=self._timeout_ms),
            eval_log=self._eval_log,
            top_k=self._top_k,
            min_prefix_words=self._min_prefix_words,
            context_terms=self._context_terms,
        )
        return ShadowSttSession(inner_session, shadow)

    async def aclose(self) -> None:
        # Relay owns the shared underlying provider and closes it exactly once.
        return None


def build_shadow_stt_provider(
    inner: SttProvider,
    *,
    call_id: str,
    speaker: Speaker,
    eval_log: CallEvalLog | None,
    glossary: dict[str, str] | None = None,
) -> SttProvider:
    """Return the original provider unless shadow mode is explicitly enabled."""
    if not _env_bool("PREDICTOR_SHADOW_ENABLED", False):
        return inner
    predictor_url = os.environ.get("PREDICTOR_URL", "").strip()
    if not predictor_url:
        logger.warning("PREDICTOR_SHADOW_ENABLED=1 but PREDICTOR_URL is empty; shadow disabled")
        return inner
    top_k = _env_int("PREDICTOR_TOP_K", 20, minimum=1, maximum=50)
    min_prefix_words = _env_int("PREDICTOR_MIN_PREFIX_WORDS", 3, minimum=1, maximum=20)
    timeout_ms = _env_int("PREDICTOR_TIMEOUT_MS", 600, minimum=50, maximum=5000)
    terms = list((glossary or {}).keys()) + list((glossary or {}).values())
    return ShadowSttProvider(
        inner,
        call_id=call_id,
        speaker=speaker,
        eval_log=eval_log,
        predictor_url=predictor_url,
        top_k=top_k,
        min_prefix_words=min_prefix_words,
        timeout_ms=timeout_ms,
        context_terms=terms,
    )


__all__ = [
    "HttpPredictorClient",
    "PredictionCandidate",
    "PredictionResult",
    "PredictionShadow",
    "PredictionShadowStats",
    "ShadowSttProvider",
    "ShadowSttSession",
    "build_shadow_stt_provider",
    "common_prefix_len",
    "words",
]
