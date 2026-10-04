# Usage metering audit (2026-10-04)

The owner's ask: *every* call that goes through a provider API and costs money must count against the
user's usage, so no account is given more than its plan (plus top-ups) pays for.

This is the inventory of every outbound paid call in the web app, the production scripts
(`scripts/work-runner.ts`, `scripts/work-trigger-poller.ts`, `scripts/research-worker.ts`) and the
voice relay (`relay/`), what gates it before money is spent, and how the real cost reaches `ApiSpend`
afterwards. `tests/usage-metering-coverage.test.ts` keeps this list honest: any module that touches a
provider key, a provider host or one of the shared paid doors (`streamChat`, the fused web search)
must appear in its `METERED` map with a sentence saying how it is billed, or the suite fails.

## How metering works (the pattern every row follows)

1. **Admit** before the provider is called: plan feature (`PLANS[plan]`), monthly budget
   (`checkBudget`: settled spend + open holds vs plan budget + top-up credit), the rolling 5-hour and
   weekly windows (`checkUsageWindows`), and the call's own estimate against what is left
   (`admitMeteredCall` / `admissionVerdict`, `src/lib/metering/`). Long or concurrent units of work also
   take a **reservation** (`reserveSpend`) so parallel requests cannot all read the same untouched month.
2. **Run**, with a per-request cap where the provider allows one (max tokens, max seconds).
3. **Record** the true cost with `recordSpend` (kind, model, tokens incl. cache read/write and
   reasoning, tool/search fees, batch discount), against the user who caused it, on every exit
   (success, error, abort), and **settle** the reservation.

Status legend: **ok** = already fully metered before this audit · **fixed** = gap closed in this
branch · **operator** = genuinely no user behind it (cost noted) · **open** = known residual, see Risks.

## Inventory

