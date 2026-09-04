# SameVoice (0110) — Strategic & Technical Handoff

Status: 28 Aug 2026 • Source project: /Users/davidov/SpeakEasy • Product domain: samevoice.0110.digital

Purpose: give the next technical/product agent a complete operating picture of SameVoice after the current architecture, latency experiments, product expansion, prediction-engine concept, data flywheel, infrastructure direction, IP strategy, and four product contours were discussed. This document is a handoff, not a marketing deck. Preserve the decisions below unless the founder explicitly changes them.

> Important: the repo contains older decisions that are superseded by newer decisions in this handoff. In particular, the Random Voice matching logic is now based on an exponentially expanding time window, not a simple fixed-lived pool match.

## 1. Executive summary

SameVoice is a communication network in which language should disappear as a user-facing action. The user chooses a person or a listening context, speaks in their own language, and hears the other side in a chosen language. When languages match, AI must be bypassed completely. When languages differ, a realtime translation/voice layer is inserted transparently.

The central technical thesis has evolved beyond a normal streaming STT → MT → TTS cascade. The new target is a proprietary rolling one-word speculative prediction runtime: predict only the next source word, acoustically verify/prune candidates while the word is still being spoken, precompute translation and speech synthesis where safe, and commit only verified output. This avoids a K^n phrase-tree explosion because speculation advances exactly one source word at a time.

The product now has four contours sharing one language/voice engine: (1) app-to-app Calls, (2) Random Voice/World matching, (3) Listen/Cinema personal translation, and (4) Phone/PSTN calls to ordinary mobile/landline numbers. The Phone contour adds a Context Resolver that can infer organization/branch/topic from Contacts, SameVoice’s own Israeli number directory, prior calls, and user context before the first human utterance.

A major R&D milestone is to break the 2-second barrier reproducibly, especially on RU<->HE. If SameVoice can show approximately 1.7 s on RU<->HE and roughly 1.6–1.7 s on strong benchmark pairs while preserving the speaker’s voice and maintaining low premature-commit error, the founder intends to move to professional patent/prior-art work and fundraising.

## 2. Product thesis and invariants
- Core thesis: “We build a communication network in which a person’s language no longer matters.”
- UX principle: “You don’t choose a language. You choose a person.”
- Routing principle: AI is not in the call path unless it is needed.
- Identity principle: translate language, not identity. The target experience is the other language in the original speaker’s own voice, not a generic translator voice.
- Latency is a product property, not only a backend metric. Natural turn-taking is the goal.
- Hard-pair focus matters: RU<->HE is a primary proving ground, not an incidental language pair.
- Own IP should be concentrated in prediction, acoustic verification, speculation, personalization/context, voice identity, and the learning dataset—not in rebuilding every commodity vendor stage for ideological reasons.

## 3. Current codebase and measured baseline

### 3.1 Repository and architecture

Working source: /Users/davidov/SpeakEasy. Production product/domain: samevoice.0110.digital. The current repository is an Stage-0/early product skeleton with a real app-to-app translation pipeline and test/evaluation infrastructure.

| Layer | Current implementation |
| --- | --- |
| Backend | Node 26 + TypeScript + Fastify 5; tokens, call mode, presence/ringing, judge verdicts. |
| Realtime agent | Python 3.13 + livekit-agents 1.7.0; per-direction relay, chunking, providers, interruption handling, eval log. |
| Web client | Vite + TypeScript; contacts, calling UI, subtitles, latency readout. |
| Media | LiveKit; DIRECT bypass when languages match. |
| Translated pipeline | STT → LocalAgreement-2 / commit policy → MT → TTS → 48 kHz → LiveKit. |
| Provider abstraction | STT, MT, TTS can each be mock/vendor/runpod independently. |
| Evaluation | Per-utterance JSONL logs with source, translation, genders, tone, stage latency, provider triple, utteranceId; “Wrong translation” verdict + optional correction. |

> Repo references: README.md; docs/03-architecture.md; docs/07-product-spec.md; agent/src/speakeasy_agent/; eval/.

### 3.2 Current latency evidence

The current production-like cloud cascade has shown roughly ~4.0 s end-to-end on successful RU<->HE calls. The repository’s measured median decomposition (24 calls, as documented on 27 Aug) was approximately:

| Stage | Median / observed |
| --- | --- |
| Speech → first usable STT | ~1,149 ms (Deepgram path; other measurements around ~917 ms in vendor bakeoff context) |
| Wait/commit/chunking | ~300 ms, policy-dependent |
| MT | ~1,008 ms (Gemini path) |
| TTS | ~240–260 ms (Cartesia) |
| End-to-first translated audio | ~3.9–4.05 s baseline |

Key lesson already measured: merely moving the same pipeline onto a rented GPU does not automatically reduce latency. WhisperLiveKit on an NVIDIA L4 was slower than the cloud path: about 1,590 ms to first text and 3,647 ms to first translation versus ~917 ms and ~2,095 ms respectively for the existing Deepgram+chunker+Gemini path in that bakeoff. Therefore own GPU is justified only for a different architecture (incremental/predictive runtime), not a lift-and-shift of the same stages.

Cartesia currently stays because it is only ~240–260 ms and, in the project’s Hebrew tests, it produced convincing Hebrew with the founder’s voice sample. VoxCPM2 was extremely fast on a 4090 but streaming quality failed; therefore TTS was not the main bottleneck in the measured 4-second cascade.

