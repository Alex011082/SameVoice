"""The eval log itself: records, robustness, and the promise that a broken log
never breaks a call."""

from __future__ import annotations

import asyncio
import json

import pytest

from speakeasy_agent.evallog import (
    CallEvalLog,
    EvalLogStore,
    call_header_record,
    is_valid_call_id,
    read_records_from_path,
    utterance_record,
    verdict_record,
)

SPEAKER = {"userId": "u_alex", "displayName": "Alex", "lang": "ru", "gender": "m", "tone": "neutral"}
LISTENER = {"userId": "u_noa", "displayName": "Noa", "lang": "he", "gender": "f", "tone": "friendly"}


def make_utterance(**overrides):
    base = dict(
        call_id="c_test01",
        utterance_id="utt_u_alex_000001",
        utterance_key="utt_u_alex@1200",
        is_first_chunk=True,
        segment_id="seg_u_alex_000001",
        speaker=SPEAKER,
        listener=LISTENER,
        src_lang="ru",
        dst_lang="he",
        src_text="привет, ты меня слышишь",
        dst_text="שלום, את שומעת אותי",
        providers={"stt": "mock", "mt": "mock", "tts": "mock"},
        latency={"speech_start_to_first_audio_ms": 1260.0, "mt_provider_latency_ms": 5.0},
        trigger="final",
        words=4,
        t_start=0.2,
        t_end=1.4,
        cancelled=False,
        error=None,
    )
    base.update(overrides)
    return utterance_record(**base)


def test_call_id_validation_blocks_path_traversal():
    assert is_valid_call_id("c_abc123")
    assert is_valid_call_id("call-1.2_3")
    assert not is_valid_call_id("../../etc/passwd")
    assert not is_valid_call_id("c/abc")
    assert not is_valid_call_id("")
    assert not is_valid_call_id(".hidden")


def test_store_refuses_to_build_a_path_for_an_unsafe_call_id(tmp_path):
    store = EvalLogStore(tmp_path)
    with pytest.raises(ValueError):
        store.path_for("../escape")
    assert store.exists("../escape") is False


def test_utterance_record_carries_everything_a_judge_needs():
    record = make_utterance()
    # The bilingual judge's verdict is worthless without the conditions it was
    # produced under, so all of these must be on every line.
    for key in (
        "callId",
        "utteranceId",
        # Without these two, one utterance committed in four chunks contributes
        # four samples to a per-utterance percentile.
        "utteranceKey",
        "isFirstChunk",
        "direction",
        "srcLang",
        "dstLang",
        "speakerId",
        "speakerGender",
        "listenerId",
        "listenerGender",
        "tone",
        "srcText",
        "dstText",
        "providers",
        "latency",
    ):
        assert key in record, f"{key} missing from the utterance record"
    assert record["kind"] == "utterance"
    assert record["direction"] == "ru->he"
    assert record["speakerGender"] == "m"
    assert record["listenerGender"] == "f"
    # Register is keyed off the listener, and that is what must be recorded.
    assert record["tone"] == "friendly"
    assert record["providers"] == {"stt": "mock", "mt": "mock", "tts": "mock"}
    assert record["latency"]["speech_start_to_first_audio_ms"] == 1260.0


async def test_append_and_read_round_trip(tmp_path):
    store = EvalLogStore(tmp_path)
    log = store.open_call(
        "c_test01",
        header=call_header_record(
            call_id="c_test01",
            room_name="call-c_test01",
            mode="TRANSLATED",
            providers={"stt": "mock", "mt": "mock", "tts": "mock"},
            participants=[SPEAKER, LISTENER],
        ),
    )
    log.append(make_utterance())
    log.append(make_utterance(utterance_id="utt_u_noa_000001", src_lang="he", dst_lang="ru"))
    await log.aclose()

    records = read_records_from_path(store.path_for("c_test01"))
    assert [r["kind"] for r in records] == ["call", "utterance", "utterance"]
    assert records[0]["providers"]["tts"] == "mock"
    # Hebrew must survive the round trip unescaped and unmangled.
    assert records[1]["dstText"] == "שלום, את שומעת אותי"
    raw = store.path_for("c_test01").read_text(encoding="utf-8")
    assert "שלום" in raw, "the file must be readable Hebrew, not \\uXXXX escapes"


async def test_a_torn_final_line_does_not_destroy_the_session(tmp_path):
    store = EvalLogStore(tmp_path)
    log = store.open_call("c_test02", header=None)
    log.append(make_utterance(call_id="c_test02"))
    await log.aclose()
    path = store.path_for("c_test02")
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"kind":"utterance","srcTe')  # process killed mid-write

    records = read_records_from_path(path)
    assert len(records) == 1
    assert records[0]["kind"] == "utterance"


