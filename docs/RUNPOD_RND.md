# RunPod R&D plan

## Objective

Build a reproducible benchmark environment for SameVoice without paying for GPU setup time unnecessarily. The first goal is not production hosting; it is to determine how low end-to-end RU↔HE speech-to-speech latency can be driven with the speculative predictor architecture.

## Location

Use a single European RunPod datacenter close to Israel so the full server-side stack is colocated. First candidate: `EU-RO-1` (Romania). Compare later with `EU-CZ-1` if needed using actual Israel→DC→Israel p50/p95 measurements.

## Initial node

Preferred high-end R&D configuration:

- 2 × RTX 4090 24 GB
- ~24 vCPU
- ~124 GB system RAM
- 60 GB container disk for disposable runtime
- persistent volume for models/checkpoints/benchmark artifacts

The 2-GPU layout is deliberately service-parallel rather than model-parallel.

### GPU 0 — latency critical

- rolling next-word predictor
- acoustic/phonetic scout
- Top-K candidate pruning
- context + personal-memory reranking
- speculative MT / local MT experiments

### GPU 1 — speech generation

- local TTS experiments
- Qwen-family TTS for supported free/low-cost language paths
- speculative TTS
- cached voice/speaker representations where legally and technically appropriate

Premium cloned-voice paths may continue to use Cartesia where it gives better language/voice quality, especially for Hebrew.

## Why colocate the stack

The benchmark should not contain an avoidable Helsinki↔GPU inter-datacenter hop. For R&D, run the web/API/realtime services and GPU engines on the same node or in the same DC whenever possible. Users/testers remain physically in Israel, so the benchmark still includes real Israel↔Europe network latency.

## Measurements

Every utterance should capture at minimum:

- `t0` speech detected at source
- `t1` first usable server audio frame
- `t2` first useful acoustic/STT evidence
- `t3` predictor start
- `t4` correct next word enters Top-K
- `t5` prediction reaches safe confidence / acoustic confirmation
- `t6` translation ready
- `t7` first TTS audio chunk ready
- `t8` audio sent toward listener
- `t9` translated audio received/played

Report separately:

- inbound network latency
- prediction latency
- acoustic-pruning latency
- MT latency
- TTS TTFA
- GPU queue wait per service
- outbound network latency
- engine-only latency
- user-perceived end-to-end latency
- p50 / p90 / p95

## Experiment order

1. Baseline current provider chain.
2. Add local next-word predictor only.
3. Add acoustic pruning.
4. Add speculative MT.
5. Add speculative TTS.
6. Add context resolver and personal-memory reranking.
7. Add latency-debt recovery (tempo/pause compression) only after correctness metrics are stable.
8. Compare 1×4090 vs 2×4090 to measure GPU contention rather than assuming the second GPU helps.

## Data persistence

Do not treat a RunPod Pod as the only copy of anything important.

Persistent/external storage must hold:

- model checkpoints
- benchmark results
- consented training/evaluation data
- derived user-language memory
- model/version manifests
- experiment configs

Never commit raw user audio, voice embeddings, secrets, API keys or private datasets to GitHub.

## Stop / restart behavior

When the Pod is running, GPU time is billed continuously. When stopped, GPU billing stops but persistent storage can continue to incur storage charges. A stopped Pod does not guarantee the same physical GPUs will still be available when restarted; production capacity planning is a later concern.

## Production rule

The live production inference model must not update its weights directly during a call. Training is offline/versioned:

`live model → collect consented data → train candidate → offline eval → shadow/canary → promote or reject`.
