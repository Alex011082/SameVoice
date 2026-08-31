"""Low-latency CTC acoustic evidence scorer for rolling next-word candidates.

This is the first *acoustic* pruning experiment. It does not replace the main
ASR. A small language-specific CTC recognizer looks only at a short PCM window
captured after the linguistic predictor is armed. Its greedy decoded grapheme
fragment is treated as early acoustic evidence and used to re-rank the
predictor's candidate words.

The service deliberately returns a ranking rather than making an irreversible
prune/commit decision. Benchmark code can ask "did the true word stay in top
10/5/3 after +50/+100/+150/+200 ms?" before runtime policy is chosen.
"""

from __future__ import annotations

import math
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Literal, Sequence

Lang = Literal["ru", "he"]

RU_MODEL = os.getenv("ACOUSTIC_PRUNER_RU_MODEL", "bond005/wav2vec2-base-ru")
HE_MODEL = os.getenv(
    "ACOUSTIC_PRUNER_HE_MODEL", "imvladikon/wav2vec2-large-xlsr-53-hebrew"
)
SAMPLE_RATE = 16000

_WORD_RE = re.compile(r"[^\W_]+(?:['’־-][^\W_]+)*", re.UNICODE)


def normalize_fragment(text: str) -> str:
    """Normalize a CTC/candidate string while preserving RU/HE letters."""
    parts = [match.group(0).casefold() for match in _WORD_RE.finditer(text)]
    return parts[-1] if parts else ""


def edit_distance(left: str, right: str) -> int:
    """Small allocation-light Levenshtein distance for short word prefixes."""
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    if len(left) > len(right):
        left, right = right, left
    previous = list(range(len(left) + 1))
    for j, char_r in enumerate(right, start=1):
        current = [j]
        for i, char_l in enumerate(left, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[i] + 1,
                    previous[i - 1] + (char_l != char_r),
                )
            )
        previous = current
    return previous[-1]


def prefix_similarity(candidate: str, evidence: str) -> float:
    """Compatibility of early decoded evidence with the start of a candidate.

    We compare only as much of the candidate as the acoustic model has emitted.
    This avoids penalising a six-letter candidate because only two graphemes are
    physically available in a 100 ms window.
    """
    candidate_n = normalize_fragment(candidate)
    evidence_n = normalize_fragment(evidence)
    if not evidence_n or not candidate_n:
        return 0.0
    width = min(len(candidate_n), len(evidence_n))
    left = candidate_n[:width]
    right = evidence_n[:width]
    distance = edit_distance(left, right)
    similarity = 1.0 - distance / max(1, width)
    # Exact acoustic prefix gets a small deterministic bonus over equally close
    # fuzzy candidates. Clamp to 1 so the score remains easy to interpret.
    if candidate_n.startswith(evidence_n):
        similarity += 0.08
    elif evidence_n.startswith(candidate_n):
        similarity += 0.04
    return max(0.0, min(1.0, similarity))


@dataclass(frozen=True)
class CandidateInput:
    word: str
    probability: float = 0.0


@dataclass(frozen=True)
class RankedCandidate:
    word: str
    probability: float
    acoustic_score: float
    combined_score: float


def rank_candidates(
    candidates: Sequence[CandidateInput],
    *,
    evidence: str,
    acoustic_weight: float = 0.88,
) -> list[RankedCandidate]:
    """Rank candidates from acoustic compatibility + a small linguistic prior."""
    if not candidates:
        return []
    acoustic_weight = max(0.0, min(1.0, acoustic_weight))
    prior_weight = 1.0 - acoustic_weight
    max_probability = max((max(0.0, item.probability) for item in candidates), default=0.0)

    ranked: list[RankedCandidate] = []
    for item in candidates:
        acoustic = prefix_similarity(item.word, evidence)
        # Normalize prior into 0..1. It only breaks acoustic ties; the dedicated
        # CTC evidence must dominate once it exists.
        prior = max(0.0, item.probability)
        prior_norm = prior / max_probability if max_probability > 0 else 0.0
        combined = acoustic_weight * acoustic + prior_weight * prior_norm
        ranked.append(
            RankedCandidate(
                word=item.word,
                probability=prior,
                acoustic_score=round(acoustic, 6),
                combined_score=round(combined, 6),
            )
        )
    ranked.sort(key=lambda item: (item.combined_score, item.probability), reverse=True)
    return ranked


@dataclass(frozen=True)
class EvidenceResult:
    evidence: str
    raw_text: str
    model: str
    inference_ms: float
    audio_ms: float


