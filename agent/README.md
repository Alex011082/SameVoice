# SpeakEasy agent

The translation relay. A standalone asyncio process: a small aiohttp job server
plus, per accepted call, one manually-connected `rtc.Room()` that publishes one
audio track per listener.

It is **not** a LiveKit `AgentServer` with automatic dispatch, on purpose. With
automatic dispatch a worker joins *every* room, which would break the core
product principle at the architecture level. Here the agent only ever connects
to a room the backend explicitly asked it to, which makes the DIRECT guarantee
structural and machine-checkable:

```bash
curl -s http://127.0.0.1:8788/healthz   # during a DIRECT call: activeCalls == 0
```

## Setup

```bash
cd agent
uv venv --python 3.13
uv sync                 # mock providers only - no API keys, no GPU, no Docker
uv sync --extra api     # optional: adds livekit-plugins-deepgram + -cartesia
```

## Run

```bash
uv run python -m speakeasy_agent.main        # job server on 127.0.0.1:8788
uv run pytest -q                             # offline smoke tests
uv run python scripts/mock_pipeline_demo.py  # full pipeline, no LiveKit at all
uv run python scripts/review_call.py --list  # what call logs exist
uv run python scripts/review_call.py <callId>  # read a session back
```

The demo is the fastest way to see the state machine: it prints the timeline of
`speech_start` / partial / final, the chunker's commits, the translations, the
synthesized durations, a barge-in, and per-stage latency — all offline.

## Job API

Every request except `GET /healthz` carries `x-speakeasy-agent-key:
$AGENT_SHARED_SECRET`.

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/healthz` | `{ok, service, version, providers, activeCalls, callIds}` |
| `GET` | `/stats` | per-call direction counters (units, barge-ins, errors) |
| `POST` | `/jobs` | `202 {accepted:true}` · `400 direct_mode_no_agent` · `400 bad_request` · `401 unauthorized` · `409 already_running` |
| `POST` | `/jobs/{callId}/stop` | `200 {stopped:true}` · `404 {stopped:false}` |
| `POST` | `/jobs/{callId}/verdict` | `202 {accepted:true, utteranceId, resolved}` · `400 bad_request` · `401 unauthorized` · `404 unknown_call` · `409 eval_log_disabled` |
| `POST` | `/verdicts` | same handler, `callId` in the body instead of the path |

`POST /jobs` requires exactly 2 participants, each with `userId`, `lang`,
`gender` and `tone`. Gender is mandatory, not decorative: without speaker AND
listener gender roughly half of all Hebrew sentences come out ungrammatical
(`אתה יודע` vs `את יודעת`) and Russian past tense is wrong too.

A job whose `mode` is `DIRECT` is refused with `direct_mode_no_agent`. The
backend already declines to dispatch in that case; this is the second line of
defence.

## Pipeline

```
mic ─▶ rtc.AudioStream ─▶ SttSession ─▶ Chunker ─▶ MtProvider ─▶ TtsProvider
                                                                    │
                          rtc.AudioSource ◀── 10 ms frames ◀── resample to 48k
```

One `Direction` per ordered pair, so a 1:1 call runs two of them simultaneously.
Stages overlap: STT keeps producing partials while an earlier committed unit is
still being translated and spoken. A single worker task per direction preserves
unit order, and that same task is what barge-in cancels.

**Chunker.** LocalAgreement-2 over STT partials gives a stable prefix; a unit is
then committed once on a strong clause boundary, on a weak boundary with at
least `CHUNK_WEAK_BOUNDARY_MIN_WORDS` stable words, on `CHUNK_MIN_WORDS` stable
words not ending on a function word, on `CHUNK_MAX_SILENCE_MS` of silence, or on
a `CHUNK_TIMEOUT_MS` hard timeout. MT never re-translates a growing prefix:
spoken words cannot be un-spoken, so stability belongs here, not in MT.

**Barge-in.** No separate VAD dependency — both participants already have a live
STT session. `speech_start` from the *listener's* session cancels the MT/TTS task
of the direction speaking *to* them and calls `AudioSource.clear_queue()`.

**Latency.** One structured JSON line per committed unit, at `logger.info`:

```
speakeasy.latency {"kind":"latency","segment_id":"seg_u_alex_000000", ...
  "speech_start_to_first_partial_ms":230.5,"first_partial_to_commit_ms":973.1,
  "commit_to_mt_done_ms":5.6,"mt_done_to_first_audio_ms":41.2,
  "speech_start_to_first_audio_ms":1250.5,"tts_audio_ms":1380.0}
