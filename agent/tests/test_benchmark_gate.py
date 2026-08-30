from __future__ import annotations

from speakeasy_agent.benchmark_gate import evaluate_promotion_gate, summarize_replay


def _sample(sample_id: str, lang: str, *, predictor_rank=2, acoustic_rank=1, lead=260.0, rtt=70.0):
    return {
        "id": sample_id,
        "lang": lang,
        "predictor": {"truthRank": predictor_rank, "roundTripMs": 45.0},
        "windows": [{
            "windowMs": 150,
            "truthRank": acoustic_rank,
            "inferenceMs": 35.0,
            "roundTripMs": rtt,
            "componentLeadVsSttMs": 320.0,
            "coldParallelLeadVsSttMs": lead,
        }],
    }


def _errored_sample(sample_id: str, lang: str, error: str, *, predictor_rank=2):
    """A window the pruner never answered for.

    Shaped exactly as `scripts/acoustic-replay-bench.py` writes it: `windowMs`
    and `error`, and no `truthRank` at all.
    """
    return {
        "id": sample_id,
        "lang": lang,
        "predictor": {"truthRank": predictor_rank, "roundTripMs": 45.0},
        "windows": [{"windowMs": 150, "error": error}],
    }


def test_summary_separates_predictor_recall_from_conditional_retention():
    samples = [
        _sample("ru-hit", "ru", predictor_rank=4, acoustic_rank=2),
        _sample("ru-miss", "ru", predictor_rank=None, acoustic_rank=None),
    ]
    summary = summarize_replay(samples)
    prediction = summary["prediction"]["byLanguage"]["ru"]
    window = summary["acousticPruning"]["byLanguage"]["ru"]["150"]
    assert prediction["recall"]["top20"] == 0.5
    assert window["predictorEligibleSamples"] == 1
    assert window["conditionalRetention"]["top3"] == 1.0
    assert window["endToEndRecall"]["top3"] == 0.5
    assert window["rankDelta"]["p50"] == 2.0


def test_gate_promotes_only_when_both_languages_have_enough_good_data():
    samples = [
        _sample("ru-1", "ru"),
        _sample("ru-2", "ru", predictor_rank=3, acoustic_rank=2, lead=220.0),
        _sample("he-1", "he"),
        _sample("he-2", "he", predictor_rank=4, acoustic_rank=3, lead=230.0),
    ]
    gate = evaluate_promotion_gate(summarize_replay(samples), {
        "minSamplesPerLanguage": 2,
        "predictorTop20RecallMin": 0.95,
        "conditionalTop5RetentionMin": 0.95,
        "conditionalTop3RetentionMin": 0.88,
        "maxConditionalTop5DropRate": 0.05,
        "leadPositiveRateMin": 0.75,
        "leadP50MsMin": 150.0,
        "prunerRoundTripP95MsMax": 220.0,
    })
    assert gate["verdict"] == "PROMOTE"
    assert all(check["pass"] for check in gate["checks"])


def test_gate_holds_when_dataset_is_too_small():
    gate = evaluate_promotion_gate(
        summarize_replay([_sample("ru-1", "ru"), _sample("he-1", "he")]),
        {"minSamplesPerLanguage": 5},
    )
    assert gate["verdict"] == "HOLD"


def test_gate_holds_when_predictor_count_is_large_but_acoustic_coverage_is_small():
    samples = []
    for lang in ("ru", "he"):
        # Two valid predictor samples, but only one target-window acoustic row.
        samples.append(_sample(f"{lang}-with-window", lang))
        missing = _sample(f"{lang}-no-window", lang)
        missing["windows"] = []
        samples.append(missing)

    gate = evaluate_promotion_gate(
        summarize_replay(samples),
        {"minSamplesPerLanguage": 2},
    )
    assert gate["verdict"] == "HOLD"
    failed = {
        (check["name"], check["lang"])
        for check in gate["checks"]
        if not check["pass"]
    }
    assert ("150 ms acoustic samples", "ru") in failed
    assert ("150 ms acoustic samples", "he") in failed
    assert ("150 ms pruner round-trip samples", "ru") in failed
    assert ("150 ms pruner round-trip samples", "he") in failed


def test_gate_rejects_very_low_predictor_recall_after_minimum_sample_count():
    samples = []
    for lang in ("ru", "he"):
        for index in range(4):
            samples.append(_sample(
                f"{lang}-{index}",
                lang,
                predictor_rank=None if index < 3 else 2,
                acoustic_rank=None if index < 3 else 1,
            ))
    gate = evaluate_promotion_gate(
        summarize_replay(samples),
        {"minSamplesPerLanguage": 4, "rejectPredictorTop20RecallBelow": 0.80},
    )
    assert gate["verdict"] == "REJECT"


