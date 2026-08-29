"""SameVoice local acoustic service: VAD + RU streaming ASR + HE rolling ASR.

Wire protocol:
1. connect to websocket `/v1/stream`;
2. first text message: {"type":"start","lang":"ru|he","sample_rate":16000,"channels":1};
3. send mono s16le PCM as binary websocket frames;
4. receive JSON `speech_start`, `partial`, `final`, `speech_end` events;
5. optional {"type":"flush"} finalizes the current utterance without closing.

This is an R&D transport, not a claim that Hebrew has native RNNT streaming:
Russian uses Nemotron cache-aware streaming; Hebrew uses ivrit.ai Faster-Whisper
rolling snapshots behind the same VAD/event contract.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections import deque
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from .engines import HEBREW_MODEL, NEMOTRON_MODEL, hebrew_engine, nemotron_engine
from .protocol import AcousticEvent, SAMPLE_RATE, validate_pcm, validate_start_message

VAD_WINDOW_SAMPLES = 512  # 32 ms at 16 kHz, required by Silero VAD.
VAD_THRESHOLD = float(os.getenv("ACOUSTIC_VAD_THRESHOLD", "0.5"))
VAD_MIN_SILENCE_MS = int(os.getenv("ACOUSTIC_VAD_MIN_SILENCE_MS", "180"))
VAD_SPEECH_PAD_MS = int(os.getenv("ACOUSTIC_VAD_SPEECH_PAD_MS", "40"))
PRE_ROLL_MS = int(os.getenv("ACOUSTIC_PRE_ROLL_MS", "320"))
HE_PARTIAL_INTERVAL_MS = int(os.getenv("ACOUSTIC_HE_PARTIAL_INTERVAL_MS", "480"))
HE_PARTIAL_MIN_AUDIO_MS = int(os.getenv("ACOUSTIC_HE_PARTIAL_MIN_AUDIO_MS", "700"))


class WarmupRequest(BaseModel):
    lang: str


class SileroVadFactory:
    def __init__(self) -> None:
        self._model: Any = None
        self._lock = asyncio.Lock()
        self.load_ms = 0.0

    @property
    def loaded(self) -> bool:
        return self._model is not None

    async def load(self) -> float:
        if self.loaded:
            return 0.0
        async with self._lock:
            if self.loaded:
                return 0.0
            started = time.perf_counter()

            def _load():
                try:
                    import torch
                    from silero_vad import load_silero_vad
                except ImportError as exc:  # pragma: no cover - GPU image only
                    raise RuntimeError(
                        "Silero VAD is missing; build with INSTALL_GPU_ENGINES=1"
                    ) from exc
                torch.set_num_threads(max(1, int(os.getenv("ACOUSTIC_VAD_CPU_THREADS", "1"))))
                return load_silero_vad()

            self._model = await asyncio.to_thread(_load)
            self.load_ms = (time.perf_counter() - started) * 1000.0
            return self.load_ms

    async def new_iterator(self):
        await self.load()
        from silero_vad import VADIterator

        return VADIterator(
            self._model,
            threshold=VAD_THRESHOLD,
            sampling_rate=SAMPLE_RATE,
            min_silence_duration_ms=VAD_MIN_SILENCE_MS,
            speech_pad_ms=VAD_SPEECH_PAD_MS,
        )


vad_factory = SileroVadFactory()


@dataclass
class _Utterance:
    id: int
    start_sample: int
    audio: Any
    ru_stream: Any = None
    he_partial_task: asyncio.Task | None = None
    he_partial_at_samples: int = 0
    last_partial: str = ""


class AcousticSession:
    def __init__(self, websocket: WebSocket, *, lang: str, vad: Any) -> None:
        import numpy as np

        self.websocket = websocket
        self.lang = lang
        self.vad = vad
        self.np = np
        self._outgoing: asyncio.Queue[AcousticEvent | None] = asyncio.Queue()
        self._sender = asyncio.create_task(self._send_loop(), name=f"acoustic-send:{lang}")
        self._vad_buffer = np.empty(0, dtype=np.float32)
        self._pre_roll: deque[Any] = deque(
            maxlen=max(1, (PRE_ROLL_MS * SAMPLE_RATE // 1000 + VAD_WINDOW_SAMPLES - 1) // VAD_WINDOW_SAMPLES)
        )
        self._samples_seen = 0
        self._utterance_seq = 0
        self._utterance: _Utterance | None = None
        self._closed = False

    @property
    def engine_name(self) -> str:
        return NEMOTRON_MODEL if self.lang == "ru" else HEBREW_MODEL

    async def _send_loop(self) -> None:
        while True:
            event = await self._outgoing.get()
            try:
                if event is None:
                    return
                await self.websocket.send_json(event.as_dict())
            finally:
                self._outgoing.task_done()

    def emit(self, event: AcousticEvent) -> None:
        if not self._closed:
            self._outgoing.put_nowait(event)

    async def feed_pcm(self, payload: bytes) -> None:
        validate_pcm(payload)
        if not payload:
            return
        pcm = self.np.frombuffer(payload, dtype="<i2").astype(self.np.float32) / 32768.0
        self._vad_buffer = self.np.concatenate((self._vad_buffer, pcm))
        while self._vad_buffer.size >= VAD_WINDOW_SAMPLES:
            chunk = self._vad_buffer[:VAD_WINDOW_SAMPLES].copy()
            self._vad_buffer = self._vad_buffer[VAD_WINDOW_SAMPLES:]
            await self._process_vad_chunk(chunk)

    async def _process_vad_chunk(self, chunk: Any) -> None:
        import torch

        chunk_start = self._samples_seen
        self._samples_seen += int(chunk.size)
        was_speaking = self._utterance is not None
        self._pre_roll.append(chunk.copy())
        signal = self.vad(torch.from_numpy(chunk), return_seconds=False)
        signal = signal or {}

        if "start" in signal and self._utterance is None:
            self._utterance_seq += 1
            start_sample = max(0, int(signal["start"]))
            audio = self.np.concatenate(tuple(self._pre_roll)).astype(self.np.float32, copy=False)
            utterance = _Utterance(
                id=self._utterance_seq,
                start_sample=start_sample,
                audio=audio,
                he_partial_at_samples=int(audio.size),
            )
            self._utterance = utterance
            self.emit(
                AcousticEvent(
                    type="speech_start",
                    lang=self.lang,  # type: ignore[arg-type]
                    start=start_sample / SAMPLE_RATE,
                    end=self._samples_seen / SAMPLE_RATE,
                    engine=self.engine_name,
                )
            )
            if self.lang == "ru":
                loop = asyncio.get_running_loop()

                def on_partial(update) -> None:
                    current = self._utterance
                    if current is None or current.id != utterance.id or not update.text.strip():
                        return
                    current.last_partial = update.text.strip()
                    self.emit(
                        AcousticEvent(
                            type="partial",
                            text=current.last_partial,
                            lang="ru",
                            start=current.start_sample / SAMPLE_RATE,
                            end=self._samples_seen / SAMPLE_RATE,
                            engine=update.engine,
                            latency_ms=update.latency_ms,
                        )
                    )

                utterance.ru_stream = nemotron_engine.new_utterance(
                    loop=loop,
                    on_partial=on_partial,
                )
                utterance.ru_stream.feed(audio)
            else:
                self._maybe_schedule_he_partial(utterance)

        elif was_speaking and self._utterance is not None:
            utterance = self._utterance
            utterance.audio = self.np.concatenate((utterance.audio, chunk))
            if self.lang == "ru":
                utterance.ru_stream.feed(chunk)
            else:
                self._maybe_schedule_he_partial(utterance)

        if "end" in signal and self._utterance is not None:
            end_sample = max(chunk_start, int(signal["end"]))
            await self._finish_utterance(end_sample=end_sample)
            self._pre_roll.clear()

    def _maybe_schedule_he_partial(self, utterance: _Utterance) -> None:
        min_samples = HE_PARTIAL_MIN_AUDIO_MS * SAMPLE_RATE // 1000
        interval_samples = HE_PARTIAL_INTERVAL_MS * SAMPLE_RATE // 1000
        if int(utterance.audio.size) < min_samples:
            return
        if int(utterance.audio.size) - utterance.he_partial_at_samples < interval_samples:
            return
        if utterance.he_partial_task is not None and not utterance.he_partial_task.done():
            return
        snapshot = utterance.audio.copy()
        utterance.he_partial_at_samples = int(snapshot.size)
        utterance.he_partial_task = asyncio.create_task(
            self._run_he_partial(utterance.id, snapshot),
            name=f"he-partial:{utterance.id}",
        )

    async def _run_he_partial(self, utterance_id: int, snapshot: Any) -> None:
        try:
            update = await asyncio.to_thread(hebrew_engine.transcribe, snapshot)
        except Exception as exc:
            self.emit(AcousticEvent(type="error", text=f"Hebrew partial ASR failed: {exc}"))
            return
        current = self._utterance
        if current is None or current.id != utterance_id:
            return
        text = update.text.strip()
        if not text or text == current.last_partial:
            return
        current.last_partial = text
        self.emit(
            AcousticEvent(
                type="partial",
                text=text,
                lang="he",
                start=current.start_sample / SAMPLE_RATE,
                end=self._samples_seen / SAMPLE_RATE,
                engine=update.engine,
                latency_ms=update.latency_ms,
            )
        )

    async def _finish_utterance(self, *, end_sample: int) -> None:
        utterance = self._utterance
        if utterance is None:
            return
        self._utterance = None

        try:
            if self.lang == "ru":
                update = await utterance.ru_stream.finish()
            else:
                if utterance.he_partial_task is not None:
                    with suppress(Exception):
                        await utterance.he_partial_task
                update = await asyncio.to_thread(hebrew_engine.transcribe, utterance.audio.copy())
        except Exception as exc:
            self.emit(AcousticEvent(type="error", text=f"ASR finalization failed: {exc}"))
            self.emit(
                AcousticEvent(
                    type="speech_end",
                    lang=self.lang,  # type: ignore[arg-type]
                    start=utterance.start_sample / SAMPLE_RATE,
                    end=end_sample / SAMPLE_RATE,
                    engine=self.engine_name,
                )
            )
            return

        text = update.text.strip()
        if text:
            self.emit(
                AcousticEvent(
                    type="final",
                    text=text,
                    lang=self.lang,  # type: ignore[arg-type]
                    start=utterance.start_sample / SAMPLE_RATE,
                    end=end_sample / SAMPLE_RATE,
                    confidence=0.0,
                    engine=update.engine,
                    latency_ms=update.latency_ms,
                )
            )
        self.emit(
            AcousticEvent(
                type="speech_end",
                lang=self.lang,  # type: ignore[arg-type]
                start=utterance.start_sample / SAMPLE_RATE,
                end=end_sample / SAMPLE_RATE,
                engine=update.engine,
            )
        )

    async def flush(self) -> None:
        # Preserve any tail smaller than the 512-sample VAD window if speech is
        # already active. We do not invent speech_start for random sub-window
        # noise on hangup.
        if self._utterance is not None and self._vad_buffer.size:
            tail = self._vad_buffer.copy()
            self._vad_buffer = self.np.empty(0, dtype=self.np.float32)
            self._samples_seen += int(tail.size)
            self._utterance.audio = self.np.concatenate((self._utterance.audio, tail))
            if self.lang == "ru":
                self._utterance.ru_stream.feed(tail)
        if self._utterance is not None:
            await self._finish_utterance(end_sample=self._samples_seen)
        with suppress(Exception):
            self.vad.reset_states()
        self._pre_roll.clear()

    async def close(self) -> None:
        if self._closed:
            return
        await self.flush()
        # Wait until every final event queued above has reached the websocket.
        await self._outgoing.join()
        self._closed = True
        self._outgoing.put_nowait(None)
        with suppress(Exception):
            await self._sender


app = FastAPI(title="SameVoice Acoustic Stage 1", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {
        "ok": True,
        "service": "acoustic-stage1",
        "sample_rate": SAMPLE_RATE,
        "vad_loaded": vad_factory.loaded,
        "ru_engine": NEMOTRON_MODEL,
        "ru_loaded": nemotron_engine.loaded,
        "ru_streaming_latency_ms": nemotron_engine.streaming_latency_ms,
        "he_engine": HEBREW_MODEL,
        "he_loaded": hebrew_engine.loaded,
        "he_mode": "rolling-snapshot",
    }


@app.post("/v1/warmup")
async def warmup(req: WarmupRequest) -> dict[str, object]:
    if req.lang not in ("ru", "he"):
        raise HTTPException(status_code=400, detail="lang must be ru or he")
    vad_ms = await vad_factory.load()
    try:
        if req.lang == "ru":
            model_ms = await asyncio.to_thread(nemotron_engine.load)
            engine = NEMOTRON_MODEL
            detail = {"streaming_latency_ms": nemotron_engine.streaming_latency_ms}
        else:
            model_ms = await asyncio.to_thread(hebrew_engine.load)
            engine = HEBREW_MODEL
            detail = {"mode": "rolling-snapshot"}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {
        "ok": True,
        "lang": req.lang,
        "vad_load_ms": vad_ms,
        "model_load_ms": model_ms,
        "engine": engine,
        **detail,
    }


@app.websocket("/v1/stream")
async def stream(websocket: WebSocket) -> None:
    await websocket.accept()
    session: AcousticSession | None = None
    try:
        first = await websocket.receive_text()
        try:
            payload = json.loads(first)
            lang, _rate = validate_start_message(payload)
        except (json.JSONDecodeError, ValueError) as exc:
            await websocket.send_json(AcousticEvent(type="error", text=str(exc)).as_dict())
            await websocket.close(code=1008)
            return

        vad = await vad_factory.new_iterator()
        session = AcousticSession(websocket, lang=lang, vad=vad)
        session.emit(
            AcousticEvent(
                type="ready",
                lang=lang,
                engine=session.engine_name,
            )
        )

        while True:
            message = await websocket.receive()
            kind = message.get("type")
            if kind == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data is not None:
                await session.feed_pcm(data)
                continue
            text = message.get("text")
            if text is None:
                continue
            try:
                control = json.loads(text)
            except json.JSONDecodeError:
                session.emit(AcousticEvent(type="error", text="invalid control JSON"))
                continue
            control_type = control.get("type") if isinstance(control, dict) else None
            if control_type == "flush":
                await session.flush()
            elif control_type == "close":
                break
            else:
                session.emit(AcousticEvent(type="error", text="unknown control message"))
    except WebSocketDisconnect:
        pass
    finally:
        if session is not None:
            with suppress(Exception):
                await session.close()
        with suppress(Exception):
            await websocket.close()