> Repo references: docs/08-gpu-topology.md; docs/09-incremental-mt-plan.md; eval/vendor-latency-bakeoff.md; eval/hebrew-tts-test.md; eval/voxcpm-samples/.

### 3.3 Palabra result — do not re-open without a specific reason

Palabra.ai was already tested. It is respected as a very fast competitor and its sub-1-second marketing claim is considered impressive if reproducible. However, it did not fit SameVoice’s Hebrew voice requirement in the project’s tests. Palabra had Hebrew across its published capability table, but the tested Hebrew output used non-native/American-accented voice behavior, and both auto-clone and uploaded sample were judged not to preserve the founder’s voice acceptably. The uploaded sample was deleted after testing.

Competitive positioning must be accurate: do not claim Palabra “cannot clone voices.” The stronger claim is that SameVoice aims to preserve voice identity naturally on difficult language pairs such as Russian<->Hebrew, where the tested Palabra output did not meet the founder’s standard.

> Repo reference: eval/vendor-latency-bakeoff.md.

## 4. Product contour #1 — Calls (app <-> app)

This is the core messenger behavior. A contact has a language profile. The user taps call; there should be no language setup in the normal flow.

```text
Caller language == Callee language
→ DIRECT
→ plain WebRTC / LiveKit
→ no STT, no MT, no TTS, no GPU

Caller language != Callee language
→ TRANSLATED
→ realtime translation/voice engine
```
- Each translated direction is its own stream; a two-way translated call means two realtime inference directions.
- Barge-in/interruption must cancel obsolete TTS.
- Long-term target: each side hears the other in the listener’s language but with the original speaker’s voice identity and natural prosody.
- Contact-level language/voice/tone preferences remain useful, but the product should hide translation configuration unless the user explicitly wants control.

## 5. Product contour #2 — Random Voice / World matching

### 5.1 Product behavior

The user submits a request to talk, chooses only the desired interlocutor gender (Man / Woman / Anyone), and presses one button. Language, country, interests, hobbies, and other compatibility fields are not required. Language must not participate in matching because SameVoice is supposed to remove the language barrier itself.

### 5.2 New matching algorithm — supersedes the older simple pool description

Let the request timestamp be t0. Matching prioritizes people who wanted to talk at almost the same time. The search window expands exponentially until a candidate is found:

```text
Cycle 1: candidate request within [t0 - 5s,  t0 + 5s]
Cycle 2: within [t0 - 10s, t0 + 10s]
Cycle 3: within [t0 - 20s, t0 + 20s]
Cycle 4: within [t0 - 40s, t0 + 40s]
...
Double the radius every cycle until a match is found.
```

Implementation detail: if a qualifying earlier request already exists, the system can propose it immediately; otherwise it can keep the first ±5-second window open until t0+5 s, then widen. Use a short internal reservation/lock so one candidate is never offered to multiple people concurrently. This reservation is an infrastructure safeguard, not the old user-facing “5/30 minute match lifetime” concept.

### 5.3 Fresh vs old requests
- For fresh/recent requests, propose the call to both parties; do not connect involuntarily.
- If the candidate request is older than one hour, treat it as asynchronous intent: send a notification and wait for confirmation that the older requester is available.
- If the older requester cannot talk now, they may accept the match but propose another time.
- The other user can accept the proposed time, turning the random match into a scheduled call.
- Only after both sides accept and languages differ should the expensive translation/GPU path start.
- After a good conversation, Add Contact converts discovery into the persistent social graph.

### 5.4 Moderation requirements
- Block/report, cooldowns, anti-repeat matching, reputation, abuse controls, and new-account limits are core matching infrastructure, not optional polish.
- Do not let premium filters turn World into a conventional dating app. The magic is minimal choice plus cross-language serendipity.

## 6. Product contour #3 — Listen / Cinema

Listen is a one-user utility layer: the user can understand a nearby external audio source without the other party installing SameVoice. Cinema is the first concrete mode, but the product surface should be broader than cinema so it can later cover lectures, conferences, tours, live events, TV, and public speech.

### 6.1 Cinema UX
- The cinema/theater does not need to integrate with SameVoice for the basic concept.
- The phone listens to the film, isolates/recognizes speech, translates it, and sends translated speech to the user’s earbud/headphones.
- Free tier: one good synthetic translation voice for all speakers.
- Premium: multiple distinct voices, maintaining consistent speaker-to-voice assignment through diarization.
- Higher-end future: voice-identity preservation where technically and legally permitted; do not assume unrestricted cloning of actors’ voices.
- A practical MVP can use one earbud: the user hears the original soundtrack/environment naturally with the other ear while SameVoice provides a personal interpreter channel.

### 6.2 Technical differences from calls
- One-way inference stream instead of two-way turn-taking.
- Requires dialogue isolation/speech enhancement because movie audio mixes dialogue, music, effects, room reverberation, and audience noise.
- No conversational barge-in from the user, so latency policy can be more aggressive than in live dialogue.
- If synchronized movie identity is known later, one translation stream might serve multiple viewers of the same content, reducing cost.

## 7. Product contour #4 — Phone / PSTN

Phone mode lets a SameVoice user call an ordinary mobile or landline number. The remote party does not need the app. This is a major cold-start and utility feature, especially for immigrants/new arrivals who need to call banks, Bituach Leumi, insurance companies, healthcare providers, municipalities, utilities, landlords, or service companies without knowing Hebrew.

