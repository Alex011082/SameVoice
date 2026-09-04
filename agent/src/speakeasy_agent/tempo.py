"""Ускорение синтеза на лету: atempo без изменения высоты голоса.

Эксперимент 14 (01.09.2026) показал: перевод, ускоренный до 1.25x, влезает
в паузы речи 8 раз из 8, и на слух остаётся собой — высота не плывёт,
только темп. Ручка скорости самой Cartesia сломана (проверено там же),
поэтому темп правим сами, ffmpeg-фильтром atempo, потоково: чанк за чанком
через долгоживущий процесс на одну реплику.

Выключено по умолчанию (tempo 1.0 — модуль просто пропускает поток через
себя без ffmpeg): включается через SV_TTS_TEMPO, откатывается мгновенно.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass

logger = logging.getLogger(__name__)

_FFMPEG_TIMEOUT_S = 10.0


@dataclass
class PcmChunk:
    pcm: bytes
    sample_rate: int


async def stretch_stream(
    chunks: AsyncIterator[PcmChunk],
    tempo: float,
) -> AsyncIterator[PcmChunk]:
    """Пропустить поток s16le-моно через atempo.

    При tempo ~1.0 поток отдаётся как есть. При сбое ffmpeg реплика доигрывает
    в обычном темпе: скорость — украшение, падать из-за неё нельзя.
    """
    if abs(tempo - 1.0) < 1e-3:
        async for chunk in chunks:
            yield chunk
        return

    proc: asyncio.subprocess.Process | None = None
    rate = 0
    try:
        async for chunk in chunks:
            if proc is None:
                rate = chunk.sample_rate
                proc = await asyncio.create_subprocess_exec(
                    "ffmpeg", "-hide_banner", "-loglevel", "error",
                    "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
                    "-filter:a", f"atempo={tempo}",
                    "-f", "s16le", "-ar", str(rate), "-ac", "1", "pipe:1",
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write(chunk.pcm)
            await proc.stdin.drain()
            # Забираем всё, что фильтр уже готов отдать, не дожидаясь конца
            # реплики — первый звук не должен ждать последнего слова.
            while True:
                try:
                    out = await asyncio.wait_for(proc.stdout.read(4096), timeout=0.001)
                except asyncio.TimeoutError:
                    break
                if not out:
                    break
                yield PcmChunk(out, rate)
        if proc is not None:
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.close()
            while True:
                out = await asyncio.wait_for(proc.stdout.read(4096), timeout=_FFMPEG_TIMEOUT_S)
                if not out:
                    break
                yield PcmChunk(out, rate)
    except FileNotFoundError:
        # ffmpeg отсутствует: честно предупредить один раз и играть как есть
        logger.warning("tempo: ffmpeg не найден — реплика идёт в обычном темпе")
        async for chunk in chunks:
            yield chunk
    except Exception as exc:  # pragma: no cover - защитный путь
        logger.warning("tempo: сбой ускорения (%s) — доигрываю без него", exc)
        async for chunk in chunks:
            yield chunk
    finally:
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
