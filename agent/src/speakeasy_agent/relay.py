"""Per-call relay: one LiveKit room, two published tracks, two directions.

Topology (ONE room, never two): both humans and the agent share
`call-<callId>`. The agent publishes one audio track per listener, named
`tx-<listenerUserId>`, and hardens routing server-side with
`set_track_subscription_permissions`. Two rooms would buy zero latency - the
media hop count is identical - while making DIRECT mode structurally impossible.

Sharp edges encoded here:
  * Both tracks are published with a BARE `rtc.TrackPublishOptions()`; the
    source is deliberately left unset and the tracks are disambiguated purely by
    track name, because two tracks both declaring SOURCE_MICROPHONE from one
    participant is not verified to work.
  * `set_track_subscription_permissions` is called AFTER both publishes. Once
    `allow_all_participants=False`, any track published later is subscribable by
    nobody until it is called again - which produces total silence with no error
    in any log. This relay therefore never republishes mid-call.
  * That method is SYNCHRONOUS in livekit 1.1.14. Awaiting it raises TypeError.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from dataclasses import dataclass
from typing import Any

from livekit import rtc

from . import AGENT_IDENTITY, __version__
from .audio import AUDIO_SOURCE_QUEUE_MS, LiveKitAudioSink, create_audio_source
from .chunker import ChunkerConfig
from .config import Config
from .direction import Direction
from .evallog import CallEvalLog, EvalLogStore, call_header_record
from .providers import build_mt, build_stt, build_tts
from .providers.base import Speaker
from .subtitles import LiveKitTextTransport, SubtitleEmitter

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_S = 15.0

#: How long the relay tolerates a room with no humans in it before giving up.
#:
#: It must comfortably exceed the whole ring window, because the agent is
#: dispatched when the call is CREATED and the room is legitimately empty until
#: somebody answers: RING_TIMEOUT_SECONDS to answer (45 by default) plus the
#: same again for an accepted ring nobody joins, so 90 s is the real worst case.
#:
#: The backend normally stops us long before this — every path that ends a call
#: posts /jobs/<id>/stop. This is the backstop for when it does not: on
#: 25.08.2026 the agent still reported activeCalls: 1 for a call that had been
#: dead for fifteen hours, holding a LiveKit participant and two open STT
#: sessions, and only a manual restart cleared it.
EMPTY_ROOM_TIMEOUT_S = 120.0

#: How often the watchdog looks. Coarse on purpose: it is measuring minutes.
EMPTY_ROOM_POLL_S = 5.0


class EmptyRoomWatch:
    """Decides when a room has been without humans for long enough to give up.

    Pure bookkeeping, no room and no clock of its own, so it can be tested
    without LiveKit. `started_at` seeds the "last seen a human" mark: a room
    that never fills counts from the moment the relay opened it.
    """

    def __init__(self, grace_s: float, started_at: float) -> None:
        self._grace_s = grace_s
        self._last_seen = started_at
        self._ever_occupied = False

    @property
    def ever_occupied(self) -> bool:
        return self._ever_occupied

    def empty_for(self, now: float) -> float:
        return max(0.0, now - self._last_seen)

    def observe(self, humans: int, now: float) -> bool:
        """Record who is in the room. True means "stop this relay"."""
        if humans > 0:
            self._last_seen = now
            self._ever_occupied = True
            return False
        return self.empty_for(now) >= self._grace_s


@dataclass(frozen=True)
class RelayJob:
    call_id: str
    room_name: str
    mode: str
    livekit_url: str
    token: str
    participants: tuple[Speaker, Speaker]

    @staticmethod
    def from_payload(payload: dict[str, Any]) -> RelayJob:
        required = ("callId", "roomName", "mode", "livekitUrl", "token", "participants")
        missing = [k for k in required if not payload.get(k)]
        if missing:
            raise ValueError(f"missing field(s): {', '.join(missing)}")
        raw = payload["participants"]
        if not isinstance(raw, list) or len(raw) != 2:
            raise ValueError("participants must contain exactly 2 entries")
        speakers = tuple(_speaker_from(p) for p in raw)
        if speakers[0].user_id == speakers[1].user_id:
            raise ValueError("participants must have distinct userIds")
        return RelayJob(
            call_id=str(payload["callId"]),
            room_name=str(payload["roomName"]),
            # Normalised so the DIRECT guard in main.create_job and everything
            # downstream (eval-log header, /stats, subtitles) agree on one
            # spelling of the mode.
            mode=str(payload["mode"]).strip().upper(),
            livekit_url=str(payload["livekitUrl"]),
            token=str(payload["token"]),
            participants=speakers,  # type: ignore[arg-type]
        )


def _speaker_from(raw: Any) -> Speaker:
    if not isinstance(raw, dict):
        raise ValueError("each participant must be an object")
    for key in ("userId", "lang", "gender", "tone"):
        if not raw.get(key):
            raise ValueError(f"participant is missing {key}")
    lang = str(raw["lang"])
    gender = str(raw["gender"])
    tone = str(raw["tone"])
    if lang not in ("ru", "he"):
        raise ValueError(f"unsupported lang {lang!r}")
    if gender not in ("m", "f", "u"):
        raise ValueError(f"unsupported gender {gender!r}")
    if tone not in ("neutral", "friendly", "formal"):
        raise ValueError(f"unsupported tone {tone!r}")
    return Speaker(
        user_id=str(raw["userId"]),
        display_name=str(raw.get("displayName") or raw["userId"]),
        lang=lang,  # type: ignore[arg-type]
        gender=gender,  # type: ignore[arg-type]
        tone=tone,  # type: ignore[arg-type]
    )


def _participant_record(speaker: Speaker) -> dict[str, Any]:
    return {
        "userId": speaker.user_id,
        "displayName": speaker.display_name,
        "lang": speaker.lang,
        "gender": speaker.gender,
        "tone": speaker.tone,
    }


class Relay:
    def __init__(
        self, job: RelayJob, cfg: Config, *, eval_store: EvalLogStore | None = None
    ) -> None:
        self.job = job
        self.cfg = cfg
        self.room = rtc.Room()
        self._call_start = time.monotonic()
        self._directions: dict[str, Direction] = {}
        self._sources: dict[str, rtc.AudioSource] = {}
        self._publications: dict[str, rtc.LocalTrackPublication] = {}
        self._reader_tasks: dict[str, asyncio.Task] = {}
        self._stopped = asyncio.Event()
        self._closed = False
        self._empty_room = EmptyRoomWatch(EMPTY_ROOM_TIMEOUT_S, self._call_start)
        self._empty_room_task: asyncio.Task | None = None

        self._stt = build_stt(cfg.stt_provider, cfg)
        self._mt = build_mt(cfg.mt_provider, cfg)
        self._tts = build_tts(cfg.tts_provider, cfg)
        self._emitter = SubtitleEmitter(
            transport=LiveKitTextTransport(self.room),
            call_id=job.call_id,
            mode=job.mode,
            providers=cfg.providers,
        )

        # One JSONL per call, shared by both directions and written from the
        # moment the relay is constructed - so POST /jobs/<id>/verdict can tell a
        # real call from a typo'd id even before anyone has said a word.
        store = eval_store or EvalLogStore(cfg.eval_log_dir, enabled=cfg.eval_log_enabled)
        self._eval_log: CallEvalLog | None = None
        try:
            self._eval_log = store.open_call(
                job.call_id,
                header=call_header_record(
                    call_id=job.call_id,
                    room_name=job.room_name,
                    mode=job.mode,
                    providers=cfg.providers,
                    participants=[_participant_record(p) for p in job.participants],
                    agent_version=__version__,
                ),
            )
        except Exception as exc:  # a broken eval log must never block a call
            logger.warning("eval log unavailable for call %s: %s", job.call_id, exc)

    # ---------------------------------------------------------------- lifecycle

    async def run(self) -> None:
        try:
            await self._connect()
            await self._publish_tracks()
            self._apply_subscription_permissions()
            await self._start_directions()
            self._attach_existing_tracks()
            await self._emitter.send_state(event="agent_ready")
            self._empty_room_task = asyncio.create_task(
                self._watch_empty_room(), name=f"empty-room:{self.job.call_id}"
            )
            logger.info(
                "relay ready call=%s room=%s providers=%s",
                self.job.call_id,
                self.job.room_name,
                json.dumps(self.cfg.providers),
            )
            await self._stopped.wait()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("relay failed call=%s: %s", self.job.call_id, exc)
            with contextlib.suppress(Exception):
                await self._emitter.send_state(event="agent_error", detail=str(exc)[:400])
            raise
        finally:
            await self.aclose()

    def stop(self) -> None:
        self._stopped.set()

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True

        if self._empty_room_task is not None:
            self._empty_room_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._empty_room_task
            self._empty_room_task = None

        for task in self._reader_tasks.values():
            task.cancel()
        for task in self._reader_tasks.values():
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._reader_tasks.clear()

        for direction in self._directions.values():
            with contextlib.suppress(Exception):
                await direction.aclose()
        self._directions.clear()

        with contextlib.suppress(Exception):
            await self._emitter.send_state(event="agent_left")

        for provider in (self._stt, self._mt, self._tts):
            with contextlib.suppress(Exception):
                await provider.aclose()

        with contextlib.suppress(Exception):
            await self.room.disconnect()
        self._sources.clear()
        self._publications.clear()

        # Closed last, after both directions have finished writing their trailing
        # units, so nothing the judge could be asked about is lost on hangup.
        if self._eval_log is not None:
            with contextlib.suppress(Exception):
                await self._eval_log.aclose()

        logger.info("relay closed call=%s", self.job.call_id)

    # ---------------------------------------------------------------- setup

    async def _connect(self) -> None:
        self.room.on("track_subscribed", self._on_track_subscribed)
        self.room.on("participant_disconnected", self._on_participant_disconnected)
        self.room.on("disconnected", self._on_room_disconnected)
        await asyncio.wait_for(
            self.room.connect(
                self.job.livekit_url,
                self.job.token,
                rtc.RoomOptions(auto_subscribe=True),
            ),
            timeout=CONNECT_TIMEOUT_S,
        )
        if self.room.local_participant.identity != AGENT_IDENTITY:
            logger.warning(
                "agent joined as %r, expected %r - the backend minted the wrong token",
                self.room.local_participant.identity,
                AGENT_IDENTITY,
            )

    async def _publish_tracks(self) -> None:
        for listener in self.job.participants:
            source = create_audio_source()
            track = rtc.LocalAudioTrack.create_audio_track(f"tx-{listener.user_id}", source)
            publication = await self.room.local_participant.publish_track(
                track, rtc.TrackPublishOptions()
            )
            self._sources[listener.user_id] = source
            self._publications[listener.user_id] = publication
            logger.info(
                "published %s sid=%s queue_size_ms=%d",
                track.name,
                publication.sid,
                AUDIO_SOURCE_QUEUE_MS,
            )

    def _apply_subscription_permissions(self) -> None:
        permissions = [
            rtc.ParticipantTrackPermission(
                participant_identity=listener.user_id,
                allowed_track_sids=[self._publications[listener.user_id].sid],
            )
            for listener in self.job.participants
        ]
        self.room.local_participant.set_track_subscription_permissions(
            allow_all_participants=False,
            participant_permissions=permissions,
        )
        logger.info(
            "track subscription permissions locked to %s",
            {p.participant_identity: list(p.allowed_track_sids) for p in permissions},
        )

    async def _start_directions(self) -> None:
        a, b = self.job.participants
        chunker_config = ChunkerConfig(
            min_words=self.cfg.chunk_min_words,
            max_silence_ms=self.cfg.chunk_max_silence_ms,
            end_of_turn_ms=self.cfg.chunk_end_of_turn_ms,
            timeout_ms=self.cfg.chunk_timeout_ms,
            weak_boundary_min_words=self.cfg.chunk_weak_boundary_min_words,
        )
        for speaker, listener in ((a, b), (b, a)):
            direction = Direction(
                call_id=self.job.call_id,
                speaker=speaker,
                listener=listener,
                stt=self._stt,
                mt=self._mt,
                tts=self._tts,
                sink=LiveKitAudioSink(self._sources[listener.user_id]),
                emitter=self._emitter,
                chunker_config=chunker_config,
                tts_tempo=self.cfg.tts_tempo,
                history_turns=self.cfg.mt_history_turns,
                glossary=self.cfg.glossary,
                call_start=self._call_start,
                eval_log=self._eval_log,
            )
            self._directions[speaker.user_id] = direction

        # Barge-in: when the listener starts speaking, their own STT session
        # cancels the direction that is speaking TO them.
        self._directions[a.user_id].on_speech_start = self._directions[b.user_id].cancel_output
        self._directions[b.user_id].on_speech_start = self._directions[a.user_id].cancel_output

        for direction in self._directions.values():
            await direction.start()

    def _attach_existing_tracks(self) -> None:
        for participant in self.room.remote_participants.values():
            for publication in participant.track_publications.values():
                track = publication.track
                if track is not None:
                    self._attach(track, participant.identity)

    # ---------------------------------------------------------------- events

    def _on_track_subscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        self._attach(track, participant.identity)

    def _on_participant_disconnected(self, participant: rtc.RemoteParticipant) -> None:
        identity = participant.identity
        logger.info("participant left mid-call: %s", identity)
        task = self._reader_tasks.pop(identity, None)
        if task is not None:
            task.cancel()
        direction = self._directions.get(identity)
        if direction is not None:
            # Whatever they were saying will never be completed; do not speak a
            # half-utterance at the other side.
            direction.cancel_output()
        for other in self._directions.values():
            if other.listener.user_id == identity:
                other.cancel_output()

    async def _watch_empty_room(self) -> None:
        """Give up on a room the humans have left (or never entered).

        LiveKit will not do this for us while the agent itself is a
        participant: the room's `empty_timeout` counts participants, and we are
        one. So a relay whose stop message never arrives would otherwise sit in
        an empty room until the process is restarted.
        """
        try:
            while not self._stopped.is_set():
                await asyncio.sleep(EMPTY_ROOM_POLL_S)
                now = time.monotonic()
                if not self._empty_room.observe(self._human_count(), now):
                    continue
                logger.warning(
                    "no humans in room %s for %.0fs (ever_occupied=%s) — stopping relay call=%s",
                    self.job.room_name,
                    self._empty_room.empty_for(now),
                    self._empty_room.ever_occupied,
                    self.job.call_id,
                )
                self._stopped.set()
                return
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # a watchdog must never be what kills a live call
            logger.warning("empty-room watchdog failed call=%s: %s", self.job.call_id, exc)

    def _human_count(self) -> int:
        """Remote participants that are not another agent."""
        return sum(
            1
            for participant in self.room.remote_participants.values()
            if participant.identity != AGENT_IDENTITY
        )

    def _on_room_disconnected(self, *_: Any) -> None:
        logger.info("room disconnected call=%s", self.job.call_id)
        self._stopped.set()

    def _attach(self, track: rtc.Track, identity: str) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return
        direction = self._directions.get(identity)
        if direction is None:
            return
        if identity in self._reader_tasks and not self._reader_tasks[identity].done():
            return
        self._reader_tasks[identity] = asyncio.create_task(
            self._read_track(track, direction), name=f"read:{identity}"
        )
        logger.info("reading microphone of %s", identity)

    async def _read_track(self, track: rtc.Track, direction: Direction) -> None:
        stream = rtc.AudioStream.from_track(
            track=track,
            sample_rate=self._stt.preferred_sample_rate,
            num_channels=self._stt.preferred_num_channels,
        )
        try:
            async for event in stream:
                direction.push_frame(event.frame)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("audio reader for %s failed: %s", direction.speaker.user_id, exc)
        finally:
            with contextlib.suppress(Exception):
                await stream.aclose()

    # ---------------------------------------------------------------- introspection

    def snapshot(self) -> dict[str, Any]:
        return {
            "callId": self.job.call_id,
            "roomName": self.job.room_name,
            "mode": self.job.mode,
            "humans": self._human_count(),
            "emptyForS": round(self._empty_room.empty_for(time.monotonic()), 1),
            "directions": [
                {
                    "speaker": d.speaker.user_id,
                    "listener": d.listener.user_id,
                    "unitsCommitted": d.stats.units_committed,
                    "unitsSpoken": d.stats.units_spoken,
                    "unitsCancelled": d.stats.units_cancelled,
                    "bargeIns": d.stats.barge_ins,
                    "providerErrors": d.stats.provider_errors,
                }
                for d in self._directions.values()
            ],
        }


__all__ = ["EmptyRoomWatch", "Relay", "RelayJob"]
