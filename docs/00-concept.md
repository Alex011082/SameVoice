# SpeakEasy — концепция (выжимка, 23.08.2026)

Источник: [materials/2026-08-23-founding-dialogue.md](../materials/2026-08-23-founding-dialogue.md)

## Суть
Мессенджер/коммуникационная сеть, в которой язык человека больше не имеет значения. Язык задаётся **один раз как свойство контакта**, дальше перевод исчезает из интерфейса: нажал 📞 — говоришь на своём языке, собеседник слышит свой (в идеале — твоим голосом).

## Принципы
- **You don't choose a language. You choose a person.**
- **AI is not in the call path unless it is needed** — при совпадении языков полный AI bypass, чистый WebRTC.
- Номер телефона = только идентификатор/верификация. Публичная identity — `@username`. Реальный номер не видит никто, даже на Free.
- Слоганы: мессенджер — *Call anyone. Speak your language.* / рулетка — *Talk to anyone. You don't need to speak the same language.*

## Продукт
- **Режимы звонка:** Direct (языки совпали) / Translated (разные) / Forced translation (вручную).
- **Поверхности:** чат, голосовые, звонки, видео (перевод + субтитры), группы (каждый слышит свой язык; переводятся только нужные ветки RU→HE, RU→EN и т.д.).
- **Contact Language Profile:** `contact → language → voice → tone → translation preferences` (Мама: Anna/Calm; Банк: Daniel/Formal).
- **Два главных экрана:** **People** (кого знаешь, retention) / **World** (Random Voice, discovery, growth).

## Random Voice (рулетка)
Выбираешь только пол (Man/Woman/Anyone) → matching pool → двойной Accept → звонок. Язык **не участвует** в матчинге — барьер снят продуктом. Матч живёт 5 мин (Free) / 30 мин (Paid). GPU включается только после двойного согласия и лишь при разных языках. Воронка: незнакомец → разговор → Add contact → социальный граф. Модерация (block/report, cooldown, reputation, лимиты новых аккаунтов, анти-повторный матч) — часть matching-системы с первого дня.

## Монетизация
- **Free:** полный продукт, 5–10 синтетических голосов, стили (Neutral/Friendly/Formal/Fun/Calm), cold GPU (scale-to-zero), реклама во время прогрева («Preparing live translation…», собеседнику звонок идёт только когда GPU готов).
- **Paid ~$4.99/мес:** warm GPU, без рекламы, сильнее STT/translation/TTS, приоритет, ниже задержка, настройки на уровне контакта.
- **My Voice +$1.99/мес:** voice cloning; в рамках минутного allowance (не безлимит — unit economics).
- **Private Phone Number:** виртуальный PSTN-номер (Plus — один, Business — несколько стран); number pooling / masked calling (модель Twilio Proxy), reserved numbers за месячную плату. Работать поверх лицензированного SIP/PSTN-провайдера, не становиться оператором.
- **Call anyone (позже):** звонок на обычный номер без установки приложения у собеседника; поминутная оплата.

## Архитектура
- V1 — только app↔app WebRTC, PSTN не трогать.
- Streaming-пайплайн с перекрытием этапов: `Audio → VAD/turn detection → streaming STT → semantic chunker → Translation → streaming TTS → playback/interruption controller` + orchestrator разговора.
- Бюджет задержки: user→edge 20–50ms, media→GPU 2–10ms, VAD 150–250, STT 100–200, translation 50–150, first TTS 100–250, обратно 30–60 → **ощущаемая ~500–1000ms**. MVP-цель: 1.5–2.5 сек субъективно, потом к ~1 сек.
- RunPod: flex workers scale-to-zero (Free), active/warm (Paid), load-balancing endpoints для real-time; media/orchestration сервер в том же DC/регионе, что GPU; позже RunPod Everywhere (своё железо + overflow) и региональные пулы (IL → EU/US/Asia).
- Base44 — только админка/тарифы/CRM/модерация/аналитика. Real-time audio — отдельный backend.
- Самое сложное — не перевод, а **естественность**: паузы, перебивания, отмена начатого TTS, смена мысли на середине фразы.

## Данные и связка с YTNG
Три потока: **A. Live processing** (уничтожается после звонка), **B. Telemetry** (без содержания: языки, latency, confidence, ошибки), **C. Improvement dataset** (только с согласия: PII-scrub → анонимизация → лингвистический корпус). Общий нижний слой — **Language Intelligence Layer**; YTNG получает извлечённое языковое знание, не сырые разговоры. Granular consent (отдельно «улучшать переводы» / «связанные продукты»), самое ценное — labelled failure dataset через 👎 Bad translation. Регуляторика: Израиль Amendment 13 (с 08.2025, целевое ограничение обработки), PPA AI guidance, EDPB (гранулярность согласия).

## Рынок
Близкие: SpeakShift (ближайший), AI Call, Owaa, Yovoca (звонки на обычные номера, Owaa — с сохранением голоса). OS-уровень: Samsung Galaxy AI, Apple Live Translation, Pixel 10 (перевод с имитацией голоса). Рулетки: Ome.gg и др. Не найдено аналога: **язык вообще не параметр matchmaking** + contact-native-language как core UX + AI bypass экономика.
Оценки «ОН»: техновизна 5/10, продуктовая комбинация 8.5/10, timing 9/10, moat сейчас 4/10, moat с network effect 9/10, потенциал 9/10 при решённой дистрибуции. Референс по задержке: WIGVO (2026) ~555ms медиана KO↔EN через PSTN.

## MVP
Один экран: регистрация → контакты → язык контакта → app-to-app звонок. RU=RU → WebRTC напрямую; RU≠HE → streaming STT → translation → TTS. Без клонирования, PSTN, групп, рулетки, YTNG-pipeline. **Критерий: 20 минут естественного разговора RU↔HE, не думая о переводчике.**
Команда ядра: realtime/backend + AI/audio + mobile/fullstack + основатель (product/architecture) + AI tooling.
