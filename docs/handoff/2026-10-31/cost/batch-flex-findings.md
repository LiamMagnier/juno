# Non-urgent work: Batch / Flex / deferred-call findings

Scope: which Alevr background jobs can move to cheaper processing lanes. The lanes are Anthropic Message Batches, the OpenAI Batch API and `service_tier: "flex"`, and the Gemini Batch API and Flex inference. The other levers are coalescing duplicate background calls and making the remaining calls cheaper to repeat.

Hard constraints from the owner: answer quality stays the same, and the user-chosen model stays the same. Every lane below keeps the same model. Utility jobs keep the same utility model that `utilityModelCandidates()` already picks for them (Haiku 5.5, GPT-6 Luna, Gemini 3.5 Flash-Lite and so on).

Repo state: `e532983ea` (2026-10-31). Read-only review. All figures are estimates from stated assumptions, not production measurements. The ledger cannot split utility spend by job today (see M0).

---

## 0. Summary

| ID | Opportunity | Saving on the call site | Saving on total spend (profiles §4) | Quality risk |
|---|---|---|---|---|
| BF-1 | Fold the after-turn memory extraction (chat + voice) into the idle-time dreamer, so one call reads a whole session in a batch, plus an "extract-on-switch" guard | −81 % (Anthropic/OpenAI/Gemini lanes); −62 % on providers with no batch lane (stock Qwen default) | A 0.5 % · B 1.6 % · **C ≈ 6 %** | low–medium |
| BF-2 | Stop re-queuing summary rebuilds on every dream round of a backfill: rebuild once when nothing is pending, and give the rebuild a stable batch key | −24 % to −56 % of dreaming spend during multi-round backfills; also removes orphaned (billed, unused) batch answers | ≈ 0 for steady-state accounts; material only for imports/migrations | low |
| BF-3 | Gemini lane: Gemini Flex (synchronous, 50 %) for background utility, plus Gemini Batch for dreaming. Gemini-policy accounts get no discount at all today | −50 % on every Gemini background call that BF-1/BF-4/BF-6 move | B up to 3.8 % (with BF-1/BF-4) | low |
| BF-4 | Agent reflection from the sweep goes through Batch. This needs two fixes: the claim-before-call stamp, and a prompt key that holds still | −50 % of reflection spend | A 0.4 % · B 1.4 % per proactive agent | low |
| BF-5 | Unattended Work runs (`origin` schedule/trigger, Code autofix) use OpenAI/Gemini Flex per request, with a standard-tier fallback and a deadline | up to −50 % of those runs' token spend on flex-eligible models | e.g. one daily GPT-6 Sol routine: $6.91 → $3.46/mo | low–medium (latency; eligible models unverified) |
| BF-6 | Store UI translations durably and pre-warm the catalog through Batch. Today they live only in process memory and are re-bought after every restart | ≈ −90 to −97 % of the i18n call site (platform cost) | operator: ≈ $3.5 → ≈ $0.3/mo at 3 locales | none |
| BF-7 | Provider-agnostic deferred-call queue (design, §6). Generalises `src/lib/batch/*` from "dreaming only" to lanes × budgets × fallbacks, deletes batch payloads at the provider, and bills by served tier | enabler for BF-1…BF-6 | — | none by itself |
| BF-8 | Prompt caching inside batches: a 1h `cache_control` on the per-user extraction system prompt shared by a batch's chunks | −4 % to −13 % of batched extraction input | ≈ 0 | none |
| BF-9 | Quality-only live evals (memory bench live, research-citation eval) through Batch | −50 % of operator eval spend | operator only | none (latency evals stay sync) |
| M0 | Prerequisite: a `purpose`/`label` and a `lane`/`servedTier` on every ApiSpend row and `llm.request` record | — | — | — |

The headline is that batch and flex are a small lever on total spend for frontier-model chat users. For them, background utility work is about 3 % of spend, because chat on Sonnet/GPT-Sol dominates. They are a large lever in three places:

- **Accounts on the stock default model.** `DEFAULT_MODEL = "qwen:qwen3.8-flash"` (`src/lib/models.ts:1138`, `prisma/schema.prisma:535`). Here background work is about **46 % of spend**: chat is so cheap that per-turn extraction, consolidation, moderation and follow-ups rival it.
- **Gemini-policy accounts.** Their utility model costs 3× input and 5× output versus Haiku 5.5, and they get **no** batch discount today.
- **Unattended agent runs on frontier OpenAI/Gemini models**, where flex halves the cost of real money.

The biggest single change in this dimension is BF-1, and BF-1 is coalescing, not batching: one call per session instead of one per turn.

---

## 1. What happens today

### 1.1 Background model calls, and which lane each one uses

