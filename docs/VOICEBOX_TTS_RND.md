# Voicebox / Chatterbox Multilingual — SameVoice TTS R&D note

**Status:** R&D candidate, not a production dependency yet  
**Target:** SameVoice realtime RU↔HE calls  
**Primary question:** can a local cloned-voice TTS path match or beat Cartesia for Hebrew/Russian while remaining fast enough for speculative realtime speech?

## Executive decision

Voicebox is useful to SameVoice primarily as a **reference implementation and TTS R&D donor**, not as a drop-in realtime speech server.

The most important discovery is **Chatterbox Multilingual**:

- multilingual cloned-voice TTS;
- Hebrew (`he`) and Russian (`ru`) are supported by the upstream model;
- the upstream Chatterbox model is published under MIT;
- Voicebox already wraps Chatterbox and several other TTS engines behind a common application architecture;
- Voicebox already contains useful patterns for voice profiles, reference samples, model loading/unloading, generation queues, retries and multi-engine A/B work.

This gives SameVoice a credible local Hebrew/Russian TTS candidate for GPU1. It does **not** replace Cartesia yet. Cartesia remains the quality/latency control until local inference proves itself on SameVoice-specific tests.

## Why this matters to SameVoice

Our production problem is not generic text-to-speech. SameVoice needs all of the following simultaneously:

1. **RU and HE quality.** Hebrew is the limiting language for many local TTS options.
2. **Voice identity preservation.** The same speaker should remain recognizably the same person across languages.
3. **Short-chunk stability.** The speculative runtime may issue many small TTS requests rather than one paragraph-sized request.
4. **Low TTFA.** Time-to-first-audio matters more than total batch generation time.
5. **Warm repeated inference.** A model that looks good on one generation but degrades over repeated calls is unsuitable.
6. **Realtime-safe output.** We need PCM/audio frames as generation progresses, not only a completed WAV after inference ends.

Chatterbox Multilingual is interesting because it directly addresses points 1 and 2. The R&D work must prove points 3–6.

## Upstream facts verified

### Voicebox

Repository: <https://github.com/jamiepine/voicebox>

Voicebox describes itself as a local-first AI voice studio. Its current README exposes seven TTS engines, including:

- Qwen3-TTS;
- Qwen CustomVoice;
- LuxTTS;
- Chatterbox Multilingual;
- Chatterbox Turbo;
- HumeAI TADA;
- Kokoro.

It also implements voice cloning/profile management, multi-sample profiles, model management, an asynchronous generation queue, REST/MCP integration and local deployment patterns.

Voicebox source license: **MIT**. This does not automatically make every external model or weight used by Voicebox MIT; model licenses must still be checked individually before production adoption.

### Chatterbox Multilingual

Upstream model: <https://huggingface.co/ResembleAI/chatterbox>

The upstream model card currently identifies Chatterbox Multilingual V3 as approximately **500M parameters**, with multilingual support that includes both **Hebrew** and **Russian**, and publishes the model under **MIT**.

Voice cloning is performed from reference audio. This is the local TTS candidate we should benchmark against the existing Cartesia path.

## Important limitation: Voicebox `/generate/stream` is not the streaming primitive SameVoice needs

Voicebox exposes a route named `/generate/stream`, but its current implementation first performs full generation:

```text
audio, sample_rate = await generate_chunked(...)
```

then converts the completed result into WAV bytes:

```text
wav_bytes = audio_to_wav_bytes(audio, sample_rate)
```

and only after that sends the already-generated WAV to the client in chunks.

For SameVoice this is **transport streaming after batch generation**, not true inference streaming.

The SameVoice requirement is different:

```text
text/speculative chunk
        ↓
TTS inference begins
        ↓
first generated PCM frames
        ↓
commit policy
        ↓
LiveKit output
        ↓
remaining PCM frames continue
```

Therefore we should reuse selected backend/model-management ideas from Voicebox, but build or adapt a true incremental audio path for SameVoice.

## What to reuse from Voicebox

### High-value patterns

**1. Common TTS backend abstraction**

SameVoice should preserve a uniform provider boundary so the same test phrase/profile can be routed to Cartesia, Chatterbox and later Qwen/local engines without changing call logic.

Proposed SameVoice contract:

```text
TtsBackend
  load()
  warmup()
  build_voice_profile(reference_samples)
  synthesize(text, language, profile, options)
  stream(text, language, profile, options) -> PCM frames
  unload()
  health()
```

Only `stream()` is mandatory for promotion into the realtime path.

