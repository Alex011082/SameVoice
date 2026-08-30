"""Wait accounting for the GPU-bound section of the two latency-critical services.

These tests exist because the previous "measurement" was structurally incapable
of failing: neither `gpu.predictor.app` nor `gpu.acoustic.prune_app` bounded GPU
concurrency (both offloaded to a thread pool, which admits every caller at
once), so nothing ever queued and any `queue_wait_ms` they published would have
read ~0 by construction, making any threshold on it unfalsifiable. Nothing here
covers contention *between* the two services: each semaphore is process-local. A fake
engine with a known blocking duration is the only way to assert the split on
CPU-only CI: it gives an expected value for `inference_ms`, so a `queue_wait_ms`
that quietly absorbed model time would be visible.
"""

from __future__ import annotations

import asyncio
import base64
import sys
import threading
import time
from pathlib import Path

import pytest

# Agent tests run with cwd=agent/, while the GPU R&D package intentionally lives
# at the repository root and is not installed into the realtime agent venv.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from gpu.queueing import GpuQueue, RequestTiming, concurrency_from_env  # noqa: E402

# Long enough that a queued request cannot be confused with scheduler jitter,
# short enough to keep the offline suite fast.
FAKE_INFERENCE_S = 0.15
FAKE_INFERENCE_MS = FAKE_INFERENCE_S * 1000.0

# CPU-only CI runners are noisy; every bound below is one-sided and generous, so
# a failure means the accounting is wrong rather than that the box was busy.
JITTER_MS = 90.0

_NEEDS_FASTAPI = "the GPU HTTP surfaces need fastapi, which the realtime agent venv does not install"


class FakeSlowEngine:
    """Stands in for a CTC forward pass or a beam search of known duration.

    It blocks with `time.sleep` rather than `await asyncio.sleep` on purpose:
    the real engines hold a worker thread, and only a blocking call proves the
    handler actually offloaded the work instead of stalling the event loop.
    """

    def __init__(self, duration_s: float = FAKE_INFERENCE_S) -> None:
        self.duration_s = duration_s
        self._lock = threading.Lock()
        self._running = 0
        self.max_concurrent = 0
        self.calls = 0

    def infer(self, marker: str) -> str:
        with self._lock:
            self._running += 1
            self.calls += 1
            self.max_concurrent = max(self.max_concurrent, self._running)
        time.sleep(self.duration_s)
        with self._lock:
            self._running -= 1
        return marker


async def _submit(queue: GpuQueue, engine: FakeSlowEngine, marker: str):
    entered_at = time.perf_counter()
    return await queue.run(engine.infer, marker, entered_at=entered_at)


async def test_second_concurrent_request_reports_a_real_queue_wait():
    queue = GpuQueue("test-predictor", limit=1)
    engine = FakeSlowEngine()

    results = await asyncio.gather(
        _submit(queue, engine, "first"),
        _submit(queue, engine, "second"),
    )
    timings = sorted((timing for _result, timing in results), key=lambda t: t.queue_wait_ms)
    served_first, queued = timings

    # One card, one inference: if this is 2 the semaphore is not doing its job
    # and every wait number below is meaningless.
    assert engine.max_concurrent == 1
    assert engine.calls == 2

    assert served_first.queue_wait_ms < JITTER_MS
    # The whole point: the queued request waited roughly one inference, and that
    # wait is attributed to the queue instead of inflating the model number.
    assert queued.queue_wait_ms > 0.8 * FAKE_INFERENCE_MS
    for timing in timings:
        assert timing.inference_ms >= 0.9 * FAKE_INFERENCE_MS
        assert timing.inference_ms <= FAKE_INFERENCE_MS + JITTER_MS
        assert timing.total_ms() >= timing.queue_wait_ms + timing.inference_ms


async def test_raising_the_limit_removes_the_wait():
    # Guards the env knob: if the limit were ignored, this test would show the
    # same serialisation as the one above and the default of 1 would be a lie.
    queue = GpuQueue("test-predictor", limit=2)
    engine = FakeSlowEngine()

    results = await asyncio.gather(
        _submit(queue, engine, "first"),
        _submit(queue, engine, "second"),
    )
    assert engine.max_concurrent == 2
    for _result, timing in results:
        assert timing.queue_wait_ms < JITTER_MS


