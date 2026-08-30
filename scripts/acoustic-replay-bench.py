#!/usr/bin/env python3
"""Replay labelled RU/HE next-word examples through predictor + acoustic pruner.

This is the measurement harness for the rolling-speculation hypothesis. It does
not alter call routing or audible output.

Manifest format (JSON object with `samples` or a bare JSON list):

  {
    "samples": [
      {
        "id": "ru-001",
        "lang": "ru",
        "wav": "audio/ru-001.wav",
        "prefix": "я завтра хочу",
        "truth": "купить",
        "wordStartMs": 812.0,
        "baselineSttStableMs": 610.0,
        "predictorReadyMsFromWordOnset": -180.0
      }
    ]
  }

`wordStartMs` is measured from WAV start. `baselineSttStableMs` is measured from
word onset until ordinary STT first has the correct word stably available.
`predictorReadyMsFromWordOnset` is optional: negative means predictor candidates
were already ready before physical word onset; positive means they arrived after
onset. When absent, the report still includes a conservative cold-parallel lead
that assumes predictor starts exactly at word onset.

WAV requirements: mono, 16 kHz, signed 16-bit PCM.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
AGENT_SRC = REPO_ROOT / "agent" / "src"
if str(AGENT_SRC) not in sys.path:
    sys.path.insert(0, str(AGENT_SRC))

from speakeasy_agent.benchmark_gate import (  # noqa: E402
    DEFAULT_GATE,
    LANGS,
    evaluate_promotion_gate,
    summarize_replay,
)

SAMPLE_RATE = 16000
BYTES_PER_SAMPLE = 2
DEFAULT_WINDOWS = (50, 100, 150, 200, 250)


def _post_json(url: str, payload: dict[str, Any], timeout_s: float) -> tuple[dict[str, Any], float]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"request failed for {url}: {exc}") from exc
    round_trip_ms = (time.perf_counter() - started) * 1000.0
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"non-JSON response from {url}") from exc
    if not isinstance(decoded, dict):
        raise RuntimeError(f"non-object JSON response from {url}")
    return decoded, round_trip_ms


def _load_manifest(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        payload = payload.get("samples")
    if not isinstance(payload, list):
        raise SystemExit("manifest must be a JSON list or {\"samples\":[...]}")
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(payload, start=1):
        if not isinstance(raw, dict):
            raise SystemExit(f"manifest sample {index}: expected object")
        item = dict(raw)
        sample_id = str(item.get("id") or f"sample-{index:04d}")
        if sample_id in seen:
            raise SystemExit(f"manifest: duplicate id {sample_id!r}")
        seen.add(sample_id)
        lang = str(item.get("lang") or "")
        if lang not in ("ru", "he"):
            raise SystemExit(f"{sample_id}: lang must be ru or he")
        for key in ("wav", "prefix", "truth"):
            if not isinstance(item.get(key), str) or not str(item[key]).strip():
                raise SystemExit(f"{sample_id}: missing non-empty {key}")
        onset = item.get("wordStartMs")
        if not isinstance(onset, (int, float)) or float(onset) < 0:
            raise SystemExit(f"{sample_id}: wordStartMs must be >= 0")
        baseline = item.get("baselineSttStableMs")
        if baseline is not None and (not isinstance(baseline, (int, float)) or float(baseline) <= 0):
            raise SystemExit(f"{sample_id}: baselineSttStableMs must be > 0 when supplied")
        ready = item.get("predictorReadyMsFromWordOnset")
        if ready is not None and not isinstance(ready, (int, float)):
            raise SystemExit(f"{sample_id}: predictorReadyMsFromWordOnset must be numeric")
        # contextTerms is a SCORE BOOST, not a topic label: collapse_candidates in
        # gpu/predictor/text.py adds context_boost to any candidate whose normalized
        # form appears here. Putting the truth word in it lifts the truth before any
        # acoustics run -- conditionalRetention.top3 goes to 1.0 and demotedBelowRate
        # to 0 whatever the pruner did, so conditionalTop3RetentionMin passes
        # vacuously and a "trap" sample stops being a trap. The rule was documented
        # in eval/corpus/he-recording-script.md but nothing enforced it, which is the
        # same silent-vacuity failure this benchmark exists to avoid.
        terms = item.get("contextTerms")
        if terms is not None:
            if not isinstance(terms, list) or not all(isinstance(t, str) for t in terms):
                raise SystemExit(f"{sample_id}: contextTerms must be a list of strings")
            truth_key = str(item["truth"]).strip().casefold()
            clash = [t for t in terms if t.strip().casefold() == truth_key]
            if clash:
                raise SystemExit(
                    f"{sample_id}: contextTerms must not contain the truth word "
                    f"({clash[0]!r}); it would boost the answer before acoustics and "
                    f"make the retention gate vacuous"
                )
        item["id"] = sample_id
        rows.append(item)
    if not rows:
        raise SystemExit("manifest contains no samples")
    return rows


def _load_pcm(path: Path) -> bytes:
    try:
        with wave.open(str(path), "rb") as wav:
            channels = wav.getnchannels()
            width = wav.getsampwidth()
            rate = wav.getframerate()
            if channels != 1 or width != 2 or rate != SAMPLE_RATE:
                raise RuntimeError(
                    f"expected 16 kHz mono s16 PCM; got {rate} Hz, {channels}ch, {width * 8}-bit"
                )
            return wav.readframes(wav.getnframes())
    except (wave.Error, OSError) as exc:
        raise RuntimeError(f"cannot read WAV: {exc}") from exc


def _word_key(value: str) -> str:
    return value.strip().casefold()


def _opt_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _truth_rank(items: Any, truth: str) -> int | None:
    if not isinstance(items, list):
        return None
    wanted = _word_key(truth)
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        word = item.get("word")
        if isinstance(word, str) and _word_key(word) == wanted:
            rank = item.get("rank")
            return int(rank) if isinstance(rank, int) else index
    return None


def _predict(
    *,
    url: str,
    prefix: str,
    lang: str,
    top_k: int,
    context_terms: list[str],
    timeout_s: float,
) -> tuple[dict[str, Any], float]:
    endpoint = url.rstrip("/")
    if not endpoint.endswith("/v1/predict"):
        endpoint += "/v1/predict"
    return _post_json(
        endpoint,
        {
            "prefix": prefix,
            "lang": lang,
            "top_k": top_k,
            "context_terms": context_terms,
            "max_new_tokens": 6,
        },
        timeout_s,
    )


def _prune(
    *,
    url: str,
    lang: str,
    pcm: bytes,
    candidates: list[dict[str, Any]],
    timeout_s: float,
) -> tuple[dict[str, Any], float]:
    endpoint = url.rstrip("/")
    if not endpoint.endswith("/v1/prune"):
        endpoint += "/v1/prune"
    return _post_json(
        endpoint,
        {
            "lang": lang,
            "pcm_s16le_b64": base64.b64encode(pcm).decode("ascii"),
            "candidates": candidates,
        },
        timeout_s,
    )


def _resolve_wav(raw: str, *, manifest: Path, dataset_root: Path | None) -> Path:
    candidate = Path(raw).expanduser()
    if candidate.is_absolute():
        return candidate
    base = dataset_root if dataset_root is not None else manifest.parent
    return (base / candidate).resolve()


def _parse_windows(raw: str) -> tuple[int, ...]:
    values: set[int] = set()
    for piece in raw.split(","):
        piece = piece.strip()
        if not piece:
            continue
        try:
            value = int(piece)
        except ValueError as exc:
            raise SystemExit(f"invalid window {piece!r}") from exc
        if value <= 0 or value > 1000:
            raise SystemExit("windows must be between 1 and 1000 ms")
        values.add(value)
    return tuple(sorted(values)) or DEFAULT_WINDOWS


def _load_gate(path: Path | None) -> dict[str, Any]:
    if path is None:
        return dict(DEFAULT_GATE)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit("gate config must be a JSON object")
    merged = dict(DEFAULT_GATE)
    for key, value in payload.items():
        if key not in merged:
            raise SystemExit(f"unknown gate setting: {key}")
        merged[key] = value
    return merged


def _run_sample(
    sample: dict[str, Any],
    *,
    manifest: Path,
    dataset_root: Path | None,
    predictor_url: str,
    pruner_url: str,
    windows: tuple[int, ...],
    top_k: int,
    timeout_s: float,
) -> dict[str, Any]:
    sample_id = str(sample["id"])
    lang = str(sample["lang"])
    truth = str(sample["truth"]).strip()
    prefix = str(sample["prefix"]).strip()
    wav_path = _resolve_wav(str(sample["wav"]), manifest=manifest, dataset_root=dataset_root)
    result: dict[str, Any] = {
        "id": sample_id,
        "lang": lang,
        "truth": truth,
        "prefix": prefix,
        "wav": str(wav_path),
        "wordStartMs": float(sample["wordStartMs"]),
        "baselineSttStableMs": (
            float(sample["baselineSttStableMs"])
            if isinstance(sample.get("baselineSttStableMs"), (int, float))
            else None
        ),
        "predictorReadyMsFromWordOnset": (
            float(sample["predictorReadyMsFromWordOnset"])
            if isinstance(sample.get("predictorReadyMsFromWordOnset"), (int, float))
            else None
        ),
        "predictor": {},
        "windows": [],
    }

    try:
        pcm = _load_pcm(wav_path)
    except Exception as exc:
        result["error"] = f"wav: {exc}"
        return result

    context_terms_raw = sample.get("contextTerms")
    context_terms = (
        [str(value) for value in context_terms_raw if str(value).strip()]
        if isinstance(context_terms_raw, list)
        else []
    )

    try:
        prediction, predictor_rtt = _predict(
            url=predictor_url,
            prefix=prefix,
            lang=lang,
            top_k=top_k,
            context_terms=context_terms,
            timeout_s=timeout_s,
        )
    except Exception as exc:
        result["predictor"] = {"error": str(exc)}
        return result

    raw_candidates = prediction.get("candidates")
    candidates: list[dict[str, Any]] = []
    if isinstance(raw_candidates, list):
        for item in raw_candidates:
            if not isinstance(item, dict) or not isinstance(item.get("word"), str):
                continue
            probability = item.get("probability")
            candidates.append(
                {
                    "word": str(item["word"]),
                    "probability": float(probability) if isinstance(probability, (int, float)) else 0.0,
                }
            )
    predictor_rank = _truth_rank(candidates, truth)
    result["predictor"] = {
        "model": str(prediction.get("model") or ""),
        "truthRank": predictor_rank,
        "candidateCount": len(candidates),
        "roundTripMs": round(predictor_rtt, 1),
        "modelLatencyMs": (
            round(float(prediction["latency_ms"]), 1)
            if isinstance(prediction.get("latency_ms"), (int, float))
            else None
        ),
        "top20": candidates[:20],
    }
    if not candidates:
        result["predictor"]["error"] = "predictor returned no candidates"
        return result

    onset_samples = int(round(float(sample["wordStartMs"]) * SAMPLE_RATE / 1000.0))
    onset_bytes = onset_samples * BYTES_PER_SAMPLE
    if onset_bytes >= len(pcm):
        result["error"] = "wordStartMs is beyond WAV duration"
        return result

    baseline = result["baselineSttStableMs"]
    ready_offset = result["predictorReadyMsFromWordOnset"]

    for window_ms in windows:
        byte_count = window_ms * SAMPLE_RATE // 1000 * BYTES_PER_SAMPLE
        end = onset_bytes + byte_count
        row: dict[str, Any] = {"windowMs": window_ms}
        if end > len(pcm):
            row["error"] = "audio shorter than requested word-onset window"
            result["windows"].append(row)
            continue
        window_pcm = pcm[onset_bytes:end]
        try:
            pruned, pruner_rtt = _prune(
                url=pruner_url,
                lang=lang,
                pcm=window_pcm,
                candidates=candidates,
                timeout_s=timeout_s,
            )
        except Exception as exc:
            row["error"] = str(exc)
            result["windows"].append(row)
            continue

        ranked = pruned.get("ranked") if isinstance(pruned.get("ranked"), list) else []
        truth_rank = _truth_rank(ranked, truth)
        # `model_forward_ms` is the forward-only number this column has always
        # carried. The service still publishes `inference_ms`, but widened it to
        # the whole section held under the GPU semaphore, so reading that key
        # here would change what `inferenceMs` means without changing its name
        # and make new artifacts look comparable to old ones. Older servers send
        # only `inference_ms`; the fallback keeps them readable.
        inference_ms = _opt_float(pruned.get("model_forward_ms"))
        if inference_ms is None:
            inference_ms = _opt_float(pruned.get("inference_ms"))
        # The queue/model split, recorded per window. A service that computes it
        # and an artifact that drops it leave the gate exactly where it was.
        queue_wait_ms = _opt_float(pruned.get("queue_wait_ms"))
        service_total_ms = _opt_float(pruned.get("total_ms"))
        component_ready_ms = window_ms + pruner_rtt
        cold_parallel_ready_ms = max(float(window_ms), predictor_rtt) + pruner_rtt
        observed_ready_ms = None
        if isinstance(ready_offset, (int, float)):
            # The scorer cannot start until both early audio and candidates exist.
            observed_ready_ms = max(float(window_ms), float(ready_offset)) + pruner_rtt

        row.update(
            {
                "truthRank": truth_rank,
                "evidence": pruned.get("evidence"),
                "rawEvidence": pruned.get("raw_evidence"),
                "inferenceMs": round(inference_ms, 1) if inference_ms is not None else None,
                "queueWaitMs": round(queue_wait_ms, 1) if queue_wait_ms is not None else None,
                "serviceTotalMs": (
                    round(service_total_ms, 1) if service_total_ms is not None else None
                ),
                "roundTripMs": round(pruner_rtt, 1),
                "componentReadyAfterWordOnsetMs": round(component_ready_ms, 1),
                "coldParallelReadyAfterWordOnsetMs": round(cold_parallel_ready_ms, 1),
                "observedChainReadyAfterWordOnsetMs": (
                    round(observed_ready_ms, 1) if observed_ready_ms is not None else None
                ),
                "componentLeadVsSttMs": (
                    round(float(baseline) - component_ready_ms, 1)
                    if isinstance(baseline, (int, float))
                    else None
                ),
                "coldParallelLeadVsSttMs": (
                    round(float(baseline) - cold_parallel_ready_ms, 1)
                    if isinstance(baseline, (int, float))
                    else None
                ),
                "observedChainLeadVsSttMs": (
                    round(float(baseline) - observed_ready_ms, 1)
                    if isinstance(baseline, (int, float)) and observed_ready_ms is not None
                    else None
                ),
                "top5": ranked[:5],
            }
        )
        result["windows"].append(row)

    return result


def _fmt_rate(value: Any) -> str:
    return "—" if not isinstance(value, (int, float)) else f"{float(value) * 100:.1f}%"


def _fmt_ms(value: Any) -> str:
    return "—" if not isinstance(value, (int, float)) else f"{float(value):.1f} ms"


def _fmt_int(value: Any) -> str:
    return "—" if not isinstance(value, (int, float)) else str(int(value))


def _sub(node: Any, key: str) -> dict[str, Any]:
    if isinstance(node, dict):
        value = node.get(key)
        if isinstance(value, dict):
            return value
    return {}


def _markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    gate = report["gate"]
    prediction = _sub(_sub(summary, "prediction"), "byLanguage")
    acoustic = _sub(_sub(summary, "acousticPruning"), "byLanguage")
    target = str(gate["targetWindowMs"])
    min_samples = _sub(gate, "thresholds").get("minSamplesPerLanguage")

    # Both gated languages always get a row even with zero data, and any extra
    # label present in the data is appended instead of being silently dropped.
    extra = sorted((set(prediction) | set(acoustic)) - set(LANGS))
    langs = list(LANGS) + extra

    # Every window in the data, ascending. The earlier report printed only the
    # gate's target window, which hid the +50…+250 ms curve the whole experiment
    # exists to measure.
    window_keys: set[str] = set(_sub(_sub(summary, "acousticPruning"), "byWindowMs"))
    for lang_windows in acoustic.values():
        if isinstance(lang_windows, dict):
            window_keys.update(lang_windows)

    def window_order(key: str) -> tuple[int, float | str]:
        try:
            return (0, float(key))
        except ValueError:
            return (1, key)

    windows = sorted(window_keys, key=window_order)

    lines = [
        "# SameVoice predictor + acoustic replay benchmark",
        "",
        f"**Verdict:** `{gate['verdict']}` — {gate['meaning']}",
        "",
        f"Samples: **{summary.get('samples', 0)}**. Target gate window: **{gate['targetWindowMs']} ms**.",
        "",
        "## Predictor (linguistic stage only)",
        "",
        "| Lang | n | Top-20 | Top-10 | Top-5 | Top-3 | Top-1 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for lang in langs:
        pred = prediction.get(lang) if isinstance(prediction.get(lang), dict) else {}
        recall = _sub(pred, "recall")
        lines.append(
            f"| {lang} | {_fmt_int(pred.get('samples'))} | "
            + " | ".join(_fmt_rate(recall.get(f"top{k}")) for k in (20, 10, 5, 3, 1))
            + " |"
        )

    lines.extend(
        [
            "",
            "## Acoustic pruning — every language × window",
            "",
            "| Lang | Window | Top-10 | Top-5 | Top-3 | Top-1 | vanished | errored | harmed | "
            "Lead vs STT p50 | Queue p95 | Pruner RTT p95 | n (eligible/all) |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for lang in langs:
        lang_windows = acoustic.get(lang) if isinstance(acoustic.get(lang), dict) else {}
        for window in windows:
            metrics = lang_windows.get(window) if isinstance(lang_windows.get(window), dict) else {}
            retention = _sub(metrics, "conditionalRetention")
            delta = _sub(metrics, "rankDelta")
            lead = _sub(metrics, "coldParallelLeadVsSttMs")
            rtt = _sub(metrics, "roundTripMs")
            queue = _sub(metrics, "queueWaitMs")
            eligible = metrics.get("predictorEligibleSamples")
            harmed = _fmt_rate(delta.get("harmedRate"))
            if isinstance(delta.get("samples"), int) and delta.get("samples"):
                # Harmed shares a denominator with improved/unchanged, not with
                # vanished; printing it inline stops the two being compared as if
                # they were the same population.
                harmed = f"{harmed} (n={delta['samples']})"
            n_cell = (
                f"{_fmt_int(eligible)}/{_fmt_int(metrics.get('samples'))}" if metrics else "—"
            )
            if (
                isinstance(min_samples, (int, float))
                and isinstance(eligible, (int, float))
                and eligible < min_samples
            ):
                n_cell += " *"
            marker = " **(gate window)**" if window == target else ""
            lines.append(
                f"| {lang} | {window} ms{marker} | "
                + " | ".join(_fmt_rate(retention.get(f"top{k}")) for k in (10, 5, 3, 1))
                + f" | {_fmt_rate(metrics.get('vanishedRate'))}"
                f" | {_fmt_rate(metrics.get('erroredRate'))} | {harmed} | "
                f"{_fmt_ms(lead.get('p50'))} | {_fmt_ms(queue.get('p95'))} | "
                f"{_fmt_ms(rtt.get('p95'))} | {n_cell} |"
            )

    if not windows:
        lines.append("| — | — | — | — | — | — | — | — | — | — | — | — | — |")

    lines.extend(
        [
            "",
            "Every rate in this table is conditional on the predictor having supplied the truth "
            "word; predictor misses are counted in the predictor table above, never charged to "
            "acoustics.",
            "",
            "- **Top-K** — conditional retention: truth word still inside Top-K after acoustics.",
            "- **vanished** — the pruner answered and its ranking had no rank for the truth word.",
            "- **errored** — the pruner never answered for this window: HTTP failure, timeout, or "
            "a clip too short for the window. Nothing is known about the scorer here, so this is "
            "**not** damage; it is reported separately precisely because an errored row looks "
            "identical to a vanished one in the raw artifact.",
            "- **harmed** — acoustics made the rank worse than the predictor's; denominator is "
            "only the samples where the truth word survived, printed as `n=` in the cell.",
            "- **Lead vs STT p50** — cold-parallel lead, i.e. the predictor is pessimistically "
            "assumed to start at word onset.",
            "- **Queue p95** — time a prune request spent waiting for the card before any model "
            "ran. `—` means the pruner did not publish `queue_wait_ms`, which is not the same "
            "claim as zero.",
            "- **n** — predictor-eligible samples / all replayed samples for that language and window.",
        ]
    )
    if isinstance(min_samples, (int, float)):
        lines.append(
            f"- `*` — fewer than {int(min_samples)} predictor-eligible samples. The gate "
            f"applies `minSamplesPerLanguage` to the replayed and round-trip counts, not to "
            f"this one, so a row can carry the marker and still be inside the gate: it means "
            f"the rates in it rest on too little data to read, not that the gate failed. "
            "The row is printed rather than hidden, but its rates decide nothing."
        )
    lines.extend(["", "## Gate checks", ""])
    for check in gate.get("checks", []):
        mark = "PASS" if check.get("pass") else "FAIL"
        lines.append(
            f"- **{mark}** `{check.get('lang')}` {check.get('name')}: "
            f"actual={check.get('actual')} {check.get('op')} {check.get('threshold')}"
        )
    lines.extend(
        [
            "",
            "> PROMOTE only authorizes the next soft-realtime R&D stage. It does not enable hard pruning or audible speculative commit.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--dataset-root", type=Path)
    parser.add_argument("--predictor-url", default="http://127.0.0.1:8101")
    parser.add_argument("--pruner-url", default="http://127.0.0.1:8105")
    parser.add_argument("--windows", default=",".join(str(v) for v in DEFAULT_WINDOWS))
    parser.add_argument("--top-k", type=int, default=20)
    parser.add_argument("--timeout-s", type=float, default=120.0)
    parser.add_argument("--gate-config", type=Path)
    parser.add_argument("--output", type=Path, help="full JSON report")
    parser.add_argument("--markdown", type=Path, help="human-readable summary")
    parser.add_argument("--fail-on-reject", action="store_true")
    args = parser.parse_args()

    if not args.manifest.is_file():
        raise SystemExit(f"manifest not found: {args.manifest}")
    if args.top_k < 1 or args.top_k > 50:
        raise SystemExit("--top-k must be 1..50")
    windows = _parse_windows(args.windows)
    samples = _load_manifest(args.manifest)
    gate_config = _load_gate(args.gate_config)

    results: list[dict[str, Any]] = []
    for index, sample in enumerate(samples, start=1):
        print(f"[{index}/{len(samples)}] {sample['id']} {sample['lang']} {sample['truth']}", file=sys.stderr)
        results.append(
            _run_sample(
                sample,
                manifest=args.manifest,
                dataset_root=args.dataset_root,
                predictor_url=args.predictor_url,
                pruner_url=args.pruner_url,
                windows=windows,
                top_k=args.top_k,
                timeout_s=args.timeout_s,
            )
        )

    summary = summarize_replay(results)
    gate = evaluate_promotion_gate(summary, gate_config)
    report = {
        "schemaVersion": 1,
        "manifest": str(args.manifest),
        "predictorUrl": args.predictor_url,
        "prunerUrl": args.pruner_url,
        "windowsMs": list(windows),
        "samples": results,
        "summary": summary,
        "gate": gate,
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    if args.markdown:
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text(_markdown(report), encoding="utf-8")
    print(rendered)

    if args.fail_on_reject and gate["verdict"] == "REJECT":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