```text
SameVoice user speaks RU
→ SameVoice RU STT/prediction/MT
→ HE speech synthesized in the user’s own voice
→ SIP/PSTN
→ ordinary phone hears Hebrew

Ordinary phone speaks HE
→ SIP/PSTN
→ SameVoice HE STT/prediction/MT
→ RU speech
→ user hears Russian
```

### 7.1 PSTN architecture
- Use a licensed SIP/PSTN provider; SameVoice should not try to become a telecom operator.
- App/media layer remains realtime; PSTN is an additional gateway/termination leg.
- Phone minutes can be monetized per minute or as included bundles because telephony has explicit variable cost.
- IVR must be a first-class state. Translate menu prompts quickly and let the UI expose large DTMF buttons/choices.
- Detect hold music and suspend expensive translation while no speech is present.

### 7.2 Commercial role, cold start, and disclosure

Phone is likely the clearest first commercial use case in Israel: “I do not know Hebrew, but I can call any organization myself.” It has immediate value before SameVoice has a network. Even with one user, Phone, Listen, and Cinema are useful; the remote party does not need to install anything. This directly reduces the classic new-messenger cold-start problem.

The remote experience must still feel human. A generic synthetic voice may be acceptable as a base tier, but voice identity is especially valuable in Phone because it prevents the caller from sounding like an IVR or autonomous robot. Preserve the principle: translate language, not identity.

For banks, government agencies, healthcare, insurance, and other regulated or sensitive contexts, the architecture must support a short neutral disclosure such as “This call uses automated speech translation.” The exact trigger, wording, jurisdiction, and whether disclosure is mandatory are legal/product policy questions; do not hard-code one universal announcement before that review.

## 8. Phone Context Resolver — automatic context before the call

### 8.0 Call Context / Call Brief

Context resolution should be automatic first, but it must also have a lightweight manual override. Before a Phone call—or any call where the user wants to narrow the topic—the user may enter one short line such as “I want to know why the May payment did not arrive.” This is a Call Brief, not a required setup form.

The resolver turns that brief into a hidden structured session context:

```text
organization: Bituach Leumi
domain: government / social security
topic: missing payment
intent: find reason + next action
source: RU
target: HE
expected vocabulary: allowance, eligibility, payment, debt, bank account, documents, application
```

Automatic number/contact resolution remains primary. The brief is an optional refinement when the inferred organization is correct but the topic is unknown, and a fallback when confidence is low. It must never become a mandatory pre-call questionnaire.


The founder explicitly wants context to be inferred automatically from the number, not entered manually every time. The context system is not only a convenience feature: it is a latency and accuracy mechanism because it narrows the next-word distribution, biases ASR/MT vocabulary, and allows predictor caches to warm before the first human utterance.

### 8.1 Resolution order
1. Look up the dialed number in the user’s Contacts (with explicit OS permission). Use contact name/category as a local signal.
2. Look up the number in SameVoice’s maintained directory of Israeli institutions and companies, including branch/department where known.
3. Combine number identity, contact name, prior call history, location/branch context, and confidence.
4. High confidence: enable the organization/domain context silently.
5. Medium confidence: ask one short confirmation, e.g. “This number is not in Contacts. Are you calling Bituach Leumi — Be’er Sheva?”
6. Low confidence: ask what organization/topic the user is calling about; do not block the call unnecessarily.

### 8.2 SameVoice number directory schema

```text
phone_number / number_range
organization
branch
city
department
category/domain
known_languages
opening_hours (optional)
IVR profile / known extensions
common call intents
domain vocabulary/context pack
verified_at
confidence/source
```

The directory should be continuously updated. It becomes useful even when a user has not saved a company in Contacts. The number itself can load semantic context before the call starts.

### 8.3 Context packs and suggested intents

Once the organization is resolved, show likely call goals instead of a blank text field. Example for Bituach Leumi: Payment / Application status / Documents / Debt / Eligibility / Other. Selecting one loads a deeper context pack. The user can still type a custom goal.

Context must feed all relevant stages when possible: next-word predictor, ASR vocabulary hints, translation terminology, TTS/prosody policy, subtitle consistency, IVR understanding, and future retrieval of prior call issues.

### 8.4 Contact- and number-specific memory

For repeated calls, the system can ask “Continue the previous issue?” versus “New issue.” A number-specific history (e.g. insurance claim, blocked card, missing payment) is a strong prior for prediction and translation. Avoid uploading the entire Contacts database unnecessarily; resolve locally where possible and send only the context needed for the call.

## 9. Core R&D: rolling one-word speculative prediction

### 9.1 Exact idea

The founder’s proposal is NOT to predict an entire phrase or recursively synthesize a phrase tree. The horizon is one source word. At any moment the engine predicts a Top-K set (for example 15–20) of plausible NEXT source words given the stable context. Candidate continuations may exist behind those words for contextual scoring, but the actively speculative unit is the next word only.

```text
stable source prefix
      ↓
Global + context + personal predictor
      ↓
Top-K NEXT source words (e.g. 20)
      ↓
incoming audio / phoneme evidence arrives continuously
      ↓
20 → 10 → 4 → 2 → 1 candidates
      ↓
winning word reaches safe confidence BEFORE ordinary final STT
      ↓
translation / target-safe prefix already prepared
TTS may already be warmed/rendered where safe
      ↓
irreversible COMMIT gate
      ↓
shift the window exactly one source word
      ↓
repeat
```

