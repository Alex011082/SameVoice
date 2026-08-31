#!/usr/bin/env python3
"""Text-only recall of the next-word predictor on a scripted line set.

No audio and no pruner: measures ONLY whether the truth word appears in the
predictor's Top-K for the scripted prefix. This is the cheap first filter for
the model ladder (eval/gpu-cost/RESULT.md, эксп. 5б): a candidate source that
fails here has nothing for acoustics to verify, so the full replay bench
(audio + onsets + pruner) is not owed to it.

Line sets are JSON: [{"id", "prefix", "truth", "contextTerms", "context_note"}].
--use-context forwards context_note to the service (works in chat mode only);
without the flag the same lines run context-free — that difference IS the
measured value of the founder's context tricks (docs/15).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.request import Request, urlopen


def post(url: str, payload: dict, timeout: float) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def norm(w: str) -> str:
    return w.strip().casefold().replace("ё", "е")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lines", required=True, help="JSON-файл со строками")
    ap.add_argument("--predictor-url", default="http://127.0.0.1:8101")
    ap.add_argument("--top-k", type=int, default=50)
    ap.add_argument("--use-context", action="store_true")
    ap.add_argument("--timeout-s", type=float, default=120.0)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    lines = json.loads(Path(args.lines).read_text(encoding="utf-8"))
    health = json.loads(
        urlopen(f"{args.predictor_url.rstrip('/')}/healthz", timeout=30).read().decode()
    )
    print(f"модель: {health.get('model')} | режим: {health.get('prompt_style')} | "
          f"контекст: {'да' if args.use_context else 'нет'} | строк: {len(lines)}")

    rows = []
    for line in lines:
        payload = {
            "prefix": line["prefix"],
            "lang": line.get("lang", "ru"),
            "top_k": args.top_k,
            "context_terms": line.get("contextTerms", []),
        }
        if args.use_context:
            payload["context_note"] = line.get("context_note", "")
        t0 = time.perf_counter()
        resp = post(f"{args.predictor_url.rstrip('/')}/v1/predict", payload, args.timeout_s)
        rtt = (time.perf_counter() - t0) * 1000.0
        truth = norm(line["truth"])
        rank = None
        for idx, cand in enumerate(resp.get("candidates", []), start=1):
            if norm(cand.get("word", "")) == truth:
                rank = idx
                break
        rows.append({
            "id": line["id"], "truth": line["truth"], "rank": rank,
            "roundTripMs": round(rtt, 1),
            "candidates": [c.get("word") for c in resp.get("candidates", [])][:20],
        })
        mark = f"ранг {rank}" if rank else "мимо"
        print(f"  {line['id']:12s} {mark:8s} {line['truth']}")

    n = len(rows)
    ranks = [r["rank"] for r in rows if r["rank"] is not None]
    recall = {f"top{k}": round(sum(1 for r in ranks if r <= k) / n, 4)
              for k in (1, 3, 5, 10, 20, 50)}
    rtts = sorted(r["roundTripMs"] for r in rows)
    summary = {
        "n": n,
        "hits": len(ranks),
        "recall": recall,
        "rtt_p50_ms": rtts[len(rtts) // 2] if rtts else None,
        "model": health.get("model"),
        "prompt_style": health.get("prompt_style"),
        "use_context": args.use_context,
        "lines_file": Path(args.lines).name,
    }
    print("recall:", json.dumps(recall, ensure_ascii=False), f"| попаданий {len(ranks)}/{n}")
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1),
                   encoding="utf-8")
    print(f"saved: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
