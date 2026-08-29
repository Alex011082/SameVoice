"""Subtitle and lifecycle-state emission over LiveKit text streams.

We use our own topics rather than `lk.transcription`: one logical caption
carries original AND translation AND both languages AND finality, and
`sender_identity` would need publish-on-behalf permission we do not grant.
`RoomEvent.TranscriptionReceived` / `publish_transcription()` are deprecated and
are not built on.

Invariant enforced here: nothing is ever sent for a segmentId after that segment
has gone final.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Protocol

from . import STATE_TOPIC, SUBTITLE_TOPIC
from .providers.base import Lang

logger = logging.getLogger(__name__)


class TextTransport(Protocol):
    async def publish(
        self,
        *,
        topic: str,
        payload: str,
        destination_identities: list[str] | None,
        attributes: dict[str, str],
    ) -> None: ...


class LiveKitTextTransport:
    """Publishes over `local_participant.stream_text`."""

    def __init__(self, room: Any) -> None:
        self._room = room

    async def publish(
        self,
        *,
        topic: str,
        payload: str,
        destination_identities: list[str] | None,
        attributes: dict[str, str],
    ) -> None:
        writer = await self._room.local_participant.stream_text(
            topic=topic,
            destination_identities=destination_identities,
            attributes=attributes,
        )
        try:
            await writer.write(payload)
        finally:
            await writer.aclose()


class CollectingTextTransport:
    """Offline transport used by tests and the mock pipeline demo."""

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def publish(
        self,
        *,
        topic: str,
        payload: str,
        destination_identities: list[str] | None,
        attributes: dict[str, str],
    ) -> None:
        self.messages.append(
            {
                "topic": topic,
                "payload": json.loads(payload),
                "destination_identities": destination_identities,
                "attributes": attributes,
            }
        )

    def subtitles(self) -> list[dict[str, Any]]:
        return [m["payload"] for m in self.messages if m["topic"] == SUBTITLE_TOPIC]

    def states(self) -> list[dict[str, Any]]:
        return [m["payload"] for m in self.messages if m["topic"] == STATE_TOPIC]


class SubtitleEmitter:
    def __init__(
        self,
        *,
        transport: TextTransport,
        call_id: str,
        mode: str,
        providers: dict[str, str],
    ) -> None:
        self._transport = transport
        self._call_id = call_id
        self._mode = mode
        self._providers = dict(providers)
        self._counters: dict[str, int] = {}
        self._seq: dict[str, int] = {}
        self._finalized: set[str] = set()

    def new_segment_id(self, speaker_id: str) -> str:
        n = self._counters.get(speaker_id, 0)
        self._counters[speaker_id] = n + 1
        segment_id = f"seg_{speaker_id}_{n:06d}"
        self._seq[segment_id] = 0
        return segment_id

    async def send_subtitle(
        self,
        *,
        segment_id: str,
        speaker_id: str,
        listener_id: str,
        src_lang: Lang,
        dst_lang: Lang,
        src_text: str,
        dst_text: str,
        is_final: bool,
        t_start: float,
        t_end: float,
        utterance_id: str = "",
    ) -> bool:
        if segment_id in self._finalized:
            logger.debug("dropping message for finalized segment %s", segment_id)
            return False

        seq = self._seq.get(segment_id, 0)
        self._seq[segment_id] = seq + 1
        if is_final:
            self._finalized.add(segment_id)

        payload = {
            "v": 1,
            "callId": self._call_id,
            "segmentId": segment_id,
            # The handle the judge flag travels on. Empty on partials: there is
            # nothing to judge until a translation exists. The SAME id is what
            # the agent writes to logs/calls/<callId>.jsonl, so a click in the
            # browser lands on the right line with no correlation guesswork.
            "utteranceId": utterance_id,
            "seq": seq,
            "speakerId": speaker_id,
            "listenerId": listener_id,
            "srcLang": src_lang,
            "dstLang": dst_lang,
            "srcText": src_text,
            "dstText": dst_text if is_final else "",
            "isFinal": is_final,
            "tStart": round(t_start, 3),
            "tEnd": round(t_end, 3),
        }
        # The speaker gets a copy of their OWN line as well. `listenerId` still
        # names the single intended recipient, and the web client drops anything
        # not addressed to it -- so this changes nothing for the product screen.
        # It exists because of the 26.08.2026 call: two people spent the whole
        # session on "слышно? / не слышу" with no way to tell whether the system
        # had heard them at all, and never got to the test script. A speaker who
        # can see their own recognised text knows in one glance whether the
        # problem is their microphone, the recogniser, or the other person.
        destinations = [listener_id] if speaker_id == listener_id else [listener_id, speaker_id]
        await self._safe_publish(
            topic=SUBTITLE_TOPIC,
            payload=payload,
            destination_identities=destinations,
            attributes={
                "v": "1",
                "seg": segment_id,
                "utt": utterance_id,
                "final": "true" if is_final else "false",
            },
        )
        return True

    async def send_state(
        self, *, event: str, detail: str = "", destination_identities: list[str] | None = None
    ) -> None:
        payload = {
            "v": 1,
            "callId": self._call_id,
            "event": event,
            "mode": self._mode,
            "detail": detail,
            "providers": self._providers,
        }
        await self._safe_publish(
            topic=STATE_TOPIC,
            payload=payload,
            destination_identities=destination_identities,
            attributes={"v": "1", "event": event},
        )

    async def _safe_publish(
        self,
        *,
        topic: str,
        payload: dict[str, Any],
        destination_identities: list[str] | None,
        attributes: dict[str, str],
    ) -> None:
        try:
            await self._transport.publish(
                topic=topic,
                payload=json.dumps(payload, ensure_ascii=False),
                destination_identities=destination_identities,
                attributes=attributes,
            )
        except Exception as exc:  # a dead text stream must never kill the audio path
            logger.warning("failed to publish on %s: %s", topic, exc)
