"""Слышен ли шов между кусками синтеза — четыре файла на прослушивание.

ЗАЧЕМ. Инкрементальный перевод (см. eval/mt/INCREMENTAL.md) выдаёт перевод
кусками по 3-5 слов. Значит синтезировать их придётся отдельно и склеивать —
а отдельно синтезированный кусок приклеивается к предыдущему с другой
интонацией и слышным стыком. Если шов слышен, схема разваливается не по счёту,
а по звуку.

Решение основателя: закрывать стык НЕЛЕКСИЧЕСКИМ заполнителем — вдохом, «אה».
Ухо ожидает, что после запинки просодия начнётся заново, поэтому шов за ней не
слышен. Лексические заполнители («знаешь», «יעני») запрещены намеренно: это
слова, человек их не говорил, и вкладывать их ему в рот нельзя.

Четыре файла, слушать подряд:
  1_whole   — фраза целиком, эталон
  2_butt    — три куска встык, без ничего
  3_silence — три куска с паузой 180 мс
  4_filler  — три куска с «אה» на стыке
"""
from __future__ import annotations
import asyncio, os, struct, sys, wave

import aiohttp

RATE = 24000  # родная частота Cartesia: не даём ресемплеру портить сравнение
CARTESIA = "https://api.cartesia.ai/tts/bytes"
OUT = os.environ.get("OUT_DIR", "/tmp/seams")

PHRASE = "את בכלל לא שומעת אותי, כשאת פשוט מדברת בשקט"
CHUNKS = ["את בכלל לא שומעת אותי,", "כשאת פשוט", "מדברת בשקט"]
FILLER = "אה"


async def synth(session, text: str) -> bytes:
    body = {
        "model_id": os.environ.get("CARTESIA_MODEL", "sonic-3.5-2026-05-04"),
        "transcript": text,
        "voice": {"mode": "id", "id": os.environ["CARTESIA_VOICE_HE"]},
        "language": "he",
        "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": RATE},
    }
    async with session.post(
        CARTESIA, json=body,
        headers={"X-API-Key": os.environ["CARTESIA_API_KEY"], "Cartesia-Version": "2025-04-16"},
    ) as r:
        if r.status != 200:
            raise RuntimeError(f"cartesia {r.status}: {(await r.text())[:200]}")
        return await r.read()


def silence(ms: int) -> bytes:
    return b"\x00\x00" * int(RATE * ms / 1000)


def save(name: str, pcm: bytes) -> None:
    path = os.path.join(OUT, name + ".wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    print(f"{path}  {len(pcm)/2/RATE:.2f} с")


async def main() -> None:
    for k in ("CARTESIA_API_KEY", "CARTESIA_VOICE_HE"):
        if not os.environ.get(k):
            sys.exit(f"ОСТАНОВ: нет {k}")
    os.makedirs(OUT, exist_ok=True)

    async with aiohttp.ClientSession() as session:
        whole = await synth(session, PHRASE)
        save("1_whole", whole)

        parts = [await synth(session, c) for c in CHUNKS]
        save("2_butt", b"".join(parts))
        save("3_silence", (silence(180)).join(parts))

        filler = await synth(session, FILLER)
        # Заполнитель обрамляем короткими паузами: живая запинка не приклеена
        # вплотную к словам, и без этих 60 мс она звучит как ещё одно слово.
        glue = silence(60) + filler + silence(60)
        save("4_filler", glue.join(parts))

        print(f"\nфраза: {PHRASE}")
        print("куски: " + " | ".join(CHUNKS))


if __name__ == "__main__":
    asyncio.run(main())
