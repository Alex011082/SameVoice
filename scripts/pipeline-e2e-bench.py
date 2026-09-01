"""Сквозной замер СБОРКИ — «всё сразу, как задумал основатель» (эксп. 14).

Два прогона ОДНОГО аудио в одном поде:

  reference — старая логика: дождаться финала STT, перевести реплику целиком
              (Marian), озвучить целиком (Cartesia, 1.0x).
  assembled — сборка: чанкер с ранним коммитом и фильтром «эээ» (тот самый
              «забрать окно себе»: слова коммитятся, пока говорящий тянет
              звук) -> Marian по кускам, не дожидаясь конца реплики ->
              Cartesia по кускам -> ускорение 1.25x (ffmpeg atempo, высота
              голоса не меняется).

Аудио подаётся В РЕАЛЬНОМ ТЕМПЕ кадрами 20 мс (протокол stt-baseline-bench),
после реплики — хвост тишины и flush. Главная метрика на реплику:
«конец речи -> первый звук перевода» (у сборки первый кусок может уйти в
перевод ДО конца речи — тогда выигрыш виден прямо в знаке слагаемых).
Вторая метрика — «влезание в окно»: длительность озвучки 1.0x против 1.25x
на фоне длительности исходной реплики.

Запуск (на поде, сервисы 8102/8103 подняты, CARTESIA_API_KEY в env):
  python scripts/pipeline-e2e-bench.py --audio-dir /workspace/data/pipeline-test \
      --output /workspace/out/results/pipeline-e2e.json
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent" / "src"))
from speakeasy_agent.chunker import Chunker, ChunkerConfig  # noqa: E402

import urllib.request  # noqa: E402

import websockets  # noqa: E402

STT_URL = os.getenv("STT_URL", "ws://127.0.0.1:8102/v1/stream")
MT_URL = os.getenv("MT_URL", "http://127.0.0.1:8103/v1/translate")
CARTESIA_KEY = os.getenv("CARTESIA_API_KEY", "")
CARTESIA_MODEL = os.getenv("CARTESIA_MODEL", "sonic-3.5-2026-05-04")
# Голос L: синтетический референс, одобрен основателем на ru и he
VOICE = os.getenv("CARTESIA_VOICE", "f247a379-1eb7-4c3f-9ca3-bd5486899190")
FRAME_MS = 20
TAIL_S = 1.5


def mt(text: str) -> tuple[str, float]:
    body = json.dumps({"text": text, "src_lang": "ru", "dst_lang": "he"}).encode()
    t0 = time.perf_counter()
    req = urllib.request.Request(MT_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        out = json.loads(resp.read())
    return out["text"], (time.perf_counter() - t0) * 1000.0


def tts(text: str, path: Path) -> float:
    """Синтез куска; возвращает длительность запроса в мс. Файл — WAV 16k s16."""
    body = json.dumps({
        "model_id": CARTESIA_MODEL, "transcript": text,
        "voice": {"mode": "id", "id": VOICE}, "language": "he",
        "output_format": {"container": "wav", "encoding": "pcm_s16le",
                          "sample_rate": 16000},
    }).encode()
    t0 = time.perf_counter()
    req = urllib.request.Request(
        "https://api.cartesia.ai/tts/bytes", data=body,
        headers={"X-API-Key": CARTESIA_KEY, "Cartesia-Version": "2025-04-16",
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        path.write_bytes(resp.read())
    return (time.perf_counter() - t0) * 1000.0


def wav_seconds(path: Path) -> float:
    raw = path.read_bytes()
    i = raw.find(b"data")
    return (len(raw) - i - 8) / 2 / 16000.0


def atempo(src: Path, dst: Path, factor: float) -> float:
    t0 = time.perf_counter()
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                    "-filter:a", f"atempo={factor}", str(dst)], check=True)
    return (time.perf_counter() - t0) * 1000.0


async def stream_utterance(wav_path: Path):
    """Подать WAV в реальном темпе; вернуть события (t_рел_мс, тип, текст)
    и длительность речи. t отсчитывается от начала подачи."""
    with wave.open(str(wav_path), "rb") as r:
        assert r.getframerate() == 16000 and r.getnchannels() == 1
        pcm = r.readframes(r.getnframes())
    speech_s = len(pcm) / 2 / 16000.0
    frame_bytes = 16000 * FRAME_MS // 1000 * 2
    events: list[tuple[float, str, str]] = []
    t0 = time.perf_counter()

    async with websockets.connect(STT_URL, max_size=None) as ws:
        await ws.send(json.dumps({"type": "start", "lang": "ru",
                                  "sample_rate": 16000, "channels": 1}))

        async def reader():
            try:
                async for raw in ws:
                    if isinstance(raw, bytes):
                        continue
                    msg = json.loads(raw)
                    if msg.get("type") in ("partial", "final"):
                        events.append(((time.perf_counter() - t0) * 1000.0,
                                       msg["type"], msg.get("text", "")))
            except websockets.ConnectionClosed:
                pass

        task = asyncio.create_task(reader())
        for i in range(0, len(pcm), frame_bytes):
            await ws.send(pcm[i:i + frame_bytes])
            target = t0 + (i + frame_bytes) / 2 / 16000.0
            delay = target - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
        silence = b"\x00" * frame_bytes
        for _ in range(int(TAIL_S * 1000 / FRAME_MS)):
            await ws.send(silence)
            await asyncio.sleep(FRAME_MS / 1000.0)
        await ws.send(json.dumps({"type": "flush"}))
        await asyncio.sleep(0.7)
        task.cancel()
    return events, speech_s * 1000.0


def run_reference(events, speech_ms, tmp: Path, idx: int) -> dict:
    """Старая логика: дождаться ВСЕХ финалов -> перевод целиком -> озвучка.

    Nemotron отдаёт финалы посегментно (и режет их по затяжкам «эээ»), поэтому
    реплика целиком = склейка всех финалов, а момент готовности текста —
    ПОСЛЕДНИЙ финал. Первая версия скрипта брала только последний сегмент и
    льстила референсу дважды: короче текст и раньше готов.
    """
    finals = [(t, x) for t, k, x in events if k == "final" and x.strip()]
    if finals:
        t_final = finals[-1][0]
        text = " ".join(x for _, x in finals)
    else:  # финала не было — берём последний partial (честно помечаем)
        t_final, text = next(((t, x) for t, k, x in reversed(events) if x.strip()),
                             (speech_ms, ""))
    if not text:
        return {"error": "STT ничего не отдал"}
    he, mt_ms = mt(text)
    p = tmp / f"ref-{idx:02d}.wav"
    tts_ms = tts(he, p)
    dur = wav_seconds(p)
    return {
        "sttText": text, "mtText": he,
        "tFinalMs": round(t_final - speech_ms, 1),   # от конца речи
        "mtMs": round(mt_ms, 1), "ttsMs": round(tts_ms, 1),
        "firstAudioAfterSpeechMs": round((t_final - speech_ms) + mt_ms + tts_ms, 1),
        "audioS": round(dur, 2),
    }


def run_assembled(events, speech_ms, tmp: Path, idx: int) -> dict:
    """Сборка: чанкер по партиалам -> перевод и озвучка по кускам -> 1.25x.

    Хронология честная: коммит случается в момент t события, породившего его;
    перевод и озвучка куска стоят своё замеренное время. Первый звук =
    t_первого_коммита + mt + tts + atempo этого куска.
    """
    ch = Chunker(ChunkerConfig())
    commits: list[tuple[float, str]] = []
    for t, kind, text in events:
        now = t / 1000.0
        units = ch.on_final(text, now) if kind == "final" else ch.on_partial(text, now)
        for u in units:
            commits.append((t, u.text))
    # финала могло не быть: закрываем реплику синтетическим финалом из
    # последней гипотезы — у чанкера финал провайдера и есть слив остатка
    if ch.has_pending and events:
        t_last, _, _ = events[-1]
        last_text = next((x for _, _, x in reversed(events) if x.strip()), "")
        for u in ch.on_final(last_text, t_last / 1000.0):
            commits.append((t_last, u.text))
    if not commits:
        return {"error": "чанкер ничего не закоммитил"}
    rows, audio_s, audio_fast_s = [], 0.0, 0.0
    first_audio = None
    for k, (t_commit, text) in enumerate(commits):
        he, mt_ms = mt(text)
        p = tmp / f"asm-{idx:02d}-{k}.wav"
        tts_ms = tts(he, p)
        pf = tmp / f"asm-{idx:02d}-{k}-fast.wav"
        at_ms = atempo(p, pf, 1.25)
        audio_s += wav_seconds(p)
        audio_fast_s += wav_seconds(pf)
        ready = t_commit + mt_ms + tts_ms + at_ms
        if first_audio is None:
            first_audio = ready
        rows.append({"chunk": text, "he": he, "tCommitMs": round(t_commit - speech_ms, 1),
                     "mtMs": round(mt_ms, 1), "ttsMs": round(tts_ms, 1),
                     "atempoMs": round(at_ms, 1)})
    return {
        "chunks": rows, "fillersDropped": ch.fillers_dropped,
        "firstCommitAfterSpeechMs": round(commits[0][0] - speech_ms, 1),
        "firstAudioAfterSpeechMs": round(first_audio - speech_ms, 1),
        "audioS": round(audio_s, 2), "audioFastS": round(audio_fast_s, 2),
        "speechS": round(speech_ms / 1000.0, 2),
    }


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    audio = Path(args.audio_dir)
    tmp = Path(args.output).parent / "pipeline-audio"
    tmp.mkdir(parents=True, exist_ok=True)
    meta = json.load(open(audio / "meta.json"))

    out = {"utterances": []}
    for idx, m in enumerate(meta["utterances"]):
        wav = audio / f"{m['id']}.wav"
        print(f"--- {m['id']}: подача в реальном темпе ({m['durationS']} с)", flush=True)
        events, speech_ms = await stream_utterance(wav)
        rec = {"id": m["id"], "truthText": m["text"],
               "events": len(events),
               "reference": run_reference(events, speech_ms, tmp, idx),
               "assembled": run_assembled(events, speech_ms, tmp, idx)}
        out["utterances"].append(rec)
        r, a = rec["reference"], rec["assembled"]
        print(json.dumps({"id": m["id"],
                          "ref_first_audio": r.get("firstAudioAfterSpeechMs"),
                          "asm_first_audio": a.get("firstAudioAfterSpeechMs"),
                          "fillers": a.get("fillersDropped")},
                         ensure_ascii=False), flush=True)

    def med(vals):
        vals = sorted(v for v in vals if v is not None)
        return vals[len(vals) // 2] if vals else None
    refs = [u["reference"].get("firstAudioAfterSpeechMs") for u in out["utterances"]]
    asms = [u["assembled"].get("firstAudioAfterSpeechMs") for u in out["utterances"]]
    out["summary"] = {
        "n": len(out["utterances"]),
        "refFirstAudioP50": med(refs), "asmFirstAudioP50": med(asms),
        "speedFactor": 1.25,
    }
    json.dump(out, open(args.output, "w"), ensure_ascii=False, indent=1)
    print("summary:", json.dumps(out["summary"], ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