| # | Paid path | Pre-check | Recorded | Kind | Rate source | Status |
|---|---|---|---|---|---|---|
| 1 | Chat turn (`/api/chat`, all adapters via `streamChat`; web + native) | plan model gate, month, windows, `reserveSpend`, mid-stream guard (`chat-budget-guard`) | `recordSpend` on every exit, cache r/w, reasoning, char floors | chat | `pricing.ts` / `model-metrics.ts` | ok |
| 2 | Chat tool fees: `web_search` engines, `run_code` sandbox seconds, hosted lab search, Gemini grounding beyond free quota | inside the chat guard | `recordToolFees`, `webSearchRequests` on token row, `exec/runtime.ts` meter | chat / work | `tools/metering.ts` list prices; `RUN_CODE_MICRO_USD_PER_SECOND` (46 µ$/s) | ok |
| 3 | AI moderation classifier | none by design (safety must run) | `runUtilityPrompt` per attempt | utility | catalog | ok (budget-exempt) |
| 4 | Titles, follow-up pills, memory extraction / consolidation / project summaries, memory editor, memory backfill, history-compaction summaries, agent reflect, voice-transcript memory | **none** → now `checkBudget` inside `runUtilityPrompt` (refuses a spent account) | `runUtilityPrompt` per attempt (timeouts included) | utility | catalog | **fixed** (gate; recording was ok) |
| 5 | Public UI translation (`/api/i18n/translations`, unauthenticated) | IP + global rate limits only (~4,000 calls/h possible) → now a per-process daily ceiling `PLATFORM_UNATTRIBUTED_DAILY_USD` (default $5) | not attributable (no user) | — | catalog | **fixed** / operator (≤ $5/day/process) |
| 6 | Preflight clarification triage (`/api/chat/clarify`) | month | **nothing** → now `recordSpend` per attempt incl. timeouts | utility | catalog + char floor | **fixed** |
| 7 | Read-aloud TTS (`/api/voice/tts`; Gemini 3.8 Flash TTS → OpenAI gpt-4o-mini-tts → ElevenLabs) | plan voice + rate limit only → now month + windows + estimate | **nothing** → now `recordSpend` at the engine that answered (Gemini priced from the WAV's exact seconds) | voice | Google/OpenAI pricing pages 2026-10-04; ElevenLabs unverified, billed at $0.30/1k chars | **fixed** |
| 8 | Dictation STT (`/api/voice/stt`; gpt-4o-transcribe/whisper, Deepgram nova-3, Gemini Flash-Lite) | plan voice + rate limit only → now month + windows + estimate (duration estimated high from size) | **nothing** → now provider token usage when returned, else duration | voice | OpenAI/Google pages; Deepgram billed at $0.006/min | **fixed** |
| 9 | Realtime voice (relay: GPT-Live, Gemini Live, Qwen, MiniMax) | relay-token: plan + month → now also windows; spend callback verdict now also windows | relay reports every 5 s to `/api/voice/spend` (idempotent), call stopped when `allowed:false` | voice | `relay/src/providers/registry.ts` | ok → **fixed** (windows) |
| 10 | GPT-Live backend delegate (GPT-6.1 Sol + web search) | none | **nothing** (voice layer only) → now an effort-scaled estimate on `session.delegation.created`, topped up by any Responses usage | voice | catalog Sol $2/$10, search $0.01 | **fixed** (estimate; see Risks) |
| 11 | Gemini Live backend delegate (Gemini 3.8 Flash + Search grounding) and Extended Thinking tokens | none | **nothing** → now usageMetadata-priced (2027 rates) + $0.014 per grounded answer; thinking tokens at $12/M | voice | Gemini pricing page 2026-10-04 | **fixed** |
| 12 | Image generation (`/api/generate`) | model `minPlan`, month, choice-scaled estimate | flat per-image list price; GPT Image at `quality:"auto"` can render "high" (4×) → now billed from the response's own token `usage` when higher | image | `spend.ts mediaRequestCost`, `unit-prices.ts` OpenAI image token table | **fixed** |
| 13 | Video generation (`/api/generate`) | model `minPlan` (MAX+), month, estimate | per clip; a job our 15-min deadline abandoned or whose file failed to download was **not billed** → now billed (`BillableVideoError`) | video | per-second list prices in `mediaRequestCost` | **fixed** |
| 14 | Music (Lyria) | as image | per song | audio | `audio-gen-core.ts` | ok |
| 15 | Media concurrency | `checkBudget` read-then-act (30 parallel clips all admitted) → now window check + `reserveSpend` held for the generation, settled/released on every exit | — | image/video/audio | — | **fixed** |
| 16 | Design/canvas edit (`/api/design/[id]/edit`) | plan canvas, month → now also windows + worst-case estimate (prompt + 8k output) | `recordSpend` on every exit | chat | catalog | ok → **fixed** (windows) |
| 17 | Code agent proxy (`/api/agent/*`: Mac Code, cloud runner, Mac-hosted Work) | plan code/agents, month, windows | `recordSpend` on every ending, usage or char floor | code | catalog | ok → **fixed**: per-request output cap (`max_tokens` lowered to what the remainder buys, floor 2,048) |
| 18 | Cloud Code task creation (`POST /api/code/tasks`) | **none** (failed later at the proxy) → now `PLANS.code` | GitHub Actions on a public repo: free | — | — | **fixed** (plan gate) |
| 19 | Code agent web search (`/api/code/search`) | plan webSearch → now also code/agents plan + month + windows + max fused fee | **nothing** (up to 4 keyed engines per query) → `meteredWebSearch` bills each engine that answered | code | research engine list prices (`search-metering.ts`) | **fixed** |
| 20 | Hosted Work runs (`scripts/work-runner.ts`) | plan agents, window remainder as run ceiling, reservation | `recordWorkRunSpend` deltas | work | `tokenRate` | ok → **fixed**: uncatalogued model was priced at **$0** (now dearest rate of its lab); cache writes now carry Anthropic's 1.25× premium |
| 21 | Work run `web_search` tool (fused multi-engine) | inside the run | **nothing** → `meteredWebSearch` | work | engine list prices | **fixed** |
| 22 | Topic-monitor triggers (`scripts/work-trigger-poller.ts`, every 2 min) | **none** (no plan, no budget) → now `PLANS.agents` + month + windows + max fused fee | **nothing** (~720 fused searches/day/trigger) → `meteredWebSearch` | work | engine list prices | **fixed** |
| 23 | Work `run_code` sandbox (hosted exec) | run ceiling | `exec/runtime.ts` meter | work | 46 µ$/s | ok |
| 24 | Agent computers (Docker on own VM) | windows | `billComputerSeconds` at `COMPUTER_COST_MICRO_USD_PER_SECOND` (default **0**) | work | env | operator (VM is a fixed cost) — see Risks |
| 25 | Deep research (planner, workers, lead, citation judge, search fees) | entitlement (Pro+), month, per-run $1 unit ceiling, reservation, per-stage ceilings | `recordSpend(research)` per stage + search fees | research | catalog + search list prices | ok |
| 26 | Memory dreaming via Batch API | windows | billed at the batch discount when the batch lands | utility | `batchPriceMultiplier` | ok |
| 27 | Embeddings (memory facts, memory recall query, knowledge retrieval query) | none (fractions of a micro-dollar each) | **nothing** → `recordSpend` per batch (chars/3, high) | utility | OpenAI $0.02/$0.13; others billed $0.20/M | **fixed** |
| 28 | OCR (`JUNO_OCR_ENDPOINT`, else local tesseract) | — | not recorded | — | self-hosted endpoint / free local | operator / open |
| 29 | Provider health probes, capability probes (admin), model catalog sync, model radar | — | — | — | one tiny completion per lab per window | operator (cents/day) |
| 30 | Composio connector tool calls, Resend email, GitHub API, Stripe | — | — | — | subscription / free tiers | operator |

**Totals:** 30 paths. 7 were fully metered and needed nothing (1, 2, 3, 14, 23, 25, 26). 4 were
metered but had a gap that is now closed (9, 16, 17, 20). 15 were unmetered or ungated and are now
fixed (4, 5, 6, 7, 8, 10, 11, 12, 13, 15, 18, 19, 21, 22, 27). 4 are operator costs with no user
behind them (24 while its price is 0, 28, 29, 30), plus row 5's capped residual.

## FREE / LITE refusals (server side, not just the UI)

| Feature | FREE | LITE | Enforced at |
|---|---|---|---|
| Voice (realtime, TTS, STT) | refused | refused | `voice-access-policy.ts`, `/api/voice/tts`, `/api/voice/stt` |
| Video generation | refused | refused | model `minPlan: MAX` in `/api/generate` |
| Image / music generation | only `gemini-3.1-flash-lite-image` ($0.01, metered against the €0.20) | same | model `minPlan` |
| Deep research | refused | refused | `research/entitlement.ts` |
| Code (proxy, cloud tasks, code search) | refused | refused | `/api/agent`, `/api/code/tasks` (new), `/api/code/search` (new) |
| Agents / Work / topic monitors | refused | refused | `work/dispatch.ts`, task tool, trigger poller (new) |
| `run_code` in chat | refused | refused | `tools/entitlements.ts` |

## Remaining risks

- **Gemini promo rates expire 2027-01-01.** The catalog bills Gemini 3.8 Flash at $0.75/$3.75; Google's
  page says $1.50/$7.50 from January 2027 (Flash TTS $9 → $18 audio). The new TTS/STT/delegate prices
  already use the 2027 figures; **the chat catalog (`model-metrics.ts`) must be updated before 1 Jan
  2027** or Gemini chat will be billed at half cost.
- **GPT-Live delegation** has no documented usage event; it is billed an effort-scaled estimate
  (≈$0.03–$0.14 per delegated turn) and topped up only if a Responses `usage` arrives. If OpenAI's real
  per-delegation cost runs higher (long contexts, several searches), it is under-billed. Check the
  OpenAI dashboard against `voice:openai` ledger rows after a week.
- **Relay without `JUNO_APP_URL`** reports nothing: voice would be unmetered. Production must set it
  (the relay logs nothing about this today).
- **ElevenLabs and Deepgram** prices are unverified for the operator's tier and billed at the top of
  the public range.
- **Agent computers** bill `COMPUTER_COST_MICRO_USD_PER_SECOND`, default 0. If the VM is ever sized per
  user, set it.
- **OCR endpoint** (`JUNO_OCR_ENDPOINT`) is unpriced; if it is ever pointed at a paid service, meter it
  per page in `knowledge/ocr.ts` (the user id would need threading through `extractDocument`).
- **Small overshoots that remain by design:** the voice relay reports every 5 s (a call can run ≤5 s
  past the limit); the agent proxy's output cap has a 2,048-token floor; TTS/STT/code search check but
  do not reserve (rate limits bound the burst); a utility walk admitted with budget left may finish a
  few cents past it. Each is bounded to cents.
- **Topic monitors now cost the user money** (~$0.02 per fused query, every 2 minutes ⇒ up to ~$15/day
  per monitor with all four keyed engines). They are now billed and stop at the limit, but the cadence
  is a product decision worth revisiting (e.g. 30 minutes, or the cheapest single engine).
- **Image generation on FREE/LITE** is allowed for one $0.01 model (catalog `minPlan: FREE`). It is
  metered; whether it should exist on Free is a product call.