def test_latency_percentiles_and_miss_split_are_reported():
    samples = [
        _sample("ru-1", "ru", predictor_rank=2, acoustic_rank=1, lead=200.0, rtt=50.0),
        _sample("ru-2", "ru", predictor_rank=2, acoustic_rank=8, lead=-20.0, rtt=100.0),
    ]
    window = summarize_replay(samples)["acousticPruning"]["byLanguage"]["ru"]["150"]
    assert window["conditionalRetention"]["top5"] == 0.5
    # The old single drop rate reported 0.5 here without saying whether the word
    # was destroyed or merely pushed down. Both causes are now separate.
    assert window["vanishedRate"] == 0.0
    assert window["demotedBelowRate"]["top5"] == 0.5
    assert window["rankDelta"]["harmedRate"] == 0.5
    assert window["roundTripMs"]["p50"] == 75.0
    assert window["coldParallelLeadVsSttMs"]["positiveRate"] == 0.5


def test_improved_rank_is_never_counted_as_harm():
    # 14 -> 9 is the acoustic stage doing exactly what it exists for. It is still
    # outside Top-5, so a Top-5 consumer loses the word: two different facts that
    # must not collapse into one number.
    window = summarize_replay(
        [_sample("ru-improved", "ru", predictor_rank=14, acoustic_rank=9)]
    )["acousticPruning"]["byLanguage"]["ru"]["150"]
    assert window["rankDelta"]["harmedRate"] == 0.0
    assert window["rankDelta"]["improvedRate"] == 1.0
    assert window["rankDelta"]["unchangedRate"] == 0.0
    assert window["vanishedRate"] == 0.0
    assert window["demotedBelowRate"]["top10"] == 0.0
    assert window["demotedBelowRate"]["top5"] == 1.0


def test_vanished_truth_is_counted_apart_from_demotion():
    # Founder's most dangerous metric: how often pruning discards the correct
    # word. Only a missing acoustic rank answers it, so it gets its own rate.
    samples = [
        _sample("ru-vanished", "ru", predictor_rank=3, acoustic_rank=None),
        _sample("ru-kept", "ru", predictor_rank=3, acoustic_rank=1),
    ]
    window = summarize_replay(samples)["acousticPruning"]["byLanguage"]["ru"]["150"]
    assert window["vanishedRate"] == 0.5
    assert window["vanishedSamples"] == 1
    assert window["demotedBelowRate"]["top5"] == 0.0
    # A rank delta is undefined for a word that came back with no rank at all.
    assert window["rankDelta"]["samples"] == 1
    assert window["conditionalRetention"]["top5"] == 0.5


def test_rank_pushed_from_two_to_seven_is_reported_as_harm():
    window = summarize_replay(
        [_sample("ru-harmed", "ru", predictor_rank=2, acoustic_rank=7)]
    )["acousticPruning"]["byLanguage"]["ru"]["150"]
    assert window["rankDelta"]["harmedRate"] == 1.0
    assert window["rankDelta"]["improvedRate"] == 0.0
    assert window["rankDelta"]["unchangedRate"] == 0.0
    # The word survived, so this damage is invisible in vanishedRate alone.
    assert window["vanishedRate"] == 0.0
    assert window["demotedBelowRate"]["top5"] == 1.0
    assert window["demotedBelowRate"]["top10"] == 0.0


def test_rate_split_is_exhaustive_for_every_cut():
    samples = [
        _sample("ru-improved", "ru", predictor_rank=5, acoustic_rank=1),
        _sample("ru-unchanged", "ru", predictor_rank=4, acoustic_rank=4),
        _sample("ru-harmed-1", "ru", predictor_rank=2, acoustic_rank=7),
        _sample("ru-harmed-2", "ru", predictor_rank=3, acoustic_rank=9),
        _sample("ru-vanished", "ru", predictor_rank=3, acoustic_rank=None),
    ]
    window = summarize_replay(samples)["acousticPruning"]["byLanguage"]["ru"]["150"]
    delta = window["rankDelta"]
    # Denominator of the delta rates is survivors only, and they are exhaustive.
    assert delta["samples"] == 4
    assert delta["improvedRate"] + delta["unchangedRate"] + delta["harmedRate"] == 1.0
    assert delta["harmedRate"] == 0.5
    assert window["vanishedRate"] == 0.2
    for cut in ("top1", "top3", "top5", "top10", "top20"):
        assert (
            window["conditionalRetention"][cut]
            + window["demotedBelowRate"][cut]
            + window["vanishedRate"]
            + window["erroredRate"]
        ) == 1.0
    assert window["conditionalRetention"]["top5"] == 0.4
    assert window["demotedBelowRate"]["top5"] == 0.4
    assert window["erroredRate"] == 0.0


