# RunPod paid-GPU readiness gate

This file is the stop/go checklist for the first paid 2 x RTX 4090 SameVoice R&D session. The Pod should stay undeployed until the **pre-GPU** gates are green.

## Green now

- [x] SpeakEasy/SameVoice runtime source is in `main`.
- [x] Backend/web/Python dependencies have lockfiles.
- [x] `npm ci` + `uv sync --frozen` are used for reproducible container installs.
- [x] Source smoke tests pass in GitHub CI.
- [x] Backend and web production builds pass in GitHub CI.
- [x] RunPod shell entrypoints pass syntax validation.
- [x] CUDA-based `Dockerfile.runpod` builds successfully in GitHub Actions.
- [x] Built image boots with the keyless mock provider trio.
- [x] Web, backend and agent healthchecks pass inside the built container.
- [x] Persistent runtime layout is defined under `/workspace`.
- [x] GPU service split is defined: GPU 0 = THINK, GPU 1 = SPEAK.
- [x] Secrets/raw audio/voice embeddings/model weights are excluded from the image/repository path.

## Pre-GPU blockers

- [ ] Select and pin the first local predictor model.
- [ ] Define the predictor request/response contract and latency timestamps.
- [ ] Implement the rolling next-source-word Top-K predictor service.
- [ ] Implement acoustic evidence/pruning service contract (even if the first implementation is deliberately simple).
- [ ] Select and pin the first local MT model or explicitly keep MT external for baseline A.
- [ ] Replace the current `runpod` MT stub with a real local HTTP adapter when the service exists.
- [ ] Decide the first local TTS path by language. Do not assume one model covers Hebrew unless verified.
- [ ] Replace the current `runpod` TTS stub only for the languages actually supported by the selected local engine.
- [ ] Decide whether STT stays Deepgram for baseline A or gets a local experimental path.
- [ ] Add per-stage queue-wait and `t0..t9` instrumentation to the benchmark record.
- [ ] Add a one-command benchmark/smoke scenario that can run immediately after Pod boot.
- [ ] Prepare RunPod secret names/environment map without committing secret values.
- [ ] Decide where benchmark results/checkpoints are exported before a Pod is terminated.

## First paid session acceptance test

The first Pod session is infrastructure validation, not a latency claim. Before loading large models:

1. run `/opt/samevoice/scripts/runpod-preflight.sh` and verify both GPUs;
2. confirm `/workspace` is mounted and writable;
3. start only the smallest chosen local engine(s);
4. verify GPU 0 and GPU 1 process placement with `nvidia-smi`;
5. run the one-command mock/baseline call test;
6. record GPU memory, queue wait, provider TTFA/latency and end-to-end timestamps;
7. stop the Pod as soon as the planned experiment is complete.

## Rule

Do not spend paid GPU time discovering package names, dependency conflicts, missing environment variables or container boot problems. Those belong in GitHub CI or a CPU-only build environment first.
