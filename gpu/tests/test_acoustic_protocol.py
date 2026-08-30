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


def test_queue_wait_reaches_the_wire_next_to_latency():
    # latency_ms alone is a mixture: it is stamped in NemotronUtterance.__init__
    # and therefore already contains the wait for the shared generate lock. The
    # wait was computed and thrown away; a consumer that sees only latency_ms
    # cannot tell a slow model from a contended card.
    payload = AcousticEvent(
        type="final",
        text="привет",
        lang="ru",
        engine="test-engine",
        latency_ms=412.0,
        queue_wait_ms=37.25,
    ).as_dict()
    assert payload["latency_ms"] == 412.0
    assert payload["queue_wait_ms"] == 37.25


def test_queue_wait_is_omitted_when_it_was_not_measured():
    # Zero and "not measured" are different claims, and this repo does not
    # publish invented numbers: events with no queue behind them stay silent.
    assert "queue_wait_ms" not in AcousticEvent(type="ready", lang="he").as_dict()


def test_engine_update_carries_no_invented_zero_wait():
    # The omission above is only honest if the producer can actually produce
    # "not measured". `HebrewWhisperEngine.transcribe` short-circuits on empty
    # audio without ever taking the lock, and a Nemotron final can be emitted
    # while `run_model` is still blocked on `_generate_lock`; with a 0.0 default
    # both would have published a measured "no wait".
    from gpu.acoustic.engines import TranscriptUpdate

    update = TranscriptUpdate(text="", latency_ms=0.0, engine="test-engine")
    assert update.queue_wait_ms is None
    assert "queue_wait_ms" not in AcousticEvent(
        type="final",
        text="x",
        lang="he",
        latency_ms=update.latency_ms,
        queue_wait_ms=update.queue_wait_ms,
    ).as_dict()


def test_hebrew_latency_contains_its_own_queue_wait():
    """`latency_ms` must mean the same thing for both engines on the wire.

    `AcousticEvent.latency_ms` is one field and both engines write it. Nemotron
    anchors it in `NemotronUtterance.__init__`, i.e. before its wait on
    `_generate_lock`, so ru events publish a latency that already contains the
    wait. If the Hebrew engine anchored after its lock instead, the same field
    would mean "wait included" for ru and "wait excluded" for he, and the only
    consumer of the number (`last_server_latency_ms` in
    `agent/src/speakeasy_agent/providers/stt_runpod.py`) has no way to tell the
    two apart. `latency_ms - queue_wait_ms` would then be right for one language
    and double-subtract for the other.
    """
    import threading
    import time

    from gpu.acoustic.engines import HebrewWhisperEngine

    block_ms = 60.0

    class FakeSegment:
        text = "שלום"

    class FakeWhisper:
        def transcribe(self, audio, **kwargs):
            time.sleep(block_ms / 1000.0)
            return [FakeSegment()], None

    engine = HebrewWhisperEngine()
    engine._model = FakeWhisper()
    engine.device = "cpu"

    results: list = []
    lock = threading.Lock()

    def call() -> None:
        update = engine.transcribe([0.0] * 160)
        with lock:
            results.append(update)

    threads = [threading.Thread(target=call) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10.0)

    assert len(results) == 2
    waited = max(results, key=lambda update: update.queue_wait_ms or 0.0)
    # The second caller really queued behind the first, so there is a wait to
    # misattribute in the first place.
    assert waited.queue_wait_ms is not None and waited.queue_wait_ms > 0.5 * block_ms
    for update in results:
        assert update.queue_wait_ms is not None
        # The invariant: the wait is a component of latency_ms, never an addend.
        assert update.latency_ms >= update.queue_wait_ms
    assert waited.latency_ms >= waited.queue_wait_ms + 0.5 * block_ms
