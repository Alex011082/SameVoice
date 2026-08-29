"""POST /jobs/<callId>/verdict and POST /verdicts - the agent half of item C.

Runs against the real aiohttp application with a temporary log directory. No
LiveKit, no network, no keys.
"""

from __future__ import annotations

import pytest
from aiohttp.test_utils import TestClient, TestServer

from speakeasy_agent.config import Config
from speakeasy_agent.evallog import EvalLogStore, call_header_record, utterance_record
from speakeasy_agent.main import AUTH_HEADER, build_app

SECRET = "test-secret"
CALL_ID = "c_verdict001"

SPEAKER = {"userId": "u_alex", "displayName": "Alex", "lang": "ru", "gender": "m", "tone": "neutral"}
LISTENER = {"userId": "u_noa", "displayName": "Noa", "lang": "he", "gender": "f", "tone": "friendly"}


def utterance(uid: str, *, speaker=SPEAKER, listener=LISTENER, dst="שלום"):
    return utterance_record(
        call_id=CALL_ID,
        utterance_id=uid,
        segment_id=f"seg_{uid}",
        speaker=speaker,
        listener=listener,
        src_lang=speaker["lang"],
        dst_lang=listener["lang"],
        src_text="привет",
        dst_text=dst,
        providers={"stt": "mock", "mt": "mock", "tts": "mock"},
        latency={},
        trigger="final",
        words=1,
        t_start=0.0,
        t_end=1.0,
        cancelled=False,
        error=None,
    )


@pytest.fixture
async def client(tmp_path):
    cfg = Config(agent_shared_secret=SECRET, eval_log_dir=str(tmp_path))
    app = build_app(cfg)
    async with TestClient(TestServer(app)) as test_client:
        yield test_client


async def seed_call(tmp_path, utterances=()) -> EvalLogStore:
    store = EvalLogStore(tmp_path)
    log = store.open_call(
        CALL_ID,
        header=call_header_record(
            call_id=CALL_ID,
            room_name=f"call-{CALL_ID}",
            mode="TRANSLATED",
            providers={"stt": "mock", "mt": "mock", "tts": "mock"},
            participants=[SPEAKER, LISTENER],
        ),
    )
    for record in utterances:
        log.append(record)
    await log.aclose()
    return store


async def test_verdict_requires_the_shared_secret(client):
    resp = await client.post(f"/jobs/{CALL_ID}/verdict", json={"verdict": "wrong"})
    assert resp.status == 401


async def test_unknown_call_is_404(client):
    resp = await client.post(
        "/jobs/c_neverhappened/verdict",
        json={"verdict": "wrong"},
        headers={AUTH_HEADER: SECRET},
    )
    assert resp.status == 404
    assert (await resp.json())["reason"] == "unknown_call"


async def test_a_traversal_attempt_is_rejected_before_it_touches_the_disk(client):
    resp = await client.post(
        "/verdicts",
        json={"callId": "../../../etc/passwd", "verdict": "wrong"},
        headers={AUTH_HEADER: SECRET},
    )
    assert resp.status == 400


async def test_an_unknown_verdict_word_is_rejected(client, tmp_path):
    await seed_call(tmp_path, [utterance("u1")])
    resp = await client.post(
        f"/jobs/{CALL_ID}/verdict",
        json={"verdict": "maybe"},
        headers={AUTH_HEADER: SECRET},
    )
    assert resp.status == 400


async def test_a_flag_with_an_explicit_utterance_id_is_appended(client, tmp_path):
    store = await seed_call(tmp_path, [utterance("u1"), utterance("u2")])
    resp = await client.post(
        f"/jobs/{CALL_ID}/verdict",
        json={
            "callId": CALL_ID,
            "userId": "u_noa",
            "verdict": "wrong",
            "utteranceId": "u1",
            "expected": "שלום, את שומעת אותי?",
            "note": "gender was masculine",
        },
        headers={AUTH_HEADER: SECRET},
    )
    assert resp.status == 202
    body = await resp.json()
    assert body == {
        "accepted": True,
        "callId": CALL_ID,
        "utteranceId": "u1",
        "resolved": True,
    }

    verdicts = [r for r in await store.read_records(CALL_ID) if r["kind"] == "verdict"]
    assert len(verdicts) == 1
    assert verdicts[0]["utteranceId"] == "u1"
    assert verdicts[0]["verdict"] == "wrong"
    assert verdicts[0]["expected"] == "שלום, את שומעת אותי?"
    assert verdicts[0]["note"] == "gender was masculine"
    assert verdicts[0]["by"] == "u_noa"


