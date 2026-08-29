#!/usr/bin/env python
"""Read one call's eval log and print a session report.

    cd agent && uv run python scripts/review_call.py c_abc123
    cd agent && uv run python scripts/review_call.py --list
    cd agent && uv run python scripts/review_call.py path/to/c_abc123.jsonl

This is what the two testers look at after a call: every utterance with source
and translation side by side, the ones the bilingual judge flagged highlighted
with what she said it should have been, then latency percentiles per stage and
end to end, counts, flag rate, and the provider triple that produced all of it.

Stdlib only, on purpose: it must run against a JSONL produced in mock mode
without importing the agent package (and therefore without livekit installed).

A NOTE ON HEBREW IN A TERMINAL. Correct bidirectional rendering in a terminal is
not solvable from here - terminals disagree about the Unicode bidi algorithm and
several ignore it entirely. So this tool does not try to be clever: it never
reorders or reverses anything, it prints every string exactly as stored, and it
labels every line with its language so you always know which script you are
looking at and in which direction it was going. `--isolate` wraps RTL text in
U+2067/U+2069 bidi isolates, which helps in terminals that implement them and is
off by default because the ones that do not may draw them as boxes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _default_dir() -> Path:
    """EVAL_LOG_DIR, anchored to the repo root when it is relative — the same
    rule the agent applies when it WRITES the logs (see agent config
    `_env_path`). Without the anchor this script resolves `logs/calls` against
    the cwd, so it found nothing whenever it was run from anywhere but the repo
    root."""
    raw = os.environ.get("EVAL_LOG_DIR") or ""
    if not raw.strip():
        return _REPO_ROOT / "logs" / "calls"
    path = Path(raw).expanduser()
    return path if path.is_absolute() else _REPO_ROOT / path


DEFAULT_DIR = _default_dir()

RTL_LANGS = frozenset({"he"})
LRI, RLI, PDI = "⁦", "⁧", "⁩"

STAGES: tuple[tuple[str, str], ...] = (
    ("speech_start_to_first_partial_ms", "speech start -> first partial"),
    ("first_partial_to_commit_ms", "first partial -> commit"),
    ("commit_to_mt_done_ms", "commit -> MT done"),
    ("mt_provider_latency_ms", "  of which MT provider"),
    ("mt_done_to_first_audio_ms", "MT done -> first audio"),
    ("tts_audio_ms", "synthesized audio length"),
)
E2E_KEY = "speech_start_to_first_audio_ms"


# ------------------------------------------------------------------ formatting


class Style:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled

    def _wrap(self, code: str, text: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def bold(self, text: str) -> str:
        return self._wrap("1", text)

    def dim(self, text: str) -> str:
        return self._wrap("2", text)

    def red(self, text: str) -> str:
        return self._wrap("31;1", text)

    def green(self, text: str) -> str:
        return self._wrap("32", text)

    def yellow(self, text: str) -> str:
        return self._wrap("33", text)

    def cyan(self, text: str) -> str:
        return self._wrap("36", text)


def bidi(text: str, lang: str, isolate: bool) -> str:
    """Never reorders. Optionally isolates, so an RTL run cannot drag the
    surrounding ASCII labels around in terminals that do implement bidi."""
    if not isolate or not text:
        return text
    return (RLI if lang in RTL_LANGS else LRI) + text + PDI


def pct(values: Sequence[float], q: float) -> float | None:
    """Nearest-rank percentile. With n=6 utterances from one test call, linear
    interpolation would invent precision that is not there."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, min(len(ordered), int(round(q * len(ordered) + 0.5))))
    return ordered[rank - 1]


def fmt_ms(value: float | None) -> str:
    return "  -  " if value is None else f"{value:7.0f}"


# ----------------------------------------------------------------------- input


def read_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                print(f"warning: {path.name} line {lineno} is not valid JSON, skipped", file=sys.stderr)
                continue
            if isinstance(record, dict):
                records.append(record)
    return records


