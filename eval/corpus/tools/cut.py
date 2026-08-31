"""Нарезка part2 на 35 файлов корпуса + отчёт о соответствии сценарию.

Совпадение ищется нечётко (Whisper на телефонном тракте врёт в служебных
словах), дубли решаются в пользу ПОСЛЕДНЕГО вхождения. wordStartMs берётся
из word_timestamps Whisper и помечается ПРЕДВАРИТЕЛЬНЫМ: протокол
(eval/corpus/README.md) запрещает молча выдавать выход STT за истину онсета —
дальше форс-алайнмент + ручная калибровка 20%.
"""
import json
import re
import wave
from pathlib import Path

WORK = Path("/Users/davidov/SameVoice-corpus/work")
OUT = Path("/Users/davidov/SameVoice-corpus/audio")
OUT.mkdir(exist_ok=True)

# (номер, класс, текст М-дорожки, целевое слово)
LINES = [
    (1, "easy", "Отправь мне его номер, я сохраню.", "Отправь"),
    (2, "hard", "Мне надо, секунду, посмотреть расписание.", "посмотреть"),
    (3, "trap", "Я не смогу приехать, у меня машина сломалась.", "машина"),
    (4, "easy", "Слушай, у меня телефон садится, я перезвоню.", "садится"),
    (5, "hard", "Билеты на двенадцатое, я уже проверил.", "двенадцатое"),
    (6, "easy", "Он сказал, что документы уже готовы.", "готовы"),
    (7, "trap", "Он обещал позвонить, но, похоже, забил.", "забил"),
    (8, "hard", "Я тебе, наверное, перезвоню минут через десять.", "перезвоню"),
    (9, "easy", "Сумма получилась тысяча двести.", "тысяча"),
    (10, "hard", "Наберёшь меня, когда приедешь?", "приедешь"),
    (11, "trap", "Скинь мне ещё раз адрес, я его потерял.", "адрес"),
    (12, "easy", "Наташа уже в курсе, я ей утром написал.", "Наташа"),
    (13, "hard", "Мне надо подтвердить бронь до вечера.", "подтвердить"),
    (14, "easy", "Позвони мне, когда освободишься.", "освободишься"),
    (15, "trap", "Давай назначим на пятнадцатое, если у тебя свободно.", "пятнадцатое"),
    (16, "hard", "Я записал твой номер, не потеряю.", "записал"),
    (17, "easy", "Стой, кажется, я забыл ключи дома.", "забыл"),
    (18, "hard", "Настя с работы, я потом объясню.", "Настя"),
    (19, "trap", "Перезвоню, как только выйду из душа.", "душа"),
    (20, "easy", "Давай тогда на вторник, если ничего не поменяется.", "вторник"),
    (21, "hard", "Сколько это стоит, пятьсот?", "пятьсот"),
    (22, "trap", "Он вчера звонил и извинялся.", "извинялся"),
    (23, "easy", "Я тебе всё объясню при встрече.", "объясню"),
    (24, "hard", "Я подъеду к семи, если пробок не будет.", "подъеду"),
    (25, "easy", "Я не успел, потому что пробки.", "пробки"),
    (26, "trap", "Я всё сделаю сегодня, не переживай.", "сегодня"),
    (27, "hard", "Ладно, я пойду, а то поздно уже.", "пойду"),
    (28, "easy", "Цена нормальная, только доставка дорогая.", "дорогая"),
    (29, "hard", "Мы же договорились на четыре, ты не забыл?", "договорились"),
    (30, "trap", "Ключи я оставил у соседки, она весь день дома.", "соседки"),
    (31, "easy", "Я в четверг никак, давай лучше в пятницу.", "лучше"),
    (32, "hard", "Она сказала, что будет завтра после обеда.", "завтра"),
    (33, "trap", "Я в аптеке, взял, что ты просила, и ещё батарейки.", "батарейки"),
    (34, "hard", "Я тебе уже отправил файл, посмотри.", "отправил"),
    (35, "trap", "Я к семи привезу документы.", "привезу"),
]

DIGITS = {"двенадцатое": "12", "тысяча": "1200", "двести": "200", "пятнадцатое": "15",
          "пятьсот": "500", "четыре": "4", "десять": "10"}


def norm(w: str) -> str:
    w = re.sub(r"[^\wёа-яa-z0-9-]", "", w.lower().strip()).replace("ё", "е")
    return w


