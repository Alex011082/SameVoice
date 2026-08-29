# Acoustic candidate pruning — Stage 2 benchmark

Stage 1 proved the software path for rolling next-SOURCE-word prediction in shadow mode. Stage 2 asks the next question: **once the linguistic predictor has Top-K candidates, how much can the first 50–250 ms of the incoming word narrow that set before the normal STT stream stabilizes the word?**

This stage remains non-audible. It re-ranks candidates; it does not commit translation or speech.

## Why a dedicated CTC scout

The main ASR engines are optimized for transcription quality and streaming semantics, not for "which of these 20 candidate words best matches the first 100 ms?". Stage 2 therefore uses a separate low-latency CTC evidence model whose only job is to expose an early grapheme fragment.

Initial benchmark models:

- RU: `bond005/wav2vec2-base-ru`
- HE: `imvladikon/wav2vec2-large-xlsr-53-hebrew`

Both are recorded as Apache-2.0 benchmark dependencies in `gpu/model_manifest.toml`. They do **not** replace Nemotron RU or ivrit.ai Whisper HE as the Stage-1 transcription engines.

## Service

`gpu.acoustic.prune_app` runs on `127.0.0.1:8105` in the GPU profile.

Request to `POST /v1/prune`:

```json
{
  "lang": "ru",
  "pcm_s16le_b64": "...",
  "candidates": [
    {"word": "купить", "probability": 0.24},
    {"word": "сказать", "probability": 0.21}
  ]
}
```

The response includes the short CTC evidence fragment, model/inference latency, and a combined candidate ranking. No candidate is irreversibly deleted by the service.

## First benchmark

Prepare 16 kHz mono s16 WAV clips whose target word starts at sample zero, plus the Top-K candidate list produced from the preceding linguistic context. Then run:

```bash
python scripts/acoustic-pruning-bench.py \
  --wav /workspace/datasets/next-word/ru/example.wav \
  --lang ru \
  --truth купить \
  --candidates /workspace/datasets/next-word/ru/example.candidates.json \
  --output /workspace/benchmarks/acoustic-pruning/example.json
```

The default windows are +50/+100/+150/+200/+250 ms. For every window the report records:

- the acoustic evidence fragment;
- inference latency;
- true-word rank;
- whether truth survived Top-20/10/5/3;
- top five candidates after re-ranking.

## Metrics that matter

Aggregate RU and HE separately. At each audio budget measure true-word retention at Top-20/10/5/3, median rank improvement vs linguistic-only Top-K, scorer p50/p90/p95 inference time, percentage of windows with no useful evidence, and catastrophic prune risk.

A useful scorer must create information **before** the regular STT word is stable. A high-quality ranking that arrives afterwards has zero latency value.

## Word-onset problem

The offline component test starts exactly at the word boundary. Live speech does not hand us that boundary for free. The later realtime integration therefore needs a short rolling PCM ring buffer and an arm timestamp when the stable linguistic prefix triggers prediction. That experiment must quantify boundary error; it must not quietly assume perfect word segmentation.

## Promotion sequence

1. Offline clips with exact word onset.
2. Add artificial onset offsets (negative and positive) to test robustness.
3. Shadow-tap real local-acoustic calls; log ranking only.
4. Measure +50/+100/+150/+200/+250 ms retention and total GPU contention with Nemotron/Whisper + Qwen + MT.
5. Only then choose an adaptive K/prune confidence rule.
6. Speculative MT and audible commit remain a later gate.

This separation is deliberate: a wrong acoustic prune destroys the correct predictor candidate before translation even begins, so the pruning layer needs its own measured safety envelope.
