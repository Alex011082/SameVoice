"""Process-level wiring for predictor and acoustic-pruner shadow modes.

The provider registry can wrap any selected STT implementation (Deepgram or the
local RunPod acoustic service) without changing Direction/Relay semantics. Each
STT session gets a zero-impact PredictionShadow observer. Optionally, a sampled
subset of predictor attempts also taps raw PCM into the Stage-2 acoustic pruner.
Neither shadow path is allowed to alter emitted STT events or audible output.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING

from .acoustic_shadow import AcousticShadowSttSession, build_acoustic_aware_predictor
from .evallog import CallEvalLog, is_valid_call_id
from .providers.base import Lang, Speaker, SttProvider, SttSession
from .speculation import HttpPredictorClient, PredictionShadow, ShadowSttSession

if TYPE_CHECKING:  # pragma: no cover
    from .config import Config

logger = logging.getLogger(__name__)


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _enabled() -> bool:
    return _bool_env("PREDICTOR_SHADOW_ENABLED", False)


def _int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("%s=%r is invalid; using %d", name, raw, default)
        return default
    return max(minimum, min(maximum, value))


def _windows_env() -> tuple[int, ...]:
    raw = os.environ.get("ACOUSTIC_PRUNER_SHADOW_WINDOWS_MS", "50,100,150,200,250")
    values: set[int] = set()
    for part in raw.split(","):
        text = part.strip()
        if not text:
            continue
        try:
            values.add(max(20, min(500, int(text))))
        except ValueError:
            logger.warning("ignoring invalid acoustic shadow window %r", text)
    return tuple(sorted(values)) or (100, 150, 200)


def _current_call_id(lang: Lang) -> str:
    task = asyncio.current_task()
    name = task.get_name() if task is not None else ""
    if name.startswith("relay:"):
        candidate = name.removeprefix("relay:").strip()
        if is_valid_call_id(candidate):
            return candidate
    # This fallback is mainly for isolated tests. A real translated call is
    # always started inside AgentService's relay:<callId> supervisor task.
    return f"shadow-{lang}"


class _OwnedShadowSession(ShadowSttSession):
    def __init__(self, inner: SttSession, shadow: PredictionShadow, eval_log: CallEvalLog) -> None:
        super().__init__(inner, shadow)
        self._shadow_eval_log = eval_log

    async def aclose(self) -> None:
        try:
            await super().aclose()
        finally:
            await self._shadow_eval_log.aclose()


class _OwnedAcousticShadowSession(AcousticShadowSttSession):
    def __init__(self, inner, shadow, collector, eval_log: CallEvalLog) -> None:
        super().__init__(inner, shadow, collector)
        self._shadow_eval_log = eval_log

    async def aclose(self) -> None:
        try:
            await super().aclose()
        finally:
            await self._shadow_eval_log.aclose()


class ProcessShadowSttProvider:
    """Transparent provider wrapper used only when predictor shadow is enabled."""

    def __init__(self, inner: SttProvider, cfg: "Config", predictor_url: str) -> None:
        self._inner = inner
        self._cfg = cfg
        self._predictor_url = predictor_url
        self.name = getattr(inner, "name", "stt")
        self.preferred_sample_rate = inner.preferred_sample_rate
        self.preferred_num_channels = inner.preferred_num_channels
        self._top_k = _int_env("PREDICTOR_TOP_K", 20, 1, 50)
        self._min_prefix_words = _int_env("PREDICTOR_MIN_PREFIX_WORDS", 3, 1, 20)
        self._timeout_ms = _int_env("PREDICTOR_TIMEOUT_MS", 600, 50, 5000)
        self._acoustic_shadow = _bool_env("ACOUSTIC_PRUNER_SHADOW_ENABLED", False)
        self._pruner_url = os.environ.get("ACOUSTIC_PRUNER_URL", "").strip()
        self._pruner_timeout_ms = _int_env("ACOUSTIC_PRUNER_TIMEOUT_MS", 1500, 100, 10000)
        self._pruner_every_n = _int_env("ACOUSTIC_PRUNER_SHADOW_EVERY_N", 3, 1, 100)
        self._pruner_windows = _windows_env()

    @property
    def variant(self) -> str | None:
        # Do not disguise the STT actually used. Shadow prediction is logged as
        # a separate record and must not contaminate provider attribution.
        return getattr(self._inner, "variant", None)

    async def start(self, *, lang: Lang) -> SttSession:
        inner_session = await self._inner.start(lang=lang)
        call_id = _current_call_id(lang)
        shadow_log = CallEvalLog(
            path=Path(self._cfg.eval_log_dir) / f"{call_id}.jsonl",
            call_id=call_id,
            enabled=self._cfg.eval_log_enabled,
        )
        speaker = Speaker(
            user_id=f"shadow-{lang}",
            display_name=f"shadow-{lang}",
            lang=lang,
            gender="u",
            tone="neutral",
        )
        context_terms = list(self._cfg.glossary.keys()) + list(self._cfg.glossary.values())

        if self._acoustic_shadow and self._pruner_url:
            predictor_client, collector = build_acoustic_aware_predictor(
                predictor_url=self._predictor_url,
                predictor_timeout_ms=self._timeout_ms,
                pruner_url=self._pruner_url,
                pruner_timeout_ms=self._pruner_timeout_ms,
                call_id=call_id,
                lang=lang,
                eval_log=shadow_log,
                windows_ms=self._pruner_windows,
                every_n=self._pruner_every_n,
            )
            shadow = PredictionShadow(
                call_id=call_id,
                speaker=speaker,
                client=predictor_client,
                eval_log=shadow_log,
                top_k=self._top_k,
                min_prefix_words=self._min_prefix_words,
                context_terms=context_terms,
            )
            logger.info(
                "prediction + acoustic-pruner shadow active call=%s lang=%s top_k=%d windows=%s every_n=%d",
                call_id,
                lang,
                self._top_k,
                self._pruner_windows,
                self._pruner_every_n,
            )
            return _OwnedAcousticShadowSession(inner_session, shadow, collector, shadow_log)

        if self._acoustic_shadow and not self._pruner_url:
            logger.warning(
                "ACOUSTIC_PRUNER_SHADOW_ENABLED=1 but ACOUSTIC_PRUNER_URL is empty; using linguistic shadow only"
            )

        shadow = PredictionShadow(
            call_id=call_id,
            speaker=speaker,
            client=HttpPredictorClient(self._predictor_url, timeout_ms=self._timeout_ms),
            eval_log=shadow_log,
            top_k=self._top_k,
            min_prefix_words=self._min_prefix_words,
            context_terms=context_terms,
        )
        logger.info(
            "prediction shadow active call=%s lang=%s top_k=%d min_prefix_words=%d",
            call_id,
            lang,
            self._top_k,
            self._min_prefix_words,
        )
        return _OwnedShadowSession(inner_session, shadow, shadow_log)

    async def aclose(self) -> None:
        await self._inner.aclose()


def maybe_wrap_stt(inner: SttProvider, cfg: "Config") -> SttProvider:
    if not _enabled():
        return inner
    predictor_url = os.environ.get("PREDICTOR_URL", "").strip()
    if not predictor_url:
        logger.warning("PREDICTOR_SHADOW_ENABLED=1 but PREDICTOR_URL is empty; shadow disabled")
        return inner
    return ProcessShadowSttProvider(inner, cfg, predictor_url)


__all__ = ["ProcessShadowSttProvider", "maybe_wrap_stt"]
