"""Замер своего стека на БЕСПЛАТНОМ GPU Kaggle. Вставить в одну ячейку блокнота.

ПОЧЕМУ KAGGLE. 27.08.2026 все платные площадки оказались закрыты: RunPod не
принимает дебетовую карту, у Vultr нет свободных GPU ни в одной локации,
Paperspace требует аппрув 1-2 рабочих дня. Kaggle даёт **P100 16 ГБ или 2xT4
бесплатно, 30 часов в неделю, без карты вообще**. Наши модели весят 5 ГБ —
влезают с запасом.

И тут исчезает та ошибка, которая стоила $7: на Kaggle **нет поминутного
счётчика**, поэтому возня с зависимостями стоит времени, а не денег.

ЧТО ЭТО ОТВЕЧАЕТ
Единственный вопрос: даёт ли свой стек готовый перевод быстрее, чем облако.
Боевая медиана (24 звонка): речь -> первая гипотеза 917 мс, речь -> готовый
перевод ~2095 мс. Синтез (Cartesia, 240 мс) остаётся в любом случае и здесь не
меряется.

P100 медленнее боевой карты. Это НЕ проблема: он даёт **верхнюю границу**.
Уложился P100 — уложится и A40. Не уложился — смотрим разбивку и решаем, дело
в железе или в подходе.

ПЕРЕД ЗАПУСКОМ
1. Settings -> Accelerator -> GPU P100 (или T4 x2)
2. Settings -> Internet -> On
3. Перетащить русскую запись (alex_ref.wav) в Input блокнота
"""

import asyncio, json, os, subprocess, sys, time, glob, statistics, socket

BASELINE_FIRST_PARTIAL_MS = 917    # речь -> первая гипотеза Deepgram
BASELINE_TRANSLATION_MS = 2095     # речь -> готовый перевод (Deepgram+чанкер+Gemini)
CHUNK_MS = 100
RATE = 16000
SRC, DST = "ru", "he"
# Скрипт живёт и на Kaggle, и на обычной GPU-машине (GCP Deep Learning VM), где
# каталога /kaggle/working нет. Путь к логу поэтому вычисляется, а не зашит.
WORKDIR = "/kaggle/working" if os.path.isdir("/kaggle/working") else os.getcwd()
LOGFILE = os.path.join(WORKDIR, "wlk.log")


def sh(cmd, **kw):
    print(f"$ {cmd}", flush=True)
    return subprocess.run(cmd, shell=True, **kw)


def install():
    """Ставит стек. torch НЕ трогаем: на Kaggle он уже под правильную CUDA.

    НЕ ПЕРЕЗАГРУЖАТЬ torch через importlib.reload — 27.08.2026 это уронило
    первый запуск с `RuntimeError: Only a single TORCH_LIBRARY can be used to
    register the namespace triton`. Повторное выполнение модуля torch заново
    регистрирует его C++-неймспейсы, а дважды так нельзя.

    Если pip всё-таки подменит torch на диске, в памяти останется СТАРЫЙ — то
    самое молчаливое враньё, от которого мы защищаемся. Лечится не reload'ом,
    а перезапуском ядра: Run -> Restart & Run All.
    """
    # ИМЕННО sys.executable -m pip, а не голый `pip`. На Deep Learning VM у GCP
    # это разные интерпретаторы: `pip` ставит в ~/.local для системного python,
    # а скрипт исполняется conda-питоном — и пакеты «ставятся», но не находятся.
    # Экстра [nllb] в 0.2.19 не существует — перевод даёт пакет `nllw`.
    sh(f'"{sys.executable}" -m pip install -q "transformers>=4.45,<5" '
       f'whisperlivekit nllw websockets soundfile 2>&1 | tail -3')


def require_cuda():
    import torch
    from transformers.utils import is_torch_available
    ok = torch.cuda.is_available()
    name = torch.cuda.get_device_name(0) if ok else "НЕТ"
    print(f"GPU: {name} | CUDA {ok} | transformers видит torch: {is_torch_available()}")
    if not ok:
        sys.exit("ОСТАНОВ: без CUDA замер бессмысленен — модель уйдёт считать на CPU "
                 "и покажет числа, которые ничего не значат.")


def find_audio():
    for pat in ("/kaggle/input/**/*.wav", "/kaggle/working/*.wav", "*.wav"):
        hits = sorted(glob.glob(pat, recursive=True))
        if hits:
            print(f"запись: {hits[0]}")
            return hits[0]
    sys.exit("ОСТАНОВ: нет .wav. Перетащи русскую запись в Input блокнота.")


