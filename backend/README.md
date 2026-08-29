# SpeakEasy backend (Stage 0 control plane)

Node 26 + TypeScript (ESM, strict) + Fastify 5 + `livekit-server-sdk` 2.18.0.

The backend is the **only** component that decides a call's mode, and the only one that mints
LiveKit tokens. It holds no media. State is in memory and seeded with two accounts; a restart
loses every call and every contact override. That is deliberate for Stage 0 — Postgres is Stage 1.

## Run

```bash
npm --prefix backend install
npm --prefix backend run dev        # tsx watch, listens on BACKEND_PORT (default 8787)
npm --prefix backend test           # offline smoke test, no keys, no network
npm --prefix backend run build      # tsc -> dist/
npm --prefix backend start          # node dist/index.js
```

Env comes from the repo-root `.env` (resolved relative to this module, so it works from both
`src/` and `dist/`). `cp .env.example .env` at the repo root is enough — the committed defaults
are mock providers and need no API keys.

## Env vars consumed

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `LIVEKIT_URL` | yes | — | Also echoed to the client via `/api/config` and in every join response. |
| `LIVEKIT_API_KEY` | yes | — | Must match the `keys:` map in `livekit.yaml`. |
| `LIVEKIT_API_SECRET` | yes | — | Same. A secret under 32 chars emits a startup warning. |
| `AGENT_URL` | yes | — | Dispatch target. Contacted only when mode != DIRECT. |
| `AGENT_SHARED_SECRET` | yes | — | Sent as `x-speakeasy-agent-key`. |
| `STT_PROVIDER` / `MT_PROVIDER` / `TTS_PROVIDER` | yes | — | Display only; the agent owns the registry. |
| `BACKEND_PORT` | no | `8787` | |
| `BACKEND_HOST` | no | `0.0.0.0` | Bind address; `0.0.0.0` so LAN devices can reach it. |
| `WEB_PORT` | no | `5173` | Logged as the expected web origin. |
| `TOKEN_TTL_SECONDS` | no | `3600` | |
| `WEB_ORIGINS` | no | *(empty)* | Comma-separated extra browser origins allowed through CORS. A leading `*.` wildcard is supported: `https://*.trycloudflare.com`. Validated at startup. |
| `ALLOW_LOCAL_ORIGINS` | no | `true` | Keep localhost / `127.0.0.1` / LAN IP / `*.local` allowed. Setting it `false` with an empty `WEB_ORIGINS` is a startup error. |
| `RING_TIMEOUT_SECONDS` | no | `45` | No-answer deadline, and then the accepted-but-nobody-joined deadline. |
| `PRESENCE_TTL_SECONDS` | no | `15` | A user counts as online this long after their last heartbeat. |
| `PRESENCE_POLL_MS` | no | `2000` | Advertised to the client via `/api/config`; the backend does not enforce it. |
| `LOG_LEVEL` | no | `info` | |

Startup validation lists **exactly** which variables are missing and exits 1. No secret is ever
written to a log line or to a response body.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Liveness. |
| GET | `/api/config` | LiveKit URL, provider names, agent identity, stream topics. |
| GET | `/api/users` | All profiles. |
| GET / PATCH | `/api/users/:userId` | Read / update `displayName`, `lang`, `gender`, `tone`. |
| GET | `/api/users/:userId/contacts` | Contact cards with **effective** lang/gender/tone. |
| PATCH | `/api/users/:userId/contacts/:contactUserId` | Per-contact overrides + `forceTranslate`. |
| POST | `/api/presence` | Heartbeat **and** ring poll in one request. |
| GET | `/api/ring/:userId` | Same payload, no heartbeat side effect. |
| POST | `/api/calls` | **The mode decision.** Dispatches the agent iff mode != DIRECT. `ring:true` also starts a ring. |
| GET | `/api/calls/:callId` | Call state, participants, agent info, ring. |
| POST | `/api/calls/:callId/join` | Mints the participant token; first join flips state to `active`. |
| POST | `/api/calls/:callId/mode` | Recompute mode; 409 `mode_locked` once state != `created`. |
| POST | `/api/calls/:callId/end` | Ends the call and stops the agent job. |
| POST | `/api/calls/:callId/ring/accept` | Callee answers. |
| POST | `/api/calls/:callId/ring/decline` | Callee refuses; ends the call, stops the agent. |
| POST | `/api/calls/:callId/ring/cancel` | Caller gives up; ends the call, stops the agent. |
| POST | `/api/calls/:callId/verdict` | Bilingual judge marks a translation wrong; forwarded to the agent's eval log. |

Every non-2xx uses the envelope `{ "error": { "code": ..., "message": ... } }` with codes
`bad_request | not_found | forbidden | conflict | self_call | mode_locked | ring_conflict | busy |
no_agent | agent_unreachable | internal`.
Request bodies and path params are validated with zod; unknown body keys are rejected (`.strict()`).

## Ringing

