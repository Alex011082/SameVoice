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


def test_latency_percentiles_and_drop_rate_are_reported():
    samples = [
        _sample("ru-1", "ru", predictor_rank=2, acoustic_rank=1, lead=200.0, rtt=50.0),
        _sample("ru-2", "ru", predictor_rank=2, acoustic_rank=8, lead=-20.0, rtt=100.0),
    ]
    window = summarize_replay(samples)["acousticPruning"]["byLanguage"]["ru"]["150"]
    assert window["conditionalRetention"]["top5"] == 0.5
    assert window["conditionalDropRate"]["top5"] == 0.5
    assert window["roundTripMs"]["p50"] == 75.0
    assert window["coldParallelLeadVsSttMs"]["positiveRate"] == 0.5
