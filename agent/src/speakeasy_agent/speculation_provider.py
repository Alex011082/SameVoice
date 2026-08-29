"""Process-level wiring for predictor shadow mode.

The provider registry can wrap any selected STT implementation (Deepgram or the
local RunPod acoustic service) without changing Direction/Relay semantics. Each
STT session gets a zero-impact PredictionShadow observer. The wrapper infers the
call id from the relay task name (``relay:<callId>``) and appends prediction
records to the same per-call JSONL through its own non-blocking CallEvalLog
writer. The existing global append lock keeps both writers safe.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import TYPE_CHECKING

from .evallog import CallEvalLog, is_valid_call_id
from .providers.base import Lang, Speaker, SttProvider, SttSession
from .speculation import HttpPredictorClient, PredictionShadow, ShadowSttSession

if TYPE_CHECKING:  # pragma: no cover
    from .config import Config

logger = logging.getLogger(__name__)


def _enabled() -> bool:
    raw = os.environ.get("PREDICTOR_SHADOW_ENABLED", "")
    return raw.strip().lower() in ("1", "true", "yes", "on")


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


class ProcessShadowSttProvider:
    """Transparent provider wrapper used only when shadow mode is enabled."""

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