`POST /api/calls` is unchanged unless you pass `ring:true`. Without it the call behaves exactly as
before (invite-link flow, `call.ring === null`), which is why adding ringing broke no existing test.

```
ringing ──accept / callee joins──►  accepted ──(first join)──► live call
   │                                   │
   │                                   └──cancel · nobody joins before expiry──► cancelled | timeout
   ├──decline──────► declined
   ├──cancel───────► cancelled
   └──expiry───────► timeout
```

Everything except `accepted` ends the call **and stops the agent** through one function
(`endRing` in `src/ringing.ts`), so there is no exit that can leave a relay sitting in a LiveKit
room burning participant-minutes and vendor STT minutes on a call nobody answered.

Deliberate choices, all covered by tests:

- **Expiry is enforced twice.** Lazily at the top of every ring-facing handler — so a poll can never
  observe a ring that should already be dead, and a stale Accept can never win a race — and by an
  unref'd 1 s background interval, so an abandoned ring still releases its agent when *both*
  browsers have gone away and nobody is polling.
- **A callee who `/join`s a still-ringing call has answered it.** That removes the accept-vs-join
  ordering race instead of refereeing it, and makes the invite link keep working on a ringing call.
- **Accept and decline are idempotent.** A double accept returns `200` with `alreadyAccepted:true`,
  not an error telling the callee the call she is in no longer exists. A repeated decline does not
  stop the agent twice.
- **The accept deadline is pushed forward, not cleared.** An accepted call that nobody joins expires
  like an unanswered one.
- **Hanging up while ringing is the same transition.** `POST /end` by the caller is a cancel; by the
  callee, a decline.
- **"Busy" is narrow on purpose:** only a *live ring* blocks a new one (`409 busy`). An `active`
  call does not, because a tester who closes a tab without hanging up would otherwise be locked out
  permanently — and that lockout would look exactly like a backend bug.
- Presence is a TTL, not a connection: `POST /api/presence` refreshes `lastSeenAt`, and `online` is
  simply `now - lastSeenAt <= PRESENCE_TTL_SECONDS`. `{"online": false}` is an explicit goodbye for
  `navigator.sendBeacon` on unload.

## The judge verdict

`POST /api/calls/:callId/verdict` validates that the caller is a participant of that call and
forwards to the agent, which owns the JSONL eval log. The agent's answer is **passed through, not
swallowed**: the whole value of the feature is that a `wrong` label is trustworthy, so a verdict that
failed to land must say so while the tester still remembers what she heard.

- `409 no_agent` when the call is `DIRECT` (nothing was translated) or when dispatch failed
  (nothing was logged). Neither case contacts the agent.
- `404 not_found` when the agent has no eval log for that call — the agent must keep a call's log
  writable for a grace period after the job stops, or "right after the call" labelling is lost.
- `502 agent_unreachable` on timeout, connection failure or any other non-2xx from the agent.

## Allowed origins

CORS accepts local origins (`localhost`, `127.0.0.1`, `::1`, dotted LAN IPv4, `*.local`) plus
everything in `WEB_ORIGINS`, so one process serves a laptop tab and a remote tester through a tunnel
without an env swap between them. Entries are `scheme://host[:port]` with an optional single leading
`*.` wildcard; `https://*.trycloudflare.com` matches `abc.trycloudflare.com` but **not** the bare
apex and **not** `speakeasy.example.com.evil.com`. Malformed entries fail at startup with the offending
string quoted, rather than silently never matching.

Note that in the recommended tunnel setup — one Cloudflare quick tunnel in front of Vite, with Vite
proxying `/api` and `/healthz` to `127.0.0.1:8787` — the page and the API share an origin and CORS
never runs at all. `WEB_ORIGINS` exists for the two-tunnel variant and for any future split host.

Every response carries `x-request-id`, and every log line carries the same id under `reqId` plus an
ISO-8601 `time`. Send your own `x-request-id` to correlate across services.

## The DIRECT guarantee

`POST /api/calls` is the only place that talks to the agent, and it does so only when
`mode !== "DIRECT"`. For DIRECT the response is:

```json
"agent": { "required": false, "dispatched": false, "identity": null, "error": null }
```

and **no HTTP request leaves the process**. The smoke test asserts this by counting real requests
against a stand-in agent server, not by trusting the flag. `GET /healthz` on the agent staying at
`activeCalls: 0` during a DIRECT call is the other half of the proof.

A dispatch failure is not fatal: the call is still created (201) with `dispatched:false` and a
human-readable `error`, and the client shows a degraded banner. The agent is a single point of
failure for TRANSLATED with no supervisor — it never silently falls back to raw peer audio.

## livekit-server-sdk v2 traps this code avoids

1. **`toJwt()` is async.** A missing `await` yields the literal string `[object Promise]` as the
   token and an opaque auth failure. This is the most common v1→v2 break.
