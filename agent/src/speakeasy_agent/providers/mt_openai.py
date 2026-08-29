"""OpenAI GPT-5.6 MT over the Responses API, on raw HTTPS.

Same shape as `mt_gemini.py` and for the same reasons: raw REST on aiohttp
rather than the OpenAI SDK, so there is no unverified dependency surface and a
plain task cancellation is enough to abandon an in-flight translation when the
speaker is interrupted.

The prompt is NOT duplicated here. `build_system_instruction` and
`build_user_content` are imported from `mt_gemini`, because that is where the
Hebrew gender contract lives - speaker gender governs first-person forms,
listener gender governs second-person forms, and both must be stated or a
native speaker hears a broken sentence. Two copies of that text would drift,
and a drifted copy would produce grammatically wrong Hebrew that no test
catches. If the prompt ever needs to differ per vendor, split it into its own
module rather than copying it.

THE ONE RULE THIS FILE OBEYS, inherited from mt_gemini: a failed translation
must never look like an empty one. On a live call a dropped unit is invisible
to the speaker and very visible to the listener waiting for a reply, and in a
judged session it would be recorded against the wrong stage. Every path that
cannot produce text raises ProviderError.

Why the Responses API and not Chat Completions: `reasoning.effort` is only
settable there, and on a reasoning model it is the single most important knob
we have. Reasoning tokens are billed as OUTPUT and, worse, they are spent
before the first visible token appears - on a live call that is dead air. See
`_REASONING_EFFORT`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import TYPE_CHECKING, Any

import aiohttp

from .base import MtRequest, MtResult, ProviderError
from .mt_gemini import build_system_instruction, build_user_content

if TYPE_CHECKING:  # pragma: no cover
    from ..config import Config

logger = logging.getLogger(__name__)

_ENDPOINT = "https://api.openai.com/v1/responses"

# Measured 24.08.2026 from Tel Aviv against gpt-5.6-luna on real call fragments:
# median ~1.3 s, worst ~1.9 s, and NO usable difference between "none" and
# "low". Gemini 3.5 Flash-Lite on the same job measured 680-770 ms in
# production. So this provider costs roughly twice the MT latency budget, and
# "none" is the only defensible default - anything higher spends the whole
# perceived-latency corridor thinking about a five-word fragment.
_REASONING_EFFORT = "none"

# Same budget and reasoning as mt_gemini: the whole corridor is 1.5-2.5 s, and
# ten seconds of dead air mid-sentence is worse than dropping the unit loudly.
_TIMEOUT_TOTAL_S = 4.0
_TIMEOUT_CONNECT_S = 2.0

# Only the genuinely transient ones. 400/401/403 are configuration errors and
# retrying them only burns latency. 429 here is usually a spend cap rather than
# a per-minute quota, but one retry is cheap and sometimes wins.
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_RETRY_BACKOFF_S = 0.25

# Reasoning tokens share this budget on GPT-5.x. A translated fragment is 10-25
# tokens; the headroom exists so that a hard fragment cannot come back as
# status=incomplete with no text at all.
_MAX_OUTPUT_TOKENS = 256


class OpenAiMtProvider:
    name = "openai"

    @property
    def variant(self) -> str:
        return self._model

    def __init__(self, cfg: "Config") -> None:
        if not cfg.openai_api_key:
            raise ProviderError("MT_PROVIDER=openai requires OPENAI_API_KEY to be set in .env")
        self._api_key = cfg.openai_api_key
        self._model = cfg.openai_model
        self._session: aiohttp.ClientSession | None = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(
                    total=_TIMEOUT_TOTAL_S, sock_connect=_TIMEOUT_CONNECT_S
                )
            )
        return self._session

    def build_payload(self, req: MtRequest, text: str) -> dict[str, Any]:
        return {
            "model": self._model,
            "instructions": build_system_instruction(
                src_lang=req.src_lang,
                dst_lang=req.dst_lang,
                speaker=req.speaker,
                listener=req.listener,
                glossary=req.glossary,
                is_continuation=req.is_continuation,
            ),
            "input": build_user_content(
                src_lang=req.src_lang,
                dst_lang=req.dst_lang,
                text=text,
                history=req.history,
            ),
            "reasoning": {"effort": _REASONING_EFFORT},
            "max_output_tokens": _MAX_OUTPUT_TOKENS,
            # Deterministic: two runs of a judged A/B must differ because of the
            # model, not because of sampling.
            "temperature": 0,
            "top_p": 1,
            "store": False,
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
                    _ENDPOINT,
                    headers={
                        "authorization": f"Bearer {self._api_key}",
                        "content-type": "application/json",
                    },
                    json=payload,
                ) as resp:
                    body = await resp.text()
                    status = resp.status
            except asyncio.CancelledError:
                raise
            except aiohttp.ClientError as exc:
                raise ProviderError(f"openai request failed: {exc}") from exc
            except asyncio.TimeoutError as exc:
                raise ProviderError(f"openai timed out after {_TIMEOUT_TOTAL_S}s") from exc

            if status == 200:
                try:
                    return _loads(body)
                except ValueError as exc:
                    raise ProviderError(f"openai returned non-JSON: {body[:200]}") from exc

            last_error = f"HTTP {status}: {body[:400]}"
            if status not in _RETRY_STATUSES or attempt == 1:
                break
            logger.warning(
                "openai %s, retrying once in %.0f ms", last_error, _RETRY_BACKOFF_S * 1000
            )
            await asyncio.sleep(_RETRY_BACKOFF_S)

        raise ProviderError(f"openai returned {last_error}")

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

    The ways the Responses API can answer 200 without a usable translation:
      1. the whole call errored inside a 200 envelope -> `error` is populated
      2. the model refused                            -> a `refusal` content part
      3. the token budget ran out                     -> status "incomplete"
      4. only reasoning items came back               -> no `output_text` part
    All four used to be an empty string, i.e. silence on the call.
    """
    err = data.get("error")
    if err:
        detail = err.get("message") if isinstance(err, dict) else str(err)
        raise ProviderError(f"openai returned an error envelope: {detail}")

    status = data.get("status")
    output = data.get("output") or []
    if not output:
        raise ProviderError(f"openai returned no output (status={status})")

    chunks: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        # Reasoning items sit alongside the message in `output`. Joining their
        # summaries into spoken audio would be a spectacular failure mode, so
        # only genuine output_text parts are collected.
        for part in item.get("content") or []:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "refusal":
                raise ProviderError(f"openai refused: {str(part.get('refusal'))[:120]}")
            if part.get("type") == "output_text":
                chunks.append(part.get("text", ""))

    text = "".join(chunks).strip()

    if status == "incomplete":
        reason = (data.get("incomplete_details") or {}).get("reason")
        raise ProviderError(
            f"openai stopped early (reason={reason}); partial text was {text[:120]!r}"
        )
    if not text:
        raise ProviderError(f"openai returned no text part (status={status})")
    return text
