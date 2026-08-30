"""Чья интонация плохая — клона или движка. Вердикт основателя 28.08.2026:
«интонация везде хуёвая», включая эталонную фразу целиком. Значит дело НЕ в
нарезке на куски — её надо искать отдельно.

Три файла разделяют три подозрения:

  A. клон основателя, фраза целиком      — то, что он слышал
  B. Ayala, единственный ивритский голос — умеет ли движок вообще
     Cartesia (проверено: из 100 голосов каталога ивритский ровно один)
  C. клон, куски с ПРОДОЛЖАЮЩЕЙ пунктуацией — не в ней ли дело

Про C. Кусок без знака в конце синтезатор читает как законченное предложение и
роняет интонацию вниз. В нашем боевом промпте для этого уже есть флаг
`is_continuation`, но в замере швов куски подавались голым текстом. Здесь
незавершённые куски получают многоточие, последний — точку.
"""
from __future__ import annotations
import asyncio, os, sys, wave
import aiohttp

RATE = 24000
URL = "https://api.cartesia.ai/tts/bytes"
OUT = os.environ.get("OUT_DIR", "/tmp/into")
AYALA = "ebc02c0d-61fd-48f2-a6c9-0d6683b7d466"

PHRASE = "את בכלל לא שומעת אותי, כשאת פשוט מדברת בשקט."
CHUNKS_PLAIN = ["את בכלל לא שומעת אותי,", "כשאת פשוט", "מדברת בשקט"]
CHUNKS_CONT = ["את בכלל לא שומעת אותי,", "כשאת פשוט…", "מדברת בשקט."]


async def synth(session, text: str, voice: str) -> bytes:
    body = {
        "model_id": os.environ.get("CARTESIA_MODEL", "sonic-3.5-2026-05-04"),
        "transcript": text,
        "voice": {"mode": "id", "id": voice},
        "language": "he",
        "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": RATE},
    }
    async with session.post(URL, json=body, headers={
            "X-API-Key": os.environ["CARTESIA_API_KEY"],
            "Cartesia-Version": "2025-04-16"}) as r:
        if r.status != 200:
            raise RuntimeError(f"{r.status}: {(await r.text())[:150]}")
        return await r.read()


def save(name: str, pcm: bytes) -> None:
    path = os.path.join(OUT, name + ".wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(pcm)
    print(f"{path}  {len(pcm)/2/RATE:.2f} с")


async def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    clone = os.environ["CARTESIA_VOICE_HE"]
    sil = b"\x00\x00" * int(RATE * 0.18)
    async with aiohttp.ClientSession() as s:
        save("A_clone_whole", await synth(s, PHRASE, clone))
        save("B_ayala_whole", await synth(s, PHRASE, AYALA))
        parts = [await synth(s, c, clone) for c in CHUNKS_CONT]
        save("C_clone_chunks_punct", sil.join(parts))
        parts = [await synth(s, c, clone) for c in CHUNKS_PLAIN]
        save("D_clone_chunks_plain", sil.join(parts))


if __name__ == "__main__":
    asyncio.run(main())
