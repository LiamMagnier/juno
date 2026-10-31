# Voice / realtime cost findings (relay/src/**)

Scope: the voice relay (`relay/src/**`) plus the client behaviour that decides what the relay forwards
(web `src/hooks/use-realtime-voice.ts`, native `native/Packages/JunoNativeKit/Sources/JunoVoiceKit/*`,
`native/iOS/.../JunoMobileVoiceCamera.swift`, `native/macOS/.../DesktopVoice.swift`). Read-only audit; no
repo file was changed. The models stay the same and the user's effort choice is respected. Every saving
below comes from waste (orphaned sessions, duplicate payloads, frames nobody needs, idle billing, spoken
reasoning, per-message fees), not from a cheaper model or lower effort.

Reproducible arithmetic: `docs/handoff/2026-10-31/cost/model.mjs`
(run `node model.mjs`). Bug repro: `.../scratchpad/cost/orphan-repro.mjs`.

Network caveat: WebFetch could not reach ai.google.dev, developers.openai.com, docs.cloud.google.com,
firebase.google.com, discuss.ai.google.dev or docs.rs from this session (DNS blocked). Every price and rule
below comes from WebSearch result summaries of those pages, so check the page before you ship anything
priced on it. Sources are at the end.

---

## 0. Ranked summary

| # | Finding | Est. saving | Quality risk | Certainty |
|---|---|---|---|---|
| V1 | Provider session left open (and unmetered) when the caller hangs up while it is connecting | 2–8% of GPT-Live/xAI spend, plus an unbounded leak per event | none | **confirmed by repro** |
| V2 | 1 fps camera/screen frames forwarded as-is: no dedup, no 1 fps cap at the relay, and frames are added as conversation items on OpenAI (native clients ignore `screenInput`) | 60–74% of a Gemini screen-share call; ~95% of image tokens on OpenAI camera/screen calls; ~15–25% of Gemini voice spend if 15% of minutes share video | low | high (code); token counts per frame need measuring |
| V3 | Gemini `realtimeInput` sends every audio chunk and frame twice (`mediaChunks` + `audio`/`video`) | 0% or ~27% of every Gemini call (verify first) | none | needs a 10-min check |
| V4 | No idle/abandon hang-up and no muted-suspend; GPT-Live and xAI bill wall-clock seconds | ~9% (5–25%) of GPT-Live/xAI voice-layer spend | low | medium (needs idle-tail data) |
| V5 | MiniMax composed path omits `reasoning_split`, so `<think>` text is streamed to TTS (spoken and billed) and eats `max_tokens: 400` | ~75% of MiniMax TTS spend | none (quality improves) | high (MiniMax docs + app already does it) |
| V6 | xAI history seeded one `conversation.item.create` per turn at $0.004 per text input | ~16% of a 5-min xAI call with 20-turn history ($0.08 → $0.004) | low | high |
| M0 | Meter from provider usage, not durations (Gemini usageMetadata, GPT-Live/xAI wall clock, Qwen response.done, legacy Realtime token table) | 0% direct; the ledger today records ~16% of modelled Gemini cost | none | high |
| V7 | Pin Gemini `realtimeInputConfig.turnCoverage`; optional ONLY_ACTIVITY for camera sessions | 0% (pin) / ~48% of a camera call (option) | none / medium | medium |
| V8 | Gemini `slidingWindow` has no `triggerTokens` (default ≈80% of 128k, never reached in a 15-min audio call) | 0% audio-only; caps runaway cost in high-res video calls | medium | low-medium (one forum report says target_tokens is ignored for S2S) |
| V9 | Legacy Realtime fallback: `gpt-realtime-whisper` transcription, no retention-ratio truncation, no `conversation.item.truncate` on barge-in | 82% of that path's transcription line; cache-hit protection | low | high (fallback path only) |
| V10 | MiniMax pushes every sentence to TTS as soon as it is generated; on barge-in the unheard ones are already billed | ~10% of MiniMax TTS | low | medium |
| V11 | Gemini delegate: no in-call memo for a repeated question; grounding metered per answer, not per query | ~3–5% of delegate spend, plus correct metering | none | medium |
| V12 | Web uplink sends a WebSocket frame per AudioWorklet block (128 samples ≈ 2.7 ms), and the relay forwards each one | 0% API; 8–15x fewer upstream messages (relay CPU) | low (+≤20 ms) | high |

Considered and rejected (would change quality or save nothing) are in §4.

---

## 1. What happens today (facts, file:line)

### Providers, defaults, how each is billed