### 9.2 Why there is no combinatorial explosion

The runtime does not expand K candidates into K×K×K complete phrases. It discards/re-ranks candidates continuously and advances only one word. After the next word wins, a new Top-K is generated for the following word. The complexity is bounded around the active candidate set rather than an exponentially growing phrase tree.

### 9.3 Acoustic pruning

Pruning should use sounds/phonetic or acoustic evidence, not letters. As the next word begins, the engine compares early acoustic frames/phoneme likelihoods against the candidate words and removes incompatible words before a conventional STT final is available. This suggests a small “Acoustic Scout” operating alongside the main STT.

```text
microphone
 ├─→ authoritative streaming STT (Deepgram for now)
 └─→ Acoustic Scout → phoneme/acoustic likelihoods
                         ↓
                 prune next-word candidates
```

Deepgram can remain the authoritative recognizer. Acoustic Scout has a narrower job: discriminate among a small candidate lexicon as early as possible. It does not have to solve full ASR better than Deepgram.

### 9.4 Commit policy
- Speculate aggressively in computation; speak conservatively.
- Never emit an unverified guessed word just because it is probable. Audio is irreversible once heard.
- Commit the maximum safe TARGET-language prefix enabled by the source evidence. One source word does not necessarily map to one target word.
- Sometimes one verified source word enables 0 target words, sometimes 1, sometimes several. Language-pair-specific policy is required, especially for RU<->HE, EN<->ZH, German/Japanese, etc.
- Adaptive K: use small K when next-word entropy is low; increase K when ambiguous; choose “wait/no speculation” when uncertainty is too high.

### 9.5 Speculative MT/TTS

The goal is to do work earlier, while the speaker is still speaking—not merely make a model 300 ms faster after the fact. The engine may precompute translation states and pre-warm/render speech for high-probability candidates or shared safe target prefixes. Do not synthesize full candidate phrases. Keep speculative audio private until commit.

## 10. Latency recovery beyond prediction

### 10.1 Silence and filler compression

The founder proposed using natural pauses as latency budget. Long pauses (for example 2–5 seconds) should not necessarily be replayed at full length in translated output. They can be compressed toward ~1 second, while preserving enough pause/bridging behavior to sound natural. Long hesitations/fillers such as “uh / ah / mm” should not force the translation to inherit the full original delay if they add no semantic content.

This must be perceptual, not mechanical: preserve discourse intent and avoid unnatural jump cuts. The goal is to let the translated stream catch up.

### 10.2 Latency-debt controller

Useful engineering abstraction: continuously track how far translated playback trails the source (“translation debt”). When debt grows, SameVoice can selectively use safe mechanisms: slightly faster playback, pause compression, early commits from successful speculation, and skipping non-semantic waiting. When debt is near zero, speak at natural timing. This is a proposed controller architecture consistent with the founder’s pause-compression idea.

## 11. Context + personal memory as a latency engine

The founder sees per-user accumulated data as a major advantage. The predictor should not be a separate huge neural model per user. Use a shared global model on GPU and a lightweight personal/context re-ranking layer.

```text
P(next word) =
  Global language prior
+ Current session / organization context
+ Personal user history
+ Contact/number-specific history
+ Current acoustic evidence
```

### 11.1 Three prediction layers

| Layer | Purpose | Likely compute |
| --- | --- | --- |
| Global Predictor | General RU/HE/EN/ZH next-word distribution and multilingual linguistic knowledge. | GPU |
| Context layer | Current call: organization, domain, topic, branch, film scene, current session. | CPU/GPU re-rank + cached context |
| Personal memory | Names, vocabulary, habitual phrases, frequent contacts, prior topics, per-contact phrases. | CPU/Redis/Postgres/vector cache; not necessarily model fine-tuning |

This is especially powerful in Phone mode. If the engine already knows “Bituach Leumi → missing payment → RU<->HE,” the candidate set for the next word is far narrower than generic Russian. The model can be pre-warmed during dialing/ringing before the operator speaks.

### 11.2 Prediction profiles, not per-user models

Each user should have a compact prediction profile layered over the shared model—not a separately trained heavyweight network. The profile may contain vocabulary statistics, entity and contact graphs, n-grams, embeddings, recurring intents, topic priors, and per-contact/per-number patterns. The default should be to store privacy-safer derived signals rather than raw conversation text whenever they are sufficient.

```text
GPU:
  global next-word distribution

CPU / Redis / Postgres:
  personal re-ranking
  context re-ranking
  contact and number vocabulary

Acoustic Scout:
  phoneme / acoustic likelihood
        ↓
final Top-K
```

This boundary keeps personalization cheap and scalable: global inference is shared, while a small user-specific profile adjusts rankings and can update quickly without retraining production weights.

### 11.3 Context behavior across the four contours

- **Calls:** contact-specific priors can reflect recurring names, topics, work, family, and recent shared context. They are hints, never assumptions that may silently alter meaning.
- **Random Voice / World:** there may be almost no useful prior at match time. Begin mostly global, then build ephemeral session context from the first 20–30 seconds.
- **Listen / Cinema:** context may include film identity, genre, characters, scene history, previous subtitles, and stable speaker identity.
- **Phone / PSTN:** number, organization, branch, department, selected or inferred intent, IVR profile, and prior call issue provide the strongest pre-call context.

