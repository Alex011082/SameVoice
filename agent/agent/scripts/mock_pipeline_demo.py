#!/usr/bin/env python
"""Offline demo of the full relay pipeline - no LiveKit, no network, no keys.

    cd agent && uv run python scripts/mock_pipeline_demo.py

Prints the timeline of speech_start / partial / final, chunker commits,
translations, TTS durations and per-stage latency for a simulated RU<->HE
exchange, then a barge-in. This is the fastest way to see the state machine
working without any account.

MECHANICS ONLY: the mock providers invent their transcripts and synthesize a
modulated tone. Nothing here says anything about quality.
"""

from __future__ import annotations

import array
import asyncio
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from livekit import rtc  # noqa: E402

from speakeasy_agent.audio import CollectingAudioSink  # noqa: E402
from speakeasy_agent.chunker import ChunkerConfig  # noqa: E402
from speakeasy_agent.config import Config  # noqa: E402
from speakeasy_agent.direction import Direction  # noqa: E402
from speakeasy_agent.providers import build_mt, build_stt, build_tts  # noqa: E402
from speakeasy_agent.providers.base import Speaker  # noqa: E402
from speakeasy_agent.providers.stt_mock import fixture_phrases  # noqa: E402
from speakeasy_agent.subtitles import CollectingTextTransport, SubtitleEmitter  # noqa: E402

ALEX = Speaker(user_id="u_alex", display_name="Alex", lang="ru", gender="m", tone="neutral")
NOA = Speaker(user_id="u_noa", display_name="Noa", lang="he", gender="f", tone="friendly")

IN_RATE = 16000
FRAME_MS = 10
FRAME_SAMPLES = IN_RATE * FRAME_MS // 1000
CALL_ID = "c_demo00000001"

T0 = time.monotonic()


def stamp() -> str:
    return f"[{time.monotonic() - T0:6.2f}s]"


def voiced_frame(index: int) -> rtc.AudioFrame:
    buf = array.array("h", bytes(FRAME_SAMPLES * 2))
    step = 2.0 * math.pi * 220.0 / IN_RATE
    base = index * FRAME_SAMPLES
    for i in range(FRAME_SAMPLES):
        buf[i] = int(0.3 * 30000 * math.sin(step * (base + i)))
    return rtc.AudioFrame(
        data=buf.tobytes(), sample_rate=IN_RATE, num_channels=1, samples_per_channel=FRAME_SAMPLES
    )


def silent_frame() -> rtc.AudioFrame:
    return rtc.AudioFrame(
        data=bytes(FRAME_SAMPLES * 2),
        sample_rate=IN_RATE,
        num_channels=1,
        samples_per_channel=FRAME_SAMPLES,
    )


class PrintingTransport(CollectingTextTransport):
    async def publish(self, *, topic, payload, destination_identities, attributes):  # noqa: ANN001
        await super().publish(
            topic=topic,
            payload=payload,
            destination_identities=destination_identities,
            attributes=attributes,
        )
        message = self.messages[-1]["payload"]
        if "event" in message:
            print(f"{stamp()} STATE  {message['event']:<12} mode={message['mode']}")
            return
        kind = "FINAL " if message["isFinal"] else "partial"
        who = f"{message['speakerId']}->{message['listenerId']}"
        line = f"{stamp()} {kind} {who} src={message['srcText']!r}"
        if message["isFinal"]:
            line += f"  dst={message['dstText']!r}"
        print(line)


def build(speaker: Speaker, listener: Speaker, cfg: Config, transport: PrintingTransport):
    sink = CollectingAudioSink()
    direction = Direction(
        call_id=CALL_ID,
        speaker=speaker,
        listener=listener,
        stt=build_stt(cfg.stt_provider, cfg),
        mt=build_mt(cfg.mt_provider, cfg),
        tts=build_tts(cfg.tts_provider, cfg),
        sink=sink,
        emitter=SubtitleEmitter(
            transport=transport, call_id=CALL_ID, mode="TRANSLATED", providers=cfg.providers
        ),
        chunker_config=ChunkerConfig(
            min_words=cfg.chunk_min_words,
            max_silence_ms=cfg.chunk_max_silence_ms,
            timeout_ms=cfg.chunk_timeout_ms,
            weak_boundary_min_words=cfg.chunk_weak_boundary_min_words,
        ),
        history_turns=cfg.mt_history_turns,
        call_start=T0,
    )
    return direction, sink