def start_server():
    # --pcm-input ОБЯЗАТЕЛЕН. Без него сервер прогоняет вход через ffmpeg, ждёт
    # контейнер от браузера и молчит с FFmpeg read timeout. Найдено руками
    # 26.08.2026, стоило часа.
    # Через -m, чтобы не зависеть от того, попал ли каталог со скриптами в PATH.
    cmd = (f'"{sys.executable}" -m whisperlivekit.basic_server '
           f"--host 127.0.0.1 --port 8000 "
           f"--model large-v3-turbo --backend faster-whisper "
           f"--lan {SRC} --target-language {DST} "
           # Флаг `--translation-backend` был в старых версиях; в 0.2.19 его НЕТ,
           # сервер падает с "unrecognized arguments". Перевод включается самим
           # `--target-language`, а тонкая настройка — через --nllb-size.
           f"--backend-policy simulstreaming --nllb-size 600M --pcm-input")
    print(f"$ {cmd} &", flush=True)
    log = open(LOGFILE, "wb")
    proc = subprocess.Popen(cmd, shell=True, stdout=log, stderr=subprocess.STDOUT)
    for i in range(180):  # веса качаются несколько минут
        with socket.socket() as s:
            s.settimeout(1)
            if s.connect_ex(("127.0.0.1", 8000)) == 0:
                print(f"сервер поднялся за ~{i} с")
                time.sleep(5)  # дать модели догрузиться в видеопамять
                return proc
        if proc.poll() is not None:
            sh(f"tail -40 {LOGFILE}")
            sys.exit("ОСТАНОВ: сервер умер, лог выше")
        time.sleep(1)
    sys.exit("ОСТАНОВ: сервер не поднялся за 3 минуты")


def pcm16(path):
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-acodec", "pcm_s16le",
         "-ac", "1", "-ar", str(RATE), "-"], capture_output=True, check=True).stdout


async def measure(audio):
    import websockets
    pcm = pcm16(audio)
    print(f"длительность записи: {len(pcm)/2/RATE:.1f} с — подаём в РЕАЛЬНОМ времени")

    url = f"ws://127.0.0.1:8000/asr?src_lang={SRC}&tgt_lang={DST}"
    res = {"first_text_ms": None, "first_translation_ms": None,
           "texts": [], "translations": []}

    async with websockets.connect(url, max_size=None) as ws:
        t0 = time.perf_counter()

        async def feed():
            step = int(RATE * CHUNK_MS / 1000) * 2
            for i in range(0, len(pcm), step):
                await ws.send(pcm[i:i + step])
                await asyncio.sleep(CHUNK_MS / 1000)
            await ws.send(b"")

        async def read():
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                now = (time.perf_counter() - t0) * 1000.0

                for line in msg.get("lines") or []:
                    t = (line.get("text") or "").strip()
                    if t and t not in res["texts"]:
                        res["texts"].append(t)
                        if res["first_text_ms"] is None:
                            res["first_text_ms"] = now
                            print(f"  [{now:6.0f} мс] первый текст: {t[:70]}")
                    # перевод бывает и в строке...
                    tr = (line.get("translation") or "").strip()
                    if tr and tr not in res["translations"]:
                        res["translations"].append(tr)
                        if res["first_translation_ms"] is None:
                            res["first_translation_ms"] = now
                            print(f"  [{now:6.0f} мс] первый перевод: {tr[:70]}")

                # ...а чаще ОТДЕЛЬНЫМ полем верхнего уровня. Найдено руками
                # 26.08.2026: в строках только text/speaker/start/end.
                tr = (msg.get("buffer_translation") or "").strip()
                if tr and tr not in res["translations"]:
                    res["translations"].append(tr)
                    if res["first_translation_ms"] is None:
                        res["first_translation_ms"] = now
                        print(f"  [{now:6.0f} мс] первый перевод: {tr[:70]}")

        feeder = asyncio.create_task(feed())
        reader = asyncio.create_task(read())
        await feeder
        try:
            await asyncio.wait_for(reader, timeout=20)
        except asyncio.TimeoutError:
            reader.cancel()
    return res


def verdict(res):
    print("\n" + "=" * 66)
    print("РЕЗУЛЬТАТ".center(66))
    print("=" * 66)

    rows = [("речь -> первый текст", res["first_text_ms"], BASELINE_FIRST_PARTIAL_MS),
            ("речь -> первый перевод", res["first_translation_ms"], BASELINE_TRANSLATION_MS)]
    for name, got, base in rows:
        if got is None:
            print(f"{name:26s}  НЕ ПОЛУЧЕНО   (облако: {base} мс)")
            continue
        d = base - got
        mark = "ЛУЧШЕ" if d > 0 else "ХУЖЕ"
        print(f"{name:26s} {got:7.0f} мс   облако {base:5d} мс   {mark} на {abs(d):.0f}")

    print("-" * 66)
    if res["first_translation_ms"] is None:
        print("Перевод не пришёл вовсе. Смотри /kaggle/working/wlk.log — скорее всего\n"
              "NLLB не загрузился. Это ровно то, что случилось на маке 26.08.")
    elif res["first_translation_ms"] < BASELINE_TRANSLATION_MS * 0.7:
        print("Своё железо ощутимо быстрее облака. Есть ради чего искать карту в\n"
              "Израиле: плюс синтез Cartesia 240 мс — и мы в целевом коридоре.")
    elif res["first_translation_ms"] < BASELINE_TRANSLATION_MS:
        print("Выигрыш есть, но небольшой — и это на МЕДЛЕННОМ P100. На боевой карте\n"
              "будет лучше, но чуда ждать не стоит.")
    else:
        print("Своё железо НЕ быстрее облака. Тему аренды GPU можно закрывать —\n"
              "секунды сидят в другом месте, и мы это выяснили бесплатно.")
    print("=" * 66)
    print("\nРаспознано:", " | ".join(res["texts"][:5]))
    print("Переведено:", " | ".join(res["translations"][:5]))


if __name__ == "__main__":
    install()
    require_cuda()
    audio = find_audio()
    proc = start_server()
    try:
        verdict(asyncio.run(measure(audio)))
    finally:
        proc.terminate()