| Provider (relay id) | Default model | Relay price used | How the provider actually bills (sources §6) |
|---|---|---|---|
| `gemini` (**product default**, `src/lib/voice-relay-protocol.ts:150`, native `JunoVoiceRelayProtocol.swift:32`) | `gemini-3.8-live`, or `-extended-thinking` on the Medium/High rungs (`relay/src/providers/gemini-live.ts:117-119`) | $0.005/min mic in, $0.018/min audio out, by duration (`registry.ts:187`) | Audio/video in ≈ $3/M, text in ≈ $0.75/M, audio out ≈ $12/M, 25 tok/s of audio. **Each turn bills the whole session context** (system instruction + every earlier turn), up to the window. |
| `openai` | GPT-Live-1 (`gpt-live.ts:123`), delegating to `gpt-6.1-sol` at the caller's effort, default **high** (`protocol.ts:45`) | $0.05/min × **mic seconds** (`registry.ts:156-159`, `gpt-live.ts:338`) + delegation estimate (`delegate-pricing.ts:16-19`) | $0.05/min of **session duration**, billed per second. Backend model and tools billed separately. |
| `openai` fallback / pinned | `gpt-realtime-2.1` Realtime (`registry.ts:17-40`) | the same $0.05/min, applied to input tokens ÷10 (`openai-realtime.ts:315-316`). **No `tokens` table exists**, despite the comment at `registry.ts:154-155`. | $32/M audio in, $0.40/M cached, $64/M audio out, $4/$24 text. Input transcription is billed separately (`gpt-realtime-whisper` $0.017/min). |
| `xai` | `grok-voice-3.0` (`registry.ts:82`) | $0.08/min × mic seconds (`registry.ts:219`) | $0.08/min of call + **$0.004 per text input** pushed into a session (`registry.ts:216-218` notes this and leaves it unpriced) |
| `qwen` | `qwen3.5-omni-flash-realtime` | output seconds only; input **never** priced (`openai-realtime.ts:309` returns before reading usage for non-OpenAI) | Token-priced per request (rates unverified) |
| `minimax` | `MiniMax-M2.7-highspeed` LLM + `speech-2.6-turbo` TTS | `full.length/1000*0.06 + 0.0005` per turn (`minimax-composed.ts:231-232`) | TTS per character submitted; LLM $0.60/$2.40 per M, cache read $0.06 (`src/lib/pricing.ts:336-338, 671-682`) |

No Anthropic call exists anywhere in the relay, so Anthropic caching and Batches do not apply here.

### Session lifecycle
- One client WebSocket is one `RelaySession` (`server.ts:71-90`). On `session.start` it fetches memory and persona in parallel, up to 2.5 s each (`session.ts:46, 246`), then `startProvider` (`session.ts:308-398`).
- `startProvider` awaits `session.connect(...)` (`session.ts:351-358`) and **never checks `this.closed`** before or after (see V1).
- Session cap: `min(provider cap, RELAY_MAX_SESSION_SEC=3600)` (`session-limit.ts:5`, `session.ts:362-369`). Gemini's cap is 15 min (`registry.ts:181`), so every Gemini call ends at 15 min. OpenAI and xAI: 60 min. Qwen and MiniMax: 120 min.
- **No idle or inactivity handling** anywhere: relay, web hook or native kit (grepped for inactiv/idleTimeout/autoEnd/"still there"; none found).
- Usage is pushed to the client and spend is reported to the app every 5 s (`session.ts:221-224, 557-601`). These are app DB calls, not model calls.

### Instructions and seeded context (sizes measured from `relay/dist`)
- Base instructions are 660 chars (≈165 tokens), or 827 with the web-search sentence swapped in (`voice-context.ts`, `session.ts:32-34`). With the persona (≤4,000 chars) and memory (≤4,000 at the relay, 3,500 at the app, `src/lib/voice-memory.ts:31`) they reach 8,111 chars (≈2,030 tokens). The Gemini tool declaration adds ≈637 chars.
- Chat history seeded at start: ≤20 turns and ≤12,000 chars total (`protocol.ts:113-115`, `session.ts:622-642`). On a provider switch, `transcript.slice(-30)` (`session.ts:354`), where a typed turn can carry ≤24,000 chars of attachment context (`voice-context.ts:2`).
- Instructions never change mid-session, so they are prefix-cache-stable wherever caching exists. Gemini Live bills them as text input **on every turn**.