def resolve_path(target: str, root: Path) -> Path:
    candidate = Path(target).expanduser()
    if candidate.is_file():
        return candidate
    if candidate.suffix == ".jsonl" and candidate.parent != Path("."):
        return candidate
    return root / f"{target}.jsonl"


# ---------------------------------------------------------------------- report


def print_header(style: Style, header: dict[str, Any], path: Path, isolate: bool) -> None:
    print(style.bold(f"\n=== SpeakEasy call review: {header.get('callId') or path.stem} ==="))
    print(f"  file      : {path}")
    if not header:
        print(style.yellow("  (no call header line - this log was written by an older agent)"))
        return
    providers = header.get("providers") or {}
    triple = f"stt={providers.get('stt', '?')} mt={providers.get('mt', '?')} tts={providers.get('tts', '?')}"
    print(f"  providers : {style.cyan(triple)}")
    print(f"  mode      : {header.get('mode', '?')}   room: {header.get('roomName', '?')}")
    for p in header.get("participants") or []:
        print(
            "  participant: {id} ({name}) lang={lang} gender={gender} tone={tone}".format(
                id=p.get("userId", "?"),
                name=bidi(str(p.get("displayName", "")), str(p.get("lang", "")), isolate),
                lang=p.get("lang", "?"),
                gender=p.get("gender", "?"),
                tone=p.get("tone", "?"),
            )
        )
    if str(providers.get("stt")) == "mock" or str(providers.get("mt")) == "mock":
        print(
            style.yellow(
                "  NOTE: mock providers were in force. The transcripts are invented from a "
                "fixture list and say NOTHING about recognition or translation quality."
            )
        )


def print_utterances(
    style: Style,
    utterances: list[dict[str, Any]],
    verdicts_by_utt: dict[str, list[dict[str, Any]]],
    *,
    isolate: bool,
    only_flagged: bool,
) -> None:
    print(style.bold("\n--- utterances ---"))
    shown = 0
    for index, u in enumerate(utterances, start=1):
        utt_id = str(u.get("utteranceId") or "")
        verdicts = verdicts_by_utt.get(utt_id, [])
        wrong = [v for v in verdicts if v.get("verdict") == "wrong"]
        if only_flagged and not wrong:
            continue
        shown += 1

        src_lang = str(u.get("srcLang") or "?")
        dst_lang = str(u.get("dstLang") or "?")
        e2e = (u.get("latency") or {}).get(E2E_KEY)
        marker = style.red("FLAGGED WRONG") if wrong else ("ok" if verdicts else "")
        head = (
            f"[{index:03d}] {u.get('tStart', 0):7.2f}s  "
            f"{src_lang}->{dst_lang}  {u.get('speakerId', '?')}"
            f"({u.get('speakerGender', '?')}) -> {u.get('listenerId', '?')}"
            f"({u.get('listenerGender', '?')})  tone={u.get('tone', '?')}"
            f"  e2e={fmt_ms(e2e).strip()}ms"
        )
        print(f"\n{style.bold(head)}  {marker}".rstrip())
        print(style.dim(f"      id={utt_id}  trigger={u.get('trigger', '?')} words={u.get('words', 0)}"))
        print(f"  {src_lang} SRC : {bidi(str(u.get('srcText') or ''), src_lang, isolate)}")
        dst_text = str(u.get("dstText") or "")
        if dst_text:
            line = bidi(dst_text, dst_lang, isolate)
            print(f"  {dst_lang} MT  : {style.red(line) if wrong else line}")
        else:
            reason = u.get("error") or ("cancelled by barge-in" if u.get("cancelled") else "empty")
            print(f"  {dst_lang} MT  : {style.yellow(f'(nothing spoken: {reason})')}")

        for v in verdicts:
            tag = style.red("WRONG") if v.get("verdict") == "wrong" else style.green("OK")
            by = v.get("by") or "?"
            print(f"      verdict {tag} by {by}")
            if v.get("expected"):
                print(
                    f"      expected: {style.green(bidi(str(v['expected']), dst_lang, isolate))}"
                )
            if v.get("note"):
                print(f"      note    : {v['note']}")
    if shown == 0:
        print(style.dim("  (nothing to show)"))


