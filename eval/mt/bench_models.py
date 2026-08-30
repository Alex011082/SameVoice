"""Кто из моделей перевода укладывается в коридор — на РЕАЛЬНЫХ репликах.

Повод: звонок 27.08.2026 (Alex+Noa) дал 5 ошибок из 26 реплик, четыре из них —
`gemini timed out after 4.0s`, пятая — `MAX_TOKENS`. Медиана вендора выросла до
1192 мс, сквозная задержка до 6773 мс. Перевод стал главным узким местом и при
этом начал ОТКАЗЫВАТЬ.

Меряем через НАШ боевой код (те же промпты, тот же разбор ответа), а не через
голый REST: иначе сравниваем не то, что работает в проде.

Запускать НА СЕРВЕРЕ — ключи там:
  scp eval/mt/bench_models.py samevoice:/tmp/ && \
  ssh samevoice 'cd /opt/samevoice/agent && .venv/bin/python /tmp/bench_models.py'
"""

from __future__ import annotations
import asyncio, json, glob, statistics as st, sys, time
sys.path.insert(0, "/opt/samevoice/agent/src")

from speakeasy_agent.config import Config
from speakeasy_agent.providers.base import MtRequest, Speaker

LOGS = "/opt/samevoice/logs/calls/*.jsonl"
ALEX = Speaker("u_alex", "Alex", "ru", "m", "neutral")
NOA = Speaker("u_noa", "Noa", "he", "f", "friendly")


def real_phrases(limit: int = 24) -> list[tuple[str, str, str]]:
    """(текст, откуда, куда) — только то, что действительно говорили в звонках."""
    seen, out = set(), []
    for path in sorted(glob.glob(LOGS)):
        for line in open(path):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("kind") != "utterance":
                continue
            t = (r.get("srcText") or "").strip()
            if not t or t in seen or len(t.split()) < 2:
                continue
            seen.add(t)
            out.append((t, r.get("srcLang", "ru"), r.get("dstLang", "he")))
    # длинные реплики впереди: на них модель думает дольше всего, там и рвётся
    out.sort(key=lambda x: -len(x[0].split()))
    return out[:limit]


async def run(label: str, provider, phrases) -> None:
    lat, fails, empties = [], [], 0
    for text, src, dst in phrases:
        speaker, listener = (ALEX, NOA) if src == "ru" else (NOA, ALEX)
        req = MtRequest(text=text, src_lang=src, dst_lang=dst, speaker=speaker,
                        listener=listener, is_continuation=False)
        t0 = time.perf_counter()
        try:
            res = await provider.translate(req)
            ms = (time.perf_counter() - t0) * 1000.0
            lat.append(ms)
            if not res.text.strip():
                empties += 1
        except Exception as exc:
            fails.append(f"{text[:34]!r}: {str(exc)[:60]}")

    n = len(phrases)
    if lat:
        s = sorted(lat)
        p90 = s[min(len(s) - 1, int(len(s) * 0.9))]
        print(f"{label:34s} медиана {st.median(s):6.0f}  p90 {p90:6.0f}  "
              f"худшая {s[-1]:6.0f}   отказов {len(fails)}/{n}  пустых {empties}")
    else:
        print(f"{label:34s} ВСЁ УПАЛО ({len(fails)}/{n})")
    for f in fails[:3]:
        print(f"     └ {f}")


async def main() -> None:
    phrases = real_phrases()
    print(f"реплик из живых звонков: {len(phrases)}, "
          f"медиана длины {st.median([len(p[0].split()) for p in phrases]):.0f} слов\n")

    base = Config.from_env()
    from speakeasy_agent.providers.mt_gemini import GeminiMtProvider
    from speakeasy_agent.providers.mt_openai import OpenAiMtProvider

    # Боевой коридор — 4045 мс всего, значит переводу отведено ~800 мс.
    # Всё, что медленнее, съедает бюджет остальных стадий.
    variants = [
        ("gemini-3.7-flash / low", GeminiMtProvider,
         {"gemini_model": "gemini-3.7-flash", "gemini_thinking_level": "low"}),
        ("gemini-3.5-flash-lite / minimal", GeminiMtProvider,
         {"gemini_model": "gemini-3.5-flash-lite", "gemini_thinking_level": "minimal"}),
        ("gemini-3.5-flash-lite / low", GeminiMtProvider,
         {"gemini_model": "gemini-3.5-flash-lite", "gemini_thinking_level": "low"}),
        ("gpt-5.6-luna / none", OpenAiMtProvider, {}),
    ]

    for label, cls, over in variants:
        cfg = Config(**{**base.__dict__, **over})
        if cls is OpenAiMtProvider and not cfg.openai_api_key:
            print(f"{label:34s} пропуск — нет OPENAI_API_KEY")
            continue
        provider = cls(cfg)
        try:
            await run(label, provider, phrases)
        finally:
            close = getattr(provider, "aclose", None) or getattr(provider, "close", None)
            if close:
                try:
                    await close()
                except Exception:
                    pass


if __name__ == "__main__":
    asyncio.run(main())
