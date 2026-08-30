"""Пауза как ресурс: обрезаем длинную паузу и тратим освободившееся время.

ИДЕЯ ОСНОВАТЕЛЯ (28.08.2026). В длинной реплике человек молчит по 2-3 секунды.
В переводе это мёртвый эфир — но эфир, принадлежащий НАМ. Сжав паузу до 0.8-1.0 с
и прикрыв стык нелексической запинкой, мы возвращаем 1-2 секунды накопленного
отставания. Заполнители должны быть РАЗНЫЕ: один и тот же звук на каждой паузе
превращается в тик и становится заметнее самой паузы.

Три файла:
  P1_original  — как есть: пауза 2.5 с
  P2_cut       — пауза обрезана до 0.9 с, без ничего
  P3_cut_filler— пауза обрезана до 0.9 с, внутри неё запинка
И отдельно набор запинок, чтобы основатель выбрал годные.
"""
from __future__ import annotations
import asyncio, os, wave
import aiohttp

RATE = 24000
URL = "https://api.cartesia.ai/tts/bytes"
OUT = os.environ.get("OUT_DIR", "/tmp/pauses")

PART1 = "אז תשמעי, דיברתי איתם אתמול בערב על כל הסיפור הזה,"
PART2 = "והם אמרו שהם יחזרו אלינו עד סוף השבוע."
# Нелексические — звуки, а не слова. Лексические («знаешь», «יעני») запрещены:
# человек их не говорил, и вкладывать ему в рот слова продукт не имеет права.
FILLERS = {"eh": "אה", "em": "אממ", "hm": "המ", "breath": "הההה"}


async def synth(session, text, voice):
    body = {"model_id": os.environ.get("CARTESIA_MODEL", "sonic-3.5-2026-05-04"),
            "transcript": text, "voice": {"mode": "id", "id": voice}, "language": "he",
            "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": RATE}}
    async with session.post(URL, json=body, headers={
            "X-API-Key": os.environ["CARTESIA_API_KEY"],
            "Cartesia-Version": "2025-04-16"}) as r:
        if r.status != 200:
            raise RuntimeError(f"{r.status}: {(await r.text())[:120]}")
        return await r.read()


def sil(ms): return b"\x00\x00" * int(RATE * ms / 1000)


def save(name, pcm):
    p = os.path.join(OUT, name + ".wav")
    with wave.open(p, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(pcm)
    print(f"{p}  {len(pcm)/2/RATE:.2f} с")


async def main():
    os.makedirs(OUT, exist_ok=True)
    v = os.environ["CARTESIA_VOICE_HE"]
    async with aiohttp.ClientSession() as s:
        a = await synth(s, PART1, v)
        b = await synth(s, PART2, v)
        save("P1_original", a + sil(2500) + b)
        save("P2_cut", a + sil(900) + b)
        f = await synth(s, FILLERS["em"], v)
        # запинка внутри укороченной паузы, с воздухом с обеих сторон
        save("P3_cut_filler", a + sil(250) + f + sil(250) + b)
        for name, text in FILLERS.items():
            save("F_" + name, sil(150) + await synth(s, text, v) + sil(150))


if __name__ == "__main__":
    asyncio.run(main())