async def test_a_null_utterance_id_resolves_to_what_that_judge_last_heard(client, tmp_path):
    """One click, no id: the judge means the translation she just heard."""
    store = await seed_call(
        tmp_path,
        [
            utterance("a1"),
            utterance("b1", speaker=LISTENER, listener=SPEAKER, dst="привет"),
            utterance("a2"),
        ],
    )
    resp = await client.post(
        "/verdicts",
        json={"callId": CALL_ID, "userId": "u_noa", "verdict": "wrong", "utteranceId": None},
        headers={AUTH_HEADER: SECRET},
    )
    assert resp.status == 202
    assert (await resp.json())["utteranceId"] == "a2"

    resp = await client.post(
        "/verdicts",
        json={"callId": CALL_ID, "userId": "u_alex", "verdict": "ok"},
        headers={AUTH_HEADER: SECRET},
    )
    assert (await resp.json())["utteranceId"] == "b1"

    verdicts = [r for r in await store.read_records(CALL_ID) if r["kind"] == "verdict"]
    assert [(v["by"], v["utteranceId"], v["verdict"]) for v in verdicts] == [
        ("u_noa", "a2", "wrong"),
        ("u_alex", "b1", "ok"),
    ]


async def test_an_unmatched_verdict_is_kept_and_marked_unresolved(client, tmp_path):
    """Losing a judge's label to a race would be worse than an orphan record."""
    store = await seed_call(tmp_path, [utterance("u1")])
    resp = await client.post(
        f"/jobs/{CALL_ID}/verdict",
        json={"verdict": "wrong", "utteranceId": "utt_that_never_existed"},
        headers={AUTH_HEADER: SECRET},
    )
    assert resp.status == 202
    body = await resp.json()
    assert body["resolved"] is False

    verdicts = [r for r in await store.read_records(CALL_ID) if r["kind"] == "verdict"]
    assert len(verdicts) == 1
    assert verdicts[0]["resolved"] is False


async def test_verdicts_still_work_after_the_call_ended(client, tmp_path):
    """The founder and the tester review together right AFTER hanging up, when
    the relay is long gone. The endpoint reads the file, not live state."""
    store = await seed_call(tmp_path, [utterance("u1")])
    from speakeasy_agent.main import SERVICE_KEY

    # No relay is running for this call - the endpoint must not depend on one.
    assert client.app[SERVICE_KEY].active_call_ids == []
    resp = await client.post(
        f"/jobs/{CALL_ID}/verdict",
        json={"verdict": "wrong", "userId": "u_noa"},
        headers={AUTH_HEADER: SECRET},
    )
    assert resp.status == 202
    assert [r for r in await store.read_records(CALL_ID) if r["kind"] == "verdict"]


async def test_healthz_reports_where_the_logs_go(client):
    resp = await client.get("/healthz")
    assert resp.status == 200
    body = await resp.json()
    assert body["evalLog"]["enabled"] is True
    assert body["evalLog"]["dir"]


async def test_verdicts_are_refused_when_the_eval_log_is_disabled(tmp_path):
    cfg = Config(agent_shared_secret=SECRET, eval_log_dir=str(tmp_path), eval_log_enabled=False)
    async with TestClient(TestServer(build_app(cfg))) as client:
        resp = await client.post(
            f"/jobs/{CALL_ID}/verdict",
            json={"verdict": "wrong"},
            headers={AUTH_HEADER: SECRET},
        )
        assert resp.status == 409
        assert (await resp.json())["reason"] == "eval_log_disabled"


DIRECT_JOB = {
    "callId": "c_directguard",
    "roomName": "call-c_directguard",
    "livekitUrl": "ws://127.0.0.1:7880",
    "token": "t",
    "participants": [
        {"userId": "u_alex", "lang": "ru", "gender": "m", "tone": "neutral"},
        {"userId": "u_noa", "lang": "ru", "gender": "f", "tone": "neutral"},
    ],
}


@pytest.mark.parametrize("mode", ["DIRECT", "direct", "Direct", " DIRECT ", "\tdirect\n"])
async def test_a_direct_job_is_refused_however_it_is_spelled(client, mode):
    """The agent's own refusal of DIRECT is the second line of defence for the
    product's core promise: no AI in the path of a call that does not need it.
    A guard that a stray space walks past is not a guard - ' DIRECT ' used to be
    accepted, and the relay joined the room and opened an eval log for it.
    """
    resp = await client.post(
        "/jobs", json=dict(DIRECT_JOB, mode=mode), headers={AUTH_HEADER: SECRET}
    )
    assert resp.status == 400
    assert (await resp.json())["reason"] == "direct_mode_no_agent"

    from speakeasy_agent.main import SERVICE_KEY

    # Not merely rejected: no relay, and nothing written to disk for that call.
    assert client.app[SERVICE_KEY].active_call_ids == []
    assert not client.app[SERVICE_KEY].eval_store.exists(DIRECT_JOB["callId"])
