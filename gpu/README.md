# SameVoice GPU service contract

The R&D topology reserves two independent GPU roles. The cards are used for service/pipeline parallelism; two RTX 4090s remain two separate 24 GB VRAM pools and are not treated as one 48 GB device.

The benchmark model selection and licences live in `gpu/model_manifest.toml`. Model weights, checkpoints, benchmark data and caches belong under `/workspace`, never in Git or an image layer.

## GPU 0 — THINK

Default runtime bindings:

- `ACOUSTIC_CUDA_VISIBLE_DEVICES=0`
- `PREDICTOR_CUDA_VISIBLE_DEVICES=0`
- `LOCAL_MT_CUDA_VISIBLE_DEVICES=0`

### Implemented Stage 1 services

**Rolling predictor — port 8101**

`gpu.predictor.app` loads `Qwen/Qwen3-0.6B-Base` lazily and predicts only the next SOURCE word. It over-generates a bounded number of short token beams, collapses them to unique Unicode words, optionally reranks exact context terms, and returns Top-K candidates with within-set probabilities. This is deliberately not a phrase tree.

**Local MT — port 8103**

`gpu.mt.app` lazily loads the pair-specific Marian baselines:

- `Helsinki-NLP/opus-mt-ru-he`
- `Helsinki-NLP/opus-mt-he-ru`

Generation is greedy (`num_beams=1`) for the first latency baseline. The main Python agent has a real HTTP `RunpodMtProvider` adapter for this service. Deep call-context conditioning is intentionally not faked into Marian; quality is compared against the existing Gemini path before any default changes.

Both services share `/opt/venvs/think` (Python 3.11) in images built with `INSTALL_GPU_ENGINES=1`. `CUDA_VISIBLE_DEVICES=0` is applied by the outer entrypoint, so each process sees its assigned physical 4090 as local `cuda:0`.

### Next THINK service — acoustic scout / streaming ASR

Port `8102` remains reserved. First A/B candidates are:

- NVIDIA Nemotron 3.5 ASR Streaming 0.6B for native cache-aware streaming;
- ivrit-ai Whisper Large v3 Turbo as a Hebrew-specific quality control/fallback.

Do not replace Deepgram in the call path until live Hebrew/Russian WER, partial stability, utterance-boundary/VAD behaviour and prediction-lead-time measurements are available.

## GPU 1 — SPEAK

Default binding:

- `TTS_CUDA_VISIBLE_DEVICES=1`

### Implemented A/B service — port 8104

`gpu.tts.app` is a deliberately **batch-labelled** Chatterbox Multilingual V3 service for RU/HE quality testing. It supports the built-in voice and safe named reference WAVs under `/workspace/voices/<lang>/<voice_id>.wav`. It returns mono s16le PCM plus explicit headers for sample rate, model, generation latency, streaming status and watermark status.

The main agent now has a `RunpodTtsProvider` client that can consume this PCM contract. The client splits the completed waveform into 20 ms chunks for the existing resampler, but this does **not** turn a batch server response into true streaming. `mt_done_to_first_audio_ms` therefore remains the relevant measurement and will expose the full generation wait.

The Chatterbox runtime is isolated in `/opt/venvs/speak` and is installed only when `INSTALL_TTS_ENGINE=1`. This prevents its torch/transformers dependency pins from contaminating the GPU0 predictor/MT environment.

Cartesia remains the realtime quality control. Qwen3-TTS remains a later Russian-specific streaming/voice-clone A/B candidate; it is not used for Hebrew because Hebrew is outside its official language set.

## Runtime profiles

`docker/runpod.env.example` remains the conservative scaffold with all local engine hooks disabled.

`docker/runpod-gpu.env.example` enables the implemented GPU0 predictor + local MT services only.

`docker/runpod-gpu-tts-ab.env.example` additionally enables the batch Chatterbox service on GPU1. It is an explicit A/B profile, not the realtime default.

## GPU queue instrumentation

The predictor (8101) and the acoustic pruner (8105) are pinned to the same physical card, which cannot run two inferences at once. Each of them therefore admits GPU work through an `asyncio.Semaphore` (`gpu/queueing.py`) and runs the blocking call via `asyncio.to_thread`. Concurrency is `1` by default and configurable per service:

- `PREDICTOR_GPU_CONCURRENCY`
- `ACOUSTIC_PRUNER_GPU_CONCURRENCY`

Raising either above 1 does not make the card faster; it interleaves forward passes and makes both numbers below unreadable as physical time on the GPU. The configured value is reported by each `/healthz` (`gpu_concurrency`), so a benchmark artifact can be checked against the setting the run actually used.

Every `/v1/predict` and `/v1/prune` response carries three separate numbers instead of one:

- `queue_wait_ms` — request entry until the card was acquired;
- `inference_ms` — the blocking model call held under the semaphore. Both engines load their weights lazily, so on the **first** call after boot this includes the model load; `load_ms` is published next to it for exactly that reason. `/v1/warmup` goes through the same semaphore, so warming a service before benchmarking it moves that cost out of the first measured request instead of hiding it in another request's `inference_ms`;
- `total_ms` — request entry until the handler assembled its return value. The semaphore is already released by then, so `total_ms - (queue_wait_ms + inference_ms)` is the handler's own post-GPU work (candidate ranking, building the response object) charged to the CPU instead of to the model. It is not the whole response cost: uvicorn encodes and writes the JSON after this stamp is taken, so wire time appears only in a client-side round trip.

The pruner additionally keeps `model_forward_ms`, the narrower forward-only number that `inference_ms` used to carry. `scripts/acoustic-pruning-bench.py` and `scripts/acoustic-replay-bench.py` read `model_forward_ms` for their `inferenceMs` column so it keeps the same meaning across this change; both also record `queueWaitMs`.

Without this split a slow answer cannot be attributed to the queue rather than the model by any later analysis of the log — see `docs/12-latency-timestamps.md`. The acoustic websocket service publishes the same split as `queue_wait_ms` next to `latency_ms` on its `partial`/`final` events. There the two engines agree on one rule and differ on another, and both matter when reading a log: `latency_ms` is anchored before that engine's wait in **both** languages, so `queue_wait_ms` is always a component of it and must never be added to it — but the remainder is not the same quantity. For `he` (`HebrewWhisperEngine`) `latency_ms - queue_wait_ms` is model time exactly; for `ru` (`NemotronUtterance`) the anchor is the utterance constructor rather than the start of the forward pass, so the remainder also contains audio feeding and is only an upper bound. A consumer cannot tell the two apart without reading `engine`.

There is no acceptance threshold on `queue_wait_ms` yet: `gpu/acoustic_gate.default.json` gates round-trip p95 only. The point of recording the split now is that a threshold on it would have been unfalsifiable before, because nothing in either process ever queued.

## Benchmark harness

`scripts/runpod-stage1-bench.py` warms the predictor and both local MT directions, runs repeat loopback requests, reports p50/p90/p95 and writes a JSON artifact under `/workspace/benchmarks`.

A local engine is promoted into the realtime path only after reproducible measurements. At minimum record:

- model load/warmup time;
- GPU VRAM and queue wait;
- p50/p90/p95 inference latency;
- predictor Top-1/3/5/10/20 recall and prediction lead time;
- MT quality against the external control;
- STT WER + partial-hypothesis stability for RU and HE;
- TTS TTFA, real-time factor, voice similarity and Hebrew/Russian naturalness;
- end-to-end translated-audio latency and premature-commit rate.

The production inference model never updates its weights during a live call. Training/fine-tuning remains offline, versioned and separately evaluated.