def test_failed_window_is_not_charged_to_the_acoustic_stage():
    # The counter-example that vanishedRate alone cannot survive: the pruner was
    # never called, so nothing was destroyed. A short clip and a 503 both produce
    # a window row with an error and no truthRank, exactly like a real vanish.
    samples = [
        _sample("ru-kept", "ru", predictor_rank=2, acoustic_rank=1),
        _sample("ru-vanished", "ru", predictor_rank=2, acoustic_rank=None),
        _errored_sample("ru-short", "ru", "audio shorter than requested word-onset window"),
        _errored_sample("ru-503", "ru", "HTTP 503"),
    ]
    window = summarize_replay(samples)["acousticPruning"]["byLanguage"]["ru"]["150"]
    assert window["predictorEligibleSamples"] == 4
    # Half the eligible rows never reached the scorer, and the report says so
    # instead of reporting 75% of candidates destroyed by acoustics.
    assert window["erroredRate"] == 0.5
    assert window["erroredSamples"] == 2
    assert window["vanishedRate"] == 0.25
    assert window["vanishedSamples"] == 1
    assert window["conditionalRetention"]["top5"] == 0.25
    # A row that never produced a rank produces no delta either.
    assert window["rankDelta"]["samples"] == 1
    for cut in ("top1", "top3", "top5", "top10", "top20"):
        assert (
            window["conditionalRetention"][cut]
            + window["demotedBelowRate"][cut]
            + window["vanishedRate"]
            + window["erroredRate"]
        ) == 1.0


def test_gate_top5_miss_check_still_counts_failed_windows():
    # Errors must not make a run cheaper than answering badly: the summed miss
    # rate stays 1 - conditional Top-5 retention whatever the cause was.
    samples = []
    for lang in ("ru", "he"):
        samples.append(_sample(f"{lang}-kept", lang, predictor_rank=2, acoustic_rank=1))
        samples.append(_sample(f"{lang}-kept-2", lang, predictor_rank=2, acoustic_rank=3))
        samples.append(_errored_sample(f"{lang}-errored", lang, "HTTP 503"))
        samples.append(_sample(f"{lang}-demoted", lang, predictor_rank=2, acoustic_rank=7))
    gate = evaluate_promotion_gate(
        summarize_replay(samples),
        {"minSamplesPerLanguage": 4, "maxConditionalTop5DropRate": 0.05},
    )
    checks = {
        (check["name"], check["lang"]): check
        for check in gate["checks"]
    }
    assert not any("drop rate" in name for name, _ in checks)
    name = "150 ms Top-5 miss rate (vanished + errored + demoted below 5)"
    for lang in ("ru", "he"):
        check = checks[(name, lang)]
        assert check["actual"] == 0.5
        assert check["pass"] is False
        retention = checks[("150 ms conditional Top-5 retention", lang)]["actual"]
        assert round(retention + check["actual"], 4) == 1.0


def test_gate_top5_miss_check_sums_vanished_and_demoted():
    samples = []
    for lang in ("ru", "he"):
        samples.append(_sample(f"{lang}-kept", lang, predictor_rank=2, acoustic_rank=1))
        samples.append(_sample(f"{lang}-kept-2", lang, predictor_rank=2, acoustic_rank=3))
        samples.append(_sample(f"{lang}-vanished", lang, predictor_rank=2, acoustic_rank=None))
        samples.append(_sample(f"{lang}-demoted", lang, predictor_rank=2, acoustic_rank=7))
    gate = evaluate_promotion_gate(
        summarize_replay(samples),
        {"minSamplesPerLanguage": 4, "maxConditionalTop5DropRate": 0.05},
    )
    checks = {
        (check["name"], check["lang"]): check
        for check in gate["checks"]
    }
    assert not any("drop rate" in name for name, _ in checks)
    for lang in ("ru", "he"):
        check = checks[("150 ms Top-5 miss rate (vanished + errored + demoted below 5)", lang)]
        assert check["actual"] == 0.5
        assert check["pass"] is False
