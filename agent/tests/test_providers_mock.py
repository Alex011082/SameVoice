from __future__ import annotations

import array
import math

from livekit import rtc

from speakeasy_agent.providers import build_mt, build_stt, build_tts
from speakeasy_agent.providers.base import (
    MtProvider,
    MtRequest,
    Speaker,
    SttProvider,
    TtsProvider,
)
from speakeasy_agent.providers.stt_mock import fixture_phrases, load_fixtures
from speakeasy_agent.providers.tts_mock import MockTtsProvider
from speakeasy_agent.config import Config

ALEX = Speaker(user_id="u_alex", display_name="Alex", lang="ru", gender="m", tone="neutral")
NOA = Speaker(user_id="u_noa", display_name="Noa", lang="he", gender="f", tone="friendly")

CFG = Config()
SAMPLE_RATE = 16000
FRAME_MS = 10


def voiced_frame(index: int, *, amplitude: float = 0.3) -> rtc.AudioFrame:
    n = SAMPLE_RATE * FRAME_MS // 1000
    buf = array.array("h", bytes(n * 2))
    step = 2.0 * math.pi * 220.0 / SAMPLE_RATE
    base = index * n
    for i in range(n):
        buf[i] = int(amplitude * 30000 * math.sin(step * (base + i)))
    return rtc.AudioFrame(
        data=buf.tobytes(), sample_rate=SAMPLE_RATE, num_channels=1, samples_per_channel=n
    )


def silent_frame() -> rtc.AudioFrame:
    n = SAMPLE_RATE * FRAME_MS // 1000
    return rtc.AudioFrame(
        data=bytes(n * 2), sample_rate=SAMPLE_RATE, num_channels=1, samples_per_channel=n
    )


def test_mocks_satisfy_the_provider_protocols():
    assert isinstance(build_stt("mock", CFG), SttProvider)
    assert isinstance(build_mt("mock", CFG), MtProvider)
    assert isinstance(build_tts("mock", CFG), TtsProvider)


def test_unknown_provider_names_are_readable():
    for builder, name, expected in (
        (build_stt, "STT", "mock, deepgram, runpod"),
        (build_mt, "MT", "mock, gemini, openai, runpod"),
        (build_tts, "TTS", "mock, cartesia, runpod"),
    ):
        try:
            builder("nope", CFG)
        except ValueError as exc:
            assert expected in str(exc)
        else:  # pragma: no cover
            raise AssertionError(f"{name} builder accepted an unknown name")


async def _drain_stt(lang: str, frames: int = 200) -> list[tuple[str, str]]:
    provider = build_stt("mock", CFG)
    session = await provider.start(lang=lang)  # type: ignore[arg-type]
    for i in range(frames):
        session.push_frame(voiced_frame(i))
    for _ in range(60):
        session.push_frame(silent_frame())
    await session.aclose()
    return [(e.type, e.text) async for e in session]


async def test_mock_stt_is_deterministic_across_runs():
    first = await _drain_stt("ru")
    second = await _drain_stt("ru")
    assert first == second
    assert first[0][0] == "speech_start"
    assert any(kind == "partial" for kind, _ in first)
    finals = [text for kind, text in first if kind == "final"]
    assert finals, "mock STT produced no final transcript"
    assert finals[0] == fixture_phrases("ru")[0]


async def test_mock_stt_advances_through_the_phrase_list():
    provider = build_stt("mock", CFG)
    session = await provider.start(lang="he")
    phrases = fixture_phrases("he")
    frame = 0
    for phrase in phrases[:3]:
        # Exactly enough voiced audio for one phrase: 220 ms per word plus one
        # trailing interval, then silence to close the utterance.
        for _ in range((len(phrase.split()) + 1) * 22):
            session.push_frame(voiced_frame(frame))
            frame += 1
        for _ in range(60):
            session.push_frame(silent_frame())
    await session.aclose()
    finals = [e.text async for e in session if e.type == "final"]
    assert finals[:3] == phrases[:3]


