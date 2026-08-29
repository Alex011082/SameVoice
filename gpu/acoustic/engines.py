"""Heavy ASR engines for the SameVoice acoustic R&D service.

Russian uses NVIDIA Nemotron 3.5's documented cache-aware Transformers streaming
API. Hebrew uses the ivrit.ai Faster-Whisper checkpoint as a quality-oriented
rolling snapshot fallback because stock Nemotron 3.5 lists Hebrew as
adaptation-ready rather than transcription-ready.

All heavyweight imports and model downloads are lazy. The module itself remains
safe to import in ordinary CPU CI.
"""

from __future__ import annotations

import asyncio
import os
import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

NEMOTRON_MODEL = os.getenv(
    "ACOUSTIC_RU_MODEL", "nvidia/nemotron-3.5-asr-streaming-0.6b"
)
HEBREW_MODEL = os.getenv(
    "ACOUSTIC_HE_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2"
)
NEMOTRON_LOOKAHEAD = int(os.getenv("ACOUSTIC_NEMOTRON_LOOKAHEAD", "3"))
if NEMOTRON_LOOKAHEAD not in (0, 3, 6, 13):
    raise ValueError("ACOUSTIC_NEMOTRON_LOOKAHEAD must be one of 0,3,6,13")


@dataclass(frozen=True)
class TranscriptUpdate:
    text: str
    latency_ms: float
    engine: str


class NemotronEngine:
    """Shared lazy-loaded Russian streaming model.

    One model instance is shared on GPU0. Generation is serialised at the model
    level for correctness in the first benchmark. Queue wait is a metric to
    remove later; silently running unsafe concurrent `generate()` calls would
    make latency numbers meaningless.
    """

    def __init__(self) -> None:
        self._load_lock = threading.RLock()
        self._generate_lock = threading.Lock()
        self.processor: Any = None
        self.model: Any = None
        self.device = "unloaded"
        self.load_ms = 0.0

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def load(self) -> float:
        if self.loaded:
            return 0.0
        with self._load_lock:
            if self.loaded:
                return 0.0
            started = time.perf_counter()
            try:
                from transformers import AutoModelForRNNT, AutoProcessor
            except ImportError as exc:  # pragma: no cover - GPU image only
                raise RuntimeError(
                    "Nemotron dependencies are missing; build with INSTALL_GPU_ENGINES=1"
                ) from exc

            processor = AutoProcessor.from_pretrained(NEMOTRON_MODEL)
            processor.set_num_lookahead_tokens(NEMOTRON_LOOKAHEAD)
            model = AutoModelForRNNT.from_pretrained(NEMOTRON_MODEL, device_map="auto")
            self.processor = processor
            self.model = model
            self.device = str(model.device)
            self.load_ms = (time.perf_counter() - started) * 1000.0
            return self.load_ms

    @property
    def streaming_latency_ms(self) -> int | None:
        if self.processor is None:
            return None
        value = getattr(self.processor, "streaming_latency_ms", None)
        return int(value) if isinstance(value, (int, float)) else None

    def new_utterance(
        self,
        *,
        loop: asyncio.AbstractEventLoop,
        on_partial: Callable[[TranscriptUpdate], None],
    ) -> "NemotronUtterance":
        self.load()
        return NemotronUtterance(self, loop=loop, on_partial=on_partial)


