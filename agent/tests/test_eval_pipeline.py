"""The eval log wired into the real pipeline, in mock mode, offline.

This is the test that proves the judge feature is usable without a single API
key: run a translated utterance through Direction, and the JSONL must contain
the same utteranceId the client was given in the subtitle, with the latencies
the pipeline actually measured.
"""

from __future__ import annotations

from speakeasy_agent.audio import CollectingAudioSink
from speakeasy_agent.chunker import ChunkerConfig
from speakeasy_agent.config import Config
from speakeasy_agent.direction import Direction
from speakeasy_agent.evallog import EvalLogStore, call_header_record
from speakeasy_agent.providers import build_mt, build_stt
from speakeasy_agent.providers.base import Speaker
from speakeasy_agent.providers.stt_mock import fixture_phrases
from speakeasy_agent.providers.tts_mock import MockTtsProvider
from speakeasy_agent.subtitles import CollectingTextTransport, SubtitleEmitter

from test_pipeline_smoke import ALEX, NOA, feed, wait_for

CFG = Config()
CALL_ID = "c_evallog0001"


def participant(s: Speaker) -> dict:
    return {
        "userId": s.user_id,
        "displayName": s.display_name,
        "lang": s.lang,
        "gender": s.gender,
        "tone": s.tone,
    }


async def run_one_utterance(tmp_path, *, speaker=ALEX, listener=NOA):
    store = EvalLogStore(tmp_path)
    eval_log = store.open_call(
        CALL_ID,
        header=call_header_record(
            call_id=CALL_ID,
            room_name=f"call-{CALL_ID}",
            mode="TRANSLATED",
            providers=CFG.providers,
            participants=[participant(speaker), participant(listener)],
        ),
    )
    transport = CollectingTextTransport()
    direction = Direction(
        call_id=CALL_ID,
        speaker=speaker,
        listener=listener,
        stt=build_stt("mock", CFG),
        mt=build_mt("mock", CFG),
        tts=MockTtsProvider(realtime=False, ttfb_s=0.01),
        sink=CollectingAudioSink(),
        emitter=SubtitleEmitter(
            transport=transport, call_id=CALL_ID, mode="TRANSLATED", providers=CFG.providers
        ),
        chunker_config=ChunkerConfig(
            min_words=CFG.chunk_min_words,
            max_silence_ms=CFG.chunk_max_silence_ms,
            timeout_ms=CFG.chunk_timeout_ms,
            weak_boundary_min_words=CFG.chunk_weak_boundary_min_words,
        ),
        eval_log=eval_log,
    )
    await direction.start()
    try:
        phrase = fixture_phrases(speaker.lang)[0]
        await feed(direction, voiced_frames=(len(phrase.split()) + 1) * 22)
        assert await wait_for(lambda: direction.stats.units_spoken >= 1, timeout=15.0)
    finally:
        await direction.aclose()
        await eval_log.aclose()
    return store, transport, direction, phrase


async def test_a_translated_utterance_lands_in_the_call_log(tmp_path):
    store, transport, direction, phrase = await run_one_utterance(tmp_path)

    records = await store.read_records(CALL_ID)
    header = [r for r in records if r["kind"] == "call"]
    utterances = [r for r in records if r["kind"] == "utterance"]
    assert header, "the call header must be written even before anyone speaks"
    assert utterances, "no utterance reached the eval log"

    row = utterances[0]
    assert row["callId"] == CALL_ID
    assert row["direction"] == "ru->he"
    assert row["srcText"] == phrase
    assert row["dstText"], "the translation must be recorded, not just the source"
    assert row["speakerId"] == "u_alex" and row["speakerGender"] == "m"
    assert row["listenerId"] == "u_noa" and row["listenerGender"] == "f"
    assert row["tone"] == "friendly"
    assert row["providers"] == {"stt": "mock", "mt": "mock", "tts": "mock"}

    # The latencies must be the ones the pipeline measured, not re-derived here.
    measured = direction.stats.metrics[0]
    assert row["latency"]["speech_start_to_first_audio_ms"] == (
        measured.speech_start_to_first_audio_ms
    )
    assert row["latency"]["mt_provider_latency_ms"] == measured.mt_provider_latency_ms
    assert row["latency"]["speech_start_to_first_audio_ms"] is not None