def print_latency(style: Style, utterances: list[dict[str, Any]]) -> None:
    # Percentiles are computed over units that actually reached the listener.
    # Mixing in cancelled and errored units would flatter every number.
    spoken = [u for u in utterances if not u.get("cancelled") and not u.get("error") and u.get("dstText")]
    print(style.bold(f"\n--- latency over {len(spoken)} delivered utterance(s) ---"))
    if not spoken:
        print(style.dim("  (no delivered utterances to measure)"))
        return
    print(f"  {'stage':<32}{'p50':>9}{'p90':>9}{'n':>6}")
    for key, label in STAGES:
        values = [
            float(u["latency"][key])
            for u in spoken
            if isinstance((u.get("latency") or {}).get(key), (int, float))
        ]
        print(f"  {label:<32}{fmt_ms(pct(values, 0.5)):>9}{fmt_ms(pct(values, 0.9)):>9}{len(values):>6}")
    e2e = [
        float(u["latency"][E2E_KEY])
        for u in spoken
        if isinstance((u.get("latency") or {}).get(E2E_KEY), (int, float))
    ]
    print(
        style.bold(
            f"  {'END-TO-END perceived delay':<32}{fmt_ms(pct(e2e, 0.5)):>9}"
            f"{fmt_ms(pct(e2e, 0.9)):>9}{len(e2e):>6}"
        )
    )
    print(style.dim("  all values in milliseconds; percentiles are nearest-rank"))


def print_counts(
    style: Style,
    utterances: list[dict[str, Any]],
    verdicts: list[dict[str, Any]],
    verdicts_by_utt: dict[str, list[dict[str, Any]]],
) -> None:
    delivered = [u for u in utterances if u.get("dstText") and not u.get("error")]
    cancelled = [u for u in utterances if u.get("cancelled")]
    errored = [u for u in utterances if u.get("error")]
    judged_ids = {v.get("utteranceId") for v in verdicts if v.get("utteranceId")}
    wrong_ids = {v.get("utteranceId") for v in verdicts if v.get("verdict") == "wrong"}
    orphans = [v for v in verdicts if not v.get("resolved")]

    print(style.bold("\n--- counts ---"))
    print(f"  utterances committed : {len(utterances)}")
    print(f"  delivered            : {len(delivered)}")
    print(f"  cancelled (barge-in) : {len(cancelled)}")
    print(f"  provider errors      : {len(errored)}")
    print(f"  verdicts recorded    : {len(verdicts)} on {len(judged_ids)} utterance(s)")
    print(f"  flagged WRONG        : {len(wrong_ids)}")
    if judged_ids:
        rate = 100.0 * len(wrong_ids) / len(judged_ids)
        print(f"  flag rate (of judged): {style.bold(f'{rate:.0f}%')}  ({len(wrong_ids)}/{len(judged_ids)})")
    else:
        print(style.dim("  flag rate            : n/a - nothing was judged"))
    if delivered:
        coverage = 100.0 * len(judged_ids) / len(delivered)
        print(f"  judged coverage      : {coverage:.0f}% of delivered utterances")
    if orphans:
        print(
            style.yellow(
                f"  {len(orphans)} verdict(s) could not be matched to an utterance "
                "(kept anyway - a judge's label is never discarded)"
            )
        )
    # Per-direction breakdown: accented Hebrew and native Russian are not the
    # same experiment and must never be averaged into one number.
    by_direction: dict[str, list[dict[str, Any]]] = {}
    for u in utterances:
        by_direction.setdefault(str(u.get("direction") or "?"), []).append(u)
    for direction, group in sorted(by_direction.items()):
        w = sum(1 for u in group if str(u.get("utteranceId")) in wrong_ids)
        j = sum(1 for u in group if str(u.get("utteranceId")) in judged_ids)
        print(f"    {direction:<10} {len(group):>3} utterance(s), {j} judged, {w} wrong")


