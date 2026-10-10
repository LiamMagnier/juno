# Cost engineering

Branch `pricing/cost`, October 2026. Lowering what a turn costs without
making anything worse for the person sending it, and billing people what the
provider actually charged. Five changes:

1. **Prompt caching:** an audit of every chat path, plus fixes for the two
   things that broke the cache on real turns.
2. **Billing at real cost:** cache hits billed at each lab's published rate,
   and batch calls at the batch price.
3. **Context trimming:** a token budget on history, plus a stored rolling
   summary of everything older.
4. **Batch APIs** for memory dreaming, at 50% off.
5. **Auto routing:** checked against the catalogue and pinned by tests.

Two environment flags were added. Both default to on:

| Flag | Default | Off means |
| --- | --- | --- |
| `BATCH_API_ENABLED` | on | The dreamer calls models synchronously, as before. |
| `HISTORY_COMPACTION_ENABLED` | on | Only the count-based history window applies, as before: no token budget and no summary. |

Schema: the hand-written migration
`prisma/migrations/20261004130000_cost_engineering` adds the
`Conversation.historySummary*` columns and the `BatchJob` table, and
`schema.prisma` matches it. **It must be applied before deploy**, and the
Prisma client regenerated. The new code reads and writes these columns with
raw SQL, so it typechecks and runs without the client being regenerated, but
the columns and the table must exist.

---

## 1. Prompt-caching audit

Providers cache a prompt **prefix**, in the order tools, then system, then
messages. A byte that changes inside the prefix invalidates everything after
it. The checks below cover the request each chat path builds.

