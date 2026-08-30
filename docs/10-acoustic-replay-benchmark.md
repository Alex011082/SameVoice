# Stage 3 — predictor + acoustic-pruner replay benchmark

This stage answers one narrow question before any realtime pruning is allowed to influence a call:

> How much earlier than conventional STT can SameVoice identify the real next source word by combining linguistic Top-K prediction with the first 50–250 ms of that word's acoustics, and how often would pruning discard the correct candidate?

## What is measured

The replay harness treats Russian and Hebrew separately and reports:

- predictor Top-1/3/5/10/20 recall for the real next source word;
- acoustic re-ranking at +50/+100/+150/+200/+250 ms from physical word onset;
- conditional Top-K retention: among examples where the predictor supplied the true word, how often acoustics keeps it inside Top-K;
- conditional drop rate, the safety-critical inverse of retention;
- end-to-end Top-K recall including predictor misses;
- rank movement from linguistic rank to acoustic rank;
- predictor and pruner round-trip latency plus model-side inference latency;
- p50/p90/p95 for latency and lead;
- lead versus a labelled conventional-STT stabilization baseline;
- RU and HE metrics separately;
- an automatic `PROMOTE`, `HOLD`, or `REJECT` R&D verdict.

`PROMOTE` means only that the measured configuration is good enough to implement the next **soft realtime pruning** experiment. It never enables hard pruning, speculative audible speech, or production routing.

## Dataset manifest

Each labelled example points to a 16 kHz mono signed-16 PCM WAV and identifies one target next word:

```json
{
  "id": "ru-001",
  "lang": "ru",
  "wav": "audio/ru-001.wav",
  "prefix": "я завтра хочу",
  "truth": "купить",
  "wordStartMs": 812.0,
  "baselineSttStableMs": 610.0,
  "predictorReadyMsFromWordOnset": -180.0,
  "contextTerms": ["банк", "Ашкелон"]
}
```

`wordStartMs` is the physical onset of `truth` inside the WAV. It must be labelled or obtained from a trusted alignment pass; the benchmark must not silently use ordinary STT output as the word-onset ground truth.

`baselineSttStableMs` is measured **from target-word onset**, not from utterance start. It is the time until the ordinary STT stream first has the correct target word stably available.

`predictorReadyMsFromWordOnset` is optional. Negative means Top-K was ready before word onset. Positive means it arrived after onset. If omitted, the report still computes a deliberately pessimistic `coldParallelLeadVsSttMs` by assuming the predictor starts at word onset.

## Lead definitions

For a window `W` and measured pruner round trip `P`:

- `componentReadyAfterWordOnsetMs = W + P` — assumes candidate Top-K already exists at onset;
- `coldParallelReadyAfterWordOnsetMs = max(W, predictorRTT) + P` — pessimistically starts predictor at onset;
- `observedChainReadyAfterWordOnsetMs = max(W, predictorReadyMsFromWordOnset) + P` — used when an observed predictor-ready offset is supplied.

Lead is `baselineSttStableMs - readyAfterWordOnsetMs`. Positive is good: the candidate decision existed before conventional STT stabilized the word.

## Run on the GPU R&D pod

After the predictor on `:8101` and acoustic pruner on `:8105` are warm:

```bash
cd /opt/samevoice
/opt/venvs/think/bin/python scripts/acoustic-replay-bench.py \
  --manifest /workspace/datasets/replay/manifest.json \
  --dataset-root /workspace/datasets/replay \
  --gate-config gpu/acoustic_gate.default.json \
  --output /workspace/benchmarks/acoustic-replay.json \
  --markdown /workspace/benchmarks/acoustic-replay.md
```

The JSON contains every sample and every window so a later model/version can be compared against exactly the same labelled corpus. The Markdown file is the human-readable gate report.

## Default promotion gate

The tracked defaults are intentionally conservative and live in `gpu/acoustic_gate.default.json`. Before promotion, both RU and HE need enough examples and must independently satisfy the target 150 ms gate. Current defaults require, among other checks:

- at least 30 labelled target words per language;
- predictor Top-20 recall >= 95%;
- at 150 ms, conditional Top-5 retention >= 95%;
- at 150 ms, conditional Top-3 retention >= 88%;
- at 150 ms, Top-5 drop rate <= 5%;
- positive cold-parallel lead on >= 75% of labelled examples;
- p50 cold-parallel lead >= 150 ms;
- pruner p95 round trip <= 220 ms.

These values are experiment gates, not product SLAs. They are versioned so a future change cannot make an old result look better by silently moving the threshold.

## Dataset size

Thirty examples per language is only the minimum gate that prevents decisions from being made on a handful of anecdotes. A meaningful R&D conclusion should quickly grow toward hundreds of naturally spoken target words per language, with different speakers, speech rates, names, code-switching, noise levels, and sentence positions.

The final decision must be based on the same corpus replayed across candidate model/configuration changes. Do not compare two configurations on different audio samples.
