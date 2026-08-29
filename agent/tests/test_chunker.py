from __future__ import annotations

from speakeasy_agent.chunker import Chunker, ChunkerConfig

NEVER = ChunkerConfig(min_words=1000, max_silence_ms=300, timeout_ms=2200, weak_boundary_min_words=1000)
DEFAULT = ChunkerConfig(min_words=8, max_silence_ms=300, timeout_ms=2200, weak_boundary_min_words=4)


def feed(chunker: Chunker, words: list[str], *, start: float = 0.0, step: float = 0.1):
    """Feed growing hypotheses one word at a time, like a real STT partial stream."""
    units = []
    for i in range(1, len(words) + 1):
        units.extend(chunker.on_partial(" ".join(words[:i]), start + i * step))
    return units


def test_local_agreement_2_lags_one_hypothesis():
    c = Chunker(NEVER)
    c.on_partial("alpha", 0.1)
    assert c.pending_text == ""  # nothing has been seen twice yet

    c.on_partial("alpha beta", 0.2)
    assert c.pending_text == "alpha"

    c.on_partial("alpha beta gamma", 0.3)
    assert c.pending_text == "alpha beta"


def test_local_agreement_2_does_not_shrink_on_a_revised_hypothesis():
    c = Chunker(NEVER)
    c.on_partial("alpha beta", 0.1)
    c.on_partial("alpha beta gamma", 0.2)
    assert c.pending_text == "alpha beta"

    # The provider revises the tail; the already-agreed prefix must survive.
    c.on_partial("alpha delta", 0.3)
    assert c.pending_text == "alpha beta"


def test_strong_clause_boundary_commits_immediately():
    c = Chunker(DEFAULT)
    c.on_partial("привет?", 0.1)
    units = c.on_partial("привет? да", 0.2)
    assert [u.text for u in units] == ["привет?"]
    assert units[0].trigger == "clause"


def test_weak_boundary_needs_enough_words():
    short = Chunker(DEFAULT)
    short.on_partial("раз,", 0.1)
    assert short.on_partial("раз, два", 0.2) == []

    long = Chunker(DEFAULT)
    units = feed(long, ["один", "два", "три", "четыре,", "пять", "шесть"])
    assert [u.text for u in units] == ["один два три четыре,"]
    assert units[0].trigger == "clause"


def test_min_words_trigger():
    c = Chunker(DEFAULT)
    words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"]
    units = feed(c, words)
    assert len(units) == 1
    assert units[0].trigger == "min_words"
    assert units[0].text == " ".join(words[:8])


def test_min_words_trigger_waits_for_a_content_word():
    c = Chunker(DEFAULT)
    # 8th stable word is a Russian conjunction: committing there would strand
    # the phrase it introduces in the next unit.
    words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "и", "iota", "kappa"]
    units = feed(c, words[:9])
    assert units == []

    units = c.on_partial(" ".join(words), 1.0)
    assert len(units) == 1
    assert units[0].text == " ".join(words[:9])


def test_silence_trigger():
    c = Chunker(DEFAULT)
    c.on_partial("тихо", 0.10)
    c.on_partial("тихо тут", 0.20)
    assert c.pending_text == "тихо"

    assert c.tick(0.40) == []  # 200 ms: a pause, nothing more
    assert c.tick(0.55) == []  # 350 ms: still just a pause - see _silence_may_commit
    units = c.tick(1.5)  # 1300 ms: the turn is plainly over
    # "тут" was seen once and LocalAgreement had not confirmed it, but a line
    # this quiet is not going to revise anything.
    assert [u.text for u in units] == ["тихо тут"]
    assert units[0].trigger == "silence"


def test_hard_timeout_fires_while_partials_keep_arriving():
    c = Chunker(NEVER)
    fired = []
    for i in range(1, 40):
        t = i * 0.1
        c.on_partial(" ".join(f"w{n}" for n in range(1, i + 1)), t)
        fired.extend(c.tick(t + 0.01))
        if fired:
            break
    assert fired, "the hard timeout never fired"
    assert fired[0].trigger == "timeout"
    assert (fired[0].committed_at - fired[0].pending_since) * 1000.0 >= 2200


def test_committed_prefix_is_never_re_emitted():
    c = Chunker(DEFAULT)
    first = c.on_partial("готово?", 0.1)
    first += c.on_partial("готово? едем дальше", 0.2)
    assert [u.text for u in first] == ["готово?"]

    later = c.on_partial("готово? едем дальше сейчас", 0.3)
    later += c.on_final("готово? едем дальше сейчас", 0.4)
    emitted = " ".join(u.text for u in later)
    assert emitted == "едем дальше сейчас"
    assert "готово?" not in emitted


def test_final_commits_the_remainder_and_resets():
    c = Chunker(DEFAULT)
    c.on_partial("раз", 0.1)
    c.on_partial("раз два", 0.2)
    units = c.on_final("раз два три", 0.3)
    assert [u.text for u in units] == ["раз два три"]
    assert units[0].trigger == "final"
    assert c.pending_text == ""
    assert c.committed_text == ""


def test_final_that_contradicts_spoken_text_only_emits_the_suffix():
    c = Chunker(DEFAULT)
    c.on_partial("готово?", 0.1)
    c.on_partial("готово? дальше", 0.2)  # commits "готово?"
    units = c.on_final("совсем другое дальше", 0.3)
    # "готово?" has already been spoken and cannot be retracted.
    assert [u.text for u in units] == ["другое дальше"]


