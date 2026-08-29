from __future__ import annotations

from gpu.predictor.text import RawCandidate, collapse_candidates, first_word


def test_first_word_handles_russian_and_hebrew():
    assert first_word("  привет, как") == "привет"
    assert first_word(" שלום, מה") == "שלום"
    assert first_word("  ") is None


def test_candidate_collapse_deduplicates_visible_words():
    result = collapse_candidates(
        [
            RawCandidate(" привет", -0.4),
            RawCandidate("привет!", -0.2),
            RawCandidate(" пока", -0.3),
        ],
        top_k=2,
    )
    assert [item.word for item in result] == ["привет", "пока"]
    assert abs(sum(item.probability for item in result) - 1.0) < 1e-9


def test_context_term_can_rerank_candidate():
    result = collapse_candidates(
        [RawCandidate("выплата", -0.5), RawCandidate("погода", -0.3)],
        top_k=2,
        context_terms=["выплата"],
    )
    assert result[0].word == "выплата"


def test_top_k_is_enforced_after_deduplication():
    result = collapse_candidates(
        [
            RawCandidate("один", -0.1),
            RawCandidate("два", -0.2),
            RawCandidate("три", -0.3),
        ],
        top_k=2,
    )
    assert len(result) == 2
