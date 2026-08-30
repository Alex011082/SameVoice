"""Откуда берутся те самые ~980 мс до первой гипотезы.

ГИПОТЕЗА, КОТОРУЮ ПРОВЕРЯЕМ ПЕРВОЙ — НАША СОБСТВЕННАЯ ОШИБКА.
В замере языков время считалось от НАЧАЛА ОТПРАВКИ звука. Если синтез Cartesia
начинается с тишины, эта тишина попадает в цифру, и «фиксированный буфер
вендора» окажется нашим же артефактом. Сначала опровергаем себя, потом вендора.

ЗАТЕМ — действительно ли это потолок Deepgram.
Гоняем одну и ту же запись с разными параметрами: другая модель, другой
endpointing, отключённый VAD. Если число не двигается — это буфер, и лечится
сменой вендора. Если двигается — лечится настройкой, и это самый дешёвый
рычаг из всех оставшихся.
"""
from __future__ import annotations
import asyncio, json, os, struct, sys, time

import aiohttp

RATE = 16000
CHUNK_MS = 100
CARTESIA = "https://api.cartesia.ai/tts/bytes"
PHRASE = "Привет, ты меня хорошо слышишь? Я хотел бы обсудить нашу завтрашнюю встречу."


async def synth(session: aiohttp.ClientSession, text: str, lang: str = "ru") -> bytes:
    body = {
        "model_id": os.environ.get("CARTESIA_MODEL", "sonic-3.5-2026-05-04"),
        "transcript": text,
        "voice": {"mode": "id", "id": os.environ["CARTESIA_VOICE_RU"]},
        "language": lang,
        "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": RATE},
    }
    async with session.post(
        CARTESIA, json=body,
        headers={"X-API-Key": os.environ["CARTESIA_API_KEY"], "Cartesia-Version": "2025-04-16"},
    ) as r:
        r.raise_for_status()
        return await r.read()


def leading_silence_ms(pcm: bytes, threshold: int = 300) -> float:
    """Сколько миллисекунд в начале записи фактически тишина.

    Порог намеренно низкий: нас интересует момент, когда появляется хоть что-то
    громче цифрового нуля, а не когда речь становится разборчивой.
    """
    n = len(pcm) // 2
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    for i, v in enumerate(samples):
        if abs(v) > threshold:
            return i / RATE * 1000.0
    return len(pcm) / 2 / RATE * 1000.0


async def listen(session: aiohttp.ClientSession, pcm: bytes, params: str
                 ) -> tuple[float | None, float | None]:
    base = os.environ.get("DEEPGRAM_BASE_URL", "https://api.eu.deepgram.com/v1/listen")
    url = (base.replace("https://", "wss://")
           + f"?encoding=linear16&sample_rate={RATE}&channels=1&interim_results=true&" + params)
    first = final = None
    finals = 0
    async with session.ws_connect(
        url, headers={"Authorization": f"Token {os.environ['DEEPGRAM_API_KEY']}"}
    ) as ws:
        t0 = time.perf_counter()

        async def feed():
            step = int(RATE * CHUNK_MS / 1000) * 2
            for i in range(0, len(pcm), step):
                await ws.send_bytes(pcm[i:i + step])
                await asyncio.sleep(CHUNK_MS / 1000)
            await ws.send_str(json.dumps({"type": "CloseStream"}))

        async def read():
            nonlocal first, final, finals
            async for msg in ws:
                if msg.type is not aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    m = json.loads(msg.data)
                except ValueError:
                    continue
                # С vad_events Deepgram шлёт и другие типы сообщений, где
                # `channel` — список, а не объект. Разбираем только Results.
                ch = m.get("channel")
                if m.get("type") not in (None, "Results") or not isinstance(ch, dict):
                    continue
                alts = ch.get("alternatives") or []
                if not alts or not alts[0].get("transcript"):
                    continue
                now = (time.perf_counter() - t0) * 1000.0
                if first is None:
                    first = now
                if m.get("is_final"):
                    final = now
                    finals += 1

        feeder = asyncio.create_task(feed())
        reader = asyncio.create_task(read())
        await feeder
        try:
            await asyncio.wait_for(reader, timeout=12)
        except asyncio.TimeoutError:
            reader.cancel()
    return first, final, finals


# Кривая по endpointing. Низкое значение ускоряет первую гипотезу, но дробит
# речь на множество финалов — а каждый финал у нас закрывает реплику и уходит
# отдельной единицей перевода. Смотрим ОБА числа сразу, иначе выберем скорость
# ценой той самой каши, которую чинили сегодня утром.
VARIANTS = [("endpointing %d" % e,
             "model=nova-3&language=ru&punctuate=true&endpointing=%d" % e)
            for e in (10, 50, 100, 200, 300, 500)]


async def main() -> None:
    for k in ("CARTESIA_API_KEY", "CARTESIA_VOICE_RU", "DEEPGRAM_API_KEY"):
        if not os.environ.get(k):
            sys.exit(f"ОСТАНОВ: нет {k}")

    async with aiohttp.ClientSession() as session:
        pcm = await synth(session, PHRASE)
        lead = leading_silence_ms(pcm)
        dur = len(pcm) / 2 / RATE * 1000.0
        print(f"запись: {dur:.0f} мс, из них тишины в начале: {lead:.0f} мс\n")

        # Обрезаем тишину: дальше время считается от РЕЧИ, а не от начала файла.
        trimmed = pcm[int(lead / 1000 * RATE) * 2:]

        # ПОВТОРЫ ОБЯЗАТЕЛЬНЫ. Первый прогон дал 984 против 781 мс и соблазн
        # объявить победителя; контрольный запуск той же конфигурации разошёлся
        # с собой на 446 мс. На одном замере здесь нельзя утверждать ничего.
        REPEATS = 5
        import statistics as st
        print("%-38s %11s %9s %9s" % ("вариант", "первая (мед)", "разброс", "финалов"))
        print("-" * 72)
        for label, params in VARIANTS:
            got, fins = [], []
            for _ in range(REPEATS):
                f, _fin, nf = await listen(session, trimmed, params)
                if f is not None:
                    got.append(f); fins.append(nf)
            if not got:
                print("%-38s %11s" % (label, "нет данных")); continue
            spread = max(got) - min(got)
            print("%-38s %8.0f мс %6.0f мс %8.1f" % (
                label, st.median(got), spread, st.median(fins) if fins else -1))

if __name__ == "__main__":
    asyncio.run(main())