The first context-ablation target is to test whether Context Resolver plus personalization adds roughly 200–400 ms of safe Prediction Lead Time beyond the global predictor. This is a research hypothesis, not a product claim, until measured.


### 11.4 Per-user language memory examples
- Frequent people and names.
- Organizations and branches.
- Recurring terms and professional vocabulary.
- Habitual phrases and n-grams.
- Contact-specific topics and prior call intents.
- Preferred translation style/tone where relevant.
- Current call session context and recent dialogue.

## 12. Data flywheel and learning architecture

### 12.1 What to collect for the proprietary predictor dataset

The most valuable dataset is not merely parallel RU<->HE text. Record the prediction process and its outcome so the system can learn when it can safely act early.

```text
source audio (only with appropriate consent)
word/phoneme timing
interim STT hypotheses
stable source prefix
Top-K next-word candidates + probabilities
prune events over acoustic time
actual next word
confidence trajectory
when correct word became knowable
translation state / safe target prefix
TTS ready time
commit time
end-to-end latency
wrong-commit / correction / judge verdict
organization/session/personal context identifiers (privacy-safe where possible)
model + dataset + consent version lineage
```

### 12.2 Key R&D metric: Prediction Lead Time (PLT)

Measure how many milliseconds before the normal STT-final/commit SameVoice can safely identify the correct next word. Evaluate Top-1/3/5/10/20 recall before the word begins and then after +50, +100, +150, +200, +250 ms of acoustic evidence. The real value is not raw next-word accuracy; it is safe predictive lead that reduces first-correct-translated-audio latency.

### 12.3 Global learning vs personal adaptation
- Global model updates should be batch/offline, versioned, benchmarked, shadow-tested, canaried, then promoted. Production weights must not mutate live during a call.
- Personal adaptation can update much faster using n-grams, caches, embeddings, entity memory, vocabulary statistics, and re-ranking without retraining a large network.
- Initial training data can come from founder/tester calls with explicit consent before there is a user base.
- As users arrive, consented data becomes the flywheel. The product should keep dataset lineage so data can be audited/removed if consent changes.
- Prefer derived personal-memory artifacts—entities, vocabulary counts, n-grams, embeddings, topic priors, and confidence statistics—over raw transcripts when they provide the required predictor value.
- Raw source audio is a separate, higher-sensitivity research asset. The older repository decision says call audio is not stored, while the predictor research concept may require consented acoustic examples. Do not silently treat the handoff as resolving this conflict. Before any audio retention is implemented, the founder must explicitly approve a separate research-audio consent tier, retention period, deletion path, access boundary, and whether audio is discarded after feature extraction.

### 12.4 Consent position

Founder intent: free-tier users may be asked to agree to use of conversations/data for model improvement. Product/legal implementation must keep this explicit and granular rather than burying it in generic Terms. The existing repo concept already separates live processing, telemetry, and opt-in improvement data. Do not silently turn all free calls into training data without an explicit approved consent design.

> Repo reference: docs/00-concept.md, “Data and YTNG” section. Legal review is required before launch; this handoff is not legal advice.

## 13. RU<->HE as the primary technical proving ground

Do not evaluate the project only through English-centric simultaneous-translation literature. RU<->HE is intentionally difficult and underrepresented in standard simultaneous-translation benchmarks. Hebrew has rich morphology and grammatical gender; Russian has its own morphology, freer word order, gender in past tense, and frequent colloquial constructions. The current MT provider code already includes explicit Hebrew/Russian gender handling.
- Treat RU→HE and HE→RU as separate benchmark directions.
- Use native/bilingual judges where possible and preserve natural spontaneous speech rather than scripted only.
- Measure quality together with latency. A lower number obtained by premature wrong audio is not success.
- After RU<->HE, validate on easier/high-resource English-related pairs and a structurally different pair such as EN<->ZH to show generalization.

## 14. Success target, patent trigger, and investment trigger

### 14.1 Desired performance target

Founder’s success target discussed in this session: approximately 1.7 s on RU<->HE; around 1.6 s on English<->similar/high-resource languages; and approximately 1.6–1.7 s on English<->Chinese, while preserving voice identity and acceptable translation quality.

Do not report one cherry-picked average. Use reproducible p50/p90/p95 and an explicit definition such as “speech start → first correct committed translated audio heard by the listener.”

### 14.2 Benchmark pack that should exist before fundraising

| Metric | Why it matters |
| --- | --- |
| p50 / p90 / p95 end-to-first-correct-audio | Shows real user latency and tail behavior. |
| Premature wrong-commit rate | Proves speculation is safe, not merely aggressive. |
| Translation quality / bilingual acceptance | Prevents latency from hiding degraded meaning. |
| Voice similarity / native accent quality | Core SameVoice differentiation. |
| Top-K next-word recall | Tests predictor usefulness. |
| Prediction Lead Time | Quantifies how early correct word becomes safely known. |
| Ablation by feature | Shows which proprietary mechanisms actually create the gain. |
| Global-only vs context vs personal re-ranking | Tests the 200–400 ms PLT hypothesis without conflating it with acoustic pruning. |
| Concurrent-stream capacity / p95 under load | Connects technical result to unit economics. |

