from __future__ import annotations

import pytest

from speakeasy_agent.config import Config
from speakeasy_agent.providers import tts_runpod
from speakeasy_agent.providers.base import ProviderError
from speakeasy_agent.providers.tts_runpod import RunpodTtsProvider


class FakeResponse:
    def __init__(self, *, status: int = 200, pcm: bytes = b"", headers: dict[str, str] | None = None, text: str = "") -> None:
        self.status = status
        self._pcm = pcm
        self.headers = headers or {}
        self._text = text

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def read(self) -> bytes:
        return self._pcm

    async def text(self) -> str:
        return self._text


class FakeSession:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, object]]] = []

    def post(self, url: str, *, json: dict[str, object], timeout: object):
        self.calls.append((url, json))
        return self.response


async def test_runpod_tts_yields_small_pcm_chunks(monkeypatch: pytest.MonkeyPatch):
    sample_rate = 24000
    pcm = bytes(sample_rate // 10 * 2)  # 100 ms mono s16le
    fake = FakeSession(
        FakeResponse(
            pcm=pcm,
            headers={
                "X-SameVoice-Sample-Rate": str(sample_rate),
                "X-SameVoice-Model": "ResembleAI/chatterbox",
                "X-SameVoice-Latency-Ms": "123.4",
                "X-SameVoice-Load-Ms": "0",
                "X-SameVoice-Streaming": "false",
                "X-SameVoice-Watermarked": "true",
            },
        )
    )
    monkeypatch.setattr(tts_runpod, "shared_session", lambda: fake)
    provider = RunpodTtsProvider(Config(runpod_tts_url="http://127.0.0.1:8104"))

    chunks = [chunk async for chunk in provider.synthesize("שלום", lang="he")]

    assert len(chunks) == 5
    assert all(chunk.sample_rate == sample_rate for chunk in chunks)
    assert all(chunk.num_channels == 1 for chunk in chunks)
    assert sum(len(chunk.pcm) for chunk in chunks) == len(pcm)
    assert provider.variant == "ResembleAI/chatterbox"
    assert provider.last_server_latency_ms == 123.4
    assert provider.streaming is False
    assert provider.watermarked is True
    assert fake.calls == [
        (
            "http://127.0.0.1:8104/v1/synthesize",
            {"text": "שלום", "lang": "he"},
        )
    ]


async def test_runpod_tts_rejects_invalid_pcm(monkeypatch: pytest.MonkeyPatch):
    fake = FakeSession(FakeResponse(pcm=b"x"))
    monkeypatch.setattr(tts_runpod, "shared_session", lambda: fake)
    provider = RunpodTtsProvider(Config(runpod_tts_url="http://local-tts"))

    with pytest.raises(ProviderError, match="invalid s16le PCM"):
        _ = [chunk async for chunk in provider.synthesize("test", lang="ru")]


def test_runpod_tts_without_url_keeps_keyless_smoke_behavior():
    provider = RunpodTtsProvider(Config())
    with pytest.raises(NotImplementedError, match="Stage-1 stub"):
        provider.synthesize("test", lang="ru")