def sim(a: str, b: str) -> float:
    """Похожесть двух нормализованных слов, 0..1 (дешёвый префиксный вариант)."""
    if a == b:
        return 1.0
    if not a or not b:
        return 0.0
    # числительные: слово из сценария может прийти цифрой
    if b.isdigit() or a.isdigit():
        da, db = DIGITS.get(a, a), DIGITS.get(b, b)
        if da == db or da.startswith(db) or db.startswith(da):
            return 0.9
    p = 0
    for x, y in zip(a, b):
        if x != y:
            break
        p += 1
    return p / max(len(a), len(b))


def _span_in(words, lo, hi):
    idx = [k for k, w in enumerate(words) if lo <= w["start"] < hi]
    return idx[0], len(idx)


# --- поток слов из расшифровки
words = []
data = json.load(open(WORK / "part2.json"))
for seg in data["segments"]:
    for w in seg.get("words", []):
        words.append({"word": norm(w["word"]), "start": w["start"], "end": w["end"]})
words = [w for w in words if w["word"]]

report = []
manifest = []
for num, cls, text, truth in LINES:
    target = [norm(t) for t in re.findall(r"[\wёА-Яа-я0-9-]+", text)]
    n = len(target)
    best = []  # (score, start_idx, span)
    for i in range(len(words)):
        for span in (n - 2, n - 1, n, n + 1, n + 2):
            if span < 2 or i + span > len(words):
                continue
            win = [w["word"] for w in words[i:i + span]]
            # выравнивание жадное по позициям (без полного ДП — хватает)
            m = min(len(win), n)
            score = sum(sim(win[k], target[k]) for k in range(m)) / n
            if score > 0.55:
                best.append((score, i, span))
    MANUAL = {1: (1.30, 4.60), 4: (10.60, 14.80), 9: (28.45, 31.80), 11: (34.98, 38.98)}
    if num in MANUAL:
        lo, hi = MANUAL[num]
        best = [(0.99, *_span_in(words, lo, hi))]
    if not best:
        report.append((num, "НЕ НАЙДЕНА", "", ""))
        continue
    best.sort(key=lambda t: (round(t[0], 2), t[1]))  # среди равных — ПОСЛЕДНЯЯ (дубль)
    score, i, span = best[-1]
    seg_words = words[i:i + min(span, n)]
    t0 = max(0.0, seg_words[0]["start"] - 0.25)
    t1 = seg_words[-1]["end"] + 0.30
    # целевое слово в окне
    tn = norm(truth)
    tw = max(seg_words, key=lambda w: sim(w["word"], tn))
    t_sim = sim(tw["word"], tn)
    wav_id = f"ru-m1-{num:03d}"
    # вырезаем
    with wave.open(str(WORK / "ru-m1-part2-16k.wav"), "rb") as r:
        sr = r.getframerate()
        r.setpos(int(t0 * sr))
        frames = r.readframes(int((t1 - t0) * sr))
    with wave.open(str(OUT / f"{wav_id}.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(frames)
    heard = " ".join(w["word"] for w in seg_words)
    flag = ""
    if t_sim < 0.99:
        flag = f"целевое слово: слышно «{tw['word']}» (совп. {t_sim:.2f})"
    report.append((num, f"ok {score:.2f} [{t0:.2f}-{t1:.2f}]", heard, flag))
    manifest.append({
        "id": wav_id, "lang": "ru", "wav": f"audio/{wav_id}.wav",
        "speaker": "ru-m1", "class": cls,
        "prefix": text.split(truth)[0].strip(" ,.—-"),
        "truth": truth.lower().replace("ё", "е"),
        "wordStartMs": round((tw["start"] - t0) * 1000.0, 1),
        "alignmentMethod": "whisper-large-v3-turbo word_timestamps — ПРЕДВАРИТЕЛЬНО, требуется форс-алайнмент и ручная калибровка 20% (eval/corpus/README.md)",
    })

for num, status, heard, flag in report:
    line = f"{num:2d} {status:22s} {heard[:70]}"
    if flag:
        line += f"  ⚠ {flag}"
    print(line)

json.dump({"samples": manifest}, open("/Users/davidov/SameVoice-corpus/manifest.provisional.json", "w"),
          ensure_ascii=False, indent=1)
print(f"\nнарезано: {len(manifest)}/35, манифест: manifest.provisional.json")
