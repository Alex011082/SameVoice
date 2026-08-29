from __future__ import annotations

import pytest

from gpu.acoustic.protocol import AcousticEvent, validate_pcm, validate_start_message


def test_start_message_accepts_ru_he_16k_mono():
    assert validate_start_message(
        {"type": "start", "lang": "ru", "sample_rate": 16000, "channels": 1}
    ) == ("ru", 16000)
    assert validate_start_message(
        {"type": "start", "lang": "he", "sample_rate": 16000, "channels": 1}
    ) == ("he", 16000)


def test_start_message_rejects_wrong_audio_contract():
    with pytest.raises(ValueError, match="16000"):
        validate_start_message({"type": "start", "lang": "ru", "sample_rate": 48000})
    with pytest.raises(ValueError, match="mono"):
        validate_start_message(
            {"type": "start", "lang": "ru", "sample_rate": 16000, "channels": 2}
        )


def test_pcm_requires_complete_s16_samples():
    validate_pcm(b"\x00\x00\x01\x00")
    with pytest.raises(ValueError, match="even"):
        validate_pcm(b"\x00")


def test_event_serialization_keeps_stt_vocabulary():
    payload = AcousticEvent(
        type="partial",
        text="привет",
        lang="ru",
        start=0.1,
        end=0.8,
        confidence=0.9,
        engine="test-engine",
        latency_ms=123.4567,
    ).as_dict()
    assert payload == {
        "type": "partial",
        "text": "привет",
        "start": 0.1,
        "end": 0.8,
        "confidence": 0.9,
        "lang": "ru",
        "engine": "test-engine",
        "latency_ms": 123.457,
    }
