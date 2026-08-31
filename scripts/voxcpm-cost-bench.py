#!/usr/bin/env python3
"""Cost benchmark for VoxCPM2 (openbmb, Apache-2.0) on a rented GPU.

Closes the measurable half of the admission gate written in
eval/open-hebrew-tts-findings.md: "blind native-speaker test passed AND p90
TTFA <= 250 ms on a rented card". This script produces the TTFA half; the
blind test remains the founder's ear and is NOT measured here.

In-process by design (no HTTP service yet): the question is the ENGINE's cost.
The service wrapper adds ~1-2 ms and can be measured later if the engine passes.

API usage copied from eval/selfhosted/bench.py, which ran successfully on
24.08.2026: streaming chunks are s16le bytes at 24 kHz.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

SAMPLE_RATE = 24000
TTFA_GATE_P90_MS = 250.0  # порог из eval/open-hebrew-tts-findings.md

CASES = [
    # Тексты совпадают с scripts/tts-cost-bench.py (Chatterbox) — сравнение
    # движков только на одинаковом материале.
    {"name": "ru_word", "lang": "ru", "text": "выплата"},
    {"name": "he_word", "lang": "he", "text": "תשלום"},
    {"name": "ru_phrase", "lang": "ru", "text": "Я хочу узнать, когда поступит следующая выплата."},
    {"name": "he_phrase", "lang": "he", "text": "אני רוצה לדעת מתי ייכנס התשלום הבא."},
]

BURST_WORDS = {
    "ru": ["выплата", "платёж", "пенсия", "пособие", "зарплата", "перевод"],
    "he": ["תשלום", "קצבה", "משכורת", "העברה", "פנסיה", "חשבון"],
}


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=6)
    parser.add_argument("--warmup-iterations", type=int, default=2)
    parser.add_argument("--burst-size", type=int, default=6)
    parser.add_argument("--output", default="/workspace/out/results/voxcpm-cost.json")
    args = parser.parse_args()

    print("SameVoice VoxCPM2 cost benchmark (streaming engine — TTFA is real)")
    from voxcpm import VoxCPM

    started = time.perf_counter()
    # Шумодав отключён — тянет modelscope, конфликтующий с transformers
    # в образе RunPod (урок 26.08, eval/selfhosted/setup_pod.sh).
    model = VoxCPM.from_pretrained("openbmb/VoxCPM2", load_denoiser=False)
    load_ms = (time.perf_counter() - started) * 1000.0
    print(f"загрузка модели: {load_ms:.0f} ms")

    def run_once(text: str, lang: str) -> tuple[float, float, float]:
        """(ttfa_ms, total_ms, audio_ms) одного стримингового синтеза."""
        t0 = time.perf_counter()
        first_at = None
        n = 0
        for piece in model.generate_streaming(text=text, language=lang):
            if first_at is None:
                first_at = (time.perf_counter() - t0) * 1000.0
            n += len(piece)
        total_ms = (time.perf_counter() - t0) * 1000.0
        audio_ms = n / 2 / SAMPLE_RATE * 1000.0
        return first_at or 0.0, total_ms, audio_ms

    results: dict[str, object] = {}
    all_ttfa: list[float] = []
    for case in CASES:
        name, lang, text = case["name"], case["lang"], case["text"]
        for _ in range(args.warmup_iterations):
            run_once(text, lang)
        ttfa, totals, durations = [], [], []
        for _ in range(args.iterations):
            f, t, a = run_once(text, lang)
            ttfa.append(f)
            totals.append(t)
            durations.append(a)
        all_ttfa.extend(ttfa)
        audio_p50 = percentile(durations, 0.5)
        total_p50 = percentile(totals, 0.5)
        results[name] = {
            "text": text,
            "lang": lang,
            "ttfa_ms": summarize(ttfa),
            "total_ms": summarize(totals),
            "audio_duration_ms_p50": round(audio_p50, 1),
            "rtf_p50": round(total_p50 / audio_p50, 3) if audio_p50 else None,
        }
        print(
            f"  {name:10s} TTFA p50 {percentile(ttfa, 0.5):7.1f} ms p90 {percentile(ttfa, 0.9):7.1f}"
            f" | total p50 {total_p50:8.1f} | audio {audio_p50:7.1f} | rtf {results[name]['rtf_p50']}"
        )

    # Спекулятивная пачка: сжечь кандидатов на одно слово. Два режима из
    # eval/selfhosted/bench.py: последовательно и с перекрытием prefill.
    for lang, words in BURST_WORDS.items():
        words = words[: args.burst_size]
        seq_totals, ovl_totals = [], []
        rounds = max(3, args.iterations // 2)
        for _ in range(rounds):
            t0 = time.perf_counter()
            for w in words:
                run_once(w, lang)
            seq_totals.append((time.perf_counter() - t0) * 1000.0)
        for _ in range(rounds):
            t0 = time.perf_counter()
            with ThreadPoolExecutor(max_workers=2) as pool:
                pending = pool.submit(run_once, words[0], lang)
                for nxt in words[1:] + [None]:
                    pending.result()
                    if nxt is not None:
                        pending = pool.submit(run_once, nxt, lang)
            ovl_totals.append((time.perf_counter() - t0) * 1000.0)
        results[f"{lang}_burst{len(words)}"] = {
            "words": words,
            "sequential_total_ms": summarize(seq_totals),
            "overlap2_total_ms": summarize(ovl_totals),
        }
        print(
            f"  {lang}_burst{len(words)}  последовательно p50 {percentile(seq_totals, 0.5):8.1f} ms"
            f" | перекрытие x2 p50 {percentile(ovl_totals, 0.5):8.1f} ms"
        )

    gate_p90 = percentile(all_ttfa, 0.9)
    gate_pass = gate_p90 <= TTFA_GATE_P90_MS
    print(f"\nворота допуска (eval/open-hebrew-tts-findings.md): TTFA p90 = {gate_p90:.1f} ms"
          f" против <= {TTFA_GATE_P90_MS:.0f} ms -> {'PASS' if gate_pass else 'FAIL'}")
    print("вторая половина ворот — слепой тест носителем — здесь НЕ измеряется")

    artifact = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "script": "scripts/voxcpm-cost-bench.py",
        "engine": "openbmb/VoxCPM2 (streaming, load_denoiser=False)",
        "sample_rate": SAMPLE_RATE,
        "load_ms": round(load_ms, 1),
        "ttfa_gate": {
            "threshold_p90_ms": TTFA_GATE_P90_MS,
            "measured_p90_ms": round(gate_p90, 1),
            "passed": gate_pass,
            "source": "eval/open-hebrew-tts-findings.md",
        },
        "not_measured_here": [
            "blind native-speaker quality test (the other half of the gate)",
            "voice cloning prompt overhead (builtin voice; no reference WAV shipped to a pod)",
            "per-chunk prefill tax inside a live incremental pipeline (eval/selfhosted/bench.py measures that shape)",
        ],
        "config": {"iterations": args.iterations, "burst_size": args.burst_size},
        "results": results,
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"saved: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