| Job | Where | Trigger and frequency | Model | Lane today | Who waits |
|---|---|---|---|---|---|
| Memory extraction, after each chat turn | `src/lib/chat/turn/finalize.ts:169-173` → `extractConversationMemory` `src/lib/memory.ts:1515`; call at `memory.ts:1669-1685` (maxTokens 500, `promptCache: "short"` only when >1 chunk) | **every turn** with an answer (`chat/post-processing.ts:35-40`) | utility walk (Haiku 5.5 / GPT-6 Luna / Gemini 3.5 Flash-Lite / qwen3.8-omni-flash …) | synchronous, standard tier | nobody directly; inside `after()` |
| Account summary rebuild | `finalize.ts:174-180` → `maybeConsolidate` `memory.ts:2557`; call `memory.ts:2455` (maxTokens 1400) | every turn, throttled to ≥ 5 min between rebuilds (`memory-lifecycle.ts:2019`) whenever facts changed | utility walk | sync | nobody; newer facts are injected as notes (`coveredBySummary`, `memory-lifecycle.ts:2079-2089`) |
| Project summary rebuild | `finalize.ts:181-185`; call `memory.ts:2725` (maxTokens 1000) | every project-chat turn, same throttle | utility walk | sync | nobody |
| Voice-call memory | `src/app/api/voice/transcript/route.ts:73-95` | after each saved voice call | utility walk | sync | nobody |
| Memory dreaming (backfill, re-reads, summary rebuilds) | `scripts/memory-dreamer.ts:30-87`, `src/lib/memory-dreamer.ts:110-231`, `src/lib/batch/*` | 10-min tick (`memory-dreaming.ts:33`), 5 accounts/tick (`:37`), 6 conversations/account in batch mode (`:46`) | cheapest **batch-capable** utility model the policy permits (`batch/dream.ts:123-132`) | **Batch, Anthropic + OpenAI only** (`batch/plan.ts:39`); everything else is sync | nobody |
| Agent reflection | `scripts/agent-reflector.ts`, `src/lib/agents/reflect.ts:146-176` (maxTokens 900) | every 6 h per proactive agent (`agents/domain.ts:321`); sweep 8/tick, 2/account (`reflect-sweep.ts:33-39`) | utility walk | sync; **stamps `lastReflectedAt` before the call** (`reflect.ts:90-99`), so a deferred answer would be lost | nobody (sweep); the person (page/button origin) |
| UI translation | `src/app/api/i18n/translations/route.ts:127-170` (maxTokens 6000, 30 ids/request `:10`) | every cache miss; the cache is a **process-memory `Map`** (`:12-15`), so every restart/deploy empties it | utility walk, `any_allowed_provider` | sync | the visitor (the UI shows English until it lands) |
| Moderation classifier | `src/lib/moderation-ai.ts:227` | every screened turn | utility walk | sync | safety pipeline |
| Titles, follow-up pills | `src/lib/titles.ts:91`, `src/app/api/chat/follow-ups/route.ts:162` | per chat / per turn | utility walk | sync | the user |
| History-compaction summary | `src/lib/chat/history-summary-store.ts:126` | when the window jumps (~1 per 4+ turns in long chats), 8 s cap | cheapest utility | sync | the user's next turn |
| Research citation judge | `src/lib/research/claims.ts:207`, run from `finalize.ts:92-160` | per research turn | utility walk | sync | the user (audit footer, repaired report) |
| Research workers, lead, writer | `src/lib/research/agents/*` | per run (durable, pushes `research_completed`, `research/stages/context.ts:243-275`) | workers prefer Anthropic Haiku (`research/agents/worker.ts:90-118`); lead = most capable | sync tool loops | the user (often comes back later) |
| Hosted Work runs, triggers, Code autofix | `scripts/work-runner.ts` → `runner/agent-core/src/providers/*` | schedules, topic triggers (2 min), CI webhooks | the run's model | sync; tier only ever `priority` (`openai-compat.ts:421`, `llm/compat-loop.ts:481`) | nobody for `origin` schedule/trigger (`src/lib/work/notifications.ts:71-73`) |
| Embeddings | `src/lib/knowledge/embed.ts:180`, `memory.ts:845-899` | per fact write and per retrieval query | text-embedding-3-small etc. | sync | the turn (4–8 s caps) |
| Live evals and benches | `scripts/eval-juno.ts:22-56`, `scripts/memory-bench.ts:50-56` | manual, by the operator | chosen | sync | the operator |

No model calls exist in `memory-recap.ts`, `memory-project-summary.ts`, `work/digests.ts` (crypto digests), `agents/goal-runner.ts` or `artifact-maintenance`. There are no LLM "notification digests" today.

### 1.2 The existing Batch layer (good, but narrow)

`src/lib/batch/{plan,parse,providers,store,dream}.ts` (documented in `docs/pricing/COST_ENGINEERING.md` §3):

- It is a `UtilityLlm` that answers from ended batches by prompt key, queues misses (returns `null`, which the memory pipeline already treats as "retry later") or falls back to the sync walk. It has a breaker after 3 failed or unused batches (`plan.ts:117-121`), a 26 h stale cutoff (`:100`) and a cap of 50 requests per job (`:98`).
- Each request is billed once at `batchPriceMultiplier` 0.5 for anthropic, openai and google (`src/lib/pricing.ts:894-903`, `:1062-1064`) under the idempotency key `batch:<job>:<custom_id>` (`batch/dream.ts:98-111`).
- **Gaps found:**
  1. Only `memory_dreaming` uses it (`batch/dream.ts:51`).
  2. There is no Google transport, although `pricing.ts` already prices Google batch at 0.5.
  3. It never deletes the provider-side batch or files after download (`batch/providers.ts:294-312`). Anthropic batches are **not ZDR-eligible and keep request and response data for 29 days**, so decrypted user messages persist at the provider.
  4. The prompt key for summary rebuilds hashes the whole user message (`plan.ts:64-69`). That message includes the GitHub repo list sorted by `pushed` (`memory.ts:2259-2270`) and chat digests sorted by `updatedAt` (`memory.ts:2302-2306`), which the dream pass itself rewrites. See BF-2.
  5. No per-job `purpose` reaches the ledger. ApiSpend has `kind` only (`prisma/schema.prisma:1904-1938`), and the request meter's role is inferred from `promptCache` (`src/lib/llm.ts:212`).
- **There is no flex anywhere.** No `service_tier: "flex"`, no flex rate column in `model-rates.generated.ts`, and the agent proxy recognises only `priority` as a served tier (`src/lib/agent-proxy.ts:389, 796, 895, 959`).

---

## 2. Provider rules, verified

