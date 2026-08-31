"""Синтез сфабрикованных прошлых разговоров: Cartesia /tts/bytes, два клона.

Муж — клон Alex (голос основателя, одобрен 24.08), жена — клон Ellen
(одобрен 24.08). Реплики → WAV 16 кГц (по одной + склейка на звонок).
Аудио остаётся в ~/SameVoice-corpus/loaded-calls/ — вне git.
"""
import json
import subprocess
import sys
import time
import wave
from pathlib import Path

ROOT = Path("/Users/davidov/SameVoice-corpus/loaded-calls")
KEY = sys.argv[1]
VOICES = {"m": "ec615c0f-9227-4e62-b46b-deed6e9ada2f",   # Alex
          "f": "551928c5-3a69-41ff-abfb-e7a268fc5b21"}   # Ellen
SR = 16000

data = json.loads((ROOT / "dialogues.json").read_text(encoding="utf-8"))
total_chars = 0
for call in data["calls"]:
    cdir = ROOT / call["id"]
    cdir.mkdir(exist_ok=True)
    pcm_all = b""
    for i, utt in enumerate(call["utterances"], start=1):
        out = cdir / f"utt{i:02d}-{utt['sp']}.wav"
        if out.exists():
            with wave.open(str(out), "rb") as r:
                pcm_all += r.readframes(r.getnframes()) + b"\x00" * (SR // 2 * 2)
            continue
        body = json.dumps({
            "model_id": "sonic-3.5-2026-05-04",
            "transcript": utt["text"],
            "voice": {"mode": "id", "id": VOICES[utt["sp"]]},
            "language": "ru",
            "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": SR},
        })
        proc = subprocess.run(
            ["curl", "-sS", "--max-time", "60", "-X", "POST",
             "https://api.cartesia.ai/tts/bytes",
             "-H", "Cartesia-Version: 2025-04-16",
             "-H", f"X-API-Key: {KEY}",
             "-H", "Content-Type: application/json",
             "--data-binary", "@-"],
            input=body.encode(), capture_output=True)
        pcm = proc.stdout
        if proc.returncode != 0 or len(pcm) < 2000 or pcm[:1] == b"{":
            print(f"ОШИБКА {call['id']}/{i}: {pcm[:200]!r}", file=sys.stderr)
            sys.exit(1)
        with wave.open(str(out), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
            w.writeframes(pcm)
        total_chars += len(utt["text"])
        pcm_all += pcm + b"\x00" * (SR // 2 * 2)  # пауза 0.5 с между репликами
        time.sleep(0.2)
    with wave.open(str(ROOT / f"{call['id']}.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm_all)
    print(f"{call['id']}: {len(call['utterances'])} реплик, {len(pcm_all)/2/SR:.1f} c")
print(f"синтезировано символов: {total_chars}")