### 14.3 Required ablation story

```text
baseline cascade                    ≈ current ~4 s
+ incremental prefix processing      → improvement
+ rolling one-word prediction        → improvement
+ acoustic pruning                   → improvement
+ speculative MT/TTS                 → improvement
+ context + personal re-ranking      → improvement
+ pause/debt recovery                → perceived catch-up

Document the exact delta of each step.
```

### 14.4 IP direction

The latency number itself is not the patent. Prior art exists for anticipation, simultaneous translation, beam search, incremental TTS, and streaming ASR. The potentially protectable layer is the specific technical combination and implementation details, subject to professional prior-art review.

Candidate invention framing: rolling one-source-word linguistic prediction + early acoustic/phonetic verification/pruning + speculative translation and/or speech synthesis + irreversible confidence-based target-prefix commit + adaptive context/personal re-ranking + latency-debt recovery.
- Keep the speculative engine/private implementation non-public until patent counsel reviews filing strategy.
- Do a real patent/prior-art search across papers and patent claims before assuming novelty.
- File before detailed public disclosure where possible, especially if international protection matters.
- A reproducible technical effect + ablation evidence is much stronger than an abstract “AI predicts speech” idea.

## 15. Infrastructure direction

### 15.1 Principle

Separate realtime control/media, realtime inference, training, and data. Do not buy one giant server and mix everything. The product’s 1.6–1.7 s target makes predictable latency more important than nominal GPU utilization.

### 15.2 Israel control plane

Near-term recommendation discussed: an Israel-hosted CPU application/control server around 8 vCPU / 16 GB RAM / NVMe class for backend, matching, auth, session state, Redis/Postgres, orchestration, consent, billing, telemetry, and queues. Current production-class sizing should grow from the very small development VM as users appear.

Staged sizing: 4 vCPU / 8 GB is a practical minimum for the next technical stage; 8 vCPU / 16 GB with roughly 160+ GB NVMe is the preferred closed-beta shape once Calls, matching, Listen, data collection, and persistent services run together. GPU is not required on this machine.

Do not introduce Kubernetes for the first hundreds of users. One well-sized VM with systemd or Docker Compose and isolated processes is sufficient until measured operational or scaling pressure proves otherwise. Keep durable data and object storage logically separate from realtime inference so a GPU restart or replacement cannot endanger the control plane or dataset.

Keep media as close to Israeli users as practical. Existing project docs emphasize that media should stay in Israel; LiveKit Israel/Jerusalem has been used in the current infrastructure work. DIRECT calls bypass all inference.

### 15.3 RunPod / GPU use

RunPod is valuable first as R&D and as a separate predictor/training environment. The existing WhisperLiveKit L4 experiment already proved that “self-host everything” is not automatically faster. The new GPU purpose is the proprietary predictor/acoustic/speculative layer.
- R&D latency baseline: RTX 4090 24 GB is preferred to determine the algorithmic ceiling; later compare a cheaper 3090/A5000 if the model is light enough.
- Use a persistent warm Pod for realtime inference once users depend on it; avoid cold/serverless inference in the critical call path.
- Open one persistent WebSocket/gRPC stream per translated direction/call context; keep model/KV/session state warm instead of repeated REST requests.
- Training GPU should be ephemeral/on-demand. Accumulate data, launch a training job, evaluate, save checkpoint, destroy the training instance.
- If own MT/TTS/voice engine grows beyond 24 GB, evaluate 48 GB class GPUs (A6000/A40/L40 family) or split predictor and voice generation across workers.
- For production Israel users, benchmark end-to-end network RTT to the chosen RunPod region. If cross-country latency erodes the speculative gain, move latency-critical inference to an Israel GPU provider when economically/physically available and use RunPod for training/overflow.

### 15.4 Never train live production weights

```text
LIVE model v17
  ↓ collect consented data
TRAIN candidate v18 offline
  ↓ benchmark
  ↓ shadow mode
  ↓ canary traffic
  ↓ promote only if better
PRODUCTION v18
```

A “self-learning product” is acceptable; a production model that mutates its weights during the user’s call is not. Keep versioning and reproducibility.

### 15.5 Compute topology by contour and capacity benchmark

| Contour | Realtime inference shape |
| --- | --- |
| Calls | Two directional streams for a fully translated two-person call. |
| Random Voice | Matching itself is CPU/Redis work; no GPU until both users accept and translation is required, then it becomes Calls. |
| Listen / Cinema | One directional stream; a synchronized source may eventually be shared by multiple listeners. |
| Phone / PSTN | Two directional translation streams plus SIP/PSTN gateway cost; IVR/HOLD classification can suspend or simplify inference. |

Do not infer concurrency from GPU model specifications or tokens/second. Benchmark the actual predictor with 1, 5, 10, 20, and 50 simultaneous translated calls—2, 10, 20, 40, and 100 directional streams—and record predictor p50/p95, queue wait, GPU utilization, VRAM, and end-to-end p95. The capacity boundary is where queueing or predictor p95 damages the 1.6–1.7 s product target.

Cloud prices, inventory, and regional GPU availability are time-sensitive. Historical chat estimates are planning inputs, not current truth. Re-check live availability and benchmark network RTT before provisioning; later measured repository evidence overrides earlier provider assumptions.

## 16. Monetization logic across the four contours

