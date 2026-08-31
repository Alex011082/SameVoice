"""CTC-форс-алайнмент онсетов целевых слов корпуса ru-m1.

Метод — запасной путь из eval/corpus/README.md: torchaudio.functional.forced_align
на bond005/wav2vec2-base-ru. Оговорка протокола сохраняется: это ТОТ ЖЕ чекпойнт,
что у пруннера, — метка смещена в сторону того, как границу слышит сам пруннер.
Метод пишется в manifest (alignmentMethod), результат читается как смещённый.
Ручная калибровка 20% по спектрограмме — отдельный обязательный шаг, не здесь.

Выход: manifest.v3.json с onset от CTC + отчёт |Δ| против whisper-меток.
"""
import json
import re
import wave
from pathlib import Path

import numpy as np
import torch
from torchaudio.functional import forced_align
from transformers import AutoModelForCTC, Wav2Vec2Processor

ROOT = Path("/Users/davidov/SameVoice-corpus")
SR = 16000

processor = Wav2Vec2Processor.from_pretrained("bond005/wav2vec2-base-ru")
model = AutoModelForCTC.from_pretrained("bond005/wav2vec2-base-ru")
model.eval()
vocab = processor.tokenizer.get_vocab()
blank_id = processor.tokenizer.pad_token_id or 0
word_delim = processor.tokenizer.word_delimiter_token  # обычно "|"

# тексты строк — дословно из сценария (без пунктуации, нижний регистр)
LINES = {int(l["id"].split("-")[-1]): l for l in
         json.load(open(ROOT / "manifest.provisional.json"))["samples"]}
TEXTS = {
 2: "мне надо секунду посмотреть расписание", 3: "я не смогу приехать у меня машина сломалась",
 4: "слушай у меня телефон садится я перезвоню", 5: "билеты на двенадцатое я уже проверил",
 6: "он сказал что документы уже готовы", 7: "он обещал позвонить но похоже забил",
 8: "я тебе наверное перезвоню минут через десять", 9: "сумма получилась тысяча двести",
 10: "наберёшь меня когда приедешь", 11: "скинь мне ещё раз адрес я его потерял",
 13: "мне надо подтвердить бронь до вечера", 14: "позвони мне когда освободишься",
 15: "давай назначим на пятнадцатое если у тебя свободно", 16: "я записал твой номер не потеряю",
 17: "стой кажется я забыл ключи дома", 18: "настя с работы я потом объясню",
 19: "перезвоню как только выйду из душа", 20: "давай тогда на вторник если ничего не поменяется",
 21: "сколько это стоит пятьсот", 22: "он вчера звонил и извинялся",
 23: "я тебе всё объясню при встрече", 24: "я подъеду к семи если пробок не будет",
 25: "я не успел потому что пробки", 26: "я всё сделаю сегодня не переживай",
 27: "ладно я пойду а то поздно уже", 28: "цена нормальная только доставка дорогая",
 29: "мы же договорились на четыре ты не забыл", 30: "ключи я оставил у соседки она весь день дома",
 31: "я в четверг никак давай лучше в пятницу", 32: "она сказала что будет завтра после обеда",
 33: "я в аптеке взял что ты просила и ещё батарейки", 34: "я тебе уже отправил файл посмотри",
 35: "я к семи привезу документы",
}


def encode(text: str) -> tuple[list[int], list[tuple[int, int]]]:
    """id-шники CTC-целей + границы (началo, конец) каждого слова в них."""
    ids, spans = [], []
    for word in text.split():
        start = len(ids)
        for ch in word:
            if ch in vocab:
                ids.append(vocab[ch])
        if word_delim in vocab:
            ids.append(vocab[word_delim])
        spans.append((start, len(ids) - (1 if word_delim in vocab else 0)))
    if word_delim in vocab and ids:
        ids.pop()  # без разделителя в конце
        spans[-1] = (spans[-1][0], len(ids))
    return ids, spans


report, manifest_out = [], []
for num, line in sorted(LINES.items()):
    wav_path = ROOT / "audio" / f"{line['id']}.wav"
    with wave.open(str(wav_path), "rb") as r:
        pcm = np.frombuffer(r.readframes(r.getnframes()), dtype="<i2").astype(np.float32) / 32767.0
    inputs = processor(pcm, sampling_rate=SR, return_tensors="pt")
    with torch.inference_mode():
        logits = model(inputs.input_values).logits  # (1, T, V)
    log_probs = torch.log_softmax(logits, dim=-1)

    text = TEXTS[num]
    ids, spans = encode(text)
    targets = torch.tensor([ids], dtype=torch.int32)
    try:
        aligned, scores = forced_align(log_probs, targets, blank=blank_id)
    except Exception as exc:
        report.append((line["id"], None, f"алайнмент упал: {exc}"))
        continue
    aligned = aligned[0].tolist()
    # кадр -> миллисекунды: wav2vec2 base даёт кадр каждые ~20 мс
    frame_ms = (len(pcm) / SR * 1000.0) / len(aligned)
    # найти кадр, где начинается первый токен целевого слова
    words = text.split()
    truth_norm = line["truth"].replace("ё", "е")
    widx = next(i for i, w in enumerate(words) if w.replace("ё", "е") == truth_norm)
    tgt_start_tok = spans[widx][0]
    # позиция в выравнивании: первый кадр, где выровнен токен с индексом пути >= tgt_start_tok
    # forced_align возвращает путь длиной T с id токена на каждом кадре; ищем первый кадр,
    # где встречается ЦЕЛЕВОЙ первый символ после того, как пройдены предыдущие цели
    seen = 0
    onset_frame = None
    prev_tok = blank_id
    for t, tok in enumerate(aligned):
        if tok != blank_id and (tok != prev_tok):
            if seen == tgt_start_tok:
                onset_frame = t
                break
            seen += 1
        prev_tok = tok
    if onset_frame is None:
        report.append((line["id"], None, "онсет не найден в пути"))
        continue
    ctc_ms = onset_frame * frame_ms
    whisper_ms = line["wordStartMs"]
    delta = ctc_ms - whisper_ms
    report.append((line["id"], round(delta, 1), f"ctc {ctc_ms:7.1f} | whisper {whisper_ms:7.1f}"))
    manifest_out.append({**line, "wordStartMs": round(ctc_ms, 1),
                         "wordStartMsWhisper": whisper_ms,
                         "alignmentMethod": "ctc-forced-align bond005/wav2vec2-base-ru (СМЕЩЁН: чекпойнт пруннера; ручная калибровка 20% не сделана)"})

deltas = [d for _, d, _ in report if d is not None]
for rid, d, note in report:
    print(f"{rid}  Δ={d if d is not None else '—':>8}  {note}")
if deltas:
    a = sorted(abs(x) for x in deltas)
    print(f"\n|Δ| медиана {a[len(a)//2]:.0f} мс, максимум {a[-1]:.0f} мс, строк {len(a)}/32")
    print("порог протокола (для РУЧНОЙ калибровки): медиана ≤10, максимум ≤25 — здесь сравниваются два АВТОмета")
json.dump({"samples": manifest_out}, open(ROOT / "manifest.v3.json", "w"), ensure_ascii=False, indent=1)
print("manifest.v3.json записан")