| # | Path | What was there | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | **All providers, chat route.** Per-user system tier | Memory notes ranked against the latest message (`getMemoryProfile().recent`), project extracts retrieved for the question, and attached-document extracts, all in the system prompt's per-user tier | **Changed almost every turn.** A memory ranking or a retrieval that came out differently invalidated the system tail **and the whole conversation after it**. That re-sent the full history at the input price, and on Anthropic re-wrote the tail at the 1h write premium (2x). | **Fixed.** These now ride a per-generation tail after the newest user message (`src/lib/chat/turn-context-tail.ts`). The summary, project instructions, style, custom instructions and language stay cached. |
| 2 | **Anthropic chat** (`src/lib/anthropic.ts`): conversation breakpoint in tool loops | One marker on the user's message, placed once before the loop | Each tool round re-sent every earlier round's `tool_use`/`tool_result` blocks as fresh input. A 6-round connector turn paid for round 1's results 5 times. | **Fixed.** Every request carries one marker on its newest block (`withConversationCacheBreakpoint`, `src/lib/anthropic-cache.ts`), so each round reads the previous one from cache. It never mutates the loop's history. |
| 3 | **Anthropic chat**: per-turn context and the marker | `appendToLastUserTurn` concatenated named references into the user's text, and the marker landed after them | A cache entry that ends in per-turn text can never be read by the next turn. | **Fixed.** `MessageForModel.volatileTail` makes the adapter send the tail as its own trailing block, with the marker in front of it. |
| 4 | **Anthropic tool-loop adapter** (`src/lib/llm/anthropic-loop.ts`, not yet wired to production) | The same pinned marker | Same as #2 | **Fixed** the same way, and the existing tests were updated. |
| 5 | **Anthropic**: tools, system and date | Last tool at 1h, two system tiers at 1h, date block after the breakpoints, conversation marker at 5m | Correct. Uses all 4 breakpoints and respects the rule that 1h entries come before 5m ones. | OK |
| 6 | **Anthropic**: conversation marker TTL | 5m | Replies more than 5 minutes apart re-write the history at 1.25x. A 1h marker would cost 2x on every write. | **Not changed.** Whether it pays depends on reply gaps. Measure it before switching (see §6). |
| 7 | **OpenAI Chat Completions / Responses** (`openai-compat.ts`, `openai-responses.ts`, `openai-prompt-cache.ts`) | `prompt_cache_key` = conversation id (`private-<user>` in private mode). Explicit system breakpoint and `prompt_cache_options` (30m) on GPT-5.6+, 24h retention on older models | 24h retention was matched by substring, so gpt-5.4-mini/-nano/-pro, gpt-5.2-pro, gpt-5.3-codex and gpt-5-mini/-nano/-pro got a field OpenAI does not document for them. The date sits before the newest user turn, so each turn re-reads one exchange uncached. | **Fixed (Oct 10):** retention only on OpenAI's documented list (gpt-5.5(-pro), 5.4, 5.2, the 5.1 family, gpt-5, gpt-5-codex, gpt-4.1). |
| 8 | **Gemini native** (`gemini.ts`, `gemini-core.ts`) | Implicit caching is automatic (nothing to send). `systemInstruction` holds the system prompt. The date goes in before the newest user turn | Correct apart from #1. | OK (#1 fixed); unchanged Oct 10 |
| 9 | **OpenAI-compatible labs and other Responses hosts** (GLM, Kimi, DeepSeek, Qwen, MiniMax, Mistral, xAI, Meta) | Automatic prefix caching. Mistral gets `prompt_cache_key` (opt-in on its side). xAI gets the `x-grok-conv-id` header on Chat Completions | Every Grok model routes to xAI's **Responses** API, which had no cache routing at all (the header is compat-only). Meta got no key. Qwen's explicit cache (10% hits on 3.7 Plus vs 20% implicit) was never asked for. | **Fixed (Oct 10):** `prompt_cache_key` on xAI Responses (`openai-responses.ts`, `llm/responses-loop.ts`) and on Meta (compat and Responses, plus `prompt_cache_retention: "24h"` on Responses). qwen3.7-plus, qwen3.8-max and qwen3.8-flash send `cache_control` on the system prompt, on the message before the per-request date, and on the newest message in a tool round (`withQwenCacheMarkers`). Not yet in the unwired `llm/compat-loop.ts`. |
| 10 | **History window** (`chat/context-assembly.ts`) | Block-anchored (`HISTORY_STEP` = 8). Binary attachments age out in blocks. Each row's history notes are a function of that row alone | Correct: stable for 4 turns at a time. | OK, extended by §3 |
| 11 | Project reference files | First user turn of the window | Stable until the window jumps. | OK |
| 12 | Agent block (system tail) | The agent's goals, notes and the status of its last 5 tasks | Changes only when a task finishes or a note is added. | Acceptable |
| 13 | Regenerate instruction | Appended to the system prompt on a regenerate | Only on that turn. | Acceptable |
| 14 | Deep research synthesis | The research corpus is appended to the system prompt for that turn | It busts the conversation cache on research turns. These are one-off turns, the corpus is the turn's own content, and research is another lane's work. | Not changed (noted) |
| 15 | Tool definitions | Derived from the turn's connectors and toggles, in a deterministic order | Change only when the user changes connectors or attachments arrive. | OK |
| 16 | Utility prompts (titles, memory, moderation, research planner/brief/clarify) | `runUtilityPrompt` and research's `utilityCompletion` call `streamChat`, which on Anthropic always wrote a 1h system marker and a 5m message marker | Each is sent once, so every write that cleared the minimum size was a premium (2x / 1.25x) nobody read. | **Fixed (Oct 10):** `streamChat({ promptCache: "none" })` sends no markers (the default for both helpers). Multi-chunk memory extraction reuses one per-user system prompt across chunks, so it passes `"short"`: one 5m marker on the system prompt only. Both now bill the cache counters they get back. |
| 17 | **Research worker** (`research/agents/worker.ts`, `worker-loop.ts`) | No markers on Anthropic, and old tool results elided one more on every step | Dozens of calls per worker, each re-sending the whole transcript at full price; and elision rewrote the middle of the transcript every step, so even an automatic prefix cache missed from there on. Billing read only input/output, so cache reads and writes were never priced. | **Fixed (Oct 10):** markers on the last tool, the system block and the newest message (5m, moved every call). Elision jumps `ELIDE_STEP` (4) results at a time, still within the character cap, so the prefix holds between jumps. Cache reads and 5m/1h writes (Anthropic) and `cached_tokens` (compat) are billed. |
| 18 | **Research lead and writer, design edit** | Default chat markers (1h system, 5m message), no `cacheKey` | The lead's per-round prompt and the writer's one-off request paid unread writes; the writer re-wrote its whole corpus at 1h for a revision that changes only the tail | **Fixed (Oct 10):** lead `"short"` (its static system prompt only), writer `"short"` with the corpus as its own tier (`systemStablePrefix`) so the citation revision reads it; design edit `"short"`. Keys: `research-<runId>`, `design-<artifactId>`. All bill their cache counters. |
| 19 | **Mac Code** (`native/Packages/JunoCode`, `PromptCacheWire.swift`) | Request bodies encoded from Swift dictionaries | Key order changed between requests, so tool schemas and replayed inputs differed byte for byte and every prefix cache missed from the first tool on. | **Fixed (Oct 10, Mac lane):** sorted-key encoding, the session id as `prompt_cache_key` / `x-grok-conv-id` per lab; the agent proxy forwards `x-grok-conv-id`. |
| 20 | **Runner** (`runner/agent-core/src/providers/prompt-cache.ts`) | No cache key on the OpenAI-shaped wires | Same routing gaps as #9 inside Code sessions. | **Fixed (Oct 10, runner lane):** per-lab plan mirroring `openai-prompt-cache.ts` (key, GPT-5.6 breakpoint, retention, Qwen markers, sorted tools). Its retention list still matches by substring; align it with #7. |
| 21 | **Code proxy thinking budget** (`agent-proxy.ts` `capOutputTokens`) | A budget near its limit lowered `budget_tokens` to `cap − 1024` on every request | The cap shrinks as the account spends, and a changed thinking budget invalidates Anthropic's cached messages, so a long session re-wrote its history on each request. | **Fixed (Oct 10):** lowered in power-of-two steps (min 1,024, `steppedThinkingBudget`). |