async def test_the_client_and_the_log_agree_on_the_utterance_id(tmp_path):
    """The whole judge feature hinges on this: the id the browser can flag must
    be the id the log stores. Any drift here means a verdict lands on the wrong
    line, which is worse than having no verdict at all."""
    store, transport, _, _ = await run_one_utterance(tmp_path)

    finals = [m for m in transport.subtitles() if m["isFinal"]]
    partials = [m for m in transport.subtitles() if not m["isFinal"]]
    assert finals

    logged = {r["utteranceId"] for r in await store.read_records(CALL_ID) if r["kind"] == "utterance"}
    for message in finals:
        assert message["utteranceId"], "a final subtitle must carry an utteranceId to flag"
        assert message["utteranceId"] in logged
    # Nothing to judge before there is a translation.
    assert all(m["utteranceId"] == "" for m in partials)


async def test_utterance_ids_are_unique_and_stable_within_a_call(tmp_path):
    store = EvalLogStore(tmp_path)
    eval_log = store.open_call(CALL_ID, header=None)
    transport = CollectingTextTransport()
    direction = Direction(
        call_id=CALL_ID,
        speaker=ALEX,
        listener=NOA,
        stt=build_stt("mock", CFG),
        mt=build_mt("mock", CFG),
        tts=MockTtsProvider(realtime=False, ttfb_s=0.0),
        sink=CollectingAudioSink(),
        emitter=SubtitleEmitter(
            transport=transport, call_id=CALL_ID, mode="TRANSLATED", providers=CFG.providers
        ),
        eval_log=eval_log,
    )
    await direction.start()
    try:
        for _ in range(3):
            phrase = fixture_phrases("ru")[0]
            await feed(direction, voiced_frames=(len(phrase.split()) + 1) * 22)
        assert await wait_for(lambda: direction.stats.units_spoken >= 3, timeout=20.0)
    finally:
        await direction.aclose()
        await eval_log.aclose()

    ids = [r["utteranceId"] for r in await store.read_records(CALL_ID) if r["kind"] == "utterance"]
    assert len(ids) >= 3
    assert len(set(ids)) == len(ids), f"utterance ids repeated: {ids}"
    assert all(i.startswith("utt_u_alex_") for i in ids)


async def test_a_failed_translation_is_logged_as_an_error_not_as_silence(tmp_path):
    """Silence is ambiguous to a judge. The log has to say which stage failed."""

    class FailingMt:
        name = "boom"

        async def translate(self, req):  # noqa: ANN001
            raise RuntimeError("simulated MT outage")

        async def aclose(self) -> None:
            return None

    store = EvalLogStore(tmp_path)
    eval_log = store.open_call("c_fail0001", header=None)
    direction = Direction(
        call_id="c_fail0001",
        speaker=ALEX,
        listener=NOA,
        stt=build_stt("mock", CFG),
        mt=FailingMt(),  # type: ignore[arg-type]
        tts=MockTtsProvider(realtime=False, ttfb_s=0.0),
        sink=CollectingAudioSink(),
        emitter=SubtitleEmitter(
            transport=CollectingTextTransport(),
            call_id="c_fail0001",
            mode="TRANSLATED",
            providers=CFG.providers,
        ),
        eval_log=eval_log,
    )
    await direction.start()
    try:
        phrase = fixture_phrases("ru")[0]
        await feed(direction, voiced_frames=(len(phrase.split()) + 1) * 22)
        assert await wait_for(lambda: bool(direction.stats.metrics), timeout=10.0)
    finally:
        await direction.aclose()
        await eval_log.aclose()

    rows = [r for r in await store.read_records("c_fail0001") if r["kind"] == "utterance"]
    assert rows
    assert rows[0]["dstText"] == "", "a failed translation must not fabricate text"
    assert rows[0]["error"] and rows[0]["error"].startswith("mt:")
    assert rows[0]["srcText"] == phrase, "the source is still worth keeping"