async def test_the_card_is_released_before_the_response_is_built():
    queue = GpuQueue("test-pruner", limit=1)
    engine = FakeSlowEngine(0.02)
    serialisation_s = 0.25

    async def worker(marker: str, post_work_s: float):
        entered_at = time.perf_counter()
        _result, timing = await queue.run(engine.infer, marker, entered_at=entered_at)
        # Stand-in for ranking + JSON serialisation, which touch no GPU.
        await asyncio.sleep(post_work_s)
        return timing

    _first, second = await asyncio.gather(
        worker("first", serialisation_s),
        worker("second", 0.0),
    )
    # The second request waited for one 20 ms inference, not for the first
    # request's 250 ms of response building. Holding the semaphore across
    # serialisation would re-label that CPU cost as GPU queue time.
    assert second.queue_wait_ms < serialisation_s * 1000.0


async def test_a_cancelled_caller_does_not_hand_the_card_to_the_next_request():
    # A benchmark client hitting its timeout makes uvicorn cancel the handler
    # task, but `asyncio.to_thread` cannot be cancelled: the forward pass keeps
    # running on the card. If the semaphore were released on cancellation, the
    # next request would start a second inference on a busy GPU and report
    # `queue_wait_ms ~ 0` for it.
    queue = GpuQueue("test-cancelled", limit=1)
    engine = FakeSlowEngine()

    abandoned = asyncio.ensure_future(_submit(queue, engine, "abandoned"))
    await asyncio.sleep(0.02)
    abandoned.cancel()
    with pytest.raises(asyncio.CancelledError):
        await abandoned

    _result, timing = await _submit(queue, engine, "next")

    # Two calls really reached the engine, and they did not overlap.
    assert engine.calls == 2
    assert engine.max_concurrent == 1
    # The survivor waited for the abandoned thread instead of joining it.
    assert timing.queue_wait_ms > 0.5 * FAKE_INFERENCE_MS


def test_queue_survives_a_second_event_loop():
    # pytest gives every test its own loop while uvicorn gives the process one.
    # A queue that bound its semaphore to the first loop forever would raise on
    # the second, and both services share one module-level queue object across
    # the whole test session.
    queue = GpuQueue("test-shared", limit=1)
    engine = FakeSlowEngine(0.01)
    assert asyncio.run(_submit(queue, engine, "loop-a"))[0] == "loop-a"
    assert asyncio.run(_submit(queue, engine, "loop-b"))[0] == "loop-b"


def test_concurrency_from_env_defaults_to_one_and_rejects_nonsense(monkeypatch):
    monkeypatch.delenv("SAMEVOICE_TEST_CONCURRENCY", raising=False)
    assert concurrency_from_env("SAMEVOICE_TEST_CONCURRENCY") == 1
    monkeypatch.setenv("SAMEVOICE_TEST_CONCURRENCY", "3")
    assert concurrency_from_env("SAMEVOICE_TEST_CONCURRENCY") == 3
    monkeypatch.setenv("SAMEVOICE_TEST_CONCURRENCY", "0")
    with pytest.raises(ValueError, match=">= 1"):
        concurrency_from_env("SAMEVOICE_TEST_CONCURRENCY")
    monkeypatch.setenv("SAMEVOICE_TEST_CONCURRENCY", "two")
    with pytest.raises(ValueError, match=">= 1"):
        concurrency_from_env("SAMEVOICE_TEST_CONCURRENCY")


