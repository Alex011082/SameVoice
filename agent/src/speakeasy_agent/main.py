"""Standalone agent job server.

Deliberately NOT `AgentServer` + `cli.run_app` + automatic dispatch: with
automatic dispatch a worker joins EVERY room, which violates "AI is not in the
call path unless it is needed" at the architecture level. A standalone process
that only ever connects to rooms the backend explicitly asked for makes the
DIRECT guarantee structural and machine-checkable:

    curl -s http://127.0.0.1:8788/healthz   ->  activeCalls: 0

during a DIRECT call, and no `agent-relay` identity in the room.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import signal
import time
from typing import Any

from aiohttp import web

from . import AGENT_IDENTITY, __version__
from .config import Config, configure_logging
from .evallog import VERDICTS, EvalLogStore, is_valid_call_id, verdict_record
from .httpclient import close_shared_session
from .providers import build_mt, build_stt, build_tts
from .relay import Relay, RelayJob
from .engine_routing import resolve_for_call

logger = logging.getLogger("speakeasy_agent")

AUTH_HEADER = "x-speakeasy-agent-key"


MAX_REMEMBERED_FAILURES = 32


#: A judge's expected-translation text and free note are stored verbatim, so
#: they are length-capped rather than trusted.
MAX_VERDICT_TEXT = 2000


class AgentService:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.eval_store = EvalLogStore(cfg.eval_log_dir, enabled=cfg.eval_log_enabled)
        self._relays: dict[str, Relay] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        # A relay that dies on connect (bad token, SFU down) would otherwise
        # vanish without a machine-readable trace: /healthz would report
        # activeCalls 0 and /stats an empty list, which is indistinguishable
        # from "never dispatched" while the backend still believes an agent is
        # in the room. Remember the last few failures so the failure is
        # observable, not just a line in the log.
        self._failures: dict[str, dict[str, Any]] = {}

    @property
    def active_call_ids(self) -> list[str]:
        return sorted(self._relays.keys())

    @property
    def failed_call_ids(self) -> list[str]:
        return sorted(self._failures.keys())

    def is_running(self, call_id: str) -> bool:
        return call_id in self._relays

    async def start_job(self, job: RelayJob) -> None:
        self._failures.pop(job.call_id, None)
        # Движок выбирается ДЛЯ ЭТОГО звонка: у оркестратора может быть
        # поднято несколько подов, и соседний разговор пойдёт на другой.
        # Молчание оркестратора не мешает звонку — остаются настройки среды.
        cfg = await resolve_for_call(self.cfg, job)
        relay = Relay(job, cfg, eval_store=self.eval_store)
        self._relays[job.call_id] = relay
        task = asyncio.create_task(self._supervise(job.call_id, relay), name=f"relay:{job.call_id}")
        self._tasks[job.call_id] = task

    def _record_failure(self, call_id: str, detail: str) -> None:
        while len(self._failures) >= MAX_REMEMBERED_FAILURES:
            self._failures.pop(next(iter(self._failures)))
        self._failures[call_id] = {
            "callId": call_id,
            "at": time.time(),
            "detail": detail[:400],
        }

    async def _supervise(self, call_id: str, relay: Relay) -> None:
        try:
            await relay.run()
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await relay.aclose()
            raise
        except Exception as exc:
            logger.exception("relay for call %s terminated with an error", call_id)
            self._record_failure(call_id, f"{type(exc).__name__}: {exc}")
        finally:
            self._relays.pop(call_id, None)
            self._tasks.pop(call_id, None)

    async def stop_job(self, call_id: str) -> bool:
        relay = self._relays.get(call_id)
        if relay is None:
            return False
        relay.stop()
        task = self._tasks.get(call_id)
        if task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=5.0)
            except asyncio.TimeoutError:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        return True

    async def stop_all(self) -> None:
        for call_id in list(self._relays.keys()):
            with contextlib.suppress(Exception):
                await self.stop_job(call_id)

    def snapshot(self) -> list[dict[str, Any]]:
        return [relay.snapshot() for relay in self._relays.values()]

    def failures(self) -> list[dict[str, Any]]:
        return list(self._failures.values())


#: Exposed so tests (and any future introspection route) can reach the service
#: without reconstructing it.
SERVICE_KEY: web.AppKey["AgentService"] = web.AppKey("service")


def _unauthorized(request: web.Request, cfg: Config) -> bool:
    return request.headers.get(AUTH_HEADER, "") != cfg.agent_shared_secret


def _clip(value: Any, limit: int = MAX_VERDICT_TEXT) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] or None


def build_app(cfg: Config) -> web.Application:
    service = AgentService(cfg)
    app = web.Application()

    async def healthz(_: web.Request) -> web.Response:
        return web.json_response(
            {
                "ok": True,
                "service": "agent",
                "version": __version__,
                "providers": cfg.providers,
                "activeCalls": len(service.active_call_ids),
                "callIds": service.active_call_ids,
                "failedCalls": len(service.failed_call_ids),
                "evalLog": {
                    "enabled": service.eval_store.enabled,
                    "dir": str(service.eval_store.root),
                },
            }
        )

    async def stats(request: web.Request) -> web.Response:
        if _unauthorized(request, cfg):
            return web.json_response({"reason": "unauthorized"}, status=401)
        return web.json_response({"calls": service.snapshot(), "failed": service.failures()})

    async def create_job(request: web.Request) -> web.Response:
        if _unauthorized(request, cfg):
            return web.json_response({"accepted": False, "reason": "unauthorized"}, status=401)
        try:
            payload = await request.json()
        except (json.JSONDecodeError, ValueError):
            return web.json_response(
                {"accepted": False, "reason": "bad_request", "detail": "body is not JSON"},
                status=400,
            )
        if not isinstance(payload, dict):
            return web.json_response(
                {
                    "accepted": False,
                    "reason": "bad_request",
                    "detail": "body must be a JSON object",
                },
                status=400,
            )
        # `.strip()` is load-bearing, not tidiness: without it a mode of
        # " DIRECT " walks straight past this guard and the agent joins the room
        # of a call that must have no AI in its path — the exact failure this
        # check exists to prevent. RelayJob.from_payload normalises the same way,
        # so the guard and the job can never disagree about what the mode is.
        if str(payload.get("mode", "")).strip().upper() == "DIRECT":
            # Second line of defence for the core product principle: the agent
            # refuses to exist in a call that does not need translation.
            return web.json_response(
                {"accepted": False, "reason": "direct_mode_no_agent"}, status=400
            )
        try:
            job = RelayJob.from_payload(payload)
        except ValueError as exc:
            return web.json_response(
                {"accepted": False, "reason": "bad_request", "detail": str(exc)}, status=400
            )
        if service.is_running(job.call_id):
            return web.json_response(
                {"accepted": False, "reason": "already_running"}, status=409
            )
        await service.start_job(job)
        logger.info("accepted job call=%s room=%s mode=%s", job.call_id, job.room_name, job.mode)
        return web.json_response({"accepted": True, "callId": job.call_id}, status=202)

    async def stop_job(request: web.Request) -> web.Response:
        if _unauthorized(request, cfg):
            return web.json_response({"stopped": False, "reason": "unauthorized"}, status=401)
        call_id = request.match_info["call_id"]
        stopped = await service.stop_job(call_id)
        if not stopped:
            return web.json_response({"stopped": False, "reason": "not_found"}, status=404)
        return web.json_response({"stopped": True})

    async def post_verdict(request: web.Request) -> web.Response:
        """The bilingual judge's verdict, forwarded by the backend.

        Two routes reach this handler because the two halves of the contract
        spell it differently: the backend calls `POST /jobs/<callId>/verdict`
        (see backend/src/types.ts `AgentVerdict`), and `POST /verdicts` takes the
        call id in the body. Both append the same record to the same JSONL.

        `utteranceId` may be null, meaning "whatever I just heard". The agent
        resolves that against the log: the newest utterance whose LISTENER is the
        judge and which actually produced a translation.
        """
        if _unauthorized(request, cfg):
            return web.json_response({"accepted": False, "reason": "unauthorized"}, status=401)
        try:
            payload = await request.json()
        except (json.JSONDecodeError, ValueError):
            return web.json_response(
                {"accepted": False, "reason": "bad_request", "detail": "body is not JSON"},
                status=400,
            )
        if not isinstance(payload, dict):
            return web.json_response(
                {"accepted": False, "reason": "bad_request", "detail": "body must be an object"},
                status=400,
            )

        call_id = str(request.match_info.get("call_id") or payload.get("callId") or "")
        if not call_id or not is_valid_call_id(call_id):
            return web.json_response(
                {"accepted": False, "reason": "bad_request", "detail": "callId is missing or unsafe"},
                status=400,
            )

        verdict = str(payload.get("verdict") or "").strip().lower()
        if verdict not in VERDICTS:
            return web.json_response(
                {
                    "accepted": False,
                    "reason": "bad_request",
                    "detail": f"verdict must be one of {', '.join(VERDICTS)}",
                },
                status=400,
            )

        if not service.eval_store.enabled:
            return web.json_response(
                {"accepted": False, "reason": "eval_log_disabled"}, status=409
            )
        if not service.eval_store.exists(call_id):
            # The log file is created the moment a relay starts, so "no file"
            # genuinely means "this agent never handled that call".
            return web.json_response({"accepted": False, "reason": "unknown_call"}, status=404)

        user_id = _clip(payload.get("userId"), 128) or ""
        raw_utterance = payload.get("utteranceId")
        utterance_id = str(raw_utterance).strip() if raw_utterance else ""
        resolved = True
        if not utterance_id:
            utterance_id = (
                await service.eval_store.resolve_latest_utterance(
                    call_id, listener_id=user_id or None
                )
                or ""
            )
            resolved = bool(utterance_id)
        else:
            resolved = await service.eval_store.has_utterance(call_id, utterance_id)

        record = verdict_record(
            call_id=call_id,
            utterance_id=utterance_id,
            verdict=verdict,
            expected=_clip(payload.get("expected")),
            note=_clip(payload.get("note")),
            by=user_id,
            received_at=_clip(payload.get("receivedAt"), 64) or "",
            resolved=resolved,
        )
        try:
            await service.eval_store.append_verdict(call_id, record)
        except Exception as exc:
            logger.warning("failed to append verdict for call %s: %s", call_id, exc)
            return web.json_response({"accepted": False, "reason": "write_failed"}, status=500)

        # An unresolved verdict is still ACCEPTED and still written. Losing a
        # judge's label because a race put the click a few milliseconds ahead of
        # the log line would be a far worse failure than an orphan record, and
        # the review CLI reports orphans explicitly.
        logger.info(
            "verdict call=%s utterance=%s verdict=%s resolved=%s",
            call_id,
            utterance_id or "-",
            verdict,
            resolved,
        )
        return web.json_response(
            {"accepted": True, "callId": call_id, "utteranceId": utterance_id, "resolved": resolved},
            status=202,
        )

    app.router.add_get("/healthz", healthz)
    app.router.add_get("/stats", stats)
    app.router.add_post("/jobs", create_job)
    app.router.add_post("/jobs/{call_id}/stop", stop_job)
    app.router.add_post("/jobs/{call_id}/verdict", post_verdict)
    app.router.add_post("/verdicts", post_verdict)

    async def _on_cleanup(_: web.Application) -> None:
        await service.stop_all()
        await close_shared_session()

    app.on_cleanup.append(_on_cleanup)
    app[SERVICE_KEY] = service
    return app


def _preflight(cfg: Config) -> None:
    """Fail loudly at boot rather than on the first call if a selected provider
    cannot be constructed (missing key, missing optional plugin, bad name)."""
    for label, builder, name in (
        ("STT", build_stt, cfg.stt_provider),
        ("MT", build_mt, cfg.mt_provider),
        ("TTS", build_tts, cfg.tts_provider),
    ):
        try:
            provider = builder(name, cfg)
        except Exception as exc:
            raise SystemExit(f"{label} provider {name!r} cannot start: {exc}") from exc
        logger.info("%s provider ready: %s", label, getattr(provider, "name", name))


async def _serve(cfg: Config) -> None:
    app = build_app(cfg)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, cfg.agent_host, cfg.agent_port)
    await site.start()
    logger.info(
        "agent listening on http://%s:%d identity=%s providers=%s",
        cfg.agent_host,
        cfg.agent_port,
        AGENT_IDENTITY,
        json.dumps(cfg.providers),
    )

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        logger.info("shutting down")
        await runner.cleanup()


def run() -> None:
    cfg = Config.from_env()
    configure_logging(cfg)
    _preflight(cfg)
    try:
        asyncio.run(_serve(cfg))
    except KeyboardInterrupt:  # pragma: no cover
        pass


if __name__ == "__main__":
    run()
