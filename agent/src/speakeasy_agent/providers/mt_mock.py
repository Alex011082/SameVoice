"""Fixture-dictionary mock MT.

MECHANICS ONLY. The fixture table is five phrases per direction; anything else
falls through to a loudly-marked passthrough so a fixture miss is visible in
subtitles instead of silently looking like a translation. Never judge
translation quality from this adapter.

The RU->HE fixtures are written for a MALE speaker addressing a FEMALE listener
(`את שומעת`, `בואי ניפגש`, `אני צריך`) and the HE->RU fixtures for a female
speaker (`אני שומעת`), so the gender contract is visible in mock output.
"""

from __future__ import annotations

import asyncio
import time
import unicodedata

from .base import Lang, MtRequest, MtResult
from .stt_mock import load_fixtures

# Artificial delay so the chunker, cancellation path and TTS handoff see a
# realistic non-zero MT stage instead of an instantaneous one.
MOCK_MT_DELAY_S = 0.005

_STRIP = " \t\r\n.,;:!?…«»\"'()[]{}־"


def _normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = " ".join(text.split())
    return text.strip(_STRIP).lower()


def _build_table() -> dict[tuple[str, str], str]:
    data = load_fixtures()
    table: dict[tuple[str, str], str] = {}
    for entry in data.get("ru", []):
        table[("ru", _normalize(entry["src"]))] = entry["he"]
        table[("he", _normalize(entry["he"]))] = entry["src"]
    for entry in data.get("he", []):
        table[("he", _normalize(entry["src"]))] = entry["ru"]
        table[("ru", _normalize(entry["ru"]))] = entry["src"]
    return table


class MockMtProvider:
    name = "mock"

    def __init__(self, *, delay_s: float = MOCK_MT_DELAY_S) -> None:
        self._table = _build_table()
        self._delay_s = delay_s

    async def translate(self, req: MtRequest) -> MtResult:
        started = time.perf_counter()
        await asyncio.sleep(self._delay_s)
        text = req.text.strip()
        if not text:
            return MtResult(text="", provider=self.name, latency_ms=0.0)
        hit = self._table.get((req.src_lang, _normalize(text)))
        if hit is None:
            hit = f"«{text}» [mock {req.src_lang}→{req.dst_lang}]"
        return MtResult(
            text=hit,
            provider=self.name,
            latency_ms=(time.perf_counter() - started) * 1000.0,
        )

    async def aclose(self) -> None:
        return None