async def test_pruner_endpoint_splits_queue_from_inference(monkeypatch):
    pytest.importorskip("fastapi", reason=_NEEDS_FASTAPI)
    from gpu.acoustic import prune_app
    from gpu.acoustic.pruner import EvidenceResult

    engine = FakeSlowEngine()

    class FakeCtcEngine:
        def infer(self, audio) -> EvidenceResult:
            engine.infer("prune")
            return EvidenceResult(
                evidence="ку",
                raw_text="ку",
                model="fake-ctc",
                inference_ms=FAKE_INFERENCE_MS,
                audio_ms=100.0,
            )

    monkeypatch.setattr(prune_app, "engine_for", lambda lang: FakeCtcEngine())
    request = prune_app.PruneRequest(
        lang="ru",
        pcm_s16le_b64=base64.b64encode(b"\x01\x00" * 1600).decode("ascii"),
        candidates=[{"word": "купить", "probability": 0.3}],
    )

    responses = await asyncio.gather(prune_app.prune(request), prune_app.prune(request))
    served_first, queued = sorted(responses, key=lambda item: item["queue_wait_ms"])

    assert engine.max_concurrent == 1
    assert served_first["queue_wait_ms"] < JITTER_MS
    assert queued["queue_wait_ms"] > 0.8 * FAKE_INFERENCE_MS
    for payload in (served_first, queued):
        assert payload["inference_ms"] <= FAKE_INFERENCE_MS + JITTER_MS
        assert payload["total_ms"] >= payload["queue_wait_ms"] + payload["inference_ms"]
        # The narrower forward-only number survives the rename instead of
        # being dropped, and ranking still happens -- off the card.
        assert payload["model_forward_ms"] == round(FAKE_INFERENCE_MS, 1)
        assert payload["ranked"][0]["word"] == "купить"


async def test_predictor_endpoint_splits_queue_from_inference(monkeypatch):
    pytest.importorskip("fastapi", reason=_NEEDS_FASTAPI)
    from gpu.predictor import app as predictor_app

    engine = FakeSlowEngine()

    def predict(req):
        engine.infer("predict")
        return predictor_app.PredictResponse(
            candidates=[predictor_app.Candidate(word="купить", probability=1.0, log_score=-0.4)],
            model="fake-lm",
            latency_ms=FAKE_INFERENCE_MS,
            beam_count=8,
        )

    monkeypatch.setattr(predictor_app.engine, "predict", predict)
    request = predictor_app.PredictRequest(prefix="я хочу", lang="ru", top_k=4)

    responses = await asyncio.gather(
        predictor_app.predict(request),
        predictor_app.predict(request),
    )
    served_first, queued = sorted(responses, key=lambda item: item.queue_wait_ms)

    assert engine.max_concurrent == 1
    assert served_first.queue_wait_ms < JITTER_MS
    assert queued.queue_wait_ms > 0.8 * FAKE_INFERENCE_MS
    for payload in (served_first, queued):
        assert payload.inference_ms <= FAKE_INFERENCE_MS + JITTER_MS
        assert payload.total_ms >= payload.queue_wait_ms + payload.inference_ms
        assert payload.candidates[0].word == "купить"


def test_published_total_is_never_smaller_than_its_published_parts():
    """The three numbers are rounded together, not independently.

    Every other test here asserts `total_ms >= queue_wait_ms + inference_ms` on
    the *published* dict, and on a real request that holds only because the raw
    total is sampled a microsecond or two after the raw sum ends. Rounding each
    of the three to 3 decimals on its own can move them up to 1.5 microseconds
    the wrong way, which is more than that margin on the predictor path -- and a
    published artifact saying the parts do not fit in the whole is not read as a
    rounding detail, it is read as "the split is wrong".

    The values below are the smallest case that reproduces it: both components
    round up, the whole rounds down.
    """
    timing = RequestTiming(
        entered_at=time.perf_counter(),
        queue_wait_ms=0.00051,
        inference_ms=0.00051,
    )
    metrics = timing.as_metrics()

    assert metrics["queue_wait_ms"] == 0.001
    assert metrics["inference_ms"] == 0.001
    assert metrics["total_ms"] >= metrics["queue_wait_ms"] + metrics["inference_ms"]
    # Clamping must not invent latency beyond the sub-microsecond slack it
    # exists to absorb.
    assert metrics["total_ms"] <= 1.0