async def test_the_last_words_of_a_call_are_not_lost_on_hangup(tmp_path):
    """`aclose()` used to cancel the STT task with the Finalize message still
    queued, so the trailing partial never became a final. That is exactly where
    people say "ок, пока" - and it was never translated and never logged."""
    store = EvalLogStore(tmp_path)
    eval_log = store.open_call("c_drain0001", header=None)
    direction = Direction(
        call_id="c_drain0001",
        speaker=ALEX,
        listener=NOA,
        stt=build_stt("mock", CFG),
        mt=build_mt("mock", CFG),
        tts=MockTtsProvider(realtime=False, ttfb_s=0.0),
        sink=CollectingAudioSink(),
        emitter=SubtitleEmitter(
            transport=CollectingTextTransport(),
            call_id="c_drain0001",
            mode="TRANSLATED",
            providers=CFG.providers,
        ),
        eval_log=eval_log,
    )
    await direction.start()
    # Speech is still in flight - no trailing silence to close the utterance.
    phrase = fixture_phrases("ru")[0]
    await feed(direction, voiced_frames=(len(phrase.split()) + 1) * 22, silent_frames=0)
    assert direction.stats.units_spoken == 0, "the test needs an unfinished utterance"

    await direction.aclose()
    await eval_log.aclose()

    rows = [r for r in await store.read_records("c_drain0001") if r["kind"] == "utterance"]
    assert rows, "the trailing utterance was dropped on hangup"
    assert rows[-1]["srcText"]


async def test_hanging_up_in_silence_stays_instant(tmp_path):
    import time as _time

    direction = Direction(
        call_id="c_quiet0001",
        speaker=ALEX,
        listener=NOA,
        stt=build_stt("mock", CFG),
        mt=build_mt("mock", CFG),
        tts=MockTtsProvider(realtime=False, ttfb_s=0.0),
        sink=CollectingAudioSink(),
        emitter=SubtitleEmitter(
            transport=CollectingTextTransport(),
            call_id="c_quiet0001",
            mode="TRANSLATED",
            providers=CFG.providers,
        ),
    )
    await direction.start()
    started = _time.monotonic()
    await direction.aclose()
    assert _time.monotonic() - started < 0.2, "nothing was in flight, so nothing to wait for"


async def test_a_relay_opens_the_call_log_before_it_connects_to_anything(tmp_path):
    """The verdict endpoint answers 404 by looking for the file, so the file has
    to exist from the moment the job is accepted - not from the first word."""
    from speakeasy_agent.relay import Relay, RelayJob

    cfg = Config(eval_log_dir=str(tmp_path))
    job = RelayJob.from_payload(
        {
            "callId": "c_relay0001",
            "roomName": "call-c_relay0001",
            "mode": "TRANSLATED",
            "livekitUrl": "ws://127.0.0.1:7880",
            "token": "not-a-real-token",
            "participants": [participant(ALEX), participant(NOA)],
        }
    )
    store = EvalLogStore(tmp_path)
    relay = Relay(job, cfg, eval_store=store)
    try:
        assert relay._eval_log is not None
        await relay._eval_log.aclose()
    finally:
        await relay.aclose()

    records = await store.read_records("c_relay0001")
    assert records and records[0]["kind"] == "call"
    assert records[0]["mode"] == "TRANSLATED"
    assert records[0]["providers"] == {"stt": "mock", "mt": "mock", "tts": "mock"}
    assert [p["userId"] for p in records[0]["participants"]] == ["u_alex", "u_noa"]
    assert records[0]["participants"][1]["gender"] == "f"


async def test_the_pipeline_runs_unchanged_with_no_eval_log(tmp_path):
    """Everything must still work when the feature is switched off."""
    transport = CollectingTextTransport()
    sink = CollectingAudioSink()
    direction = Direction(
        call_id="c_nolog0001",
        speaker=ALEX,
        listener=NOA,
        stt=build_stt("mock", CFG),
        mt=build_mt("mock", CFG),
        tts=MockTtsProvider(realtime=False, ttfb_s=0.0),
        sink=sink,
        emitter=SubtitleEmitter(
            transport=transport, call_id="c_nolog0001", mode="TRANSLATED", providers=CFG.providers
        ),
        eval_log=None,
    )
    await direction.start()
    try:
        phrase = fixture_phrases("ru")[0]
        await feed(direction, voiced_frames=(len(phrase.split()) + 1) * 22)
        assert await wait_for(lambda: direction.stats.units_spoken >= 1, timeout=15.0)
    finally:
        await direction.aclose()
    assert sink.total_samples > 0
    assert not list(tmp_path.iterdir())
