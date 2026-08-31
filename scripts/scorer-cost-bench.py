#!/usr/bin/env python3
"""Cost-only benchmark for the FIRST paid GPU session: what the scorer charges.

WHAT THIS ANSWERS

    Only the cost half of the founder's question. How many milliseconds does one
    utterance pay for the prediction + acoustic-pruning machinery on the critical
    path, on this card, at this much contention. If the bill is ~280 ms, then
    stealing 300 ms of a future word buys nothing and the idea stops here -- and
    that is the cheapest answer to buy first, because it needs no corpus at all.

CORRECTNESS IS **NOT** MEASURED HERE

    No recall, no retention, no truth rank, no promotion verdict. Every one of
    those needs labelled RU/HE samples (word onset, truth word, baseline STT
    stable time) and not one such sample is recorded yet. Computed over the
    placeholder words and synthetic audio this script sends, they would be noise
    wearing the costume of data -- and a plausible-looking recall number is worse
    than no number, because the next decision would be taken on it.

    So this script refuses to emit them: `_assert_no_correctness_fields` aborts
    the run if a future edit puts such a field in the report.

    Correctness lives, and only lives, in:
      * scripts/acoustic-replay-bench.py            -- replays a labelled manifest
      * agent/src/speakeasy_agent/benchmark_gate.py -- Top-K recall, retention,
        vanished/harmed/demoted rates, PROMOTE / HOLD / REJECT
      * docs/10-acoustic-replay-benchmark.md, docs/11-acoustic-pruning.md

    The other half of the founder's question -- what the machinery SAVES -- is the
    lead over the ordinary STT baseline (`leadP50MsMin` in the gate above). It
    needs `baselineSttStableMs` per sample and therefore lives there too. It
    cannot be computed here and is not estimated here.

WHAT IT DOES MEASURE

    * predictor (:8101)  queue_wait_ms / inference_ms / total_ms as reported by
      the service, plus the client-side HTTP round trip; p50/p90/p95 and n.
    * pruner (:8105)     the same set, once per window in 50/100/150/200/250 ms.
    * critical path      predictor round trip + pruner round trip paid back to
      back by one utterance, summed PER TRIAL and then percentiled. The report
      also prints p50(predictor) + p50(pruner) beside it, because the two are not
      the same number and quoting the sum of medians as "the" cost understates a
      tail that a live call actually pays.
      This pair is a HYPOTHETICAL inline design, not today's agent. Today the
      pruner is not on the critical path: `acoustic_shadow._maybe_start_scoring`
      spawns a background task and `_score` issues ONE /v1/prune PER WINDOW
      (five by default), blocking nothing. So the pair answers "what would an
      inline predict+prune cost", and today's per-attempt pruner spend is the
      pruner column times the number of windows.
    * concurrency        the whole sweep at 1, 2 and 4 in-flight requests. Two GPU
      services share one physical card (gpu/queueing.py), so the queue is real and
      a single-client number describes a machine nobody will ever run.

USAGE (invoke with the pinned interpreter; nothing in the image puts a bare
`python` on PATH -- see docs/RUNPOD_READINESS.md):

    /opt/venvs/think/bin/python scripts/scorer-cost-bench.py --lang ru
    /opt/venvs/think/bin/python scripts/scorer-cost-bench.py --wav clip.wav \\
        --output /workspace/benchmarks/scorer-cost-ru.json
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import struct
import sys
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPO_ROOT = Path(__file__).resolve().parents[1]
AGENT_SRC = REPO_ROOT / "agent" / "src"
if str(AGENT_SRC) not in sys.path:
    sys.path.insert(0, str(AGENT_SRC))

# Only the percentile helper is borrowed from the gate module; the gate itself
# needs the corpus this script does not have. Sharing the function is deliberate:
# scripts/acoustic-replay-bench.py percentiles through the same interpolation, so
# a p95 here and a p95 there mean the same operation on the same kind of list.
from speakeasy_agent.benchmark_gate import percentile  # noqa: E402

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
DEFAULT_WINDOWS = (50, 100, 150, 200, 250)
DEFAULT_IN_FLIGHT = (1, 2, 4)
# DEFAULT_GATE["targetWindowMs"] in agent/src/speakeasy_agent/benchmark_gate.py.
# The critical-path pair is measured at the window the promotion gate judges, so
# the cost number and the future retention number describe the same request.
DEFAULT_CRITICAL_WINDOW_MS = 150
# gpu/acoustic/prune_app.py: PruneRequest.pcm_s16le_b64 is Field(max_length=100000)
# and candidates is Field(max_length=50). Checked here so an over-long window is
# rejected before boot instead of as a 422 storm while the card bills.
PRUNE_B64_MAX_CHARS = 100000
PRUNE_MAX_CANDIDATES = 50
# gpu/predictor/app.py: PredictRequest.top_k is Field(default=20, ge=1, le=50).
# Checked before boot for the same reason as the two pruner limits above: a
# --top-k the server rejects turns every measured request into a 422, and the
# script would otherwise discover that one request at a time while the card
# bills.
PREDICT_MAX_TOP_K = 50

# The founder's stated targets for this machinery. They are targets, not
# measurements: nothing in this repository has measured any of them yet.
TARGET_PREDICTOR_INFERENCE_P50_MS = 50.0
TARGET_PREDICTOR_INFERENCE_P95_MS = 100.0
TARGET_QUEUE_WAIT_P95_MS = 20.0

NOT_MEASURED = "не измерено"

# Same prefixes and context terms as scripts/runpod-stage1-bench.py, so a
# predictor number from this artifact can be laid next to the stage-1 artifact
# without wondering whether the prompt changed underneath it.
PROMPTS: dict[str, dict[str, Any]] = {
    "ru": {
        "prefix": "мне нужно узнать когда будет",
        "context_terms": ["выплата", "платёж", "пенсия", "пособие"],
    },
    "he": {
        "prefix": "אני רוצה לדעת מתי יהיה",
        "context_terms": ["תשלום", "קצבה", "זכאות", "חשבון"],
    },
}

# Substrings that may never appear in a key of the written report. Enforced, not
# promised: see the module docstring for why a recall-shaped number computed on
# this input would be actively harmful.
FORBIDDEN_KEY_TOKENS = (
    "recall",
    "retention",
    "truth",
    "rank",
    "accuracy",
    "correct",
    "promote",
    "demoted",
    "vanished",
    "harmed",
    "wer",
)


# ------------------------------------------------------------------ HTTP -----


def _post_json(url: str, payload: dict[str, Any], timeout_s: float) -> tuple[dict[str, Any], float]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=body, headers={"content-type": "application/json"}, method="POST")
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=timeout_s) as response:
            raw = response.read()
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except (URLError, OSError) as exc:
        raise RuntimeError(f"request failed for {url}: {exc}") from exc
    round_trip_ms = (time.perf_counter() - started) * 1000.0
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"non-JSON response from {url}") from exc
    if not isinstance(decoded, dict):
        raise RuntimeError(f"non-object JSON response from {url}")
    return decoded, round_trip_ms


def _get_json(url: str, timeout_s: float) -> dict[str, Any]:
    try:
        with urlopen(Request(url, method="GET"), timeout=timeout_s) as response:
            decoded = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"health check failed for {url}: {exc}") from exc
    if not isinstance(decoded, dict):
        raise RuntimeError(f"non-object JSON from {url}")
    return decoded


def _endpoint(base: str, path: str) -> str:
    return base.rstrip("/") + path


# ------------------------------------------------------------------ audio ----


def synthetic_pcm(duration_ms: int, tone_hz: int, amplitude: float) -> bytes:
    """Generate the input locally so the first paid session needs no corpus file.

    Content is not what this script measures: the pruner is charged per window of
    audio, and the window length is fixed by the caller. Whether a real voice
    costs measurably more than a tone is `не измерено` -- which is exactly why
    --wav exists, so the same sweep can be re-run on a real clip later and the
    two artifacts compared.
    """
    total_samples = duration_ms * SAMPLE_RATE // 1000
    if total_samples <= 0:
        raise SystemExit("--audio-ms is too small to produce a single sample")
    if tone_hz <= 0:
        return b"\x00\x00" * total_samples
    peak = int(32767 * max(0.0, min(1.0, amplitude)))
    step = 2.0 * math.pi * tone_hz / SAMPLE_RATE
    return struct.pack(
        f"<{total_samples}h",
        *(int(peak * math.sin(step * index)) for index in range(total_samples)),
    )


def load_wav_pcm(path: Path) -> bytes:
    """Same 16 kHz mono s16 contract as scripts/acoustic-pruning-bench.py."""
    try:
        with wave.open(str(path), "rb") as wav:
            channels = wav.getnchannels()
            width = wav.getsampwidth()
            rate = wav.getframerate()
            if channels != 1 or width != BYTES_PER_SAMPLE or rate != SAMPLE_RATE:
                raise SystemExit(
                    f"{path}: expected 16 kHz mono signed-16 PCM WAV; got "
                    f"{rate} Hz, {channels}ch, {width * 8}-bit"
                )
            return wav.readframes(wav.getnframes())
    except (wave.Error, OSError) as exc:
        raise SystemExit(f"{path}: cannot read WAV: {exc}") from exc


def window_slice(pcm: bytes, window_ms: int) -> bytes:
    sample_bytes = min(len(pcm), window_ms * SAMPLE_RATE // 1000 * BYTES_PER_SAMPLE)
    # s16 samples must never be split mid-sample.
    return pcm[: sample_bytes - sample_bytes % BYTES_PER_SAMPLE]


def prepare_audio(args: argparse.Namespace) -> tuple[bytes, dict[str, Any]]:
    """Build or read the input, and refuse an unusable one before the card boots.

    Both refusals below cost nothing and both would otherwise arrive as a 422 in
    the middle of a paid run -- the one class of discovery docs/RUNPOD_READINESS.md
    says must never happen while the GPUs bill.
    """
    if args.wav:
        pcm = load_wav_pcm(args.wav)
        source: dict[str, Any] = {"kind": "wav", "path": str(args.wav)}
    else:
        pcm = synthetic_pcm(args.audio_ms, args.tone_hz, args.tone_amplitude)
        source = {
            "kind": "synthetic",
            "tone_hz": args.tone_hz,
            "amplitude": args.tone_amplitude,
        }
    audio_ms = len(pcm) // BYTES_PER_SAMPLE * 1000 // SAMPLE_RATE
    source["audio_ms"] = audio_ms

    if audio_ms < max(args.windows):
        raise SystemExit(
            f"audio is {audio_ms} ms but the largest window is {max(args.windows)} ms; "
            "supply a longer --wav or raise --audio-ms"
        )
    for window in args.windows:
        encoded = len(base64.b64encode(window_slice(pcm, window)))
        if encoded > PRUNE_B64_MAX_CHARS:
            raise SystemExit(
                f"window {window} ms encodes to {encoded} base64 chars, over the "
                f"{PRUNE_B64_MAX_CHARS} the pruner accepts (gpu/acoustic/prune_app.py)"
            )
    return pcm, source


# ------------------------------------------------------------- statistics ----


def summarize(values: list[float]) -> dict[str, Any]:
    if not values:
        return {
            "n": 0,
            "p50_ms": None,
            "p90_ms": None,
            "p95_ms": None,
            "min_ms": None,
            "max_ms": None,
            "note": NOT_MEASURED,
        }
    return {
        "n": len(values),
        "p50_ms": percentile(values, 0.50),
        "p90_ms": percentile(values, 0.90),
        "p95_ms": percentile(values, 0.95),
        "min_ms": round(min(values), 1),
        "max_ms": round(max(values), 1),
    }


def _numbers(records: list[dict[str, Any]], key: str) -> list[float]:
    out: list[float] = []
    for record in records:
        value = record.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out.append(float(value))
    return out


def phase_summary(records: list[dict[str, Any]], keys: tuple[str, ...]) -> dict[str, Any]:
    ok = [record for record in records if record.get("ok")]
    failed = [record for record in records if not record.get("ok")]
    result: dict[str, Any] = {"requests": len(records), "ok": len(ok), "failed": len(failed)}
    if failed:
        # Failures are named, not averaged away: a phase whose p50 looks great
        # because two thirds of its requests 503'd must not read as a good phase.
        counts: dict[str, int] = {}
        for record in failed:
            message = str(record.get("error", "unknown"))[:200]
            counts[message] = counts.get(message, 0) + 1
        result["errors"] = [
            {"message": message, "count": count}
            for message, count in sorted(counts.items(), key=lambda item: -item[1])[:5]
        ]
    for key in keys:
        values = _numbers(ok, key)
        summary = summarize(values)
        missing = len(ok) - len(values)
        if missing:
            # A field absent from the response is recorded as absent. Substituting
            # 0.0 would publish "the queue was empty" for a service too old to
            # have a queue at all -- the exact mixture gpu/queueing.py exists to
            # keep out of the numbers.
            summary["missing_from_response"] = missing
        result[key] = summary
    return result


SERVICE_KEYS = ("round_trip_ms", "queue_wait_ms", "inference_ms", "total_ms")


# ------------------------------------------------------------- requesting ----


def build_candidates(count: int) -> list[dict[str, Any]]:
    """Placeholder Top-K. The words cannot move the timing this script reports.

    gpu/acoustic/pruner.py re-ranks after the card is released, over <=50 short
    strings; and the scores it produces are never read here, because reading them
    is the correctness question this script refuses to answer.
    """
    probability = round(1.0 / count, 6)
    return [{"word": f"cand{index:02d}", "probability": probability} for index in range(1, count + 1)]


def candidates_from_prediction(response: dict[str, Any], fallback: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Feed the predictor's own Top-K to the pruner, the way a real utterance does.

    Clamped and truncated on the way: PredictResponse.probability is unconstrained
    (gpu/predictor/app.py) while PruneRequest.probability is Field(ge=0, le=1), so
    one out-of-range value would turn a paid timing run into a run of 422s.
    """
    raw = response.get("candidates")
    if not isinstance(raw, list):
        return fallback
    out: list[dict[str, Any]] = []
    for item in raw[:PRUNE_MAX_CANDIDATES]:
        if not isinstance(item, dict):
            continue
        word = item.get("word")
        if not isinstance(word, str) or not word.strip():
            continue
        probability = item.get("probability")
        if not isinstance(probability, (int, float)) or isinstance(probability, bool):
            probability = 0.0
        out.append({"word": word[:128], "probability": max(0.0, min(1.0, float(probability)))})
    return out or fallback