# --- silence-as-confirmation -------------------------------------------------
# Measured 26.08.2026 on 85 real utterances: median length 2 words, and 54 of 85
# units committed on the provider's `final` rather than on our own silence.
# LocalAgreement was holding the last word hostage because it was seen only once.


def test_silence_commits_a_word_seen_only_once():
    c = Chunker(NEVER)
    c.on_partial("алло", 0.1)
    assert c.pending_text == ""  # not yet confirmed by a second hypothesis

    units = c.tick(1.4)  # quiet past end_of_turn_ms: the speaker stopped there
    assert [u.text for u in units] == ["алло"]
    assert units[0].trigger == "silence"


def test_silence_does_not_fire_before_the_threshold():
    c = Chunker(NEVER)
    c.on_partial("алло", 0.1)
    assert c.tick(0.3) == []   # 200 ms: mid-thought
    assert c.tick(0.45) == []  # 350 ms: still mid-thought
    assert c.tick(0.8) == []   # 700 ms: past max_silence_ms, but a short
                               # unpunctuated tail needs the full end_of_turn_ms
    units = c.tick(1.4)
    assert [u.text for u in units] == ["алло"]


def test_silence_on_an_empty_stream_commits_nothing():
    c = Chunker(NEVER)
    assert c.tick(99.0) == []
    assert c.committed_text == ""


def test_final_after_a_silence_commit_does_not_repeat_the_text():
    """The provider's final arrives late with the same words we already spoke."""
    c = Chunker(NEVER)
    c.on_partial("алло", 0.1)
    spoken = c.tick(1.4)
    assert [u.text for u in spoken] == ["алло"]

    assert c.on_final("алло", 1.8) == []  # nothing left to say


def test_final_after_a_silence_commit_emits_only_the_new_suffix():
    c = Chunker(NEVER)
    c.on_partial("алло", 0.1)
    c.tick(1.4)
    units = c.on_final("алло слышно", 1.8)
    assert [u.text for u in units] == ["слышно"]


def test_silence_never_adopts_a_hypothesis_that_contradicts_spoken_text():
    c = Chunker(NEVER)
    c.on_partial("алло", 0.1)
    c.tick(1.4)  # "алло" spoken
    c.on_partial("привет всем", 1.5)  # provider revised the whole thing
    units = c.tick(3.0)
    assert units == []  # cannot retract "алло"; on_final owns this repair


def test_min_words_fires_at_the_new_threshold():
    c = Chunker(ChunkerConfig())  # production defaults
    units = feed(c, ["мы", "хотим", "заказать", "доставку", "завтра"])
    assert [u.text for u in units] == []  # LocalAgreement lags by one word
    units = c.on_partial("мы хотим заказать доставку завтра утром", 0.7)
    assert [u.text for u in units] == ["мы хотим заказать доставку завтра"]
    assert units[0].trigger == "min_words"


# --- fragmentation guard -----------------------------------------------------
# Real damage from the Alex-Omri call, 26.08.2026: silence fired inside a phrase
# and the stranded half was translated on its own. "אני לא שומע" | "אותך" came
# out as "я не слышу" | "тебя".


def test_silence_does_not_commit_a_tail_ending_on_a_function_word():
    c = Chunker(NEVER)
    c.on_partial("а", 0.1)
    c.on_partial("а я", 0.2)
    assert c.pending_text == "а"

    assert c.tick(0.6) == []  # "а я" is obviously unfinished; wait for the rest
    assert c.committed_text == ""


def test_punctuation_beats_the_function_word_guard():
    """"נכון?" is a whole utterance even though it is one short word."""
    c = Chunker(NEVER)
    c.on_partial("это?", 0.1)
    units = c.tick(0.6)
    assert [u.text for u in units] == ["это?"]


def test_a_dangling_tail_still_leaves_on_timeout():
    c = Chunker(ChunkerConfig(min_words=1000, max_silence_ms=300, timeout_ms=800, weak_boundary_min_words=1000))
    c.on_partial("а", 0.1)
    c.on_partial("а я", 0.2)
    c.tick(0.6)  # held back by the guard
    units = c.tick(1.3)  # timeout wins: silence must not deadlock the stream
    assert [u.text for u in units] == ["а я"]
    assert units[0].trigger == "timeout"


# --- a pause is not a sentence boundary --------------------------------------
# The Omri-Maya call, 27.08.2026: "Мне" | "тебя в наушниках" | "сейчас" |
# "вышла." went to MT as four units and came back as four disconnected Hebrew
# fragments. Median committed unit that call: ONE word.


def test_a_mid_sentence_pause_does_not_commit():
    c = Chunker(ChunkerConfig())  # production defaults
    c.on_partial("мне", 0.1)
    c.on_partial("мне тебя", 0.2)
    assert c.pending_text == "мне"

    # 700 ms of breath in the middle of "мне тебя в наушниках сейчас не слышно"
    assert c.tick(0.9) == []
    assert c.committed_text == ""


def test_punctuation_lets_a_short_unit_go_at_once():
    c = Chunker(ChunkerConfig())
    c.on_partial("алло.", 0.1)
    units = c.tick(0.7)  # past max_silence_ms, well short of end_of_turn_ms
    assert [u.text for u in units] == ["алло."]


def test_a_long_tail_does_not_wait_for_end_of_turn():
    """min_words words already stand on their own - no reason to hold them."""
    c = Chunker(ChunkerConfig())
    feed(c, ["мы", "хотим", "заказать", "доставку"])
    c.on_partial("мы хотим заказать доставку домой", 0.6)
    units = c.tick(1.2)  # 600 ms quiet, below end_of_turn_ms
    assert [u.text for u in units] == ["мы хотим заказать доставку домой"]
