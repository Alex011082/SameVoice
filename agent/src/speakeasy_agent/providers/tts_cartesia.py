"""Cartesia Sonic streaming TTS.

The model id is pinned to a dated snapshot via CARTESIA_MODEL, never the rolling
`sonic-3.5` id: Hebrew quality is the make-or-break axis of this product and it
must not change without a deploy.

Hebrew support is real despite what the installed plugin's type hints suggest:
`TTSLanguages` in `livekit/plugins/cartesia/models.py` lists seven languages and
neither `he` nor `ru` is among them. That Literal is stale and is never
enforced - the constructor parameter is `language: str | None` and the wire
value is taken verbatim. Cartesia's own model page for Sonic 3.5 lists 42
languages including `he` and `ru`. Do not "fix" this file to match the Literal.

Two things this file gets right that are one word away from being wrong:
  * `impl.stream()`, NOT `impl.synthesize()`. They read identically and are
    completely different transports: `synthesize()` is a one-shot POST to
    /tts/bytes, `stream()` is the pooled WebSocket. Batch TTS is named in the
    architecture's latency budget as a budget-breaker.
  * `word_timestamps=False`. The flag only reaches the wire (`add_timestamps`)
    on the STREAMING path, so it was harmless while we were on batch and becomes
    an unsupported-for-Hebrew request the moment streaming is switched on. We do
    not use word timings anywhere: subtitles carry whole committed units.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, AsyncIterator

from ..httpclient import shared_session
from .base import LANGS, Lang, ProviderError, TtsChunk

if TYPE_CHECKING:  # pragma: no cover
    from ..config import Config

logger = logging.getLogger(__name__)

_VOICE_ENV: dict[str, str] = {"ru": "CARTESIA_VOICE_RU", "he": "CARTESIA_VOICE_HE"}


class CartesiaTtsProvider:
    name = "cartesia"
    num_channels = 1

    @property
    def variant(self) -> str:
        # The voice ids belong here too: the same model with a different Hebrew
        # voice is a different thing to the ear judging the recording.
        voices = ",".join(f"{lang}={self._voices.get(lang, '')}" for lang in sorted(self._voices))
        return f"{self._cfg.cartesia_model}/{voices}"

    def __init__(self, cfg: "Config", *, sample_rate: int | None = None) -> None:
        if not cfg.cartesia_api_key:
            raise ProviderError(
                "TTS_PROVIDER=cartesia requires CARTESIA_API_KEY to be set in .env"
            )

        self._voices: dict[str, str] = {
            "ru": cfg.cartesia_voice_ru.strip(),
            "he": cfg.cartesia_voice_he.strip(),
        }
        # A blank voice does NOT mean "the default voice for this language" -
        # `voice` is a required field in Cartesia's API, so the plugin
        # substitutes its own hardcoded en-US female voice ("Katie") and the
        # male founder gets rendered into Hebrew by an American woman. Fail at
        # boot, where `_preflight` will print it, rather than mid-call.
        missing = [
            _VOICE_ENV[lang] for lang in LANGS if not self._voices.get(lang)
        ]
        if missing:
            raise ProviderError(
                "TTS_PROVIDER=cartesia requires a voice id per language: "
                f"{', '.join(missing)} is not set in .env. A blank value does NOT mean "
                "'default voice for that language' - it silently selects Cartesia's "
                "en-US voice for BOTH languages. Audition voices at play.cartesia.ai "
                "with the language set, and paste the voice UUIDs."
            )

        try:
            from livekit.plugins import cartesia
        except ImportError as exc:  # pragma: no cover - optional extra
            raise ProviderError(
                "livekit-plugins-cartesia is not installed. Run: uv sync --extra api"
            ) from exc

        self._cartesia = cartesia
        self._cfg = cfg
        self.sample_rate = sample_rate if sample_rate is not None else cfg.cartesia_sample_rate
        self._impls: dict[str, object] = {}

    def _impl_for(self, lang: Lang, voice: str | None):
        selected = (voice or self._voices.get(lang) or "").strip()
        if not selected:
            raise ProviderError(
                f"no Cartesia voice configured for {lang!r}; set {_VOICE_ENV.get(lang, 'the voice')}"
            )
        key = f"{lang}:{selected}"
        impl = self._impls.get(key)
        if impl is None:
            kwargs: dict[str, Any] = {
                "api_key": self._cfg.cartesia_api_key,
                "model": self._cfg.cartesia_model,
                "language": lang,
                "sample_rate": self.sample_rate,
                "voice": selected,
                # See the module docstring: mandatory once we are on stream().
                "word_timestamps": False,
                # Our agent is not an AgentServer job, so the plugin's implicit
                # `utils.http_context.http_session()` would raise. See
                # speakeasy_agent/httpclient.py.
                "http_session": shared_session(),
            }
            # UNVERIFIED: the plugin hardcodes Cartesia-Version 2025-04-16 while
            # current docs show 2026-08-14. Cartesia keeps dated versions working
            # and we could not read their versioning page (it requires login), so
            # the default is left alone and this is an override, not a guess.
            # Note it only affects the WebSocket path - the plugin's /tts/bytes
            # call sends its module constant regardless.
            api_version = self._cfg.cartesia_api_version.strip()
            if api_version:
                kwargs["api_version"] = api_version
            impl = self._cartesia.TTS(**kwargs)
            self._impls[key] = impl
            # Opens a WebSocket before the first unit needs one, so the first
            # thing anybody says does not pay connection setup on top of TTFB.
            try:
                impl.prewarm()
            except Exception as exc:  # pragma: no cover - best effort only
                logger.debug("cartesia prewarm skipped: %s", exc)
            logger.info(
                "cartesia TTS ready lang=%s model=%s voice=%s sample_rate=%d api_version=%s",
                lang,
                self._cfg.cartesia_model,
                selected,
                self.sample_rate,
                api_version or "plugin default",
            )
        return impl

    def synthesize(
        self, text: str, *, lang: Lang, voice: str | None = None
    ) -> AsyncIterator[TtsChunk]:
        return self._synthesize(text, lang, voice)

    async def _synthesize(
        self, text: str, lang: Lang, voice: str | None
    ) -> AsyncIterator[TtsChunk]:
        text = text.strip()
        if not text:
            return
        impl = self._impl_for(lang, voice)
        # One SynthesizeStream per unit: the plugin warns (and misbehaves) if a
        # single stream is reused for several segments. The expensive part - the
        # WebSocket - lives in the TTS object's connection pool, not here.
        stream = impl.stream()  # type: ignore[attr-defined]
        try:
            stream.push_text(text)
            stream.end_input()
            async for synthesized in stream:
                frame = synthesized.frame
                yield TtsChunk(
                    pcm=bytes(frame.data),
                    sample_rate=frame.sample_rate,
                    num_channels=frame.num_channels,
                    samples_per_channel=frame.samples_per_channel,
                )
        finally:
            # Barge-in cancels this generator mid-iteration; closing the stream
            # here is what stops Cartesia from continuing to bill for audio
            # nobody will hear.
            await stream.aclose()

    async def aclose(self) -> None:
        # Closes each TTS object's WebSocket pool. The shared aiohttp session is
        # process-owned and deliberately NOT closed here.
        for impl in self._impls.values():
            await impl.aclose()  # type: ignore[attr-defined]
        self._impls.clear()
