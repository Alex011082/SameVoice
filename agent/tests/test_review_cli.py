"""The review CLI, against a log produced by the real pipeline in mock mode.

The CLI is stdlib-only and lives in scripts/, so it is imported by path here the
same way a human runs it.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from speakeasy_agent.evallog import (
    EvalLogStore,
    call_header_record,
    utterance_record,
    verdict_record,
)

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "review_call.py"


def load_cli():
    spec = importlib.util.spec_from_file_location("review_call", _SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CALL_ID = "c_review0001"
ALEX = {"userId": "u_alex", "displayName": "Alex", "lang": "ru", "gender": "m", "tone": "neutral"}
NOA = {"userId": "u_noa", "displayName": "Noa", "lang": "he", "gender": "f", "tone": "friendly"}


def unit(uid, src, dst, *, speaker=ALEX, listener=NOA, e2e=1300.0, **kw):
    return utterance_record(
        call_id=CALL_ID,
        utterance_id=uid,
        # One chunk per utterance in this fixture; the multi-chunk case has its
        # own file (test_utterance_percentiles.py).
        utterance_key=kw.pop("utterance_key", uid),
        is_first_chunk=kw.pop("is_first_chunk", True),
        segment_id=f"seg_{uid}",
        speaker=speaker,
        listener=listener,
        src_lang=speaker["lang"],
        dst_lang=listener["lang"],
        src_text=src,
        dst_text=dst,
        providers={"stt": "mock", "mt": "mock", "tts": "mock"},
        latency={
            "speech_start_to_first_partial_ms": 220.0,
            "first_partial_to_commit_ms": 500.0,
            "commit_to_mt_done_ms": 90.0,
            "mt_provider_latency_ms": 85.0,
            "mt_done_to_first_audio_ms": 190.0,
            "speech_start_to_first_audio_ms": e2e,
            "tts_audio_ms": 1400.0,
        },
        trigger="final",
        words=5,
        t_start=kw.pop("t_start", 0.4),
        t_end=kw.pop("t_end", 2.0),
        cancelled=kw.pop("cancelled", False),
        error=kw.pop("error", None),
    )


@pytest.fixture
async def session_log(tmp_path):
    store = EvalLogStore(tmp_path)
    log = store.open_call(
        CALL_ID,
        header=call_header_record(
            call_id=CALL_ID,
            room_name=f"call-{CALL_ID}",
            mode="TRANSLATED",
            providers={"stt": "mock", "mt": "mock", "tts": "mock"},
            participants=[ALEX, NOA],
        ),
    )
    log.append(unit("utt_u_alex_000001", "привет, ты меня слышишь", "שלום, את שומעת אותי", e2e=1200.0))
    log.append(
        unit(
            "utt_u_noa_000001",
            "כן, אני שומעת אותך",
            "да, я тебя слышу",
            speaker=NOA,
            listener=ALEX,
            e2e=1500.0,
            t_start=3.0,
        )
    )
    log.append(unit("utt_u_alex_000002", "давай встретимся завтра", "", error="mt: boom", t_start=6.0))
    log.append(
        unit("utt_u_alex_000003", "я приду позже", "אני אבוא מאוחר יותר", e2e=1800.0, t_start=9.0)
    )
    await log.aclose()
    await store.append_verdict(
        CALL_ID,
        verdict_record(
            call_id=CALL_ID,
            utterance_id="utt_u_alex_000001",
            verdict="wrong",
            expected="שלום, את שומעת אותי?",
            note="missing question intonation",
            by="u_noa",
        ),
    )
    await store.append_verdict(
        CALL_ID,
        verdict_record(
            call_id=CALL_ID, utterance_id="utt_u_alex_000003", verdict="ok", by="u_noa"
        ),
    )
    return store.path_for(CALL_ID)


async def test_the_report_shows_source_and_translation_side_by_side(session_log, capsys):
    cli = load_cli()
    assert cli.main([str(session_log), "--no-color"]) == 0
    out = capsys.readouterr().out

    assert "ru->he" in out and "he->ru" in out
    assert "стt=" not in out
    assert "stt=mock mt=mock tts=mock" in out
    # Both scripts must be present verbatim - never reordered, never mangled.
    assert "привет, ты меня слышишь" in out
    assert "שלום, את שומעת אותי" in out
    assert "כן, אני שומעת אותך" in out
    assert "да, я тебя слышу" in out
    # Direction must be unambiguous even when a terminal renders RTL badly.
    assert "ru SRC" in out and "he MT" in out
    assert "he SRC" in out and "ru MT" in out
    assert "MECHANICS" not in out
    assert "mock providers were in force" in out


async def test_flagged_utterances_are_highlighted_with_the_expected_text(session_log, capsys):
    cli = load_cli()
    cli.main([str(session_log), "--no-color"])
    out = capsys.readouterr().out
    assert "FLAGGED WRONG" in out
    assert "verdict WRONG by u_noa" in out
    assert "expected: שלום, את שומעת אותי?" in out
    assert "missing question intonation" in out
    assert "verdict OK by u_noa" in out


async def test_a_failed_translation_is_explained_not_left_blank(session_log, capsys):
    cli = load_cli()
    cli.main([str(session_log), "--no-color"])
    out = capsys.readouterr().out
    assert "nothing spoken: mt: boom" in out


async def test_latency_percentiles_and_counts(session_log, capsys):
    cli = load_cli()
    cli.main([str(session_log), "--no-color"])
    out = capsys.readouterr().out
    assert "END-TO-END perceived delay" in out
    assert "commit -> MT done" in out
    assert "utterances           : 4" in out
    assert "chunks committed     : 4" in out
    assert "delivered chunks     : 3" in out
    assert "provider errors      : 1" in out
    assert "flagged WRONG        : 1" in out
    assert "flag rate (of judged): 50%" in out
    # Accented Hebrew and native Russian are different experiments and must not
    # be averaged into one number.
    assert "ru->he" in out and "he->ru" in out


async def test_flagged_only_view(session_log, capsys):
    cli = load_cli()
    cli.main([str(session_log), "--no-color", "--flagged"])
    out = capsys.readouterr().out
    assert "שלום, את שומעת אותי" in out
    assert "אני אבוא מאוחר יותר" not in out


async def test_json_summary_is_machine_readable(session_log, capsys):
    cli = load_cli()
    assert cli.main([str(session_log), "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["callId"] == CALL_ID
    assert data["providers"] == {"stt": "mock", "mt": "mock", "tts": "mock"}
    assert data["counts"] == {
        "utterances": 4,
        "chunks": 4,
        # Both zero here on purpose: this fixture is one chunk per utterance and
        # every chunk is its own first. The cases that make them non-zero live in
        # test_utterance_percentiles.py.
        "deliveredUtterancesWithoutFirstChunk": 0,
        "utterancesWithDuplicateFirstChunk": 0,
        "delivered": 3,
        "cancelled": 0,
        "errors": 1,
        "verdicts": 2,
        "judged": 2,
        "wrong": 1,
    }
    assert data["flagRate"] == 0.5
    assert data["latency"]["speech_start_to_first_audio_ms"]["n"] == 3
    assert data["latency"]["speech_start_to_first_audio_ms"]["p50"] == 1500.0
    # The basis travels with the numbers, so a diff of two runs cannot silently
    # compare a per-utterance p50 against a per-chunk one.
    assert data["latency"]["speech_start_to_first_audio_ms"]["basis"] == "utterance"
    assert data["latency"]["mt_provider_latency_ms"]["basis"] == "chunk"


async def test_a_call_id_resolves_against_the_log_directory(session_log, capsys):
    cli = load_cli()
    assert cli.main([CALL_ID, "--dir", str(session_log.parent), "--no-color"]) == 0
    assert CALL_ID in capsys.readouterr().out


async def test_listing_and_missing_files(session_log, capsys):
    cli = load_cli()
    assert cli.main(["--list", "--dir", str(session_log.parent)]) == 0
    assert CALL_ID in capsys.readouterr().out

    assert cli.main(["c_nope", "--dir", str(session_log.parent)]) == 1
    assert "no such call log" in capsys.readouterr().err


async def test_isolate_wraps_rtl_without_reordering(session_log, capsys):
    cli = load_cli()
    cli.main([str(session_log), "--no-color", "--isolate"])
    out = capsys.readouterr().out
    assert cli.RLI + "שלום, את שומעת אותי" + cli.PDI in out
    # Codepoint order is never touched, only wrapped.
    assert "שלום, את שומעת אותי" in out


async def test_a_log_without_a_header_still_reports(tmp_path, capsys):
    """Older logs, or a call killed before the header flushed."""
    path = tmp_path / "c_bare.jsonl"
    path.write_text(
        json.dumps(unit("u1", "привет", "שלום"), ensure_ascii=False) + "\n", encoding="utf-8"
    )
    cli = load_cli()
    assert cli.main([str(path), "--no-color"]) == 0
    out = capsys.readouterr().out
    assert "older agent" in out
    assert "שלום" in out


async def test_an_orphan_verdict_is_reported_not_hidden(tmp_path, capsys):
    path = tmp_path / "c_orphan.jsonl"
    lines = [
        json.dumps(unit("u1", "привет", "שלום"), ensure_ascii=False),
        json.dumps(
            verdict_record(
                call_id="c_orphan", utterance_id="ghost", verdict="wrong", resolved=False
            ),
            ensure_ascii=False,
        ),
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    cli = load_cli()
    cli.main([str(path), "--no-color"])
    out = capsys.readouterr().out
    assert "could not be matched" in out


def test_percentiles_are_nearest_rank():
    cli = load_cli()
    assert cli.pct([], 0.5) is None
    assert cli.pct([10.0], 0.9) == 10.0
    assert cli.pct([1.0, 2.0, 3.0, 4.0], 0.5) == 2.0
    assert cli.pct([1.0, 2.0, 3.0, 4.0], 0.9) == 4.0
