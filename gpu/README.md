# SameVoice GPU service contract

The first R&D topology reserves two independent GPU roles. The cards are used for service/pipeline parallelism; two RTX 4090s remain two separate 24 GB VRAM pools and are not treated as one 48 GB device.

## GPU 0 — THINK

Default runtime bindings:

- `ACOUSTIC_CUDA_VISIBLE_DEVICES=0`
- `PREDICTOR_CUDA_VISIBLE_DEVICES=0`
- `LOCAL_MT_CUDA_VISIBLE_DEVICES=0`

Planned responsibilities are the acoustic/phonetic scout, rolling next-source-word Top-K predictor, acoustic pruning and confidence gating, context/personal-memory reranking, and local/speculative MT when benchmarks show a latency or quality win.

The container starts these services only when the corresponding command hook is populated:

- `ACOUSTIC_SCOUT_CMD`
- `PREDICTOR_CMD`
- `LOCAL_MT_CMD`

## GPU 1 — SPEAK

Default binding:

- `TTS_CUDA_VISIBLE_DEVICES=1`

Planned responsibilities are local low-cost TTS for supported language paths, speculative TTS and cached speaker representations where permitted. The service is started only when `LOCAL_TTS_CMD` is populated.

## Runtime rule

The command hooks are intentionally empty in the base image. Model selection, licences, Hebrew quality, VRAM pressure and p50/p95 latency must be benchmarked before a local engine becomes part of the standard stack.

Model weights, checkpoints, benchmark data and caches belong under `/workspace`, not in Git or the container image.
