from __future__ import annotations

import asyncio
from dataclasses import dataclass

from speakeasy_agent.providers.base import Speaker, SttEvent
from speakeasy_agent.speculation import (
    PredictionCandidate,
    PredictionResult,
    PredictionShadow,
    ShadowSttSession,
    common_prefix_len,
    words,
)


class FakeEvalLog:
    def __init__(self) -> None:
        self.records: list[dict] = []

    def append(self, record: dict) -> None:
        self.records.append(record)


class FakePredictor:
    def __init__(self, candidates: tuple[str, ...]) -> None:
        self.candidates = candidates
        self.calls: list[dict] = []
        self.closed = False

    async def predict(self, *, prefix, lang, top_k, context_terms):
        self.calls.append(
            {
                "prefix": prefix,
                "lang": lang,
                "top_k": top_k,
                "context_terms": tuple(context_terms),
            }
        )
        await asyncio.sleep(0)
        return PredictionResult(
            candidates=tuple(
                PredictionCandidate(word=word, probability=1.0 / len(self.candidates))
                for word in self.candidates
            ),
            model="fake-next-word",
            model_latency_ms=4.0,
            round_trip_ms=5.0,
        )

    async def aclose(self) -> None:
        self.closed = True


def _speaker(lang: str = "ru") -> Speaker:
    return Speaker(
        user_id="tester",
        display_name="Tester",
        lang=lang,  # type: ignore[arg-type]
        gender="u",
        tone="neutral",
    )


def test_words_support_russian_hebrew_and_joiners():
    assert words("Привет, как дела?") == ("привет", "как", "дела")
    assert words("שלום, מה שלומך?") == ("שלום", "מה", "שלומך")
    assert words("кто-то O’Neil") == ("кто-то", "o’neil")


def test_common_prefix_len_is_conservative():
    assert common_prefix_len(("я", "хочу"), ("я", "хочу", "кофе")) == 2
    assert common_prefix_len(("я", "хочу", "чай"), ("я", "хочу", "кофе")) == 2


async def test_shadow_scores_next_word_only_after_stt_stabilizes_it():
    log = FakeEvalLog()
    predictor = FakePredictor(("купить", "увидеть", "сказать"))
    shadow = PredictionShadow(
        call_id="call-test",
        speaker=_speaker(),
        client=predictor,
        eval_log=log,  # type: ignore[arg-type]
        top_k=20,
        min_prefix_words=2,
    )

    # First hypothesis cannot prove stability by itself.
    shadow.observe("я хочу", now=1.0)
    assert predictor.calls == []

    # The same two-word prefix survived the next hypothesis, so predict word 3.
    shadow.observe("я хочу купить", now=1.1)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert predictor.calls[0]["prefix"] == "я хочу"
    assert not [r for r in log.records if r.get("status") == "resolved"]

    # 'купить' is now present in two consecutive hypotheses and is safe to score.
    shadow.observe("я хочу купить машину", now=1.2)
    await asyncio.sleep(0)
    resolved = [r for r in log.records if r.get("kind") == "prediction_shadow" and r.get("status") == "resolved"]
    assert len(resolved) == 1
    assert resolved[0]["actualNextWord"] == "купить"
    assert resolved[0]["rank"] == 1
    assert resolved[0]["hits"]["top1"] is True
    assert shadow.stats.resolved == 1
    assert shadow.stats.top1_hits == 1

    await shadow.aclose()
    assert predictor.closed is True


async def test_shadow_final_can_verify_the_next_word_without_a_second_partial():
    log = FakeEvalLog()
    predictor = FakePredictor(("עכשיו", "מחר", "כאן"))
    shadow = PredictionShadow(
        call_id="call-he",
        speaker=_speaker("he"),
        client=predictor,
        eval_log=log,  # type: ignore[arg-type]
        min_prefix_words=2,
    )

    shadow.observe("אני רוצה", now=2.0)
    shadow.observe("אני רוצה עכשיו", now=2.1)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    shadow.observe("אני רוצה עכשיו לדבר", now=2.2, final=True)

    resolved = [r for r in log.records if r.get("kind") == "prediction_shadow" and r.get("status") == "resolved"]
    assert resolved[0]["actualNextWord"] == "עכשיו"
    assert resolved[0]["rank"] == 1
    await shadow.aclose()


@dataclass
class FakeMessageSource:
    events: list[SttEvent]
    closed: bool = False
    flushed: bool = False

    def push_frame(self, frame) -> None:
        return None

    async def flush(self) -> None:
        self.flushed = True

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        for event in self.events:
            yield event

    async def aclose(self) -> None:
        self.closed = True


class SpyShadow:
    def __init__(self) -> None:
        self.observed: list[tuple[str, bool]] = []
        self.resets: list[str] = []
        self.closed = False

    def observe(self, text: str, *, now=None, final=False) -> None:
        self.observed.append((text, final))

    def reset(self, *, reason="reset") -> None:
        self.resets.append(reason)

    async def aclose(self) -> None:
        self.closed = True


async def test_shadow_stt_session_is_transparent_to_the_call_pipeline():
    events = [
        SttEvent(type="speech_start", text="", lang="ru", start=0.0, end=0.0),
        SttEvent(type="partial", text="я хочу", lang="ru", start=0.0, end=0.4),
        SttEvent(type="final", text="я хочу кофе", lang="ru", start=0.0, end=0.8),
        SttEvent(type="speech_end", text="", lang="ru", start=0.0, end=0.8),
    ]
    source = FakeMessageSource(events)
    spy = SpyShadow()
    session = ShadowSttSession(source, spy)  # type: ignore[arg-type]

    yielded = [event async for event in session]
    assert yielded == events
    assert spy.resets == ["speech_start"]
    assert spy.observed == [("я хочу", False), ("я хочу кофе", True)]

    await session.flush()
    await session.aclose()
    assert source.flushed is True
    assert source.closed is True
    assert spy.closed is True
