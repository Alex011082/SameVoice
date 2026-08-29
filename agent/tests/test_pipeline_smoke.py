"""End-to-end pipeline smoke with NO LiveKit connection and NO network.

Synthetic audio frames go in one end; PCM audio and subtitles come out the
other. This is the day-one "does the skeleton work" gate for the agent.
"""

from __future__ import annotations

import array
import asyncio
import math
import time

from livekit import rtc

from speakeasy_agent.audio import CollectingAudioSink
from speakeasy_agent.chunker import ChunkerConfig
from speakeasy_agent.config import Config
from speakeasy_agent.direction import Direction
from speakeasy_agent.providers import build_mt, build_stt, build_tts
from speakeasy_agent.providers.base import Speaker
from speakeasy_agent.providers.stt_mock import fixture_phrases
from speakeasy_agent.providers.tts_mock import MockTtsProvider
from speakeasy_agent.subtitles import CollectingTextTransport, SubtitleEmitter

ALEX = Speaker(user_id="u_alex", display_name="Alex", lang="ru", gender="m", tone="neutral")
NOA = Speaker(user_id="u_noa", display_name="Noa", lang="he", gender="f", tone="friendly")

CFG = Config()
IN_RATE = 16000
FRAME_MS = 10
FRAME_SAMPLES = IN_RATE * FRAME_MS // 1000


def voiced_frame(index: int) -> rtc.AudioFrame:
    buf = array.array("h", bytes(FRAME_SAMPLES * 2))
    step = 2.0 * math.pi * 220.0 / IN_RATE
    base = index * FRAME_SAMPLES
    for i in range(FRAME_SAMPLES):
        buf[i] = int(0.3 * 30000 * math.sin(step * (base + i)))
    return rtc.AudioFrame(
        data=buf.tobytes(),
        sample_rate=IN_RATE,
        num_channels=1,
        samples_per_channel=FRAME_SAMPLES,
    )


def silent_frame() -> rtc.AudioFrame:
    return rtc.AudioFrame(
        data=bytes(FRAME_SAMPLES * 2),
        sample_rate=IN_RATE,
        num_channels=1,
        samples_per_channel=FRAME_SAMPLES,
    )


async def wait_for(predicate, timeout: float = 10.0, interval: float = 0.02) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return False


def make_direction(
    speaker: Speaker,
    listener: Speaker,
    *,
    realtime_tts: bool,
    transport: CollectingTextTransport | None = None,
) -> tuple[Direction, CollectingAudioSink, CollectingTextTransport]:
    transport = transport or CollectingTextTransport()
    emitter = SubtitleEmitter(
        transport=transport, call_id="c_smoke0000001", mode="TRANSLATED", providers=CFG.providers
    )
    sink = CollectingAudioSink()
    direction = Direction(
        call_id="c_smoke0000001",
        speaker=speaker,
        listener=listener,
        stt=build_stt("mock", CFG),
        mt=build_mt("mock", CFG),
        tts=MockTtsProvider(realtime=realtime_tts, ttfb_s=0.04),
        sink=sink,
        emitter=emitter,
        chunker_config=ChunkerConfig(
            min_words=CFG.chunk_min_words,
            max_silence_ms=CFG.chunk_max_silence_ms,
            timeout_ms=CFG.chunk_timeout_ms,
            weak_boundary_min_words=CFG.chunk_weak_boundary_min_words,
        ),
        history_turns=CFG.mt_history_turns,
    )
    return direction, sink, transport


async def feed(direction: Direction, *, voiced_frames: int, silent_frames: int = 60) -> None:
    for i in range(voiced_frames):
        direction.push_frame(voiced_frame(i))
        if i % 10 == 0:
            await asyncio.sleep(0)
    for _ in range(silent_frames):
        direction.push_frame(silent_frame())
    await asyncio.sleep(0)


