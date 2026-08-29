"""Provider registry.

Imports live inside each branch so a mock-only install stays lean and a missing
optional plugin only fails when that provider is explicitly selected.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import (
    Gender,
    Lang,
    MtProvider,
    MtRequest,
    MtResult,
    ProviderError,
    Speaker,
    SttEvent,
    SttProvider,
    SttSession,
    Tone,
    TtsChunk,
    TtsProvider,
)

if TYPE_CHECKING:  # pragma: no cover
    from ..config import Config

STT_PROVIDERS = ("mock", "deepgram", "runpod")
MT_PROVIDERS = ("mock", "gemini", "openai", "runpod")
TTS_PROVIDERS = ("mock", "cartesia", "runpod")

__all__ = [
    "Gender",
    "Lang",
    "MtProvider",
    "MtRequest",
    "MtResult",
    "ProviderError",
    "Speaker",
    "SttEvent",
    "SttProvider",
    "SttSession",
    "Tone",
    "TtsChunk",
    "TtsProvider",
    "STT_PROVIDERS",
    "MT_PROVIDERS",
    "TTS_PROVIDERS",
    "build_stt",
    "build_mt",
    "build_tts",
]


def build_stt(name: str, cfg: "Config") -> SttProvider:
    key = name.strip().lower()
    provider: SttProvider
    if key == "mock":
        from .stt_mock import MockSttProvider

        provider = MockSttProvider()
    elif key == "deepgram":
        from .stt_deepgram import DeepgramSttProvider

        provider = DeepgramSttProvider(cfg)
    elif key == "runpod":
        from .stt_runpod import RunpodSttProvider

        provider = RunpodSttProvider(cfg)
    else:
        raise ValueError(f"unknown STT provider {name!r}; valid: {', '.join(STT_PROVIDERS)}")

    # Predictor shadow mode wraps the selected recognizer without changing its
    # emitted STT events or provider identity. With the flag off this is exactly
    # the original provider object.
    from ..speculation_provider import maybe_wrap_stt

    return maybe_wrap_stt(provider, cfg)


def build_mt(name: str, cfg: "Config") -> MtProvider:
    key = name.strip().lower()
    if key == "mock":
        from .mt_mock import MockMtProvider

        return MockMtProvider()
    if key == "gemini":
        from .mt_gemini import GeminiMtProvider

        return GeminiMtProvider(cfg)
    if key == "openai":
        from .mt_openai import OpenAiMtProvider

        return OpenAiMtProvider(cfg)
    if key == "runpod":
        from .mt_runpod import RunpodMtProvider

        return RunpodMtProvider(cfg)
    raise ValueError(f"unknown MT provider {name!r}; valid: {', '.join(MT_PROVIDERS)}")


def build_tts(name: str, cfg: "Config") -> TtsProvider:
    key = name.strip().lower()
    if key == "mock":
        from .tts_mock import MockTtsProvider

        return MockTtsProvider()
    if key == "cartesia":
        from .tts_cartesia import CartesiaTtsProvider

        return CartesiaTtsProvider(cfg)
    if key == "runpod":
        from .tts_runpod import RunpodTtsProvider

        return RunpodTtsProvider(cfg)
    raise ValueError(f"unknown TTS provider {name!r}; valid: {', '.join(TTS_PROVIDERS)}")