| Rule | Value | Source |
|---|---|---|
| Anthropic Message Batches | 50 % off input and output; most batches finish in < 1 h; results come when all are done or at 24 h; expires at 24 h; ≤ 100,000 requests or 256 MB; results kept 29 days; **not ZDR-eligible**; Batches rate limits are separate from Messages; expired requests are not billed | [batch-processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing) (fetched) |
| Anthropic batch + cache | The discounts stack. Cache hits are best effort (30–98 % in practice); the docs recommend the 1 h TTL for shared context in batches; `max_tokens: 0` pre-warm is rejected in batches | same page; [prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (fetched) |
| Anthropic cache pricing | 5 m write 1.25×, 1 h write 2×, read 0.1× (0.05× Opus 5.5 and Sonnet 5.5); minimum cacheable length **512 tokens** for Haiku 5.5, Sonnet 5.5 and Opus 5.5; ≤ 4 breakpoints; 20-position lookback; 1 h entries before 5 m | [prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| Haiku 5.5 prices | $0.10 / $0.50 per MTok (batch $0.05 / $0.25); over 100K-token prompts, $0.50 / $2.50 (batch $0.25 / $1.25). Fast mode is not available on Batch | [pricing](https://platform.claude.com/docs/en/about-claude/pricing) (fetched) |
| Anthropic flex tier | **None.** The only discounted non-urgent lane on Anthropic is Batches (priority/fast are premiums) | [pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| OpenAI Batch | 50 % off; `completion_window` `24h` only; endpoints include `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/completions` (the CLI reference also lists moderations, images and videos) | [batch guide](https://developers.openai.com/api/docs/guides/batch.md), [batches create](https://developers.openai.com/api/reference/cli/resources/batches/methods/create/index.md) (search snippets) |
| OpenAI Flex | `service_tier: "flex"` on Chat Completions **and** Responses; priced at Batch rates (~50 %); slower; `429 Resource Unavailable` **is not billed**; the docs' examples use a 900 s timeout; suggested handling is backoff, or retry at standard tier; beta, and the eligible-model list is on the pricing page | [flex-processing](https://developers.openai.com/api/docs/guides/flex-processing), [pricing](https://developers.openai.com/api/docs/pricing.md), [classmethod test](https://dev.classmethod.jp/en/articles/openai-flex-processing/) (search snippets) |
| Gemini Batch | 50 % off; target turnaround 24 h; JSONL input ≤ 2 GB (secondary sources: jobs expire after 48 h). Whether cache discounts stack is **unverified** | [optimization](https://ai.google.dev/gemini-api/docs/optimization.md.txt), [Google blog](https://developers.googleblog.com/en/scale-your-ai-workloads-batch-mode-gemini-api/) (search snippets) |
| Gemini Flex inference | `service_tier` flex: 50 % off, variable latency, best effort, may be preempted (503); **no server-side fallback** to standard; client timeouts of ≥ 10 min recommended; the response reports the served tier | [flex-inference](https://ai.google.dev/gemini-api/docs/flex-inference), [Google blog](https://blog.google/innovation-and-ai/technology/developers-tools/introducing-flex-and-priority-inference/) (search snippets) |
| Qwen (Model Studio) Batch | OpenAI-compatible file batch at 50 %; model list varies by region (qwen-flash, qwen3.5-flash, qwen3.7-plus …); **no context cache** in batch. Whether qwen3.8-flash / omni-flash are listed is **unverified** | [batch-inference](https://www.alibabacloud.com/help/en/model-studio/batch-inference), [OpenAI-compatible batch](https://www.alibabacloud.com/help/en/model-studio/batch-interfaces-compatible-with-openai) (search snippets) |
| Realtime audio | No batch or flex lane exists; out of scope for this dimension | — |

> **Access caveat.** developers.openai.com, platform.openai.com, ai.google.dev and alibabacloud.com could not be fetched from this session (the network allowlist blocked them), so the OpenAI, Gemini and Qwen rows come from search-result snippets of those official pages. Two items must be checked live before building BF-3 and BF-5: the flex-eligible model list (OpenAI pricing page, flex filter; Gemini flex-inference page), and the exact Gemini request field.

---

## 3. Latency budget per job

The **budget** is how long the answer may take without anyone being worse off. The **hard deadline** is when the queue must stop waiting and fall back.

| Job | Budget | Hard deadline | Lane ladder | Why |
|---|---|---|---|---|
| Chat turn, tool rounds, titles, follow-ups, history summary, research workers/lead/writer, citation judge, realtime voice | 0–8 s | — | standard only | The user is watching. |
| Moderation classifier | ≤ 60 s | 60 s | standard | Safety and bans. Flex would save ≈ $0.02/mo (A) at a safety-latency risk, so it stays as is. |
| Embeddings (fact write, query) | 4–8 s | 8 s | standard | Needed for retrieval; batch would save < $0.001/mo (§7). |
| **Memory extraction of a live session (BF-1)** | session idle (10 min, `memory-dreaming.ts:35`) + ≤ 2 h | 24 h | batch → flex → standard; standard immediately on "extract-on-switch" | The fact is already in the conversation's own history. Explicit "remember this" is saved inline by the chat model's memory tags (`chat/system-prompt.ts:414`), with no utility call. |
| **Account/project summary rebuild (BF-1, BF-2)** | ≤ 2 h after the facts settle | 24 h | batch → flex → standard | Facts newer than the summary are injected individually (`memory-lifecycle.ts:2079-2089`), so a stale summary hides nothing. |
| Dreaming backfill and re-reads | ≤ 24 h | 26 h (`plan.ts:100`) | batch → flex → standard | Already the design. |
| **Agent reflection, sweep origin (BF-4)** | ≤ 6 h (the interval itself) | 6 h | batch → flex → standard; page/button origin stays standard | Ideas arrive as a passive notification (`reflect.ts:273-293`). |
| **Scheduled/trigger Work runs, Code autofix (BF-5)** | per request: min(15 min, time to due − expected remaining steps × p95 step) | routine due time | flex → standard (never batch: tool loops) | The run's result is due at a time, not at a keystroke. |
| **UI catalog pre-translation (BF-6)** | days (offline) | before deploy | batch → standard | Shipped strings, no user content. |
| Live quality evals (BF-9) | hours | 24 h | batch | Not latency evals. |

---

## 4. Cost model used in the arithmetic

These are per-call token assumptions. The prompt shapes come from the code; the sizes are estimates.

- **Extraction, per turn today:** system ≈ 900 tok (instructions plus 40 known facts, `memory-extraction.ts:33-54`) + user message ≈ 300 tok (one or two user messages, each capped at 1,200 chars by `memory.ts:1601`) = **1,200 in / 120 out**.
- **Extraction, coalesced per session (BF-1):** 900 + 5 × 300 = **2,400 in / 200 out**. Assumes 5 turns per session.
- **Summary rebuild:** **6,000 in / 700 out** (facts budget + 40 digests + projects + GitHub lines; 1,400 max output).
- **Reflection:** **3,000 in / 600 out**.
- **Dream chunk:** **3,900 in / 200 out** (up to 12K chars + system).
- **Rates, $/MTok in/out (batch/flex = ×0.5):**
  - Haiku 5.5: 0.10/0.50.
  - Gemini 3.5 Flash-Lite: 0.30/2.50.
  - qwen3.8-omni-flash: 0.15/0.47 (Juno's own estimate in `pricing.ts`; no official row).
  - These are the first utility candidates per provider (computed with `utilityModelCandidates()` logic against `MODEL_LIST`: Anthropic → haiku-5-5, OpenAI → gpt-6-luna, Google → gemini-3.5-flash-lite, Qwen → qwen3.8-omni-flash).

Usage profiles, per month:

- **A**, Anthropic Pro user (`COST_ENGINEERING.md` §5): 300 turns, 60 sessions, Sonnet 5.5 chat ≈ $8.90 after the caching work. Utility runs on Haiku 5.5.
- **B**, Gemini-policy user: same usage, chat ≈ $8.90 (Gemini 3.1 Pro has similar rates). Utility runs on Gemini 3.5 Flash-Lite.
- **C**, stock-default user (qwen3.8-flash): same usage. Chat ≈ 300 × ($0.00064 cached input + $0.00023 fresh + $0.00038 output) ≈ **$0.37**. Utility runs on qwen3.8-omni-flash.
- **Always-sync utility per profile:** moderation 300 × (900/40), follow-ups 300 × (1,500/80), titles 60 × (400/20), history summary 30 × (6,000/500), dreaming 40 × (3,900/200).

The calculation, in `probe/calc.py` beside this file, gives:

| Profile | Chat | Utility | Utility share |
|---|---|---|---|
| A (Anthropic) | $8.90 | $0.31 | **3.3 %** |
| B (Gemini) | $8.90 | $1.12 | **11.2 %** |
| C (Qwen default, without agents) | $0.37 | $0.32 | **46 %** |

---

## 5. Findings

### BF-1: Fold after-turn memory extraction into the idle-time (batched) dreamer

**Today.** `finalize.ts:172` runs `extractConversationMemory` after **every** turn that produced an answer. Each call re-sends the ~900-token per-user system prompt (40 known facts) to read ~300 tokens of new user text, with up to 12 facts and a digest out. A project turn adds `maybeConsolidateProject` (`finalize.ts:184`). Voice calls do the same (`voice/transcript/route.ts:88-90`). The dreamer would read exactly those messages anyway once the account is idle: `findAccountsToDream` selects conversations whose `lastMessageAt > processedAt` (`memory-dreamer.ts:50-68`).

**Opportunity.** Stop the per-turn extraction call and let the dreamer read the session as one chunk when the account goes idle. That is one call per session instead of one per turn, through Batch where the policy's provider has a batch lane.

**Arithmetic (per month).**

| | Today (300 calls) | After (60 coalesced calls) | Saving |
|---|---|---|---|
| A, Haiku 5.5 + Batch | 300 × (1,200 × 0.10 + 120 × 0.50)/1e6 = **$0.0540** | 60 × (2,400 × 0.05 + 200 × 0.25)/1e6 = **$0.0102** | $0.0438 (**−81 %** of the site, **0.48 %** of $9.21 total) |
| B, Gemini Flash-Lite + BF-3 lane | **$0.198** | **$0.0366** | $0.161 (−82 %, **1.6 %** of total); without BF-3, coalescing alone gives −63 % |
| C, Qwen, no batch lane | **$0.0709** | 60 × (2,400 × 0.15 + 200 × 0.47)/1e6 = **$0.0272** | $0.0437 (−62 %, **≈ 6.4 %** of $0.69 total) |

**Quality risk: low–medium.**

- In-conversation behaviour is unchanged, because the model has the history.
- Explicit memories are unchanged: the chat model's own inline tags (`system-prompt.ts:414`) save them with no utility call.
- What changes is the **cross-chat freshness of implicit facts**. A fact said in chat A reaches a *new* chat B after the session idles (10 min) plus batch latency (usually < 1 h). For comparison, Claude's and ChatGPT's chat-history memory are also asynchronous.
- **Mitigation, "extract-on-switch":** when a turn starts in conversation B and the account has another conversation with USER messages newer than its `processedAt`, run that one extraction synchronously (one call, standard tier) before or alongside the turn. That keeps today's freshness exactly where it matters.
- Second-order risk: a coalesced chunk is capped at 12 facts (`EXTRACTION_MAX_FACTS`, `memory-extraction.ts:30`) where five per-turn calls could yield 60. For long fact-dense sessions, cap the coalesced chunk at ~10 messages or raise the cap with chunk length, and measure.

**Implementation sketch.**

- `src/lib/chat/post-processing.ts`: add `extractsMemory: "deferred" | "inline"`. Inline only for private/no-dreamer deployments or when `BATCH_SESSION_MEMORY=0`.
- `src/lib/chat/turn/finalize.ts:169-185`, `src/app/api/voice/transcript/route.ts:88-90`: skip extraction and consolidation when deferred.
- `src/lib/chat/turn/*` (turn start): `extractOnSwitch(userId, conversationId)` → `extractConversationMemory` for at most one other pending conversation, behind `after()` or awaited with a 3 s cap.
- `src/lib/memory-dreamer.ts:50-68`: order eligible accounts by the oldest unprocessed `lastMessageAt` among idle accounts (not `random()`), so recent sessions are read first.
- `memory-dreaming.ts:37`: raise `DREAM_ACCOUNTS_PER_TICK`. Capacity today is 5 accounts / 10 min = 30/h, which caps out at ~700 sessions/day. A queued prompt costs nothing until submitted, so the limit is DB time per tick.

**Measure.**

- (a) `memory-bench` (`src/lib/memory-bench.ts`, `scripts/memory-bench.ts`) in a new "coalesced session" mode against today's per-turn mode. Recall and correction scores must not drop.
- (b) Production: ApiSpend $ for `label = memory/extract` per account-month (needs M0), before and after.
- (c) Exposure: share of new conversations started while another conversation has unprocessed USER messages, and how often extract-on-switch fires.
- (d) Fact lag: P50/P95 of `memoryEntry.createdAt − observedAt` for extractor-sourced rows.

### BF-2: Rebuild summaries once per backfill, with a stable batch key

**Today.** In Batch mode the dream pass offers `maybeConsolidate` **plus up to 3** `maybeConsolidateProject` on every pass (`memory-dreamer.ts:197-210`: "In Batch API mode the summary rebuild is offered on every pass"). During a multi-round backfill (6 conversations per tick, one chunk each per batch round), every round applies new facts and updates digests. The rebuild prompt therefore changes, its key changes (`plan.ts:64-69` hashes system + user message), and the previous round's rebuild answer is **orphaned: billed (`dream.ts:98-111`) and never used.** Two other things move the key without any memory change: the GitHub list is ordered by `pushed` (`memory.ts:2259`), and a 5 s GitHub timeout empties it (`memory.ts:2258-2264`). The sync dreamer has the same pattern: one rebuild per productive 10-minute tick, and the 5-minute throttle does not stop 10-minute ticks.

**Arithmetic, one batched backfill round on Haiku 5.5.**

- Extraction: 6 × (3,900 × 0.05 + 200 × 0.25)/1e6 = $0.00147.
- Rebuilds: 4 × (6,000 × 0.05 + 700 × 0.25)/1e6 = $0.00190.
- Rebuilds are therefore **56 %** of a round's spend (24 % with only the account summary stale). Over an M-round backfill, (M−1)/M of them are wasted. A 200-conversation import is ≈ 34 rounds → ≈ 33 wasted rebuild rounds, so **−24 % to −56 % of dreaming spend** during backfills.
- Steady-state accounts barely change. The money is small on Haiku 5.5 and about 5× larger on Gemini Flash-Lite.

**Quality risk: low.** The summary refreshes once, when the backfill drains (or at most hourly). In between, every newer fact is injected as its own note (`coveredBySummary`). `summarySourcesStillHold` (`memory.ts:2480-2482`) already guards apply-time correctness.

**Implementation sketch.**

- `src/lib/memory-dreamer.ts:201`: in both modes, offer rebuilds only when `pass.remaining === 0`, or when the last rebuild is older than 60 min.
- `src/lib/memory.ts:2267-2270`: sort `githubLines` by name (the summary does not need push order). Digests ordered by `updatedAt` should be keyed on content, not order.
- `src/lib/batch/plan.ts:61`: add a per-label key strategy. `memory/consolidate*` keys on `(label, userId, projectId)` — one in-flight slot — plus a stored encrypted submit-time snapshot. At apply, validate `summarySourcesStillHold(snapshot, current)` instead of requiring an identical prompt, and set `entryCount` to the snapshot count so newer facts stay "uncovered".

**Measure.** `BatchJob` rows split by request label: `matchedCount / requestCount` for `memory/consolidate*` (orphan rate; today expected ≈ 1/M during backfills). Rebuild calls per backfilled account.

### BF-3: A Gemini lane (Flex now, Batch for dreaming)

**Today.** `BATCH_PROVIDERS = ["anthropic", "openai"]` (`batch/plan.ts:39`), so a Gemini-policy account dreams, rebuilds and reflects synchronously at full price. This is the most expensive utility model of the three big labs ($0.30/$2.50 against $0.10/$0.50), and `pricing.ts:898` already knows Google batch is 0.5. `COST_ENGINEERING.md` §3 lists Gemini Batch as an open follow-up.

**Opportunity.**

- **(a) Gemini Flex inference** is synchronous with the same call shape, so it slots into the existing `runUtilityPrompt` walk with no queueing at all. Request `service_tier` flex when the job's budget is ≥ 60 s (dreaming, deferred extraction, rebuilds, reflection, i18n pre-warm). On 503 or preemption, retry once at standard (no server-side fallback exists).
- **(b) Gemini Batch** for the dreamer's queued prompts, as a third transport in `batch/providers.ts`.

**Arithmetic (Profile B, per month).**

- Dreaming: 40 × (3,900 × 0.30 + 200 × 2.50)/1e6 = $0.067 → $0.033 saved.
- Rebuilds: $0.160 → $0.080 saved.
- With BF-1 the extraction saving is $0.161, and with BF-4 reflection saves $0.144.
- Total ≈ $0.42/mo on $10.02, about **3.8–4.2 % of total spend** for Gemini-policy accounts.

**Quality risk: low.** Same model and same prompt. The only cost is latency on jobs that have none to lose. Two conditions: Flex's model list must include gemini-3.5-flash-lite, and if it does not, the lane is skipped (never a model switch). A preempted request must not feed provider health.

**Implementation sketch.**

- `src/lib/gemini-core.ts` / `gemini.ts`: an option `serviceTier?: "flex"` (verify the field name on the flex-inference page), read the served tier from the response, timeout ≥ 600 s for flex.
- `src/lib/llm.ts` `streamChat`: pass it through.
- `src/lib/memory.ts:466-479` (the attempt): accept `lane` from the caller. On flex, use the flex timeout instead of `ATTEMPT_TIMEOUT_MS` (20 s, `memory.ts:259`), and raise the total deadline for `budgetMs ≥ 60 s` jobs.
- `memory.ts:496`: do **not** call `noteLiveProviderFault` for a flex 503/429.
- `src/lib/batch/providers.ts`: a Gemini `submit`/`status`/`results` (inline or JSONL file). `parse.ts`: Gemini result parser.
- `pricing.ts`: `servedTier: "flex"` → multiplier from a new `flex` column in `OfficialRateEntry` (`model-rates.generated.ts:9-25`), filled by `scripts/model-sync`.

**Measure.** Served-tier mix and 503 rate per Gemini utility label (M0). $ per Gemini-policy account-month. P95 completion latency against each job's budget.

### BF-4: Agent reflection from the sweep, through Batch

**Today.** `reflectAgent` claims the agent by stamping `lastReflectedAt = now` **before** calling the model (`reflect.ts:90-99`), then calls `runUtilityPrompt` (maxTokens 900, `:146-176`). A batching layer that returns `null` ("queued") would therefore lose the reflection for 6 h. `COST_ENGINEERING.md` §3 names this as the blocker. A second blocker: the user message carries `today` and relative times (`formatAgentWhen(task.lastActivityAt, now)`, `reflect.ts:160`), so the batch key moves between the queuing tick and the answering tick, and every answer would be orphaned.

**Arithmetic, per proactive agent per month.**

- 120 reflections (4 a day): A, Haiku: 120 × (3,000 × 0.10 + 600 × 0.50)/1e6 = **$0.072** → $0.036 saved (0.39 % of total).
- B, Gemini: $0.288 → $0.144 saved (1.44 %).
- This scales with agents per account.

**Quality risk: low.**

- Only `origin === "sweep"` is deferred.
- The page and "Think it over" button stay synchronous.
- Ideas arrive within the 6 h interval as the passive notification they already are.
- `parseReflection` already de-duplicates against open, dismissed and known items, so a slightly older answer cannot duplicate.

**Implementation sketch.**

- `src/lib/agents/reflect.ts`: on the sweep path, take a *pending* claim (a new `reflectionPendingAt` column, or a `BatchJob` slot keyed by `agentId`). Stamp `lastReflectedAt` only when an answer is applied. Clear a stale pending claim after the 6 h deadline and fall back to sync.
- Key strategy `agent-reflection` = `(label, agentId, slot)` with a stored snapshot of goal, idea and note ids. At apply, re-run `parseReflection` against current state (it drops goals that disappeared, via `goalCount`).
- `scripts/agent-reflector.ts`: poll batches on the same tick as the dreamer (BF-7).

**Measure.** Reflections per agent-day (must stay ≈ 4). Ideas raised per reflection, before and after. Delay from due to applied (P95 ≤ 6 h). Reflection $ (M0).

### BF-5: Flex for unattended Work runs, triggers and Code autofix

**Today.** Work runs with `origin` `schedule` or `trigger` are unattended by definition (`src/lib/work/notifications.ts:71-73`). They run the user's chosen model through `runner/agent-core` providers at standard tier. The only tier Juno ever sets is `priority` (`openai-compat.ts:421`, `llm/compat-loop.ts:481`, `agent-proxy.ts:389`). Batch is the wrong tool for these: a multi-step tool loop would wait up to 24 h per step. Flex keeps **the same model** at roughly batch price, synchronously.

**Arithmetic.** One daily routine on GPT-6 Sol ($2 in / $0.20 cached / $10 out), 8 requests per run, each 9K cached + 6K fresh input and 1.5K output:

- Per request: 9,000 × 0.2 + 6,000 × 2 + 1,500 × 10 = 28,800 µ$ = $0.0288.
- Per run: × 8 = $0.230. Per month (30 runs): **$6.91**.
- Flex at 50 %: **$3.46/month saved per routine**, assuming flex prices cached input at 50 % too (unverified).
- Topic triggers fire every 2 min; each one that escalates to a run is the same math.
- Anthropic-model runs get nothing here (Anthropic has no flex), and Qwen and others get nothing either.

**Quality risk: low–medium.** Output is identical (same model, same request). The risks are latency against the routine's due time, and flex "Resource Unavailable" during peaks. Mitigations:

- Use flex only while `timeToDue > remainingSteps × p95(flex step)`.
- On 429/503 retry at standard (OpenAI does not bill 429s).
- Never use flex for attended origins.
- The eligible-model list is unverified (search results suggest GPT-5.4+ routes; GPT-6 Sol and Luna must be confirmed). Gate it on a `flex` rate column, so a model without one never gets the field.

**Implementation sketch.**

- `scripts/work-runner.ts:595-620`: the `steerable()` wrapper is already the per-request seam. Add a `tiered()` wrapper that sets `request.serviceTier = "flex"` for unattended origins, catches 429/503 and replays at standard.
- `runner/agent-core/src/providers/openai-compat.ts`, `openai-responses.ts`: send `service_tier`. Also the Gemini adapter if Work drives Gemini.
- `src/lib/agent-proxy.ts:389, 796, 895, 959`: treat a served `flex` as a discount tier in billing (today `servedTier` is only compared with `"priority"`).
- `src/lib/spend.ts` `recordWorkRunSpend` and `pricing.ts`: price `flex` from the rates table.
- `src/lib/code-autofix-dispatch.ts`: autofix runs count as unattended.

**Measure.** Per unattended run: served-tier mix, 429/503 count, standard fallbacks, step P95, deadline misses (must be 0), $ per run against the same routine's previous 4 weeks.

### BF-6: Store UI translations durably and pre-warm them through Batch

**Today.**

- The translation cache is a `Map` on `globalThis` (`i18n/translations/route.ts:13-15`). Every deploy or restart empties it, and the catalog is re-bought on demand, 30 ids per call (`:10`), maxTokens 6000, unattributed (`userId: null`).
- The catalog holds **10,788 strings, 365,101 source chars** (`src/lib/i18n-catalog.generated.ts`). As the request payload (`{id: source}`) that is 635,900 chars over 360 requests.
- 19 non-English UI locales (`src/lib/i18n.ts:95-97`). There were 28 merges to main in October, roughly one deploy a day.

**Arithmetic.**

- Full catalog, one locale: ≈ 265K input tokens (payload ≈ 204K at ~3.1 chars/token plus 360 × 170 system) and ≈ 205K output tokens. On Haiku 5.5 that is 0.265 × $0.10 + 0.205 × $0.50 = **$0.129** standard, or **$0.065** batch.
- Today, per month: 30 restarts × k locales × f of the catalog viewed × $0.129. With k = 3, f = 0.3: **$3.48**. With k = 5, f = 0.5: **$9.68**. That is platform money, capped at $5 per day per process by `PLATFORM_UNATTRIBUTED_DAILY_USD`.
- After: a one-time **$1.23** for all 19 locales in batch, plus deltas for new strings. Saving **≈ 90–97 %** of the call site.

**Quality risk: none.** Same model. Translations become stable across restarts, and cold-locale visitors stop seeing English while the walk runs.

**Implementation sketch.**

- A `UiTranslation(locale, id, sourceHash, text)` table, or `public/i18n/<locale>.json` written by a script.
- `route.ts:88-100`: read from it before the `Map`. Write misses through to it.
- `scripts/i18n-prewarm.ts`: diff the catalog against stored `sourceHash`, submit one Batch per locale using the same system prompt and parser, apply results.
- Run it from `deploy.sh` or a nightly sweeper. It falls back to the runtime walk for anything not yet translated.

**Measure.** Daily count and $ of `label = i18n` calls (the unattributed meter in `memory.ts:291` already counts spend). Cache-miss rate per locale after a deploy. Target ≈ 0 misses for catalog strings older than the last pre-warm.

### BF-7: The provider-agnostic deferred-call queue (design, §6)

This is the enabler for BF-1 through BF-6. It saves nothing by itself, and it closes the 29-day provider-retention gap (`batch/providers.ts:294-312` never deletes).

### BF-8: Prompt caching inside batches

**Today.** Batched requests carry no `cache_control` (`batch/parse.ts:43-58`).

**Opportunity.** Chunks for one user and one scope in the same batch share the ~900-token extraction system prompt, which is above Haiku 5.5's 512-token minimum. Mark it with a 1 h `cache_control`, as the Anthropic batch docs recommend.

**Arithmetic, for 6 chunks of 3,900 tokens.**

- First request: +900 × (2 − 1) = +900 token-equivalents (the 1 h write premium).
- Next five: 5 × 900 × 0.9 = 4,050 saved.
- Net 3,150 of 23,400, about **−13 %** of input at a 100 % hit rate, or **−4 %** at the documented 30 % floor.
- Total-spend impact ≈ 0.

**Quality risk: none.**

**Sketch.** `anthropicBatchRequest` sends `system` as a block array with `cache_control: {type: "ephemeral", ttl: "1h"}` when ≥ 2 requests in the job share it. Bill cache counters (already parsed, `parse.ts:91-96`).

**Measure.** `cacheRead` summed over the job's results / system tokens × (n − 1).

### BF-9: Quality-only live evals through Batch

**Today.** `EVAL_LIVE=1` evals and `memory-bench` live call `streamChat` / `runUtilityPrompt` synchronously (`scripts/eval-juno.ts:22-56`, `scripts/memory-bench.ts:50-56`).

**Opportunity.** Benches that grade content, not latency, can inject a batch `UtilityLlm` (the seam already exists) and run at 50 %. `eval-juno` records `latencyMs`, so its latency and router cases stay sync.

**Risk: none.**

**Measure.** Operator spend per eval run.

---

## 6. Design: a provider-agnostic deferred-call queue

This generalises `src/lib/batch/*` from "dreaming via two providers" to **jobs × lanes × budgets × fallbacks**, keeping its two best properties. First, prompts are never stored; only keys, encrypted answers and encrypted apply-time snapshots are. Second, idempotent pull-model apply: the pipeline re-runs and asks the layer for its answer.

### 6.1 Pure rules (no I/O): `src/lib/deferred/lanes.ts`

```ts
export type Lane = "batch" | "flex" | "standard";

export interface JobClass {
  purpose: "memory_session" | "memory_dreaming" | "memory_consolidation"
         | "agent_reflection" | "ui_translation" | "eval" | "work_unattended";
  budgetMs: number;        // §3 "budget"
  hardDeadlineMs: number;  // §3 "hard deadline"
  keyStrategy: "prompt" | "prompt-ignore-system" | "slot";   // BF-2 / BF-4
}

export interface LaneCaps {          // from model-rates.generated.ts
  batch: boolean;                    // provider transport exists AND model listed
  flex: { input: number; output: number } | null;
}

export function chooseLane(budgetMs: number, caps: LaneCaps): Lane {
  if (budgetMs >= 2 * 3_600_000 && caps.batch) return "batch";
  if (budgetMs >= 60_000 && caps.flex) return "flex";
  return "standard";
}

/** What to do when the current lane has not answered by `now`. */
export function nextLane(current: Lane, caps: LaneCaps, msToDeadline: number): Lane | "wait" {
  if (current === "batch") return msToDeadline > 15 * 60_000 ? "wait" : caps.flex ? "flex" : "standard";
  if (current === "flex") return "standard";          // after a 429/503 or a flex timeout
  return "standard";
}
```

### 6.2 Transports: `src/lib/deferred/transports/*`

These replace `batch/providers.ts`, behind one interface:

```ts
interface BatchTransport { submit(model, items): Promise<string>; status(id): Promise<"in_progress"|"ended"|"failed">;
                           results(id): Promise<BatchItemResult[]>; purge(id): Promise<void>; }   // NEW: purge
interface FlexTransport  { call(model, item, { timeoutMs, signal }): Promise<FlexOutcome>; }      // served tier read back
```

| Provider | Batch transport | Flex transport |
|---|---|---|
| Anthropic | Message Batches (exists) | none |
| OpenAI | `/v1/batches` over chat/completions (exists; `/v1/responses` for Responses-only models) | `service_tier: "flex"` |
| Google | Gemini Batch (new) | Gemini Flex (new) |
| Qwen | Model Studio batch (new; **only** for models on its list, never a model swap) | none |
| Others | none | none |

`purge(id)` deletes the batch and its input/output/error files right after `results()` is stored. Anthropic batches are not ZDR-eligible and keep data for 29 days.

### 6.3 Store

Reuse `BatchJob` (`prisma/schema.prisma:1948-1970`, raw SQL in `batch/store.ts`):

- Widen `purpose` to the `JobClass` purposes.
- Add `lane`, `deadlineAt` and `purgedAt`.
- Add a `DeferredSlot(userId, purpose, slotKey, jobId, snapshotEnc, createdAt)` table for the slot-keyed jobs: rebuilds and reflection, whose prompt legitimately drifts between queue and apply.
- The breaker becomes per `(userId, purpose)`, so a reflection problem cannot turn memory synchronous.

### 6.4 Orchestration

- One tick inside `juno-sweepers` (the existing 10-min `scripts/memory-dreamer.ts` loop, renamed `deferred-worker`):
  1. Poll every submitted batch job of every purpose; bill each answer once (`batch:<job>:<custom_id>`) at its served tier; `purge`.
  2. Expire jobs past `deadlineAt − 15 min` to their `nextLane`.
  3. Run each purpose's handler for its eligible accounts. The handlers are the dream pass, the BF-1 session pass, the BF-4 reflection pass and the BF-6 pre-warm.
  4. Submit what the handlers queued: **one batch per model per tick across accounts**, with answers still stored per account. This replaces today's one batch per account per model (`dream.ts:201-229`) and cuts Batches-API HTTP calls and rate-limit pressure as accounts grow.
- **Flex runs inline** in `runUtilityPrompt` (new `lane` option) and in the Work runner's `tiered()` wrapper. Nothing is queued: it is the same synchronous walk with a longer timeout and a standard-tier retry.

### 6.5 Invariants

- **Never cross providers to reach a cheaper lane.** Lanes are chosen *inside* `resolveBackgroundCandidates`' permitted set, as `chooseBatchModel` already does (`dream.ts:123-132`).
- **Same model.** The lane is chosen for the model, never the model for the lane. A model without a batch or flex capability simply gets `standard`.
- **Bill what was served.** Read `service_tier` and the batch result usage. `batch: true` and `servedTier: "flex"` reach `recordSpend` from the provider's answer, never from the request.
- **Lane unavailability is not provider failure.** Flex 429/503 and batch expiry do not call `noteLiveProviderFault` (`memory.ts:496`).
- **Budget gates still apply at enqueue** (`checkBudget` / `checkUsageWindows`). Billing happens at download, as today.

---

## 7. Considered and rejected (with arithmetic)

| Job | Why not |
|---|---|
| Embeddings via OpenAI/Gemini Batch | A fact is ~20 tokens; at $0.02/MTok that is $0.0000004 each. Even 1,000 facts a month is $0.0004, so 50 % saves < $0.001/account-month. Write-time vectors are also needed for the next retrieval. |
| Moderation via flex | 300 × $0.00011 = $0.033/mo (A). Flex saves ≈ $0.016 and delays bans. |
| Titles, follow-ups, history-compaction summary | The user is waiting (seconds). They belong to the routing and trimming dimensions, not deferral. |
| Research workers, lead, writer via Batch | Tool loops: each step would wait up to 24 h. Flex does not help Anthropic workers (`worker.ts:116` prefers Haiku), and Anthropic has no flex. A possible future "economy research" opt-in exists only for OpenAI/Gemini leads. |
| Citation judge deferred | The audit repairs the delivered report and sets its verified footer (`finalize.ts:92-160`). Deferring it means the user reads the unaudited report. High risk. |
| Batch for scheduled Work runs | Agent loops; see BF-5 (flex) instead. |
| Realtime voice | No batch or flex lane exists. |

---

## 8. Measurement prerequisites (M0), then the plan

1. **Per-job attribution (M0).** Add `purpose` (BackgroundPurpose / label) and `lane` / `servedTier` to `ApiSpend` (`prisma/schema.prisma:1904`) and to the `llm.request` record (`src/lib/llm/request-meter.ts:58`, where `role` today is only utility/auxiliary/chat, `llm.ts:212`). Then `recordSpend` in `runUtilityPrompt` (`memory.ts:542-552`) and in batch billing (`dream.ts:100-110`) pass the label. Without this, no saving below can be verified.
2. **Baseline (2 weeks before shipping).** $ and call count per `purpose`, per provider, per account-month. Utility share of total per account.
3. **Per finding:**
   - **BF-1:** memory-bench parity (coalesced against per-turn), fact lag P95, extract-on-switch rate, `memory/extract` $ per account-month.
   - **BF-2:** orphan rate `1 − matchedCount/requestCount` by label, rebuilds per backfilled account.
   - **BF-3, BF-5:** served-tier mix, 429/503 rate, standard-fallback rate, P95 latency against budget, deadline misses (0).
   - **BF-4:** reflections per agent-day ≈ 4, ideas per reflection unchanged.
   - **BF-6:** `i18n` calls per day after a deploy ≈ 0.
   - **BF-8:** cache-read share in batch results.
4. **Guardrail alerts.** A breaker trip per `(user, purpose)`. Any batch whose `createdAt` is older than `deadlineAt`. Any unpurged job older than 24 h.

---

## Sources

- Anthropic: [Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing) · [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). All fetched 2026-10-31.
- OpenAI: [Flex processing](https://developers.openai.com/api/docs/guides/flex-processing) · [Batch API](https://developers.openai.com/api/docs/guides/batch.md) · [Create batch (CLI ref)](https://developers.openai.com/api/reference/cli/resources/batches/methods/create/index.md) · [Pricing](https://developers.openai.com/api/docs/pricing.md) · [DevelopersIO flex test](https://dev.classmethod.jp/en/articles/openai-flex-processing/). Search snippets; direct fetch blocked by the session network.
- Google: [Gemini Flex inference](https://ai.google.dev/gemini-api/docs/flex-inference) · [Flex & Priority announcement](https://blog.google/innovation-and-ai/technology/developers-tools/introducing-flex-and-priority-inference/) · [Optimization (Batch)](https://ai.google.dev/gemini-api/docs/optimization.md.txt) · [Batch Mode blog](https://developers.googleblog.com/en/scale-your-ai-workloads-batch-mode-gemini-api/). Search snippets.
- Alibaba Model Studio: [Batch inference](https://www.alibabacloud.com/help/en/model-studio/batch-inference) · [OpenAI-compatible batch](https://www.alibabacloud.com/help/en/model-studio/batch-interfaces-compatible-with-openai). Search snippets.
- In-repo: `docs/pricing/COST_ENGINEERING.md` §3/§5/§6, `docs/pricing/USAGE_METERING_AUDIT.md` rows 3–5, 20–22, 26–27.
