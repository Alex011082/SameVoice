"""Gemini Flash-Lite MT over raw HTTPS.

Raw REST on aiohttp (already a livekit-agents dependency) rather than a Python
SDK: it adds no unverified dependency surface and is cancelled by plain task
cancellation, which is what barge-in needs.

Non-streaming is deliberate: our units are 25-40 output tokens and we buffer to
a whole unit before TTS anyway, so SSE would only add parsing.

THE ONE RULE THIS FILE OBEYS: a failed translation must never look like an empty
one. On a live call a dropped unit is invisible to the person who spoke and very
visible to the person waiting to hear a reply, and during a judged test session
it would be recorded against the wrong stage - the bilingual judge would mark
"bad translation" on what was actually an HTTP 503. Every path that cannot
produce text raises ProviderError, which direction.py counts, logs, and writes
into the eval log as `error`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import TYPE_CHECKING, Any, Mapping, Sequence

import aiohttp

from .base import Gender, Lang, MtRequest, MtResult, ProviderError, Speaker

if TYPE_CHECKING:  # pragma: no cover
    from ..config import Config

logger = logging.getLogger(__name__)

_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

_LANG_NAME: dict[str, str] = {"ru": "Russian", "he": "Hebrew"}

# Hebrew has no unmarked gender: "u" must resolve to something, and masculine is
# the least-bad default. It IS logged (see `_gender_word`) so that an
# unexplained masculine form in a judged session can be traced to a missing
# contact-card gender rather than to the model.
_GENDER_WORD: dict[str, str] = {"m": "male", "f": "female", "u": "male"}

_REGISTER_TEXT: dict[str, str] = {
    "neutral": "neutral spoken",
    "friendly": "friendly colloquial",
    "formal": "formal",
}

# Total wall-clock budget for one unit. The whole perceived-latency corridor is
# 1.5-2.5 s; ten seconds of dead air mid-sentence is a worse product outcome
# than dropping the unit and saying so.
_TIMEOUT_TOTAL_S = 4.0
_TIMEOUT_CONNECT_S = 2.0

# Retried once, and only for the two statuses that are genuinely transient.
# 400/403 are configuration errors: retrying them only burns latency.
_RETRY_STATUSES = frozenset({429, 503})
_RETRY_BACKOFF_S = 0.25

# Thinking tokens count as OUTPUT tokens on Gemini 3.x, and they share this
# budget. At 96 a hard fragment (idiom, code-switch, ambiguous gender) can spend
# the whole allowance thinking and come back with finishReason MAX_TOKENS and no
# text at all - which used to surface as silence with no error anywhere.
_MAX_OUTPUT_TOKENS = 256


#: One warning per participant, not one per utterance: at ~13 MT calls a minute
#: an unconditional warning would bury every other line in the log.
_warned_unknown_gender: set[str] = set()


def _gender_word(gender: Gender, *, who: str = "participant", user_id: str = "") -> str:
    if gender == "u":
        key = f"{who}:{user_id}"
        if key not in _warned_unknown_gender:
            _warned_unknown_gender.add(key)
            logger.warning(
                "MT: %s %s has an unknown gender; Hebrew has no unmarked gender so "
                "MASCULINE forms are being requested for the whole call. "
                "Set the gender on the contact card.",
                who,
                user_id or "?",
            )
    return _GENDER_WORD.get(gender, "male")


def _ru_address(tone: str) -> str:
    return "вы" if tone == "formal" else "ты"


def build_system_instruction(
    *,
    src_lang: Lang,
    dst_lang: Lang,
    speaker: Speaker,
    listener: Speaker,
    glossary: Mapping[str, str],
    is_continuation: bool = False,
) -> str:
    """The whole Hebrew gender contract lives here.

    Hebrew inflects on BOTH axes at once: the speaker's gender governs
    first-person verbs and adjectives (אני הולך / אני הולכת) and the addressee's
    gender governs second-person forms (אתה יודע / את יודעת). Getting one right
    and the other wrong still produces a sentence that a native speaker hears as
    broken, so both are stated explicitly and separately, and for a Hebrew target
    the requirement is spelled out rather than implied.

    Register is keyed off the LISTENER's tone, not the speaker's: the address
    form belongs to the person being addressed. That means the two directions of
    one call can legitimately run at different registers if the two contact
    cards disagree. This is deliberate, and the eval log records the tone that
    was actually in force for every utterance.
    """
    src = _LANG_NAME.get(src_lang, src_lang)
    dst = _LANG_NAME.get(dst_lang, dst_lang)
    speaker_g = _gender_word(speaker.gender, who="speaker", user_id=speaker.user_id)
    listener_g = _gender_word(listener.gender, who="listener", user_id=listener.user_id)
    lines = [
        f"You are a simultaneous interpreter on a live phone call. Translate ONLY the new {src} "
        f"fragment",
        f"into {dst}. Output the translation and nothing else - no quotes, no source text, no",
        "transliteration, no explanation.",
        f"Speaker is {speaker_g}; inflect first-person verbs and adjectives "
        f"for a {speaker_g} speaker.",
        f"Listener is {listener_g}, singular; address them using "
        f"{'masculine' if listener_g == 'male' else 'feminine'} singular forms.",
    ]
    if dst_lang == "he":
        lines.append(
            "Hebrew marks gender grammatically on verbs, adjectives and pronouns: use "
            f"{'masculine' if speaker_g == 'male' else 'feminine'} first-person forms and "
            f"{'masculine' if listener_g == 'male' else 'feminine'} second-person singular forms. "
            "Never use plural or mixed forms to avoid choosing."
        )
        # The rule above is stated twice already and STILL gets broken: measured
        # 27.08.2026, gemini-3.5-flash-lite turned "Ты меня слышишь?" into
        # `את שומעות אותי?` - feminine PLURAL at a feminine singular listener.
        # A concrete contrast pair fixes what another sentence of rules does not;
        # small models copy examples far more reliably than they follow prose.
        lines.append(
            "Example of the second-person form required here - "
            + ("correct: אתה שומע אותי? / wrong: אתם שומעים אותי?"
               if listener_g == "male"
               else "correct: את שומעת אותי? / wrong: את שומעות אותי?")
        )
    if dst_lang == "ru":
        lines.append(f'Address the listener with "{_ru_address(listener.tone)}".')
        lines.append(
            "Russian marks the speaker's gender in the past tense: use "
            f"{'masculine' if speaker_g == 'male' else 'feminine'} past-tense forms "
            "for the speaker."
        )
    lines.append(f"Register: {_REGISTER_TEXT.get(listener.tone, 'neutral spoken')}.")
    lines.append(
        "The fragment may be an incomplete sentence - translate it as a fragment, do not invent "
        "an ending,"
    )
    lines.append("do not repeat anything already translated.")
    if is_continuation:
        # Without this the model capitalises and full-stops every fragment, and
        # the TTS then reads a mid-sentence chunk with a falling final intonation.
        lines.append(
            "This fragment continues the sentence already in progress: do not capitalise the "
            "first word and do not add a final period."
        )
    # Israelis code-switch English words into Hebrew constantly ("אני אשלח לך את
    # ה-link"). Translating them produces something nobody says out loud.
    lines.append(
        "Keep English words the speaker used as English words; do not translate or transliterate "
        "them."
    )
    if glossary:
        terms = ", ".join(f"{k}={v}" for k, v in glossary.items())
    else:
        terms = "-"
    lines.append(f"Keep these names and terms consistent: {terms}.")
    return "\n".join(lines)


def build_user_content(
    *, src_lang: Lang, dst_lang: Lang, text: str, history: Sequence[tuple[str, str]]
) -> str:
    src_tag = src_lang.upper()
    dst_tag = dst_lang.upper()
    lines: list[str] = []
    for src_text, dst_text in history:
        lines.append(f"{src_tag}: {src_text}")
        lines.append(f"{dst_tag}: {dst_text}")
    lines.append(f"NEW {src_tag}: {text}")
    return "\n".join(lines)


class GeminiMtProvider:
    name = "gemini"

    @property
    def variant(self) -> str:
        return self._model

    def __init__(self, cfg: "Config") -> None:
        if not cfg.gemini_api_key:
            raise ProviderError("MT_PROVIDER=gemini requires GEMINI_API_KEY to be set in .env")
        self._api_key = cfg.gemini_api_key
        self._model = cfg.gemini_model
        self._thinking = cfg.gemini_thinking_level
        self._url = _ENDPOINT.format(model=self._model)
        self._session: aiohttp.ClientSession | None = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        # Deliberately its own session rather than the process-shared one: this
        # provider wants a short total deadline on every request, and it owns
        # the lifecycle cleanly in `aclose()`.
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(
                    total=_TIMEOUT_TOTAL_S, sock_connect=_TIMEOUT_CONNECT_S
                )
            )
        return self._session

    def build_payload(self, req: MtRequest, text: str) -> dict[str, Any]:
        return {
            "systemInstruction": {
                "parts": [
                    {
                        "text": build_system_instruction(
                            src_lang=req.src_lang,
                            dst_lang=req.dst_lang,
                            speaker=req.speaker,
                            listener=req.listener,
                            glossary=req.glossary,
                            is_continuation=req.is_continuation,
                        )
                    }
                ]
            },
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "text": build_user_content(
                                src_lang=req.src_lang,
                                dst_lang=req.dst_lang,
                                text=text,
                                history=req.history,
                            )
                        }
                    ],
                }
            ],
            "generationConfig": {
                "temperature": 0,
                "topP": 1,
                "candidateCount": 1,
                "maxOutputTokens": _MAX_OUTPUT_TOKENS,
                "stopSequences": ["\n"],
                # The valid set differs per model and a wrong value is a hard
                # 400, so this is configuration rather than a constant:
                #   gemini-3.5-flash-lite -> minimal | low | medium | high
                #   gemini-3.7-flash      -> low | medium | high   (NO minimal)
                # Always pick the lowest the model accepts: thinking tokens are
                # billed as output AND spent before the first word is audible,
                # which on a live call is silence.
                "thinkingConfig": {"thinkingLevel": self._thinking},
            },
        }

    async def translate(self, req: MtRequest) -> MtResult:
        text = req.text.strip()
        if not text:
            return MtResult(text="", provider=self.name, latency_ms=0.0)

        payload = self.build_payload(req, text)
        session = await self._ensure_session()
        started = time.perf_counter()
        data = await self._post_with_retry(session, payload)
        latency_ms = (time.perf_counter() - started) * 1000.0
        return MtResult(text=_extract_text(data), provider=self.name, latency_ms=latency_ms)

    async def _post_with_retry(
        self, session: aiohttp.ClientSession, payload: dict[str, Any]
    ) -> dict[str, Any]:
        last_error: str = ""
        for attempt in range(2):
            try:
                async with session.post(
                    self._url,
                    headers={
                        # Header rather than ?key=, so the secret never lands in
                        # a URL, a log line or a proxy access record.
                        "x-goog-api-key": self._api_key,
                        "content-type": "application/json",
                    },
                    json=payload,
                ) as resp:
                    body = await resp.text()
                    status = resp.status
            except asyncio.CancelledError:
                raise
            except aiohttp.ClientError as exc:
                raise ProviderError(f"gemini request failed: {exc}") from exc
            except asyncio.TimeoutError as exc:
                raise ProviderError(
                    f"gemini timed out after {_TIMEOUT_TOTAL_S}s"
                ) from exc

            if status == 200:
                try:
                    return _loads(body)
                except ValueError as exc:
                    raise ProviderError(f"gemini returned non-JSON: {body[:200]}") from exc

            last_error = f"HTTP {status}: {body[:400]}"
            if status not in _RETRY_STATUSES or attempt == 1:
                break
            logger.warning("gemini %s, retrying once in %.0f ms", last_error, _RETRY_BACKOFF_S * 1000)
            await asyncio.sleep(_RETRY_BACKOFF_S)

        raise ProviderError(f"gemini returned {last_error}")

    async def aclose(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None


def _loads(body: str) -> dict[str, Any]:
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError("response is not a JSON object")
    return data


def _extract_text(data: dict[str, Any]) -> str:
    """Every "no text" case raises instead of returning "".

    The four ways Gemini can answer without a translation, all of which used to
    come back as an empty string and therefore as silence:
      1. the prompt was blocked        -> no `candidates`, a `promptFeedback.blockReason`
      2. the candidate was blocked     -> a candidate with no `content`
      3. the budget ran out            -> `finishReason: "MAX_TOKENS"`
      4. only thought parts came back  -> parts marked `"thought": true`
    """
    feedback = data.get("promptFeedback") or {}
    block_reason = feedback.get("blockReason")
    if block_reason:
        raise ProviderError(f"gemini blocked the prompt: {block_reason}")

    candidates = data.get("candidates") or []
    if not candidates:
        raise ProviderError("gemini returned no candidates")

    candidate = candidates[0] or {}
    finish_reason = candidate.get("finishReason")
    content = candidate.get("content")
    if content is None:
        raise ProviderError(f"gemini returned a candidate with no content (finish={finish_reason})")

    parts = content.get("parts") or []
    # Thought summaries are not translation. They are only ever present when
    # includeThoughts is on, but joining them into the spoken output would be a
    # spectacular failure mode, so they are filtered unconditionally.
    text = "".join(
        part.get("text", "") for part in parts if isinstance(part, dict) and not part.get("thought")
    ).strip()

    if finish_reason not in (None, "STOP"):
        raise ProviderError(
            f"gemini stopped early (finishReason={finish_reason}); "
            f"partial text was {text[:120]!r}"
        )
    return text