**2. Voice profile / reference sample management**

One logical SameVoice voice identity should be reusable across engines.

Example:

```text
VoiceProfile: alexander
  reference samples
  ├─ clean-neutral-01.wav
  ├─ clean-neutral-02.wav
  └─ expressive-01.wav

  derived engine assets
  ├─ Cartesia voice id
  ├─ Chatterbox conditioning/cache
  └─ future local engine cache
```

The provider-specific representation must not become the canonical identity object.

**3. Warm model management**

Models should remain resident on GPU during an R&D session/call window. Model downloads and caches belong under persistent `/workspace` storage on RunPod.

**4. GPU serialization / queue discipline**

Voicebox serializes expensive generation work to avoid uncontrolled GPU contention. SameVoice should keep the same principle, but with realtime priority classes:

```text
P0  audible committed realtime chunk
P1  speculative TTS likely to commit
P2  shadow/A-B benchmark generation
P3  offline evaluation
```

A long offline request must never block a live call.

**5. Multi-engine A/B harness**

The same text, language and voice profile should be reproducibly tested across engines.

## What not to import into SameVoice now

Do not transplant the full Voicebox product.

The following are out of scope for the realtime core:

- desktop/Tauri UI;
- Stories editor;
- global dictation UX;
- MCP voice assistant UI;
- post-processing studio effects;
- long-form auto-chunking designed for articles/chapters;
- history/database UX that is not required for call evaluation;
- Voicebox's completed-WAV `/generate/stream` behavior.

These features may be useful elsewhere, but they should not increase latency or complexity in the SameVoice call path.

## GPU placement

For the current 2×4090 R&D topology:

```text
GPU0 — THINK
  Acoustic Scout / STT experiments
  next-word predictor
  acoustic candidate scorer
  local MT experiments

GPU1 — SPEAK
  Chatterbox Multilingual
  future local TTS candidates
  Cartesia remains external API control
```

A 500M-class TTS model is small enough that the key constraint is likely not raw model size but **TTFA, repeated-call behavior, scheduling and actual streaming implementation**.

## Required A/B: Cartesia vs Chatterbox

Chatterbox must not become the default merely because it is local or open source.

Every benchmark must use the same speakers, text sets and network conditions where applicable.

### Quality metrics

Measure separately for RU and HE:

- speaker similarity / identity preservation;
- Hebrew pronunciation correctness;
- Russian pronunciation correctness;
- accent drift;
- prosody and naturalness;
- cross-language identity consistency;
- numbers, dates, names and named entities;
- code-switching and borrowed words;
- very short phrases (1–5 words);
- normal conversational clauses;
- questions, interruptions and corrections.

Human listening evaluation remains necessary for final voice-quality decisions.

### Latency metrics

For every engine collect:

- cold model load time;
- warm TTFA;
- p50 / p90 / p95 TTFA;
- total generation latency;
- realtime factor (RTF);
- first committed PCM time;
- queue wait;
- model inference time;
- output duration;
- end-to-end call contribution.

For Cartesia, separate network/API time from service synthesis time where observable.

For local TTS, separate queue time, conditioning/profile preparation and inference.

## Critical stress test: repeated short generations

This test is mandatory before Chatterbox can influence the production path.

Voicebox currently has an open issue reporting premature EOS/cut-off behavior with Chatterbox Multilingual and repeated generation. The report also discusses a possible forward-hook leak and overly aggressive EOS/token-repetition behavior. This is an upstream issue report, not proof that every current Chatterbox build is broken, but it directly overlaps with the SameVoice workload.

Reference: <https://github.com/jamiepine/voicebox/issues/587>

Our stress suite must therefore include at least:

```text
1-word chunks      × 100+
2–3 word chunks    × 100+
4–8 word chunks    × 100+
alternating RU/HE  × 100+
same voice profile × repeated warm calls
2 simultaneous directions
speculative requests cancelled before commit
```

Track:

- premature EOS;
- truncated words;
- repeated tokens/audio;
- silence generation;
- voice drift;
- VRAM growth;
- latency degradation over N calls;
- leaked hooks/objects if observable;
- process/GPU recovery after cancellation.

Any progressive degradation over repeated calls is a **HOLD/REJECT** condition for realtime promotion.

## True streaming implementation work

The local TTS experiment should be split into two stages.

### Stage A — batch baseline

Use the upstream Chatterbox API/model as-is to establish:

- HE/RU pronunciation quality;
- speaker similarity;
- warm batch RTF;
- stability over repeated requests.

