"""Pure-text helpers for the rolling predictor.

This module intentionally has no torch/transformers imports so candidate
normalization can be unit-tested in ordinary CI.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Iterable

# Python's Unicode \w already includes Cyrillic and Hebrew letters. Add common
# apostrophe/maqaf/hyphen joiners so names and compounds do not get chopped at
# the first character boundary.
_WORD_RE = re.compile(r"[\w]+(?:['’\-־][\w]+)*", re.UNICODE)


@dataclass(frozen=True)
class RawCandidate:
    continuation: str
    log_score: float


@dataclass(frozen=True)
class WordCandidate:
    word: str
    probability: float
    log_score: float


def first_word(continuation: str) -> str | None:
    match = _WORD_RE.search(continuation.strip())
    return match.group(0) if match else None


def normalize_word(word: str) -> str:
    return word.strip().casefold()


def collapse_candidates(
    raw: Iterable[RawCandidate],
    *,
    top_k: int,
    context_terms: Iterable[str] = (),
    context_boost: float = 0.35,
) -> list[WordCandidate]:
    """Collapse token-sequence beams into unique first-word candidates.

    Multiple tokenizations can produce the same visible word. We retain the
    highest-scoring realization, optionally boost exact current-context terms,
    then softmax over the surviving words. The returned probability is therefore
    a ranking probability within this candidate set, not a calibrated LM
    probability of the whole vocabulary.
    """

    if top_k < 1:
        raise ValueError("top_k must be >= 1")

    context = {normalize_word(term) for term in context_terms if term.strip()}
    best: dict[str, tuple[str, float]] = {}
    for item in raw:
        word = first_word(item.continuation)
        if not word:
            continue
        key = normalize_word(word)
        score = float(item.log_score) + (context_boost if key in context else 0.0)
        existing = best.get(key)
        if existing is None or score > existing[1]:
            best[key] = (word, score)

    ranked = sorted(best.values(), key=lambda item: item[1], reverse=True)[:top_k]
    if not ranked:
        return []

    max_score = ranked[0][1]
    weights = [math.exp(score - max_score) for _, score in ranked]
    denominator = sum(weights) or 1.0
    return [
        WordCandidate(word=word, probability=weight / denominator, log_score=score)
        for (word, score), weight in zip(ranked, weights, strict=True)
    ]
