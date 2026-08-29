"""Speech-like mock TTS.

MECHANICS ONLY. This is an amplitude-modulated carrier tone, not speech; it
exists so the whole audio path (framing, resampling seam, AudioSource queueing,
barge-in cancellation) is genuinely exercised offline. Never judge voice
quality or UX from it.

It is emitted in real wall-clock time so that cancelling mid-utterance actually
cuts audio short, which is the only way barge-in becomes testable.
"""

from __future__ import annotations

import asyncio
import math
import time
from typing import AsyncIterator

from ..audio import BYTES_PER_SAMPLE, OUTPUT_SAMPLE_RATE
from .base import Lang, TtsChunk

CHUNK_MS = 20
SYLLABLE_RATE_HZ = 4.5
SECONDS_PER_CHAR = 0.06
MAX_DURATION_S = 8.0
MIN_DURATION_S = 0.2

# Distinct carriers so the two directions are audibly different in a live test.
CARRIER_HZ: dict[str, float] = {"ru": 140.0, "he": 190.0}
DEFAULT_CARRIER_HZ = 165.0


def _duration_for(text: str) -> float:
    return max(MIN_DURATION_S, min(MAX_DURATION_S, len(text) * SECONDS_PER_CHAR))


class MockTtsProvider:
    name = "mock"
    sample_rate = OUTPUT_SAMPLE_RATE
    num_channels = 1

    def __init__(self, *, realtime: bool = True, ttfb_s: float = 0.04) -> None:
        self._realtime = realtime
        # Simulated time-to-first-byte so the latency instrumentation reports a
        # plausible shape rather than an impossible zero.
        self._ttfb_s = ttfb_s

    def synthesize(
        self, text: str, *, lang: Lang, voice: str | None = None
    ) -> AsyncIterator[TtsChunk]:
        return self._synthesize(text, lang)

    async def _synthesize(self, text: str, lang: Lang) -> AsyncIterator[TtsChunk]:
        text = text.strip()
        if not text:
            return

        carrier = CARRIER_HZ.get(lang, DEFAULT_CARRIER_HZ)
        total_s = _duration_for(text)
        samples_per_chunk = self.sample_rate * CHUNK_MS // 1000
        total_chunks = max(1, int(round(total_s * 1000.0 / CHUNK_MS)))

        step = 2.0 * math.pi * carrier / self.sample_rate
        mod_step = 2.0 * math.pi * SYLLABLE_RATE_HZ / self.sample_rate
        n = 0
        if self._ttfb_s > 0:
            await asyncio.sleep(self._ttfb_s)
        started = time.perf_counter()

        for chunk_index in range(total_chunks):
            buf = bytearray(samples_per_chunk * BYTES_PER_SAMPLE)
            for i in range(samples_per_chunk):
                # Syllable envelope, plus a short fade at both ends so the tone
                # does not click when it is cut off by a barge-in.
                envelope = 0.35 + 0.65 * (0.5 * (1.0 - math.cos(mod_step * n)))
                progress = chunk_index / total_chunks
                if progress < 0.02:
                    envelope *= progress / 0.02
                elif progress > 0.98:
                    envelope *= (1.0 - progress) / 0.02
                value = int(26000 * envelope * math.sin(step * n))
                value = max(-32768, min(32767, value))
                buf[i * 2] = value & 0xFF
                buf[i * 2 + 1] = (value >> 8) & 0xFF
                n += 1

            yield TtsChunk(
                pcm=bytes(buf),
                sample_rate=self.sample_rate,
                num_channels=self.num_channels,
                samples_per_channel=samples_per_chunk,
            )

            if self._realtime:
                target = started + (chunk_index + 1) * CHUNK_MS / 1000.0
                delay = target - time.perf_counter()
                if delay > 0:
                    await asyncio.sleep(delay)
                else:
                    await asyncio.sleep(0)
            else:
                await asyncio.sleep(0)

    async def aclose(self) -> None:
        return None