async def test_mock_mt_round_trips_every_fixture_phrase():
    mt = build_mt("mock", CFG)
    data = load_fixtures()

    for entry in data["ru"]:
        result = await mt.translate(
            MtRequest(
                text=entry["src"],
                src_lang="ru",
                dst_lang="he",
                speaker=ALEX,
                listener=NOA,
                is_continuation=False,
            )
        )
        assert result.text == entry["he"]

    for entry in data["he"]:
        result = await mt.translate(
            MtRequest(
                text=entry["src"],
                src_lang="he",
                dst_lang="ru",
                speaker=NOA,
                listener=ALEX,
                is_continuation=False,
            )
        )
        assert result.text == entry["ru"]


async def test_mock_mt_marks_a_fixture_miss_visibly():
    mt = build_mt("mock", CFG)
    result = await mt.translate(
        MtRequest(
            text="это не из фикстур",
            src_lang="ru",
            dst_lang="he",
            speaker=ALEX,
            listener=NOA,
            is_continuation=True,
        )
    )
    assert "[mock ru→he]" in result.text


async def test_mock_mt_hebrew_fixtures_carry_listener_gender():
    """The RU->HE fixtures address a FEMALE listener; if that ever silently
    reverts to masculine forms the gender contract has been lost."""
    mt = build_mt("mock", CFG)
    result = await mt.translate(
        MtRequest(
            text="привет, слышишь меня нормально?",
            src_lang="ru",
            dst_lang="he",
            speaker=ALEX,
            listener=NOA,
            is_continuation=False,
        )
    )
    assert "שומעת" in result.text  # feminine, not שומע


async def _tts_pcm(text: str) -> tuple[int, int]:
    tts = MockTtsProvider(realtime=False, ttfb_s=0.0)
    total = 0
    chunks = 0
    async for chunk in tts.synthesize(text, lang="ru"):
        assert chunk.sample_rate == 48000
        assert chunk.num_channels == 1
        assert len(chunk.pcm) == chunk.samples_per_channel * 2
        total += chunk.samples_per_channel
        chunks += 1
    return total, chunks


async def test_mock_tts_emits_48k_int16_and_scales_with_text_length():
    short_samples, short_chunks = await _tts_pcm("да")
    long_samples, _ = await _tts_pcm("это заметно более длинная фраза для синтеза")
    assert short_chunks >= 1
    assert long_samples > short_samples * 2


async def test_mock_tts_is_deterministic():
    a = [c.pcm async for c in MockTtsProvider(realtime=False, ttfb_s=0.0).synthesize("тест", lang="ru")]
    b = [c.pcm async for c in MockTtsProvider(realtime=False, ttfb_s=0.0).synthesize("тест", lang="ru")]
    assert a == b


async def test_mock_tts_emits_nothing_for_empty_text():
    chunks = [c async for c in MockTtsProvider(realtime=False, ttfb_s=0.0).synthesize("  ", lang="he")]
    assert chunks == []


async def test_runpod_stubs_are_importable_and_raise():
    import pytest

    from speakeasy_agent.providers.mt_runpod import RunpodMtProvider
    from speakeasy_agent.providers.stt_runpod import RunpodSttProvider
    from speakeasy_agent.providers.tts_runpod import RunpodTtsProvider

    with pytest.raises(NotImplementedError, match="Stage-1 stub"):
        await RunpodSttProvider(CFG).start(lang="ru")

    with pytest.raises(NotImplementedError, match="Stage-1 stub"):
        await RunpodMtProvider(CFG).translate(
            MtRequest(
                text="x",
                src_lang="ru",
                dst_lang="he",
                speaker=ALEX,
                listener=NOA,
                is_continuation=False,
            )
        )

    with pytest.raises(NotImplementedError, match="Stage-1 stub"):
        RunpodTtsProvider(CFG).synthesize("x", lang="ru")
