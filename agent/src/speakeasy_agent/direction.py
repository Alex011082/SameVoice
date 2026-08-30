"""One speaker -> listener translation pipeline.

    listener-side audio ─▶ STT session ─▶ Chunker ─▶ MT ─▶ TTS ─▶ resample ─▶ 10ms frames ─▶ sink

The stages overlap: STT keeps producing partials while an earlier committed unit
is still being translated and spoken. Ordering between units is preserved by a
single worker task; that same task is what barge-in cancels.

This module deliberately knows nothing about LiveKit rooms - it takes an
`AudioSink` and a `SubtitleEmitter`, so the whole pipeline is exercised offline
in tests with no connection at all.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from typing import Callable

from livekit import rtc

from .audio import AudioSink, OutputFramer, ResamplerPool
from .chunker import Chunker, ChunkerConfig, CommittedUnit
from .evallog import CallEvalLog, utterance_record
from .providers.base import (
    MtProvider,
    MtRequest,
    Speaker,
    SttProvider,
    SttSession,
    TtsProvider,
    provider_id,
)
from .subtitles import SubtitleEmitter

logger = logging.getLogger(__name__)

TICK_INTERVAL_S = 0.05
NO_SPEECH_TIMEOUT_S = 15.0
AGENT_ERROR_COOLDOWN_S = 10.0

# On hangup the STT socket used to be cancelled without ever being flushed, so
# the last in-flight partial never became a final and the closing words of every
# call - "ок, пока" - were silently never translated or logged. `aclose()` now
# flushes the session and waits, briefly and with an early exit, for the trailing
# final to arrive. Bounded on purpose: hanging up must stay instant.
CLOSE_DRAIN_S = 0.6
_DRAIN_POLL_S = 0.02
# How long the STT session has to stay silent before the drain believes there is
# nothing more coming. Checking only the queue and the chunker is not enough:
# the flushed final may still be sitting unread in the session's own buffer.
_DRAIN_QUIET_S = 0.08


def _ms(a: float | None, b: float | None) -> float | None:
    if a is None or b is None:
        return None
    return round((b - a) * 1000.0, 1)


@dataclass
class UnitMetrics:
    """One structured line per committed translation unit. Latency is the
    product KPI, so it is measured from day one rather than inferred.

    A unit is a CHUNK, not an utterance: `speech_start_to_first_partial_ms` and
    `speech_start_to_first_audio_ms` are anchored on the utterance, so on chunks
    2..n they answer a different question than their names suggest and only
    `utterance_key` + `is_first_chunk` let a reader tell the two apart.
    """

    kind: str = "latency"
    call_id: str = ""
    speaker: str = ""
    listener: str = ""
    src_lang: str = ""
    dst_lang: str = ""
    segment_id: str = ""
    utterance_id: str = ""
    utterance_key: str = ""
    is_first_chunk: bool = False
    trigger: str = ""
    words: int = 0
    src_chars: int = 0
    dst_chars: int = 0
    stt_provider: str = ""
    mt_provider: str = ""
    tts_provider: str = ""
    # stage timings, all milliseconds
    speech_start_to_first_partial_ms: float | None = None
    first_partial_to_commit_ms: float | None = None
    commit_to_mt_done_ms: float | None = None
    mt_provider_latency_ms: float | None = None
    mt_done_to_first_audio_ms: float | None = None
    speech_start_to_first_audio_ms: float | None = None
    tts_audio_ms: float | None = None
    cancelled: bool = False
    error: str | None = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    def stage_timings(self) -> dict[str, float | None]:
        """Just the measured milliseconds, for the eval log. Deliberately reads
        the already-recorded values instead of re-measuring anything."""
        return {
            "speech_start_to_first_partial_ms": self.speech_start_to_first_partial_ms,
            "first_partial_to_commit_ms": self.first_partial_to_commit_ms,
            "commit_to_mt_done_ms": self.commit_to_mt_done_ms,
            "mt_provider_latency_ms": self.mt_provider_latency_ms,
            "mt_done_to_first_audio_ms": self.mt_done_to_first_audio_ms,
            "speech_start_to_first_audio_ms": self.speech_start_to_first_audio_ms,
            "tts_audio_ms": self.tts_audio_ms,
        }


@dataclass
class _Unit:
    unit: CommittedUnit
    segment_id: str
    utterance_id: str
    utterance_key: str
    is_first_chunk: bool
    speech_start: float | None
    first_partial: float | None
    src_text: str
    t_start: float
    t_end: float


@dataclass
class DirectionStats:
    units_committed: int = 0
    units_spoken: int = 0
    units_cancelled: int = 0
    barge_ins: int = 0
    provider_errors: int = 0
    metrics: list[UnitMetrics] = field(default_factory=list)


class Direction:
    def __init__(
        self,
        *,
        call_id: str,
        speaker: Speaker,
        listener: Speaker,
        stt: SttProvider,
        mt: MtProvider,
        tts: TtsProvider,
        sink: AudioSink,
        emitter: SubtitleEmitter,
        chunker_config: ChunkerConfig | None = None,
        history_turns: int = 4,
        glossary: dict[str, str] | None = None,
        call_start: float | None = None,
        on_speech_start: Callable[[], None] | None = None,
        eval_log: CallEvalLog | None = None,
        close_drain_s: float = CLOSE_DRAIN_S,
    ) -> None:
        self.call_id = call_id
        self.speaker = speaker
        self.listener = listener
        self.stats = DirectionStats()

        self._stt = stt
        self._mt = mt
        self._tts = tts
        self._sink = sink
        self._emitter = emitter
        self._chunker = Chunker(chunker_config)
        self._history_turns = max(0, history_turns)
        self._glossary = dict(glossary or {})
        self._call_start = call_start if call_start is not None else time.monotonic()
        self.on_speech_start = on_speech_start
        self._eval_log = eval_log
        self._close_drain_s = max(0.0, close_drain_s)

        self._session: SttSession | None = None
        self._input_dead = False
        self._queue: asyncio.Queue[_Unit] = asyncio.Queue()
        self._tasks: list[asyncio.Task] = []
        self._active_unit_task: asyncio.Task | None = None
        self._epoch = 0
        self._closed = False
        # `_closed` is only set AFTER the trailing-speech drain, so a second
        # concurrent aclose() would otherwise drain a second time.
        self._closing = False

        self._history: list[tuple[str, str]] = []
        self._resamplers = ResamplerPool()

        self._t_speech_start: float | None = None
        self._t_first_partial: float | None = None
        self._t_last_event: float = time.monotonic()
        # Distinct from `_t_last_event`, which starts "now" for the no-speech
        # timeout. This one starts at zero so that closing a direction nobody
        # ever spoke into is instant.
        self._t_last_stt_event: float = 0.0
        self._current_segment: str | None = None
        self._utterance_committed: list[str] = []
        self._last_error_at: float = 0.0
        self._utterance_seq = 0
        # Minted on the first committed chunk of an utterance and cleared by both
        # utterance resets, so it can never outlive the speech-start anchor whose
        # latencies it groups. `None` is exactly "no chunk of this utterance has
        # been committed yet", which is also what marks a chunk as the first one.
        self._utterance_key: str | None = None

    # ---------------------------------------------------------------- lifecycle

    @property
    def label(self) -> str:
        return f"{self.speaker.user_id}({self.speaker.lang})->{self.listener.user_id}({self.listener.lang})"

    async def start(self) -> None:
        self._session = await self._stt.start(lang=self.speaker.lang)
        self._tasks = [
            asyncio.create_task(self._stt_loop(), name=f"stt:{self.label}"),
            asyncio.create_task(self._ticker(), name=f"tick:{self.label}"),
            asyncio.create_task(self._worker(), name=f"unit:{self.label}"),
        ]
        logger.info("direction started %s", self.label)

    async def aclose(self) -> None:
        if self._closed or self._closing:
            return
        self._closing = True
        await self._drain_trailing_speech()
        self._closed = True
        if self._active_unit_task is not None and not self._active_unit_task.done():
            self._active_unit_task.cancel()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._tasks.clear()
        if self._session is not None:
            with contextlib.suppress(Exception):
                await self._session.aclose()
            self._session = None
        self._resamplers.close()
        # The eval log is NOT closed here: one file serves both directions of a
        # call, so its lifecycle belongs to the Relay that opened it.
        logger.info(
            "direction closed %s committed=%d spoken=%d cancelled=%d barge_ins=%d errors=%d",
            self.label,
            self.stats.units_committed,
            self.stats.units_spoken,
            self.stats.units_cancelled,
            self.stats.barge_ins,
            self.stats.provider_errors,
        )

    async def _drain_trailing_speech(self) -> None:
        """Flush the STT socket and give the trailing final a moment to land.

        Without this the closing words of every call are lost: `aclose()` used to
        cancel the STT task while the send loop still had the `Finalize` message
        queued, so the last partial never became a final and was never
        translated, never spoken and - more importantly for the experiment -
        never written to the eval log.
        """
        if self._closed or self._session is None or self._close_drain_s <= 0:
            return
        with contextlib.suppress(Exception):
            await self._session.flush()
        deadline = time.monotonic() + self._close_drain_s
        idle_streak = 0
        while time.monotonic() < deadline:
            await asyncio.sleep(_DRAIN_POLL_S)
            busy = (
                not self._queue.empty()
                or self._active_unit_task is not None
                or self._chunker.has_pending
                # Events are still arriving from the STT session, so the flushed
                # final may not have been delivered yet.
                or (time.monotonic() - self._t_last_stt_event) < _DRAIN_QUIET_S
            )
            # A single idle poll is not proof, so require a short quiet streak.
            idle_streak = 0 if busy else idle_streak + 1
            if idle_streak >= 2:
                return
        logger.debug("%s: trailing speech drain timed out", self.label)

    # ---------------------------------------------------------------- input

    def push_frame(self, frame: rtc.AudioFrame) -> None:
        if self._closed or self._session is None or self._input_dead:
            return
        try:
            self._session.push_frame(frame)
        except Exception as exc:
            # A dead session raises on EVERY subsequent frame. At 100 frames/s
            # per direction that is a log flood that buries the one line that
            # matters, so stop feeding it after the first failure.
            self._input_dead = True
            logger.warning(
                "%s: STT push_frame failed, input stopped for this session: %s", self.label, exc
            )

    def cancel_output(self) -> None:
        """Barge-in: the listener started speaking, so everything we are about to
        say to them is stale. Cancel MT/TTS and drop the already-queued audio."""
        self._epoch += 1
        cancelled_any = False
        if self._active_unit_task is not None and not self._active_unit_task.done():
            self._active_unit_task.cancel()
            cancelled_any = True
        while not self._queue.empty():
            try:
                dropped = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            self._queue.task_done()
            # RECORDED, not silently discarded. A unit cancelled inside
            # _process_unit writes its row (the two `except CancelledError`
            # handlers below do), but a unit still waiting in this queue used to
            # leave no trace at all. When the dropped unit was the utterance's
            # FIRST chunk, the log then held that utterance with isFirstChunk
            # false on every surviving row, so it contributed ZERO samples to
            # every utterance-basis percentile - including END-TO-END - while
            # still being counted as one utterance. The bias is not random:
            # a listener interrupts the slow answers, so exactly the slow
            # utterances were dropping out of the p50.
            self._record_dropped(dropped)
            cancelled_any = True
        self._sink.clear_queue()
        if cancelled_any:
            self.stats.barge_ins += 1
            logger.info("%s: barge-in, output cancelled", self.label)

    # ---------------------------------------------------------------- loops

    async def _stt_loop(self) -> None:
        assert self._session is not None
        try:
            async for event in self._session:
                now = time.monotonic()
                self._t_last_event = now
                self._t_last_stt_event = now

                if event.type == "speech_start":
                    self._on_speech_start(now)
                    continue

                if event.type == "speech_end":
                    continue

                if event.type == "partial":
                    if self._t_first_partial is None:
                        self._t_first_partial = now
                    units = self._chunker.on_partial(event.text, now)
                    self._enqueue(units, now)
                    await self._emit_partial(event.text, now)
                    continue

                if event.type == "final":
                    if self._t_first_partial is None:
                        self._t_first_partial = now
                    units = self._chunker.on_final(event.text, now)
                    self._enqueue(units, now)
                    self._reset_utterance()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("%s: STT loop failed: %s", self.label, exc)
            await self._report_error(f"stt: {exc}")

    async def _ticker(self) -> None:
        try:
            while True:
                await asyncio.sleep(TICK_INTERVAL_S)
                now = time.monotonic()
                units = self._chunker.tick(now)
                if units:
                    self._enqueue(units, now)
                if (
                    self._t_speech_start is not None
                    and not self._chunker.has_pending
                    and (now - self._t_last_event) > NO_SPEECH_TIMEOUT_S
                ):
                    logger.info("%s: no speech for %.0fs, resetting", self.label, NO_SPEECH_TIMEOUT_S)
                    self._reset_utterance()
                    self._t_last_event = now
        except asyncio.CancelledError:
            raise

    async def _worker(self) -> None:
        try:
            while True:
                item = await self._queue.get()
                task = asyncio.create_task(self._process_unit(item))
                self._active_unit_task = task
                try:
                    await asyncio.wait({task})
                finally:
                    self._active_unit_task = None
                    self._queue.task_done()
                if task.cancelled():
                    self.stats.units_cancelled += 1
                    continue
                exc = task.exception()
                if exc is not None:
                    self.stats.provider_errors += 1
                    logger.warning("%s: unit failed: %s", self.label, exc)
                    await self._report_error(str(exc))
        except asyncio.CancelledError:
            raise

    # ---------------------------------------------------------------- stages

    def _base_metrics(self, item: _Unit) -> UnitMetrics:
        """Everything about a unit that is known before MT is even attempted.

        Shared by `_process_unit` and by the barge-in drop path, so a unit that
        never reached a provider still carries the same identity and the same two
        utterance-anchored latencies as one that did.
        """
        return UnitMetrics(
            call_id=self.call_id,
            speaker=self.speaker.user_id,
            listener=self.listener.user_id,
            src_lang=self.speaker.lang,
            dst_lang=self.listener.lang,
            segment_id=item.segment_id,
            utterance_id=item.utterance_id,
            utterance_key=item.utterance_key,
            is_first_chunk=item.is_first_chunk,
            trigger=item.unit.trigger,
            words=item.unit.word_count,
            src_chars=len(item.src_text),
            stt_provider=provider_id(self._stt),
            mt_provider=provider_id(self._mt),
            tts_provider=provider_id(self._tts),
            speech_start_to_first_partial_ms=_ms(item.speech_start, item.first_partial),
            first_partial_to_commit_ms=_ms(item.first_partial, item.unit.committed_at),
        )

    def _record_dropped(self, item: _Unit) -> None:
        """A committed unit that barge-in removed from the queue before any
        provider saw it. `cancelled` is true and every stage latency below the
        commit is None, which is exactly what happened."""
        metrics = self._base_metrics(item)
        metrics.cancelled = True
        self.stats.units_cancelled += 1
        self._record(metrics, item, "")

    async def _process_unit(self, item: _Unit) -> None:
        epoch = self._epoch
        metrics = self._base_metrics(item)

        dst_text = ""
        try:
            request = MtRequest(
                text=item.src_text,
                src_lang=self.speaker.lang,
                dst_lang=self.listener.lang,
                speaker=self.speaker,
                listener=self.listener,
                is_continuation=bool(self._history),
                history=tuple(self._history[-self._history_turns :]) if self._history_turns else (),
                glossary=self._glossary,
            )
            result = await self._mt.translate(request)
            dst_text = result.text.strip()
            metrics.mt_provider_latency_ms = round(result.latency_ms, 1)
        except asyncio.CancelledError:
            metrics.cancelled = True
            self._record(metrics, item, dst_text)
            raise
        except Exception as exc:
            metrics.error = f"mt: {exc}"
            self.stats.provider_errors += 1
            logger.warning("%s: MT failed for %r: %s", self.label, item.src_text, exc)

        t_mt_done = time.monotonic()
        metrics.commit_to_mt_done_ms = _ms(item.unit.committed_at, t_mt_done)
        metrics.dst_chars = len(dst_text)

        await self._emitter.send_subtitle(
            segment_id=item.segment_id,
            speaker_id=self.speaker.user_id,
            listener_id=self.listener.user_id,
            src_lang=self.speaker.lang,
            dst_lang=self.listener.lang,
            src_text=item.src_text,
            dst_text=dst_text,
            is_final=True,
            t_start=item.t_start,
            t_end=item.t_end,
            utterance_id=item.utterance_id,
        )

        if not dst_text:
            self._record(metrics, item, dst_text)
            return

        if self._history_turns:
            self._history.append((item.src_text, dst_text))
            if len(self._history) > self._history_turns * 2:
                del self._history[: -self._history_turns * 2]

        samples = 0
        first_audio: float | None = None
        framer = OutputFramer()
        src_rate: int | None = None
        try:
            stream = self._tts.synthesize(dst_text, lang=self.listener.lang)
            async for chunk in stream:
                if self._epoch != epoch or self._closed:
                    break
                src_rate = chunk.sample_rate
                pcm = self._resamplers.resample(chunk.pcm, chunk.sample_rate)
                for frame in framer.push(pcm):
                    if first_audio is None:
                        first_audio = time.monotonic()
                    samples += frame.samples_per_channel
                    await self._sink.capture_frame(frame)
            # The resampler keeps residual samples between pushes; it is drained on
            # every unit — including a cancelled one — so one utterance's tail can
            # never be prepended to the next.
            if src_rate is not None:
                tail = self._resamplers.flush(src_rate)
                if tail and self._epoch == epoch and not self._closed:
                    for frame in framer.push(tail):
                        if first_audio is None:
                            first_audio = time.monotonic()
                        samples += frame.samples_per_channel
                        await self._sink.capture_frame(frame)
            for frame in framer.flush():
                if self._epoch != epoch or self._closed:
                    break
                if first_audio is None:
                    first_audio = time.monotonic()
                samples += frame.samples_per_channel
                await self._sink.capture_frame(frame)
        except asyncio.CancelledError:
            metrics.cancelled = True
            metrics.mt_done_to_first_audio_ms = _ms(t_mt_done, first_audio)
            metrics.tts_audio_ms = round(samples / self._sink.sample_rate * 1000.0, 1)
            self._record(metrics, item, dst_text)
            raise
        except Exception as exc:
            metrics.error = f"tts: {exc}"
            self.stats.provider_errors += 1
            logger.warning("%s: TTS failed for %r: %s", self.label, dst_text, exc)

        metrics.mt_done_to_first_audio_ms = _ms(t_mt_done, first_audio)
        metrics.speech_start_to_first_audio_ms = _ms(item.speech_start, first_audio)
        metrics.tts_audio_ms = round(samples / self._sink.sample_rate * 1000.0, 1)
        # A unit only counts as spoken if TTS actually delivered audio: counting
        # a provider outage as "spoken" makes /stats claim the listener heard
        # something they did not.
        if metrics.error is None:
            self.stats.units_spoken += 1
        self._record(metrics, item, dst_text)

    # ---------------------------------------------------------------- helpers

    def _on_speech_start(self, now: float) -> None:
        self._t_speech_start = now
        self._t_first_partial = None
        self._chunker.reset()
        self._utterance_committed = []
        self._utterance_key = None
        self._current_segment = None
        if self.on_speech_start is not None:
            try:
                self.on_speech_start()
            except Exception as exc:
                logger.warning("%s: on_speech_start hook failed: %s", self.label, exc)

    def _reset_utterance(self) -> None:
        self._t_speech_start = None
        self._t_first_partial = None
        self._current_segment = None
        self._utterance_committed = []
        self._utterance_key = None

    def _utterance_grouping(self, fallback_id: str) -> tuple[str, bool]:
        """(key, is_first_chunk) for the chunk about to be enqueued.

        Rows are written per committed chunk, but `speech_start`/`first_partial`
        belong to the whole utterance. On the Omri-Maya call (27.08.2026) the
        median committed unit was ONE WORD (`chunker.py:60`), so a four-chunk
        utterance published the same speech-start latency four times and every
        percentile weighted an utterance by how many chunks it happened to
        produce. That call is what the current commit policy was written against,
        so chunks should be longer now - but nothing has re-measured them, and
        one long reply is enough to move a p50 either way.

        The key is minted ONCE, on the utterance's first committed chunk, and
        held in `_utterance_key` until one of the two utterance resets clears it
        - the same two resets that clear the speech-start anchor. So the key and
        the anchor whose latencies it groups can never drift apart, and the same
        field answers both questions this method returns: an unset key IS the
        first chunk. `segmentId` cannot serve as the key - adjacent chunks of one
        utterance get different segment ids.
        """
        if self._t_speech_start is None:
            # No anchor: the provider produced text with no speech_start, or
            # after a reset. Both first-chunk latencies are None on such a row
            # anyway, and nothing can honestly group these rows, so each stands
            # alone as a one-chunk utterance rather than being merged with a
            # neighbour it may have nothing to do with.
            self._utterance_key = None
            return fallback_id, True
        if self._utterance_key is not None:
            return self._utterance_key, False
        offset_ms = round((self._t_speech_start - self._call_start) * 1000.0)
        # The offset alone was NOT unique. Two utterances whose speech_start
        # events land in the same millisecond - a `final` immediately followed by
        # the next `speech_start`, which is what any buffered or replayed STT
        # stream produces - shared one key, and the log then carried TWO
        # first-chunk rows under it while the readers counted one utterance.
        # `fallback_id` is this chunk's own utteranceId, minted off a
        # per-direction counter that never repeats, so folding it in makes the
        # key unique by construction. The offset stays because it is what makes
        # the key readable at 1am: milliseconds since the call started.
        self._utterance_key = f"{fallback_id}@{offset_ms}"
        return self._utterance_key, True

    def _enqueue(self, units: list[CommittedUnit], now: float) -> None:
        for unit in units:
            if not unit.text.strip():
                continue
            segment_id = self._current_segment or self._emitter.new_segment_id(
                self.speaker.user_id
            )
            self._current_segment = None
            self.stats.units_committed += 1
            # The judge's handle on this translation. Speakers are unique within
            # a call, so a per-direction counter is enough to be stable and
            # unique inside logs/calls/<callId>.jsonl - and it is readable, which
            # matters when someone is reading the file at 1am after a test call.
            self._utterance_seq += 1
            utterance_id = f"utt_{self.speaker.user_id}_{self._utterance_seq:06d}"
            utterance_key, is_first_chunk = self._utterance_grouping(utterance_id)
            # Only feeds `_uncommitted_tail`, which strips the already-committed
            # prefix off the partial being displayed. The first-chunk mark comes
            # from `_utterance_key`, not from this list.
            self._utterance_committed.append(unit.text)
            self._queue.put_nowait(
                _Unit(
                    unit=unit,
                    segment_id=segment_id,
                    utterance_id=utterance_id,
                    utterance_key=utterance_key,
                    is_first_chunk=is_first_chunk,
                    speech_start=self._t_speech_start,
                    first_partial=self._t_first_partial,
                    src_text=unit.text,
                    t_start=max(0.0, unit.pending_since - self._call_start),
                    t_end=max(0.0, now - self._call_start),
                )
            )

    async def _emit_partial(self, text: str, now: float) -> None:
        display = self._uncommitted_tail(text)
        if not display:
            return
        if self._current_segment is None:
            self._current_segment = self._emitter.new_segment_id(self.speaker.user_id)
        await self._emitter.send_subtitle(
            segment_id=self._current_segment,
            speaker_id=self.speaker.user_id,
            listener_id=self.listener.user_id,
            src_lang=self.speaker.lang,
            dst_lang=self.listener.lang,
            src_text=display,
            dst_text="",
            is_final=False,
            t_start=max(0.0, (self._t_speech_start or now) - self._call_start),
            t_end=max(0.0, now - self._call_start),
        )

    def _uncommitted_tail(self, text: str) -> str:
        prefix = " ".join(self._utterance_committed).strip()
        stripped = text.strip()
        if prefix and stripped.startswith(prefix):
            return stripped[len(prefix) :].strip()
        return stripped

    def _record(self, metrics: UnitMetrics, item: _Unit, dst_text: str) -> None:
        self.stats.metrics.append(metrics)
        logger.info("speakeasy.latency %s", metrics.to_json())
        if self._eval_log is None:
            return
        # Cancelled and errored units are logged too, on purpose: "the listener
        # heard nothing" is one of the things the judge will report, and the log
        # has to be able to say whether that was a barge-in, a provider outage,
        # or a genuinely empty translation.
        self._eval_log.append(
            utterance_record(
                call_id=self.call_id,
                utterance_id=item.utterance_id,
                utterance_key=item.utterance_key,
                is_first_chunk=item.is_first_chunk,
                segment_id=item.segment_id,
                speaker={
                    "userId": self.speaker.user_id,
                    "displayName": self.speaker.display_name,
                    "lang": self.speaker.lang,
                    "gender": self.speaker.gender,
                    "tone": self.speaker.tone,
                },
                listener={
                    "userId": self.listener.user_id,
                    "displayName": self.listener.display_name,
                    "lang": self.listener.lang,
                    "gender": self.listener.gender,
                    "tone": self.listener.tone,
                },
                src_lang=self.speaker.lang,
                dst_lang=self.listener.lang,
                src_text=item.src_text,
                dst_text=dst_text,
                providers={
                    "stt": metrics.stt_provider,
                    "mt": metrics.mt_provider,
                    "tts": metrics.tts_provider,
                },
                latency=metrics.stage_timings(),
                trigger=item.unit.trigger,
                words=item.unit.word_count,
                t_start=item.t_start,
                t_end=item.t_end,
                cancelled=metrics.cancelled,
                error=metrics.error,
            )
        )

    async def _report_error(self, detail: str) -> None:
        now = time.monotonic()
        if now - self._last_error_at < AGENT_ERROR_COOLDOWN_S:
            return
        self._last_error_at = now
        await self._emitter.send_state(event="agent_error", detail=detail[:400])

    @property
    def last_metrics(self) -> UnitMetrics | None:
        return self.stats.metrics[-1] if self.stats.metrics else None
