"""Английский против русского и иврита — где на самом деле сидят наши секунды.

ВОПРОС, КОТОРЫЙ НИКТО НЕ ЗАДАЛ ЗА ТРИ ДНЯ (задал основатель 27.08.2026):
мы приняли 4 секунды за свойство задачи, ни разу не проверив их на **самом
обеспеченном данными языке**. Если английский заметно быстрее — секунды не в
природе синхронного перевода, а в том, что русский и иврит обслужены хуже. Это
меняет вывод: лечится подбором вендора, а не своим сервером за месяц работы.

КАК ПОСТРОЕН ЗАМЕР, ЧТОБЫ ОН ЧТО-ТО ЗНАЧИЛ
Один и тот же голос, один и тот же движок синтеза, одни и те же предложения в
трёх переводах. Меняется ТОЛЬКО язык. Синтезированная речь легче живой для всех
трёх одинаково, поэтому абсолютные числа оптимистичны, а СРАВНЕНИЕ честное —
а нас интересует именно оно.

Звук подаётся в Deepgram в реальном времени чанками по 100 мс. Меряем:
  * до первой гипотезы  — это те самые 917 мс из боевых логов;
  * до финала           — когда вендор считает фразу законченной.

Запускать на сервере, ключи там:
  scp eval/langs/bench_langs.py samevoice:/tmp/ && ssh samevoice \
    'cd /opt/samevoice/agent && set -a && . /opt/samevoice/.env && set +a && \
     .venv/bin/python /tmp/bench_langs.py'
"""
from __future__ import annotations
import asyncio, json, os, statistics as st, sys, time

import aiohttp

CARTESIA = "https://api.cartesia.ai/tts/bytes"
RATE = 16000
CHUNK_MS = 100

# Одни и те же мысли на трёх языках. Длина подобрана близкой, чтобы сравнивать
# не количество слов, а язык.
SENTENCES = {
    "en": [
        "Hello, can you hear me well?",
        "I would like to discuss our meeting tomorrow.",
        "If I manage to arrive earlier, I will call you half an hour before.",
        "The address is Herzl Street eighty two, third floor.",
        "Thank you very much for your help today.",
    ],
    "ru": [
        "Привет, ты меня хорошо слышишь?",
        "Я хотел бы обсудить нашу завтрашнюю встречу.",
        "Если получится приехать пораньше, я позвоню тебе за полчаса.",
        "Адрес — улица Герцля восемьдесят два, третий этаж.",
        "Большое спасибо за твою помощь сегодня.",
    ],
    "he": [
        "היי, אתה שומע אותי טוב?",
        "הייתי רוצה לדבר על הפגישה שלנו מחר.",
        "אם אצליח להגיע מוקדם יותר, אתקשר אליך חצי שעה קודם.",
        "הכתובת היא רחוב הרצל שמונים ושתיים, קומה שלוש.",
        "תודה רבה על העזרה שלך היום.",
    ],
}


async def synth(session: aiohttp.ClientSession, text: str, lang: str) -> bytes:
    """Синтез одним и тем же голосом на всех языках — иначе сравниваем голоса."""
    body = {
        "model_id": os.environ.get("CARTESIA_MODEL", "sonic-3.5-2026-05-04"),
        "transcript": text,
        "voice": {"mode": "id", "id": os.environ["CARTESIA_VOICE_RU"]},
        "language": lang,
        # container=raw, а не wav: на боевом сервере нет ffmpeg, и ставить его
        # ради замера незачем — Cartesia отдаёт готовый PCM сама.
        "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": RATE},
    }
    async with session.post(
        CARTESIA, json=body,
        headers={"X-API-Key": os.environ["CARTESIA_API_KEY"], "Cartesia-Version": "2025-04-16"},
    ) as r:
        if r.status != 200:
            raise RuntimeError(f"cartesia {r.status}: {(await r.text())[:150]}")
        return await r.read()


