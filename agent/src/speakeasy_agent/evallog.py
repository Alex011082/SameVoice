"""Durable per-call evaluation log: one JSONL file per call.

Why this exists. The second tester is a native Russian speaker who speaks
Hebrew to the founder. She hears her own Hebrew AND the Russian the relay
produced, so she can say immediately whether a translation was actually
correct. That verdict is worth something only if it can be attached to the
*exact* utterance, together with the exact latencies and the exact provider
triple that produced it. This file is what turns her from an opinion into a
labelled-data source.

Two record kinds share the file, keyed on `kind`:

  * `call`      - one header line per relay, written when the call opens.
  * `utterance` - one line per committed translation unit, carrying source,
                  translation, both genders, the tone in force, every latency
                  the pipeline already measured, and a stable `utteranceId`.
  * `verdict`   - one line per judge verdict, referencing that `utteranceId`.

Verdicts are appended, never merged into the utterance line: the log is
append-only so a second verdict on the same utterance is visible as a change of
mind rather than silently overwriting the first.

HARD RULE: nothing here may block or crash the audio path. `CallEvalLog.append`
is synchronous and non-blocking - it drops the record into a bounded queue. A
background task drains the queue and does the actual file write on a worker
thread. A full queue drops the record with a warning; every filesystem error is
logged and swallowed. A broken eval log degrades the experiment, never the call.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

logger = logging.getLogger(__name__)

RECORD_VERSION = 1

#: Call ids come from the backend and are interpolated into a filename, so they
#: are validated rather than trusted. This also blocks `..` traversal on the
#: verdict endpoint, whose call id arrives over HTTP.
_CALL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

VERDICTS: tuple[str, ...] = ("wrong", "ok")

#: Enough for many minutes of two-way speech. If it ever fills, the pipeline is
#: producing units faster than a local disk can absorb one short line each,
#: which means something else is badly wrong.
_QUEUE_MAXSIZE = 2048

_STOP = object()

# Two writers can touch one file: the per-call background writer and the
# verdict endpoint (which appends even after the relay is gone). Both use
# O_APPEND, but an in-process lock removes any doubt about interleaving.
_write_lock = threading.Lock()


def is_valid_call_id(call_id: str) -> bool:
    return bool(_CALL_ID_RE.match(call_id))


def _append_lines(path: Path, lines: Sequence[str]) -> None:
    if not lines:
        return
    with _write_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write("".join(line + "\n" for line in lines))
            fh.flush()


def _dumps(record: dict[str, Any]) -> str:
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"))


# --------------------------------------------------------------------- records


def call_header_record(
    *,
    call_id: str,
    room_name: str,
    mode: str,
    providers: dict[str, str],
    participants: Iterable[dict[str, Any]],
    agent_version: str = "",
) -> dict[str, Any]:
    """Written once per relay so a review of a call with zero utterances still
    shows which providers were in force - which is exactly the case you most
    want to explain."""
    return {
        "kind": "call",
        "v": RECORD_VERSION,
        "ts": round(time.time(), 3),
        "callId": call_id,
        "roomName": room_name,
        "mode": mode,
        "providers": dict(providers),
        "participants": [dict(p) for p in participants],
        "agentVersion": agent_version,
    }


def utterance_record(
    *,
    call_id: str,
    utterance_id: str,
    segment_id: str,
    speaker: dict[str, Any],
    listener: dict[str, Any],
    src_lang: str,
    dst_lang: str,
    src_text: str,
    dst_text: str,
    providers: dict[str, str],
    latency: dict[str, Any],
    trigger: str,
    words: int,
    t_start: float,
    t_end: float,
    cancelled: bool,
    error: str | None,
) -> dict[str, Any]:
    """One translated utterance, flat enough to grep and rich enough to judge.

    `tone` is recorded separately from the two participant blocks because the MT
    prompt keys register off the LISTENER's tone - the address form belongs to
    the person being addressed. Recording it explicitly means a later argument
    about "why was this so formal" is settled by the log, not by memory.
    """
    return {
        "kind": "utterance",
        "v": RECORD_VERSION,
        "ts": round(time.time(), 3),
        "callId": call_id,
        "utteranceId": utterance_id,
        "segmentId": segment_id,
        "direction": f"{src_lang}->{dst_lang}",
        "srcLang": src_lang,
        "dstLang": dst_lang,
        "speakerId": speaker.get("userId", ""),
        "speakerGender": speaker.get("gender", ""),
        "speakerTone": speaker.get("tone", ""),
        "listenerId": listener.get("userId", ""),
        "listenerGender": listener.get("gender", ""),
        "listenerTone": listener.get("tone", ""),
        "tone": listener.get("tone", ""),
        "srcText": src_text,
        "dstText": dst_text,
        "srcChars": len(src_text),
        "dstChars": len(dst_text),
        "trigger": trigger,
        "words": words,
        "tStart": round(t_start, 3),
        "tEnd": round(t_end, 3),
        "providers": dict(providers),
        "latency": dict(latency),
        "cancelled": bool(cancelled),
        "error": error,
    }


def verdict_record(
    *,
    call_id: str,
    utterance_id: str,
    verdict: str,
    expected: str | None = None,
    note: str | None = None,
    by: str = "",
    received_at: str = "",
    resolved: bool = True,
) -> dict[str, Any]:
    return {
        "kind": "verdict",
        "v": RECORD_VERSION,
        "ts": round(time.time(), 3),
        "callId": call_id,
        "utteranceId": utterance_id,
        "verdict": verdict,
        "expected": expected or None,
        "note": note or None,
        "by": by,
        "receivedAt": received_at,
        # False means the verdict arrived for an utterance id this log has never
        # seen. The verdict is still kept - losing a judge's label is worse than
        # keeping an orphan - and the review CLI reports it as orphaned.
        "resolved": bool(resolved),
    }


# ------------------------------------------------------------------- per call


@dataclass
class _Dropped:
    count: int = 0
    warned: bool = False


class CallEvalLog:
    """Append-only writer for one call. Constructed by `EvalLogStore.open_call`."""

    def __init__(self, *, path: Path, call_id: str, enabled: bool = True) -> None:
        self.path = path
        self.call_id = call_id
        self.enabled = enabled
        self._queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
        self._dropped = _Dropped()
        self._closed = False
        self._task: asyncio.Task | None = None
        if enabled:
            self._task = asyncio.create_task(self._writer(), name=f"evallog:{call_id}")

    # ------------------------------------------------------------------ write

    def append(self, record: dict[str, Any]) -> None:
        """Non-blocking. Never raises: the audio path calls this."""
        if not self.enabled or self._closed:
            return
        try:
            self._queue.put_nowait(_dumps(record))
        except asyncio.QueueFull:
            self._dropped.count += 1
            if not self._dropped.warned:
                self._dropped.warned = True
                logger.warning(
                    "eval log queue is full for call %s; records are being dropped",
                    self.call_id,
                )
        except Exception as exc:  # serialisation of an unexpected value
            logger.warning("eval log record for call %s is not serialisable: %s", self.call_id, exc)

    async def _writer(self) -> None:
        try:
            while True:
                item = await self._queue.get()
                stop = item is _STOP
                batch: list[str] = [] if stop else [item]
                while not stop and not self._queue.empty():
                    nxt = self._queue.get_nowait()
                    if nxt is _STOP:
                        stop = True
                        break
                    batch.append(nxt)
                if batch:
                    try:
                        await asyncio.to_thread(_append_lines, self.path, batch)
                    except Exception as exc:
                        logger.warning("eval log write failed for %s: %s", self.path, exc)
                if stop:
                    return
        except asyncio.CancelledError:
            raise

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._task is None:
            return
        try:
            self._queue.put_nowait(_STOP)
        except asyncio.QueueFull:  # pragma: no cover - the writer will still drain
            pass
        try:
            await asyncio.wait_for(asyncio.shield(self._task), timeout=3.0)
        except Exception as exc:
            logger.warning("eval log writer for %s did not finish cleanly: %s", self.call_id, exc)
            self._task.cancel()
        finally:
            self._task = None
        if self._dropped.count:
            logger.warning(
                "eval log for call %s dropped %d record(s)", self.call_id, self._dropped.count
            )


# ------------------------------------------------------------------- the store


class EvalLogStore:
    """Owns the log directory. Cheap to construct; holds no open files."""

    def __init__(self, root: str | os.PathLike[str], *, enabled: bool = True) -> None:
        self.root = Path(root).expanduser()
        self.enabled = enabled

    def path_for(self, call_id: str) -> Path:
        if not is_valid_call_id(call_id):
            raise ValueError(f"unsafe call id {call_id!r}")
        return self.root / f"{call_id}.jsonl"

    def exists(self, call_id: str) -> bool:
        try:
            return self.path_for(call_id).is_file()
        except ValueError:
            return False

    def open_call(self, call_id: str, *, header: dict[str, Any] | None = None) -> CallEvalLog:
        """Start a writer for one call. The header line is queued immediately so
        the file exists from the moment the relay starts - which is what makes
        the verdict endpoint able to answer 404 truthfully."""
        path = self.path_for(call_id)
        log = CallEvalLog(path=path, call_id=call_id, enabled=self.enabled)
        if header is not None:
            log.append(header)
        return log

    # ------------------------------------------------------------ read / verdict

    async def read_records(self, call_id: str) -> list[dict[str, Any]]:
        path = self.path_for(call_id)
        return await asyncio.to_thread(read_records_from_path, path)

    async def resolve_latest_utterance(
        self, call_id: str, *, listener_id: str | None = None
    ) -> str | None:
        """Which utterance did the judge mean by "that one was wrong"?

        The one they most recently HEARD - i.e. the newest utterance whose
        listener is them and which actually produced a translation. When the
        caller did not say who they are, the newest utterance in the call is the
        best available answer; when they did and nothing matches, None is
        returned rather than anchoring the verdict to something they never
        heard.
        """
        records = await self.read_records(call_id)
        for record in reversed(records):
            if record.get("kind") != "utterance" or not record.get("dstText"):
                continue
            if listener_id and record.get("listenerId") != listener_id:
                continue
            return record.get("utteranceId") or None
        return None

    async def append_verdict(self, call_id: str, record: dict[str, Any]) -> None:
        path = self.path_for(call_id)
        await asyncio.to_thread(_append_lines, path, [_dumps(record)])

    async def has_utterance(self, call_id: str, utterance_id: str) -> bool:
        records = await self.read_records(call_id)
        return any(
            r.get("kind") == "utterance" and r.get("utteranceId") == utterance_id for r in records
        )

    def list_calls(self) -> list[str]:
        if not self.root.is_dir():
            return []
        return sorted(p.stem for p in self.root.glob("*.jsonl"))


def read_records_from_path(path: Path) -> list[dict[str, Any]]:
    """Tolerant reader: a torn last line (process killed mid-write) must not
    make a whole session unreadable."""
    records: list[dict[str, Any]] = []
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return records
    except OSError as exc:
        logger.warning("cannot read eval log %s: %s", path, exc)
        return records
    for lineno, line in enumerate(raw.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("eval log %s line %d is not valid JSON, skipped", path, lineno)
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


__all__ = [
    "RECORD_VERSION",
    "VERDICTS",
    "CallEvalLog",
    "EvalLogStore",
    "call_header_record",
    "is_valid_call_id",
    "read_records_from_path",
    "utterance_record",
    "verdict_record",
]