```

Grep for `speakeasy.latency` to get the whole call's KPI series.

## Eval log and the judge flag

Every translated utterance is also appended to `logs/calls/<callId>.jsonl`
(`EVAL_LOG_DIR`, default `<repo>/logs/calls`; `EVAL_LOG_ENABLED=false` turns it
off). This exists because one of the two testers is a native Russian speaker who
speaks Hebrew: she hears her own Hebrew AND the Russian the relay produced, so
she can say immediately whether a translation was actually right. The log is
what turns that from an opinion into labelled data.

Three record kinds share the file, keyed on `kind`:

* `call` — one header per relay: providers, mode, room, both participants.
* `utterance` — one per committed unit: `utteranceId`, direction, both genders,
  the tone in force, source, translation, the provider triple, and every latency
  the pipeline already measured (copied, never re-measured).
* `verdict` — one per judge click: `utteranceId`, `wrong`/`ok`, optional
  `expected` and `note`. Appended, never merged — a second verdict on the same
  utterance is a visible change of mind, not a silent overwrite.

The `utteranceId` in the log is the **same** id the client receives on the final
`speakeasy.subtitle` message, so a click in the browser lands on the right line
with no correlation guesswork. Partials carry an empty `utteranceId`: there is
nothing to judge until a translation exists.

`POST /jobs/<callId>/verdict` accepts `{callId?, userId, verdict, utteranceId?,
expected?, note?, receivedAt?}`. A null or absent `utteranceId` means "whatever
I just heard" and is resolved against the log: the newest utterance whose
**listener** is that user and which actually produced a translation. A verdict
that cannot be matched is still accepted and written with `resolved:false` —
losing a judge's label to a race would be far worse than an orphan record, and
the review tool reports orphans explicitly.

Writing can never block or crash the audio path: appends go to a bounded queue
drained by a background task on a worker thread, a full queue drops with a
warning, and every filesystem error is logged and swallowed.

**Reading a session back.** `scripts/review_call.py` is stdlib-only (it does not
import this package, so it runs anywhere) and prints every utterance with source
and translation side by side, flagged ones highlighted with the expected text,
then p50/p90 per stage and end to end, counts, flag rate, and the provider
triple. `--flagged` shows only the flagged ones, `--json` emits the summary for
a script, `--isolate` wraps RTL text in Unicode bidi isolates for terminals that
implement them. It never reorders or reverses text and always labels each line
with its language, because terminal bidi cannot be fixed from here.

All of this works in mock mode with zero keys.

## Providers

Selected by env var, built by `providers/build_stt|build_mt|build_tts`. Imports
are lazy per branch, so a mock-only install stays lean and a missing optional
plugin only fails when that provider is actually selected.

| Stage | `mock` (default) | `api` | `runpod` |
| --- | --- | --- | --- |
| STT | fixture phrases on an energy gate | Deepgram Nova-3 (`he`/`ru`) | Stage-1 stub |
| MT | fixture dictionary | Gemini Flash-Lite over raw REST | Stage-1 stub |
| TTS | modulated tone at 48 kHz | Cartesia Sonic (pinned snapshot) | Stage-1 stub |

Switching to real providers is `.env` only, then restart the agent:

```
STT_PROVIDER=deepgram  DEEPGRAM_API_KEY=...
MT_PROVIDER=gemini     GEMINI_API_KEY=...
TTS_PROVIDER=cartesia  CARTESIA_API_KEY=...  CARTESIA_VOICE_RU=...  CARTESIA_VOICE_HE=...
```

**The mocks are for mechanics only.** They exercise the VAD gate, chunk cadence,
the partial-vs-final contract, backpressure and TTS cancellation. They say
nothing about translation or voice quality and must never be used to judge
whether the product works.

## Subtitles

Own topics, not `lk.transcription`, because one logical caption carries original
**and** translation **and** both languages **and** finality, and `sender_identity`
would need publish-on-behalf permission we do not grant.

* `speakeasy.subtitle` — one `SubtitleMessage` JSON per message, addressed with
  `destination_identities=[listenerId]`. Nothing is ever sent for a `segmentId`
  after that segment goes `isFinal:true`.
* `speakeasy.state` — `agent_ready` / `agent_error` / `agent_left`.

`RoomEvent.TranscriptionReceived` and `publish_transcription()` are deprecated
and are not used.

## Pitfalls encoded in this code

* **`AudioSource` queue size.** The default is 1000 ms, which lets a full second
  of already-queued TTS keep playing after a cancellation — barge-in then feels
  broken. Every source here is built with `queue_size_ms=200`.
* **`AudioResampler.push()` returns a LIST of frames**, not one. Treating it as
  a single frame produces chipmunk or slowed audio with no error anywhere.
* **`set_track_subscription_permissions` is SYNCHRONOUS** in `livekit` 1.1.14.
  Awaiting it raises `TypeError`.
* **Re-call it after any later publish.** Once `allow_all_participants=False`,
  a newly published track is subscribable by nobody until the call is repeated —
  producing total silence with no error in any log. This relay therefore
  publishes both tracks first, calls it once, and never republishes mid-call.
* **Two mic-source tracks from one participant is unverified.** Both tracks are
  published with a bare `rtc.TrackPublishOptions()` (source deliberately unset)
  and disambiguated purely by `track_name`, matching LiveKit's own multi-user
  translator example.
* **Deepgram's plugin parameter is `endpointing_ms`,** not `endpointing`.
* **The plugins need an explicit `http_session=`.** They fall back to
  `utils.http_context.http_session()`, whose contextvar is only ever set by the
  `AgentServer` job runner — which we deliberately do not use. Without a session
  passed in, Deepgram and Cartesia raise "Attempted to use an http session
  outside of a job context" on the first real call. The fix is
  `speakeasy_agent/httpclient.py`, NOT migrating to `AgentServer`.
* **`impl.stream()` and `impl.synthesize()` are not two spellings of one thing.**
  In the Cartesia plugin the first is the pooled WebSocket and the second is a
  one-shot POST to `/tts/bytes`. Batch TTS is a named budget-breaker in the
  latency plan and reads as correct at a glance.
* **A blank `CARTESIA_VOICE_*` is not "the default voice for that language".**
  `voice` is required by Cartesia's API, so the plugin substitutes its own
  hardcoded en-US female voice for both languages and both people. The adapter
  refuses to start rather than let that happen silently.
* **Stale Literals in both plugins.** `DeepgramLanguages` has no `he`;
  Cartesia's `TTSLanguages` lists seven languages with neither `he` nor `ru`.
  Both are type hints on `str` parameters, never enforced, and both vendors
  document the languages. Do not "fix" our code to match them.
* **A failed translation must never look like an empty one.** Every path in
  `mt_gemini.py` that cannot produce text raises `ProviderError` — a blocked
  prompt, a content-less candidate, `finishReason: MAX_TOKENS`, a thought-only
  response. Otherwise a provider outage is recorded against the translation
  quality of a judged session.
* **Never use `AgentSession` for this.** It binds to exactly one participant and
  owns exactly one audio output; a symmetric two-human relay needs two
  independent, simultaneously-active directions.

## Environment

`AGENT_PORT`, `AGENT_HOST`, `AGENT_SHARED_SECRET`, `STT_PROVIDER`,
`MT_PROVIDER`, `TTS_PROVIDER`, `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`,
`GEMINI_API_KEY`, `GEMINI_MODEL`, `CARTESIA_API_KEY`, `CARTESIA_MODEL`,
`CARTESIA_VOICE_RU`, `CARTESIA_VOICE_HE`, `RUNPOD_STT_URL`, `RUNPOD_MT_URL`,
`RUNPOD_TTS_URL`, `CHUNK_MIN_WORDS`, `CHUNK_MAX_SILENCE_MS`,
`CHUNK_TIMEOUT_MS`, `CHUNK_WEAK_BOUNDARY_MIN_WORDS`, `MT_HISTORY_TURNS`,
`EVAL_LOG_ENABLED`, `EVAL_LOG_DIR`, `DEEPGRAM_ENDPOINTING_MS`,
`CARTESIA_API_VERSION`, `CARTESIA_SAMPLE_RATE`, `LOG_LEVEL`. All have working
defaults; the repo-root `.env` is loaded automatically.

`DEEPGRAM_ENDPOINTING_MS` defaults to 0, meaning "follow `CHUNK_MAX_SILENCE_MS`"
— the chunker already owns the commit policy, and finalizing far earlier just
produces two-word finals it has to re-aggregate, at one extra MT call each.
`CARTESIA_API_VERSION` defaults to empty, meaning "use whatever the installed
plugin pins"; it exists because the plugin hardcodes `2025-04-16` while current
Cartesia docs show `2026-08-14`, and that could not be confirmed against primary
docs.
