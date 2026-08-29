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
