"""Линейка ru-m1-mem: контекст E + память из транскриптов прошлых разговоров.

Память — извлечение по релевантности (как RAG в продукте): для каждой тестовой
строки берутся 2-3 сегмента транскриптов с наибольшим пересечением слов с
ЗАПРОСОМ = префикс + темы строки. Целевое слово в запрос НЕ входит — память
не подглядывает в ответ; если она содержит его, значит он пришёл через тему,
как и в жизни. В отчёте эти строки считаются отдельно (memHasTruth).
"""
import json
import re
from pathlib import Path

ROOT = Path("/Users/davidov/SameVoice-corpus")
STOP = set("я ты он она мы вы они и а но в на у к с о же не что это как когда если то за по из до".split())

def norm_words(text):
    return [w.lower().replace("ё", "е") for w in re.findall(r"[\wёА-Яа-я-]+", text)
            if w.lower() not in STOP and len(w) > 2]

trans = json.loads((ROOT / "loaded-calls" / "transcripts.json").read_text(encoding="utf-8"))
segments = []
for call, segs in trans.items():
    for s in segs:
        segments.append({"call": call, "text": s, "words": set(norm_words(s))})

lines = json.loads(Path("/private/tmp/sv-pr8/eval/corpus/linesets/ru-m1.json").read_text(encoding="utf-8"))
out = []
stats = {"memHasTruth": [], "memNoTruth": []}
for line in lines:
    query = set(norm_words(line["prefix"])) | {w.lower().replace("ё", "е") for w in line["contextTerms"]}
    # Ретрив на уровне ЗВОНКА: находим самый релевантный разговор и берём из
    # него окно вокруг лучшего сегмента — память подгружает тему целиком,
    # а не одну фразу (реплика с датами лежит РЯДОМ с вопросом про билеты).
    by_call = {}
    for s in segments:
        by_call.setdefault(s["call"], []).append(s)
    def call_score(segs):
        return sum(len(s["words"] & query) for s in segs)
    best_call, best_segs = max(by_call.items(), key=lambda kv: call_score(kv[1]))
    picked = []
    if call_score(best_segs) > 0:
        idx = max(range(len(best_segs)), key=lambda i: len(best_segs[i]["words"] & query))
        lo, hi = max(0, idx - 1), min(len(best_segs), idx + 3)
        picked = best_segs[lo:hi]
    mem_text = " ".join(f"«{s['text']}»" for s in picked)
    truth = line["truth"].lower().replace("ё", "е")
    has_truth = truth in norm_words(mem_text)
    stats["memHasTruth" if has_truth else "memNoTruth"].append(line["id"])
    note = line["context_note"]
    if picked:
        note += " Из прошлых разговоров этой пары: " + mem_text
    out.append({**line, "context_note": note, "memHasTruth": has_truth,
                "memSegments": [s["text"] for s in picked]})

json.dump(out, open("/private/tmp/sv-pr8/eval/corpus/linesets/ru-m1-mem.json", "w"),
          ensure_ascii=False, indent=1)
print(f"память содержит целевое слово: {len(stats['memHasTruth'])} строк {stats['memHasTruth']}")
print(f"память без целевого слова:     {len(stats['memNoTruth'])} строк")
ex = out[3]
print("пример:", ex["id"], "->", ex["context_note"][:220])
