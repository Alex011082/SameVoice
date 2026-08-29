"""Stage-1 self-hosted MT stub.

Intended target: dicta-il/DictaLM-3.0-Nemotron-12B-Instruct-W4A16 on vLLM
(~7-8 GB, leaving room for STT and TTS on one 24 GB card) behind an
OpenAI-compatible /v1/chat/completions at RUNPOD_MT_URL, so the Gemini
adapter's prompt-building logic ports across with minimal change. Never use the
`-Thinking` variants: reasoning tokens destroy the latency budget.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import MtRequest, MtResult

if TYPE_CHECKING:  # pragma: no cover
    from ..config import Config

_MESSAGE = "runpod provider is a Stage-1 stub"


class RunpodMtProvider:
    name = "runpod"

    def __init__(self, cfg: "Config") -> None:
        self._url = cfg.runpod_mt_url

    async def translate(self, req: MtRequest) -> MtResult:
        raise NotImplementedError(_MESSAGE)

    async def aclose(self) -> None:
        return None
