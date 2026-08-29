"""Deterministic mock STT.

MECHANICS ONLY. This adapter invents its transcripts from a fixture list; it
does not listen. Never use it to judge recognition quality or UX - its only job
is to exercise the VAD gate, the partial-vs-final contract, chunk cadence,
backpressure and TTS cancellation with zero credentials and zero GPU.

Cadence is driven by *audio time consumed*, not by wall clock, so the same
sequence of frames always produces the same sequence of events regardless of
how fast the caller feeds them.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import AsyncIterator

from livekit import rtc

from ..audio import frame_rms
from .base import Lang, SttEvent

_SENTINEL = object()

DEFAULT_GATE_RMS = 0.02
DEFAULT_WORD_INTERVAL_S = 0.22
DEFAULT_TAIL_SILENCE_S = 0.4


FIXTURES_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "mock_phrases.json"


def load_fixtures() -> dict:
    return json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))


def fixture_phrases(lang: Lang) -> list[str]:
    data = load_fixtures()
    entries = data.get(lang) or []
    return [entry["src"] for entry in entries]


class MockSttSession:
    def __init__(
        self,
        *,
        lang: Lang,
        phrases: list[str],
        gate_rms: float = DEFAULT_GATE_RMS,
        word_interval_s: float = DEFAULT_WORD_INTERVAL_S,
        tail_silence_s: float = DEFAULT_TAIL_SILENCE_S,
    ) -> None:
        if not phrases:
            raise ValueError(f"no mock phrases available for language {lang!r}")
        self._lang: Lang = lang
        self._phrases = phrases
        self._gate = gate_rms
        self._word_interval = word_interval_s
        self._tail_silence = tail_silence_s

        self._queue: asyncio.Queue = asyncio.Queue()
        self._phrase_idx = 0
        self._words: list[str] = phrases[0].split()
        self._audio_clock = 0.0
        self._utt_start = 0.0
        self._voiced_s = 0.0
        self._silence_s = 0.0
        self._speaking = False
        self._emitted = 0
        self._closed = False

    # ---------------------------------------------------------------- input

    def push_frame(self, frame: rtc.AudioFrame) -> None:
        if self._closed:
            return
        if frame.sample_rate <= 0 or frame.samples_per_channel <= 0:
            return
        duration = frame.samples_per_channel / float(frame.sample_rate)
        self._audio_clock += duration

        if frame_rms(frame) >= self._gate:
            self._on_voiced(duration)
        else:
            self._on_silence(duration)

    async def flush(self) -> None:
        if self._speaking:
            self._finish_utterance()

    async def aclose(self) -> None:
        if self._closed:
            return
        if self._speaking:
            self._finish_utterance()
        self._closed = True
        self._queue.put_nowait(_SENTINEL)

    def __aiter__(self) -> AsyncIterator[SttEvent]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[SttEvent]:
        while True:
            item = await self._queue.get()
            if item is _SENTINEL:
                return
            yield item  # type: ignore[misc]

    # ------------------------------------------------------------- internal

    def _on_voiced(self, duration: float) -> None:
        self._silence_s = 0.0
        if not self._speaking:
            self._speaking = True
            self._utt_start = max(0.0, self._audio_clock - duration)
            self._voiced_s = 0.0
            self._emitted = 0
            self._words = self._phrases[self._phrase_idx].split()
            self._emit("speech_start", "")
        self._voiced_s += duration

        while (
            self._emitted < len(self._words)
            and self._voiced_s >= (self._emitted + 1) * self._word_interval
        ):
            self._emitted += 1
            self._emit("partial", " ".join(self._words[: self._emitted]))

        if (
            self._emitted >= len(self._words)
            and self._voiced_s >= (len(self._words) + 1) * self._word_interval
        ):
            self._finish_utterance()

    def _on_silence(self, duration: float) -> None:
        if not self._speaking:
            return
        self._silence_s += duration
        if self._silence_s >= self._tail_silence:
            self._finish_utterance()

    def _finish_utterance(self) -> None:
        if not self._speaking:
            return
        self._speaking = False
        if self._emitted > 0:
            self._emit("final", " ".join(self._words[: self._emitted]))
        self._emit("speech_end", "")
        self._phrase_idx = (self._phrase_idx + 1) % len(self._phrases)
        self._voiced_s = 0.0
        self._silence_s = 0.0
        self._emitted = 0

    def _emit(self, kind: str, text: str) -> None:
        self._queue.put_nowait(
            SttEvent(
                type=kind,  # type: ignore[arg-type]
                text=text,
                lang=self._lang,
                start=round(self._utt_start, 3),
                end=round(self._audio_clock, 3),
                confidence=0.99 if kind == "final" else 0.5,
            )
        )


class MockSttProvider:
    name = "mock"
    preferred_sample_rate = 16000
    preferred_num_channels = 1

    def __init__(
        self,
        *,
        phrases: dict[str, list[str]] | None = None,
        gate_rms: float = DEFAULT_GATE_RMS,
        word_interval_s: float = DEFAULT_WORD_INTERVAL_S,
        tail_silence_s: float = DEFAULT_TAIL_SILENCE_S,
    ) -> None:
        self._phrases = phrases
        self._gate_rms = gate_rms
        self._word_interval_s = word_interval_s
        self._tail_silence_s = tail_silence_s
        self._sessions: list[MockSttSession] = []

    async def start(self, *, lang: Lang) -> MockSttSession:
        phrases = (self._phrases or {}).get(lang) or fixture_phrases(lang)
        session = MockSttSession(
            lang=lang,
            phrases=phrases,
            gate_rms=self._gate_rms,
            word_interval_s=self._word_interval_s,
            tail_silence_s=self._tail_silence_s,
        )
        self._sessions.append(session)
        return session

    async def aclose(self) -> None:
        for session in self._sessions:
            await session.aclose()
        self._sessions.clear()
