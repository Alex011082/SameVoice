"""Wire contract helpers for the local acoustic service.

Audio frames are mono signed-16-bit little-endian PCM at 16 kHz. Events are
small JSON objects matching the agent's existing SttEvent vocabulary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Lang = Literal["ru", "he"]
EventType = Literal["speech_start", "partial", "final", "speech_end", "error", "ready"]
SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 2


@dataclass(frozen=True)
class AcousticEvent:
    type: EventType
    text: str = ""
    lang: Lang | None = None
    start: float = 0.0
    end: float = 0.0
    confidence: float = 0.0
    engine: str = ""
    latency_ms: float | None = None

    def as_dict(self) -> dict[str, object]:
        data: dict[str, object] = {
            "type": self.type,
            "text": self.text,
            "start": round(float(self.start), 4),
            "end": round(float(self.end), 4),
            "confidence": round(float(self.confidence), 6),
        }
        if self.lang is not None:
            data["lang"] = self.lang
        if self.engine:
            data["engine"] = self.engine
        if self.latency_ms is not None:
            data["latency_ms"] = round(float(self.latency_ms), 3)
        return data


def validate_start_message(payload: object) -> tuple[Lang, int]:
    if not isinstance(payload, dict) or payload.get("type") != "start":
        raise ValueError("first websocket message must be a start object")
    lang = payload.get("lang")
    if lang not in ("ru", "he"):
        raise ValueError("lang must be 'ru' or 'he'")
    rate = payload.get("sample_rate", SAMPLE_RATE)
    if isinstance(rate, bool) or not isinstance(rate, int):
        raise ValueError("sample_rate must be an integer")
    if rate != SAMPLE_RATE:
        raise ValueError(f"acoustic service requires {SAMPLE_RATE} Hz PCM")
    channels = payload.get("channels", CHANNELS)
    if channels != CHANNELS:
        raise ValueError("acoustic service requires mono PCM")
    return lang, rate


def validate_pcm(payload: bytes) -> None:
    if len(payload) == 0:
        return
    if len(payload) % SAMPLE_WIDTH_BYTES:
        raise ValueError("PCM frame byte length must be even for s16le audio")
