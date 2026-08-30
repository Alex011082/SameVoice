"""Aggregation and promotion gates for predictor + acoustic-pruner replay.

The benchmark deliberately separates three questions:

1. Did the linguistic predictor include the real next source word in Top-K?
2. Given that the word was available to the pruner, did early acoustic evidence
   keep/promote it at +50/+100/+150/+200/+250 ms?
3. Was the combined component ready before the conventional STT baseline?

A PROMOTE verdict means only "safe to implement the next soft-realtime R&D
stage". It is never a production-enable flag and never authorizes audible early
commit.

Safety vocabulary. Every rate below is measured only over samples where the
linguistic predictor actually supplied the truth word, i.e. `predictor.truthRank`
is not None; a predictor miss is a predictor problem and must never be charged to
the acoustic stage:

- ``erroredRate``       -- the pruner never answered for this window (HTTP
  failure, timeout, or a clip too short for the window). Nothing is known about
  what acoustics would have done, so this must not be read as damage. It is
  broken out first because it is the easiest way for the numbers below to lie.
- ``vanishedRate``      -- the pruner answered, and its ranking contained no rank
  for the truth word. This is the only rate that means "the candidate was really
  destroyed".
- ``demotedBelowRate``  -- per cut K: the truth word survived but ended below K.
  This is the loss taken when a consumer acts on Top-K.
- ``harmedRate``        -- acoustics made the rank worse than the predictor's.
- ``improvedRate`` / ``unchangedRate`` -- the other two thirds of the same split.

A single "conditionalDropRate" field used to stand in for all of this. It was
removed because the pruner only re-ranks and never deletes candidates -- see
docs/11-acoustic-pruning.md, "No candidate is irreversibly deleted by the
service" -- so its Top-20 value was structurally ~0 and still read as "pruning
discards the correct word almost never": the founder's most dangerous question
answered by a number that could not measure it. `vanishedRate` and `harmedRate`
are the honest answers; `demotedBelowRate` is the Top-K consumer's actual loss.

Why `erroredRate` is separate from `vanishedRate`. A window row that failed
carries no `truthRank` at all, exactly like a genuinely destroyed candidate. Six
clips out of thirty that are shorter than 250 ms after `wordStartMs` produce
`{"windowMs": 250, "error": "audio shorter than requested word-onset window"}`
in `scripts/acoustic-replay-bench.py`, and folding them into `vanishedRate`
would report 20% of candidates destroyed at 250 ms by a pruner that was never
called. The same holds for a pod returning 503s. The gate's Top-5 miss check
still sums all three causes, so nothing gets quietly cheaper; the report just
says which one it was.
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
    # tracked separately: every conditional rate below answers "what did acoustics
    # do to a word the linguistic predictor actually supplied?", never "did the
    # predictor find it" -- mixing the two is what made the old drop rate unusable.
    all_count = len(rows)
    predictor_eligible = 0
    vanished = 0
    errored_eligible = 0
    demoted_below = {k: 0 for k in TOP_KS}
    ranks_all: list[int | None] = []
    conditional_ranks: list[int | None] = []
    inference: list[float] = []
    queue_wait: list[float] = []
    round_trip: list[float] = []
    component_leads: list[float] = []
    cold_parallel_leads: list[float] = []
    observed_chain_leads: list[float] = []
    rank_deltas: list[float] = []
    errors = 0

    for sample, row in rows:
        row_errored = bool(row.get("error"))
        if row_errored:
            errors += 1
        predictor = sample.get("predictor") if isinstance(sample.get("predictor"), Mapping) else {}
        predictor_rank_raw = predictor.get("truthRank") if isinstance(predictor, Mapping) else None
        predictor_rank = int(predictor_rank_raw) if isinstance(predictor_rank_raw, int) else None
        truth_rank_raw = row.get("truthRank")
        truth_rank = int(truth_rank_raw) if isinstance(truth_rank_raw, int) else None
        ranks_all.append(truth_rank)
        if predictor_rank is not None:
            predictor_eligible += 1
            # An errored row contributes no rank even if one somehow survived on
            # it, so retention/demoted/vanished/errored stay mutually exclusive
            # and exhaustive over the eligible samples.
            conditional_ranks.append(None if row_errored else truth_rank)
            if row_errored:
                # The pruner never answered, so this row is evidence about the
                # run, not about the scorer. An errored row carries no truthRank
                # and would otherwise be indistinguishable from a destroyed
                # candidate -- see the module docstring.
                errored_eligible += 1
            elif truth_rank is None:
                # The pruner answered and its ranking did not contain the word
                # the predictor did supply: the only case where the acoustic
                # stage really destroyed the candidate.
                vanished += 1
            else:
                # Positive means the acoustic scorer improved the rank.
                rank_deltas.append(float(predictor_rank - truth_rank))
                for k in TOP_KS:
                    if truth_rank > k:
                        demoted_below[k] += 1

        for key, target in (
            ("inferenceMs", inference),
            ("queueWaitMs", queue_wait),
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
    # Per cut K the eligible samples split four ways, which is what the single
    # removed "drop rate" hid. In counts the identity is exact:
    #   retained[k] + demotedBelow[k] + vanished + erroredEligible == eligible
    # The published rates are each rounded to 4 decimals independently, so their
    # sum can miss 1.0 by up to 1.5e-4 (eligible == 3 gives 0.3333 * 3 = 0.9999).
    # Compare the counts, not the rates, if the identity has to be checked.
    demoted_below_rate = {
        f"top{k}": _rate(demoted_below[k], predictor_eligible) for k in TOP_KS
    }
    vanished_rate = _rate(vanished, predictor_eligible)
    errored_rate = _rate(errored_eligible, predictor_eligible)

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
        # The pruner answered and its ranking had no rank for a truth word the
        # predictor did supply.
        "vanishedRate": vanished_rate,
        "vanishedSamples": vanished,
        # The pruner never answered for this window: HTTP failure, timeout, or a
        # clip too short for the window. Kept out of vanishedRate because it says
        # nothing about the scorer, and out of retention because it says nothing
        # about safety either.
        "erroredRate": errored_rate,
        "erroredSamples": errored_eligible,
        # Truth word survived acoustics but ended below K: the loss a consumer
        # takes when it acts on Top-K. Reported separately from vanishedRate
        # because the two demand different fixes (thresholds vs. scorer).
        "demotedBelowRate": demoted_below_rate,
        "truthRankP50": percentile(
            [float(rank) for rank in conditional_ranks if rank is not None], 0.50
        ),
        # Denominator here is rank_deltas, i.e. only samples where the truth word
        # had a rank before AND after acoustics -- a delta is undefined for a
        # vanished word and for an errored row. improved + unchanged + harmed
        # == 1 over that denominator (again up to per-rate rounding);
        # vanishedRate and erroredRate above cover the rest of the eligible
        # samples. `samples` is published so the two denominators are never
        # mistaken for each other.
        "rankDelta": {
            "samples": len(rank_deltas),
            "p50": percentile(rank_deltas, 0.50),
            "improvedRate": _rate(sum(value > 0 for value in rank_deltas), len(rank_deltas)),
            "unchangedRate": _rate(sum(value == 0 for value in rank_deltas), len(rank_deltas)),
            # Previously only improvedRate was published, so harm hid inside the
            # 1 - improvedRate remainder together with the unchanged samples;
            # this is the number that decides whether pruning is safe.
            "harmedRate": _rate(sum(value < 0 for value in rank_deltas), len(rank_deltas)),
        },
        # Forward-only model time, from the service's `model_forward_ms`.
        "inferenceMs": _latencies(inference),
        # Time the request spent waiting for the card before any model ran. Empty
        # `samples` here means the pruner was too old to publish the split, not
        # that nothing queued -- do not read a missing p95 as zero.
        "queueWaitMs": _latencies(queue_wait),
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
            "minimum predictor samples",
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
        predictor_enough = (
            isinstance(sample_count, (int, float))
            and sample_count >= gate["minSamplesPerLanguage"]
        )
        if predictor_enough:
            if isinstance(top20, (int, float)) and top20 < gate["rejectPredictorTop20RecallBelow"]:
                hard_reject = True

        lang_windows = acoustic_lang.get(lang) if isinstance(acoustic_lang, Mapping) else None
        lang_windows = lang_windows if isinstance(lang_windows, Mapping) else {}
        metrics = lang_windows.get(target) if isinstance(lang_windows, Mapping) else None
        metrics = metrics if isinstance(metrics, Mapping) else {}
        retention = metrics.get("conditionalRetention") if isinstance(metrics.get("conditionalRetention"), Mapping) else {}
        demoted = metrics.get("demotedBelowRate") if isinstance(metrics.get("demotedBelowRate"), Mapping) else {}
        lead = metrics.get("coldParallelLeadVsSttMs") if isinstance(metrics.get("coldParallelLeadVsSttMs"), Mapping) else {}
        rtt = metrics.get("roundTripMs") if isinstance(metrics.get("roundTripMs"), Mapping) else {}

        acoustic_samples = metrics.get("samples")
        rtt_samples = rtt.get("samples") if isinstance(rtt, Mapping) else None
        min_samples = float(gate["minSamplesPerLanguage"])
        add(f"{target} ms acoustic samples", lang, acoustic_samples, ">=", min_samples)
        add(f"{target} ms pruner round-trip samples", lang, rtt_samples, ">=", min_samples)
        acoustic_enough = (
            isinstance(acoustic_samples, (int, float))
            and acoustic_samples >= gate["minSamplesPerLanguage"]
        )
        rtt_enough = (
            isinstance(rtt_samples, (int, float))
            and rtt_samples >= gate["minSamplesPerLanguage"]
        )

        top5_ret = retention.get("top5") if isinstance(retention, Mapping) else None
        top3_ret = retention.get("top3") if isinstance(retention, Mapping) else None
        top10_ret = retention.get("top10") if isinstance(retention, Mapping) else None
        # The gate threshold key keeps its name because gpu/acoustic_gate.default.json
        # ships it, and the summed value is still exactly 1 - conditional Top-5
        # retention, so the gate is neither tightened nor loosened here. What
        # changed is that the report next to it names which of the three causes
        # produced the number, so a FAIL can be attributed instead of merely
        # observed. erroredRate is included on purpose: a run that fails to
        # answer must not become cheaper than one that answers badly.
        vanished_rate = metrics.get("vanishedRate")
        errored_rate = metrics.get("erroredRate")
        top5_demoted = demoted.get("top5") if isinstance(demoted, Mapping) else None
        miss_parts = (vanished_rate, errored_rate, top5_demoted)
        top5_miss = (
            round(sum(float(part) for part in miss_parts), 4)
            if all(isinstance(part, (int, float)) for part in miss_parts)
            else None
        )
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
            f"{target} ms Top-5 miss rate (vanished + errored + demoted below 5)",
            lang,
            top5_miss,
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

        if acoustic_enough:
            if isinstance(top10_ret, (int, float)) and top10_ret < gate["rejectConditionalTop10RetentionBelow"]:
                hard_reject = True
        if rtt_enough:
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
    "LANGS",
    "evaluate_promotion_gate",
    "percentile",
    "summarize_replay",
]
