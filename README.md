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

## Repository policy

This repository is **private**. Do not publish predictor internals, patentable implementation details, private datasets, user audio, voice embeddings, API keys, model weights with restrictive licenses, or consent-sensitive data.

## Status

Repository initialized. Existing SpeakEasy/SameVoice source will be migrated and normalized before the RunPod image is built.
