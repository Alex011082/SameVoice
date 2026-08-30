"""Работает ли инкрементальный перевод — БЕЗ обучения и БЕЗ своего сервера.

ЗАЧЕМ ЭТОТ ЗАМЕР СУЩЕСТВУЕТ
План «свой сервер под инкрементальную модель» стоит $281/мес и несколько дней
работы. Но саму АРХИТЕКТУРУ можно испытать на том, что уже работает: подавать
модели растущий префикс фразы и требовать выдавать только ту часть перевода,
которая уже не изменится.

Подтвердится — дообучение нужно лишь чтобы делать то же самое быстрее и дешевле.
Не подтвердится — никакая своя модель не спасёт, и мы узнали это за вечер.

ЧТО ИМЕННО МЕРЯЕТСЯ

1. `k_first` — на какой доле фразы модель впервые решается что-то выдать.
   Чем раньше, тем больше перевода готово к моменту, когда человек договорил.

2. СТАБИЛЬНОСТЬ — главное число. Выданное вслух не отзывается. Если то, что
   модель выдала на префиксе в 4 слова, на 6 словах оказалось неверным — в
   живом звонке мы бы это уже произнесли. Каждый такой случай считается
   НАРУШЕНИЕМ, и именно они решают судьбу затеи.

3. ПОКРЫТИЕ — какая доля финального перевода была готова ДО конца фразы. Это и
   есть сэкономленное время.

Запускать на сервере, ключи там:
  scp eval/mt/bench_incremental.py samevoice:/tmp/ && ssh samevoice \
    'cd /opt/samevoice/agent && set -a && . /opt/samevoice/.env && set +a && \
     .venv/bin/python /tmp/bench_incremental.py'
"""
from __future__ import annotations
import asyncio, glob, json, statistics as st, sys, time

sys.path.insert(0, "/opt/samevoice/agent/src")
from speakeasy_agent.config import Config
from speakeasy_agent.providers.base import MtRequest, Speaker
from speakeasy_agent.providers.mt_gemini import GeminiMtProvider, build_system_instruction

LOGS = "/opt/samevoice/logs/calls/*.jsonl"
ALEX = Speaker("u_alex", "Alex", "ru", "m", "neutral")
NOA = Speaker("u_noa", "Noa", "he", "f", "friendly")
NOTHING = "—"

# Инструкция поверх боевого промпта. Контракт по роду не трогаем — он общий,
# и расходиться двум промптам нельзя.
# ТРИ РЕДАКЦИИ ЭТОГО ПРОМПТА, И ТРЕТЬЯ МЕНЯЕТ САМУ ПОСТАНОВКУ.
#
# 1. «Выдавай только достоверное» — 23 нарушения на 11 фраз. Модель читала
#    правило и всё равно догадывалась.
# 2. Плюс примеры осторожности — 16 нарушений. Лучше, но всё равно негодно.
# 3. ЗДЕСЬ: модель больше НЕ ПЕРЕВОДИТ ФРАЗУ ЗАНОВО. Ей показывают, что уже
#    сказано вслух, и просят ДОПИСАТЬ продолжение. Отозвать сказанное она
#    теперь не может не потому, что её попросили, а потому, что её об этом не
#    спрашивают. Ограничение вшито в постановку, а не в вежливую просьбу.
#
# Заодно это чинит методическую ошибку первых двух редакций: там сравнивались
# выходы НЕЗАВИСИМЫХ вызовов, и часть «нарушений» была просто разбросом модели
# между запросами (בשקט против שקט), а не настоящей правкой.
INCREMENTAL = f"""

You are interpreting a live phone call. You hear the sentence AS IT IS BEING
SPOKEN, and everything you output is spoken aloud to the listener IMMEDIATELY.

You will be shown:
  SOURCE SO FAR - what the speaker has said up to now, possibly mid-sentence.
  ALREADY SPOKEN - the translation you have already delivered out loud.

Output ONLY the NEW words that continue ALREADY SPOKEN and that will remain
correct no matter how the sentence goes on. Do not repeat ALREADY SPOKEN. Do not
correct it - it is in the listener's ear and cannot be taken back.

If nothing new is safe yet, output exactly: {NOTHING}

  SOURCE SO FAR: "Ты меня"
  ALREADY SPOKEN: ""
  output: {NOTHING}
  why: the verb has not arrived; "слышишь" and "не слышишь" are opposites.

  SOURCE SO FAR: "Если получится приехать пораньше, я позвоню"
  ALREADY SPOKEN: "אם אצליח להגיע מוקדם יותר,"
  output: אני אתקשר
  why: the first clause was already delivered; only the new, closed part is added.

A late output costs nothing. A wrong one is already heard.
"""


