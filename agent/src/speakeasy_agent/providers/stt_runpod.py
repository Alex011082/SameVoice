"""Self-hosted SameVoice acoustic/STT adapter.

The local service exposes one websocket per speech direction. The relay already
asks LiveKit for 16 kHz mono frames, so the wire payload is raw s16le PCM with no
container/header overhead.

Stage-1 server policy:
- Russian -> NVIDIA Nemotron 3.5 cache-aware streaming ASR.
- Hebrew  -> ivrit.ai Whisper Large-v3-Turbo CT2 rolling/final ASR.
- Silero VAD owns speech_start/speech_end for both languages.

The Hebrew path is intentionally not described as native streaming: partials are
rolling snapshots until a Hebrew streaming model clears the quality gate.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, AsyncIterator, Any
from urllib.parse import urlparse, urlunparse

import aiohttp
from livekit import rtc

from ..httpclient import shared_session
from .base import Lang, ProviderError, SttEvent, SttSession

if TYPE_CHECKING:  # pragma: no cover
    from ..config import Config

_SAMPLE_RATE = 16000
_CHANNELS = 1
_MAX_PENDING_AUDIO_FRAMES = 500  # ~5 s for the usual 10 ms LiveKit frames.


def _websocket_url(raw: str) -> str:
    value = raw.strip().rstrip("/")
    if not value:
        return ""
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https", "ws", "wss"):
        raise ProviderError("RUNPOD_STT_URL must use http(s) or ws(s)")
    scheme = {"http": "ws", "https": "wss"}.get(parsed.scheme, parsed.scheme)
    path = parsed.path
    if not path.endswith("/v1/stream"):
        path = path.rstrip("/") + "/v1/stream"
    return urlunparse((scheme, parsed.netloc, path, parsed.params, parsed.query, parsed.fragment))


class RunpodSttSession:
    def __init__(self, websocket: Any, *, lang: Lang) -> None:
        self._ws = websocket
        self._lang = lang
        self._closed = False
        self._audio: asyncio.Queue[bytes | None] = asyncio.Queue(
            maxsize=_MAX_PENDING_AUDIO_FRAMES
        )
        self._sender_error: BaseException | None = None
        self._sender = asyncio.create_task(
            self._send_audio(), name=f"runpod-stt-send:{lang}"
        )
        self.last_engine = ""
        self.last_server_latency_ms: float | None = None

    def push_frame(self, frame: rtc.AudioFrame) -> None:
        if self._closed:
            return
        if int(frame.sample_rate) != _SAMPLE_RATE or int(frame.num_channels) != _CHANNELS:
            raise ProviderError(
                f"local STT requires {_SAMPLE_RATE} Hz mono; got "
                f"{frame.sample_rate} Hz/{frame.num_channels}ch"
            )
        payload = bytes(frame.data)
        if len(payload) % 2:
            raise ProviderError("LiveKit produced an invalid odd-length s16le frame")
        try:
            self._audio.put_nowait(payload)
        except asyncio.QueueFull as exc:
            raise ProviderError(
                "local STT audio queue exceeded 5 seconds; GPU service is not keeping up"
            ) from exc

    async def _send_audio(self) -> None:
        try:
            while True:
                payload = await self._audio.get()
                try:
                    if payload is None:
                        return
                    await self._ws.send_bytes(payload)
                finally:
                    self._audio.task_done()
        except BaseException as exc:
            self._sender_error = exc
            raise

    def _check_sender(self) -> None:
        if self._sender_error is not None:
            raise ProviderError(f"local STT audio sender failed: {self._sender_error}")

    async def flush(self) -> None:
        if self._closed:
            return
        await self._audio.join()
        self._check_sender()
        await self._ws.send_json({"type": "flush"})

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            await asyncio.wait_for(self._audio.join(), timeout=2.0)
            if self._sender_error is None:
                await self._ws.send_json({"type": "close"})
        except (asyncio.TimeoutError, Exception):
            pass
        finally:
            with suppress_queue_full():
                self._audio.put_nowait(None)
            if not self._sender.done():
                try:
                    await asyncio.wait_for(self._sender, timeout=2.0)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    self._sender.cancel()
            try:
                await self._ws.close()
            except Exception:
                pass

    def __aiter__(self) -> AsyncIterator[SttEvent]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[SttEvent]:
        try:
            async for message in self._ws:
                if message.type == aiohttp.WSMsgType.TEXT:
                    try:
                        payload = json.loads(message.data)
                    except json.JSONDecodeError as exc:
                        raise ProviderError("local STT returned invalid JSON") from exc
                    if not isinstance(payload, dict):
                        continue
                    event_type = payload.get("type")
                    if event_type == "ready":
                        engine = payload.get("engine")
                        if isinstance(engine, str):
                            self.last_engine = engine
                        continue
                    if event_type == "error":
                        raise ProviderError(str(payload.get("text") or "local STT error"))
                    if event_type not in ("speech_start", "partial", "final", "speech_end"):
                        continue
                    text = payload.get("text")
                    text = text if isinstance(text, str) else ""
                    if event_type in ("partial", "final") and not text.strip():
                        continue
                    engine = payload.get("engine")
                    if isinstance(engine, str) and engine.strip():
                        self.last_engine = engine.strip()
                    self.last_server_latency_ms = _number(payload.get("latency_ms"))
                    yield SttEvent(
                        type=event_type,  # type: ignore[arg-type]
                        text=text.strip(),
                        lang=self._lang,
                        start=_number(payload.get("start")) or 0.0,
                        end=_number(payload.get("end")) or 0.0,
                        confidence=_number(payload.get("confidence")) or 0.0,
                    )
                elif message.type in (
                    aiohttp.WSMsgType.CLOSE,
                    aiohttp.WSMsgType.CLOSED,
                ):
                    return
                elif message.type == aiohttp.WSMsgType.ERROR:
                    raise ProviderError(f"local STT websocket failed: {self._ws.exception()}")
        finally:
            self._check_sender()


class RunpodSttProvider:
    name = "runpod"
    preferred_sample_rate = _SAMPLE_RATE
    preferred_num_channels = _CHANNELS

    def __init__(self, cfg: "Config") -> None:
        self._url = _websocket_url(cfg.runpod_stt_url)
        self._timeout = aiohttp.ClientTimeout(total=None, sock_connect=2.0)

    @property
    def variant(self) -> str:
        return "nemotron3.5-ru+ivrit-whisper-he"

    async def start(self, *, lang: Lang) -> SttSession:
        if not self._url:
            raise NotImplementedError(
                "runpod provider is a Stage-1 stub until RUNPOD_STT_URL is configured"
            )
        try:
            websocket = await shared_session().ws_connect(
                self._url,
                heartbeat=15.0,
                timeout=self._timeout,
                max_msg_size=2 * 1024 * 1024,
            )
            await websocket.send_json(
                {
                    "type": "start",
                    "lang": lang,
                    "sample_rate": self.preferred_sample_rate,
                    "channels": self.preferred_num_channels,
                    "encoding": "pcm_s16le",
                }
            )
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise ProviderError(f"local STT connection failed: {exc}") from exc
        return RunpodSttSession(websocket, lang=lang)

    async def aclose(self) -> None:
        # Per-direction websocket sessions own their sockets. The aiohttp session
        # is shared process-wide and closed once by main.py.
        return None


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    return float(value) if isinstance(value, (int, float)) else None


class suppress_queue_full:
    """Tiny local context manager to keep aclose() dependency-free."""

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return exc_type is asyncio.QueueFull