async def test_pipeline_produces_a_translation_and_audio():
    direction, sink, transport = make_direction(ALEX, NOA, realtime_tts=True)
    await direction.start()
    try:
        phrase = fixture_phrases("ru")[0]
        await feed(direction, voiced_frames=(len(phrase.split()) + 1) * 22)

        assert await wait_for(lambda: direction.stats.units_spoken >= 1, timeout=15.0), (
            "no unit was translated and spoken"
        )
        assert await wait_for(lambda: sink.total_samples > 0, timeout=5.0)
    finally:
        await direction.aclose()

    subtitles = transport.subtitles()
    partials = [m for m in subtitles if not m["isFinal"]]
    finals = [m for m in subtitles if m["isFinal"]]

    assert partials, "no partial subtitle was emitted"
    assert all(m["dstText"] == "" for m in partials), "partials must not carry a translation"
    assert finals, "no final subtitle was emitted"

    final = finals[0]
    assert final["v"] == 1
    assert final["speakerId"] == "u_alex"
    assert final["listenerId"] == "u_noa"
    assert final["srcLang"] == "ru"
    assert final["dstLang"] == "he"
    assert final["srcText"] == phrase
    assert final["dstText"], "final subtitle carries no translation"
    # The RU->HE fixture addresses a FEMALE listener.
    assert "שומעת" in final["dstText"]

    # Nothing may follow isFinal:true for a segment.
    finalized = {m["segmentId"] for m in finals}
    for message in subtitles:
        if not message["isFinal"] and message["segmentId"] in finalized:
            index_final = subtitles.index(next(m for m in finals if m["segmentId"] == message["segmentId"]))
            assert subtitles.index(message) < index_final

    assert sink.sample_rate == 48000
    assert all(f.sample_rate == 48000 and f.num_channels == 1 for f in sink.frames)
    assert all(f.samples_per_channel == 480 for f in sink.frames), "output frames must be 10 ms"
    assert sink.duration_s > 0.3, f"only {sink.duration_s:.3f}s of audio was produced"

    metrics = direction.stats.metrics
    assert metrics, "no latency metrics were recorded"
    spoken = [m for m in metrics if not m.cancelled and m.error is None]
    assert spoken

    print("\n--- measured latency (mock providers, single RU->HE utterance) ---")
    for m in spoken:
        print(
            f"  segment={m.segment_id} trigger={m.trigger} words={m.words}\n"
            f"    speech_start -> first partial : {m.speech_start_to_first_partial_ms} ms\n"
            f"    first partial -> commit       : {m.first_partial_to_commit_ms} ms\n"
            f"    commit -> MT done             : {m.commit_to_mt_done_ms} ms"
            f" (provider {m.mt_provider_latency_ms} ms)\n"
            f"    MT done -> first audio        : {m.mt_done_to_first_audio_ms} ms\n"
            f"    END-TO-END perceived delay    : {m.speech_start_to_first_audio_ms} ms\n"
            f"    synthesized audio             : {m.tts_audio_ms} ms"
        )

    assert spoken[0].speech_start_to_first_audio_ms is not None
    assert spoken[0].tts_audio_ms and spoken[0].tts_audio_ms > 0


async def test_listener_speech_start_cancels_the_in_flight_tts():
    """Barge-in: Noa starts talking while the relay is still speaking Hebrew at
    her, so the direction speaking TO her must be cancelled."""
    transport = CollectingTextTransport()
    ru_to_he, he_sink, _ = make_direction(ALEX, NOA, realtime_tts=True, transport=transport)
    he_to_ru, _, _ = make_direction(NOA, ALEX, realtime_tts=True, transport=transport)

    # This is exactly the wiring relay.py performs.
    he_to_ru.on_speech_start = ru_to_he.cancel_output

    await ru_to_he.start()
    await he_to_ru.start()
    try:
        phrase = fixture_phrases("ru")[0]
        await feed(ru_to_he, voiced_frames=(len(phrase.split()) + 1) * 22, silent_frames=10)

        assert await wait_for(lambda: he_sink.captured_samples > 0, timeout=15.0), (
            "the relay never started speaking, so barge-in cannot be tested"
        )
        played_before = he_sink.captured_samples

        # Noa opens her mouth.
        for i in range(30):
            he_to_ru.push_frame(voiced_frame(i))
        assert await wait_for(lambda: ru_to_he.stats.barge_ins >= 1, timeout=5.0), (
            "listener speech_start did not cancel the direction speaking to her"
        )

        assert he_sink.clear_count >= 1, "AudioSource queue was not cleared on barge-in"
        assert ru_to_he.stats.units_cancelled >= 1
        assert played_before > 0
        await asyncio.sleep(0.15)
        assert he_sink.duration_s < 1.0, "audio kept flowing after the barge-in"
    finally:
        await he_to_ru.aclose()
        await ru_to_he.aclose()


async def test_empty_and_failing_providers_do_not_break_the_pipeline():
    class FailingMt:
        name = "failing"

        async def translate(self, req):  # noqa: ANN001
            raise RuntimeError("simulated MT outage")

        async def aclose(self) -> None:
            return None

    transport = CollectingTextTransport()
    emitter = SubtitleEmitter(
        transport=transport, call_id="c_smoke0000002", mode="TRANSLATED", providers=CFG.providers
    )
    sink = CollectingAudioSink()
    direction = Direction(
        call_id="c_smoke0000002",
        speaker=ALEX,
        listener=NOA,
        stt=build_stt("mock", CFG),
        mt=FailingMt(),  # type: ignore[arg-type]
        tts=MockTtsProvider(realtime=False, ttfb_s=0.0),
        sink=sink,
        emitter=emitter,
    )
    await direction.start()
    try:
        phrase = fixture_phrases("ru")[0]
        await feed(direction, voiced_frames=(len(phrase.split()) + 1) * 22)
        assert await wait_for(lambda: bool(direction.stats.metrics), timeout=10.0)
    finally:
        await direction.aclose()

    finals = [m for m in transport.subtitles() if m["isFinal"]]
    assert finals, "MT failure must still produce a subtitle with the original text"
    assert finals[0]["srcText"] == phrase
    assert finals[0]["dstText"] == "", "a failed translation must not fabricate text"
    assert sink.total_samples == 0, "nothing may be spoken when MT failed"
    assert direction.stats.provider_errors >= 1
    assert any(m.error and m.error.startswith("mt:") for m in direction.stats.metrics)


async def test_participant_leaving_mid_utterance_closes_cleanly():
    direction, sink, _ = make_direction(ALEX, NOA, realtime_tts=True)
    await direction.start()
    phrase = fixture_phrases("ru")[0]
    # Only half the utterance arrives, then the speaker disappears.
    await feed(direction, voiced_frames=40, silent_frames=0)
    await direction.aclose()
    await direction.aclose()  # idempotent
    assert sink.sample_rate == 48000