2. **`identity`, `name`, `ttl` and `attributes` are `AccessToken` *constructor options*, not
   `VideoGrant` fields.** Putting `identity` inside `addGrant()` silently does nothing and the
   participant joins with an empty identity — which would break every `destination_identities`
   subtitle and every track-permission entry downstream.
3. **`canPublish` / `canSubscribe` are set explicitly.** Omitting *both* enables *both*; the grant
   defaults are permissive, so leaving them out grants more, not less.
4. A numeric `ttl` is safe here: the SDK converts `3600` to the string `"3600s"` before handing it
   to jose. Passing a raw number straight to jose's `setExpirationTime` would mean epoch seconds
   (a token expiring in 1970) — do not bypass the SDK.
5. **`keys:` in `livekit.yaml` suppresses devkey injection.** `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`
   must match that map exactly or every token is rejected.

## Effective language, gender and tone

"Language is a property of the contact." The override that describes user **X** lives on the card
the *other* side keeps for X, layered over X's own profile:

```
langA (caller) = contact(callee -> caller).overrides.lang ?? callerProfile.lang
langB (callee) = contact(caller -> callee).overrides.lang ?? calleeProfile.lang
forceEffective = body.force || contact(caller->callee).forceTranslate || contact(callee->caller).forceTranslate
```

Gender and tone resolve the same way, and the resolved values are what land in the token
`attributes`, in `Call.participants[]` and in the agent job. Gender is mandatory in both
directions: without speaker **and** listener gender roughly half of all Hebrew sentences are
ungrammatical (`אתה יודע` vs `את יודעת`), and Russian past tense is wrong too
(`я сказал` / `я сказала`). Tone is equally load-bearing: Hebrew has no T-V distinction, so in the
HE→RU direction `tone` silently becomes the mandatory ты/вы decision.

> **Deviation from the spec text.** Section 2.8 of the architecture spec writes
> `langA = effectiveLang(callerProfile, contact(caller -> callee))`, i.e. it pairs each user's own
> profile with their *own* card for the peer. Taken literally, an override I record on my card for
> Noa would change **my** language, which contradicts section 2.6 (where a contact card's `lang` is
> the *peer's* effective language) and contradicts the product principle. The two contact arguments
> are swapped above so both sections agree. With the seeded data — both cards empty — the two
> readings are identical, so nothing observable changes for the agent, the web client or the tests.

Two further judgement calls worth knowing:

- `Call.agent.identity` is set to `agent-relay` whenever the mode requires an agent, including when
  dispatch *failed*, so the client always knows whom it would subscribe to. The spec only pins
  `identity: null` for DIRECT.
- `POST /api/calls/:callId/mode` recomputes the mode but leaves `participants[]` as captured at
  creation. Mode changes are only legal while state is `created`, so this cannot drift mid-call.

## Testing

`npm --prefix backend test` runs `node --import tsx --test test/smoke.test.ts` fully offline. It
boots the app in-process with `app.inject()` (no port binding), stands up a throwaway HTTP server
as the agent, and asserts:

- `/healthz` and `/api/config` shapes, and that `x-request-id` is echoed;
- the seeded profiles carry gender and tone;
- `(ru, he)` → `TRANSLATED`, exactly one `POST /jobs` carrying the shared secret, a valid agent JWT
  with `sub=agent-relay`, `video.room=call-<id>` and `video.agent=true`, and two role-free
  participants with their languages, genders and tones;
- `(ru, ru)` → `DIRECT` with **zero** outbound agent requests;
- `force:true` and a contact-level `forceTranslate` both yield `FORCED`;
- join returns a decodable 3-segment JWT with `sub` = the userId and `video.room` = `call-<id>`,
  plus `expectedAgentTrackName` = `tx-<userId>` (and `null` in DIRECT);
- `409 self_call`, `403` for a non-participant, `404` for unknown users and calls;
- `409 mode_locked` on a mode change after a join, and `409 conflict` on a join after end;
- the full ringing state machine, including every race that actually happens on two machines:
  double accept, caller hanging up while it is still ringing, a callee accepting after a decline or
  after a timeout, a callee polling once the call is already gone, a double dial (`409 busy`), a
  stale timed-out ring not blocking the retry, and an accepted ring that nobody joins;
- that a declined / cancelled / timed-out ring stops the agent **exactly once**, and that a DIRECT
  ring never contacts the agent at all — not even to stop it;
- the verdict endpoint: the exact body forwarded to the agent (including the shared-secret header),
  `403` for a non-participant, `409 no_agent` for DIRECT and for a failed dispatch, `404` when the
  agent has no log, and `502` when the agent is unreachable;
- origin parsing and matching, wildcard behaviour, the `ALLOW_LOCAL_ORIGINS=false` startup error,
  and that `access-control-allow-origin` is present for a configured tunnel origin and absent
  otherwise.

The two timeout tests sleep ~1.2 s each (a per-call `ringTimeoutSeconds` override makes that
possible without a 45 s wait). Nothing binds a port; the stand-in agent server is closed in `after`.