async def listen(session: aiohttp.ClientSession, pcm: bytes, lang: str
                 ) -> tuple[float | None, float | None, str]:
    """Возвращает (до первой гипотезы, до финала, распознанный текст).

    Сокет держим через aiohttp, а не через пакет `websockets`: в боевом venv
    агента его нет, а ставить лишнее в прод ради замера — плохой размен.
    """
    base = os.environ.get("DEEPGRAM_BASE_URL", "https://api.eu.deepgram.com/v1/listen")
    url = (base.replace("https://", "wss://")
           + f"?model={os.environ.get('DEEPGRAM_MODEL','nova-3')}&language={lang}"
           + "&interim_results=true&punctuate=true&filler_words=false"
           + f"&encoding=linear16&sample_rate={RATE}&channels=1&endpointing=300")

    first = final = None
    text = ""
    async with session.ws_connect(
        url, headers={"Authorization": f"Token {os.environ['DEEPGRAM_API_KEY']}"}
    ) as ws:
        t0 = time.perf_counter()

        async def feed():
            step = int(RATE * CHUNK_MS / 1000) * 2
            for i in range(0, len(pcm), step):
                await ws.send_bytes(pcm[i:i + step])
                await asyncio.sleep(CHUNK_MS / 1000)  # реальное время, не заливом
            await ws.send_str(json.dumps({"type": "CloseStream"}))

        async def read():
            nonlocal first, final, text
            async for msg in ws:
                if msg.type is not aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                alts = (m.get("channel") or {}).get("alternatives") or []
                if not alts or not alts[0].get("transcript"):
                    continue
                now = (time.perf_counter() - t0) * 1000.0
                if first is None:
                    first = now
                if m.get("is_final"):
                    final = now
                    text = alts[0]["transcript"]

        feeder = asyncio.create_task(feed())
        reader = asyncio.create_task(read())
        await feeder
        try:
            await asyncio.wait_for(reader, timeout=10)
        except asyncio.TimeoutError:
            reader.cancel()
    return first, final, text


async def main() -> None:
    for key in ("CARTESIA_API_KEY", "CARTESIA_VOICE_RU", "DEEPGRAM_API_KEY"):
        if not os.environ.get(key):
            sys.exit(f"ОСТАНОВ: нет {key} в окружении")

    print("Один голос, один движок синтеза, одни и те же фразы. Меняется только язык.\n")
    results: dict[str, dict[str, list[float]]] = {}

    async with aiohttp.ClientSession() as session:
        for lang, texts in SENTENCES.items():
            firsts, finals, secs = [], [], []
            print(f"--- {lang}")
            for t in texts:
                try:
                    wav = await synth(session, t, lang)
                except Exception as exc:
                    print(f"  синтез не удался: {exc}")
                    continue
                pcm = wav  # уже сырой PCM
                dur = len(pcm) / 2 / RATE
                f, fin, got = await listen(session, pcm, lang)
                secs.append(dur)
                if f is not None:
                    firsts.append(f)
                if fin is not None:
                    finals.append(fin)
                mark = "" if got else "  <-- НИЧЕГО НЕ РАСПОЗНАНО"
                print(f"  {dur:4.1f}с звука | первая {f or -1:6.0f} мс | финал {fin or -1:6.0f} мс{mark}")
                if got:
                    print(f"      {got[:80]}")
            results[lang] = {"first": firsts, "final": finals, "dur": secs}

    print("\n" + "=" * 62)
    print("%-6s %14s %14s %12s" % ("язык", "первая гипотеза", "финал", "звука"))
    print("=" * 62)
    for lang, r in results.items():
        if not r["first"]:
            print(f"{lang:<6} нет данных")
            continue
        print("%-6s %11.0f мс %11.0f мс %9.1f с" % (
            lang, st.median(r["first"]),
            st.median(r["final"]) if r["final"] else -1,
            st.median(r["dur"])))
    print("=" * 62)

    if results.get("en", {}).get("first") and results.get("ru", {}).get("first"):
        en, ru = st.median(results["en"]["first"]), st.median(results["ru"]["first"])
        he = st.median(results["he"]["first"]) if results.get("he", {}).get("first") else None
        print(f"\nанглийский против русского: {ru - en:+.0f} мс")
        if he:
            print(f"английский против иврита:   {he - en:+.0f} мс")
        if abs(ru - en) < 150 and (he is None or abs(he - en) < 200):
            print("\nВЫВОД: языки НЕ различаются. Значит задержка структурная, и подбором\n"
                  "вендора её не убрать — надо менять архитектуру.")
        else:
            print("\nВЫВОД: языки различаются заметно. Часть наших секунд — не природа\n"
                  "задачи, а качество поддержки языка. Это лечится дешевле своего сервера.")


if __name__ == "__main__":
    asyncio.run(main())