| Contour | Free / base concept | Premium / paid value |
| --- | --- | --- |
| Calls | Translated calling with a limited/generic voice set; DIRECT is cheap. | Warm/priority inference, lower latency, stronger models, per-contact preferences, My Voice. |
| Random Voice | Basic matching; GPU only after both accept and languages differ. | Potential comfort/priority/scheduling extensions without over-filtering the pool. |
| Listen/Cinema | One translation voice. | Multiple stable speaker voices; better diarization/quality; future identity-preserving mode where rights allow. |
| Phone/PSTN | Trial minutes or limited bundle. | Included minutes + overage/per-minute pricing; My Voice; stronger context packs / lower latency. |

My Voice can be a paid identity feature but must respect unit economics. The product should not promise unlimited expensive generation for a tiny flat add-on without minute/usage controls.

## 17. Recommended R&D sequence from here
1. Freeze the current ~4 s baseline and benchmark definition. Do not change the baseline while measuring the predictor.
2. Build an offline rolling next-word benchmark on natural RU<->HE conversations. Measure Top-K recall and Prediction Lead Time before any live integration.
3. Prototype the predictor on a rented 4090. Keep the task narrow: next-word distribution, not full translation generation.
4. Add phoneme/acoustic candidate scoring (“Acoustic Scout”) and measure how quickly Top-K collapses as +50/+100/+150/+200 ms audio arrives.
5. Run the predictor in shadow mode on live calls. It predicts and logs but does not affect what the user hears.
6. Add safe commit logic and speculative MT state. Measure wrong-commit rate.
7. Add speculative/pre-warmed TTS only after commit safety is proven.
8. Add pause/filler compression and latency-debt controller; compare perceived and objective latency.
9. Add Context Resolver and per-user/personal re-ranking. Measure incremental gain over global-only predictor.
10. Only after stable sub-2-second RU<->HE results: package the benchmark/ablation evidence, do professional patent/prior-art work, then prepare fundraising/demo materials.
11. Build product contours in utility order as resources allow. Phone is likely the clearest first commercial Israeli use case and, together with Listen, provides value before a network exists; Random creates a network/discovery loop; Calls remains the core communication primitive.

## 18. Decision register — do not accidentally revert these

| Decision | Status / rationale |
| --- | --- |
| Same-language calls bypass AI | Hard invariant. DIRECT WebRTC/LiveKit only. |
| Preserve the four seeded test identities | Alex, Noa, Omri, and Maya remain as a fast internal call-test contour with preconfigured RU/HE language, gender, tone, contact links, and voice/provider setup. Real phone-number registration is added alongside this contour; it must not replace or delete it. The test contour may stay hidden behind debug/test access in the user-facing product. |
| RU<->HE is a primary benchmark | Hard pair is intentional; do not optimize only for English demos. |
| Prediction horizon = one source word | New core R&D decision; do not build an exponential full-phrase tree. |
| Candidate pruning uses acoustic/phonetic evidence | Core mechanism; sounds, not letters. |
| Speculate computation, not unverified speech | Audio commit is irreversible; require safe commit. |
| Per-user “bank of data” is a re-ranking/memory layer first | Do not create a full separate giant model per user. |
| Context is a latency feature | Organization/topic/contact context should bias prediction before and during calls. |
| Phone Context Resolver starts from number + Contacts + SameVoice directory | Automatic first; ask only when confidence is insufficient. |
| Call Brief is optional refinement/fallback | One short line may narrow the topic; never make it a mandatory pre-call form. |
| Personalization uses a compact prediction profile first | Shared global model plus derived per-user re-ranking; do not train a giant model per user. |
| Raw call audio retention is unresolved | The existing “voice is not stored” invariant conflicts with acoustic-dataset ambitions; explicit founder and consent-policy approval is required before implementation. |
| Matching window expands 5s → 10s → 20s → 40s… | Supersedes older simple pool/hold logic as the main selection algorithm. |
| Requests older than 1 hour require renewed availability confirmation | Can lead to “call now” or proposed alternate time/scheduled call. |
| Cinema is user-side; no theater integration required for MVP | Free one voice, Premium multiple voices. |
| Phone/PSTN remote party needs no app | Remote hears target language; goal is the caller’s own voice. |
| Phone must support policy-driven disclosure | Sensitive or regulated calls may require a neutral automated-translation notice; exact rules require jurisdiction-specific review. |
| Early control plane stays simple and separate from GPU | Israel CPU VM first; no Kubernetes without measured need; inference, training, and durable data remain separate failure domains. |
| GPU capacity is established by directional-stream load tests | Measure p50/p95 and queueing at 1/5/10/20/50 translated calls; do not estimate capacity from card specifications alone. |
| Palabra is not the chosen vendor | Fast competitor; Hebrew/accent/voice-identity test failed project requirements. |
| Do not self-host the old cascade just to be self-hosted | Measured L4 WhisperLiveKit experiment was slower. Own GPU is for new architecture. |
| Realtime inference and training are separate workloads | Training is batch/versioned; no live weight mutation. |
| Patent/investment trigger depends on reproducible quality + latency + ablation | Not on a one-off demo number. |

