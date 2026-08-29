"""LocalAgreement-2 stable-prefix tracking plus the commit policy.

Pure and synchronous: the caller supplies `now` (monotonic seconds), so every
trigger is deterministic and directly unit-testable.

Why stability lives here and not in MT: spoken words cannot be un-spoken. MT is
never asked to re-translate a growing prefix; it only ever sees a fragment this
module has decided will not change.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

CommitTrigger = Literal["clause", "min_words", "silence", "timeout", "final"]

# A strong boundary always commits. A weak boundary only commits once enough
# stable words have accumulated, otherwise "привет," would become its own
# translation unit and the MT stage would lose all sentence context.
_STRONG_BOUNDARY = ".?!…׃"
_WEAK_BOUNDARY = ",;:־"
_TRAILING_STRIP = "\"'»«)]}”’"

# Committing on a function word strands the phrase it introduces in the next
# unit, which is exactly where RU->HE agreement errors come from.
_FUNCTION_WORDS_RU = frozenset(
    """
    и а но или да же ли бы не ни в во на за под над от до из у к ко с со о об обо про для
    что чтобы как когда где куда пока если то так вот уж ещё еще при без через между
    я ты он она оно мы вы они мой твой его её ее наш ваш их это эта этот эти тот та те
    """.split()
)
_FUNCTION_WORDS_HE = frozenset(
    """
    ו של את אל על מן מ ב ל כ ה כי אם אז גם רק עוד כבר לא אין יש כמו אבל או אשר
    אני אתה את הוא היא אנחנו אתם אתן הם הן זה זאת אלה שם פה כאן
    """.split()
)
_FUNCTION_WORDS = _FUNCTION_WORDS_RU | _FUNCTION_WORDS_HE


@dataclass(frozen=True)
class ChunkerConfig:
    # Measured on 85 real utterances from 24 calls (26.08.2026): median length
    # is 2 words, longest 11, and `min_words` fired ZERO times at 8. A gate that
    # never opens is not a policy, it is dead code - every unit fell through to
    # silence or to the provider's final. 5 and 3 are low enough to fire on a
    # normal sentence and still high enough that "привет," does not become its
    # own translation unit.
    min_words: int = 5
    # 300 ms was too eager. On the Alex-Omri call (26.08.2026) it cut sentences
    # at ordinary mid-sentence hesitations: "אני לא שומע" | "אותך" arrived as two
    # units and the second was translated alone as "тебя". A natural pause
    # *inside* a phrase runs 200-400 ms; a pause that actually ends one is
    # longer. Deepgram's own endpointing stays at 300 ms (it is speech-activity
    # based, not a raw timer) and leads; this threshold is now the backstop for
    # when no final arrives at all.
    max_silence_ms: int = 550
    # A pause is not a sentence boundary. On the Omri-Maya call (27.08.2026) the
    # median committed unit was ONE WORD: "Мне" | "тебя в наушниках" | "сейчас" |
    # "вышла." went out as four separate translation units and came back as four
    # disconnected Hebrew fragments. Founder's verdict: "перевод отстойный -
    # отрывками, неверный часто".
    #
    # So silence alone no longer commits. It must ALSO look like a finished
    # thought: ends in sentence punctuation, or has grown to min_words, or the
    # line has been quiet long enough that the turn is plainly over. Everything
    # else waits for the provider's final - the authoritative sentence boundary,
    # and the one that produced whole, correct units on 24.08.2026.
    end_of_turn_ms: int = 1200
    timeout_ms: int = 2200
    weak_boundary_min_words: int = 3


@dataclass(frozen=True)
class CommittedUnit:
    text: str
    trigger: CommitTrigger
    pending_since: float
    committed_at: float
    word_count: int


def _normalize_word(word: str) -> str:
    return word.strip(_TRAILING_STRIP + _STRONG_BOUNDARY + _WEAK_BOUNDARY).lower()


def _is_function_word(word: str) -> bool:
    return _normalize_word(word) in _FUNCTION_WORDS


def _ends_with(word: str, charset: str) -> bool:
    stripped = word.rstrip(_TRAILING_STRIP)
    return bool(stripped) and stripped[-1] in charset


def _common_prefix(a: Sequence[str], b: Sequence[str]) -> list[str]:
    out: list[str] = []
    for x, y in zip(a, b):
        if x != y:
            break
        out.append(x)
    return out


class Chunker:
    """Turns a stream of growing STT hypotheses into commit-once fragments."""

    def __init__(self, cfg: ChunkerConfig | None = None) -> None:
        self._cfg = cfg or ChunkerConfig()
        self._prev_words: list[str] = []
        self._stable: list[str] = []
        self._committed: int = 0
        self._pending_since: float | None = None
        self._last_activity: float = 0.0

    # ---------------------------------------------------------------- state

    @property
    def config(self) -> ChunkerConfig:
        return self._cfg

    @property
    def committed_text(self) -> str:
        return " ".join(self._stable[: self._committed])

    @property
    def pending_text(self) -> str:
        return " ".join(self._stable[self._committed :])

    @property
    def has_pending(self) -> bool:
        return self._committed < len(self._stable)

    def reset(self) -> None:
        self._prev_words = []
        self._stable = []
        self._committed = 0
        self._pending_since = None
        self._last_activity = 0.0

    # ---------------------------------------------------------------- input

    def on_partial(self, text: str, now: float) -> list[CommittedUnit]:
        words = text.split()
        self._last_activity = now

        agreed = _common_prefix(self._prev_words, words)
        self._prev_words = words

        if len(agreed) > len(self._stable) and agreed[: len(self._stable)] == self._stable:
            self._extend_stable(agreed, now)

        return self._drain(now)

    def on_final(self, text: str, now: float) -> list[CommittedUnit]:
        """A final transcript is stable by definition; commit whatever is left."""
        words = text.split()
        self._last_activity = now
        self._prev_words = words

        already = self._stable[: self._committed]
        if words[: len(already)] == already:
            self._extend_stable(words, now)
        else:
            # The provider revised text we have already spoken. We cannot retract
            # it, so keep the spoken prefix and append only the unseen suffix.
            self._extend_stable(already + words[len(already) :], now)

        units = self._drain(now, force="final")
        self.reset()
        return units

    def tick(self, now: float) -> list[CommittedUnit]:
        cfg = self._cfg
        quiet_ms = (now - self._last_activity) * 1000.0
        silent = bool(self._prev_words) and quiet_ms >= cfg.max_silence_ms
        if silent:
            self._adopt_hypothesis(now)
        if not self.has_pending:
            return []
        if silent and self._silence_may_commit(quiet_ms):
            return self._drain(now, force="silence")
        if self._pending_since is not None and (now - self._pending_since) * 1000.0 >= cfg.timeout_ms:
            return self._drain(now, force="timeout")
        return []

    # ------------------------------------------------------------- internal

    def _silence_may_commit(self, quiet_ms: float) -> bool:
        """Whether a pause may end a unit, or whether it is just a pause.

        The single most damaging bug of 26-27.08.2026 was answering "yes" here
        unconditionally: half-sentences went to MT and came back as nonsense.
        A pause may close a unit only when the unit already looks whole.
        """
        pending = self._stable[self._committed :]
        if not pending:
            return False
        if _ends_with(pending[-1], _STRONG_BOUNDARY):
            return True  # "Алло." / "נכון?" - finished, send it now
        if self._tail_is_dangling():
            return False  # ends on a function word: the phrase it opens is still coming
        if len(pending) >= self._cfg.min_words:
            return True  # long enough to stand on its own and to translate in context
        # Short, unpunctuated, and the line has gone properly quiet: the speaker
        # simply stopped there. Waiting for a `final` that may never come would
        # strand the words entirely.
        return quiet_ms >= self._cfg.end_of_turn_ms

    def _tail_is_dangling(self) -> bool:
        """True when the pending tail obviously has not finished.

        Real fragments the 26.08.2026 call produced: "אתה," -> "ты,", "А я" ->
        "ואני", "Я" -> "אני". Every one ends on a function word that introduces
        the phrase which the pause interrupted, so committing here strands that
        phrase in the next unit -- exactly where RU->HE agreement errors come
        from. Punctuation overrides: "נכון?" is finished and must go now.
        """
        pending = self._stable[self._committed :]
        if not pending:
            return False
        last = pending[-1]
        if _ends_with(last, _STRONG_BOUNDARY) or _ends_with(last, _WEAK_BOUNDARY):
            return False
        return _is_function_word(last)

    def _adopt_hypothesis(self, now: float) -> None:
        """Silence is confirmation.

        LocalAgreement holds a word back until a second hypothesis repeats it,
        because the first one might still be revised. But a provider that has
        sent nothing for `max_silence_ms` is not going to revise anything -- it
        is waiting for the speaker, same as we are. Without this, the last word
        of a short utterance is seen exactly once and never stabilises, so the
        unit waits for the provider's `final` instead of our own silence.

        Measured 26.08.2026 on 85 real utterances: 54 of 85 committed on
        `final`, only 22 on `silence`. Those 54 were paying for the vendor's
        endpointing on top of evidence we already had.
        """
        already = self._stable[: self._committed]
        if len(self._prev_words) <= len(self._stable):
            return
        if self._prev_words[: len(already)] != already:
            return  # provider revised text we have already spoken; on_final handles it
        self._extend_stable(self._prev_words, now)

    def _extend_stable(self, words: list[str], now: float) -> None:
        if len(words) <= len(self._stable):
            return
        self._stable = list(words)
        if self._pending_since is None and self.has_pending:
            self._pending_since = now

    def _drain(self, now: float, force: CommitTrigger | None = None) -> list[CommittedUnit]:
        units: list[CommittedUnit] = []
        while True:
            unit = self._try_commit(now, force)
            if unit is None:
                return units
            units.append(unit)
            if force is not None:
                return units

    def _try_commit(self, now: float, force: CommitTrigger | None) -> CommittedUnit | None:
        pending = self._stable[self._committed :]
        if not pending:
            return None

        if force is not None:
            return self._emit(len(pending), force, now)

        cfg = self._cfg
        for i in range(len(pending) - 1, -1, -1):
            if _ends_with(pending[i], _STRONG_BOUNDARY):
                return self._emit(i + 1, "clause", now)
        for i in range(len(pending) - 1, -1, -1):
            if _ends_with(pending[i], _WEAK_BOUNDARY) and (i + 1) >= cfg.weak_boundary_min_words:
                return self._emit(i + 1, "clause", now)
        if len(pending) >= cfg.min_words and not _is_function_word(pending[-1]):
            return self._emit(len(pending), "min_words", now)
        return None

    def _emit(self, count: int, trigger: CommitTrigger, now: float) -> CommittedUnit:
        words = self._stable[self._committed : self._committed + count]
        self._committed += count
        pending_since = self._pending_since if self._pending_since is not None else now
        self._pending_since = now if self.has_pending else None
        return CommittedUnit(
            text=" ".join(words),
            trigger=trigger,
            pending_since=pending_since,
            committed_at=now,
            word_count=count,
        )
