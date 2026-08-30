"""Aggregation and promotion gates for predictor + acoustic-pruner replay.

The benchmark deliberately separates three questions:

1. Did the linguistic predictor include the real next source word in Top-K?
2. Given that the word was available to the pruner, did early acoustic evidence
   keep/promote it at +50/+100/+150/+200/+250 ms?
3. Was the combined component ready before the conventional STT baseline?

A PROMOTE verdict means only "safe to implement the next soft-realtime R&D
stage". It is never a production-enable flag and never authorizes audible early
commit.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any, Iterable, Mapping

LANGS = ("ru", "he")
TOP_KS = (1, 3, 5, 10, 20)

DEFAULT_GATE: dict[str, Any] = {
    "minSamplesPerLanguage": 30,
    "targetWindowMs": 150,
    "predictorTop20RecallMin": 0.95,
    "conditionalTop5RetentionMin": 0.95,
    "conditionalTop3RetentionMin": 0.88,
    "maxConditionalTop5DropRate": 0.05,
    "leadPositiveRateMin": 0.75,
    "leadP50MsMin": 150.0,
    "prunerRoundTripP95MsMax": 220.0,
    # Strong failure thresholds used only after enough data exists. Values in
    # between produce HOLD, not REJECT.
    "rejectPredictorTop20RecallBelow": 0.80,
    "rejectConditionalTop10RetentionBelow": 0.80,
    "rejectPrunerRoundTripP95MsAbove": 500.0,
}


def percentile(values: Iterable[float], q: float) -> float | None:
    clean = sorted(float(value) for value in values)
    if not clean:
        return None
    if len(clean) == 1:
        return round(clean[0], 1)
    position = (len(clean) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return round(clean[lower], 1)
    weight = position - lower
    return round(clean[lower] * (1.0 - weight) + clean[upper] * weight, 1)


def _latencies(values: list[float]) -> dict[str, Any]:
    return {
        "samples": len(values),
        "p50": percentile(values, 0.50),
        "p90": percentile(values, 0.90),
        "p95": percentile(values, 0.95),
    }


def _rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _rank_recall(ranks: list[int | None], k: int) -> float | None:
    if not ranks:
        return None
    return _rate(sum(rank is not None and rank <= k for rank in ranks), len(ranks))


def _prediction_metrics(samples: list[Mapping[str, Any]]) -> dict[str, Any]:
    ranks: list[int | None] = []
    rtts: list[float] = []
    errors = 0
    for sample in samples:
        predictor = sample.get("predictor")
        if not isinstance(predictor, Mapping):
            errors += 1
            continue
        if predictor.get("error"):
            errors += 1
            continue
        rank = predictor.get("truthRank")
        ranks.append(int(rank) if isinstance(rank, int) else None)
        rtt = predictor.get("roundTripMs")
        if isinstance(rtt, (int, float)):
            rtts.append(float(rtt))
    return {
        "samples": len(ranks),
        "errors": errors,
        "recall": {f"top{k}": _rank_recall(ranks, k) for k in TOP_KS},
        "roundTripMs": _latencies(rtts),
    }


def _window_metrics(rows: list[tuple[Mapping[str, Any], Mapping[str, Any]]]) -> dict[str, Any]:
    # Each tuple is (sample, window-row). Predictor eligibility is deliberately
    # tracked separately: conditional retention answers "did acoustic pruning
    # throw away a word the linguistic predictor actually supplied?".
    all_count = len(rows)
    predictor_eligible = 0
    ranks_all: list[int | None] = []
    conditional_ranks: list[int | None] = []
    inference: list[float] = []
    round_trip: list[float] = []
    component_leads: list[float] = []
    cold_parallel_leads: list[float] = []
    observed_chain_leads: list[float] = []
    rank_deltas: list[float] = []
    errors = 0

    for sample, row in rows:
        if row.get("error"):
            errors += 1
        predictor = sample.get("predictor") if isinstance(sample.get("predictor"), Mapping) else {}
        predictor_rank_raw = predictor.get("truthRank") if isinstance(predictor, Mapping) else None
        predictor_rank = int(predictor_rank_raw) if isinstance(predictor_rank_raw, int) else None
        truth_rank_raw = row.get("truthRank")
        truth_rank = int(truth_rank_raw) if isinstance(truth_rank_raw, int) else None
        ranks_all.append(truth_rank)
        if predictor_rank is not None:
            predictor_eligible += 1
            conditional_ranks.append(truth_rank)
            if truth_rank is not None:
                # Positive means the acoustic scorer improved the rank.
                rank_deltas.append(float(predictor_rank - truth_rank))

        for key, target in (
            ("inferenceMs", inference),
            ("roundTripMs", round_trip),
            ("componentLeadVsSttMs", component_leads),
            ("coldParallelLeadVsSttMs", cold_parallel_leads),
            ("observedChainLeadVsSttMs", observed_chain_leads),
        ):
            value = row.get(key)
            if isinstance(value, (int, float)):
                target.append(float(value))

    def conditional_retention(k: int) -> float | None:
        if not predictor_eligible:
            return None
        return _rate(
            sum(rank is not None and rank <= k for rank in conditional_ranks),
            predictor_eligible,
        )

    retention = {f"top{k}": conditional_retention(k) for k in TOP_KS}
    drop = {
        key: (round(1.0 - value, 4) if isinstance(value, (int, float)) else None)
        for key, value in retention.items()
    }

    def lead_metrics(values: list[float]) -> dict[str, Any]:
        result = _latencies(values)
        result["positiveRate"] = _rate(sum(value > 0 for value in values), len(values))
        return result

    return {
        "samples": all_count,
        "errors": errors,
        "predictorEligibleSamples": predictor_eligible,
        # End-to-end recall includes predictor misses in the denominator.
        "endToEndRecall": {f"top{k}": _rank_recall(ranks_all, k) for k in TOP_KS},
        # Conditional retention isolates damage/improvement caused by acoustics.
        "conditionalRetention": retention,
        "conditionalDropRate": drop,
        "truthRankP50": percentile(
            [float(rank) for rank in conditional_ranks if rank is not None], 0.50
        ),
        "rankDelta": {
            "samples": len(rank_deltas),
            "p50": percentile(rank_deltas, 0.50),
            "improvedRate": _rate(sum(value > 0 for value in rank_deltas), len(rank_deltas)),
        },
        "inferenceMs": _latencies(inference),
        "roundTripMs": _latencies(round_trip),
        # componentLead assumes predictor candidates were already available at
        # word onset. coldParallelLead pessimistically starts predictor at onset.
        # observedChainLead is used only when the manifest supplied a measured
        # predictor-ready offset relative to word onset.
        "componentLeadVsSttMs": lead_metrics(component_leads),
        "coldParallelLeadVsSttMs": lead_metrics(cold_parallel_leads),
        "observedChainLeadVsSttMs": lead_metrics(observed_chain_leads),
    }


def summarize_replay(samples: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    rows = [sample for sample in samples if isinstance(sample, Mapping)]
    by_lang: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    by_window: dict[int, list[tuple[Mapping[str, Any], Mapping[str, Any]]]] = defaultdict(list)
    by_lang_window: dict[str, dict[int, list[tuple[Mapping[str, Any], Mapping[str, Any]]]]] = defaultdict(
        lambda: defaultdict(list)
    )

    for sample in rows:
        lang = str(sample.get("lang") or "unknown")
        by_lang[lang].append(sample)
        windows = sample.get("windows")
        if not isinstance(windows, list):
            continue
        for window in windows:
            if not isinstance(window, Mapping):
                continue
            window_ms = window.get("windowMs")
            if not isinstance(window_ms, int):
                continue
            pair = (sample, window)
            by_window[window_ms].append(pair)
            by_lang_window[lang][window_ms].append(pair)

    return {
        "samples": len(rows),
        "prediction": {
            "all": _prediction_metrics(rows),
            "byLanguage": {
                lang: _prediction_metrics(items) for lang, items in sorted(by_lang.items())
            },
        },
        "acousticPruning": {
            "byWindowMs": {
                str(window): _window_metrics(items) for window, items in sorted(by_window.items())
            },
            "byLanguage": {
                lang: {
                    str(window): _window_metrics(items)
                    for window, items in sorted(windows.items())
                }
                for lang, windows in sorted(by_lang_window.items())
            },
        },
    }


def _merged_gate(overrides: Mapping[str, Any] | None) -> dict[str, Any]:
    merged = dict(DEFAULT_GATE)
    if overrides:
        for key, value in overrides.items():
            if key in merged:
                merged[key] = value
    return merged


def evaluate_promotion_gate(
    summary: Mapping[str, Any], overrides: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Return PROMOTE/HOLD/REJECT with machine-readable checks.

    PROMOTE means the data supports implementing *soft* realtime pruning next.
    It never enables hard pruning or audible speculative output.
    """

    gate = _merged_gate(overrides)
    target = str(int(gate["targetWindowMs"]))
    checks: list[dict[str, Any]] = []
    hard_reject = False
    missing = False

    prediction = summary.get("prediction") if isinstance(summary.get("prediction"), Mapping) else {}
    prediction_lang = prediction.get("byLanguage") if isinstance(prediction, Mapping) else {}
    acoustic = summary.get("acousticPruning") if isinstance(summary.get("acousticPruning"), Mapping) else {}
    acoustic_lang = acoustic.get("byLanguage") if isinstance(acoustic, Mapping) else {}

    def add(name: str, lang: str, actual: Any, op: str, threshold: float, *, critical: bool = False) -> None:
        nonlocal hard_reject, missing
        if not isinstance(actual, (int, float)):
            passed = False
            missing = True
        elif op == ">=":
            passed = float(actual) >= threshold
        elif op == "<=":
            passed = float(actual) <= threshold
        else:  # pragma: no cover - programming error
            raise ValueError(op)
        checks.append(
            {
                "name": name,
                "lang": lang,
                "actual": actual,
                "op": op,
                "threshold": threshold,
                "pass": passed,
            }
        )
        if critical and isinstance(actual, (int, float)) and not passed:
            hard_reject = True

    for lang in LANGS:
        pred = prediction_lang.get(lang) if isinstance(prediction_lang, Mapping) else None
        pred = pred if isinstance(pred, Mapping) else {}
        sample_count = pred.get("samples")
        add(
            "minimum samples",
            lang,
            sample_count,
            ">=",
            float(gate["minSamplesPerLanguage"]),
        )
        recall = pred.get("recall") if isinstance(pred.get("recall"), Mapping) else {}
        top20 = recall.get("top20") if isinstance(recall, Mapping) else None
        add(
            "predictor Top-20 recall",
            lang,
            top20,
            ">=",
            float(gate["predictorTop20RecallMin"]),
        )
        if isinstance(sample_count, (int, float)) and sample_count >= gate["minSamplesPerLanguage"]:
            if isinstance(top20, (int, float)) and top20 < gate["rejectPredictorTop20RecallBelow"]:
                hard_reject = True

        lang_windows = acoustic_lang.get(lang) if isinstance(acoustic_lang, Mapping) else None
        lang_windows = lang_windows if isinstance(lang_windows, Mapping) else {}
        metrics = lang_windows.get(target) if isinstance(lang_windows, Mapping) else None
        metrics = metrics if isinstance(metrics, Mapping) else {}
        retention = metrics.get("conditionalRetention") if isinstance(metrics.get("conditionalRetention"), Mapping) else {}
        drop = metrics.get("conditionalDropRate") if isinstance(metrics.get("conditionalDropRate"), Mapping) else {}
        lead = metrics.get("coldParallelLeadVsSttMs") if isinstance(metrics.get("coldParallelLeadVsSttMs"), Mapping) else {}
        rtt = metrics.get("roundTripMs") if isinstance(metrics.get("roundTripMs"), Mapping) else {}

        top5_ret = retention.get("top5") if isinstance(retention, Mapping) else None
        top3_ret = retention.get("top3") if isinstance(retention, Mapping) else None
        top10_ret = retention.get("top10") if isinstance(retention, Mapping) else None
        top5_drop = drop.get("top5") if isinstance(drop, Mapping) else None
        add(
            f"{target} ms conditional Top-5 retention",
            lang,
            top5_ret,
            ">=",
            float(gate["conditionalTop5RetentionMin"]),
        )
        add(
            f"{target} ms conditional Top-3 retention",
            lang,
            top3_ret,
            ">=",
            float(gate["conditionalTop3RetentionMin"]),
        )
        add(
            f"{target} ms conditional Top-5 drop rate",
            lang,
            top5_drop,
            "<=",
            float(gate["maxConditionalTop5DropRate"]),
        )
        add(
            f"{target} ms cold-parallel lead positive rate",
            lang,
            lead.get("positiveRate") if isinstance(lead, Mapping) else None,
            ">=",
            float(gate["leadPositiveRateMin"]),
        )
        add(
            f"{target} ms cold-parallel lead p50",
            lang,
            lead.get("p50") if isinstance(lead, Mapping) else None,
            ">=",
            float(gate["leadP50MsMin"]),
        )
        add(
            f"{target} ms pruner round-trip p95",
            lang,
            rtt.get("p95") if isinstance(rtt, Mapping) else None,
            "<=",
            float(gate["prunerRoundTripP95MsMax"]),
        )

        if isinstance(sample_count, (int, float)) and sample_count >= gate["minSamplesPerLanguage"]:
            if isinstance(top10_ret, (int, float)) and top10_ret < gate["rejectConditionalTop10RetentionBelow"]:
                hard_reject = True
            p95 = rtt.get("p95") if isinstance(rtt, Mapping) else None
            if isinstance(p95, (int, float)) and p95 > gate["rejectPrunerRoundTripP95MsAbove"]:
                hard_reject = True

    all_pass = bool(checks) and all(item["pass"] for item in checks)
    if hard_reject:
        verdict = "REJECT"
    elif all_pass and not missing:
        verdict = "PROMOTE"
    else:
        verdict = "HOLD"

    return {
        "verdict": verdict,
        "meaning": {
            "PROMOTE": "data supports implementing soft realtime pruning next",
            "HOLD": "collect more data or tune models/thresholds before realtime influence",
            "REJECT": "measured failure is large enough that this configuration should not advance",
        }[verdict],
        "targetWindowMs": int(gate["targetWindowMs"]),
        "thresholds": gate,
        "checks": checks,
    }


__all__ = [
    "DEFAULT_GATE",
    "evaluate_promotion_gate",
    "percentile",
    "summarize_replay",
]
