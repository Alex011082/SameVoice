"""Deepgram Nova-3 streaming STT.

Nova-3 is the only 1.7.0-verified plugin with BOTH Hebrew and Russian in true
streaming. Deepgram Flux is deliberately NOT used: it supports neither language.

Note on the installed plugin's type hints: `DeepgramLanguages` in
`livekit/plugins/deepgram/models.py` does NOT list `he`. That Literal is stale -
the parameter is declared `DeepgramLanguages | str` and the plugin wraps the
value in a non-validating `LanguageCode`, while Deepgram's own launch post for
Hebrew on Nova-3 documents `model=nova-3&language=he` in streaming. Do not
"fix" this file to match the Literal.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, AsyncIterator

from livekit import rtc
from livekit.agents import stt as agent_stt

from ..httpclient import shared_session
from .base import Lang, ProviderError, SttEvent

logger = logging.getLogger(__name__)

if TYPE_CHECKING:  # pragma: no cover
    from ..config import Config

_EVENT_MAP: dict[str, str] = {
    agent_stt.SpeechEventType.START_OF_SPEECH.value: "speech_start",
    agent_stt.SpeechEventType.INTERIM_TRANSCRIPT.value: "partial",
    agent_stt.SpeechEventType.PREFLIGHT_TRANSCRIPT.value: "partial",
    agent_stt.SpeechEventType.FINAL_TRANSCRIPT.value: "final",
    agent_stt.SpeechEventType.END_OF_SPEECH.value: "speech_end",
}


class DeepgramSttSession:
    def __init__(self, stream: agent_stt.RecognizeStream, lang: Lang) -> None:
        self._stream = stream
        self._lang: Lang = lang
        self._closed = False

    def push_frame(self, frame: rtc.AudioFrame) -> None:
        if self._closed:
            return
        self._stream.push_frame(frame)

    async def flush(self) -> None:
        if not self._closed:
            self._stream.flush()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._stream.aclose()

    def __aiter__(self) -> AsyncIterator[SttEvent]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[SttEvent]:
        async for event in self._stream:
            mapped = _EVENT_MAP.get(event.type.value)
            if mapped is None:
                continue
            alt = event.alternatives[0] if event.alternatives else None
            text = alt.text if alt is not None else ""
            if mapped in ("partial", "final") and not text.strip():
                continue
            yield SttEvent(
                type=mapped,  # type: ignore[arg-type]
                text=text,
                lang=self._lang,
                start=alt.start_time if alt is not None else 0.0,
                end=alt.end_time if alt is not None else 0.0,
                confidence=alt.confidence if alt is not None else 0.0,
            )


class DeepgramSttProvider:
    name = "deepgram"
    preferred_sample_rate = 16000
    preferred_num_channels = 1

    @property
    def variant(self) -> str:
        return self._cfg.deepgram_model

    def __init__(self, cfg: "Config") -> None:
        if not cfg.deepgram_api_key:
            raise ProviderError(
                "STT_PROVIDER=deepgram requires DEEPGRAM_API_KEY to be set in .env"
            )
        try:
            from livekit.plugins import deepgram
        except ImportError as exc:  # pragma: no cover - optional extra
            raise ProviderError(
                "livekit-plugins-deepgram is not installed. Run: uv sync --extra api"
            ) from exc

        self._deepgram = deepgram
        self._cfg = cfg
        self._impls: dict[str, object] = {}
        self._lock = asyncio.Lock()

    @property
    def endpointing_ms(self) -> int:
        """0 in config means "follow the chunker". Deepgram finalizing far
        earlier than CHUNK_MAX_SILENCE_MS just produces two-word finals that our
        chunker immediately re-aggregates - and every extra final is an extra
        MT call."""
        configured = self._cfg.deepgram_endpointing_ms
        return configured if configured > 0 else self._cfg.chunk_max_silence_ms

    def _impl_for(self, lang: Lang) -> agent_stt.STT:
        impl = self._impls.get(lang)
        if impl is None:
            impl = self._deepgram.STT(
                model=self._cfg.deepgram_model,
                language=lang,
                interim_results=True,
                # The plugin parameter is `endpointing_ms`, not `endpointing`.
                endpointing_ms=self.endpointing_ms,
                sample_rate=self.preferred_sample_rate,
                api_key=self._cfg.deepgram_api_key,
                # Region matters here more than any other single setting: the
                # plugin's US default measured 233 ms from Israel against 84 ms
                # for the EU endpoint, and this leg is serial in the media path.
                base_url=self._cfg.deepgram_base_url,
                # Explicit even though the plugin default is already True:
                # chunker.py's clause-boundary commit policy depends on
                # punctuation existing, and that dependency must not live in a
                # vendor default that could change under us.
                punctuate=True,
                # The plugin defaults this to True to help ITS turn detector,
                # which we do not use. Left on, every "эээ" / "אמ" is
                # transcribed, translated, billed and then SPOKEN at the other
                # person - the relay sounds drunk and the MT bill goes up.
                filler_words=False,
                # Model Improvement Program off: two real people are having a
                # real private conversation. Also switch it off in the Deepgram
                # console - the console setting is the stronger guarantee, and
                # on some plan tiers this flag alone may not be honoured.
                mip_opt_out=True,
                # Our agent is not an AgentServer job, so the plugin's implicit
                # `utils.http_context.http_session()` would raise. See
                # speakeasy_agent/httpclient.py.
                http_session=shared_session(),
            )
            self._impls[lang] = impl
            logger.info(
                "deepgram STT ready lang=%s model=%s endpointing_ms=%d filler_words=off mip_opt_out=on",
                lang,
                self._cfg.deepgram_model,
                self.endpointing_ms,
            )
        return impl  # type: ignore[return-value]

    async def start(self, *, lang: Lang) -> DeepgramSttSession:
        async with self._lock:
            impl = self._impl_for(lang)
        return DeepgramSttSession(impl.stream(language=lang), lang)

    async def aclose(self) -> None:
        # NOTE: `STT.aclose()` is a no-op in livekit-agents 1.7.0 (the Deepgram
        # plugin does not override the empty base implementation). It is still
        # called for forward compatibility, but the thing that actually closes
        # the sockets is `DeepgramSttSession.aclose()` per direction. The shared
        # aiohttp session is process-owned and deliberately NOT closed here.
        for impl in self._impls.values():
            await impl.aclose()  # type: ignore[attr-defined]
        self._impls.clear()
