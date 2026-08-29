# SameVoice

Private R&D repository for a real-time multilingual voice communication system focused on **low latency**, **voice identity preservation**, and **context-aware speculative speech translation**.

## Current product contours

1. **Calls** — app-to-app translated calls. Same-language calls bypass AI and stay direct WebRTC.
2. **Random Voice** — time-window matching with language-independent conversations.
3. **Listen** — one-way translation for cinema, lectures, events, TV and nearby speech.
4. **Phone** — translated calls to ordinary mobile/landline/PSTN numbers, so the other party does not need SameVoice.

## Core R&D objective

Primary benchmark: reduce end-to-end speech-to-speech latency on difficult language pairs, especially **Russian ↔ Hebrew**, while preserving translation quality and speaker identity.

Target research range:

- RU ↔ HE: ~1.7 s median target
- easier EN pairs / EN ↔ ZH: ~1.6–1.7 s target
- measure p50/p90/p95, not only best-case demos

## Proposed proprietary layer

The main research direction is a rolling, one-word speculative runtime:

- predict Top-K candidates for the **next source word**;
- continuously prune candidates using incoming acoustic/phonetic evidence;
- prepare translation and speech synthesis speculatively;
- commit only when confidence is safe;
- shift the window by one word and repeat;
- combine global language priors, current-call context and per-user language memory;
- manage latency debt using safe tempo/pause compression where appropriate.

## R&D infrastructure direction

Initial benchmark environment is planned as a single European RunPod node close to Israel, with the entire test stack colocated to remove inter-datacenter jitter.

Candidate configuration:

- 2 × RTX 4090
- 24 vCPU
- ~124 GB RAM
- one GPU reserved for latency-critical prediction/MT
- one GPU reserved for TTS/audio generation
- persistent storage for models, checkpoints and benchmark data

Production architecture will be decided only after measured R&D results.

## RunPod container preparation

The repository now contains a reproducible R&D container scaffold:

- `Dockerfile.runpod` — CUDA 12.8 runtime, Node 22, Python 3.13 via `uv`, backend/web/agent dependencies and compiled web/backend;
- `docker/entrypoint.sh` — starts the current app services and reserves independent GPU hooks for predictor/MT and TTS;
- `docker/healthcheck.sh` — verifies web, backend and agent;
- `docker/runpod.env.example` — non-secret runtime layout;
- `scripts/runpod-preflight.sh` — checks the 2-GPU runtime and persistent `/workspace` before paid benchmark work starts;
- `docs/RUNPOD_RND.md` and `docker/README.md` — deployment and benchmark notes.

The image is **not built or deployed yet**. Model weights are intentionally not downloaded during repository preparation.

## Repository policy

This repository is **private**. Do not publish predictor internals, patentable implementation details, private datasets, user audio, voice embeddings, API keys, model weights with restrictive licenses, or consent-sensitive data.

## Status

The tracked SpeakEasy application source has been migrated into `main`. Current application code includes the web client, Fastify backend, Python relay agent, panel, scripts, tests and evaluation tooling. The repository is now being normalized for the first RunPod R&D image and the later local predictor/MT/TTS services.