### Audio uplink / VAD / transcription
- Web: mic → AudioWorklet → one binary WS frame per 128-sample block (≈2.7 ms at 48 kHz) (`use-realtime-voice.ts:788-897`). Nothing is uploaded while muted or while the assistant is speaking unless a local barge-in fires (`use-realtime-voice.ts:830-879`). Native does the same (`RealtimeAudioEngineEndpoint.swift:527`). Silence between turns **is** streamed.
- Gemini: `sendAudio` puts the same base64 in **both** `mediaChunks` and `audio` (`gemini-live.ts:336-341`). Video likewise (`gemini-live.ts:351-356`). No `realtimeInputConfig` (VAD, turnCoverage) and no `mediaResolution` in setup (`gemini-live.ts:286-317`). `contextWindowCompression: { slidingWindow: {} }` with no trigger (`gemini-live.ts:314`). Input and output transcription are both on (`:311-312`).
- OpenAI legacy: `server_vad`, transcription `gpt-realtime-whisper` (`registry.ts:34-35`), no `truncation`, no `noise_reduction`, and `interrupt()` sends `response.cancel` without `conversation.item.truncate` (`openai-realtime.ts:234-241`).
- Qwen: `semantic_vad` + `gummy-realtime-v1` (`registry.ts:63-64`). xAI: `server_vad` (`registry.ts:93`).
- GPT-Live: no VAD config (full duplex). The turn end is inferred from a 700 ms output gap (`gpt-live.ts:199`).

### Video
- Web screen share: 1 fps, ≤1024 px, JPEG 0.6, only when `capabilities.screenInput` (Gemini, Qwen) (`use-realtime-voice.ts:1410-1475`).
- **Native** screen share (macOS, iOS) and the iOS camera: 1 fps, ≤1024 px, JPEG 0.6, gated on `screenInput || videoInput` (`JunoRealtimeVoiceController.swift:1121, 1318, 1356, 1380`; `DesktopVoice.swift:381`; `JunoMobileVoiceCamera.swift:150, 213-226`). OpenAI advertises `videoInput: true, screenInput: false` (`registry.ts:137-138`), so native streams 60 frames/min into OpenAI.
- Relay: `video.frame` is forwarded whenever it is <2 MB, with no rate cap or dedup (`session.ts:269-273`). The protocol's "Send <= 1 fps" (`protocol.ts:143`) is not enforced.
- GPT-Live adds each frame as a user `response.item.create` image with `detail:"auto"` (`gpt-live.ts:345-349`), and legacy Realtime as a `conversation.item.create` (`openai-realtime.ts:216-227`). Both are permanent context items.

### Delegates
- GPT-Live → Sol: each `session.delegation.created` is charged the estimate ($0.086 at high: 8k in × $2/M + 6k out × $10/M + $0.01 search), topped up from a `response.completed` usage (`gpt-live.ts:399-419`).
- Gemini → `gemini-3.8-flash` via `ask_backend_model` (`gemini-delegate.ts:21-42, 149-203`). The prompt is tiny (system ≈50 tokens, question ≤4k chars, context ≤8k chars), so it is below any implicit-cache minimum. Grounding is charged $0.014 whenever `groundingMetadata` is present (`gemini-delegate.ts:141, 185`).

---

## 2. Cost model (assumptions and arithmetic)

Assumptions, stated so they can be replaced by measured values (M0):
- Gemini call: 3 user turns/min. Wall time is 35% user speech, 45% model speech, 20% silence. Silence is **not** in context (the Gemini 3.x default turn coverage includes audio activity plus all video). Both directions accumulate at 25 tok/s. The static prefix is 1,500 tokens (instructions + some history). No cache discount on the Live context (none documented).
- Per-turn billed input = prefix + accumulated tokens. Growth per 20 s turn: g = 25 × 20 × (0.35 + 0.45) = 400 tokens. Over N turns: Σ = N·prefix + g·N(N+1)/2.

| Scenario (model.mjs) | Real (modelled) | Relay ledger today | Note |
|---|---|---|---|
| Gemini 10-min, audio only | **$0.673** (in $0.592 = 30×1,500 text + 400×465 audio tokens; out $0.081) | $0.108 | 83% of the cost is re-billed context |
| Gemini 15-min (cap), audio only | $1.414 | $0.163 | grows quadratically |
| Gemini 10-min, user audio processed twice (V3) | $0.917 | $0.108 | removing the duplicate saves 27% |
| Gemini 10-min + screen at 70 tok/frame | $2.626 | $0.108 | video is 78% of context growth |
| ↳ with 80% of frames deduped (V2) | $1.063 | | −60% |
| Gemini 10-min + screen at 280 tok/frame (text-heavy) | $8.485 | $0.108 | |
| ↳ with 80% deduped | $2.235 | | −74% |
| Camera (frames always differ), ONLY_ACTIVITY coverage (V7 option) | $1.356 vs $2.626 | | −48% |
| GPT-Live 10-min, 3 high-effort delegations | $0.758 (0.50 + 3×0.086) | ≈$0.53 (mic seconds ≈55% of wall) | |
| xAI 5-min call + 20-turn history seed | $0.48 (0.40 + 20×0.004) | $0.40 or less | |
| MiniMax turn: 900 chars of think + 300 of answer | TTS $0.072 → $0.018 with V5 | | −75% |

