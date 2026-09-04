"""Доменный корректор: чиним ослышки из реального звонка 03.09.2026 и
не трогаем здоровую речь."""
from speakeasy_agent.domain_lexicon import correct_stt_text


def test_fixes_real_call_mishearings():
    assert correct_stt_text("что я должна говорить на игри", "ru").endswith("на иврите")
    assert "иврите" in correct_stt_text("игритии, но переводишь", "ru")
    assert correct_stt_text("А почему то на руском говорит", "ru") == (
        "А почему то на русском говорит"
    )


def test_leaves_normal_speech_alone():
    text = "мы играли в игру вчера вечером"
    assert correct_stt_text(text, "ru") == text


def test_hebrew_passes_through():
    text = "אני מדבר עברית"
    assert correct_stt_text(text, "he") == text


def test_deterministic_for_partials():
    partial = "почему то на руском"
    assert correct_stt_text(partial, "ru") == correct_stt_text(partial, "ru")