class Bench:
    def __init__(self, args: argparse.Namespace, pcm: bytes) -> None:
        self.args = args
        self.pcm = pcm
        self.candidates = build_candidates(args.candidate_count)
        self.prompt = PROMPTS[args.lang]
        self.window_b64: dict[int, str] = {
            window: base64.b64encode(window_slice(pcm, window)).decode("ascii")
            for window in args.windows
        }

    # -- single requests ----------------------------------------------------

    def predict(self) -> dict[str, Any]:
        payload = {
            "prefix": self.prompt["prefix"],
            "lang": self.args.lang,
            "top_k": self.args.top_k,
            "max_new_tokens": self.args.max_new_tokens,
            "context_terms": self.prompt["context_terms"],
        }
        try:
            response, round_trip_ms = _post_json(
                _endpoint(self.args.predictor_url, "/v1/predict"),
                payload,
                self.args.request_timeout,
            )
        except RuntimeError as exc:
            return {"ok": False, "error": str(exc)}
        record: dict[str, Any] = {"ok": True, "round_trip_ms": round(round_trip_ms, 3)}
        for key in ("queue_wait_ms", "inference_ms", "total_ms", "load_ms"):
            value = response.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                record[key] = float(value)
        record["_response"] = response
        return record

    def prune(self, window_ms: int, candidates: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        payload = {
            "lang": self.args.lang,
            "pcm_s16le_b64": self.window_b64[window_ms],
            "candidates": candidates if candidates is not None else self.candidates,
        }
        try:
            response, round_trip_ms = _post_json(
                _endpoint(self.args.pruner_url, "/v1/prune"),
                payload,
                self.args.request_timeout,
            )
        except RuntimeError as exc:
            return {"ok": False, "error": str(exc)}
        record: dict[str, Any] = {"ok": True, "round_trip_ms": round(round_trip_ms, 3)}
        for key in ("queue_wait_ms", "inference_ms", "total_ms", "model_forward_ms"):
            value = response.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                record[key] = float(value)
        # `ranked` is deliberately dropped on the floor here rather than carried
        # into the report: keeping it would put the correctness question one
        # convenient field away from being answered on placeholder words.
        return record

    def critical_pair(self) -> dict[str, Any]:
        """What an INLINE predict-then-prune would bill one utterance.

        Summed per trial. A sum of two medians is a different number from the
        median of the sums -- the report prints both so the gap is visible instead
        of assumed away.

        Not a measurement of the shipped agent: today the pruner runs off the
        critical path in a background task, once per window (acoustic_shadow.py).
        The caveat block of the report says so next to the numbers.
        """
        prediction = self.predict()
        if not prediction.get("ok"):
            return {"ok": False, "error": f"predictor: {prediction.get('error')}"}
        candidates = candidates_from_prediction(prediction.get("_response", {}), self.candidates)
        pruning = self.prune(self.args.critical_window, candidates)
        if not pruning.get("ok"):
            return {"ok": False, "error": f"pruner: {pruning.get('error')}"}
        predictor_ms = float(prediction["round_trip_ms"])
        pruner_ms = float(pruning["round_trip_ms"])
        return {
            "ok": True,
            "predictor_round_trip_ms": predictor_ms,
            "pruner_round_trip_ms": pruner_ms,
            "sum_round_trip_ms": round(predictor_ms + pruner_ms, 3),
        }


def run_phase(
    call: Callable[[], dict[str, Any]],
    *,
    iterations: int,
    in_flight: int,
) -> list[dict[str, Any]]:
    """Drive one service (or one pair) with `in_flight` requests outstanding.

    Concurrency is what makes the queue numbers mean anything: gpu/queueing.py
    admits one inference at a time per service, so a benchmark that never has two
    requests outstanding measures a machine that will never exist -- and reports
    `queue_wait_ms ~ 0` while doing it.
    """
    if in_flight <= 1:
        return [call() for _ in range(iterations)]
    with ThreadPoolExecutor(max_workers=in_flight) as pool:
        return list(pool.map(lambda _index: call(), range(iterations)))


# --------------------------------------------------------------- verdicts ----


def verdict_row(
    name: str,
    measured: float | None,
    limit_ms: float,
    *,
    vacuous_reason: str | None = None,
) -> dict[str, Any]:
    if measured is None:
        verdict = NOT_MEASURED
    elif vacuous_reason is not None:
        # Not PASS. A check that cannot fail has not been passed, it has been
        # skipped -- the same trap agent/src/speakeasy_agent/benchmark_gate.py
        # documents for a gate that passes vacuously on a boosted candidate.
        verdict = "VACUOUS"
    else:
        verdict = "PASS" if measured <= limit_ms else "FAIL"
    row: dict[str, Any] = {
        "check": name,
        "target_ms": limit_ms,
        "measured_ms": measured,
        "verdict": verdict,
    }
    if vacuous_reason is not None and measured is not None:
        row["note"] = vacuous_reason
    return row


def build_verdicts(
    *,
    in_flight: int,
    predictor: dict[str, Any],
    pruner_critical: dict[str, Any],
    predictor_queue_limit: int | None,
    pruner_queue_limit: int | None,
    queue_split_published: bool,
) -> list[dict[str, Any]]:
    inference = predictor.get("inference_ms", {})
    rows = [
        verdict_row(
            "predictor inference p50",
            inference.get("p50_ms"),
            TARGET_PREDICTOR_INFERENCE_P50_MS,
        ),
        verdict_row(
            "predictor inference p95",
            inference.get("p95_ms"),
            TARGET_PREDICTOR_INFERENCE_P95_MS,
        ),
    ]
    for label, phase, limit in (
        ("predictor queue wait p95", predictor, predictor_queue_limit),
        ("pruner queue wait p95", pruner_critical, pruner_queue_limit),
    ):
        measured = phase.get("queue_wait_ms", {}).get("p95_ms")
        if not queue_split_published:
            rows.append(
                {
                    "check": label,
                    "target_ms": TARGET_QUEUE_WAIT_P95_MS,
                    "measured_ms": None,
                    "verdict": NOT_MEASURED,
                    "note": (
                        "/healthz published no gpu_concurrency, so this build predates "
                        "gpu/queueing.py and any queue_wait_ms it reports is ~0 by construction"
                    ),
                }
            )
            continue
        reason = None
        if limit is not None and in_flight <= limit:
            reason = (
                f"{in_flight} in flight against gpu_concurrency={limit}: nothing can queue, "
                "so this check cannot fail here"
            )
        rows.append(verdict_row(label, measured, TARGET_QUEUE_WAIT_P95_MS, vacuous_reason=reason))
    return rows


# ----------------------------------------------------------------- report ----


def _forbidden_token(key: Any) -> str | None:
    flat = "".join(character for character in str(key).lower() if character.isalnum())
    return next((token for token in FORBIDDEN_KEY_TOKENS if token in flat), None)


def _assert_no_correctness_fields(node: Any, path: str = "report") -> None:
    """Refuse to write a correctness-shaped field, rather than merely intend to.

    The corpus does not exist yet (docs/10-acoustic-replay-benchmark.md describes
    the manifest that would have to be recorded first), so any such field here
    would be computed over placeholder words and a synthetic tone.

    Applies to the fields THIS script authors. The two verbatim service replies
    are handled by `_strip_service_fields` instead: see there for why an abort is
    the wrong answer to a name somebody else chose.
    """
    if isinstance(node, dict):
        for key, value in node.items():
            token = _forbidden_token(key)
            if token is not None:
                raise RuntimeError(
                    f"{path}.{key}: this benchmark must not publish a correctness field "
                    f"(matched {token!r}). Correctness is measured by "
                    f"scripts/acoustic-replay-bench.py on a labelled manifest."
                )
            _assert_no_correctness_fields(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _assert_no_correctness_fields(value, f"{path}[{index}]")


def _strip_service_fields(node: Any, path: str, dropped: list[str]) -> Any:
    """Drop a forbidden-looking key out of a VERBATIM service reply, don't abort.

    `health` and `warmup` carry `/healthz` and `/v1/warmup` bodies word for word,
    and their key names belong to the services, not to this script. The token
    list matches on substrings, so ordinary GPU-service fields collide with it by
    accident: `rank` is the torch distributed rank, and any `power_*` field
    contains "wer". Raising on those would kill the run with a traceback AFTER
    the warmup has already pulled the weights onto a billing card -- the exact
    class of paid-time discovery docs/RUNPOD_READINESS.md says must not happen.
    The published artifact still contains no correctness-shaped key: the field is
    removed and named in `report.dropped_service_fields` so nothing vanishes
    silently.
    """
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for key, value in node.items():
            if _forbidden_token(key) is not None:
                dropped.append(f"{path}.{key}")
                continue
            out[key] = _strip_service_fields(value, f"{path}.{key}", dropped)
        return out
    if isinstance(node, list):
        return [
            _strip_service_fields(value, f"{path}[{index}]", dropped)
            for index, value in enumerate(node)
        ]
    return node


def write_report(path: Path, report: dict[str, Any]) -> None:
    dropped: list[str] = []
    for section in ("health", "warmup"):
        if section in report:
            report[section] = _strip_service_fields(report[section], section, dropped)
    if dropped:
        report["dropped_service_fields"] = {
            "paths": dropped,
            "reason": (
                "a key of a verbatim /healthz or /v1/warmup reply matched the "
                "correctness-field token list; it was removed from this artifact rather "
                "than published or allowed to abort a paid run"
            ),
        }
    _assert_no_correctness_fields(report)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- printing ---


def fmt_ms(value: float | None) -> str:
    return f"{NOT_MEASURED:>12}" if value is None else f"{value:12.1f}"


def print_distribution(label: str, summary: dict[str, Any]) -> None:
    print(
        f"    {label:<24} n={summary.get('n', 0):<4}"
        f" p50={fmt_ms(summary.get('p50_ms'))}"
        f" p90={fmt_ms(summary.get('p90_ms'))}"
        f" p95={fmt_ms(summary.get('p95_ms'))}"
        f" max={fmt_ms(summary.get('max_ms'))}",
        flush=True,
    )


def print_phase(title: str, phase: dict[str, Any]) -> None:
    failed = phase.get("failed", 0)
    suffix = f"  ({failed} FAILED request(s))" if failed else ""
    print(f"  {title}{suffix}", flush=True)
    for key in SERVICE_KEYS:
        if key in phase:
            print_distribution(key, phase[key])
    for error in phase.get("errors", []):
        print(f"      error x{error['count']}: {error['message']}", flush=True)


def print_verdicts(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        measured = row.get("measured_ms")
        measured_text = NOT_MEASURED if measured is None else f"{measured:.1f} ms"
        print(
            f"  {row['verdict']:<12} {row['check']:<26}"
            f" target <= {row['target_ms']:.0f} ms | measured {measured_text}",
            flush=True,
        )
        if row.get("note"):
            print(f"      {row['note']}", flush=True)


# -------------------------------------------------------------------- main ---


def parse_int_list(raw: str, *, what: str) -> tuple[int, ...]:
    values: list[int] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            value = int(chunk)
        except ValueError:
            raise SystemExit(f"{what}: {chunk!r} is not an integer") from None
        if value < 1:
            raise SystemExit(f"{what}: values must be >= 1, got {value}")
        values.append(value)
    if not values:
        raise SystemExit(f"{what}: no values given")
    return tuple(sorted(dict.fromkeys(values)))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Cost-only latency benchmark for the predictor + acoustic pruner. "
            "Measures what the machinery costs; measures NO correctness metric "
            "(recall/retention need a labelled corpus -- see "
            "scripts/acoustic-replay-bench.py)."
        )
    )
    parser.add_argument(
        "--predictor-url",
        default=os.getenv("PREDICTOR_URL", "http://127.0.0.1:8101"),
    )
    parser.add_argument(
        "--pruner-url",
        default=os.getenv("ACOUSTIC_PRUNER_URL", "http://127.0.0.1:8105"),
    )
    parser.add_argument("--lang", choices=("ru", "he"), default="ru")
    parser.add_argument(
        "--iterations",
        type=int,
        default=30,
        help="requests per phase per concurrency level (default 30)",
    )
    parser.add_argument(
        "--warmup-iterations",
        type=int,
        default=3,
        help="requests discarded before measuring, per service (default 3)",
    )
    parser.add_argument(
        "--in-flight",
        default=",".join(str(value) for value in DEFAULT_IN_FLIGHT),
        help="concurrency levels to sweep (default 1,2,4)",
    )
    parser.add_argument(
        "--windows",
        default=",".join(str(value) for value in DEFAULT_WINDOWS),
        help="pruner windows in ms from word onset (default 50,100,150,200,250)",
    )
    parser.add_argument(
        "--critical-window",
        type=int,
        default=DEFAULT_CRITICAL_WINDOW_MS,
        help="window used for the predictor+pruner critical-path pair (default 150)",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=20,
        help=f"predictor top_k, 1..{PREDICT_MAX_TOP_K} (server limit; default 20)",
    )
    parser.add_argument(
        "--max-new-tokens",
        type=int,
        default=6,
        help="predictor max_new_tokens, 2..12 (server limit; default 6). "
        "Cost lever independent of --top-k: beam WIDTH scales with top_k, "
        "but generation runs max_new_tokens sequential forward passes "
        "regardless of how many candidates are requested.",
    )
    parser.add_argument(
        "--candidate-count",
        type=int,
        default=20,
        help="placeholder candidates sent to the pruner (default 20)",
    )
    parser.add_argument(
        "--wav",
        type=Path,
        help="16 kHz mono s16 WAV to use instead of synthetic audio",
    )
    parser.add_argument(
        "--audio-ms",
        type=int,
        default=1000,
        help="synthetic audio length in ms (default 1000)",
    )
    parser.add_argument(
        "--tone-hz",
        type=int,
        default=440,
        help="synthetic tone frequency; 0 generates silence (default 440)",
    )
    parser.add_argument(
        "--tone-amplitude",
        type=float,
        default=0.2,
        help="synthetic tone amplitude, 0..1 of full scale (default 0.2)",
    )
    parser.add_argument("--request-timeout", type=float, default=30.0)
    parser.add_argument("--warmup-timeout", type=float, default=600.0)
    parser.add_argument(
        "--output",
        type=Path,
        help="JSON report path (default $BENCHMARK_DIR/scorer-cost-<stamp>.json, "
        "which is the tree scripts/runpod-export.sh copies off the Pod)",
    )
    parser.add_argument("--print-json", action="store_true")
    parser.add_argument(
        "--fail-on-target-miss",
        action="store_true",
        help="exit non-zero when a non-vacuous target FAILs (default: a miss is a "
        "result, not a script error, and exits 0)",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    args.windows = parse_int_list(args.windows, what="--windows")
    args.in_flight = parse_int_list(args.in_flight, what="--in-flight")

    if args.iterations < 1:
        raise SystemExit("--iterations must be >= 1")
    if args.warmup_iterations < 0:
        raise SystemExit("--warmup-iterations must be >= 0")
    if not 1 <= args.candidate_count <= PRUNE_MAX_CANDIDATES:
        raise SystemExit(f"--candidate-count must be 1..{PRUNE_MAX_CANDIDATES} (server limit)")
    if not 2 <= args.max_new_tokens <= 12:
        parser.error("--max-new-tokens must be within 2..12 (server limit)")
    if not 1 <= args.top_k <= PREDICT_MAX_TOP_K:
        raise SystemExit(f"--top-k must be 1..{PREDICT_MAX_TOP_K} (server limit)")
    if args.critical_window not in args.windows:
        raise SystemExit("--critical-window must be one of --windows")

    pcm, source = prepare_audio(args)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = args.output or (
        Path(os.getenv("BENCHMARK_DIR", "/workspace/benchmarks")) / f"scorer-cost-{stamp}.json"
    )

    bench = Bench(args, pcm)

    print("SameVoice scorer cost benchmark (cost only -- no correctness metric)", flush=True)
    print(f"  lang={args.lang} iterations={args.iterations} in-flight={list(args.in_flight)}", flush=True)
    print(f"  audio: {source}", flush=True)
    print(f"  output: {output}", flush=True)

    # Health first: a latency number nobody can attribute to a checkpoint and a
    # concurrency limit is worth very little afterwards. scripts/runpod-export.sh
    # takes the same snapshot for the same reason.
    health: dict[str, Any] = {}
    for name, url in (("predictor", args.predictor_url), ("pruner", args.pruner_url)):
        try:
            health[name] = _get_json(_endpoint(url, "/healthz"), 15.0)
        except RuntimeError as exc:
            print(f"FATAL: {exc}", flush=True)
            return 2

    predictor_queue_limit = health["predictor"].get("gpu_concurrency")
    pruner_queue_limit = health["pruner"].get("gpu_concurrency")
    queue_split_published = isinstance(predictor_queue_limit, int) and isinstance(
        pruner_queue_limit, int
    )

    warmup: dict[str, Any] = {}
    try:
        predictor_warm, predictor_warm_ms = _post_json(
            _endpoint(args.predictor_url, "/v1/warmup"), {}, args.warmup_timeout
        )
        pruner_warm, pruner_warm_ms = _post_json(
            _endpoint(args.pruner_url, "/v1/warmup"), {"lang": args.lang}, args.warmup_timeout
        )
    except RuntimeError as exc:
        print(f"FATAL: warmup failed: {exc}", flush=True)
        return 2
    warmup["predictor"] = {"round_trip_ms": round(predictor_warm_ms, 1), "response": predictor_warm}
    warmup["pruner"] = {"round_trip_ms": round(pruner_warm_ms, 1), "response": pruner_warm}

    # /v1/warmup only loads weights (PredictorEngine.warmup -> _load, and the
    # pruner's engine.load). It never runs a beam search or a CTC forward pass, so
    # without these discarded requests the first measured call would carry a
    # one-off cost straight into p50 and p95.
    discarded = {"predictor_round_trip_ms": [], "pruner_round_trip_ms": []}
    for _ in range(args.warmup_iterations):
        record = bench.predict()
        if record.get("ok"):
            discarded["predictor_round_trip_ms"].append(record["round_trip_ms"])
        record = bench.prune(args.critical_window)
        if record.get("ok"):
            discarded["pruner_round_trip_ms"].append(record["round_trip_ms"])
    warmup["discarded_iterations"] = args.warmup_iterations
    warmup["discarded"] = discarded

    caveats = [
        "Correctness is not measured here. No recall, retention or rank number exists "
        "in this artifact; those need the labelled manifest of "
        "docs/10-acoustic-replay-benchmark.md and are produced by "
        "scripts/acoustic-replay-bench.py.",
        "The critical-path pair is a HYPOTHETICAL inline design, not a measurement of "
        "today's agent. Today the pruner is not on the critical path at all: "
        "acoustic_shadow.py:_maybe_start_scoring spawns a background task and "
        "_score loops over ACOUSTIC_PRUNER_SHADOW_WINDOWS_MS, so one scored attempt "
        "costs ONE /v1/prune PER WINDOW (five by default, "
        "docker/runpod-gpu.env.example:65) and blocks nothing. Read the pair below as "
        "'what one predict + one prune would cost if the pruner were moved onto the "
        "path', and multiply the pruner column by the number of windows for what the "
        "shadow actually spends per attempt today.",
        "The predictor and the pruner are pinned to the same physical card. In the "
        "per-service phases only one of them is driven at a time; in the critical-path "
        "phase both are, so at 2+ in flight those numbers describe the pair, not either "
        "service alone (gpu/queueing.py).",
        "Round trips are loopback, measured from inside the Pod. They contain no "
        "wide-area network time and are not an end-user latency.",
    ]
    if source["kind"] == "synthetic":
        caveats.append(
            "Audio is synthetic. Whether real speech costs the pruner measurably more "
            f"per window is {NOT_MEASURED}; re-run with --wav to find out."
        )
    if args.iterations <= 20:
        caveats.append(
            f"n={args.iterations} per phase: p95 interpolates between the two largest "
            "samples, so read it as 'near the maximum observed', not as a tail estimate."
        )
    if queue_split_published:
        for name, limit in (("predictor", predictor_queue_limit), ("pruner", pruner_queue_limit)):
            if isinstance(limit, int) and limit > 1:
                caveats.append(
                    f"{name} runs with gpu_concurrency={limit}: two forward passes can "
                    "interleave on the card, so its inference_ms is no longer readable as "
                    "physical time on the GPU (gpu/queueing.py)."
                )

    report: dict[str, Any] = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "script": "scripts/scorer-cost-bench.py",
        "question": (
            "Cost only: what does the prediction+pruning machinery charge one utterance "
            "on the critical path? The saving half of the question (lead over baseline "
            "STT) needs a labelled corpus and is not answered here."
        ),
        "not_measured_here": {
            "metrics": ["recall", "retention", "rank movement", "promotion verdict", "STT lead"],
            "reason": (
                "no labelled corpus exists yet; on placeholder words and synthetic audio "
                "such numbers would be noise formatted as data"
            ),
            "measured_instead_by": [
                "scripts/acoustic-replay-bench.py",
                "agent/src/speakeasy_agent/benchmark_gate.py",
                "docs/10-acoustic-replay-benchmark.md",
            ],
        },
        "config": {
            "lang": args.lang,
            "iterations": args.iterations,
            "in_flight_levels": list(args.in_flight),
            "windows_ms": list(args.windows),
            "critical_window_ms": args.critical_window,
            "top_k": args.top_k,
            "max_new_tokens": args.max_new_tokens,
            "candidate_count": args.candidate_count,
            "predictor_url": args.predictor_url,
            "pruner_url": args.pruner_url,
            "audio": source,
        },
        "targets": {
            "predictor_inference_p50_ms_max": TARGET_PREDICTOR_INFERENCE_P50_MS,
            "predictor_inference_p95_ms_max": TARGET_PREDICTOR_INFERENCE_P95_MS,
            "queue_wait_p95_ms_max": TARGET_QUEUE_WAIT_P95_MS,
            "source": "founder's stated targets for the first paid session; not measurements",
        },
        "health": health,
        "warmup": warmup,
        "levels": [],
        "caveats": caveats,
    }

    # Written after every level, not once at the end: the card bills while this
    # runs, and a run that dies at 4 in flight must still leave the 1-in-flight
    # numbers on disk. docs/RUNPOD_READINESS.md raises the same complaint against
    # scripts/runpod-stage1-bench.py.
    write_report(output, report)

    all_verdicts: list[dict[str, Any]] = []
    measured_anything = False

    for in_flight in args.in_flight:
        level = run_level(
            bench,
            in_flight=in_flight,
            predictor_queue_limit=predictor_queue_limit if queue_split_published else None,
            pruner_queue_limit=pruner_queue_limit if queue_split_published else None,
            queue_split_published=queue_split_published,
        )
        all_verdicts.extend(level["verdicts"])
        if level["predictor"]["ok"] or any(phase["ok"] for phase in level["pruner_windows"]):
            measured_anything = True
        report["levels"].append(level)
        write_report(output, report)

    print("", flush=True)
    print("=== target checks, every level ===", flush=True)
    for in_flight in args.in_flight:
        print(f"  [{in_flight} in flight]", flush=True)
        print_verdicts([row for row in all_verdicts if row["in_flight"] == in_flight])
    # No single overall verdict on purpose. The targets were stated without a load
    # figure, and choosing one here -- PASS from the idle run, or FAIL from the
    # contended one -- would be inventing the half of the target the founder did
    # not state.
    print("", flush=True)
    print(
        "Correctness (recall/retention/rank) is absent from this artifact by design: "
        "no labelled corpus exists yet. It is measured by scripts/acoustic-replay-bench.py.",
        flush=True,
    )
    print(f"saved: {output}", flush=True)

    if args.print_json:
        print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)

    if not measured_anything:
        print("FATAL: every request failed; nothing was measured.", flush=True)
        return 2
    if args.fail_on_target_miss and any(row["verdict"] == "FAIL" for row in all_verdicts):
        return 1
    return 0


