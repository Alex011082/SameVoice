"""Stage-1 self-hosted TTS stub.

Intended target: Chatterbox Multilingual (MIT licence, covers both Hebrew and
Russian, zero-shot voice cloning) at RUNPOD_TTS_URL. Note that every Chatterbox
output carries a Resemble Perth watermark that survives MP3 compression - a
feature for synthetic-media marking, but it means clean audio is not available
from this path.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, AsyncIterator

from .base import Lang, TtsChunk

if TYPE_CHECKING:  # pragma: no cover
    from ..config import Config

_MESSAGE = "runpod provider is a Stage-1 stub"


class RunpodTtsProvider:
    name = "runpod"
    sample_rate = 24000
    num_channels = 1

    def __init__(self, cfg: "Config") -> None:
        self._url = cfg.runpod_tts_url

    def synthesize(
        self, text: str, *, lang: Lang, voice: str | None = None
    ) -> AsyncIterator[TtsChunk]:
        raise NotImplementedError(_MESSAGE)

    async def aclose(self) -> None:
        return None
