"""The relay must not sit in a room the humans have left.

Regression cover for 25.08.2026: the agent reported `activeCalls: 1` for a call
that had been dead for fifteen hours — holding a LiveKit participant slot and
two open STT sessions — because nothing ever told it to leave and LiveKit will
not clear a room the agent itself is a participant of.
"""

from __future__ import annotations

import asyncio

import pytest

from speakeasy_agent import relay as relay_module
from speakeasy_agent.config import Config
from speakeasy_agent.providers.base import Speaker
from speakeasy_agent.relay import EmptyRoomWatch, Relay, RelayJob

GRACE = 120.0


def test_a_room_nobody_ever_joins_is_given_up_on_after_the_grace() -> None:
    watch = EmptyRoomWatch(GRACE, started_at=1000.0)
    # The agent is dispatched when the call is CREATED, so an empty room is
    # normal for the whole ring window. It must not be cut short.
    assert watch.observe(0, 1000.0 + GRACE - 1) is False
    assert watch.observe(0, 1000.0 + GRACE) is True
    assert watch.ever_occupied is False


def test_a_human_in_the_room_resets_the_clock() -> None:
    watch = EmptyRoomWatch(GRACE, started_at=0.0)
    assert watch.observe(0, GRACE - 1) is False
    assert watch.observe(2, GRACE - 1) is False, "two people are talking"
    assert watch.ever_occupied is True
    assert watch.empty_for(GRACE - 1) == 0.0

    # They hang up without anybody telling the agent.
    assert watch.observe(0, GRACE * 2 - 2) is False
    assert watch.observe(0, GRACE * 2) is True


def test_one_person_left_behind_still_counts_as_occupied() -> None:
    """A call where the peer dropped is still a call; only an EMPTY room ends it."""
    watch = EmptyRoomWatch(GRACE, started_at=0.0)
    for t in range(0, int(GRACE * 3), 10):
        assert watch.observe(1, float(t)) is False


class _FakeParticipant:
    def __init__(self, identity: str) -> None:
        self.identity = identity


class _FakeRoom:
    """Only the two members the watchdog and teardown touch."""

    def __init__(self) -> None:
        self.remote_participants: dict[str, _FakeParticipant] = {}
        self.disconnected = False

    async def disconnect(self) -> None:
        self.disconnected = True


def _job() -> RelayJob:
    speakers = (
        Speaker(user_id="u_alex", display_name="Alex", lang="ru", gender="m", tone="neutral"),
        Speaker(user_id="u_noa", display_name="Noa", lang="he", gender="f", tone="friendly"),
    )
    return RelayJob(
        call_id="c_emptyroom01",
        room_name="call-c_emptyroom01",
        mode="TRANSLATED",
        livekit_url="ws://127.0.0.1:7880",
        token="not-used",
        participants=speakers,
    )


@pytest.mark.parametrize("occupied_first", [False, True])
async def test_the_watchdog_stops_the_relay_when_the_room_empties(
    monkeypatch: pytest.MonkeyPatch, occupied_first: bool
) -> None:
    monkeypatch.setattr(relay_module, "EMPTY_ROOM_POLL_S", 0.01)
    monkeypatch.setattr(relay_module, "EMPTY_ROOM_TIMEOUT_S", 0.05)

    cfg = Config(eval_log_enabled=False)
    relay = Relay(_job(), cfg)
    room = _FakeRoom()
    relay.room = room  # type: ignore[assignment]

    if occupied_first:
        room.remote_participants["u_alex"] = _FakeParticipant("u_alex")

    watchdog = asyncio.create_task(relay._watch_empty_room())
    try:
        if occupied_first:
            await asyncio.sleep(0.1)
            assert not relay._stopped.is_set(), "a room with a human in it must be left alone"
            # The agent's own identity is not a human and must not hold the room.
            room.remote_participants.clear()
            room.remote_participants["agent-relay"] = _FakeParticipant("agent-relay")

        await asyncio.wait_for(relay._stopped.wait(), timeout=2.0)
    finally:
        watchdog.cancel()
        await asyncio.gather(watchdog, return_exceptions=True)
        await relay.aclose()

    assert room.disconnected, "giving up on the room must actually leave it"
