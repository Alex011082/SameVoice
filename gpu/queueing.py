"""Admission control for the GPU-bound section of the latency-critical services.

Why this module exists: until it did, neither `gpu.predictor.app` nor
`gpu.acoustic.prune_app` bounded GPU concurrency. Both already ran the blocking
call off the event loop -- the pruner through `asyncio.to_thread`, the predictor
through Starlette's threadpool, which is what a non-`async def` path operation
gets -- but a thread pool is not admission control: it admits every arriving
request at once, up to tens of them. So nothing ever queued *in the process*,
any `queue_wait_ms` reported from them would have read ~0 by construction, and
any future threshold on it would have been unfalsifiable -- yet both services
are pinned to the same physical card (`ACOUSTIC_PRUNER_CUDA_VISIBLE_DEVICES=0`
and `PREDICTOR_CUDA_VISIBLE_DEVICES=0` in `docker/runpod-gpu.env.example`), and
one 4090 cannot serve two inferences at the same time.

What this module does **not** do: the semaphore lives inside one process, so it
serialises a service against itself and nothing more. A predictor forward pass
and a pruner forward pass still overlap on GPU 0, and that contention lands in
`inference_ms` with `queue_wait_ms ~ 0` in both processes. Attributing *that*
needs a cross-process gate (or one process owning the card); until then a
benchmark that drives 8101 and 8105 at once must be read as a measurement of
the pair, not of either service.

`docs/12-latency-timestamps.md` states the failure this fixes: a single latency
number cannot be split into "model" or "queue" by any later analysis of the log,
so the split has to be recorded at the moment it happens.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, TypeVar

T = TypeVar("T")

# One card, one inference. A limit above 1 does not make the GPU faster, it only
# interleaves two forward passes, and then neither the queue number nor the
# inference number can be read as physical time on the card.
DEFAULT_CONCURRENCY = 1


def concurrency_from_env(var: str, *, default: int = DEFAULT_CONCURRENCY) -> int:
    """Read a per-service GPU concurrency limit from the environment."""
    raw = (os.getenv(var) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{var} must be an integer >= 1, got {raw!r}") from exc
    if value < 1:
        raise ValueError(f"{var} must be an integer >= 1, got {value}")
    return value


@dataclass(frozen=True)
class RequestTiming:
    """Three numbers for one request, deliberately not one.

    `total_ms` is a method rather than a stored field because it must be sampled
    after the card has already been released. The remainder
    `total_ms - (queue_wait_ms + inference_ms)` is therefore the handler's own
    post-GPU work -- ranking, building the response object -- charged to the CPU
    instead of silently to the model. It is *not* the whole response cost: the
    stamp is taken while the handler assembles its return value, before uvicorn
    encodes and writes it, so JSON encoding and socket time are outside all
    three numbers and show up only in a client-side round trip.
    """

    entered_at: float
    queue_wait_ms: float
    inference_ms: float

    def total_ms(self) -> float:
        return (time.perf_counter() - self.entered_at) * 1000.0

    def as_metrics(self) -> dict[str, float]:
        """Both services publish these under identical names on purpose: the
        benchmark has to attribute a slow answer the same way in either one.

        The three are rounded together rather than independently. Raw
        `total_ms` always exceeds the raw sum -- the sum ends inside this call
        -- but by only a microsecond or two on the predictor path, while three
        independent `round(..., 3)` calls can move the published numbers by up
        to 1.5 microseconds the other way. That is enough to publish
        `queue_wait_ms + inference_ms > total_ms`, which is not a rounding
        detail to anyone reading the artifact: it says the parts do not fit in
        the whole, i.e. that the split cannot be trusted. Clamping keeps the
        published numbers self-consistent; it can only ever add sub-microsecond
        slack to total_ms.
        """
        queue_wait_ms = round(self.queue_wait_ms, 3)
        inference_ms = round(self.inference_ms, 3)
        return {
            "queue_wait_ms": queue_wait_ms,
            "inference_ms": inference_ms,
            "total_ms": max(round(self.total_ms(), 3), round(queue_wait_ms + inference_ms, 3)),
        }


class GpuQueue:
    """Serialises the GPU-bound section of one service and times the wait."""

    def __init__(self, name: str, *, limit: int = DEFAULT_CONCURRENCY) -> None:
        if limit < 1:
            raise ValueError("GPU concurrency limit must be >= 1")
        self.name = name
        self._limit = limit
        self._semaphore: asyncio.Semaphore | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._waiting = 0

    @property
    def limit(self) -> int:
        return self._limit

    @property
    def waiting(self) -> int:
        """Requests currently blocked on the card. Exposed by /healthz so a
        benchmark run can be told apart from an idle service after the fact."""
        return self._waiting

    def _for_current_loop(self) -> asyncio.Semaphore:
        # uvicorn gives this process exactly one event loop, but pytest gives
        # every test its own, and an asyncio primitive binds to the first loop
        # that awaits it and then raises on the second. Rebinding per loop keeps
        # the module-level queues testable without weakening serialisation
        # inside the running service, which never has a second loop.
        loop = asyncio.get_running_loop()
        if self._semaphore is None or self._loop is not loop:
            self._semaphore = asyncio.Semaphore(self._limit)
            self._loop = loop
            self._waiting = 0
        return self._semaphore

    async def run(
        self,
        func: Callable[..., T],
        /,
        *args: Any,
        entered_at: float,
        **kwargs: Any,
    ) -> tuple[T, RequestTiming]:
        """Wait for the card, then run one blocking inference off the event loop.

        `entered_at` is a `time.perf_counter()` stamp taken when the request
        entered the handler, so the wait covers the whole time the caller was
        held up, not just the final `acquire()`.

        The card is released before this returns: a caller that spends
        milliseconds building its response must not hold the GPU while doing it,
        otherwise its serialisation cost reappears as another request's queue
        wait and the two become indistinguishable again.

        Release is bound to the worker thread finishing, not to this coroutine
        finishing. `asyncio.to_thread` cannot be cancelled: when a benchmark
        client hits its timeout and uvicorn cancels the handler task, the
        forward pass keeps running on the card. Releasing in a `finally` here
        would admit the next request on top of it, so the card would really
        serve two inferences at once while the newcomer reported
        `queue_wait_ms ~ 0` -- the exact mixture this module exists to remove.
        """
        semaphore = self._for_current_loop()
        self._waiting += 1
        try:
            await semaphore.acquire()
        finally:
            self._waiting -= 1
        queue_wait_ms = (time.perf_counter() - entered_at) * 1000.0
        started = time.perf_counter()
        task = asyncio.ensure_future(asyncio.to_thread(func, *args, **kwargs))
        task.add_done_callback(lambda _done: semaphore.release())
        # `shield` keeps a cancellation of the caller from cancelling the wrapper
        # future, so the callback above still fires exactly once, when the thread
        # is genuinely off the GPU.
        result = await asyncio.shield(task)
        inference_ms = (time.perf_counter() - started) * 1000.0
        return result, RequestTiming(
            entered_at=entered_at,
            queue_wait_ms=queue_wait_ms,
            inference_ms=inference_ms,
        )


__all__ = [
    "DEFAULT_CONCURRENCY",
    "GpuQueue",
    "RequestTiming",
    "concurrency_from_env",
]
