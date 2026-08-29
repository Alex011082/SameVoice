from __future__ import annotations

from dataclasses import dataclass

import aiohttp
import pytest

from speakeasy_agent.config import Config
from speakeasy_agent.providers.stt_runpod import (
    RunpodSttProvider,
    RunpodSttSession,
    _websocket_url,
)


@dataclass
class FakeFrame:
    data: bytes
    sample_rate: int = 16000
    num_channels: int = 1


class FakeMessage:
    def __init__(self, data: str, message_type=aiohttp.WSMsgType.TEXT) -> None:
        self.data = data
        self.type = message_type


class FakeWebSocket:
    def __init__(self, messages: list[FakeMessage] | None = None) -> None:
        self.messages = list(messages or [])
        self.sent_bytes: list[bytes] = []
        self.sent_json: list[dict[str, object]] = []
        self.closed = False

    async def send_bytes(self, payload: bytes) -> None:
        self.sent_bytes.append(payload)

    async def send_json(self, payload: dict[str, object]) -> None:
        self.sent_json.append(payload)

    async def close(self) -> None:
        self.closed = True

    def exception(self):
        return None

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self.messages:
            raise StopAsyncIteration
        return self.messages.pop(0)


def test_websocket_url_normalization():
    assert _websocket_url("http://127.0.0.1:8102") == "ws://127.0.0.1:8102/v1/stream"
    assert _websocket_url("https://asr.example/x") == "wss://asr.example/x/v1/stream"
    assert _websocket_url("ws://local/v1/stream") == "ws://local/v1/stream"


async def test_session_sends_raw_pcm_then_flushes():
    ws = FakeWebSocket()
    session = RunpodSttSession(ws, lang="ru")
    session.push_frame(FakeFrame(data=b"\x01\x00\x02\x00"))  # type: ignore[arg-type]
    await session.flush()
    assert ws.sent_bytes == [b"\x01\x00\x02\x00"]
    assert ws.sent_json == [{"type": "flush"}]
    await session.aclose()
    assert ws.closed is True


async def test_session_maps_server_events():
    ws = FakeWebSocket(
        [
            FakeMessage('{"type":"ready","engine":"nemotron"}'),
            FakeMessage('{"type":"speech_start","start":0.1,"end":0.2}'),
            FakeMessage(
                '{"type":"partial","text":"привет","start":0.1,"end":0.7,'
                '"latency_ms":123.4,"engine":"nemotron"}'
            ),
            FakeMessage('{"type":"final","text":"привет мир","start":0.1,"end":1.1}'),
            FakeMessage('{"type":"speech_end","start":0.1,"end":1.1}'),
        ]
    )
    session = RunpodSttSession(ws, lang="ru")
    events = [event async for event in session]
    assert [event.type for event in events] == [
        "speech_start",
        "partial",
        "final",
        "speech_end",
    ]
    assert events[1].text == "привет"
    assert session.last_engine == "nemotron"
    assert session.last_server_latency_ms == 123.4
    await session.aclose()


async def test_session_rejects_wrong_frame_format():
    ws = FakeWebSocket()
    session = RunpodSttSession(ws, lang="ru")
    with pytest.raises(Exception, match="16000 Hz mono"):
        session.push_frame(FakeFrame(data=b"\0\0", sample_rate=48000))  # type: ignore[arg-type]
    await session.aclose()


async def test_provider_without_url_preserves_keyless_stub():
    provider = RunpodSttProvider(Config())
    with pytest.raises(NotImplementedError, match="RUNPOD_STT_URL"):
        await provider.start(lang="he")