async def speak(direction: Direction, phrase: str, *, tail_silence_frames: int = 60) -> None:
    frames = (len(phrase.split()) + 1) * 22
    print(f"{stamp()} MIC    {direction.speaker.user_id} starts speaking ({frames * FRAME_MS} ms)")
    for i in range(frames):
        direction.push_frame(voiced_frame(i))
        await asyncio.sleep(FRAME_MS / 1000.0)
    for _ in range(tail_silence_frames):
        direction.push_frame(silent_frame())
        await asyncio.sleep(FRAME_MS / 1000.0)


def report(direction: Direction) -> None:
    print(f"\n=== latency, {direction.label} ===")
    if not direction.stats.metrics:
        print("  (no units)")
        return
    for m in direction.stats.metrics:
        flag = " CANCELLED" if m.cancelled else (f" ERROR {m.error}" if m.error else "")
        print(
            f"  {m.segment_id} trigger={m.trigger:<9} words={m.words}{flag}\n"
            f"    speech_start -> first partial : {m.speech_start_to_first_partial_ms} ms\n"
            f"    first partial -> commit       : {m.first_partial_to_commit_ms} ms\n"
            f"    commit -> MT done             : {m.commit_to_mt_done_ms} ms\n"
            f"    MT done -> first audio        : {m.mt_done_to_first_audio_ms} ms\n"
            f"    END-TO-END perceived delay    : {m.speech_start_to_first_audio_ms} ms\n"
            f"    synthesized audio             : {m.tts_audio_ms} ms"
        )


async def main() -> int:
    cfg = Config.from_env()
    print(f"providers: stt={cfg.stt_provider} mt={cfg.mt_provider} tts={cfg.tts_provider}")
    if "mock" not in (cfg.stt_provider, cfg.mt_provider, cfg.tts_provider):
        print("note: this demo is designed for the mock providers")

    transport = PrintingTransport()
    ru_to_he, he_sink = build(ALEX, NOA, cfg, transport)
    he_to_ru, ru_sink = build(NOA, ALEX, cfg, transport)
    ru_to_he.on_speech_start = he_to_ru.cancel_output
    he_to_ru.on_speech_start = ru_to_he.cancel_output

    await ru_to_he.start()
    await he_to_ru.start()

    try:
        print("\n--- turn 1: Alex speaks Russian, Noa hears Hebrew ---")
        await speak(ru_to_he, fixture_phrases("ru")[0])
        await asyncio.sleep(1.5)

        print("\n--- turn 2: Noa answers in Hebrew, Alex hears Russian ---")
        await speak(he_to_ru, fixture_phrases("he")[0])
        await asyncio.sleep(1.5)

        print("\n--- turn 3: Alex starts a long sentence, Noa interrupts (barge-in) ---")
        long_phrase = fixture_phrases("ru")[1]
        frames = (len(long_phrase.split()) + 1) * 22
        for i in range(frames):
            ru_to_he.push_frame(voiced_frame(i))
            await asyncio.sleep(FRAME_MS / 1000.0)
        for _ in range(60):
            ru_to_he.push_frame(silent_frame())
            await asyncio.sleep(FRAME_MS / 1000.0)

        deadline = time.monotonic() + 5.0
        while he_sink.total_samples == 0 and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        print(f"{stamp()} MIC    u_noa interrupts")
        for i in range(30):
            he_to_ru.push_frame(voiced_frame(i))
            await asyncio.sleep(FRAME_MS / 1000.0)
        await asyncio.sleep(0.5)
    finally:
        await ru_to_he.aclose()
        await he_to_ru.aclose()

    report(ru_to_he)
    report(he_to_ru)

    print("\n=== audio delivered (cumulative, before any barge-in flush) ===")
    print(f"  to u_noa  (Hebrew) : {he_sink.captured_duration_s:.2f}s, queue cleared {he_sink.clear_count}x")
    print(f"  to u_alex (Russian): {ru_sink.captured_duration_s:.2f}s, queue cleared {ru_sink.clear_count}x")
    print(f"  barge-ins: ru->he {ru_to_he.stats.barge_ins}, he->ru {he_to_ru.stats.barge_ins}")

    ok = ru_to_he.stats.units_spoken >= 1 and he_to_ru.stats.units_spoken >= 1
    print("\nRESULT:", "ok" if ok else "FAILED - no audio was produced in one direction")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
