"""Тесты разводки движка по звонкам.

Проверяется главное: звонок никогда не должен сорваться из-за оркестратора.
Любая невнятица в ответе означает «работаем как раньше», а не отказ.
"""
from __future__ import annotations

import dataclasses

import pytest

from speakeasy_agent.config import Config
from speakeasy_agent.engine_routing import apply_engine


@pytest.fixture()
def cfg() -> Config:
    base = Config()
    return dataclasses.replace(
        base,
        stt_provider="deepgram",
        mt_provider="gemini",
        runpod_stt_url="",
        runpod_mt_url="",
    )


def test_годный_ответ_переводит_звонок_на_под(cfg: Config) -> None:
    out = apply_engine(cfg, {
        "sttUrl": "wss://pod123-8000.proxy.runpod.net/stt/v1/stream",
        "mtUrl": "https://pod123-8000.proxy.runpod.net/mt/v1/translate",
    })
    assert out.stt_provider == "runpod"
    assert out.mt_provider == "runpod"
    assert out.runpod_stt_url.endswith("/stt/v1/stream")
    assert out.runpod_mt_url.endswith("/mt/v1/translate")


def test_исходные_настройки_не_портятся(cfg: Config) -> None:
    apply_engine(cfg, {
        "sttUrl": "wss://pod123-8000.proxy.runpod.net/stt/v1/stream",
        "mtUrl": "https://pod123-8000.proxy.runpod.net/mt/v1/translate",
    })
    assert cfg.stt_provider == "deepgram", "чужой звонок не должен пострадать"
    assert cfg.mt_provider == "gemini"


@pytest.mark.parametrize(
    "engine",
    [
        None,
        {},
        "строка вместо словаря",
        {"sttUrl": "", "mtUrl": ""},
        {"sttUrl": "wss://pod/stt"},                      # нет перевода
        {"mtUrl": "https://pod/mt"},                      # нет распознавания
        {"sttUrl": "не адрес", "mtUrl": "https://pod/mt"},
        {"sttUrl": "wss://pod/stt", "mtUrl": "ftp://pod/mt"},
        {"sttUrl": "wss:///stt", "mtUrl": "https://pod/mt"},   # нет хоста
    ],
)
def test_невнятный_ответ_оставляет_облако(cfg: Config, engine) -> None:
    out = apply_engine(cfg, engine)
    assert out is cfg, "при любой невнятице звонок идёт по настройкам окружения"


def test_обычный_http_адрес_распознавания_тоже_годится(cfg: Config) -> None:
    # некоторые сборки отдают http-адрес, провайдер сам переведёт его в ws
    out = apply_engine(cfg, {
        "sttUrl": "https://pod123-8000.proxy.runpod.net/stt/v1/stream",
        "mtUrl": "https://pod123-8000.proxy.runpod.net/mt/v1/translate",
    })
    assert out.stt_provider == "runpod"


@pytest.mark.asyncio
async def test_молчание_оркестратора_не_срывает_звонок(cfg: Config) -> None:
    """Главная гарантия: недоступный оркестратор оставляет звонок на облаке.

    Адрес заведомо мёртвый — так проверяется, что ошибка сети именно
    проглатывается, а не всплывает в середину дозвона.
    """
    from types import SimpleNamespace

    from speakeasy_agent.engine_routing import resolve_for_call

    routed = dataclasses.replace(
        cfg,
        orchestrator_url="http://127.0.0.1:9",   # порт discard: соединения не будет
        orchestrator_key="ключ",
    )
    job = SimpleNamespace(
        call_id="c_test",
        participants=(SimpleNamespace(user_id="a"), SimpleNamespace(user_id="b")),
    )
    out = await resolve_for_call(routed, job)
    assert out.stt_provider == "deepgram", "звонок должен пойти как обычно"


@pytest.mark.asyncio
async def test_без_адреса_оркестратора_ничего_не_спрашиваем(cfg: Config) -> None:
    from types import SimpleNamespace

    from speakeasy_agent.engine_routing import resolve_for_call

    job = SimpleNamespace(call_id="c", participants=(SimpleNamespace(user_id="a"), SimpleNamespace(user_id="b")))
    out = await resolve_for_call(cfg, job)
    assert out is cfg
