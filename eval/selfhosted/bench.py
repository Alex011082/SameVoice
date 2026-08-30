"""Замер сквозной задержки связки WhisperLiveKit + VoxCPM2.

Отвечает на вопрос, ради которого арендуется GPU: **укладывается ли свой стек
в две секунды**, где облачная цепочка даёт четыре.

ЧТО ИМЕННО МЕРЯЕТСЯ И ПОЧЕМУ ТАК

Звук подаётся в РЕАЛЬНОМ ВРЕМЕНИ — чанками по 100 мс с настоящими паузами.
Залить файл целиком было бы бессмысленно: модель получит всю фразу мгновенно и
покажет задержку, которой в живом разговоре никогда не будет. Ровно эту ошибку
легко сделать и потом радоваться цифре, которая ничего не значит.

Главное число — `speech_start_to_first_audio_ms`: от момента, когда человек
начал говорить, до первого байта переведённого звука. Оно сравнимо с тем, что
пишет наш агент в eval-лог (§10 docs/07-product-spec.md), где сейчас медиана
4045 мс.

ГЛАВНЫЙ ПОДОЗРЕВАЕМЫЙ, КОТОРЫЙ ЗДЕСЬ ПРОВЕРЯЕТСЯ

Потоковый API VoxCPM2 принимает текст ЦЕЛИКОМ (`generate_streaming(text: str)`):
звук отдаёт потоком, но на вход берёт готовую строку. Значит каждый
закоммиченный кусок перевода платит за свой prefill заново, и это прямо
противоречит инкрементальности WhisperLiveKit. Поэтому синтез меряется отдельно
и в двух режимах: последовательно и с перекрытием (prefill следующего куска
идёт, пока звучит текущий) — разница между ними и есть цена этой занозы.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import subprocess
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

CHUNK_MS = 100
IN_RATE = 16000


def pcm16(path: Path, rate: int) -> bytes:
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le",
         "-acodec", "pcm_s16le", "-ac", "1", "-ar", str(rate), "-"],
        capture_output=True, check=True,
    ).stdout


@dataclass
class Stage:
    """Замеры одной стадии. Держим все значения, а не только среднее: в живом
    звонке рвёт хвост, а не медиана."""
    name: str
    samples: list[float] = field(default_factory=list)

    def add(self, ms: float) -> None:
        self.samples.append(ms)

    def report(self) -> str:
        if not self.samples:
            return f"{self.name:38s} — нет данных"
        s = sorted(self.samples)
        p90 = s[min(len(s) - 1, int(len(s) * 0.9))]
        return (f"{self.name:38s} медиана {statistics.median(s):6.0f} мс  "
                f"p90 {p90:6.0f}  худшая {s[-1]:6.0f}  (n={len(s)})")


# --------------------------------------------------------------- синтез

def bench_tts(text_chunks: list[str], overlap: bool) -> tuple[Stage, float]:
    """Время до первого звука на каждый кусок.

    overlap=False — куски синтезируются по очереди, как получится «в лоб».
    overlap=True  — prefill следующего куска запускается, пока звучит текущий.
                    Именно так prefill прячется за уже играющим звуком; если
                    выигрыш заметный, значит заноза лечится инженерией, а не
                    сменой модели.
    """
    from concurrent.futures import ThreadPoolExecutor
    from voxcpm import VoxCPM

    # Шумодав отключён: он тянет modelscope, который конфликтует с
    # transformers в образе RunPod, и на замер задержки не влияет.
    model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
    stage = Stage("синтез: до первого звука" + (" (с перекрытием)" if overlap else " (последовательно)"))
    audio_total = 0.0

    def first_chunk(text: str) -> tuple[float, float]:
        t0 = time.perf_counter()
        first_at = None
        n = 0
        for piece in model.generate_streaming(text=text, language="he"):
            if first_at is None:
                first_at = (time.perf_counter() - t0) * 1000.0
            n += len(piece)
        return first_at or 0.0, n / 2 / 24000.0

    if not overlap:
        for t in text_chunks:
            ms, dur = first_chunk(t)
            stage.add(ms)
            audio_total += dur
    else:
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(first_chunk, text_chunks[0])
            for nxt in text_chunks[1:] + [None]:
                ms, dur = pending.result()
                stage.add(ms)
                audio_total += dur
                if nxt is not None:
                    pending = pool.submit(first_chunk, nxt)

    return stage, audio_total


# ------------------------------------------------- распознавание + перевод

async def bench_asr_mt(audio: Path, host: str, src: str, dst: str) -> tuple[Stage, list[str]]:
    """Подаём звук в реальном времени в WhisperLiveKit и ловим момент, когда
    появляется первый ЗАКОММИЧЕННЫЙ перевод — то есть кусок, который уже можно
    безопасно произносить."""
    import websockets

    pcm = pcm16(audio, IN_RATE)
    stage = Stage("распознавание+перевод: до первого коммита")
    translated: list[str] = []
    url = f"ws://{host}/asr?src_lang={src}&tgt_lang={dst}"

    async with websockets.connect(url, max_size=None) as ws:
        t_start = time.perf_counter()
        first_commit: float | None = None

        async def feed() -> None:
            step = int(IN_RATE * CHUNK_MS / 1000) * 2
            for i in range(0, len(pcm), step):
                await ws.send(pcm[i:i + step])
                await asyncio.sleep(CHUNK_MS / 1000)  # реальное время
            await ws.send(b"")

        async def read() -> None:
            nonlocal first_commit
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                for line in msg.get("lines", []) or []:
                    txt = (line.get("translation") or "").strip()
                    if txt and txt not in translated:
                        translated.append(txt)
                        if first_commit is None:
                            first_commit = (time.perf_counter() - t_start) * 1000.0
                            stage.add(first_commit)
                            print(f"  первый перевод через {first_commit:.0f} мс: {txt[:60]}")

        feeder = asyncio.create_task(feed())
        reader = asyncio.create_task(read())
        await feeder
        try:
            await asyncio.wait_for(reader, timeout=15)
        except asyncio.TimeoutError:
            reader.cancel()

    return stage, translated


# ------------------------------------------------------------------ main

async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", default="alex_ref.wav", help="запись русской речи")
    ap.add_argument("--host", default="127.0.0.1:8000", help="адрес WhisperLiveKit")
    ap.add_argument("--src", default="ru")
    ap.add_argument("--dst", default="he")
    ap.add_argument("--skip-asr", action="store_true", help="мерить только синтез")
    args = ap.parse_args()

    audio = Path(args.audio)
    if not audio.exists():
        sys.exit(f"нет файла: {audio}")

    w = wave.open(str(audio)); dur = w.getnframes() / w.getframerate(); w.close()
    print(f"вход: {dur:.1f} с речи, подаём чанками по {CHUNK_MS} мс в реальном времени\n")

    chunks: list[str] = []
    stages: list[Stage] = []

    if not args.skip_asr:
        print("=== распознавание + перевод ===")
        st, chunks = await bench_asr_mt(audio, args.host, args.src, args.dst)
        stages.append(st)
        print(f"  кусков перевода: {len(chunks)}")

    if not chunks:
        # Запасной набор, чтобы померить синтез, даже если ASR не поднялся.
        chunks = ["היי, אני שומע אותך טוב.", "מה שלומך היום?", "אני מדבר איתך דרך מתרגם."]
        print("\n(перевод не получен — синтез меряется на запасных фразах)")

    print("\n=== синтез ===")
    for overlap in (False, True):
        st, total = bench_tts(chunks, overlap=overlap)
        stages.append(st)
        print(" ", st.report(), f"| звука {total:.1f} с")

    print("\n" + "=" * 78)
    for st in stages:
        print(st.report())
    print("=" * 78)
    print("Ориентир: облачная цепочка даёт медиану 4045 мс (§10 docs/07-product-spec.md).")
    print("Цель: меньше 2000 мс.")


if __name__ == "__main__":
    asyncio.run(main())
