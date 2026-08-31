#!/usr/bin/env python3
"""baselineSttStableMs: когда боевой STT стабилизирует целевое слово.

Реализация процедуры из eval/corpus/README.md («Скрипта в репозитории нет —
не реализовано» — теперь реализовано):
  1. тот же WAV, что в манифесте (16 кГц моно s16);
  2. websocket /v1/stream боевого сервиса (gpu/acoustic/app.py, порт 8102);
  3. подача В РЕАЛЬНОМ ТЕМПЕ, кадрами продакшн-размера (20 мс);
  4. каждый partial/final логируется со стенным временем от начала подачи;
  5. T = момент, ПОСЛЕ которого целевое слово присутствует в гипотезе и не
     исчезает до конца высказывания (последнее изменение, не первое появление);
  6. сравнение форм — той же нормализацией, что бенч: strip().casefold();
  7. baselineSttStableMs = T − wordStartMs.

Пишет обогащённый манифест (+engine id, +GPU) — вход для acoustic-replay-bench,
который на его основе сам считает lead. База и replay должны сниматься В ОДНОЙ
сессии пода (протокол): иначе lead между двумя машинами.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import wave
from pathlib import Path

import websockets


def word_key(w: str) -> str:
    return w.strip().casefold().replace("ё", "е")


async def measure_one(url: str, wav_path: Path, truth: str, frame_ms: int, tail_s: float):
    with wave.open(str(wav_path), "rb") as r:
        assert r.getframerate() == 16000 and r.getnchannels() == 1 and r.getsampwidth() == 2
        pcm = r.readframes(r.getnframes())
    frame_bytes = int(16000 * frame_ms / 1000) * 2
    events: list[tuple[float, str, str]] = []  # (t_ms, type, text)

    async with websockets.connect(url, max_size=None) as ws:
        await ws.send(json.dumps({"type": "start", "lang": "ru", "sample_rate": 16000, "channels": 1}))
        t0 = time.perf_counter()
        stop = asyncio.Event()

        async def reader():
            try:
                async for raw in ws:
                    if isinstance(raw, bytes):
                        continue
                    msg = json.loads(raw)
                    t_ms = (time.perf_counter() - t0) * 1000.0
                    if msg.get("type") in ("partial", "final"):
                        events.append((t_ms, msg["type"], msg.get("text", "")))
            except websockets.ConnectionClosed:
                pass
            finally:
                stop.set()

        rt = asyncio.create_task(reader())
        # подача 1x: планирование по абсолютным моментам, чтобы темп не плыл
        next_at = time.perf_counter()
        for i in range(0, len(pcm), frame_bytes):
            await ws.send(pcm[i:i + frame_bytes])
            next_at += frame_ms / 1000.0
            delay = next_at - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
        await ws.send(json.dumps({"type": "flush"}))
        try:
            await asyncio.wait_for(stop.wait(), timeout=tail_s)
        except asyncio.TimeoutError:
            pass
        rt.cancel()

    # T: последнее событие, после которого истина присутствует непрерывно
    tkey = word_key(truth)
    stable_since = None
    for t_ms, _typ, text in events:
        present = tkey in {word_key(w) for w in text.split()}
        if present and stable_since is None:
            stable_since = t_ms
        elif not present:
            stable_since = None
    return stable_since, events


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--dataset-root", required=True)
    ap.add_argument("--stream-url", default="ws://127.0.0.1:8102/v1/stream")
    ap.add_argument("--frame-ms", type=int, default=20)
    ap.add_argument("--tail-s", type=float, default=4.0)
    ap.add_argument("--engine-id", default="nvidia/nemotron-3.5-asr-streaming-0.6b")
    ap.add_argument("--output-manifest", required=True)
    args = ap.parse_args()

    root = Path(args.dataset_root)
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    stats_ok, stats_none = [], []
    for s in manifest["samples"]:
        wav = root / s["wav"] if not str(s["wav"]).startswith("/") else Path(s["wav"])
        stable_ms, events = await measure_one(args.stream_url, wav, s["truth"], args.frame_ms, args.tail_s)
        if stable_ms is None:
            s.pop("baselineSttStableMs", None)
            s["baselineSttNote"] = f"слово не стабилизировалось; событий {len(events)}"
            stats_none.append(s["id"])
            print(f"  {s['id']}  БАЗА НЕТ (событий {len(events)}, «{s['truth']}»)")
        else:
            base = stable_ms - float(s["wordStartMs"])
            s["baselineSttStableMs"] = round(base, 1)
            stats_ok.append(base)
            print(f"  {s['id']}  стабильно на {stable_ms:7.1f} мс | от онсета слова: {base:7.1f} мс")
    manifest["baselineEngine"] = args.engine_id
    import subprocess
    gpu = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                         capture_output=True, text=True).stdout.strip()
    manifest["baselineGpu"] = gpu
    Path(args.output_manifest).write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    if stats_ok:
        srt = sorted(stats_ok)
        print(f"\nбаза от онсета: p50 {srt[len(srt)//2]:.0f} мс, min {srt[0]:.0f}, max {srt[-1]:.0f}, n={len(srt)}; без базы: {len(stats_none)}")
    print(f"движок: {args.engine_id} | GPU: {gpu}")
    print(f"манифест с базой: {args.output_manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