Voice-spend mix (assumption, for blended figures only): Gemini 70% of minutes (≈69% of voice $), GPT-Live 20%, xAI 5%, Qwen/MiniMax 5%. Swap in real minute shares from M0.

---

## 3. Findings

### V1 — Orphaned provider session when the caller hangs up during connect (bug)
**Today.** `server.ts:85-89` calls `session.destroy()` on WS close. `destroy()` (`session.ts:607-616`) sets `closed`, clears the timers and closes `this.provider`, which is still `null` while `startProvider` is awaiting `session.connect` (`session.ts:351`) or `loadMemory`/`loadPersona` (`:246`). When connect resolves, `this.provider = session` and a fresh `sessionTimer` is set (`:359-369`). That timer's `endAtSessionLimit` returns early because `closed` is true (`:401`), so **nothing ever closes the provider**. The usage timer is already cleared, so its spend is never reported either. The window is ≤2.5 s for memory plus 1–15 s for connect, plus the GPT-Live→Realtime fallback. A mid-switch disconnect (`:327-331`) hits the same race.
**Repro** (in memory, read-only): `node .../scratchpad/cost/orphan-repro.mjs` prints `provider.close() calls after destroy + connect: 0`.
**Saving.** GPT-Live bills per connected second, so each orphan costs up to the provider's own session ceiling (60 min = $3.00; xAI $4.80). Gemini orphans cost ≈$0 (no turns) but reconnect on every `goAway` indefinitely (`gemini-live.ts:433-436, 527-541`), leaking sockets. If 1–3% of GPT-Live/xAI sessions end during connect and an orphan lives 15–60 min: 0.02 × $3 / $0.76 ≈ 8% at the high end, ≈2% at the low end.
**Risk.** None. It only closes sessions nobody is attached to.
**Sketch.** `relay/src/session.ts`: bail at the top of `startProvider` and after each `await` if `this.closed`; after `await session.connect(...)`, `if (this.closed) { await session.close().catch(()=>{}); return; }`; guard the `session.start` branch after `Promise.all`. Add a test in `relay/tests/` using a slow mock provider, the pattern in `orphan-repro.mjs`.
**Measure.** A counter `relay_orphan_closed_total`, and the OpenAI GPT-Live minutes in the usage export against the relay's per-session wall seconds.

### V2 — Video frame policy: dedup, a 1 fps cap at the relay, and "frame-on-turn" for item-based providers
**Today.** All clients send 1 frame/s while sharing, unchanged frames included. Native clients send to OpenAI, where each frame becomes a permanent conversation item (see §1 Video).
- **Gemini.** Frames are part of the turn (3.x default coverage includes all video), so they accumulate in context and are re-billed every turn. At 70 tok/frame (Gemini 3 video low/medium), video is 78% of context growth; at 280 (high), 93%.
- **OpenAI.** 60 image items/min. If the delegate receives the conversation (the docs say GPT-Live "supplies conversation context"), 3 min of camera ≈ 180 × ~1,105 tok ≈ 199k tokens ≈ **$0.40 per delegation** at Sol's $2/M, against $0.013 for one frame per user turn. On the legacy Realtime path the window fills with images, and every response re-bills it.
**Saving.** Gemini screen-share call: 60% (70 tok) to 74% (280 tok) with 80% of frames dropped as unchanged (model.mjs). Blended: if 15% of Gemini minutes carry a screen or camera, those calls are ≈41% of Gemini spend, so ≈15–25% of Gemini voice spend. OpenAI camera/screen: ≈95%+ of image tokens.
**Risk.** Low. The model still has the newest frame whenever the picture changes and whenever the user speaks. It loses unprompted comments about a scene that changes while nobody talks; that is rare.
**Sketch.**
1. `relay/src/session.ts` `video.frame`: drop a frame byte-identical (hash) to the last one forwarded. Enforce ≥900 ms between forwarded frames per session. Always forward the latest pending frame on `onUserSpeechStart` and on `input.text`.
2. Providers with `screenInput:false` (openai, xai): **latest-frame-wins**. Hold the newest frame and send it only on user speech start or a typed turn, and only if it changed since the last one sent (`gpt-live.ts:345`, `openai-realtime.ts:214`). On legacy Realtime, optionally `conversation.item.delete` the previous image item.
3. Clients: near-duplicate suppression via a 32×32 grayscale mean-abs-diff before encoding (web `use-realtime-voice.ts:1459-1475`; native `JunoRealtimeVoiceController.swift:1380-1388`, `JunoMobileVoiceCamera.swift` FrameGate). Make the native screen share honour `screenInput`, as the web does, or rely on (2).
**Measure.** Relay counters frames_in/forwarded/deduped per provider. On Gemini, `usageMetadata.promptTokenCount` growth per minute with the screen on, before and after. On GPT-Live, the delegation `usage.input_tokens` in `response.completed` with the camera on, before and after.

