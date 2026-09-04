#!/usr/bin/env python3
"""Summarize linguistic + acoustic shadow records from one SameVoice call JSONL."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


def _percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 1)
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 1)
    weight = position - lower
    return round(ordered[lower] * (1.0 - weight) + ordered[upper] * weight, 1)


def _read(path: Path) -> Iterable[dict[str, Any]]:
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{line_no}: invalid JSON: {exc}") from exc
            if isinstance(record, dict):
                yield record


def summarize(records: Iterable[dict[str, Any]]) -> dict[str, Any]:
    statuses: Counter[str] = Counter()
    errors = 0
    resolved: list[dict[str, Any]] = []
    by_lang: dict[str, list[dict[str, Any]]] = defaultdict(list)
    acoustic_records: list[dict[str, Any]] = []

    for record in records:
        kind = record.get("kind")
        if kind == "prediction_shadow_error":
            errors += 1
            continue
        if kind == "acoustic_pruning_shadow":
            acoustic_records.append(record)
            continue
        if kind != "prediction_shadow":
            continue
        status = str(record.get("status") or "unknown")
        statuses[status] += 1
        if status == "resolved":
            resolved.append(record)
            by_lang[str(record.get("srcLang") or "unknown")].append(record)

    def _prediction_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
        total = len(rows)
        ranks = [int(row["rank"]) for row in rows if isinstance(row.get("rank"), int)]
        leads = [
            float(row["sttLeadMs"])
            for row in rows
            if isinstance(row.get("sttLeadMs"), (int, float))
        ]
        rtts = [
            float(row["predictorRoundTripMs"])
            for row in rows
            if isinstance(row.get("predictorRoundTripMs"), (int, float))
        ]

        def recall(k: int) -> float | None:
            if total == 0:
                return None
            return round(sum(rank <= k for rank in ranks) / total, 4)

        return {
            "resolved": total,
            "ranked": len(ranks),
            "recall": {
                "top1": recall(1),
                "top3": recall(3),
                "top5": recall(5),
                "top10": recall(10),
                "top20": recall(20),
            },
            "sttLeadMs": {
                "samples": len(leads),
                "positiveRate": (
                    round(sum(value > 0 for value in leads) / len(leads), 4) if leads else None
                ),
                "p50": _percentile(leads, 0.50),
                "p90": _percentile(leads, 0.90),
                "p95": _percentile(leads, 0.95),
                "min": round(min(leads), 1) if leads else None,
                "max": round(max(leads), 1) if leads else None,
            },
            "predictorRoundTripMs": {
                "samples": len(rtts),
                "p50": _percentile(rtts, 0.50),
                "p90": _percentile(rtts, 0.90),
                "p95": _percentile(rtts, 0.95),
            },
        }

    acoustic_statuses: Counter[str] = Counter()
    acoustic_by_window: dict[int, list[dict[str, Any]]] = defaultdict(list)
    acoustic_by_lang_window: dict[str, dict[int, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    acoustic_errors = 0

    for record in acoustic_records:
        acoustic_statuses[str(record.get("status") or "unknown")] += 1
        if record.get("scoreError"):
            acoustic_errors += 1
        lang = str(record.get("srcLang") or "unknown")
        windows = record.get("windows")
        if not isinstance(windows, list):
            continue
        for row in windows:
            if not isinstance(row, dict):
                continue
            window = row.get("windowMs")
            if not isinstance(window, int):
                continue
            acoustic_by_window[window].append(row)
            acoustic_by_lang_window[lang][window].append(row)

    def _acoustic_window_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
        ranked = [row for row in rows if isinstance(row.get("truthRank"), int)]
        ranks = [int(row["truthRank"]) for row in ranked]
        inference = [
            float(row["inferenceMs"])
            for row in rows
            if isinstance(row.get("inferenceMs"), (int, float))
        ]
        leads = [
            float(row["estimatedLeadVsSttMs"])
            for row in rows
            if isinstance(row.get("estimatedLeadVsSttMs"), (int, float))
        ]

        def retention(k: int) -> float | None:
            if not ranked:
                return None
            return round(sum(rank <= k for rank in ranks) / len(ranked), 4)

        return {
            "samples": len(rows),
            "rankedTruthSamples": len(ranked),
            "truthRankP50": _percentile([float(rank) for rank in ranks], 0.50),
            "retention": {
                "top3": retention(3),
                "top5": retention(5),
                "top10": retention(10),
                "top20": retention(20),
            },
            "inferenceMs": {
                "p50": _percentile(inference, 0.50),
                "p90": _percentile(inference, 0.90),
                "p95": _percentile(inference, 0.95),
            },
            "estimatedLeadVsSttMs": {
                "samples": len(leads),
                "positiveRate": (
                    round(sum(value > 0 for value in leads) / len(leads), 4) if leads else None
                ),
                "p50": _percentile(leads, 0.50),
                "p90": _percentile(leads, 0.90),
                "p95": _percentile(leads, 0.95),
            },
        }

    acoustic_summary = {
        "records": len(acoustic_records),
        "statuses": dict(sorted(acoustic_statuses.items())),
        "scoreErrors": acoustic_errors,
        "reference": "prediction_arm",
        "byWindowMs": {
            str(window): _acoustic_window_metrics(rows)
            for window, rows in sorted(acoustic_by_window.items())
        },
        "byLanguage": {
            lang: {
                str(window): _acoustic_window_metrics(rows)
                for window, rows in sorted(windows.items())
            }
            for lang, windows in sorted(acoustic_by_lang_window.items())
        },
    }

    return {
        "prediction": {
            "attemptStatuses": dict(sorted(statuses.items())),
            "predictorErrors": errors,
            "all": _prediction_metrics(resolved),
            "byLanguage": {
                lang: _prediction_metrics(rows) for lang, rows in sorted(by_lang.items())
            },
        },
        "acousticPruning": acoustic_summary,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("jsonl", type=Path, help="logs/calls/<callId>.jsonl")
    parser.add_argument("--compact", action="store_true")
    args = parser.parse_args()
    if not args.jsonl.is_file():
        raise SystemExit(f"not found: {args.jsonl}")
    report = summarize(_read(args.jsonl))
    print(json.dumps(report, ensure_ascii=False, indent=None if args.compact else 2, sort_keys=True))


if __name__ == "__main__":
    main()
