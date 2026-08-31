#!/usr/bin/env python3
"""Cost-only benchmark for the local batch TTS service (gpu.tts.app, port 8104).

Answers one question with numbers: what does locally-hosted synthesis charge
per word and per phrase, and can it afford the speculative case -- burning
several candidate words per committed word? Quality (voice similarity, Hebrew
naturalness) is NOT measured here; that is the founder's ear on saved samples.

The service is batch-labelled: latency here IS time-to-full-audio. There is no
streaming TTFA to report, and pretending otherwise would flatter the engine.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def post(url: str, payload: dict, timeout: float) -> tuple[bytes, dict[str, str], float]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
            headers = {k: v for k, v in response.headers.items()}
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"request failed for {url}: {exc}") from exc
    return raw, headers, (time.perf_counter() - started) * 1000.0


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * fraction)))
    return ordered[index]


def summarize(values: list[float]) -> dict[str, float]:
    return {
        "n": len(values),
        "p50_ms": round(percentile(values, 0.50), 1),
        "p90_ms": round(percentile(values, 0.90), 1),
        "p95_ms": round(percentile(values, 0.95), 1),
        "min_ms": round(min(values), 1),
        "max_ms": round(max(values), 1),
        "mean_ms": round(statistics.fmean(values), 1),
    }


CASES = [
    # Одно слово -- цена спекулятивного кандидата в схеме основателя.
    {"name": "ru_word", "lang": "ru", "text": "выплата"},
    {"name": "he_word", "lang": "he", "text": "תשלום"},
    # Фразы совпадают с scripts/runpod-stage1-bench.py, чтобы стадии цепочки
    # сравнивались на одном и том же материале.
    {"name": "ru_phrase", "lang": "ru", "text": "Я хочу узнать, когда поступит следующая выплата."},
    {"name": "he_phrase", "lang": "he", "text": "אני רוצה לדעת מתי ייכנס התשלום הבא."},
]

# Спекулятивный кейс: сжечь пачку кандидатов на одно слово. Слова разные,
# чтобы кеширование (если оно вдруг появится в движке) не польстило числам.
BURST_WORDS = {
    "ru": ["выплата", "платёж", "пенсия", "пособие", "зарплата", "перевод"],
    "he": ["תשלום", "קצבה", "משכורת", "העברה", "פנסיה", "חשבון"],
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tts-url", default=os.getenv("LOCAL_TTS_URL", "http://127.0.0.1:8104"))
    parser.add_argument("--iterations", type=int, default=10)
    parser.add_argument("--warmup-iterations", type=int, default=2)
    parser.add_argument("--burst-size", type=int, default=6,
                        help="candidate words burned per speculative burst (default 6)")
    parser.add_argument("--request-timeout", type=float, default=300.0)
    parser.add_argument("--warmup-timeout", type=float, default=1800.0,
                        help="first warmup downloads model weights")
    parser.add_argument("--output", default="/workspace/out/results/tts-cost.json")
    args = parser.parse_args()

    base = args.tts_url.rstrip("/")
    print("SameVoice local TTS cost benchmark (batch engine -- latency IS full-audio time)")

    raw, _, warm_ms = post(f"{base}/v1/warmup", {}, args.warmup_timeout)
    warmup = json.loads(raw.decode("utf-8"))
    print(f"warmup: {json.dumps(warmup, ensure_ascii=False)} ({warm_ms:.0f} ms round trip)")

    results: dict[str, object] = {}
    for case in CASES:
        name, lang, text = case["name"], case["lang"], case["text"]
        payload = {"text": text, "lang": lang}
        for _ in range(args.warmup_iterations):
            post(f"{base}/v1/synthesize", payload, args.request_timeout)
        lat, rtt, durations = [], [], []
        for _ in range(args.iterations):
            pcm, headers, round_trip = post(f"{base}/v1/synthesize", payload, args.request_timeout)
            # uvicorn/h11 нормализует имена заголовков в нижний регистр --
            # поиск точного CamelCase дал нули по всем кейсам (под
            # b0jxilt07hcur3, 31.08). Ищем без учёта регистра.
            hl = {k.lower(): v for k, v in headers.items()}
            server_ms = float(hl.get("x-samevoice-latency-ms", "0"))
            sr = int(hl.get("x-samevoice-sample-rate", "0") or 0)
            audio_ms = (len(pcm) / 2 / sr * 1000.0) if sr else 0.0
            lat.append(server_ms)
            rtt.append(round_trip)
            durations.append(audio_ms)
        audio_p50 = percentile(durations, 0.5)
        lat_p50 = percentile(lat, 0.5)
        results[name] = {
            "text": text,
            "lang": lang,
            "chars": len(text),
            "server_latency_ms": summarize(lat),
            "round_trip_ms": summarize(rtt),
            "audio_duration_ms_p50": round(audio_p50, 1),
            # RTF < 1 означает "генерирует быстрее, чем звучит".
            "rtf_p50": round(lat_p50 / audio_p50, 3) if audio_p50 else None,
        }
        print(f"  {name:10s} latency p50 {lat_p50:8.1f} ms | audio {audio_p50:7.1f} ms | rtf {results[name]['rtf_p50']}")

    for lang, words in BURST_WORDS.items():
        words = words[: args.burst_size]
        totals = []
        for _ in range(max(3, args.iterations // 2)):
            started = time.perf_counter()
            for word in words:
                post(f"{base}/v1/synthesize", {"text": word, "lang": lang}, args.request_timeout)
            totals.append((time.perf_counter() - started) * 1000.0)
        results[f"{lang}_burst{len(words)}"] = {
            "words": words,
            "total_ms": summarize(totals),
            "note": "последовательное сжигание кандидатов; батчинга в движке нет",
        }
        print(f"  {lang}_burst{len(words)}  total p50 {percentile(totals, 0.5):8.1f} ms")

    artifact = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "script": "scripts/tts-cost-bench.py",
        "engine": "ResembleAI/chatterbox (Multilingual V3, batch)",
        "not_measured_here": [
            "voice similarity / cloning quality (founder's ear on samples)",
            "cloning-prompt overhead (builtin voice only; no reference WAV is shipped to a pod)",
            "streaming TTFA (engine is batch by design)",
        ],
        "config": {
            "iterations": args.iterations,
            "burst_size": args.burst_size,
            "tts_url": base,
        },
        "warmup": warmup,
        "results": results,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"saved: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
