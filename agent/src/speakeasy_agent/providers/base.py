"""The STT / MT / TTS provider contract.

No vendor imports may ever appear in this module: it is imported by the mock
providers, which must work with zero credentials and zero optional packages.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import AsyncIterator, Literal, Mapping, Protocol, Sequence, runtime_checkable

from livekit import rtc

Lang = Literal["ru", "he"]
Gender = Literal["m", "f", "u"]
Tone = Literal["neutral", "friendly", "formal"]

LANGS: tuple[str, ...] = ("ru", "he")
GENDERS: tuple[str, ...] = ("m", "f", "u")
TONES: tuple[str, ...] = ("neutral", "friendly", "formal")


@dataclass(frozen=True)
class Speaker:
    user_id: str
    display_name: str
    lang: Lang
    gender: Gender
    tone: Tone


# --------------------------------------------------------------------------- STT


@dataclass(frozen=True)
class SttEvent:
    type: Literal["speech_start", "partial", "final", "speech_end"]
    text: str
    lang: Lang
    start: float
    end: float
    confidence: float = 0.0


@runtime_checkable
class SttSession(Protocol):
    def push_frame(self, frame: rtc.AudioFrame) -> None: ...

    async def flush(self) -> None: ...

    def __aiter__(self) -> AsyncIterator[SttEvent]: ...

    async def aclose(self) -> None: ...


@runtime_checkable
class SttProvider(Protocol):
    name: str
    preferred_sample_rate: int
    preferred_num_channels: int

    async def start(self, *, lang: Lang) -> SttSession: ...

    async def aclose(self) -> None: ...


# --------------------------------------------------------------------------- MT


@dataclass(frozen=True)
class MtRequest:
    text: str
    src_lang: Lang
    dst_lang: Lang
    speaker: Speaker
    listener: Speaker
    is_continuation: bool
    history: Sequence[tuple[str, str]] = ()
    glossary: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class MtResult:
    text: str
    provider: str
    latency_ms: float


@runtime_checkable
class MtProvider(Protocol):
    name: str

    async def translate(self, req: MtRequest) -> MtResult: ...

    async def aclose(self) -> None: ...


# --------------------------------------------------------------------------- TTS


@dataclass(frozen=True)
class TtsChunk:
    pcm: bytes
    sample_rate: int
    num_channels: int
    samples_per_channel: int


@runtime_checkable
class TtsProvider(Protocol):
    name: str
    sample_rate: int
    num_channels: int

    def synthesize(
        self, text: str, *, lang: Lang, voice: str | None = None
    ) -> AsyncIterator[TtsChunk]: ...

    async def aclose(self) -> None: ...


def provider_id(provider: object) -> str:
    """`name` plus the concrete model/voice behind it, for the eval log.

    Two A/B runs that differ only by model id are otherwise byte-identical in
    the log, which makes the judge's verdicts unattributable. Adapters expose
    the detail through an optional `variant` attribute; anything without one
    degrades to its bare name.
    """
    name = str(getattr(provider, "name", "?"))
    variant = getattr(provider, "variant", None)
    text = str(variant).strip() if variant else ""
    return f"{name}:{text}" if text else name


class ProviderError(RuntimeError):
    """Raised by a provider adapter when the upstream service fails."""
