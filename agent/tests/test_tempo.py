"""Ускоритель темпа: 1.0 — прозрачный путь; 1.25 укорачивает звук ~на 20%."""
import asyncio
import math
import shutil
import struct

import pytest

from speakeasy_agent.tempo import PcmChunk, stretch_stream


def _sine_pcm(seconds: float, rate: int = 24000) -> bytes:
    n = int(seconds * rate)
    return b"".join(
        struct.pack("<h", int(12000 * math.sin(2 * math.pi * 220 * i / rate)))
        for i in range(n)
    )


async def _run(tempo: float, pcm: bytes, rate: int = 24000) -> bytes:
    async def chunks():
        step = rate // 10 * 2
        for i in range(0, len(pcm), step):
            yield PcmChunk(pcm[i : i + step], rate)

    out = b""
    async for chunk in stretch_stream(chunks(), tempo):
        out += chunk.pcm
    return out


def test_unity_tempo_is_passthrough():
    pcm = _sine_pcm(0.5)
    out = asyncio.run(_run(1.0, pcm))
    assert out == pcm


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нет ffmpeg")
def test_125_shortens_by_fifth():
    pcm = _sine_pcm(1.0)
    out = asyncio.run(_run(1.25, pcm))
    ratio = len(out) / len(pcm)
    assert 0.74 <= ratio <= 0.86, ratio
