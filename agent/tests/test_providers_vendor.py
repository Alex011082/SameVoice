"""The vendor adapters, exercised without ever touching a vendor.

These adapters had never been run against the real APIs. Every assertion here
pins one of the mismatches found in the provider review, so that a future edit
that reintroduces it fails loudly instead of silently costing a test session.
No network, no keys, no plugins constructed for real.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

import pytest

from speakeasy_agent.config import Config
from speakeasy_agent.providers.base import MtRequest, ProviderError, Speaker
from speakeasy_agent.providers.mt_gemini import (
    GeminiMtProvider,
    _extract_text,
    build_system_instruction,
)
from speakeasy_agent.providers.mt_openai import OpenAiMtProvider
from speakeasy_agent.providers.mt_openai import _extract_text as openai_extract

ALEX = Speaker(user_id="u_alex", display_name="Alex", lang="ru", gender="m", tone="neutral")
NOA = Speaker(user_id="u_noa", display_name="Noa", lang="he", gender="f", tone="friendly")
UNKNOWN = Speaker(user_id="u_x", display_name="X", lang="he", gender="u", tone="neutral")


# The Deepgram/Cartesia adapters import their livekit plugin lazily, inside
# __init__, because those plugins live in the OPTIONAL `api` extra. The default
# install (`uv sync`, mock providers only, no keys) does not have them, and
# `npm run smoke` runs against exactly that install — so the handful of tests
# that must really construct an adapter skip instead of failing there. They
# still run in full on `uv sync --extra api`.
def _require_plugin(module: str):
    return pytest.importorskip(
        f"livekit.plugins.{module}",
        reason=f"livekit-plugins-{module} is in the optional `api` extra (uv sync --extra api)",
    )


# ----------------------------------------------------------------- Gemini: prompt


def test_the_prompt_carries_both_hebrew_genders_for_the_ru_to_he_direction():
    """Hebrew inflects on BOTH axes at once. Getting one right and the other
    wrong still sounds broken to a native speaker, so both must be stated."""
    prompt = build_system_instruction(
        src_lang="ru", dst_lang="he", speaker=ALEX, listener=NOA, glossary={}
    )
    assert "Speaker is male" in prompt
    assert "first-person" in prompt
    assert "Listener is female" in prompt
    assert "feminine singular" in prompt
    # The Hebrew requirement must be explicit, not implied.
    assert "Hebrew marks gender grammatically" in prompt
    assert "Register: friendly colloquial." in prompt


def test_the_prompt_carries_both_genders_and_the_address_form_for_he_to_ru():
    prompt = build_system_instruction(
        src_lang="he", dst_lang="ru", speaker=NOA, listener=ALEX, glossary={}
    )
    assert "Speaker is female" in prompt
    assert "Listener is male" in prompt
    assert "masculine singular" in prompt
    # Hebrew does not encode ты/вы, so the target language's address form has to
    # be decided explicitly or the model will guess differently every unit.
    assert 'Address the listener with "ты".' in prompt
    assert "past-tense" in prompt


def test_a_formal_tone_switches_russian_to_vy():
    formal = Speaker(user_id="u_alex", display_name="A", lang="ru", gender="m", tone="formal")
    prompt = build_system_instruction(
        src_lang="he", dst_lang="ru", speaker=NOA, listener=formal, glossary={}
    )
    assert 'Address the listener with "вы".' in prompt
    assert "Register: formal." in prompt


def test_english_code_switching_is_addressed():
    """An Israeli saying "אני אשלח לך את ה-link" must not have "link" translated."""
    prompt = build_system_instruction(
        src_lang="he", dst_lang="ru", speaker=NOA, listener=ALEX, glossary={}
    )
    assert "Keep English words the speaker used as English words" in prompt


def test_is_continuation_reaches_the_prompt():
    mid = build_system_instruction(
        src_lang="ru", dst_lang="he", speaker=ALEX, listener=NOA, glossary={}, is_continuation=True
    )
    start = build_system_instruction(
        src_lang="ru", dst_lang="he", speaker=ALEX, listener=NOA, glossary={}, is_continuation=False
    )
    assert "do not capitalise" in mid
    assert "do not capitalise" not in start


def test_unknown_gender_falls_back_to_masculine_and_says_so(caplog):
    import speakeasy_agent.providers.mt_gemini as mt

    mt._warned_unknown_gender.clear()
    with caplog.at_level("WARNING"):
        prompt = build_system_instruction(
            src_lang="ru", dst_lang="he", speaker=UNKNOWN, listener=NOA, glossary={}
        )
    assert "Speaker is male" in prompt
    assert any("unknown gender" in r.getMessage() for r in caplog.records), (
        "the masculine fallback must be logged - an unexplained masculine form is "
        "exactly what a bilingual judge will flag"
    )


def test_the_glossary_reaches_the_prompt():
    prompt = build_system_instruction(
        src_lang="ru", dst_lang="he", speaker=ALEX, listener=NOA, glossary={"Noa": "נועה"}
    )
    assert "Noa=נועה" in prompt


# -------------------------------------------------- Gemini: never silent failures


def ok_response(text: str) -> dict:
    return {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": text}]}}]}


def test_a_normal_response_is_extracted():
    assert _extract_text(ok_response(" שלום ")) == "שלום"


def test_a_blocked_prompt_raises_instead_of_returning_nothing():
    with pytest.raises(ProviderError, match="blocked"):
        _extract_text({"promptFeedback": {"blockReason": "SAFETY"}})


def test_no_candidates_raises():
    with pytest.raises(ProviderError, match="no candidates"):
        _extract_text({"candidates": []})


def test_a_safety_blocked_candidate_raises():
    with pytest.raises(ProviderError, match="no content"):
        _extract_text({"candidates": [{"finishReason": "SAFETY"}]})


def test_max_tokens_raises_rather_than_speaking_a_truncated_sentence():
    """Thinking tokens count as output tokens on Gemini 3.x, so a hard fragment
    can burn the whole budget and return nothing. That used to be silence."""
    with pytest.raises(ProviderError, match="MAX_TOKENS"):
        _extract_text({"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": []}}]})


def test_thought_parts_are_never_spoken():
    data = {
        "candidates": [
            {
                "finishReason": "STOP",
                "content": {
                    "parts": [
                        {"text": "the user wants Hebrew...", "thought": True},
                        {"text": "שלום"},
                    ]
                },
            }
        ]
    }
    assert _extract_text(data) == "שלום"


def test_the_output_budget_is_large_enough_for_thinking_plus_an_answer():
    cfg = Config(gemini_api_key="k")
    provider = GeminiMtProvider(cfg)
    payload = provider.build_payload(_request(), "привет")
    assert payload["generationConfig"]["maxOutputTokens"] >= 256
    # Уровень берётся из конфига, а не зашит: допустимые значения различаются
    # по моделям, и неверное — жёсткий HTTP 400 (flash-lite принимает "minimal",
    # 3.7-flash не принимает).
    assert payload["generationConfig"]["thinkingConfig"] == {"thinkingLevel": cfg.gemini_thinking_level}
    # И самый низкий уровень, который принимает модель по умолчанию: думающие
    # токены тарифицируются как выход и тратятся ДО первого произносимого слова.
    assert cfg.gemini_thinking_level == "minimal"
    assert "Hebrew marks gender grammatically" in payload["systemInstruction"]["parts"][0]["text"]


def _request(**overrides) -> MtRequest:
    base = dict(
        text="привет",
        src_lang="ru",
        dst_lang="he",
        speaker=ALEX,
        listener=NOA,
        is_continuation=False,
    )
    base.update(overrides)
    return MtRequest(**base)  # type: ignore[arg-type]


# ------------------------------------------------------------- Gemini: transport


class FakeResponse:
    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self._body = body

    async def text(self) -> str:
        return self._body


class _FakeSession:
    """Records every POST and replays a scripted list of responses."""

    def __init__(self, responses: list[tuple[int, str]]) -> None:
        self._responses = list(responses)
        self.calls: list[dict] = []
        self.closed = False

    @asynccontextmanager
    async def _ctx(self, status: int, body: str):
        yield FakeResponse(status, body)

    def post(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        status, body = self._responses.pop(0)
        return self._ctx(status, body)

    async def close(self) -> None:
        self.closed = True


def provider_with(responses: list[tuple[int, str]]) -> tuple[GeminiMtProvider, _FakeSession]:
    provider = GeminiMtProvider(Config(gemini_api_key="test-key"))
    session = _FakeSession(responses)

    async def _ensure():
        return session

    provider._ensure_session = _ensure  # type: ignore[assignment]
    return provider, session


async def test_the_api_key_travels_in_a_header_never_in_the_url():
    provider, session = provider_with([(200, json.dumps(ok_response("שלום")))])
    await provider.translate(_request())
    assert session.calls[0]["headers"]["x-goog-api-key"] == "test-key"
    assert "test-key" not in session.calls[0]["url"]


async def test_a_503_is_retried_once_and_then_succeeds():
    """Gemini returns "model overloaded" routinely. Without a retry, each one
    permanently loses a sentence in the middle of a live conversation."""
    provider, session = provider_with(
        [(503, "overloaded"), (200, json.dumps(ok_response("שלום")))]
    )
    result = await provider.translate(_request())
    assert result.text == "שלום"
    assert len(session.calls) == 2


async def test_a_429_is_retried_once():
    provider, session = provider_with([(429, "rate limited"), (200, json.dumps(ok_response("כן")))])
    assert (await provider.translate(_request())).text == "כן"
    assert len(session.calls) == 2


async def test_a_400_is_not_retried_because_retrying_a_config_error_only_costs_latency():
    provider, session = provider_with([(400, "bad request")])
    with pytest.raises(ProviderError, match="HTTP 400"):
        await provider.translate(_request())
    assert len(session.calls) == 1


async def test_a_persistent_503_gives_up_after_one_retry():
    provider, session = provider_with([(503, "down"), (503, "still down")])
    with pytest.raises(ProviderError, match="HTTP 503"):
        await provider.translate(_request())
    assert len(session.calls) == 2


async def test_empty_input_never_reaches_the_network():
    provider, session = provider_with([])
    result = await provider.translate(_request(text="   "))
    assert result.text == ""
    assert session.calls == []


# --------------------------------------------------------------------- OpenAI
#
# Same contract as Gemini above, and for the same reason: a translation that
# cannot be produced must RAISE, never come back as "". Every assertion here is
# one of the ways the Responses API can answer HTTP 200 with no usable text.


def openai_ok(text: str) -> dict:
    """A minimal successful Responses-API envelope, including a reasoning item
    to prove reasoning output is never mistaken for the translation."""
    return {
        "status": "completed",
        "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "content": [{"type": "output_text", "text": text}]},
        ],
    }


def openai_provider_with(
    responses: list[tuple[int, str]],
) -> tuple[OpenAiMtProvider, _FakeSession]:
    provider = OpenAiMtProvider(Config(openai_api_key="test-key"))
    session = _FakeSession(responses)

    async def _ensure():
        return session

    provider._ensure_session = _ensure  # type: ignore[assignment]
    return provider, session


def test_openai_requires_a_key():
    with pytest.raises(ProviderError):
        OpenAiMtProvider(Config(openai_api_key=""))


def test_openai_shares_the_gemini_prompt_so_the_hebrew_gender_contract_cannot_drift():
    """The prompt is imported, not copied. If someone forks it, two vendors
    start producing differently-gendered Hebrew from the same call."""
    from speakeasy_agent.providers import mt_openai

    assert mt_openai.build_system_instruction is build_system_instruction


async def test_openai_reasoning_is_pinned_off_because_thinking_is_dead_air():
    provider, session = openai_provider_with([(200, json.dumps(openai_ok("שלום")))])
    await provider.translate(_request())
    assert session.calls[0]["json"]["reasoning"] == {"effort": "none"}


async def test_the_openai_key_travels_in_a_header_never_in_the_url():
    provider, session = openai_provider_with([(200, json.dumps(openai_ok("שלום")))])
    await provider.translate(_request())
    assert session.calls[0]["headers"]["authorization"] == "Bearer test-key"
    assert "test-key" not in session.calls[0]["url"]


async def test_openai_reasoning_items_are_never_spoken():
    provider, _ = openai_provider_with([(200, json.dumps(openai_ok("שלום")))])
    result = await provider.translate(_request())
    assert result.text == "שלום"


def test_openai_incomplete_raises_rather_than_speaking_half_a_sentence():
    with pytest.raises(ProviderError):
        openai_extract(
            {
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "output": [
                    {"type": "message", "content": [{"type": "output_text", "text": "שלו"}]}
                ],
            }
        )


def test_openai_refusal_raises_instead_of_returning_nothing():
    with pytest.raises(ProviderError):
        openai_extract(
            {
                "status": "completed",
                "output": [
                    {"type": "message", "content": [{"type": "refusal", "refusal": "no"}]}
                ],
            }
        )


def test_openai_reasoning_only_output_raises():
    """The budget went entirely on thinking. Used to be silence on the call."""
    with pytest.raises(ProviderError):
        openai_extract({"status": "completed", "output": [{"type": "reasoning", "summary": []}]})


def test_openai_error_inside_a_200_envelope_raises():
    with pytest.raises(ProviderError):
        openai_extract({"status": "completed", "output": [], "error": {"message": "boom"}})


async def test_openai_a_429_is_retried_once():
    provider, session = openai_provider_with(
        [(429, "rate limited"), (200, json.dumps(openai_ok("שלום")))]
    )
    result = await provider.translate(_request())
    assert result.text == "שלום"
    assert len(session.calls) == 2


async def test_openai_a_400_is_not_retried_because_retrying_a_config_error_costs_latency():
    provider, session = openai_provider_with([(400, "bad request")])
    with pytest.raises(ProviderError):
        await provider.translate(_request())
    assert len(session.calls) == 1


async def test_openai_empty_input_never_reaches_the_network():
    provider, session = openai_provider_with([])
    result = await provider.translate(_request(text="  "))
    assert result.text == ""
    assert session.calls == []


# ------------------------------------------------------------------- Deepgram


class _FakeDeepgramModule:
    def __init__(self) -> None:
        self.kwargs: dict = {}

    def STT(self, **kwargs):  # noqa: N802 - mirrors the plugin's class name
        self.kwargs = kwargs
        return _FakeStt()


class _FakeStt:
    def stream(self, **kwargs):
        return _FakeStream()

    async def aclose(self) -> None:
        return None


class _FakeStream:
    def push_frame(self, frame) -> None:  # noqa: ANN001
        return None

    def flush(self) -> None:
        return None

    async def aclose(self) -> None:
        return None

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


def deepgram_provider(cfg: Config):
    from speakeasy_agent.providers.stt_deepgram import DeepgramSttProvider

    _require_plugin("deepgram")
    provider = DeepgramSttProvider(cfg)
    fake = _FakeDeepgramModule()
    provider._deepgram = fake  # type: ignore[assignment]
    return provider, fake


def test_deepgram_requires_a_key():
    from speakeasy_agent.providers.stt_deepgram import DeepgramSttProvider

    with pytest.raises(ProviderError, match="DEEPGRAM_API_KEY"):
        DeepgramSttProvider(Config())


def test_endpointing_is_explicit_and_only_zero_follows_the_chunker():
    # По умолчанию значение своё, а не унаследованное от чанкера: замер
    # 27.08.2026 показал, что endpointing управляет и временем ПЕРВОЙ гипотезы
    # (300 -> 980 мс, 100 -> 678 мс), поэтому подчинять его порогу тишины нельзя.
    provider, _ = deepgram_provider(Config(deepgram_api_key="k", chunk_max_silence_ms=550))
    assert provider.endpointing_ms == 100

    # Явный ноль по-прежнему означает «следуй за чанкером».
    provider, _ = deepgram_provider(
        Config(deepgram_api_key="k", chunk_max_silence_ms=550, deepgram_endpointing_ms=0)
    )
    assert provider.endpointing_ms == 550

    provider, _ = deepgram_provider(
        Config(deepgram_api_key="k", chunk_max_silence_ms=550, deepgram_endpointing_ms=80)
    )
    assert provider.endpointing_ms == 80


async def test_deepgram_is_constructed_with_the_corrected_options():
    provider, fake = deepgram_provider(Config(deepgram_api_key="k", chunk_max_silence_ms=300))
    await provider.start(lang="he")
    kwargs = fake.kwargs
    assert kwargs["model"] == "nova-3"
    assert kwargs["language"] == "he"
    # Filler words on means "эээ" / "אמ" gets transcribed, translated, billed
    # and SPOKEN at the other person.
    assert kwargs["filler_words"] is False
    # Two real people having a real private conversation.
    assert kwargs["mip_opt_out"] is True
    # chunker.py's clause boundary policy depends on punctuation existing.
    assert kwargs["punctuate"] is True
    assert kwargs["endpointing_ms"] == 100
    assert kwargs["sample_rate"] == 16000
    # Without an explicit session the plugin raises "outside of a job context".
    assert kwargs["http_session"] is not None


# ------------------------------------------------------------------- Cartesia


def test_cartesia_refuses_to_start_with_blank_voices():
    """A blank voice is NOT "the default voice for that language" - it is an
    en-US female voice speaking both Hebrew and Russian for both people."""
    from speakeasy_agent.providers.tts_cartesia import CartesiaTtsProvider

    with pytest.raises(ProviderError) as exc:
        CartesiaTtsProvider(Config(cartesia_api_key="k"))
    assert "CARTESIA_VOICE_RU" in str(exc.value)
    assert "CARTESIA_VOICE_HE" in str(exc.value)

    with pytest.raises(ProviderError, match="CARTESIA_VOICE_HE"):
        CartesiaTtsProvider(Config(cartesia_api_key="k", cartesia_voice_ru="voice-ru"))


def test_cartesia_requires_a_key():
    from speakeasy_agent.providers.tts_cartesia import CartesiaTtsProvider

    with pytest.raises(ProviderError, match="CARTESIA_API_KEY"):
        CartesiaTtsProvider(Config())


class _FakeCartesiaModule:
    def __init__(self) -> None:
        self.kwargs: dict = {}
        self.prewarmed = False

    def TTS(self, **kwargs):  # noqa: N802 - mirrors the plugin's class name
        self.kwargs = kwargs
        return _FakeCartesiaTts(self)


class _FakeCartesiaTts:
    def __init__(self, module: _FakeCartesiaModule) -> None:
        self._module = module
        self.streams = 0

    def prewarm(self) -> None:
        self._module.prewarmed = True

    def synthesize(self, text):  # noqa: ANN001
        raise AssertionError(
            "synthesize() is the one-shot POST to /tts/bytes; the relay must use stream()"
        )

    def stream(self):
        self.streams += 1
        self.last_stream = _FakeSynthesizeStream()
        return self.last_stream

    async def aclose(self) -> None:
        return None


class _FakeSynthesizeStream:
    def __init__(self) -> None:
        self.pushed: list[str] = []
        self.ended = False
        self.closed = False
        self._frames = iter([_FakeFrame(), _FakeFrame()])

    def push_text(self, text: str) -> None:
        self.pushed.append(text)

    def end_input(self) -> None:
        self.ended = True

    async def aclose(self) -> None:
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self._frames)
        except StopIteration:
            raise StopAsyncIteration from None


class _FakeFrame:
    class _F:
        data = b"\x00\x01" * 240
        sample_rate = 24000
        num_channels = 1
        samples_per_channel = 240

    frame = _F()


def cartesia_provider():
    from speakeasy_agent.providers.tts_cartesia import CartesiaTtsProvider

    _require_plugin("cartesia")
    cfg = Config(
        cartesia_api_key="k",
        cartesia_voice_ru="voice-ru-female",
        cartesia_voice_he="voice-he-male",
    )
    provider = CartesiaTtsProvider(cfg)
    fake = _FakeCartesiaModule()
    provider._cartesia = fake  # type: ignore[assignment]
    return provider, fake


async def test_cartesia_uses_the_streaming_websocket_not_the_batch_endpoint():
    """`synthesize()` and `stream()` read identically and are entirely different
    transports. The fake raises if the batch one is ever called again."""
    provider, fake = cartesia_provider()
    chunks = [chunk async for chunk in provider.synthesize("שלום", lang="he")]
    assert len(chunks) == 2
    assert chunks[0].sample_rate == 24000
    assert fake.prewarmed, "the WS pool should be warmed so the first unit does not pay setup"


async def test_cartesia_options_match_the_review():
    provider, fake = cartesia_provider()
    _ = [c async for c in provider.synthesize("שלום", lang="he")]
    kwargs = fake.kwargs
    assert kwargs["voice"] == "voice-he-male", "the Hebrew voice must be the configured one"
    assert kwargs["language"] == "he"
    assert kwargs["model"] == "sonic-3.5-2026-05-04"
    # add_timestamps only reaches the wire on the streaming path, and Hebrew
    # does not support it.
    assert kwargs["word_timestamps"] is False
    assert kwargs["http_session"] is not None
    # Left at the plugin default unless CARTESIA_API_VERSION is set: the current
    # value could not be confirmed from primary docs.
    assert "api_version" not in kwargs


async def test_cartesia_api_version_is_overridable_without_a_code_change():
    from speakeasy_agent.providers.tts_cartesia import CartesiaTtsProvider

    _require_plugin("cartesia")
    cfg = Config(
        cartesia_api_key="k",
        cartesia_voice_ru="v-ru",
        cartesia_voice_he="v-he",
        cartesia_api_version="2026-08-14",
    )
    provider = CartesiaTtsProvider(cfg)
    fake = _FakeCartesiaModule()
    provider._cartesia = fake  # type: ignore[assignment]
    _ = [c async for c in provider.synthesize("привет", lang="ru")]
    assert fake.kwargs["api_version"] == "2026-08-14"
    assert fake.kwargs["voice"] == "v-ru"


async def test_each_language_gets_its_own_voice():
    provider, fake = cartesia_provider()
    _ = [c async for c in provider.synthesize("שלום", lang="he")]
    assert fake.kwargs["voice"] == "voice-he-male"
    _ = [c async for c in provider.synthesize("привет", lang="ru")]
    assert fake.kwargs["voice"] == "voice-ru-female"


async def test_empty_text_never_opens_a_stream():
    provider, fake = cartesia_provider()
    assert [c async for c in provider.synthesize("   ", lang="he")] == []
    assert fake.kwargs == {}


async def test_the_unit_text_is_pushed_and_the_input_closed_immediately():
    provider, fake = cartesia_provider()
    _ = [c async for c in provider.synthesize("שלום, מה שלומך", lang="he")]
    assert fake.kwargs["language"] == "he"
    impl = provider._impls["he:voice-he-male"]
    assert impl.last_stream.pushed == ["שלום, מה שלומך"]  # type: ignore[attr-defined]
    assert impl.last_stream.ended is True  # type: ignore[attr-defined]
    assert impl.last_stream.closed is True  # type: ignore[attr-defined]


async def test_barge_in_closes_the_cartesia_stream():
    """Cancelling mid-iteration must close the WS segment, or Cartesia keeps
    billing for audio nobody will hear."""
    provider, _ = cartesia_provider()
    gen = provider.synthesize("שלום", lang="he")
    await gen.__anext__()
    await gen.aclose()
    await asyncio.sleep(0)
    impl = provider._impls["he:voice-he-male"]
    assert impl.last_stream.closed is True  # type: ignore[attr-defined]
