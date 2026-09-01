"""Разбор одного звонка по evallog: задержки, провайдеры, срывы, вердикты.

Зачем: после живого звонка нужен ответ «сколько было на самом деле и где
съедено» одной командой, а не археология по jsonl. Считает раскладку задержки
по стадиям (p50/p95), отдельно по направлениям RU->HE и HE->RU, показывает
ошибки, обрывы и пометки судьи.

Запуск:
    python3 scripts/call-review-latency.py <c_XXXX.jsonl>
    python3 scripts/call-review-latency.py --newest   # свежайший на сервере
                                                      # (scp с samevoice сам)
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

FIELDS = [
    ("speech_start_to_first_partial_ms", "речь → первый частичный STT", True),
    ("first_partial_to_commit_ms", "частичный → фиксация куска", False),
    ("commit_to_mt_done_ms", "фиксация → перевод готов", False),
    ("mt_provider_latency_ms", "  из них сам переводчик", False),
    ("mt_done_to_first_audio_ms", "перевод → первый звук", False),
    ("speech_start_to_first_audio_ms", "РЕЧЬ → ПЕРВЫЙ ЗВУК (сквозная)", True),
]


def pct(vals, q):
    if not vals:
        return None
    vals = sorted(vals)
    i = max(0, min(len(vals) - 1, round(q * (len(vals) - 1))))
    return vals[i]


def fmt(v):
    return f"{v:7.0f}" if v is not None else "      —"


def review(path: Path) -> None:
    rows = [json.loads(l) for l in open(path) if l.strip()]
    header = next((r for r in rows if r.get("kind") == "call"), {})
    utts = [r for r in rows if r.get("kind") == "utterance"]
    verdicts = [r for r in rows if r.get("kind") == "verdict"]

    print(f"звонок {header.get('callId', path.stem)}  режим {header.get('mode', '?')}")
    print(f"провайдеры: {header.get('providers', {})}")
    ok = [u for u in utts if not u.get("cancelled") and not u.get("error")]
    cancelled = [u for u in utts if u.get("cancelled")]
    errors = [u for u in utts if u.get("error")]
    print(f"кусков: {len(utts)} (чистых {len(ok)}, оборвано {len(cancelled)}, ошибок {len(errors)})")

    for direction in sorted({u.get("direction") for u in ok}):
        sub = [u for u in ok if u.get("direction") == direction]
        first = [u for u in sub if u.get("isFirstChunk")]
        print(f"\n--- {direction}: кусков {len(sub)}, первых {len(first)} ---")
        print(f"{'стадия':38s} {'p50':>7s} {'p95':>7s}  n")
        for key, label, first_only in FIELDS:
            pool = first if first_only else sub
            vals = [u["latency"].get(key) for u in pool
                    if u.get("latency", {}).get(key) is not None]
            print(f"{label:38s} {fmt(pct(vals, .5))} {fmt(pct(vals, .95))}  {len(vals)}")

    if errors:
        print("\nошибки:")
        for u in errors[:8]:
            print(f"  {u.get('utteranceId')}: {u.get('error')}")
    if cancelled:
        print(f"\nоборвано (перебивание/отмена): {len(cancelled)}")
    if verdicts:
        print("\nпометки судьи:")
        for v in verdicts:
            note = f" — надо: {v['expected']}" if v.get("expected") else ""
            print(f"  {v.get('utteranceId')}: {v.get('verdict')}{note}")

    # тексты — чтобы качество судить не по памяти
    print("\nпоследние реплики (src -> dst):")
    for u in utts[-6:]:
        mark = "✗" if u.get("cancelled") or u.get("error") else " "
        print(f" {mark} [{u.get('direction')}] {u.get('srcText', '')[:48]!r} -> {u.get('dstText', '')[:48]!r}")


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--newest":
        with tempfile.TemporaryDirectory() as td:
            name = subprocess.run(
                ["ssh", "samevoice", "ls -t /opt/samevoice/logs/calls/*.jsonl | head -1"],
                capture_output=True, text=True, check=True).stdout.strip()
            if not name:
                sys.exit("на сервере нет логов звонков")
            local = Path(td) / Path(name).name
            subprocess.run(["scp", "-q", f"samevoice:{name}", str(local)], check=True)
            review(local)
        return
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    review(Path(sys.argv[1]))


if __name__ == "__main__":
    main()