### V3 — Gemini sends every audio chunk and frame twice
**Today.** `gemini-live.ts:336-341`: `realtimeInput: { mediaChunks: [{…data}], audio: {…same data} }`; video likewise (`:351-356`). `mediaChunks` is deprecated in favour of `audio`/`video`/`text` (SDK docs). No test pins the dual send. Both fields arrived in one squashed commit.
**Saving.** If the server ingests both, user audio enters context twice: g goes from 400 to 575 tok/turn and a 10-min call from $0.917 to $0.673 (**−27%** of every Gemini call; more with video). If the server ignores one, the API saving is 0% and the relay→Google uplink halves (≈85→43 KB/s per call).
**Risk.** None, provided the `audio` field alone works for `gemini-3.8-live`. The deprecation notes say it is the current field.
**Sketch.** Send only `realtimeInput.audio` and `realtimeInput.video`. When the client pauses the mic for more than ~1 s (mute), send `realtimeInput.audioStreamEnd: true`, as Google documents.
**Measure (do this first, 10 minutes).** Log `usageMetadata.promptTokensDetails` (AUDIO) per turn against seconds of mic audio sent. ≈25 tok/s means single ingestion; ≈50 tok/s means double.

### V4 — Idle/abandoned-call hang-up and muted-suspend for duration-billed providers
**Today.** No inactivity logic anywhere. GPT-Live ($0.05/min) and xAI ($0.08/min) bill connected time, including muted time and a call left open in a background tab, up to the 60-min cap ($3.00 / $4.80).
**Saving.** Model: 8 active min per call + 1 min of normal trailing idle, and 5% of calls abandoned for 20 min. A 2-min idle cutoff recovers 0.05 × 18 = 0.9 of 10 billed min = **9%** of voice-layer spend (5–25% depending on the abandon rate). Gemini: ≈0 (no turns, no bill), unless video keeps flowing (V2 covers that).
**Risk.** Low. The relay sends a "still there?" cue/notice after 90 s with no user speech and no assistant audio, ends at 120 s with `session.closed` reason `idle`, and the client offers one-tap resume (history is replayed as today). Muted more than 3 min on a duration-billed provider: close upstream but keep the `RelaySession` and transcript, and reconnect on unmute (≈1 s, the same seeding path as a switch).
**Sketch.** `relay/src/session.ts`: track `lastActivityMs` (onUserSpeechStart, onAudio, input.text). Add a 10 s check on the existing usage tick. A per-provider policy flag goes in `registry.ts` (`billsWallClock: true` for openai/xai). Add `"idle"` to `session.closed` in `protocol.ts`, `src/lib/voice-relay-protocol.ts` and `JunoVoiceRelayProtocol.swift`.
**Measure.** Log `idleTailSec` (close time − last activity) per session; check the distribution before and after. Guardrail: the share of idle-ended calls restarted within 60 s (false hang-ups) stays under 2%.

### V5 — MiniMax: `<think>` content is spoken, billed as TTS, and truncates answers
**Today.** `minimax-composed.ts:184` sends `{model, messages, stream, max_tokens:400}` with no `reasoning_split`. MiniMax documents that M2.7's `content` includes the `<think>` content by default. Every `delta.content` goes to the transcript, the sentence splitter → TTS (`:208-219`), the history (`:229`) and the cost estimate (`:232`). The main app already sets `params.reasoning_split = true` for MiniMax (`src/lib/openai-compat.ts:478-481`); the relay does not.
**Saving.** TTS at $60/M chars: 1,200 → 300 chars per turn = **−75%** of MiniMax TTS. It also stops the 400-token cap being spent on reasoning.
**Risk.** None. Quality goes up: the user stops hearing the reasoning.
**Sketch.** Add `reasoning_split: true` to the request. Read only `delta.content`. Keep `reasoning_details` on the assistant message in `this.messages`, since MiniMax asks for it to be preserved, but never send it to TTS or the transcript. Optionally raise `max_tokens` so the cap applies to the answer.
**Measure.** Characters sent to TTS per turn, before and after. A smoke test (`npm run smoke -- minimax`) asserting no `<think>` reaches `onTranscript`.

### V6 — xAI: history seeded as N separate text inputs at $0.004 each
**Today.** `openai-realtime.ts:176-191` sends one `conversation.item.create` per seeded turn: ≤20 at start, ≤30 on a switch, and again on every client reconnect. xAI charges $0.004 per text input (`registry.ts:216-218`).
**Saving.** $0.08 (start) or $0.12 (switch) → $0.004. A 5-min call goes from $0.48 to $0.404 (**−16%**). Smaller on longer calls.
**Risk.** Low. The model gets the same text as one role-labelled block ("Earlier in this conversation: User: … / Assistant: …"), or inside `session.instructions` if xAI does not count instructions as a text input.
**Sketch.** A `RealtimeDialect.seedAsSingleItem` flag (xai: true) in `registry.ts`, branched in `openai-realtime.ts:176`. Reuse `providerText` for attachment context.
**Measure.** The xAI invoice's text-input count per session, before and after.