If quality fails here, do not invest in streaming optimization.

### Stage B — realtime output

If Stage A passes, instrument or modify the inference path so generated acoustic frames can be emitted before the complete utterance exists.

Target interface:

```python
async for frame in tts.stream(
    text=chunk,
    lang="he",
    profile=voice_profile,
):
    commit_controller.offer(frame)
```

The commit controller, not the TTS model, decides whether speculative frames may become audible.

Cancellation must be first-class: wrong speculation should stop inference and release queued work quickly.

## SameVoice promotion gates

Use three decisions: **PROMOTE / HOLD / REJECT**.

### PROMOTE to soft realtime integration

Only when all of the following are demonstrated on both RU and HE test sets:

- voice identity is acceptable against the Cartesia control;
- Hebrew pronunciation is consistently usable;
- no systematic short-chunk truncation;
- repeated-call stress does not progressively degrade output;
- warm TTFA is low enough to create measurable overlap with speculative MT/commit logic;
- GPU1 has sufficient headroom for two call directions and cancellations;
- a true incremental PCM path exists or is technically demonstrated.

### HOLD

Use HOLD when quality is promising but one of these is still unresolved:

- TTFA too high;
- repeated-call instability;
- Hebrew edge-case quality;
- cancellation too slow;
- true inference streaming not yet available;
- GPU scheduling causes unacceptable p95 spikes.

### REJECT for realtime path

Reject Chatterbox as the primary realtime engine if:

- Hebrew quality is materially worse than Cartesia;
- identity preservation is inconsistent;
- short speculative chunks are inherently unstable;
- p95 latency removes the benefit of local inference;
- repeated requests cause unrecoverable degradation.

REJECT for realtime does not mean the model is useless; it may remain useful for offline generation, fallback experiments or non-call product surfaces.

## Recommended implementation sequence

1. Keep Cartesia as the current real TTS control.
2. Add a local `chatterbox_multilingual` provider/service on GPU1.
3. Reuse the existing SameVoice provider abstraction rather than coupling call logic to Voicebox.
4. Reuse/adapt Voicebox patterns for voice profiles, reference samples, caching and model lifecycle.
5. Run batch RU/HE quality baseline.
6. Run repeated-short-generation stress suite.
7. Record TTFA/RTF/VRAM p50/p90/p95.
8. If the model passes, implement true inference streaming and cancellation.
9. A/B true streaming against Cartesia on identical call fragments.
10. Only then consider making local Chatterbox primary and Cartesia fallback/quality tier.

## Relationship to the rolling speculation work

This TTS work is complementary to the current predictor/acoustic-pruning experiment.

The target eventual path remains:

```text
source audio
  → STT / Acoustic Scout
  → rolling next-word predictor
  → acoustic Top-K re-ranking
  → speculative MT
  → speculative TTS
  → safe commit policy
  → LiveKit
```

Chatterbox is relevant at **speculative TTS**, not at STT or acoustic candidate pruning.

A local engine becomes especially valuable when speculative branches can be started and cancelled cheaply without paying an external API for every losing branch. That benefit is real only if GPU contention remains controlled.

## Licensing rule

- Voicebox repository: MIT.
- Upstream ResembleAI Chatterbox model card: MIT at the time of this note.
- Every engine/model/weight imported later must have its own license recorded in the SameVoice model manifest.
- Do not infer a model's license from Voicebox's repository license.
- Preserve required notices for copied/adapted MIT code.

## Sources

- Voicebox repository: <https://github.com/jamiepine/voicebox>
- Voicebox README / engine overview: <https://github.com/jamiepine/voicebox/blob/main/README.md>
- Voicebox license: <https://github.com/jamiepine/voicebox/blob/main/LICENSE>
- Voicebox voice cloning docs: <https://github.com/jamiepine/voicebox/blob/main/docs/content/docs/overview/voice-cloning.mdx>
- Voicebox generation route: <https://github.com/jamiepine/voicebox/blob/main/backend/routes/generations.py>
- Chatterbox model: <https://huggingface.co/ResembleAI/chatterbox>
- Voicebox Chatterbox early-EOS issue: <https://github.com/jamiepine/voicebox/issues/587>

## Bottom line

**Adopt the idea, not the whole application.**

Voicebox gives SameVoice a strong reference for local multi-engine TTS infrastructure. Chatterbox Multilingual gives us a concrete local HE+RU cloned-voice candidate. The next decision must come from measured Hebrew/Russian voice quality, repeated-short-request stability and true TTFA — not from feature count or GitHub popularity.
