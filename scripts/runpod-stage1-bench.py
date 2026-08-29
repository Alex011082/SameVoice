#!/usr/bin/env python3
"""Benchmark the first local THINK services from inside the R&D Pod.

No third-party Python packages are required. The script warms the predictor and
both Marian directions, runs repeat requests over loopback HTTP, and writes a
JSON artifact under /workspace/benchmarks (or BENCHMARK_DIR).
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


def post_json(url: str, payload: dict | None = None, timeout: float = 120.0) -> tuple[dict, float]:
    body = json.dumps(payload or {}).encode("utf-8")
    request = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"HTTP {exc.code} from {url}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"request failed for {url}: {exc}") from exc
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError(f"expected JSON object from {url}")
    return data, elapsed_ms


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * fraction)))
    return ordered[index]


def summary(values: list[float]) -> dict[str, float]:
    return {
        "p50_ms": round(statistics.median(values), 3),
        "p90_ms": round(percentile(values, 0.90), 3),
        "p95_ms": round(percentile(values, 0.95), 3),
        "min_ms": round(min(values), 3),
        "max_ms": round(max(values), 3),
    }


def benchmark_case(url: str, payload: dict, iterations: int) -> dict:
    observed: list[float] = []
    server: list[float] = []
    last: dict = {}
    for _ in range(iterations):
        last, elapsed = post_json(url, payload, timeout=30.0)
        observed.append(elapsed)
        value = last.get("latency_ms")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            server.append(float(value))
    result = {"loopback": summary(observed), "last_response": last}
    if server:
        result["server_inference"] = summary(server)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=7)
    args = parser.parse_args()
    if args.iterations < 3:
        parser.error("--iterations must be >= 3")

    predictor = os.getenv("PREDICTOR_URL", "http://127.0.0.1:8101").rstrip("/")
    mt = os.getenv("LOCAL_MT_URL", os.getenv("RUNPOD_MT_URL", "http://127.0.0.1:8103")).rstrip("/")

    print("warming predictor (first run may download model weights)...", flush=True)
    predictor_warm, predictor_warm_ms = post_json(f"{predictor}/v1/warmup", timeout=600.0)
    print(json.dumps(predictor_warm, ensure_ascii=False), flush=True)

    print("warming local MT directions (first run may download model weights)...", flush=True)
    mt_warm, mt_warm_ms = post_json(f"{mt}/v1/warmup", timeout=600.0)
    print(json.dumps(mt_warm, ensure_ascii=False), flush=True)

    cases = {
        "predict_ru": (
            f"{predictor}/v1/predict",
            {
                "prefix": "мне нужно узнать когда будет",
                "lang": "ru",
                "top_k": 20,
                "context_terms": ["выплата", "платёж", "пенсия", "пособие"],
            },
        ),
        "predict_he": (
            f"{predictor}/v1/predict",
            {
                "prefix": "אני רוצה לדעת מתי יהיה",
                "lang": "he",
                "top_k": 20,
                "context_terms": ["תשלום", "קצבה", "זכאות", "חשבון"],
            },
        ),
        "mt_ru_he": (
            f"{mt}/v1/translate",
            {"text": "Я хочу узнать, когда поступит следующая выплата.", "src_lang": "ru", "dst_lang": "he"},
        ),
        "mt_he_ru": (
            f"{mt}/v1/translate",
            {"text": "אני רוצה לדעת מתי ייכנס התשלום הבא.", "src_lang": "he", "dst_lang": "ru"},
        ),
    }

    results: dict[str, object] = {}
    for name, (url, payload) in cases.items():
        print(f"benchmarking {name} x{args.iterations}...", flush=True)
        results[name] = benchmark_case(url, payload, args.iterations)

    artifact = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "iterations": args.iterations,
        "warmup": {
            "predictor_loopback_ms": round(predictor_warm_ms, 3),
            "predictor": predictor_warm,
            "mt_loopback_ms": round(mt_warm_ms, 3),
            "mt": mt_warm,
        },
        "results": results,
    }

    out_dir = Path(os.getenv("BENCHMARK_DIR", "/workspace/benchmarks"))
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = out_dir / f"stage1-think-{stamp}.json"
    output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(artifact, ensure_ascii=False, indent=2))
    print(f"saved: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