## 19. Open questions for the next agent
- Which compact multilingual model gives the best next-word Top-K recall/latency for RU and HE on a 24 GB GPU?
- What is the best acoustic representation for early discrimination among a tiny candidate lexicon: phoneme CTC head, acoustic tokens, constrained ASR lattice, or another method?
- What confidence/consensus rule keeps premature committed speech below the required threshold while preserving PLT?
- How should one source-word evidence map to a maximum safe target prefix for RU<->HE and EN<->ZH?
- How much additional PLT comes from organization context and personal memory versus the global predictor? Test the current 200–400 ms hypothesis as an ablation, not an assumption.
- What exact raw/derived data should be stored by consent tier, for how long, and what can be discarded after feature extraction? In particular, does predictor R&D justify any exception to the current “call audio is not stored” rule?
- Which Israel GPU option is economically viable once live predictor traffic must stay near users? RunPod can remain R&D/training/overflow if network RTT is too high.
- How should Phone context directory data be sourced, verified, updated, and protected from stale/incorrect organization identification?
- What telecom/SIP provider and disclosure/recording policies are required for Phone mode in Israel and later markets?
- What rights/voice policy is acceptable for Cinema premium multi-voice and any future actor-like identity preservation?

## 20. Implementation update — web phone confirmation (29 Aug 2026)

The first real-number registration slice has started without touching LiveKit,
the translation relay, PSTN, or the GPU path.

- `POST /api/auth/phone/start` accepts an Israeli mobile number (`05x...`) or
  international E.164 input, normalizes it, and returns a five-minute challenge.
- During the free web prototype the six-digit confirmation code is returned as
  `devCode` and displayed in the web UI. SMS delivery is deliberately not
  connected yet.
- `POST /api/auth/phone/verify` accepts the code once. A wrong code is rejected;
  a successful or exhausted challenge cannot be replayed. The backend stores
  only a SHA-256 digest of the code in its in-memory challenge record. A valid
  confirmation returns a short-lived, single-use registration token.
- `POST /api/auth/register` consumes that token and creates a real user profile
  with phone number, display name, language, gender, and the default friendly
  tone. Verifying the same number later recognizes the existing profile and
  opens it without repeating the profile form.
- The ordinary web entry path is now phone confirmation followed by profile
  creation for a new number. Founder decision:
  the four seeded identities (Alex, Noa, Omri, Maya), their mutual contacts,
  preconfigured voices, languages, gender/tone settings, and fast test-call path
  are permanent internal test infrastructure. They are isolated behind
  `?debug=1` (or a direct `?me=u_alex`-style link), and that picker is filtered
  to exactly those four identities even after real users have registered.
- This is still a prototype identity flow, not durable account authentication:
  challenges, registration tokens, and real user profiles are in memory and do
  not survive a backend restart; no durable login session/cookie is issued.
  PostgreSQL-backed users and proper sessions remain a later slice.

Verification on 29 Aug: backend smoke suite 61/61, web suite 92/92, backend
typecheck/build and web production build passed. A real local browser exercised
new-number confirmation → profile creation → profile entry, repeated-number
confirmation → direct profile entry, and the isolated four-identity debug picker.
Profile navigation uses an explicit URL assignment rather than
`history.replaceState()` followed by `reload()`: the latter intermittently lost
the `me` parameter in the production browser during repeated-number entry. The
profile-creation slice is deployed on the existing Vultr server and has been
exercised through the public domain. The translation agent was not changed.
The production Caddy configuration is now mirrored in `infra/Caddyfile`; it
marks `/` and `/index.html` as `no-cache, no-store, must-revalidate` so browsers
do not keep loading an obsolete hashed JS bundle after a web deployment.
The implementation is present in the local working tree and on production, but
has not yet been committed to git. Preserve the current modified and untracked
files when continuing; do not mistake the clean `HEAD` for the deployed state.

## 21. Source map in the existing repository

| File | Why read it |
| --- | --- |
| README.md | Current Stage-0 behavior, providers, eval logging, DIRECT/TRANSLATED mechanics. |
| docs/00-concept.md | Original product thesis, Random Voice, monetization, PSTN concept, consent/data separation. |
| docs/07-product-spec.md | Consolidated current specification and project history. |
| docs/08-gpu-topology.md | Measured latency decomposition, Israel media placement, GPU topology and vendor location work. |
| docs/09-incremental-mt-plan.md | Incremental translation experiments/plan and cost/latency thinking. |
| eval/vendor-latency-bakeoff.md | Palabra, Gemini Live, VoxCPM2, WhisperLiveKit measured/observed results. |
| eval/self-hosted-stack.md | Self-hosted component research. |
| eval/server-placement.md | Infrastructure placement reasoning. |
| agent/src/speakeasy_agent/providers/ | Actual STT/MT/TTS provider implementations and Hebrew/Russian constraints. |
| agent/src/speakeasy_agent/evallog.py | Per-utterance quality/latency logging foundation. |
| materials/2026-08-23-founding-dialogue.md | Long-form founding/product dialogue; useful historical context, but newer decisions in this handoff override older variants. |

## 22. One-sentence north star

SameVoice should become a realtime language layer that lets people call, discover, listen, or phone anyone without sharing a language—while preserving human voice identity and using prediction, context, and personal memory to make translated speech arrive close enough to realtime that users stop noticing the translation system.

> Handoff rule: before implementing any major architecture change, compare it against the Decision Register in §18 and the measured evidence in the repo. The project has already spent time disproving attractive but slower approaches; do not repeat those experiments without a new hypothesis.
