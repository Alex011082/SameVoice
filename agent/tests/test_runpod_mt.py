from __future__ import annotations

import pytest

from speakeasy_agent.config import Config
from speakeasy_agent.providers.base import MtRequest, ProviderError, Speaker
from speakeasy_agent.providers import mt_runpod
from speakeasy_agent.providers.mt_runpod import RunpodMtProvider

ALEX = Speaker(user_id="u1", display_name="Alex", lang="ru", gender="m", tone="neutral")
NOA = Speaker(user_id="u2", display_name="Noa", lang="he", gender="f", tone="neutral")


class FakeResponse:
    def __init__(self, *, status: int = 200, data: object = None, text: str = "") -> None:
        self.status = status
        self._data = data
        self._text = text

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def json(self):
        return self._data

    async def text(self):
        return self._text


class FakeSession:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.calls: list[tuple[str, dict[str, object]]] = []

    def post(self, url: str, *, json: dict[str, object], timeout: object):
        self.calls.append((url, json))
        return self.response


def request() -> MtRequest:
    return MtRequest(
        text="привет",
        src_lang="ru",
        dst_lang="he",
        speaker=ALEX,
        listener=NOA,
        is_continuation=False,
    )


async def test_runpod_mt_calls_local_contract(monkeypatch: pytest.MonkeyPatch):
    fake = FakeSession(
        FakeResponse(
            data={
                "text": "שלום",
                "model": "Helsinki-NLP/opus-mt-ru-he",
                "latency_ms": 17.5,
                "load_ms": 0.0,
            }
        )
    )
    monkeypatch.setattr(mt_runpod, "shared_session", lambda: fake)
    provider = RunpodMtProvider(Config(runpod_mt_url="http://127.0.0.1:8103"))

    result = await provider.translate(request())

    assert result.text == "שלום"
    assert result.provider == "runpod"
    assert result.latency_ms >= 0.0
    assert provider.variant == "Helsinki-NLP/opus-mt-ru-he"
    assert provider.last_server_latency_ms == 17.5
    assert fake.calls == [
        (
            "http://127.0.0.1:8103/v1/translate",
            {"text": "привет", "src_lang": "ru", "dst_lang": "he"},
        )
    ]


async def test_runpod_mt_surfaces_service_error(monkeypatch: pytest.MonkeyPatch):
    fake = FakeSession(FakeResponse(status=503, text="model unavailable"))
    monkeypatch.setattr(mt_runpod, "shared_session", lambda: fake)
    provider = RunpodMtProvider(Config(runpod_mt_url="http://local-mt"))

    with pytest.raises(ProviderError, match="HTTP 503"):
        await provider.translate(request())


async def test_runpod_mt_without_url_keeps_keyless_smoke_behavior():
    provider = RunpodMtProvider(Config())
    with pytest.raises(NotImplementedError, match="Stage-1 stub"):
        await provider.translate(request())
