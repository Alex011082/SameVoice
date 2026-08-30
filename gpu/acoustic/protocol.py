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
    # One rule holds for both engines: latency_ms is anchored *before* that
    # engine's wait for its lock and therefore already contains it, so
    # queue_wait_ms is a breakdown of latency_ms and must never be added to it.
    # ru: anchored in `NemotronUtterance.__init__`, wait computed in
    #     `_start_model.run_model` on `_generate_lock`.
    # he: anchored in `HebrewWhisperEngine.transcribe`, wait computed on the
    #     engine's own `_lock`.
    # Both waits used to be discarded, which left the published number
    # impossible to split into model or queue afterwards
    # (docs/12-latency-timestamps.md, docs/RUNPOD_READINESS.md:36).
    #
    # What the remainder means is NOT the same in the two languages, and no
    # consumer can tell them apart without also reading `engine`:
    # he: `latency_ms - queue_wait_ms` is model time exactly.
    # ru: the anchor is the utterance constructor, not the start of the forward
    #     pass, so the remainder also contains the time spent feeding audio. It
    #     is an upper bound on model time, not model time.
    queue_wait_ms: float | None = None

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
        if self.queue_wait_ms is not None:
            data["queue_wait_ms"] = round(float(self.queue_wait_ms), 3)
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