### M0 — Make the meter tell the truth (prerequisite for measuring everything above)
**Today.** Gemini is priced by duration (`registry.ts:187`), so the ledger records $0.108 of a modelled $0.673 10-min call (≈16%). The relay already receives `usageMetadata` on the Live socket but reads only `thoughtsTokenCount` (`gemini-live.ts:398, 411-412`). GPT-Live and xAI are priced on mic seconds while they bill wall clock (≈55% of real). Qwen input is never priced (`openai-realtime.ts:309`). The legacy Realtime path has no `tokens` table, so it prices input tokens ÷10 as "seconds" at $0.05/min (`openai-realtime.ts:315-316`). Extended Thinking thoughts are priced at $12/M where the Live text-output rate is ≈$4.50/M. Grounding is charged per answer, not per executed query.
**Saving.** 0% direct. It shows where the money really goes, and it stops the operator silently absorbing the under-billed part of voice.
**Risk.** None for answers. Users' budgets will run down faster, because they become correct.
**Sketch.** `gemini-live.ts`: price `promptTokenCount`/`responseTokenCount` by modality (`promptTokensDetails`, `cachedContentTokenCount`) via a `tokens` table in `registry.ts`. openai/xai: emit wall-clock seconds from `connect` to `close` (a timer in `session.ts`). Qwen: read `response.done.usage`. Legacy: add `tokens: {audioIn:32, audioInCached:0.4, textIn:4, textInCached:0.4, audioOut:64, textOut:24}` (aggregator figures, check them). Grounding: `webSearchQueries.length × $0.014`.
**Measure.** Ledger `voice:*` rows against the Google billing export and the OpenAI/xAI usage dashboards, weekly.

### V7 — Gemini turn coverage: pin the default; optional ONLY_ACTIVITY for camera calls
**Today.** No `realtimeInputConfig`, so silence and video handling are whatever the model's default is (Gemini 3.x: audio activity + all video, per SDK docs).
**Saving.** Pinning `TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO` saves 0% but guards against a future default of `ALL_INPUT`, which in model.mjs adds 17% (silence in context). Option: `TURN_INCLUDES_ONLY_ACTIVITY` for camera calls keeps only frames during user speech: **−48%** of a camera call.
**Risk.** Pin: none. Option: medium. The model does not see what happened while it was talking.
**Sketch.** The `setup.realtimeInputConfig` in `gemini-live.ts:286-317`. Setup rejects unknown fields, so verify against `gemini-3.8-live` in staging (tests: `tests/gemini-setup-failure.test.ts`).
**Measure.** promptTokenCount growth per minute (M0).

### V8 — Gemini sliding-window trigger as a safety cap for video calls
**Today.** `slidingWindow: {}` with the default trigger ≈80% of 128k ≈ 102k. An audio-only call reaches ≈25k at the 15-min cap, so compression never fires. A 280 tok/frame screen call reaches 128k in ≈7 min, and every turn there re-bills ≈100k tokens.
**Saving.** 0% for audio-only. For high-res video calls, a cap such as `triggerTokens: 48000, targetTokens: 24000` bounds the per-turn input to ≤48k (roughly half of the late turns of a 280 tok/frame call).
**Risk.** Medium: the earliest turns, including seeded history, drop first. One forum report says `target_tokens` had no effect on realized cost for S2S on gemini-3.1-flash-live, so measure before relying on it.
**Sketch.** The `contextWindowCompression.slidingWindow` fields in `gemini-live.ts:314`. Only worth doing after V2.
**Measure.** promptTokenCount per turn plotted over a 15-min screen-share call.

