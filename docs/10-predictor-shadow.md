# Rolling next-word predictor — shadow gate

This stage connects the local next-SOURCE-word predictor to real STT hypotheses without allowing it to change translation or audio. Shadow mode is measurement infrastructure, not a latency optimization by itself.

## Safe first live profile

For the first GPU benchmark keep the already-known speech path as the control:

```text
STT_PROVIDER=deepgram
MT_PROVIDER=gemini
TTS_PROVIDER=cartesia

PREDICTOR_SHADOW_ENABLED=1
PREDICTOR_URL=http://127.0.0.1:8101
PREDICTOR_TOP_K=20
PREDICTOR_MIN_PREFIX_WORDS=3
PREDICTOR_TIMEOUT_MS=600
```

The predictor therefore runs on GPU0 while Deepgram/Gemini/Cartesia still determine what the two people actually hear. The existing selected Cartesia RU/HE voice IDs remain normal environment secrets; shadow mode does not inspect or replace them.

After this control run, `STT_PROVIDER=runpod` can A/B the local acoustic service against Deepgram while leaving MT/TTS unchanged.

## What counts as a prediction attempt

For partial STT hypotheses `H[n-1]` and `H[n]`, the runtime computes their longest common Unicode word prefix. A predictor request is issued only when that prefix contains at least `PREDICTOR_MIN_PREFIX_WORDS` words. This is intentionally conservative: one unstable partial is not treated as truth.

If prefix words 1..N survive, the predictor is asked for candidates for source word N+1 only. No future sentence tree is created.

The attempt is scored only when the actual word N+1 itself becomes stable in a later hypothesis or final transcript.

## Per-attempt JSONL record

`logs/calls/<callId>.jsonl` receives records with `kind=prediction_shadow`. Important fields:

- `prefix`, `prefixWords`
- `actualNextWord`
- `candidates`
- `rank`
- `hits.top1/top3/top5/top10/top20`
- `predictorModelLatencyMs`
- `predictorRoundTripMs`
- `sttLeadMs`

`sttLeadMs > 0` means the predictor answer existed before the normal STT stream stabilized the actual following word. `sttLeadMs < 0` means the prediction arrived too late to create linguistic lead.

This is deliberately named **STT lead**, not acoustic Prediction Lead Time. The next stage will measure candidate elimination from the first +50/+100/+150/+200 ms of the incoming word and record that separately.

## Summarize a call

```bash
cd agent
uv run python scripts/summarize_prediction_shadow.py ../logs/calls/<callId>.jsonl
```

The report contains Top-1/3/5/10/20 recall, predictor RTT p50/p90/p95, STT-lead p50/p90/p95, positive-lead rate, and separate RU/HE results.

## Promotion rule

Do not wire predictions into MT/TTS on the strength of a few good examples. Collect enough natural RU↔HE speech to see stable distributions and tail latency. Keep wrong/late predictions because they are part of the result.

Only after the linguistic predictor has useful Top-K recall and positive lead should the acoustic-pruning stage be allowed to reduce Top-K using early audio. Audible speculative commit comes later and requires a separate wrong-commit safety gate.
