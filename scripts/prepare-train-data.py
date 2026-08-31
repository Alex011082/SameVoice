"""Сборка обучающих данных угадывателя из синтетических диалогов фабрики v1.

Вход:  ~/SameVoice-corpus/train-data/dialogues-v1.jsonl (1020 диалогов фабрики).
Выход: train-v1.jsonl / val-v1.jsonl — примеры вида {"system", "utterance"},
где system = боевая инструкция предиктора + контекст (пара говорящих, тема,
до 2 последних реплик), а utterance = реплика целиком. Формат обязан
совпадать с рендером gpu/predictor/app.py (PROMPT_STYLE=chat): обучаем ровно
на том промпте, на котором модель работает в бою.

Правила отбора (проверены обратной сверкой с фактическими файлами v1 —
совпадение полное, 8399 кандидатов → 8388 примеров):
  1. каждая реплика длиной >= 3 слов становится примером;
  2. хвост контекста — до 2 предыдущих реплик, разделитель " | ";
  3. фильтр утечек: реплика выбрасывается, если её нормализованный текст
     (нижний регистр, ё→е, без пунктуации) содержит подстроку
     "префикс + целевое слово" любой зачётной строки ru-m1 / ru-m1-mem.
     Это защита честности замера: модель не должна увидеть в обучении
     свои экзаменационные фразы. В v1 так отброшено 11 реплик.

Сплит train/val v1 (7969/419, ~5%) был сделан случайно; seed утрачен вместе
с /private/tmp при перезагрузке 01.09. Поэтому: если файлы v1 уже лежат на
диске — скрипт их НЕ трогает, а только сверяет (кандидаты, утечки, состав).
Для пересборки с нуля (v2+) используется документированный seed 42.
"""
import argparse
import json
import random
import re
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


def build_candidates(dialogues: list[dict]) -> list[dict]:
    out = []
    for d in dialogues:
        utts = [u["text"] for u in d["utterances"]]
        for i, text in enumerate(utts):
            if len(text.split()) < MIN_WORDS:
                continue
            ctx = f"Контекст: телефонный разговор, {d['speakers']}. Тема: {d['theme']}."
            tail = utts[max(0, i - TAIL):i]
            if tail:
                ctx += " Последние реплики: " + " | ".join(tail)
            out.append({"system": INSTRUCTION + "\n" + ctx, "utterance": text})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="пересобрать сплит заново (seed 42), даже если файлы есть")
    args = ap.parse_args()

    dialogues = [json.loads(l) for l in open(CORPUS / "dialogues-v1.jsonl")]
    cands = build_candidates(dialogues)
    keys = leak_keys()
    kept = [c for c in cands if not any(k in norm(c["utterance"]) for k in keys)]
    leaked = len(cands) - len(kept)
    print(f"диалогов: {len(dialogues)} | кандидатов: {len(cands)} | "
          f"утечек в зачётный корпус отброшено: {leaked}")

    train_p, val_p = CORPUS / "train-v1.jsonl", CORPUS / "val-v1.jsonl"
    if train_p.exists() and val_p.exists() and not args.force:
        existing = {(json.loads(l)["system"], json.loads(l)["utterance"])
                    for p in (train_p, val_p) for l in open(p)}
        ours = {(c["system"], c["utterance"]) for c in kept}
        verdict = "СОВПАДАЕТ" if existing == ours else "РАСХОЖДЕНИЕ!"
        print(f"файлы v1 уже существуют — сверка состава: {verdict} "
              f"(на диске {len(existing)}, пересборка {len(ours)})")
        return

    rng = random.Random(SEED)
    idx = set(rng.sample(range(len(kept)), round(len(kept) * VAL_SHARE)))
    with open(train_p, "w") as ft, open(val_p, "w") as fv:
        for i, c in enumerate(kept):
            (fv if i in idx else ft).write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"обучение: {len(kept) - len(idx)} | валидация: {len(idx)} | "
          f"seed сплита: {SEED}")


if __name__ == "__main__":
    main()
