from __future__ import annotations

import asyncio

from speakeasy_agent.acoustic_shadow import (
    AcousticWindowResult,
    LiveAcousticPruningCollector,
)
from speakeasy_agent.providers.base import SttEvent
from speakeasy_agent.speculation import PredictionCandidate, PredictionResult


class FakeEvalLog:
    def __init__(self) -> None:
        self.records: list[dict] = []

    def append(self, record: dict) -> None:
        self.records.append(record)


class FakePruner:
    def __init__(self) -> None:
        self.windows: list[int] = []
        self.closed = False

    async def prune(self, *, lang, pcm_s16le, candidates):
        window_ms = len(pcm_s16le) // 2 / 16000 * 1000
        self.windows.append(round(window_ms))
        ranked = tuple(
            {
                "rank": index,
                "word": candidate.word,
                "probability": candidate.probability,
                "acoustic_score": 1.0 if candidate.word == "купить" else 0.1,
                "combined_score": 1.0 if candidate.word == "купить" else 0.1,
            }
            for index, candidate in enumerate(
                sorted(candidates, key=lambda item: item.word != "купить"), start=1
            )
        )
        await asyncio.sleep(0)
        return AcousticWindowResult(
            window_ms=round(window_ms),
            evidence="ку",
            raw_evidence="ку",
            inference_ms=7.0,
            ranked=ranked,
            round_trip_ms=11.0,
        )

    async def aclose(self):
        self.closed = True


class BlockingPruner(FakePruner):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def prune(self, *, lang, pcm_s16le, candidates):
        self.started.set()
        await self.release.wait()
        return await super().prune(lang=lang, pcm_s16le=pcm_s16le, candidates=candidates)


def _prediction() -> PredictionResult:
    return PredictionResult(
        candidates=(
            PredictionCandidate("сказать", 0.6),
            PredictionCandidate("купить", 0.3),
            PredictionCandidate("увидеть", 0.1),
        ),
        model="fake-qwen",
        model_latency_ms=10.0,
        round_trip_ms=12.0,
    )


async def test_live_collector_scores_arm_relative_windows_and_truth_rank():
    log = FakeEvalLog()
    pruner = FakePruner()
    collector = LiveAcousticPruningCollector(
        call_id="call-live",
        lang="ru",
        eval_log=log,  # type: ignore[arg-type]
        client=pruner,
        windows_ms=(50, 100, 200),
        every_n=1,
    )

    arm_id = collector.arm("я хочу")
    assert arm_id == 1
    collector.predictor_result(arm_id, _prediction())

    # 200 ms at 16 kHz, mono s16le.
    collector.feed_pcm(b"\x00\x00" * 3200)
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    # One partial alone is not trusted. The following partial confirms word 3.
    collector.observe_stt(
        SttEvent(type="partial", text="я хочу купить", lang="ru", start=0.0, end=0.4)
    )
    collector.observe_stt(
        SttEvent(type="partial", text="я хочу купить машину", lang="ru", start=0.0, end=0.6)
    )
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    records = [r for r in log.records if r.get("kind") == "acoustic_pruning_shadow"]
    assert len(records) == 1
    record = records[0]
    assert record["reference"] == "prediction_arm"
    assert record["actualNextWord"] == "купить"
    assert [row["windowMs"] for row in record["windows"]] == [50, 100, 200]
    assert all(row["truthRank"] == 1 for row in record["windows"])
    assert all(row["retained"]["top3"] for row in record["windows"])
    assert all(row["roundTripMs"] == 11.0 for row in record["windows"])
    assert pruner.windows == [50, 100, 200]

    await collector.aclose()
    assert pruner.closed is True


def test_live_collector_sampling_and_single_active_guard():
    collector = LiveAcousticPruningCollector(
        call_id="call-sampling",
        lang="he",
        eval_log=None,
        client=FakePruner(),
        every_n=2,
        max_active=1,
    )
    # Attempt 1 sampled and occupies the only active slot.
    assert collector.arm("אני רוצה") == 1
    # Attempt 2 skipped by every_n.
    assert collector.arm("אני רוצה לדבר") is None
    # Attempt 3 would be sampled, but max_active prevents a second GPU probe.
    assert collector.arm("אני רוצה לדבר עכשיו") is None


async def test_terminal_arm_with_running_score_still_counts_against_max_active():
    pruner = BlockingPruner()
    collector = LiveAcousticPruningCollector(
        call_id="call-blocked",
        lang="ru",
        eval_log=None,
        client=pruner,
        windows_ms=(50,),
        every_n=1,
        max_active=1,
    )
    arm_id = collector.arm("я хочу")
    assert arm_id == 1
    collector.predictor_result(arm_id, _prediction())
    collector.feed_pcm(b"\x00\x00" * 800)  # 50 ms
    await asyncio.wait_for(pruner.started.wait(), timeout=1.0)

    # Mark the first arm terminal while its HTTP/GPU probe is still running.
    collector.observe_stt(
        SttEvent(type="final", text="я хочу", lang="ru", start=0.0, end=0.4)
    )
    assert collector.arm("другой префикс") is None

    pruner.release.set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    await collector.aclose()


async def test_close_forces_resolved_short_audio_into_incomplete_record():
    log = FakeEvalLog()
    collector = LiveAcousticPruningCollector(
        call_id="call-close",
        lang="ru",
        eval_log=log,  # type: ignore[arg-type]
        client=FakePruner(),
        windows_ms=(50, 200),
        every_n=1,
    )
    arm_id = collector.arm("я хочу")
    assert arm_id == 1
    collector.predictor_result(arm_id, _prediction())
    collector.feed_pcm(b"\x00\x00" * 800)  # only 50 ms, not enough to start scoring

    arm_time = collector._arms[0].armed_at
    collector.observe_stt(
        SttEvent(type="partial", text="я хочу купить", lang="ru", start=0.0, end=0.4),
        now=arm_time + 0.4,
    )
    collector.observe_stt(
        SttEvent(type="partial", text="я хочу купить машину", lang="ru", start=0.0, end=0.6),
        now=arm_time + 0.5,
    )
    assert log.records == []

    await collector.aclose()
    assert len(log.records) == 1
    record = log.records[0]
    assert record["status"] == "closed_incomplete"
    assert record["actualNextWord"] == "купить"
    assert record["windows"] == []


async def test_live_lead_uses_client_round_trip_not_model_inference():
    log = FakeEvalLog()
    collector = LiveAcousticPruningCollector(
        call_id="call-rtt",
        lang="ru",
        eval_log=log,  # type: ignore[arg-type]
        client=FakePruner(),
        windows_ms=(50,),
        every_n=1,
    )
    arm_id = collector.arm("я хочу")
    assert arm_id == 1
    arm_time = collector._arms[0].armed_at
    collector.predictor_result(arm_id, _prediction())
    collector.feed_pcm(b"\x00\x00" * 800)
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    collector.observe_stt(
        SttEvent(type="partial", text="я хочу купить", lang="ru", start=0.0, end=0.4),
        now=arm_time + 0.3,
    )
    collector.observe_stt(
        SttEvent(type="partial", text="я хочу купить машину", lang="ru", start=0.0, end=0.6),
        now=arm_time + 0.4,
    )
    await asyncio.sleep(0)
    row = log.records[0]["windows"][0]
    # 400 ms to STT stability - 50 ms evidence window - 11 ms client RTT.
    assert row["estimatedLeadVsSttMs"] == 339.0
    # If inferenceMs had been used instead, this would incorrectly be 343 ms.
    assert row["inferenceMs"] == 7.0
    assert row["roundTripMs"] == 11.0
    await collector.aclose()
