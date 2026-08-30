#!/usr/bin/env python3
"""Summarize rolling next-word shadow records from one SameVoice call JSONL."""

from __future__ import annotations

import argparse
import json
import math
import sys
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

    for record in records:
        kind = record.get("kind")
        if kind == "prediction_shadow_error":
            errors += 1
            continue
        if kind != "prediction_shadow":
            continue
        status = str(record.get("status") or "unknown")
        statuses[status] += 1
        if status == "resolved":
            resolved.append(record)
            by_lang[str(record.get("srcLang") or "unknown")].append(record)

    def _metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
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

    return {
        "attemptStatuses": dict(sorted(statuses.items())),
        "predictorErrors": errors,
        "all": _metrics(resolved),
        "byLanguage": {lang: _metrics(rows) for lang, rows in sorted(by_lang.items())},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("jsonl", type=Path, help="logs/calls/<callId>.jsonl")
    parser.add_argument("--compact", action="store_true")
    # Без --output отчёт жил только в stdout. На арендованном поде это значит,
    # что предикторские числа печатаются в терминал и умирают вместе с подом:
    # scripts/runpod-export.sh забирает файлы, а не историю чужой консоли.
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="also write the report to this file so a Pod export can pick it up",
    )
    args = parser.parse_args()
    if not args.jsonl.is_file():
        raise SystemExit(f"not found: {args.jsonl}")
    report = summarize(_read(args.jsonl))
    text = json.dumps(report, ensure_ascii=False, indent=None if args.compact else 2, sort_keys=True)
    print(text)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
        print(f"written: {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