### Cost ledger: are cache reads and writes billed at the real discounted rate?

| Provider | How usage is read | Rate before | Rate now | Source |
| --- | --- | --- | --- | --- |
| Anthropic | `input_tokens` excludes cache. `cache_read_input_tokens`, and `cache_creation.ephemeral_5m/1h` split by TTL | Reads 0.1x (0.05x Opus 5.5, 0.025x Fable/Mythos 5.1). Writes 1.25x (5m) and 2x (1h). An unsplit write is billed at 1h (conservative) | Unchanged, already correct | Anthropic pricing page |
| OpenAI | `prompt_tokens` includes `cached_tokens` **and** `cache_write_tokens` (GPT-5.6+) | Reads 0.1x (0.05x 6.1 Sol). Writes 1.25x on 5.6+, but written tokens were also left in fresh input, so they billed 2.25x | **Fresh input = prompt − read − written** (Oct 10), for every compat dialect | developers.openai.com |
| Google Gemini | `promptTokenCount` includes `cachedContentTokenCount` | **0.1x only on 3.5–3.8 Flash; 0.25x for 3.1 Pro, 3/3.1 Flash(-Lite) and 2.5 Pro** | **0.1x on every Gemini model** (2.5x over-billing removed) | ai.google.dev pricing, 2026-10-04 |
| DeepSeek | `prompt_cache_hit_tokens` inside `prompt_tokens` | **0.25x** | **0.02x V4.1 Flash, 0.033x V4 Pro** (about 12x over-billing removed) | api-docs.deepseek.com, 2026-10-04 |
| Moonshot Kimi | Top-level `cached_tokens` | **0.25x** | **0.1x K3, 0.2x K2.7 Code (incl. High-Speed), 0.168x K2.6** | platform.kimi.ai, 2026-10-04 |
| Z.ai GLM, xAI, Meta, MiMo | Per dialect | Per-model columns | Unchanged, already correct | — |
| Qwen | `prompt_tokens_details.cached_tokens`, and `cache_creation_input_tokens` for explicit writes (both inside `prompt_tokens`; writes were not read before) | 0.25x | **qwen3.7-plus 0.1x hits, 1.25x explicit writes.** qwen3.8-max/flash: 1.25x writes, hits stay 0.25x (the doc excludes them from 10%, console rate unverified). Implicit-only models stay 0.25x (doc's "most models 20%" unverified per model) | alibabacloud.com model-studio/context-cache, 2026-10-10 |
| MiniMax | Compat `cached_tokens` | 0.25x | **M3 0.2x, M2.7 0.2x, M2.7-highspeed 0.1x, M2.5 0.1x (highspeed 0.05x); M2.x writes $0.375 (1.25x / 0.625x highspeed).** M3.1 Flash Preview unpriced, stays 0.25x | platform.minimax.io pricing-paygo, 2026-10-10 |
| Mistral, LongCat | Compat `cached_tokens` | 0.25x | **Mistral 0.1x, LongCat 0.02x** | docs.mistral.ai prompt caching; longcat.chat/platform/docs/pricing (audit, 2026-10-10) |
| Any provider, Batch API | Batch result usage | — | **`batch: true` on `recordSpend` / `estimateGenerationCostUsd` bills tokens at `batchPriceMultiplier` (0.5 for Anthropic, OpenAI and Google). Tool fees are never discounted.** It is ignored for a provider with no batch price, so the flag cannot invent a discount. | Provider batch docs |

This is billing people at real cost: a cache hit counts against their budget at
what it actually cost, and a batch call at half.

**Ledger fix (Oct 10).** The chat turn and design-edit ledger rows passed
`totalInput` (fresh + cache) as `promptTokens` alongside the cache counters, and
`recordSpend` re-prices from those and keeps the higher figure. Every cached
token was therefore billed at the full input rate *and* at its cache rate: a
cached Sonnet turn landed at about 6x its real cost, so caching saved users
nothing. They now pass `billedPromptTokens` (the provider's own convention).
The message's displayed input total is unchanged.

---

## 2. Context trimming

The code is in `src/lib/chat/history-compaction.ts` (pure, 14 tests) and
`src/lib/chat/history-summary-store.ts` (database half).

- **Token budget.** The existing 24–31-message window (block-anchored) is also
  held to **min(60K tokens, 40% of the model's window)**, with a floor of 8K.
  When it is over budget, the oldest messages are dropped in whole
  `HISTORY_STEP` (8-message) blocks, and the cap on the drop is itself
  step-aligned. The cut therefore moves in large steps, never once per turn.
  The window always opens on a USER message.
- **Never dropped:**
  - the system prompt, which is not history;
  - the newest 8 messages;
  - the newest user message carrying files, if it is among the last 12;
  - tool-call/result pairs. Persisted history carries no raw tool blocks:
    each row's tool activity is a note inside its own text, so a pair cannot
    be split.
- **Rolling summary.** Everything before the window is shown as one summary,
  prepended to the window's first user turn. The cheapest eligible utility
  model writes it (`runUtilityPrompt({ cheapestFirst: true })`, purpose
  `history_summary`), within the account's background-provider policy, and it
  is billed as spend kind `utility`. It is stored encrypted on the
  conversation along with the count it covers and the id of the first message
  it does not cover.
  - It is recomputed only when the window's start moves, and incrementally:
    the old summary plus the messages that just left the window.
  - Between jumps its bytes are identical, so it reads from cache like the
    rest of the prefix.
  - A summary update that fails or takes more than 8s leaves the stored
    summary in place (still a true summary of what it covers). If the update
    finishes later, it is saved for the next turn.
  - If history changes under it (deleted or regenerated messages), the
    boundary check fails and it is rebuilt from the beginning.
- Private mode (history supplied by the client, never stored) keeps its
  24-message cap and gets no summary.

## 3. Batch APIs

The code is in `src/lib/batch/*` (pure rules and wire shapes in `plan.ts` and
`parse.ts`, 15 tests). It runs on the memory dreamer's existing 10-minute tick
in `scripts/memory-dreamer.ts`, which runs inside `juno-sweepers`.

- **Scope.** Memory dreaming: distilling past chats, plus the account and
  project memory-summary rebuilds that follow. Research and chat are excluded,
  because people watch those. Scheduled tasks are excluded because their
  output is due at a time.
- **Mechanism.** The dream pass gets a `UtilityLlm` layer that does three
  things:
  1. If a batch that has ended holds the answer (keyed by a hash of the
     prompt), it returns that answer and the pipeline applies it like any
     reply.
  2. If there is no answer yet, it queues the prompt and returns `null`. The
     pipeline already treats `null` as "retry later": no chunk is marked read
     and nothing is half-applied.
  3. If the prompt cannot be batched, it calls the ordinary synchronous walk.
- **Each tick:**
  1. Running batches are polled.
  2. Ended batches are **billed once per request at the batch price**, using
     an idempotency key `batch:<job>:<custom_id>`. They are billed whether or
     not the answer is used, because the provider charged for it either way.
     The answers are stored encrypted.
  3. Accounts with answers waiting are visited, along with those that have
     history to read.
  4. Each pass's queued prompts go out as one batch per model, capped at 50
     requests.
- **Idempotent apply.** Extraction marks each chunk read as it saves, and
  `saveCandidates` de-duplicates, so an answer applied twice learns nothing
  twice. Ledger rows are unique per request.
- **Fallbacks:**
  - `BATCH_API_ENABLED=false` turns batching off.
  - No batch-capable provider (Anthropic or OpenAI with a configured key) is
    permitted by the account's background policy.
  - Submission fails: the job is recorded as failed and the pass re-runs
    synchronously.
  - A batch fails, expires, or is still unfinished after 26h.
  - **Circuit breaker:** after 3 settled batches that all failed or whose
    answers went unused, the account's work goes synchronous.
- **Model.** The cheapest batch-capable utility model the policy permits, for
  example Claude Haiku 4.5 or GPT-6 Luna.
- **Not batched yet:** agent reflection (`scripts/agent-reflector.ts`). It
  stamps its reflection time even when no model answers, so a deferred answer
  would be lost. It is the next candidate once that stamp moves after a
  successful reply. The Gemini Batch API (also 50%) is a second follow-up.
  Today Gemini-only accounts dream synchronously.

## 4. Auto routing

`src/lib/auto-model.ts` already ranks capable models cheapest first, by the
average request cost of each model at its own rates. The new
`tests/auto-model-cheapest.test.ts` pins three things, with every provider
configured, on the FREE and PRO plans and across 4 prompts:

- no current, callable model that clears the prompt's intelligence floor is
  cheaper than Auto's pick;
- an everyday question goes to a cost-1 model when the plan has one;
- an easy question never costs more than a hard one.

Today Auto sends "hi there" to GLM-4.7-Flash (free on Z.ai) at Instant, and a
multi-step refactor to GPT-6 Luna at high effort.

The low-budget behaviour ("prefer cost-1 below 10% of budget") belongs to
another lane and was not touched.

---

## 5. Impact estimate

These are estimates from stated assumptions, not measurements.

**Profile: a busy Pro user (€20 plan, €11 model budget).**

- 300 chat turns a month on a Sonnet-5.5-class model: $2 / $10 per MTok, cache
  read $0.20, 5m write $2.50, 1h write $4.
- A 6K-token system prompt: a 5K shared head and a 1K per-user tail.
- About 12K tokens of history and 800 tokens of output per turn.
- 30% of turns have ranked memory notes or retrieved extracts.
- 20% of turns use tools, at 4 requests a turn with 3K tokens of results per
  round.
- 10% of turns are in long chats whose window weighs about 100K tokens.
- 40 dreaming calls a month.

| Change | Turns affected | Before ($/turn) | After ($/turn) | Monthly before → after | Notes |
| --- | --- | --- | --- | --- | --- |
| Baseline cached turn | 300 | ≈0.017 | ≈0.017 | $5.10 → $5.10 | 5K read + 12K history read + 1.5K new + 800 out |
| Volatile context out of system (#1) | 90 | +0.034 (re-write 12K history at 1.25x + 1K tail at 2x) | +0.005 (1.5K tail fresh + read) | $3.06 → $0.45 | The biggest lever: −$2.6 |
| Tool-loop marker (#2) | 60 | +0.036 (18K of earlier results re-sent fresh) | +0.024 (9K written once, then read) | $2.16 → $1.44 | Bigger on 6-round connector turns (about −50%) |
| Token budget on history | 30 | +0.10 avg (100K window; half the turns miss the 5m TTL and re-write at 1.25x) | +0.06 (60K window) + about $0.001 of summary per jump | $3.00 → $1.80 | Also stops silent context loss: dropped turns used to vanish, now they are summarised |
| Batch dreaming | 40 calls | $0.005 | $0.0025 | $0.20 → $0.10 | Small: dreaming is already cheap |
| **Total** | | | | **≈ $13.5 → ≈ $8.9 (−34%)** | Before, this profile ran out of a Pro budget; after, it fits with room |

The billing corrections (§1 ledger) do not change what Alevr pays. They stop
over-charging people's budgets. Over a month at 15K cached tokens a turn, that
is:

- a Gemini 3.1 Pro user: about $1.35 less charged (0.25x → 0.1x on cache hits);
- a DeepSeek V4.1 Flash user: cached input is now charged at 1/12 of what it
  was.

The margin effect: plan prices are fixed and budgets are spend caps, so every
dollar saved per turn is margin on users below their cap. For users at their
cap, it is headroom: they do more for the same plan, which is the fairness
half of the brief.

## 6. Verify after deploy

- **Cache hit ratio per provider:** `ApiSpend` rows do not store cache tokens.
  Read `Message.cacheReadTokens` / `cacheWriteTokens` (the chat usage columns)
  for chat turns, before and after. The expectation: the cache-read share of
  input on Anthropic turns that carry memory notes rises from about 30% to
  over 80%.
- **Summary churn:** the number of `historySummaryAt` updates per long
  conversation should be about one per 4 turns at most.
- **Batch health:** `BatchJob` rows by status, and how far `matchedCount` falls
  short of `requestCount` (unused answers are billed waste). If many accounts
  trip the breaker, the prompt keys are moving between submit and apply.
- **Conversation marker TTL (#6):** with the cache columns above, compare the
  history re-write rate against the reply gap before trying `ttl: "1h"`.
