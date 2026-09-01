"""Environment-backed configuration for the agent process.

Every value has a working default so that `uv run python -m speakeasy_agent.main`
boots with zero credentials and the mock provider trio.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _candidate_env_files() -> list[Path]:
    roots = [_REPO_ROOT, Path.cwd(), *Path.cwd().parents[:3]]
    seen: list[Path] = []
    for root in roots:
        for name in (".env", ".env.example"):
            candidate = root / name
            if candidate.is_file() and candidate not in seen:
                seen.append(candidate)
    return seen


def _load_dotenv() -> None:
    """Load the repo-root .env if python-dotenv is installed. Never fatal."""
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - dotenv is a declared dependency
        return
    for candidate in _candidate_env_files():
        load_dotenv(candidate, override=False)


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_path(name: str, default: str) -> str:
    """A path from the environment, anchored to the repo root when it is relative.

    `.env` ships `EVAL_LOG_DIR=logs/calls`, which is written relative to the
    REPO, not to whatever directory a process happens to be started in. The
    agent is started by scripts/dev.sh with cwd=agent/, so taking the value
    literally put every call log in agent/logs/calls while both review tools
    (scripts/review-call.mjs and agent/scripts/review_call.py) looked in
    <repo>/logs/calls and reported "no call logs found".
    """
    raw = _env(name, default)
    return str(Path(raw).expanduser() if Path(raw).expanduser().is_absolute() else _REPO_ROOT / raw)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


@dataclass(frozen=True)
class Config:
    # --- job server ---
    agent_port: int = 8788
    agent_host: str = "127.0.0.1"
    agent_shared_secret: str = "dev-agent-secret"

    # --- provider selection ---
    stt_provider: str = "mock"
    mt_provider: str = "mock"
    tts_provider: str = "mock"

    # --- provider credentials / model ids ---
    deepgram_api_key: str = ""
    deepgram_model: str = "nova-3"
    #: 0 still means "follow CHUNK_MAX_SILENCE_MS", but the two are DELIBERATELY
    #: decoupled since 26.08.2026. Deepgram's endpointing is speech-activity
    #: based, not a raw timer, so it separates "paused mid-thought" from
    #: "finished" better than we can; the chunker's own silence threshold
    #: (550 ms) is the backstop for when no final ever arrives.
    #:
    #: 300 -> 100 ПО ЗАМЕРУ 27.08.2026. Оказалось, эта настройка управляет не
    #: только финалами, но и тем, когда приходит ПЕРВАЯ гипотеза. Кривая на
    #: одной и той же записи, по 5 прогонов на точку:
    #:      endpointing  10 -> первая  578 мс, финалов 3
    #:      endpointing  50 -> первая  580 мс, финалов 3
    #:      endpointing 100 -> первая  678 мс, финалов 3
    #:      endpointing 200 -> первая  981 мс, финалов 2
    #:      endpointing 300 -> первая  980 мс, финалов 2   <- было
    #:      endpointing 500 -> первая  983 мс, финалов 1
    #: То есть ~300 мс из «неизбежной» секунды до первой гипотезы были нашей
    #: собственной настройкой. 100, а не 50: замер шёл на СИНТЕЗИРОВАННОЙ речи,
    #: где почти нет микропауз; в живой речи слишком низкий порог нарежет фразу
    #: на куски — ровно то, что чинили утром 27.08.
    #: ПРОВЕРЯТЬ на следующем звонке: медиана слов на единицу в eval-логе. Если
    #: упала — откатывать на 300.
    deepgram_endpointing_ms: int = 100
    #: The plugin default is the US endpoint (api.deepgram.com), measured from
    #: Israel at 233 ms TCP connect against 84 ms for api.eu.deepgram.com
    #: (AWS eu-central-1). Streaming STT sits serially in the media path, so
    #: that ~150 ms is paid on the critical path, not once at setup. EU is the
    #: default because every user we have is in Israel; a deployment serving
    #: users elsewhere must set this to its own nearest region.
    #: NOT YET VERIFIED WITH A REAL KEY: the EU endpoint may require an
    #: EU-provisioned account. If auth fails against it, fall back to
    #: https://api.deepgram.com/v1/listen and re-measure.
    deepgram_base_url: str = "https://api.eu.deepgram.com/v1/listen"
    gemini_api_key: str = ""
    #: ВОЗВРАТ К flash-lite, 27.08.2026 — по замеру, а не по предпочтению.
    #: 25.08 здесь стояла 3.7-flash: flash-lite путала женский единственный род
    #: с множественным, и медленная-но-правильная казалась лучшим разменом.
    #: Замер 27.08 на 24 РЕАЛЬНЫХ репликах из живых звонков перевернул картину:
    #:   3.7-flash  : медиана 1133 мс, p90 2070, ОТКАЗОВ 3 из 24 (таймауты 4 с)
    #:   flash-lite : медиана  635 мс, p90  805, отказов 0 из 24
    #: 12% реплик просто НЕ ПЕРЕВОДИЛИСЬ — это хуже любой ошибки рода.
    #: А сама ошибка рода закрылась примером в промпте (см. mt_gemini.py,
    #: build_system_instruction): после него flash-lite даёт `את שומעת אותי?`,
    #: как и 3.7-flash. Правило моделька игнорировала, пример — скопировала.
    gemini_model: str = "gemini-3.5-flash-lite"
    #: Допустимые уровни РАЗНЫЕ у разных моделей, неверный — жёсткий HTTP 400:
    #: flash-lite принимает minimal, 3.7-flash — НЕТ (только low/medium/high).
    #: Всегда самый низкий, который модель принимает.
    gemini_thinking_level: str = "minimal"
    openai_api_key: str = ""
    #: gpt-5.6-luna is the cheap tier ($0.20/$1.20 per 1M, comparable to
    #: Flash-Lite). Do NOT casually raise this to sol/terra: measured 24.08.2026,
    #: sol is 33x the input price, and all of them are reasoning models whose
    #: thinking tokens are billed as output and spent before the first audible
    #: word. See _REASONING_EFFORT in providers/mt_openai.py.
    openai_model: str = "gpt-5.6-luna"
    cartesia_api_key: str = ""
    cartesia_model: str = "sonic-3.5-2026-05-04"
    cartesia_voice_ru: str = ""
    cartesia_voice_he: str = ""
    #: Blank means "use whatever Cartesia-Version the installed plugin pins"
    #: (2025-04-16 at the time of writing, against 2026-08-14 in current docs).
    #: We could not confirm from primary docs whether the older value is still
    #: accepted, so this is an escape hatch rather than a guess baked into code.
    cartesia_api_version: str = ""
    cartesia_sample_rate: int = 24000
    #: Оркестратор броней: у кого спрашивать движок для конкретного звонка.
    #: Пусто — агент работает как раньше, по переменным окружения.
    orchestrator_url: str = ""
    orchestrator_key: str = ""
    runpod_stt_url: str = ""
    runpod_mt_url: str = ""
    runpod_tts_url: str = ""

    # --- chunker tuning ---
    chunk_min_words: int = 5
    chunk_max_silence_ms: int = 550
    #: Тишина ДОЛЬШЕ этой — конец реплики, короткий кусок можно отдавать.
    #: Короче — просто пауза, ждём вендорский final. См. chunker.ChunkerConfig.
    chunk_end_of_turn_ms: int = 1200
    chunk_timeout_ms: int = 2200
    chunk_weak_boundary_min_words: int = 3

    # --- MT context ---
    mt_history_turns: int = 4

    # --- evaluation log (the bilingual-judge feature) ---
    eval_log_enabled: bool = True
    eval_log_dir: str = str(_REPO_ROOT / "logs" / "calls")

    # --- logging ---
    log_level: str = "INFO"

    glossary: dict[str, str] = field(default_factory=dict)

    @property
    def providers(self) -> dict[str, str]:
        return {"stt": self.stt_provider, "mt": self.mt_provider, "tts": self.tts_provider}

    @classmethod
    def from_env(cls) -> Config:
        _load_dotenv()
        return cls(
            agent_port=_env_int("AGENT_PORT", 8788),
            agent_host=_env("AGENT_HOST", "127.0.0.1"),
            agent_shared_secret=_env("AGENT_SHARED_SECRET", "dev-agent-secret"),
            stt_provider=_env("STT_PROVIDER", "mock").strip().lower(),
            mt_provider=_env("MT_PROVIDER", "mock").strip().lower(),
            tts_provider=_env("TTS_PROVIDER", "mock").strip().lower(),
            deepgram_api_key=_env("DEEPGRAM_API_KEY", ""),
            deepgram_model=_env("DEEPGRAM_MODEL", "nova-3"),
            deepgram_endpointing_ms=_env_int("DEEPGRAM_ENDPOINTING_MS", 100),
            deepgram_base_url=_env(
                "DEEPGRAM_BASE_URL", "https://api.eu.deepgram.com/v1/listen"
            ).strip(),
            gemini_api_key=_env("GEMINI_API_KEY", ""),
            gemini_model=_env("GEMINI_MODEL", "gemini-3.5-flash-lite"),
            gemini_thinking_level=_env("GEMINI_THINKING_LEVEL", "minimal").strip().lower(),
            openai_api_key=_env("OPENAI_API_KEY", ""),
            openai_model=_env("OPENAI_MODEL", "gpt-5.6-luna"),
            cartesia_api_key=_env("CARTESIA_API_KEY", ""),
            cartesia_model=_env("CARTESIA_MODEL", "sonic-3.5-2026-05-04"),
            cartesia_voice_ru=_env("CARTESIA_VOICE_RU", ""),
            cartesia_voice_he=_env("CARTESIA_VOICE_HE", ""),
            cartesia_api_version=_env("CARTESIA_API_VERSION", ""),
            cartesia_sample_rate=_env_int("CARTESIA_SAMPLE_RATE", 24000),
            orchestrator_url=_env("ORCHESTRATOR_URL", ""),
            orchestrator_key=_env("ORCHESTRATOR_KEY", ""),
            runpod_stt_url=_env("RUNPOD_STT_URL", ""),
            runpod_mt_url=_env("RUNPOD_MT_URL", ""),
            runpod_tts_url=_env("RUNPOD_TTS_URL", ""),
            chunk_min_words=_env_int("CHUNK_MIN_WORDS", 5),
            chunk_max_silence_ms=_env_int("CHUNK_MAX_SILENCE_MS", 550),
            chunk_end_of_turn_ms=_env_int("CHUNK_END_OF_TURN_MS", 1200),
            chunk_timeout_ms=_env_int("CHUNK_TIMEOUT_MS", 2200),
            chunk_weak_boundary_min_words=_env_int("CHUNK_WEAK_BOUNDARY_MIN_WORDS", 3),
            mt_history_turns=_env_int("MT_HISTORY_TURNS", 4),
            eval_log_enabled=_env_bool("EVAL_LOG_ENABLED", True),
            eval_log_dir=_env_path("EVAL_LOG_DIR", str(_REPO_ROOT / "logs" / "calls")),
            log_level=_env("LOG_LEVEL", "info").upper(),
        )


def configure_logging(cfg: Config) -> None:
    logging.basicConfig(
        level=getattr(logging, cfg.log_level, logging.INFO),
        format="%(asctime)s %(levelname)-5s %(name)s %(message)s",
    )
