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

## Exporting results before the Pod is stopped

`scripts/runpod-export.sh` implements step 7 of the acceptance test in `docs/RUNPOD_READINESS.md` — "export the artifacts off the Pod **before** stopping it, and write a run manifest next to them" — which until now was specified and never built. Run `bash /opt/samevoice/scripts/runpod-export.sh` as the last step of every paid session: after the measurements, before the Pod is stopped. Not after — a stop is the event the export exists to survive. Run it again after any further experiment; each run writes its own timestamped bundle and never overwrites an earlier one, including when two runs land in the same second.

The risk is structural, not hypothetical. Every result path in the image points inside `/workspace` (`BENCHMARK_DIR`, `EVAL_LOG_DIR`, `CALL_ARCHIVE_DIR`), and nothing else in this repository moves a byte off the Pod. `docker/entrypoint.sh`'s `cleanup()` only kills child processes, so a stop signal flushes and copies nothing. Worse, `scripts/runpod-preflight.sh` proves only that `/workspace` is *writable*, which the ephemeral container overlay is too — a Pod created without a volume passes preflight and still loses the whole session on stop. The export script therefore compares filesystem device ids and refuses to write when its destination turns out to be container disk, saying why.

The bundle is one timestamped `.tar.gz` under `/workspace/exports` holding the eval JSONL logs, the benchmark artifacts, an `nvidia-smi` snapshot taken at export time, `gpu/model_manifest.toml` plus each service's `/healthz` (which reports the model id that actually loaded, not the one that was configured), the non-secret environment and a run manifest. The script then prints the one-line `scp`/`rsync` command to run from the laptop. Secrets, raw audio and voice embeddings are excluded by allow-list — voice is biometrics here — and every skipped file is named in `EXCLUDED.txt` inside the bundle.

Three limits to know before the session starts:

- `CALL_ARCHIVE_DIR` is a result path but is deliberately **not** exported. It holds one JSON file per finished call — a conversation between two named people, readable by exactly those two — so the script treats `/workspace/logs/archive` the same way it treats model weights and voice references: pointing a source at it, or at any directory containing it, aborts the run rather than producing a bundle;
- `.dockerignore` excludes `.git` from the image and no build argument records a commit, so the run manifest carries `git_sha: null` on a Pod. Attribute a bundle by the image tag/digest from the RunPod console instead;
- a `/healthz` is only captured for a service that is actually up. Each miss is recorded as a note in the manifest, because a benchmark number whose checkpoint cannot be confirmed should not be quoted as if it could.

Stop the Pod only once the tarball is on the laptop and its `sha256` matches.