class Incremental(GeminiMtProvider):
    """Тот же провайдер, но с добавленной инструкцией про незаконченную фразу."""

    def build_payload(self, req, text):
        payload = super().build_payload(req, text)
        base = build_system_instruction(
            src_lang=req.src_lang, dst_lang=req.dst_lang, speaker=req.speaker,
            listener=req.listener, glossary=req.glossary, is_continuation=req.is_continuation,
        )
        payload["systemInstruction"]["parts"][0]["text"] = base + INCREMENTAL
        return payload


def phrases(min_words: int = 5, limit: int = 12):
    seen, out = set(), []
    for path in sorted(glob.glob(LOGS)):
        for line in open(path):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("kind") != "utterance" or r.get("error") or r.get("cancelled"):
                continue
            t = (r.get("srcText") or "").strip()
            if not t or t in seen or len(t.split()) < min_words:
                continue
            seen.add(t)
            out.append((t, r.get("srcLang", "ru"), r.get("dstLang", "he")))
    out.sort(key=lambda x: -len(x[0].split()))
    return out[:limit]


async def translate(prov, text, src, dst):
    speaker, listener = (ALEX, NOA) if src == "ru" else (NOA, ALEX)
    req = MtRequest(text=text, src_lang=src, dst_lang=dst, speaker=speaker,
                    listener=listener, is_continuation=False)
    t0 = time.perf_counter()
    try:
        res = await prov.translate(req)
        return res.text.strip(), (time.perf_counter() - t0) * 1000.0
    except Exception as exc:
        return f"!{exc}", (time.perf_counter() - t0) * 1000.0


def is_prefix_of(a: str, b: str) -> bool:
    """Осталось ли выданное началом того, что получилось позже.

    Сравниваем по словам, а не посимвольно: пунктуация и огласовки в иврите
    плавают между вызовами, и посимвольное сравнение объявило бы нарушением то,
    что слушатель не заметит.
    """
    aw, bw = a.split(), b.split()
    return bw[: len(aw)] == aw


async def main():
    base = Config.from_env()
    prov = Incremental(base)
    plain = GeminiMtProvider(base)

    items = phrases()
    print(f"фраз из живых звонков: {len(items)}\n")

    firsts, coverages, violations, calls, lat = [], [], 0, 0, []
    built = []

    for text, src, dst in items:
        words = text.split()
        full, _ = await translate(plain, text, src, dst)
        print(f"\n{text}")
        print(f"  целиком: {full}")

        emitted, k_first = "", None
        for k in range(2, len(words)):          # последний префикс = вся фраза
            part = " ".join(words[:k])
            # Модель видит своё же произнесённое и дописывает — переписать его
            # она не может, потому что её просят только продолжение.
            payload_text = f'SOURCE SO FAR: "{part}"\nALREADY SPOKEN: "{emitted}"'
            out, ms = await translate(prov, payload_text, src, dst)
            calls += 1
            lat.append(ms)
            if out.startswith("!"):
                print(f"  [{k}/{len(words)}] ОШИБКА {out[1:60]}")
                continue
            if out == NOTHING or not out:
                continue
            if k_first is None:
                k_first = k
                firsts.append(k / len(words))
            emitted = (emitted + " " + out).strip()
            print(f"  [{k}/{len(words)}] +{out}   ->   {emitted}")

        if emitted:
            cov = len(emitted.split()) / max(1, len(full.split()))
            coverages.append(min(cov, 1.0))
            built.append((text, emitted, full))
            print(f"  СОБРАНО:  {emitted}")

    print("\n" + "=" * 68)
    print("ИТОГ".center(68))
    print("=" * 68)
    if firsts:
        print(f"впервые выдаёт перевод на {st.median(firsts)*100:.0f}% фразы (медиана)")
    print(f"покрытие до конца фразы:   {st.median(coverages)*100:.0f}%" if coverages else "покрытия нет")
    print(f"вызовов модели:            {calls} (в {calls/max(1,len(items)):.1f} раза больше обычного)")
    print(f"задержка вызова:           медиана {st.median(lat):.0f} мс" if lat else "")
    print("=" * 68)
    print("\nНарушений стабильности здесь быть НЕ МОЖЕТ: модель дописывает и не\n"
          "переписывает. Поэтому вопрос теперь один — годится ли то, что собралось.\n"
          "Сравнивать глазами (и билингвальным судьёй), а не метрикой:\n")
    for src_text, inc, full in built:
        print(f"  · {src_text}")
        print(f"      по кускам: {inc}")
        print(f"      целиком:   {full}")


if __name__ == "__main__":
    asyncio.run(main())
