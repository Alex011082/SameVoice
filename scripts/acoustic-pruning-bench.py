#!/usr/bin/env python3
"""Probe how quickly short audio windows re-rank next-word candidates.

Input WAV must contain the target word starting at (or very near) sample zero.
This is intentionally an offline/component benchmark: live word-onset capture is
a separate integration step after the acoustic scorer proves useful.
"""

from __future__ import annotations

import argparse
import base64
import json
import urllib.request
import wave
from pathlib import Path
from typing import Any


def load_candidates(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        payload = payload.get("candidates")
    if not isinstance(payload, list) or not payload:
        raise SystemExit("candidate JSON must be a non-empty list or {candidates:[...]}")
    result: list[dict[str, Any]] = []
    for item in payload:
        if isinstance(item, str):
            result.append({"word": item, "probability": 0.0})
        elif isinstance(item, dict) and isinstance(item.get("word"), str):
            probability = item.get("probability", 0.0)
            result.append(
                {
                    "word": item["word"],
                    "probability": float(probability) if isinstance(probability, (int, float)) else 0.0,
                }
            )
    if not result:
        raise SystemExit("candidate JSON contains no valid words")
    return result


def load_pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        if channels != 1 or width != 2 or rate != 16000:
            raise SystemExit(
                f"{path}: expected 16 kHz mono signed-16 PCM WAV; got "
                f"{rate} Hz, {channels}ch, {width * 8}-bit"
            )
        return wav.readframes(wav.getnframes())


def post_json(url: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not isinstance(result, dict):
        raise RuntimeError("pruner returned non-object JSON")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", required=True, type=Path)
    parser.add_argument("--candidates", required=True, type=Path)
    parser.add_argument("--truth", required=True)
    parser.add_argument("--lang", required=True, choices=("ru", "he"))
    parser.add_argument(
        "--windows",
        default="50,100,150,200,250",
        help="comma-separated milliseconds from word onset",
    )
    parser.add_argument("--url", default="http://127.0.0.1:8105/v1/prune")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    pcm = load_pcm(args.wav)
    candidates = load_candidates(args.candidates)
    windows = sorted({int(value) for value in args.windows.split(",") if value.strip()})
    if not windows or windows[0] <= 0:
        raise SystemExit("windows must contain positive millisecond values")

    rows: list[dict[str, Any]] = []
    for window_ms in windows:
        sample_bytes = min(len(pcm), window_ms * 16000 // 1000 * 2)
        # s16 samples must never be split mid-sample.
        sample_bytes -= sample_bytes % 2
        if sample_bytes <= 0:
            continue
        response = post_json(
            args.url,
            {
                "lang": args.lang,
                "pcm_s16le_b64": base64.b64encode(pcm[:sample_bytes]).decode("ascii"),
                "candidates": candidates,
            },
        )
        ranked = response.get("ranked") if isinstance(response.get("ranked"), list) else []
        truth_rank = next(
            (
                item.get("rank")
                for item in ranked
                if isinstance(item, dict)
                and str(item.get("word", "")).casefold() == args.truth.casefold()
            ),
            None,
        )
        rows.append(
            {
                "windowMs": window_ms,
                "truth": args.truth,
                "truthRank": truth_rank,
                "retained": {
                    "top3": isinstance(truth_rank, int) and truth_rank <= 3,
                    "top5": isinstance(truth_rank, int) and truth_rank <= 5,
                    "top10": isinstance(truth_rank, int) and truth_rank <= 10,
                    "top20": isinstance(truth_rank, int) and truth_rank <= 20,
                },
                "evidence": response.get("evidence"),
                "rawEvidence": response.get("raw_evidence"),
                "inferenceMs": response.get("inference_ms"),
                "top5": ranked[:5],
            }
        )

    report = {
        "lang": args.lang,
        "wav": str(args.wav),
        "truth": args.truth,
        "candidateCount": len(candidates),
        "rows": rows,
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
