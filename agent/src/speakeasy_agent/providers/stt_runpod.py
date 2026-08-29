"""Stage-1 self-hosted STT stub.

Intended target when concurrency justifies a rented GPU:
  * Hebrew: ivrit-ai/whisper-large-v3-turbo-ct2 pinned to git tag 2025.05.13
    (Apache-2.0, 1.62 GB) served with faster-whisper, `language='he'` ALWAYS
    pinned - the model card warns its language detection was degraded in
    training.
  * Russian: nvidia/nemotron-3.5-asr-streaming-0.6b (true cache-aware streaming;
    it does NOT support Hebrew, so the two languages need two models).
Exposed over RUNPOD_STT_URL.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import Lang, SttSession

if TYPE_CHECKING:  # pragma: no cover
    from ..config import Config

_MESSAGE = "runpod provider is a Stage-1 stub"


class RunpodSttProvider:
    name = "runpod"
    preferred_sample_rate = 16000
    preferred_num_channels = 1

    def __init__(self, cfg: "Config") -> None:
        self._url = cfg.runpod_stt_url

    async def start(self, *, lang: Lang) -> SttSession:
        raise NotImplementedError(_MESSAGE)

    async def aclose(self) -> None:
        return None
