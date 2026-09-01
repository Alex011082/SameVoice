"""Выбор движка ДЛЯ КАЖДОГО ЗВОНКА, а не для всего агента сразу.

Зачем: оркестратор поднимает несколько подов (по одному на гнездо броней),
но агент до сих пор брал адрес движка из переменных окружения — то есть в
любой момент говорил только с одним подом. Пока это так, вся арифметика с
двумя парами на карту и несколькими гнёздами остаётся на бумаге.

Как работает: перед началом звонка агент спрашивает оркестратор, есть ли
для ЭТОЙ пары собеседников готовый под. Ответ превращается в копию Config
с адресами этого пода; сам агент при этом ничего глобально не переключает,
поэтому соседний звонок может идти на другой под.

Три правила, заложенных намеренно:
  1. Молчание оркестратора — не авария. Нет ответа, нет ключа, нет пода —
     звонок идёт по настройкам из окружения (обычно облако). Разговор
     важнее оптимизации.
  2. Ответ проверяется на вид. Пришёл мусор вместо адреса — используем
     окружение, а не падаем на середине звонка.
  3. Ждём недолго. Опрос с коротким сроком: лучше начать разговор на
     облаке, чем задержать соединение из-за задумавшейся службы.
"""
from __future__ import annotations

import dataclasses
import logging
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

if TYPE_CHECKING:  # pragma: no cover - только для подсказок типов
    from .config import Config
    from .relay import RelayJob

logger = logging.getLogger(__name__)

TIMEOUT_S = 2.0


def _valid(url: str, schemes: tuple[str, ...]) -> bool:
    try:
        p = urlparse(url)
    except ValueError:
        return False
    return p.scheme in schemes and bool(p.netloc)


def apply_engine(cfg: "Config", engine: Any) -> "Config":
    """Наложить ответ оркестратора на настройки. Мусор и пустота -> как было.

    Отдельная чистая функция: именно её проверяют тесты, потому что здесь
    решается, поедет звонок на под или на облако.
    """
    if not isinstance(engine, dict):
        return cfg
    stt = str(engine.get("sttUrl") or "").strip()
    mt = str(engine.get("mtUrl") or "").strip()
    if not stt or not mt:
        return cfg
    if not _valid(stt, ("ws", "wss", "http", "https")) or not _valid(mt, ("http", "https")):
        logger.warning("оркестратор прислал негодные адреса движка: stt=%r mt=%r", stt, mt)
        return cfg
    return dataclasses.replace(
        cfg,
        stt_provider="runpod",
        mt_provider="runpod",
        runpod_stt_url=stt,
        runpod_mt_url=mt,
    )


async def resolve_for_call(cfg: "Config", job: "RelayJob") -> "Config":
    """Спросить оркестратор про движок для этой пары. Никогда не бросает."""
    base = (getattr(cfg, "orchestrator_url", "") or "").rstrip("/")
    key = getattr(cfg, "orchestrator_key", "") or ""
    if not base or not key:
        return cfg
    a, b = job.participants[0].user_id, job.participants[1].user_id
    try:
        import aiohttp

        from .httpclient import shared_session

        session = shared_session()
        async with session.get(
            f"{base}/engine-for",
            params={"a": a, "b": b, "callId": job.call_id},
            headers={"x-engine-key": key},
            timeout=aiohttp.ClientTimeout(total=TIMEOUT_S),
        ) as r:
            if r.status != 200:
                logger.info("оркестратор ответил %s — звонок пойдёт по настройкам окружения", r.status)
                return cfg
            payload = await r.json(content_type=None)
    except Exception as exc:  # сеть, разбор, что угодно
        logger.info("оркестратор недоступен (%s) — звонок пойдёт по настройкам окружения", exc)
        return cfg

    engine = payload.get("engine") if isinstance(payload, dict) else None
    out = apply_engine(cfg, engine)
    if out is not cfg:
        logger.info("звонок %s пойдёт на под %s", job.call_id, payload.get("podId", "?"))
    return out


__all__ = ["apply_engine", "resolve_for_call", "TIMEOUT_S"]