# ------------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="review_call.py",
        description="Print a readable session report from a SpeakEasy call eval log.",
    )
    parser.add_argument("target", nargs="?", help="call id (e.g. c_abc123) or a path to a .jsonl")
    parser.add_argument("--dir", default=str(DEFAULT_DIR), help=f"log directory (default: {DEFAULT_DIR})")
    parser.add_argument("--list", action="store_true", help="list the call logs in --dir and exit")
    parser.add_argument("--flagged", action="store_true", help="show only utterances flagged WRONG")
    parser.add_argument(
        "--isolate",
        action="store_true",
        help="wrap RTL text in Unicode bidi isolates (helps in some terminals, boxes in others)",
    )
    parser.add_argument("--no-color", action="store_true", help="disable ANSI colour")
    parser.add_argument("--json", action="store_true", help="emit the aggregated summary as JSON")
    return parser


def summary_json(
    header: dict[str, Any], utterances: list[dict[str, Any]], verdicts: list[dict[str, Any]]
) -> dict[str, Any]:
    spoken = [u for u in utterances if not u.get("cancelled") and not u.get("error") and u.get("dstText")]

    def stage(key: str) -> dict[str, float | None]:
        values = [
            float(u["latency"][key])
            for u in spoken
            if isinstance((u.get("latency") or {}).get(key), (int, float))
        ]
        return {"p50": pct(values, 0.5), "p90": pct(values, 0.9), "n": len(values)}

    judged = {v.get("utteranceId") for v in verdicts if v.get("utteranceId")}
    wrong = {v.get("utteranceId") for v in verdicts if v.get("verdict") == "wrong"}
    return {
        "callId": header.get("callId"),
        "providers": header.get("providers"),
        "counts": {
            "utterances": len(utterances),
            "delivered": len(spoken),
            "cancelled": sum(1 for u in utterances if u.get("cancelled")),
            "errors": sum(1 for u in utterances if u.get("error")),
            "verdicts": len(verdicts),
            "judged": len(judged),
            "wrong": len(wrong),
        },
        "flagRate": (len(wrong) / len(judged)) if judged else None,
        "latency": {key: stage(key) for key, _ in STAGES} | {E2E_KEY: stage(E2E_KEY)},
    }


def group_verdicts(verdicts: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for v in verdicts:
        grouped.setdefault(str(v.get("utteranceId") or ""), []).append(v)
    return grouped


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.dir).expanduser()
    color = sys.stdout.isatty() and not args.no_color and not os.environ.get("NO_COLOR")
    style = Style(color)

    if args.list:
        logs = sorted(root.glob("*.jsonl")) if root.is_dir() else []
        if not logs:
            print(f"no call logs in {root}", file=sys.stderr)
            return 1
        for log in logs:
            print(f"{log.stem}\t{log.stat().st_size:>8} bytes\t{log}")
        return 0

    if not args.target:
        build_parser().print_usage(sys.stderr)
        print("error: a call id or path is required (or use --list)", file=sys.stderr)
        return 2

    path = resolve_path(args.target, root)
    if not path.is_file():
        print(f"error: no such call log: {path}", file=sys.stderr)
        return 1

    records = read_records(path)
    header = next((r for r in records if r.get("kind") == "call"), {})
    utterances = [r for r in records if r.get("kind") == "utterance"]
    verdicts = [r for r in records if r.get("kind") == "verdict"]
    verdicts_by_utt = group_verdicts(verdicts)

    if args.json:
        json.dump(summary_json(header, utterances, verdicts), sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0

    print_header(style, header, path, args.isolate)
    print_utterances(
        style, utterances, verdicts_by_utt, isolate=args.isolate, only_flagged=args.flagged
    )
    print_latency(style, utterances)
    print_counts(style, utterances, verdicts, verdicts_by_utt)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
