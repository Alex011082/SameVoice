"""HTTP adapter for the colocated SameVoice local MT service."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

import aiohttp

from ..httpclient import shared_session
from .base import MtRequest, MtResult, ProviderError

if TYPE_CHECKING:
    from ..config import Config


class RunpodMtProvider:
    name = "runpod"

    def __init__(self, cfg: "Config") -> None:
        base = cfg.runpod_mt_url.strip().rstrip("/")
        if not base:
            raise ProviderError("MT_PROVIDER=runpod requires RUNPOD_MT_URL or LOCAL_MT_URL")
        self._url = base if base.endswith("/v1/translate") else base + "/v1/translate"
        self._variant = "local-marian"
        self._timeout = aiohttp.ClientTimeout(total=4.0, sock_connect=1.0)
        self.last_server_latency_ms: float | None = None
        self.last_server_load_ms: float | None = None

    @property
    def variant(self) -> str:
        return self._variant

    async def translate(self, req: MtRequest) -> MtResult:
        started = time.perf_counter()
        try:
            async with shared_session().post(
                self._url,
                json={"text": req.text, "src_lang": req.src_lang, "dst_lang": req.dst_lang},
                timeout=self._timeout,
            ) as response:
                if response.status != 200:
                    detail = (await response.text())[:1000]
                    raise ProviderError(f"local MT HTTP {response.status}: {detail}")
                data = await response.json()
        except ProviderError:
            raise
        except (aiohttp.ClientError, TimeoutError) as exc:
            raise ProviderError(f"local MT request failed: {exc}") from exc

        observed_ms = (time.perf_counter() - started) * 1000.0
        if not isinstance(data, dict):
            raise ProviderError("local MT returned invalid JSON")
        text = data.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ProviderError("local MT returned an empty translation")
        model = data.get("model")
        if isinstance(model, str) and model.strip():
            self._variant = model.strip()
        self.last_server_latency_ms = _number(data.get("latency_ms"))
        self.last_server_load_ms = _number(data.get("load_ms"))
        return MtResult(text=text.strip(), provider=self.name, latency_ms=observed_ms)

    async def aclose(self) -> None:
        return None


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    return float(value) if isinstance(value, (int, float)) else None
