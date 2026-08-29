"""HTTP adapter for the colocated SameVoice local TTS A/B service.

The first local service is intentionally batch-only. It yields PCM chunks only
after the server has finished generating the waveform, so it is useful for
quality/cost experiments but is not allowed to masquerade as the final low-TTFA
streaming path.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, AsyncIterator

import aiohttp

from ..httpclient import shared_session
from .base import Lang, ProviderError, TtsChunk

if TYPE_CHECKING:
    from ..config import Config


class RunpodTtsProvider:
    name = "runpod"
    num_channels = 1

    def __init__(self, cfg: "Config") -> None:
        base = cfg.runpod_tts_url.strip().rstrip("/")
        self._url = (base if base.endswith("/v1/synthesize") else base + "/v1/synthesize") if base else ""
        self.sample_rate = 24000
        self._variant = "local-tts-ab"
        self._timeout = aiohttp.ClientTimeout(total=30.0, sock_connect=1.0)
        self.last_server_latency_ms: float | None = None
        self.last_server_load_ms: float | None = None
        self.streaming = False
        self.watermarked: bool | None = None

    @property
    def variant(self) -> str:
        return self._variant

    def synthesize(
        self, text: str, *, lang: Lang, voice: str | None = None
    ) -> AsyncIterator[TtsChunk]:
        if not self._url:
            raise NotImplementedError(
                "runpod provider is a Stage-1 stub until RUNPOD_TTS_URL or LOCAL_TTS_URL is configured"
            )
        return self._synthesize(text, lang=lang, voice=voice)

    async def _synthesize(
        self, text: str, *, lang: Lang, voice: str | None
    ) -> AsyncIterator[TtsChunk]:
        normalized = text.strip()
        if not normalized:
            return
        payload: dict[str, object] = {"text": normalized, "lang": lang}
        if voice:
            payload["voice_id"] = voice

        try:
            async with shared_session().post(
                self._url,
                json=payload,
                timeout=self._timeout,
            ) as response:
                if response.status != 200:
                    detail = (await response.text())[:1000]
                    raise ProviderError(f"local TTS HTTP {response.status}: {detail}")
                pcm = await response.read()
                headers = response.headers
        except ProviderError:
            raise
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise ProviderError(f"local TTS request failed: {exc}") from exc

        if not pcm or len(pcm) % 2:
            raise ProviderError("local TTS returned invalid s16le PCM")
        try:
            sample_rate = int(headers.get("X-SameVoice-Sample-Rate", "24000"))
        except ValueError as exc:
            raise ProviderError("local TTS returned invalid sample rate") from exc
        if sample_rate <= 0:
            raise ProviderError("local TTS returned non-positive sample rate")

        self.sample_rate = sample_rate
        model = headers.get("X-SameVoice-Model", "").strip()
        if model:
            self._variant = model
        self.last_server_latency_ms = _header_float(headers.get("X-SameVoice-Latency-Ms"))
        self.last_server_load_ms = _header_float(headers.get("X-SameVoice-Load-Ms"))
        self.streaming = headers.get("X-SameVoice-Streaming", "false").lower() == "true"
        watermarked = headers.get("X-SameVoice-Watermarked")
        if watermarked is not None:
            self.watermarked = watermarked.lower() == "true"

        # Keep chunk boundaries small for the existing resampler/framer even
        # though the server response itself was batch. 20 ms of mono int16.
        samples_per_chunk = max(1, sample_rate // 50)
        bytes_per_chunk = samples_per_chunk * 2
        for offset in range(0, len(pcm), bytes_per_chunk):
            part = pcm[offset : offset + bytes_per_chunk]
            if not part:
                continue
            yield TtsChunk(
                pcm=part,
                sample_rate=sample_rate,
                num_channels=1,
                samples_per_channel=len(part) // 2,
            )

    async def aclose(self) -> None:
        return None


def _header_float(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None
