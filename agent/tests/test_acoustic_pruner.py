from __future__ import annotations

from gpu.acoustic.pruner import (
    CandidateInput,
    edit_distance,
    normalize_fragment,
    prefix_similarity,
    rank_candidates,
)


def test_normalize_fragment_supports_ru_and_he():
    assert normalize_fragment("  ПРИВЕТ, ") == "привет"
    assert normalize_fragment("שלום!") == "שלום"
    assert normalize_fragment("noise я-хочу") == "я-хочу"


def test_edit_distance_basic_cases():
    assert edit_distance("", "abc") == 3
    assert edit_distance("кот", "кот") == 0
    assert edit_distance("кот", "код") == 1


def test_prefix_similarity_does_not_penalize_unheard_suffix():
    assert prefix_similarity("купить", "ку") > 0.95
    assert prefix_similarity("купить", "ма") < 0.2
    assert prefix_similarity("שלום", "של") > 0.95


def test_acoustic_evidence_can_reorder_linguistic_candidates():
    ranked = rank_candidates(
        [
            CandidateInput("сказать", 0.65),
            CandidateInput("купить", 0.20),
            CandidateInput("увидеть", 0.15),
        ],
        evidence="ку",
    )
    assert ranked[0].word == "купить"
    assert ranked[0].acoustic_score > ranked[1].acoustic_score


def test_empty_evidence_falls_back_to_linguistic_prior():
    ranked = rank_candidates(
        [CandidateInput("אחד", 0.2), CandidateInput("עכשיו", 0.8)],
        evidence="",
    )
    assert [item.word for item in ranked] == ["עכשיו", "אחד"]