async def test_writing_never_raises_into_the_audio_path(tmp_path):
    """A directory that cannot be written to is a logging problem, not a call
    problem: appends must be swallowed, not propagated."""
    blocked = tmp_path / "blocked"
    blocked.write_text("i am a file, not a directory", encoding="utf-8")
    store = EvalLogStore(blocked)
    log = store.open_call("c_test03", header=None)
    log.append(make_utterance(call_id="c_test03"))  # must not raise
    await log.aclose()
    assert blocked.is_file()


async def test_disabled_store_writes_nothing(tmp_path):
    store = EvalLogStore(tmp_path, enabled=False)
    log = store.open_call("c_test04", header=call_header_record(
        call_id="c_test04", room_name="r", mode="TRANSLATED", providers={}, participants=[]
    ))
    log.append(make_utterance(call_id="c_test04"))
    await log.aclose()
    assert not store.path_for("c_test04").exists()


async def test_verdicts_are_appended_not_merged(tmp_path):
    """Append-only: a second verdict on the same utterance is a visible change
    of mind, never a silent overwrite of the first."""
    store = EvalLogStore(tmp_path)
    log = store.open_call("c_test05", header=None)
    log.append(make_utterance(call_id="c_test05"))
    await log.aclose()

    await store.append_verdict(
        "c_test05",
        verdict_record(
            call_id="c_test05", utterance_id="utt_u_alex_000001", verdict="wrong", by="u_noa"
        ),
    )
    await store.append_verdict(
        "c_test05",
        verdict_record(
            call_id="c_test05",
            utterance_id="utt_u_alex_000001",
            verdict="ok",
            expected="שלום, את שומעת אותי?",
            by="u_noa",
        ),
    )
    records = await store.read_records("c_test05")
    verdicts = [r for r in records if r["kind"] == "verdict"]
    assert [v["verdict"] for v in verdicts] == ["wrong", "ok"]
    assert verdicts[1]["expected"] == "שלום, את שומעת אותי?"


async def test_latest_utterance_resolves_to_what_that_listener_heard(tmp_path):
    store = EvalLogStore(tmp_path)
    log = store.open_call("c_test06", header=None)
    log.append(make_utterance(call_id="c_test06", utterance_id="a1"))
    log.append(
        make_utterance(
            call_id="c_test06",
            utterance_id="b1",
            speaker=LISTENER,
            listener=SPEAKER,
            src_lang="he",
            dst_lang="ru",
        )
    )
    log.append(make_utterance(call_id="c_test06", utterance_id="a2"))
    await log.aclose()

    # Noa presses "wrong": she can only mean a translation SHE heard, i.e. one
    # where she is the listener - the newest of those, not the newest overall.
    assert await store.resolve_latest_utterance("c_test06", listener_id="u_noa") == "a2"
    assert await store.resolve_latest_utterance("c_test06", listener_id="u_alex") == "b1"
    assert await store.resolve_latest_utterance("c_test06") == "a2"
    assert await store.resolve_latest_utterance("c_test06", listener_id="u_ghost") is None


async def test_empty_translations_are_never_offered_as_the_thing_you_just_heard(tmp_path):
    store = EvalLogStore(tmp_path)
    log = store.open_call("c_test07", header=None)
    log.append(make_utterance(call_id="c_test07", utterance_id="good"))
    log.append(
        make_utterance(call_id="c_test07", utterance_id="failed", dst_text="", error="mt: boom")
    )
    await log.aclose()
    assert await store.resolve_latest_utterance("c_test07", listener_id="u_noa") == "good"


async def test_a_full_queue_drops_records_instead_of_blocking(tmp_path, monkeypatch):
    import speakeasy_agent.evallog as evallog

    monkeypatch.setattr(evallog, "_QUEUE_MAXSIZE", 4)
    log = CallEvalLog(path=tmp_path / "c_flood.jsonl", call_id="c_flood", enabled=True)
    # Never yields to the loop, so the writer task cannot drain: the queue fills.
    for i in range(200):
        log.append(make_utterance(utterance_id=f"u{i}"))
    await log.aclose()
    # The point is that none of the 200 calls raised, and the process survived.
    assert log.path.exists()
    written = read_records_from_path(log.path)
    assert 0 < len(written) <= 200


async def test_concurrent_writers_do_not_interleave_lines(tmp_path):
    """The per-call writer and the verdict endpoint touch the same file."""
    store = EvalLogStore(tmp_path)
    log = store.open_call("c_test08", header=None)
    for i in range(30):
        log.append(make_utterance(call_id="c_test08", utterance_id=f"u{i}"))
    await asyncio.gather(
        *[
            store.append_verdict(
                "c_test08",
                verdict_record(call_id="c_test08", utterance_id=f"u{i}", verdict="wrong"),
            )
            for i in range(30)
        ]
    )
    await log.aclose()

    for line in store.path_for("c_test08").read_text(encoding="utf-8").splitlines():
        if line.strip():
            json.loads(line)  # every line must be a complete JSON object