### V9 — Legacy OpenAI Realtime fallback hygiene (runs when GPT-Live is unavailable or pinned)
- **Transcription.** `gpt-realtime-whisper` costs $0.017/min against $0.003/min for `gpt-4o-mini-transcribe`: **−82%** on that line (≈$0.014 per mic minute). It is unmetered today. Risk low-medium: the transcript feeds saved chats and memory, not the model's answer. A/B the WER first, or keep whisper and meter it.
- **Truncation.** Add `truncation: { type: "retention_ratio", retention_ratio: 0.8 }`, as OpenAI's cost guide recommends, so a truncation does not bust the cache every turn once the window fills (cached audio input is $0.40 against $32/M). Risk low.
- **Barge-in.** Send `conversation.item.truncate` with `audio_end_ms` = ms actually played, so unheard audio leaves the context (fewer re-billed tokens, and the model's memory matches what was heard). The relay must track the `item_id` from `response.output_item.added`. Played ms can be approximated from bytes forwarded minus the client buffer, or reported by the client. Risk low; quality improves.
- **Noise reduction.** `noise_reduction: {type:"near_field"}` (or far_field on desktop) reduces false VAD starts, each of which re-bills the context and generates audio. Risk low.
- Files: `registry.ts:27-39`, `openai-realtime.ts:234-241, 253-327`. Measure the cached-token share in `response.done.usage` and the count of responses cancelled within 1 s.

### V10 — MiniMax: pace TTS submission to playback
**Today.** Each finished sentence is sent to TTS immediately (`minimax-composed.ts:215-219, 241-255`). The LLM outruns speech, so at barge-in most of the reply is already submitted and billed. On interrupt the socket is closed and reopened (`:139-159`).
**Saving.** If 25% of turns are interrupted halfway, ≈12.5% of characters go unheard. Keeping ≤2 sentences ahead of the audio actually forwarded recovers most of it: ≈10% of MiniMax TTS.
**Risk.** Low. A two-sentence lead keeps time-to-first-audio unchanged.
**Sketch.** A queue in `speak()`. Release the next sentence when the forwarded audio seconds come within ~1.5 s of the submitted text's estimated duration.
**Measure.** TTS chars submitted against chars spoken (from `audioOutSec`).

### V11 — Gemini delegate: in-call memo, and grounding metered per query
**Today.** Every `ask_backend_model` call goes to Flash. After a barge-in or a `toolCallCancellation`, Live often re-asks the same question, and the aborted request is still billed at the character floor (`gemini-delegate.ts:196-199`). Grounding is charged per grounded answer, while Gemini 3 bills per executed search query (5,000/month free shared).
**Saving.** ≈3–5% of delegate spend (repeat questions within 120 s). Metering becomes correct (up or down).
**Risk.** None. The memo key is the normalized question plus context, with a 120 s TTL, per call only.
**Sketch.** A `Map` on `GeminiLiveSession` in `runDelegation` (`gemini-live.ts:502-519`). Cost from `groundingMetadata.webSearchQueries.length`.
**Measure.** A delegate memo hit counter; the grounding query count against the Google billing export.

### V12 — Batch uplink audio into 20 ms frames (infrastructure, not API)
**Today.** The web worklet posts 128-sample blocks, and each becomes one WS frame (≈375/s at 48 kHz). The relay resamples and re-wraps each one as JSON+base64 to the provider (`gemini-live.ts:334-343`, `gpt-live.ts:334-339`). With V3 unfixed, each message carries the payload twice. The relay shares a `shared-cpu-1x` / app VM (`fly.toml`, README).
**Saving.** 0% API. 8–15x fewer upstream messages and less JSON/base64 CPU per call, which means more concurrent calls per relay box.
**Risk.** Low: +≤20 ms worst-case uplink latency (Google suggests ~20–100 ms chunks).
**Sketch.** Accumulate to 20 ms in `use-realtime-voice.ts:880-896` and/or in `RelaySession.handleAudio` (`session.ts:304-306`), flushing immediately on barge-in.
**Measure.** Relay CPU per concurrent call; p50/p95 time-to-first-audio unchanged.

---

## 4. Considered and rejected

- **Lowering the default GPT-Live delegate effort from high to medium** (`protocol.ts:45`) would save ≈$0.03 of each $0.086 delegation (−35%), but it changes answer quality. Rejected under the "same quality" rule. The user's chosen effort stays as it is.
- **Cheaper realtime models** (gpt-realtime mini, Flash-Lite Live): these change the model. Rejected.
- **Client-side silence gating** of mic audio: on Gemini 3.x the default turn coverage already excludes audio inactivity, GPT-Live and xAI bill wall clock anyway, and legacy server_vad commits only speech. ≈0% saving (17% only if silence were in context; V7's pin covers that). Only `audioStreamEnd` on mute is kept (V3).
- **Lower `mediaResolution` for screen share**: Gemini's docs say high resolution is for reading text, and screens are text-heavy. Rejected for screen share; V2's dedup gets most of the saving with no loss. A camera-only LOW setting is possible later (session-level, so it needs a reconnect).
- **Trimming memory, persona or seeded history**: the prefix is a minor cost. A 5,200-token prefix costs +12% on a 10-min Gemini call against 1,500 tokens (model.mjs `gem10_bigPrefix`), and removing it loses context the user expects. The current caps are reasonable.
- **Flex/Batch tiers and `service_tier`** on the delegate: voice is latency-critical and the relay has no deferrable work. Rejected.
- **`prompt_cache_key` on GPT-Live delegation**: unverified whether `delegation.responses` accepts the field (the session config rejects unknown fields). The input side is only $0.016 of $0.086, so at most ≈10% of a delegation. Revisit if OpenAI documents the field.
- **Anthropic prompt caching / Message Batches**: no Anthropic calls exist in the relay.
- **Adjacent, outside relay/src**: read-aloud `/api/voice/tts` re-synthesizes identical (text, voice) pairs. A content-hash cache would save repeats there; that belongs to the app-side dimension.

## 5. Measurement plan (one PR before the savings work)
1. Write one structured log line per `RelaySession.destroy()`: provider/model, wall seconds per provider leg, mic seconds, out seconds, idle tail seconds, frames in/forwarded/deduped, delegations, measured tokens by modality (Gemini usageMetadata, response.done), estimated against measured USD, and close reason (incl. `orphan-closed`, `idle`).
2. Reconcile weekly: ledger `voice:gemini|openai|xai|qwen|minimax` against the Google billing export and the OpenAI/xAI/DashScope/MiniMax dashboards.
3. Quality guardrails, before and after each change: time to first audio (p50/p95), barge-in-to-silence latency, delegate success rate, false idle hang-ups (restart within 60 s), and transcript WER spot checks (only for the V9 transcription swap).
4. Order of rollout: M0 + V1 + V3-check (no risk, measuring) → V5, V6 → V2 → V4 → V9–V12 → V7/V8 options.

## 6. Sources
- Gemini Live per-turn context billing ("Session Context Window includes new tokens + all accumulated tokens from previous turns"): https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing ; https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/best-practices
- Live API context window (128k native audio) and 25 tok/s audio: https://ai.google.dev/gemini-api/docs/live-api/capabilities
- Compression defaults (trigger 80% of window, target 50% of trigger): https://firebase.google.com/docs/ai-logic/live-api/sessions ; forum report on target_tokens and S2S: https://discuss.ai.google.dev/t/live-api-does-contextwindowcompression-target-tokens-affect-the-post-compression-window-for-audio-s2s-sessions/147228
- Video tokens per frame (Gemini 3: 70 low/medium, 280 high), Live 1 FPS / 768×768: https://ai.google.dev/gemini-api/docs/media-resolution ; https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/send-audio-video-streams
- TurnCoverage values: https://pub.dev/documentation/gemini_live/2026.10.6/compat_firebase_ai/TurnCoverage.html ; defaults per model: https://docs.rs/gemini-live/0.1.8/src/gemini_live/types/config.rs.html
- `mediaChunks` deprecated in favour of audio/video/text; `audioStreamEnd`: https://hexdocs.pm/gemini_ex/Gemini.Live.Message.RealtimeInput.html ; https://firebase.google.com/docs/reference/unity/class/firebase/a-i/live-session ; https://ai.google.dev/gemini-api/docs/live-api/live-transcribe
- Gemini 3.8 Live rates (aggregators, conflicting; verify): https://www.developersdigest.tech/voice-agents/gemini-live-api ; https://tokenkarma.app/blog/gemini-live-api-pricing-voice-agents-2026/ ; https://www.getmaxim.ai/bifrost/model-library/compare/gemini/gemini-3.8-live
- Grounding billed per search query on Gemini 3 ($14/1,000, 5,000/month free): https://ai.google.dev/pricing ; https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
- GPT-Live-1 $0.05/min billed per second of session; backend billed separately: https://developers.openai.com/api/docs/models/gpt-live-1 ; delegation supplies conversation context: https://developers.openai.com/api/docs/guides/live-delegation
- Realtime cost guide (per-response billing, caching, retention_ratio truncation): https://developers.openai.com/api/docs/guides/realtime-costs ; https://developers.openai.com/blog/realtime-api
- Realtime VAD / idle_timeout_ms / noise_reduction: https://developers.openai.com/api/docs/guides/realtime-vad
- gpt-realtime-whisper $0.017/min: https://developers.openai.com/api/docs/models/gpt-realtime-whisper ; gpt-4o-mini-transcribe ≈$0.003/min: https://costgoat.com/pricing/openai-transcription
- gpt-realtime-2.1 token rates (aggregators): https://www.layer3labs.io/guides/openai-realtime-api-pricing ; https://aireiter.com/blog/openai-realtime-api-pricing
- Grok Voice 3.0 $0.08/min + $0.004 per text input: https://www.eesel.ai/blog/grok-voice-3-pricing ; https://www.buildmvpfast.com/blog/grok-voice-3-api-voice-agents-pricing-2026
- MiniMax `<think>` in content by default; `reasoning_split`: https://platform.minimaxi.com/docs/api-reference/text-openai-api
- Qwen3.5-Omni pricing (unverified): https://wavespeed.ai/blog/posts/qwen3-5-omni-api-pricing-2026