class CtcEvidenceEngine:
    """Lazy per-language CTC model. No weights are downloaded in normal CI."""

    def __init__(self, lang: Lang, model_id: str) -> None:
        self.lang = lang
        self.model_id = model_id
        self._processor = None
        self._model = None
        self._device = "unloaded"
        self._lock = threading.RLock()
        self.load_ms = 0.0

    @property
    def loaded(self) -> bool:
        return self._model is not None

    @property
    def device(self) -> str:
        return self._device

    def load(self) -> float:
        if self.loaded:
            return 0.0
        with self._lock:
            if self.loaded:
                return 0.0
            started = time.perf_counter()
            try:
                import torch
                from transformers import AutoModelForCTC, Wav2Vec2Processor
            except ImportError as exc:  # pragma: no cover - GPU image only
                raise RuntimeError(
                    "CTC acoustic-pruner dependencies are missing; build with INSTALL_GPU_ENGINES=1"
                ) from exc

            # Wav2Vec2Processor, а НЕ AutoProcessor. `bond005/wav2vec2-base-ru`
            # объявляет в конфиге Wav2Vec2ProcessorWithLM, и AutoProcessor
            # покорно тянет его — а тот требует pyctcdecode и без него валит
            # загрузку: HTTP 500 на /v1/warmup, воспроизведено локально
            # 31.08.2026 (ImportError: requires the pyctcdecode library).
            #
            # Ставить pyctcdecode было бы не просто лишним, а ВРЕДНЫМ. Этот
            # сервис существует, чтобы измерять ЧИСТО акустическую улику первых
            # 50-250 мс слова. Декодер с языковой моделью подмешал бы в неё
            # лингвистическое ожидание — то самое, что предиктор даёт отдельно и
            # что мы как раз хотим померить раздельно. Разделение бы схлопнулось,
            # а числа стали бы необъяснимо хорошими.
            processor = Wav2Vec2Processor.from_pretrained(self.model_id)
            model = AutoModelForCTC.from_pretrained(self.model_id)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            if device == "cuda":
                model = model.to(device=device, dtype=torch.float16)
            else:
                model = model.to(device=device)
            model.eval()
            self._processor = processor
            self._model = model
            self._device = device
            self.load_ms = (time.perf_counter() - started) * 1000.0
            return self.load_ms

    def infer(self, audio) -> EvidenceResult:
        import numpy as np
        import torch

        self.load()
        pcm = np.asarray(audio, dtype=np.float32).reshape(-1)
        if pcm.size == 0:
            raise ValueError("audio window is empty")
        if pcm.size > SAMPLE_RATE * 2:
            raise ValueError("acoustic-pruner window must be <= 2 seconds")
        processor = self._processor
        model = self._model
        assert processor is not None and model is not None

        inputs = processor(pcm, sampling_rate=SAMPLE_RATE, return_tensors="pt")
        # Вход обязан прийти в dtype модели. На CUDA модель лежит в float16
        # (см. load()), а процессор отдаёт float32 — без приведения каждый
        # запрос падает 503: "Input type (torch.cuda.FloatTensor) and weight
        # type (torch.cuda.HalfTensor) should be the same". На CPU это не
        # воспроизводится вовсе (модель float32), поэтому сухой прогон 31.08
        # был зелёным, а под eizvbi6bza72um завалил все 900 запросов.
        input_values = inputs.input_values.to(self._device, dtype=model.dtype)
        attention_mask = getattr(inputs, "attention_mask", None)
        if attention_mask is not None:
            attention_mask = attention_mask.to(self._device)

        started = time.perf_counter()
        with torch.inference_mode():
            outputs = model(input_values=input_values, attention_mask=attention_mask)
            predicted_ids = torch.argmax(outputs.logits, dim=-1)
        raw = processor.batch_decode(predicted_ids)[0]
        inference_ms = (time.perf_counter() - started) * 1000.0
        return EvidenceResult(
            evidence=normalize_fragment(raw),
            raw_text=raw.strip(),
            model=self.model_id,
            inference_ms=inference_ms,
            audio_ms=pcm.size / SAMPLE_RATE * 1000.0,
        )


engines: dict[Lang, CtcEvidenceEngine] = {
    "ru": CtcEvidenceEngine("ru", RU_MODEL),
    "he": CtcEvidenceEngine("he", HE_MODEL),
}


def engine_for(lang: Lang) -> CtcEvidenceEngine:
    return engines[lang]


__all__ = [
    "CandidateInput",
    "CtcEvidenceEngine",
    "EvidenceResult",
    "HE_MODEL",
    "RU_MODEL",
    "RankedCandidate",
    "edit_distance",
    "engine_for",
    "normalize_fragment",
    "prefix_similarity",
    "rank_candidates",
]
