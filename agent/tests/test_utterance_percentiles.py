"""One utterance is several log lines, and a percentile must not count it twice.

Eval-log rows are written per COMMITTED CHUNK, but `speech_start` and
`first_partial` belong to the whole utterance. On the Omri-Maya call (27.08.2026)
the median committed unit was ONE WORD - the measurement and its example live at
`speakeasy_agent/chunker.py:60` and `test_chunker.py:246` - so a four-word
sentence published the same `speech_start_to_first_partial_ms` four times and
every percentile in the repo weighted an utterance by how many chunks it happened
to produce. These tests pin both halves of the fix: the writer emits a
per-utterance key plus a first-chunk mark, and both readers aggregate on them.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from pathlib import Path
from typing import AsyncIterator

import pytest

from speakeasy_agent.audio import CollectingAudioSink
from speakeasy_agent.chunker import ChunkerConfig
from speakeasy_agent.config import Config
from speakeasy_agent.direction import Direction
from speakeasy_agent.evallog import EvalLogStore, call_header_record, utterance_record
from speakeasy_agent.providers import build_mt
from speakeasy_agent.providers.base import Lang, SttEvent
from speakeasy_agent.providers.tts_mock import MockTtsProvider
from speakeasy_agent.subtitles import CollectingTextTransport, SubtitleEmitter

from test_pipeline_smoke import ALEX, NOA, wait_for
from test_review_cli import load_cli

CFG = Config()
_REPO_ROOT = Path(__file__).resolve().parents[2]
_NODE_CLI = _REPO_ROOT / "scripts" / "review-call.mjs"


# --------------------------------------------------------------- scripted STT


class ScriptedSttSession:
    """Emits exactly the events the test writes, in order.

    The mock STT adapter drives its cadence off audio time, which is right for a
    smoke test and useless here: this test needs one utterance split into a
    known number of chunks, with nothing else in the stream."""

    def __init__(self, lang: Lang) -> None:
        self._lang = lang
        self._queue: asyncio.Queue = asyncio.Queue()

    def emit(self, kind: str, text: str = "") -> None:
        self._queue.put_nowait(
            SttEvent(
                type=kind,  # type: ignore[arg-type]
                text=text,
                lang=self._lang,
                start=0.0,
                end=0.0,
                confidence=0.99 if kind == "final" else 0.5,
            )
        )

    def push_frame(self, frame) -> None:  # noqa: ANN001 - the test feeds no audio
        return None

    async def flush(self) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[SttEvent]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[SttEvent]:
        while True:
            item = await self._queue.get()
            if item is None:
                return
            yield item

    async def aclose(self) -> None:
        self._queue.put_nowait(None)


class ScriptedSttProvider:
    name = "scripted"
    preferred_sample_rate = 16000
    preferred_num_channels = 1

    def __init__(self) -> None:
        self.session: ScriptedSttSession | None = None

    async def start(self, *, lang: Lang) -> ScriptedSttSession:
        self.session = ScriptedSttSession(lang)
        return self.session

    async def aclose(self) -> None:
        if self.session is not None:
            await self.session.aclose()


def make_direction(store: EvalLogStore, call_id: str) -> tuple[Direction, ScriptedSttProvider, object]:
    stt = ScriptedSttProvider()
    eval_log = store.open_call(call_id, header=None)
    direction = Direction(
        call_id=call_id,
        speaker=ALEX,
        listener=NOA,
        stt=stt,  # type: ignore[arg-type]
        mt=build_mt("mock", CFG),
        tts=MockTtsProvider(realtime=False, ttfb_s=0.0),
        sink=CollectingAudioSink(),
        emitter=SubtitleEmitter(
            transport=CollectingTextTransport(),
            call_id=call_id,
            mode="TRANSLATED",
            providers=CFG.providers,
        ),
        # One committed chunk per stabilised word, and no timer may commit
        # anything: the test decides where the chunk boundaries are.
        chunker_config=ChunkerConfig(
            min_words=1,
            weak_boundary_min_words=1,
            max_silence_ms=10**6,
            end_of_turn_ms=10**6,
            timeout_ms=10**6,
        ),
        eval_log=eval_log,
    )
    return direction, stt, eval_log


async def speak_four_words(session: ScriptedSttSession, words: list[str]) -> None:
    """LocalAgreement commits a word once a second hypothesis repeats it, so
    four growing partials plus the final produce four one-word chunks."""
    session.emit("speech_start")
    for i in range(1, len(words) + 1):
        session.emit("partial", " ".join(words[:i]))
    session.emit("final", " ".join(words))


# --------------------------------------------------------------- the writer


async def test_every_chunk_of_one_utterance_carries_the_same_key(tmp_path):
    store = EvalLogStore(tmp_path)
    direction, stt, eval_log = make_direction(store, "c_key0001")
    await direction.start()
    try:
        assert stt.session is not None
        await speak_four_words(stt.session, ["яблоко", "груша", "слива", "банан"])
        assert await wait_for(lambda: direction.stats.units_spoken >= 4, timeout=15.0)
    finally:
        await direction.aclose()
        await eval_log.aclose()

    rows = [r for r in await store.read_records("c_key0001") if r["kind"] == "utterance"]
    assert len(rows) == 4, f"expected one chunk per word, got {[r['srcText'] for r in rows]}"

    assert len({r["utteranceKey"] for r in rows}) == 1, "one utterance must have one key"
    assert [r["isFirstChunk"] for r in rows] == [True, False, False, False]
    # The reason a key had to be added at all: the id that already existed is
    # per chunk, and segmentId - the other candidate - differs between adjacent
    # chunks of the SAME utterance.
    assert len({r["utteranceId"] for r in rows}) == 4
    assert len({r["segmentId"] for r in rows}) == 4

    # The metric that was being counted four times is present once.
    anchored = [r for r in rows if r["isFirstChunk"]]
    assert len(anchored) == 1
    assert anchored[0]["latency"]["speech_start_to_first_partial_ms"] is not None


async def test_a_new_utterance_gets_a_new_key(tmp_path):
    """The key has to change when the speech-start anchor does, or two sentences
    would merge into one sample."""
    store = EvalLogStore(tmp_path)
    direction, stt, eval_log = make_direction(store, "c_key0002")
    await direction.start()
    try:
        assert stt.session is not None
        await speak_four_words(stt.session, ["яблоко", "груша", "слива", "банан"])
        assert await wait_for(lambda: direction.stats.units_spoken >= 4, timeout=15.0)
        await speak_four_words(stt.session, ["стол", "окно", "дверь", "полка"])
        assert await wait_for(lambda: direction.stats.units_spoken >= 8, timeout=15.0)
    finally:
        await direction.aclose()
        await eval_log.aclose()

    rows = [r for r in await store.read_records("c_key0002") if r["kind"] == "utterance"]
    keys = [r["utteranceKey"] for r in rows]
    assert len(set(keys)) == 2, f"two utterances must produce two keys, got {keys}"
    assert sum(1 for r in rows if r["isFirstChunk"]) == 2
    # One first chunk per key, never two.
    for key in set(keys):
        assert sum(1 for r in rows if r["utteranceKey"] == key and r["isFirstChunk"]) == 1


async def test_two_utterances_a_fraction_of_a_millisecond_apart_get_two_keys(tmp_path):
    """The key was `utt_<speaker>@<ms since call start>` and nothing else, so two
    utterances whose speech starts rounded to the same millisecond collapsed into
    one. That is not exotic: a `final` immediately followed by the next
    `speech_start` is what every buffered or replayed STT stream produces, and
    the events below are consumed without anything advancing the clock between
    them. The log then carried TWO first chunks under one key - one utterance in
    the counts, two samples in every utterance-basis percentile."""
    store = EvalLogStore(tmp_path)
    direction, stt, eval_log = make_direction(store, "c_key0003")
    await direction.start()
    try:
        assert stt.session is not None
        session = stt.session
        # Both utterances queued before the STT loop reads any of them.
        session.emit("speech_start")
        session.emit("partial", "яблоко")
        session.emit("partial", "яблоко груша")
        session.emit("final", "яблоко груша")
        session.emit("speech_start")
        session.emit("partial", "стол")
        session.emit("partial", "стол окно")
        session.emit("final", "стол окно")
        assert await wait_for(lambda: direction.stats.units_spoken >= 4, timeout=15.0)
    finally:
        await direction.aclose()
        await eval_log.aclose()

    rows = [r for r in await store.read_records("c_key0003") if r["kind"] == "utterance"]
    keys = [r["utteranceKey"] for r in rows]
    assert len(set(keys)) == 2, f"two utterances, two keys - got {keys}"
    for key in set(keys):
        firsts = sum(1 for r in rows if r["utteranceKey"] == key and r["isFirstChunk"])
        assert firsts == 1, f"key {key} carries {firsts} first chunks, must carry exactly 1"


async def test_a_final_that_revises_the_text_does_not_mint_a_second_first_chunk(tmp_path):
    """A provider is allowed to rewrite its own hypothesis in the final. When it
    does, the chunker commits the tail as a further chunk of the SAME utterance -
    the speech-start anchor has not moved - so the first-chunk mark must stay on
    the chunk that was committed first."""
    store = EvalLogStore(tmp_path)
    direction, stt, eval_log = make_direction(store, "c_key0004")
    await direction.start()
    try:
        assert stt.session is not None
        session = stt.session
        session.emit("speech_start")
        session.emit("partial", "мне")
        session.emit("partial", "мне тебя")
        # The final disagrees with the partials about everything after the first
        # word, which is exactly what a revision looks like on the wire.
        session.emit("final", "мне тебя в наушниках не слышно")
        assert await wait_for(lambda: direction.stats.units_spoken >= 2, timeout=15.0)
    finally:
        await direction.aclose()
        await eval_log.aclose()

    rows = [r for r in await store.read_records("c_key0004") if r["kind"] == "utterance"]
    assert len(rows) >= 2, [r["srcText"] for r in rows]
    assert len({r["utteranceKey"] for r in rows}) == 1, "a revision is not a new utterance"
    assert sum(1 for r in rows if r["isFirstChunk"]) == 1
    assert rows[0]["isFirstChunk"] is True
    assert all(r["isFirstChunk"] is False for r in rows[1:])


# --------------------------------------------------------------- the readers

CALL_ID = "c_chunks0001"
ALEX_P = {"userId": "u_alex", "displayName": "Alex", "lang": "ru", "gender": "m", "tone": "neutral"}
NOA_P = {"userId": "u_noa", "displayName": "Noa", "lang": "he", "gender": "f", "tone": "friendly"}


def chunk_row(index: int, *, first: bool, first_audio: float, mt_ms: float) -> dict:
    """One chunk of ONE three-chunk utterance, shaped exactly as the agent
    writes it: the speech-start latencies grow with the chunk index because they
    are measured from the start of the utterance, not of the chunk."""
    return utterance_record(
        call_id=CALL_ID,
        utterance_id=f"utt_u_alex_{index:06d}",
        utterance_key="utt_u_alex@1500",
        is_first_chunk=first,
        segment_id=f"seg_u_alex_{index:06d}",
        speaker=ALEX_P,
        listener=NOA_P,
        src_lang="ru",
        dst_lang="he",
        src_text=f"слово{index}",
        dst_text=f"מילה{index}",
        providers={"stt": "mock", "mt": "mock", "tts": "mock"},
        latency={
            "speech_start_to_first_partial_ms": 220.0,
            "first_partial_to_commit_ms": 400.0 * index,
            "commit_to_mt_done_ms": 90.0,
            "mt_provider_latency_ms": mt_ms,
            "mt_done_to_first_audio_ms": 190.0,
            "speech_start_to_first_audio_ms": first_audio,
            "tts_audio_ms": 300.0,
        },
        trigger="min_words",
        words=1,
        t_start=1.5 * index,
        t_end=1.5 * index + 0.5,
        cancelled=False,
        error=None,
    )


@pytest.fixture
def three_chunk_log(tmp_path) -> Path:
    """One utterance, three chunks. Per-chunk aggregation of the first-audio
    metric would answer 1800 ms (the median of the three rows); the delay the
    listener actually perceived is the 900 ms on the first chunk."""
    path = tmp_path / f"{CALL_ID}.jsonl"
    lines = [
        call_header_record(
            call_id=CALL_ID,
            room_name=f"call-{CALL_ID}",
            mode="TRANSLATED",
            providers={"stt": "mock", "mt": "mock", "tts": "mock"},
            participants=[ALEX_P, NOA_P],
        ),
        chunk_row(1, first=True, first_audio=900.0, mt_ms=60.0),
        chunk_row(2, first=False, first_audio=1800.0, mt_ms=70.0),
        chunk_row(3, first=False, first_audio=2700.0, mt_ms=80.0),
    ]
    path.write_text(
        "\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n", encoding="utf-8"
    )
    return path


def test_python_reader_takes_one_first_audio_sample_per_utterance(three_chunk_log, capsys):
    cli = load_cli()
    assert cli.main([str(three_chunk_log), "--json"]) == 0
    data = json.loads(capsys.readouterr().out)

    e2e = data["latency"]["speech_start_to_first_audio_ms"]
    assert e2e["n"] == 1, "three chunks of one utterance are ONE end-to-end sample"
    assert e2e["p50"] == 900.0, "the p50 must be the first chunk's delay, not the median of three"
    assert e2e["basis"] == "utterance"

    mt = data["latency"]["mt_provider_latency_ms"]
    assert mt["n"] == 3, "an MT call happens per chunk and stays per chunk"
    assert mt["p50"] == 70.0
    assert mt["basis"] == "chunk"

    # The metric that was published three times is now one sample too.
    assert data["latency"]["speech_start_to_first_partial_ms"]["n"] == 1
    assert data["counts"]["utterances"] == 1
    assert data["counts"]["chunks"] == 3


def test_python_reader_prints_both_counts_and_names_the_basis(three_chunk_log, capsys):
    cli = load_cli()
    assert cli.main([str(three_chunk_log), "--no-color"]) == 0
    out = capsys.readouterr().out

    assert "utterances           : 1" in out
    assert "chunks committed     : 3" in out
    # Nobody may read a per-chunk number as a per-utterance one by accident.
    assert "1 delivered utterance(s) in 3 delivered chunk(s)" in out
    assert "basis" in out
    assert "FIRST committed chunk only" in out


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_node_reader_agrees_with_the_python_one(three_chunk_log):
    """Two readers, one log, one BASIS. They disagreed about what a sample is
    until now.

    They still do not agree about which rows are eligible: review_call.py drops
    cancelled and errored chunks ("what did the listener get"), review-call.mjs
    keeps them ("what did the pipeline do"). Every row of this fixture is
    delivered, so here the two answers coincide; the call where they do not is
    pinned in test_the_two_readers_diverge_on_cancelled_chunks_and_both_say_so."""
    result = subprocess.run(
        ["node", str(_NODE_CLI), str(three_chunk_log), "--json"],
        capture_output=True,
        text=True,
        cwd=str(_REPO_ROOT),
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)

    assert data["counts"]["utterances"] == 1
    assert data["counts"]["chunks"] == 3
    assert data["latency"]["e2e"]["n"] == 1
    assert data["latency"]["e2e"]["p50"] == 900.0
    assert data["latency"]["e2e"]["basis"] == "utterance"
    assert data["latency"]["mt"]["n"] == 3
    assert data["latency"]["mt"]["basis"] == "chunk"
    assert data["latency"]["stt"]["n"] == 1


def test_a_log_without_keys_is_read_exactly_as_before(tmp_path, capsys):
    """Every log recorded so far - 27.08.2026 included - has no key, and none can
    be repaired after the fact. They must still open, with one utterance per row
    and a note saying so."""
    path = tmp_path / "c_legacy.jsonl"
    rows = []
    for index in (1, 2):
        row = chunk_row(index, first=index == 1, first_audio=900.0 * index, mt_ms=60.0)
        row.pop("utteranceKey")
        row.pop("isFirstChunk")
        rows.append(row)
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8"
    )

    cli = load_cli()
    assert cli.main([str(path), "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["counts"]["utterances"] == 2
    assert data["counts"]["chunks"] == 2
    assert data["latency"]["speech_start_to_first_audio_ms"]["n"] == 2

    assert cli.main([str(path), "--no-color"]) == 0
    assert "predates the per-utterance key" in capsys.readouterr().out


def cancelled_chunk_row(index: int, *, first: bool) -> dict:
    """A chunk that was cancelled by a barge-in: no destination text and no
    end-to-end number, because the listener never heard it."""
    row = chunk_row(index, first=first, first_audio=900.0, mt_ms=60.0)
    row["dstText"] = ""
    row["cancelled"] = True
    row["latency"]["speech_start_to_first_audio_ms"] = None
    return row


@pytest.fixture
def barge_in_log(tmp_path) -> Path:
    """One utterance, three chunks, and the FIRST one cancelled by a barge-in.

    The utterance is still delivered - two of its chunks reached the listener -
    but the only row an utterance-basis percentile is allowed to sample is gone.
    Nothing about the numbers themselves says so."""
    path = tmp_path / f"{CALL_ID}.jsonl"
    lines = [
        call_header_record(
            call_id=CALL_ID,
            room_name=f"call-{CALL_ID}",
            mode="TRANSLATED",
            providers={"stt": "mock", "mt": "mock", "tts": "mock"},
            participants=[ALEX_P, NOA_P],
        ),
        cancelled_chunk_row(1, first=True),
        chunk_row(2, first=False, first_audio=1800.0, mt_ms=70.0),
        chunk_row(3, first=False, first_audio=2700.0, mt_ms=80.0),
    ]
    path.write_text(
        "\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n", encoding="utf-8"
    )
    return path


def test_an_utterance_that_lost_its_first_chunk_is_counted_and_explained(barge_in_log, capsys):
    """A delivered utterance contributing ZERO samples must not look like a log
    that is missing the metric. It happens on any call with a barge-in."""
    cli = load_cli()
    assert cli.main([str(barge_in_log), "--json"]) == 0
    data = json.loads(capsys.readouterr().out)

    assert data["counts"]["utterances"] == 1
    # The whole utterance-basis column is empty although one utterance was
    # delivered - and the JSON now says why, rather than leaving a reader to
    # guess that the writer stopped emitting the metric.
    assert data["latency"]["speech_start_to_first_audio_ms"]["n"] == 0
    assert data["counts"]["deliveredUtterancesWithoutFirstChunk"] == 1
    assert data["counts"]["utterancesWithDuplicateFirstChunk"] == 0

    assert cli.main([str(barge_in_log), "--no-color"]) == 0
    out = capsys.readouterr().out
    assert "no first chunk among the delivered rows" in out
    assert "contribute NOTHING" in out


def test_a_log_with_a_duplicated_first_chunk_is_flagged(tmp_path, capsys):
    """Logs written before the key was unique per utterance are already on disk
    and cannot be repaired. Two utterances that shared a key are one line in the
    counts and two samples in the percentiles, and the reader has to say so."""
    path = tmp_path / "c_dup.jsonl"
    rows = [chunk_row(1, first=True, first_audio=900.0, mt_ms=60.0),
            chunk_row(2, first=True, first_audio=1500.0, mt_ms=70.0)]
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8"
    )
    cli = load_cli()
    assert cli.main([str(path), "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["counts"]["utterances"] == 1
    assert data["latency"]["speech_start_to_first_audio_ms"]["n"] == 2
    assert data["counts"]["utterancesWithDuplicateFirstChunk"] == 1

    assert cli.main([str(path), "--no-color"]) == 0
    assert "MORE THAN ONE first chunk" in capsys.readouterr().out


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_the_two_readers_diverge_on_cancelled_chunks_and_both_say_so(barge_in_log, capsys):
    """Pinned, not fixed. The readers share the utterance/chunk BASIS but not the
    eligibility set, so on a call with a barge-in they report different n - and
    that is the one thing a founder holding both reports must be told."""
    cli = load_cli()
    assert cli.main([str(barge_in_log), "--json"]) == 0
    py = json.loads(capsys.readouterr().out)

    result = subprocess.run(
        ["node", str(_NODE_CLI), str(barge_in_log), "--json"],
        capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=60,
    )
    assert result.returncode == 0, result.stderr
    js = json.loads(result.stdout)

    # review_call.py drops the cancelled chunk; review-call.mjs keeps it.
    assert py["latency"]["mt_provider_latency_ms"]["n"] == 2
    assert js["latency"]["mt"]["n"] == 3
    assert js["counts"]["cancelledOrErroredChunks"] == 1

    assert cli.main([str(barge_in_log), "--no-color"]) == 0
    assert "no first chunk among the delivered rows" in capsys.readouterr().out

    text = subprocess.run(
        ["node", str(_NODE_CLI), str(barge_in_log)],
        capture_output=True, text=True, cwd=str(_REPO_ROOT), timeout=60,
    ).stdout
    assert "review_call.py drops" in text
    # And it must not blame the writer for a metric the writer did emit.
    assert "the writer is not emitting e2e_ms" not in text
