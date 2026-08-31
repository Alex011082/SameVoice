"""Сборка обучающих данных v2: фабрика v1 + частичная v2 + ПАМЯТЬ в примерах.

Отличия от v1 (scripts/prepare-train-data.py):
  1. Входа два: dialogues-v1.jsonl (1020 диалогов) и gen-v2/*.jsonl
     (частичная выработка фабрики v2 — остановлена по цене токенов 01.09:
     560 диалогов, 48 тыс. слов, профессии/длины/память).
  2. У диалогов v2 бывает pastNote — память прошлых разговоров пары.
     Она вплетается в system тем же слотом, каким память подаётся в бою
     и в зачётной линейке ru-m1-mem: «Из прошлых разговоров этой пары: …».
     В данных v1 этого слота не было вовсе — и на ru-m1-mem обучение v1
     ничего не прибавило (RESULT.md, эксп. 12, вывод 3).
  3. Дедупликация между бригадами: точные повторы (system, utterance)
     выбрасываются.

Правила отбора и фильтр утечек — те же, что в v1 (реплика >= 3 слов, хвост
до 2 реплик, нормализованный «префикс+целевое слово» зачётных строк).
Сплит: seed 42, ~5% в валидацию.
"""
import json
import random
import re
from glob import glob
from pathlib import Path

CORPUS = Path.home() / "SameVoice-corpus" / "train-data"
LINESETS = Path(__file__).resolve().parent.parent / "eval" / "corpus" / "linesets"
INSTRUCTION = (
    "Продолжи реплику говорящего в живом телефонном разговоре "
    "естественным разговорным языком. Пиши только продолжение реплики, "
    "без пояснений."
)
MIN_WORDS = 3
TAIL = 2
VAL_SHARE = 0.05
SEED = 42


def norm(text: str) -> str:
    text = text.lower().replace("ё", "е")
    return re.sub(r"[^\w\s]", "", text, flags=re.U).strip()


def leak_keys() -> set[str]:
    keys = set()
    for name in ("ru-m1.json", "ru-m1-mem.json"):
        for line in json.load(open(LINESETS / name)):
            keys.add(norm(line["prefix"] + " " + line["truth"]))
    return keys


def candidates(dialogues: list[dict]) -> list[dict]:
    out = []
    for d in dialogues:
        utts = [u["text"] for u in d["utterances"]]
        for i, text in enumerate(utts):
            if len(text.split()) < MIN_WORDS:
                continue
            ctx = f"Контекст: телефонный разговор, {d['speakers']}. Тема: {d['theme']}."
            if d.get("pastNote"):
                ctx += f" Из прошлых разговоров этой пары: {d['pastNote'].strip()}"
            tail = utts[max(0, i - TAIL):i]
            if tail:
                ctx += " Последние реплики: " + " | ".join(tail)
            out.append({"system": INSTRUCTION + "\n" + ctx, "utterance": text})
    return out


def main() -> None:
    v1 = [json.loads(l) for l in open(CORPUS / "dialogues-v1.jsonl")]
    v2 = [json.loads(l) for p in sorted(glob(str(CORPUS / "gen-v2" / "*.jsonl")))
          for l in open(p)]
    cands = candidates(v1) + candidates(v2)
    keys = leak_keys()
    kept, seen, leaked, dups = [], set(), 0, 0
    for c in cands:
        if any(k in norm(c["utterance"]) for k in keys):
            leaked += 1
            continue
        sig = (c["system"], c["utterance"])
        if sig in seen:
            dups += 1
            continue
        seen.add(sig)
        kept.append(c)
    mem = sum(1 for c in kept if "Из прошлых разговоров" in c["system"])
    print(f"диалогов: {len(v1)} v1 + {len(v2)} v2 | кандидатов: {len(cands)} | "
          f"утечек: {leaked} | дублей: {dups} | примеров: {len(kept)} | с памятью: {mem}")

    rng = random.Random(SEED)
    idx = set(rng.sample(range(len(kept)), round(len(kept) * VAL_SHARE)))
    with open(CORPUS / "train-v2.jsonl", "w") as ft, \
         open(CORPUS / "val-v2.jsonl", "w") as fv:
        for i, c in enumerate(kept):
            (fv if i in idx else ft).write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"обучение: {len(kept) - len(idx)} | валидация: {len(idx)} | seed: {SEED}")


if __name__ == "__main__":
    main()
