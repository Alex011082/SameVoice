"""Resampling and framing helpers for the relay's audio path.

Two constraints are encoded here that the LiveKit API does not enforce:
  * `rtc.AudioResampler.push()` returns a LIST of frames, not one frame.
    Treating it as a single frame yields chipmunk or slowed audio with no error.
  * Frames pushed into an `rtc.AudioSource` must be 10 ms so that a 200 ms
    queue stays a 200 ms queue.
"""

from __future__ import annotations

import array
import math
from typing import Protocol

from livekit import rtc
from livekit.agents.utils.audio import AudioByteStream

OUTPUT_SAMPLE_RATE = 48000
OUTPUT_NUM_CHANNELS = 1
OUTPUT_FRAME_MS = 10
OUTPUT_SAMPLES_PER_FRAME = OUTPUT_SAMPLE_RATE * OUTPUT_FRAME_MS // 1000  # 480
BYTES_PER_SAMPLE = 2

# `rtc.AudioSource` defaults to 1000 ms, which lets a full second of already
# queued TTS keep playing after a barge-in cancellation.
AUDIO_SOURCE_QUEUE_MS = 200


class AudioSink(Protocol):
    """What a Direction needs from its output. Implemented over rtc.AudioSource
    in the relay and over a list in tests."""

    sample_rate: int
    num_channels: int

    async def capture_frame(self, frame: rtc.AudioFrame) -> None: ...

    def clear_queue(self) -> None: ...


class LiveKitAudioSink:
    """Adapts `rtc.AudioSource` to the `AudioSink` protocol."""

    def __init__(self, source: rtc.AudioSource) -> None:
        self._source = source
        self.sample_rate = OUTPUT_SAMPLE_RATE
        self.num_channels = OUTPUT_NUM_CHANNELS

    @property
    def source(self) -> rtc.AudioSource:
        return self._source

    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        await self._source.capture_frame(frame)

    def clear_queue(self) -> None:
        self._source.clear_queue()


class CollectingAudioSink:
    """Offline sink used by tests and by the mock pipeline demo."""

    def __init__(
        self,
        sample_rate: int = OUTPUT_SAMPLE_RATE,
        num_channels: int = OUTPUT_NUM_CHANNELS,
    ) -> None:
        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self.frames: list[rtc.AudioFrame] = []
        self.clear_count = 0
        self.captured_samples = 0

    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        self.frames.append(frame)
        self.captured_samples += frame.samples_per_channel

    def clear_queue(self) -> None:
        self.clear_count += 1
        self.frames.clear()

    @property
    def total_samples(self) -> int:
        return sum(f.samples_per_channel for f in self.frames)

    @property
    def duration_s(self) -> float:
        if not self.frames:
            return 0.0
        return self.total_samples / float(self.sample_rate)

    @property
    def captured_duration_s(self) -> float:
        """Cumulative audio ever captured, including audio a later
        `clear_queue()` discarded."""
        return self.captured_samples / float(self.sample_rate)


def create_audio_source() -> rtc.AudioSource:
    return rtc.AudioSource(
        OUTPUT_SAMPLE_RATE,
        OUTPUT_NUM_CHANNELS,
        queue_size_ms=AUDIO_SOURCE_QUEUE_MS,
    )


class ResamplerPool:
    """Lazily creates one `rtc.AudioResampler` per source rate."""

    def __init__(self, target_rate: int = OUTPUT_SAMPLE_RATE, num_channels: int = 1) -> None:
        self._target_rate = target_rate
        self._num_channels = num_channels
        self._resamplers: dict[int, rtc.AudioResampler] = {}

    def resample(self, pcm: bytes, src_rate: int) -> bytes:
        if src_rate == self._target_rate:
            return pcm
        resampler = self._resamplers.get(src_rate)
        if resampler is None:
            resampler = rtc.AudioResampler(
                src_rate, self._target_rate, num_channels=self._num_channels
            )
            self._resamplers[src_rate] = resampler
        out = bytearray()
        for frame in resampler.push(bytearray(pcm)):
            out.extend(frame.data)
        return bytes(out)

    def flush(self, src_rate: int) -> bytes:
        resampler = self._resamplers.get(src_rate)
        if resampler is None:
            return b""
        out = bytearray()
        for frame in resampler.flush():
            out.extend(frame.data)
        return bytes(out)

    def close(self) -> None:
        self._resamplers.clear()


class OutputFramer:
    """Buffers arbitrary PCM and emits fixed 10 ms frames at 48 kHz."""

    def __init__(self) -> None:
        self._stream = AudioByteStream(
            OUTPUT_SAMPLE_RATE,
            OUTPUT_NUM_CHANNELS,
            samples_per_channel=OUTPUT_SAMPLES_PER_FRAME,
        )

    def push(self, pcm: bytes) -> list[rtc.AudioFrame]:
        assert_int16(pcm)
        return self._stream.push(pcm)

    def flush(self) -> list[rtc.AudioFrame]:
        return self._stream.flush()


def assert_int16(pcm: bytes) -> None:
    if len(pcm) % BYTES_PER_SAMPLE != 0:
        raise ValueError(
            f"PCM buffer of {len(pcm)} bytes is not a whole number of int16 samples"
        )


def frame_rms(frame: rtc.AudioFrame) -> float:
    """Root-mean-square of an int16 mono frame, normalised to 0.0 - 1.0."""
    samples = array.array("h")
    samples.frombytes(bytes(frame.data)[: (len(frame.data) // 2) * 2])
    if not samples:
        return 0.0
    acc = 0
    for s in samples:
        acc += s * s
    return math.sqrt(acc / len(samples)) / 32768.0


def silence_frame(
    sample_rate: int = OUTPUT_SAMPLE_RATE,
    num_channels: int = OUTPUT_NUM_CHANNELS,
    duration_ms: int = OUTPUT_FRAME_MS,
) -> rtc.AudioFrame:
    samples = sample_rate * duration_ms // 1000
    return rtc.AudioFrame(
        data=bytes(samples * num_channels * BYTES_PER_SAMPLE),
        sample_rate=sample_rate,
        num_channels=num_channels,
        samples_per_channel=samples,
    )


def tone_frame(
    *,
    freq: float,
    amplitude: float,
    phase: float,
    sample_rate: int = OUTPUT_SAMPLE_RATE,
    duration_ms: int = OUTPUT_FRAME_MS,
) -> tuple[rtc.AudioFrame, float]:
    """A mono int16 sine frame plus the phase to continue from."""
    samples = sample_rate * duration_ms // 1000
    buf = array.array("h", bytes(samples * BYTES_PER_SAMPLE))
    step = 2.0 * math.pi * freq / sample_rate
    peak = int(max(0.0, min(1.0, amplitude)) * 32000)
    for i in range(samples):
        buf[i] = int(peak * math.sin(phase + step * i))
    phase = (phase + step * samples) % (2.0 * math.pi)
    return (
        rtc.AudioFrame(
            data=buf.tobytes(),
            sample_rate=sample_rate,
            num_channels=1,
            samples_per_channel=samples,
        ),
        phase,
    )