class NemotronUtterance:
    """One live utterance using the official feature-generator streaming shape."""

    def __init__(
        self,
        engine: NemotronEngine,
        *,
        loop: asyncio.AbstractEventLoop,
        on_partial: Callable[[TranscriptUpdate], None],
    ) -> None:
        self.engine = engine
        self.loop = loop
        self.on_partial = on_partial
        self._audio: Any = None
        self._feature_queue: queue.Queue[Any | None] = queue.Queue()
        self._model_thread: threading.Thread | None = None
        self._output_thread: threading.Thread | None = None
        self._started = False
        self._closed = False
        self._transcript = ""
        self._next_start_idx = 0
        self._started_at = time.perf_counter()
        self.queue_wait_ms = 0.0
        self.error: BaseException | None = None

    @property
    def transcript(self) -> str:
        return self._transcript.strip()

    def feed(self, samples: Any) -> None:
        if self._closed:
            return
        import numpy as np

        values = np.asarray(samples, dtype=np.float32).reshape(-1)
        if values.size == 0:
            return
        self._audio = values.copy() if self._audio is None else np.concatenate((self._audio, values))
        if not self._started:
            first_needed = int(self.engine.processor.num_samples_first_audio_chunk)
            if self._audio.size < first_needed:
                return
            self._start_model()
        self._enqueue_available_features()

    def _start_model(self) -> None:
        from transformers import TextIteratorStreamer

        processor = self.engine.processor
        model = self.engine.model
        first_needed = int(processor.num_samples_first_audio_chunk)
        first_audio = self._audio[:first_needed]
        first_inputs = processor(
            first_audio,
            sampling_rate=processor.feature_extractor.sampling_rate,
            is_streaming=True,
            is_first_audio_chunk=True,
            language="ru-RU",
            return_tensors="pt",
        )
        first_inputs = first_inputs.to(model.device, dtype=model.dtype)

        first_features = first_inputs.input_features[
            :, : int(processor.num_mel_frames_first_audio_chunk), :
        ]
        self._feature_queue.put(first_features)

        mel_frame_idx = int(processor.num_mel_frames_first_audio_chunk)
        hop_length = int(processor.feature_extractor.hop_length)
        n_fft = int(processor.feature_extractor.n_fft)
        self._next_start_idx = mel_frame_idx * hop_length - n_fft // 2

        streamer = TextIteratorStreamer(processor.tokenizer, skip_special_tokens=True)

        def feature_generator():
            while True:
                item = self._feature_queue.get()
                try:
                    if item is None:
                        return
                    yield item
                finally:
                    self._feature_queue.task_done()

        generate_kwargs = {
            **first_inputs,
            "input_features": feature_generator(),
            "streamer": streamer,
        }

        def run_model() -> None:
            wait_started = time.perf_counter()
            try:
                with self.engine._generate_lock:
                    self.queue_wait_ms = (time.perf_counter() - wait_started) * 1000.0
                    model.generate(**generate_kwargs)
            except BaseException as exc:  # surfaced when finish() joins
                self.error = exc

        def read_output() -> None:
            try:
                for chunk in streamer:
                    if not chunk:
                        continue
                    self._transcript += str(chunk)
                    update = TranscriptUpdate(
                        text=self.transcript,
                        latency_ms=(time.perf_counter() - self._started_at) * 1000.0,
                        engine=NEMOTRON_MODEL,
                    )
                    self.loop.call_soon_threadsafe(self.on_partial, update)
            except BaseException as exc:
                self.error = self.error or exc

        self._model_thread = threading.Thread(target=run_model, name="nemotron-generate", daemon=True)
        self._output_thread = threading.Thread(target=read_output, name="nemotron-streamer", daemon=True)
        self._started = True
        self._model_thread.start()
        self._output_thread.start()

    def _enqueue_available_features(self) -> None:
        if not self._started:
            return
        processor = self.engine.processor
        model = self.engine.model
        chunk_samples = int(processor.num_samples_per_audio_chunk)
        hop_length = int(processor.feature_extractor.hop_length)
        mel_advance = int(processor.num_mel_frames_per_audio_chunk)
        n_fft = int(processor.feature_extractor.n_fft)

        while self._next_start_idx + chunk_samples <= int(self._audio.size):
            start_idx = self._next_start_idx
            end_idx = start_idx + chunk_samples
            inputs = processor(
                self._audio[start_idx:end_idx],
                sampling_rate=processor.feature_extractor.sampling_rate,
                is_streaming=True,
                is_first_audio_chunk=False,
                language="ru-RU",
                return_tensors="pt",
            )
            inputs = inputs.to(model.device, dtype=model.dtype)
            self._feature_queue.put(inputs.input_features)
            mel_frame_idx = (start_idx + n_fft // 2) // hop_length + mel_advance
            self._next_start_idx = mel_frame_idx * hop_length - n_fft // 2

    async def finish(self) -> TranscriptUpdate:
        if self._closed:
            return TranscriptUpdate(
                text=self.transcript,
                latency_ms=(time.perf_counter() - self._started_at) * 1000.0,
                engine=NEMOTRON_MODEL,
            )
        self._closed = True

        import numpy as np

        if self._audio is None:
            self._audio = np.zeros(1, dtype=np.float32)

        # Very short utterances still need the model's first streaming chunk.
        if not self._started:
            first_needed = int(self.engine.processor.num_samples_first_audio_chunk)
            if self._audio.size < first_needed:
                self._audio = np.pad(self._audio, (0, first_needed - self._audio.size))
            self._start_model()

        # Do not lose the tail between the final full chunk and VAD end. Pad at
        # most one final streaming chunk with silence and enqueue it.
        chunk_samples = int(self.engine.processor.num_samples_per_audio_chunk)
        needed = self._next_start_idx + chunk_samples
        if int(self._audio.size) < needed:
            self._audio = np.pad(self._audio, (0, needed - int(self._audio.size)))
        self._enqueue_available_features()
        self._feature_queue.put(None)

        if self._model_thread is not None:
            await asyncio.to_thread(self._model_thread.join, 30.0)
            if self._model_thread.is_alive():
                raise RuntimeError("Nemotron streaming generation did not finish within 30s")
        if self._output_thread is not None:
            await asyncio.to_thread(self._output_thread.join, 5.0)
        if self.error is not None:
            raise RuntimeError(f"Nemotron streaming failed: {self.error}") from self.error

        return TranscriptUpdate(
            text=self.transcript,
            latency_ms=(time.perf_counter() - self._started_at) * 1000.0,
            engine=NEMOTRON_MODEL,
        )


class HebrewWhisperEngine:
    """Hebrew rolling-snapshot/final engine using ivrit.ai Faster-Whisper."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._model: Any = None
        self.device = "unloaded"
        self.load_ms = 0.0

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> float:
        if self.loaded:
            return 0.0
        with self._lock:
            if self.loaded:
                return 0.0
            started = time.perf_counter()
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:  # pragma: no cover - GPU image only
                raise RuntimeError(
                    "faster-whisper is missing; build with INSTALL_GPU_ENGINES=1"
                ) from exc
            device = os.getenv("ACOUSTIC_HE_DEVICE", "cuda")
            compute_type = os.getenv("ACOUSTIC_HE_COMPUTE_TYPE", "float16")
            self._model = WhisperModel(
                HEBREW_MODEL,
                device=device,
                compute_type=compute_type,
            )
            self.device = device
            self.load_ms = (time.perf_counter() - started) * 1000.0
            return self.load_ms

    def transcribe(self, samples: Any) -> TranscriptUpdate:
        self.load()
        import numpy as np

        audio = np.asarray(samples, dtype=np.float32).reshape(-1)
        if audio.size == 0:
            return TranscriptUpdate(text="", latency_ms=0.0, engine=HEBREW_MODEL)
        started = time.perf_counter()
        with self._lock:
            segments, _info = self._model.transcribe(
                audio,
                language="he",
                beam_size=1,
                best_of=1,
                temperature=0.0,
                vad_filter=False,
                condition_on_previous_text=False,
                without_timestamps=True,
            )
            text = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
        return TranscriptUpdate(
            text=text.strip(),
            latency_ms=(time.perf_counter() - started) * 1000.0,
            engine=HEBREW_MODEL,
        )


nemotron_engine = NemotronEngine()
hebrew_engine = HebrewWhisperEngine()