def run_level(
    bench: Bench,
    *,
    in_flight: int,
    predictor_queue_limit: int | None,
    pruner_queue_limit: int | None,
    queue_split_published: bool,
) -> dict[str, Any]:
    """One concurrency level: predictor alone, pruner per window, then the pair.

    The order matters for what the numbers mean. The first two phases drive one
    service at a time, so their queue_wait_ms is that service's own admission
    control. The critical-path phase drives both, and gpu/queueing.py is explicit
    that its semaphore lives inside one process: predictor and pruner forward
    passes still overlap on GPU 0 there, so at 2+ in flight that phase measures
    the pair rather than either service.
    """
    args = bench.args
    print("", flush=True)
    print(f"=== {in_flight} in flight ===", flush=True)
    level: dict[str, Any] = {"in_flight": in_flight}

    predictor_records = run_phase(bench.predict, iterations=args.iterations, in_flight=in_flight)
    predictor_phase = phase_summary(predictor_records, SERVICE_KEYS)
    late_loads = sum(
        1
        for record in predictor_records
        if record.get("ok") and float(record.get("load_ms", 0.0)) > 0.0
    )
    if late_loads:
        # load_ms > 0 after warmup means weights were loaded inside a measured
        # request, so that request's inference_ms is a model load and not an
        # inference. Counted rather than dropped: the reader decides.
        predictor_phase["requests_that_loaded_weights"] = late_loads
    level["predictor"] = predictor_phase
    print_phase("predictor /v1/predict", predictor_phase)

    level["pruner_windows"] = []
    for window in args.windows:
        records = run_phase(
            lambda window_ms=window: bench.prune(window_ms),
            iterations=args.iterations,
            in_flight=in_flight,
        )
        window_phase = phase_summary(records, SERVICE_KEYS)
        window_phase["window_ms"] = window
        level["pruner_windows"].append(window_phase)
        print_phase(f"pruner /v1/prune +{window} ms", window_phase)

    critical_records = run_phase(
        bench.critical_pair, iterations=args.iterations, in_flight=in_flight
    )
    critical = phase_summary(
        critical_records,
        ("predictor_round_trip_ms", "pruner_round_trip_ms", "sum_round_trip_ms"),
    )
    critical["window_ms"] = args.critical_window
    p50_predictor = critical["predictor_round_trip_ms"].get("p50_ms")
    p50_pruner = critical["pruner_round_trip_ms"].get("p50_ms")
    if p50_predictor is not None and p50_pruner is not None:
        # Published beside the measured distribution, not instead of it. Quoting
        # p50(predictor) + p50(pruner) as the utterance's bill assumes the two
        # slow requests never land in the same utterance, which is exactly what a
        # shared card makes likely.
        critical["sum_of_the_two_p50s_ms"] = round(p50_predictor + p50_pruner, 1)
        p50_of_sum = critical["sum_round_trip_ms"].get("p50_ms")
        if p50_of_sum is not None:
            critical["p50_of_sum_minus_sum_of_p50s_ms"] = round(
                p50_of_sum - critical["sum_of_the_two_p50s_ms"], 1
            )
    level["critical_path"] = critical

    print(f"  critical path (predictor + pruner +{args.critical_window} ms, per trial)", flush=True)
    for key in ("predictor_round_trip_ms", "pruner_round_trip_ms", "sum_round_trip_ms"):
        print_distribution(key, critical[key])
    if "sum_of_the_two_p50s_ms" in critical:
        measured_p50 = fmt_ms(critical["sum_round_trip_ms"].get("p50_ms")).strip()
        print(
            f"    sum of the two p50s      {critical['sum_of_the_two_p50s_ms']:.1f} ms"
            f"   (p50 of the measured sums: {measured_p50} ms)",
            flush=True,
        )
    for error in critical.get("errors", []):
        print(f"      error x{error['count']}: {error['message']}", flush=True)

    pruner_critical = next(
        (
            phase
            for phase in level["pruner_windows"]
            if phase.get("window_ms") == args.critical_window
        ),
        {},
    )
    verdicts = build_verdicts(
        in_flight=in_flight,
        predictor=predictor_phase,
        pruner_critical=pruner_critical,
        predictor_queue_limit=predictor_queue_limit,
        pruner_queue_limit=pruner_queue_limit,
        queue_split_published=queue_split_published,
    )
    for row in verdicts:
        row["in_flight"] = in_flight
    level["verdicts"] = verdicts
    print("", flush=True)
    print_verdicts(verdicts)
    return level


if __name__ == "__main__":
    raise SystemExit(main())
