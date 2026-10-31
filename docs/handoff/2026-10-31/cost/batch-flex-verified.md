# Batch / Flex findings: verification

**Reviewer:** principal engineer, model quality. **Dimension:** batch-flex. **Repo:** `/home/user/juno` at `e532983ea`, read-only (tree clean after the review).
**Input:** `scratchpad/cost/batch-flex-findings.md` (BF-1 to BF-9, M0).

**Rules I applied:**
- The user-chosen model and its answers stay exactly the same.
- No added latency on an interactive turn.
- No new cross-user exposure, and no new provider-side retention of user content without a purge.
- A lane is picked for a model. A model is never picked for a lane.

**Repo moved during the review.** Another session merged `feat/memory-off-chat` and other branches. HEAD is now `ff1161190`.
- All file:line citations below are at `e532983ea`.
- Shifts in the files cited:
  - `src/lib/memory.ts`: about +8 lines after line 1533.
  - `src/lib/memory-dreamer.ts`: about +6 lines after line 48. It now adds `AND c."memoryOff" = false`.
  - `scripts/work-runner.ts` and `src/app/api/voice/transcript/route.ts`: small additions for the per-chat memory-off switch.
- None of these changes alters a verdict. The new per-chat "memory off" is honoured by `extractConversationMemory` itself, so every path below inherits it.

**What I ran** (all in `scratchpad/cost/verify-bf/`):
- `calc.mjs` → `calc-report.txt`: every $ figure below, using rates from `src/lib/model-rates.generated.ts`.
- `tsx --test tests/batch-api.test.ts`: 14/14 pass. This is the baseline for the batch layer.

---

## 0. Verdicts at a glance

| # | Item | Verdict | Saving (no double counting) | Ships |
|---|---|---|---|---|
| K1 | BF-2 narrowed: summary rebuilds during a backfill. Three parts: gate them, consume the rebuild answer *before* extraction moves the sources, and treat a GitHub fetch failure as "do not rebuild" | **KEPT (narrowed)** | Per 200-chat import: $0.016–0.063 (batch, Haiku 5.5). Sync-mode imports: $0.09 (Haiku 5.5) to $0.33 (Flash-Lite, excluding thinking). Steady state ≈ 0 today; it becomes the guard for aux-routing K3 | After memory tests |
| K2 | BF-7 narrowed: delete the provider-side batch and its files once the answers are stored | **KEPT (privacy prerequisite)** | $0 | **Before** any new batch purpose |
| K3 | BF-3 + BF-4 narrowed: a flex lane (Gemini and OpenAI) for utility calls made **inside the worker scripts** (dreamer sync walk, reflection sweep). The call stays synchronous, the model is the same, and a lane failure falls back to standard and is not counted as a provider fault | **KEPT (narrowed, flex eligibility gated on a rate column)** | Gemini-policy account: $0.033/mo dreaming, plus $0.08/mo rebuilds once aux K3 moves rebuilds to the dreamer, plus $0.144 per active proactive agent. OpenAI/Luna: $0.036 per active agent. Anthropic/Qwen: $0 | After K6 |
| K4 | BF-5 narrowed: an **opt-in** "economy" setting per routine. Scheduled and trigger Work runs then use flex on flex-eligible OpenAI/Gemini models | **KEPT (opt-in only)** | −50 % of the opted-in routine's token spend: $3.46/mo per daily GPT-6 Sol routine, $0.17 per daily Luna routine | After K6 |
| K5 | BF-6: a durable UI-translation store, plus an optional Batch pre-warm | **KEPT** | Platform cost: ≈ $3.5–9.7/mo (Haiku) or up to ≈ $16/mo (Flash-Lite) falls to ≈ $0.3/mo. These are assumption-driven; measure them | Now |
| K6 | M0: served tier / lane on `llm.request` and in pricing. **Merged with aux-routing K11** (labels) | **KEPT (enabler)** | — | First |
| R1 | BF-1: defer after-turn extraction to the dreamer | **REJECTED** | (claimed 0.48 % A / 1.6 % B / 6.3 % C) | — |
| R2 | BF-1 "extract-on-switch" | **REJECTED** | — | — |
| R3 | BF-2 slot-keyed rebuild with a submit-time snapshot | **REJECTED (as written)** | — | — |
| R4 | BF-3(b): Gemini Batch transport | **REJECTED (redundant with K3)** | — | — |
| R5 | BF-4: Anthropic Batch for reflection, with a slot key and a pending claim | **REJECTED (as written)** | — | — |
| R6 | BF-5 parts: default-on flex, Code autofix, the "remaining steps × p95" deadline rule | **REJECTED** | — | — |
| R7 | BF-7 parts: one provider batch per model **across accounts**, and the generic queue framework | **REJECTED** | — | — |
| R8 | BF-8: 1 h `cache_control` inside batches | **REJECTED (arithmetic wrong, negative expected value)** | — | — |
| R9 | BF-9: live evals through Batch | **REJECTED (infeasible for eval-juno; cents for memory-bench)** | — | — |

**Honest roll-up.**
- For the reference Anthropic Pro profile (A, $9.21/mo), the kept items save **≈ $0 to $0.04/mo per user**: reflection only, and only on OpenAI/Gemini. Anthropic has no flex tier, and Anthropic dreaming is already batched.
- For a Gemini-policy account (B, $10.02/mo), they save **≈ $0.11/mo (1.1 %)**, plus $0.14 per active agent, plus another ≈ $0.10 if phase 2 of K3 clears its latency gate.
- The real money in this dimension sits in two places:
  - **opted-in unattended Work runs on frontier OpenAI/Gemini models** (K4: dollars per routine per month);
  - **the platform's translation re-buys** (K5).
- Everything else here is either a correctness fix that also stops waste (K1, K2) or the meter that proves it (K6).

---

## 1. What I confirmed in code, and what I corrected

### Confirmed (file:line at `e532983ea`)

**The batch layer.**
- `BATCH_PROVIDERS = ["anthropic","openai"]` (`src/lib/batch/plan.ts:39`).
- The key ignores the system prompt only for `memory/extract` (`plan.ts:61-69`).
- Cap of 50 requests per job (`:98`), 26 h stale cutoff (`:100`), breaker window 3 (`:102, :117-121`).
- `chooseBatchModel` picks the cheapest batch-capable candidate **inside** the policy's permitted set (`src/lib/batch/dream.ts:123-132`).
- Billing is once per result under `batch:<job>:<custom_id>`, `batch: true` (`dream.ts:98-110`).
- There is one batch per account per model (`dream.ts:201-229`), and the only purpose is `memory_dreaming` (`dream.ts:51`).
- `batchPriceMultiplier` is 0.5 for anthropic, openai and google (`src/lib/pricing.ts:894-903`) and is applied at `:1062-1064`.

**No provider-side cleanup.**
- `liveBatchTransport` has only `submit`, `status` and `results` (`src/lib/batch/providers.ts:32-36, 61-126`).
- The OpenAI input JSONL holds the decrypted user messages (`providers.ts:79-87`). Neither the input file, the output file nor the error file is ever deleted. The Anthropic batch is never deleted either.
- Both SDKs in `node_modules` expose the needed calls: `messages.batches.delete` (anthropic-sdk 0.107.0) and `files.delete` (openai 6.45.0).

**No flex anywhere.**
- The only tier Juno sets is `priority` (`src/lib/openai-compat.ts:421`, `src/lib/llm/compat-loop.ts:481`).
- The agent proxy compares a served tier only against `"priority"` (`src/lib/agent-proxy.ts:389, 796, 895, 959`).
- The OpenAI SDK type already accepts `service_tier: 'flex'` (`node_modules/openai/resources/chat/completions/completions.d.ts:198`).
- Gemini is called over REST (`src/lib/gemini.ts:130`), so flex is a body field there.

**After-turn memory.**
- `finalize.ts:168-186` runs `extractConversationMemory`, then `maybeConsolidate`, then `maybeConsolidateProject` after every answered turn.
- That is gated only by `memoryEnabled` (`src/lib/chat/post-processing.ts:35`).
- The extraction chunk is `slice(0,1200)` per message, 40 messages / 12K chars (`memory.ts:1507-1508, 1601`), with `promptCache:"short"` only when there is more than one chunk (`memory.ts:1685`).
- `EXTRACTION_MAX_FACTS = 12` and `EXTRACTION_KNOWN_FACTS = 40` (`src/lib/memory-extraction.ts:30,33`).
- The chat model saves durable facts inline with `<juno:memory>` tags (`src/lib/chat/system-prompt.ts:411-427`).

**The dreamer.**
- It runs on a 10-min tick (`memory-dreaming.ts:33`) and needs the account to have been idle for 10 min (`:35`). It visits 5 accounts per tick (`:37`) and reads 6 conversations per account in batch mode (`:46`).
- It requires both `memoryEnabled` **and** `memoryBackgroundLearning` (`memory-dreamer.ts:61-62`, `memory-dreaming.ts:72-73`), plus usage-window room (`memory-dreamer.ts:150-152`).
- Accounts are visited sequentially (`scripts/memory-dreamer.ts:52-77`).
- In batch mode the summary rebuild is offered on **every** pass (`memory-dreamer.ts:197-210`).

**The rebuild prompt moves for reasons unrelated to memory.**
- The GitHub list is fetched live with `sort=pushed`, and a 5 s timeout or a non-OK response returns `[]` (`memory.ts:2247-2273`).
- Digests are ordered by `updatedAt desc`, take 40 (`memory.ts:2302-2307`). `markProcessed` rewrites `ConversationMemory` on every extraction.

**Coverage rule.**
- `coveredBySummary` treats a fact as covered when `row.createdAt <= summary.updatedAt` (`src/lib/memory-lifecycle.ts:2079-2089`). It does **not** use `entryCount`.
- The rebuild throttle is 5 min (`memory-lifecycle.ts:2019, 2066-2067`).

**Reflection.**
- The claim stamps `lastReflectedAt = now` before the call (`src/lib/agents/reflect.ts:90-99`).
- The prompt carries `today` and relative times (`reflect.ts:155-163`).
- Goals are addressed **by index into the current query**: `goals[checkIn.goalIndex]` (`reflect.ts:183-205`), bounded only by `goalCount` (`src/lib/agents/reflection.ts:209-210`).
- The sweep runs on a 10-min tick, 8 per tick, 2 per account (`src/lib/agents/reflect-sweep.ts:33-39`).

**Work runs.**
- `isAttendedOrigin` returns false only for `schedule` and `trigger`, and the comment states "There is no presence signal" (`src/lib/work/notifications.ts:65-73`).
- Unattended runs are still **steerable** mid-run (`scripts/work-runner.ts:595-625`).
- The per-request silence deadline is 120 s (`runner/agent-core/src/providers/timeouts.ts:23`).
- The Work runner calls providers directly with deployment keys (`scripts/work-runner.ts:3378-3420`).

**UI translation.**
- The cache is a process `Map` on `globalThis` (`src/app/api/i18n/translations/route.ts:13-15`).
- It accepts only catalog ids (`:74-77`), so **no user content can reach it**.
- Ids are `sha256(source).slice(0,16)` (`scripts/generate-i18n-catalog.mjs:276`), so a stored translation goes stale automatically when its English changes.
- There is one `juno-backend` process (`deploy/ecosystem.config.js:172`), so every restart or deploy empties the cache.
- `userId: null` makes this platform spend, capped at $5 per day per process (`memory.ts:286-291`).

### Corrected

1. **BF-1 "explicit memories unchanged, so the risk is low–medium" understates three hard conflicts** (details in R1):
   - the background-learning switch;
   - dreamer capacity;
   - extract-on-switch, which either adds latency to a turn or does not deliver the freshness it promises.
2. **BF-2's slot strategy says "set `entryCount` to the snapshot count so newer facts stay uncovered".** That is wrong. Coverage is `createdAt ≤ summary.updatedAt`, not `entryCount` (R3).
3. **BF-4 says "`parseReflection` drops goals that disappeared, via `goalCount`".**
   - `goalCount` only bounds the index.
   - If a goal is completed or added between submit and apply, every later index shifts, and check-ins and ideas attach to the **wrong goal** (R5).
4. **BF-8's "−4 % at the documented 30 % floor" assumes only the first request writes.**
   - With concurrent batch processing, every miss writes at 2×.
   - At a 30 % hit rate a 1 h marker **adds** ≈ 10 % to input. Break-even is a 52.6 % hit rate (R8).
5. **The `batch/providers.ts:294-312` citation is wrong.** The file has 126 lines. The result download is at `:107-125`, and nothing in the file deletes anything.
6. **BF-5's deadline rule cannot work as stated.** A scheduled run fires *at* its due time, so there is no slack to spend on flex queueing unless the run starts early. Starting early changes how fresh its content is (R6).
7. **BF-3 puts flex inside `runUtilityPrompt` for every caller with `budgetMs ≥ 60 s`.** Most of those callers run in `after()` in the web process, or inside a route's 45 s walk deadline (`memory.ts:259-260`). Flex therefore belongs only in the worker scripts until its latency is measured (K3).
8. **The sync dreamer's long-backfill waste is larger than the batch orphaning BF-2 headlines.** It does one rebuild per productive tick: ~100 rebuilds for a 200-chat import at 2 conversations per tick (`calc-report.txt`). K1 covers both modes.

---

## 2. Provider rules, checked against official documentation

| Rule | Status | Source |
|---|---|---|
| Anthropic Message Batches: −50 %; most finish in < 1 h; results at completion or 24 h; batches expire at 24 h; ≤ 100,000 requests / 256 MB; **results kept 29 days**; **ZDR: not eligible**; errored/canceled/expired requests are **not billed**; `DELETE /v1/messages/batches/{id}` after processing (cancel an in-progress batch first) | **Fetched 2026-10-31** | https://platform.claude.com/docs/en/build-with-claude/batch-processing |
| Anthropic batch + cache: discounts stack; "processed asynchronously and concurrently, cache hits are provided on a best-effort basis… 30 percent to 98 percent"; the 1 h TTL is recommended for shared context; `max_tokens: 0` pre-warm is rejected in batches | **Fetched** | same page; https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| Anthropic cache pricing: 5 m write 1.25×, 1 h write 2×, read 0.1× (0.05× Opus/Sonnet 5.5); minimum **512 tokens** for Haiku/Sonnet/Opus 5.5 (4,096 for Haiku 4.5); "Different organizations never share caches"; workspace isolation on the Claude API; ≤ 4 breakpoints; multipliers stack with Batch | **Fetched** | https://platform.claude.com/docs/en/build-with-claude/prompt-caching |
| Haiku 5.5 batch price $0.05 / $0.25 (≤ 100K-token prompts) | **Fetched** (batch page pricing table) | batch-processing page |
| Anthropic flex tier | None exists. The only discounted asynchronous lane is Batches | pricing / batch pages |
| OpenAI Flex: `service_tier:"flex"` on Responses and Chat Completions; priced at Batch rates, with caching discounts on top; `429 Resource Unavailable` is **not charged**; no automatic fallback (retry with `auto` or omit the field); the docs' examples use a 15-min client timeout; beta, eligible models listed on the pricing page | **Search snippets of the official page** (developers.openai.com is not resolvable from this session) | https://developers.openai.com/api/docs/guides/flex-processing ; corroborated by https://learn.microsoft.com/en-ca/Azure/foundry/openai/how-to/flex-processing |
| GPT-6 Sol / Luna standard rates | $2 / $0.20 cached / $10 and $0.10 / $0.01 / $0.50 (repo table, verified 2026-10-18 against OpenAI's pricing page). The **flex** column is **unverified** (third-party snippets show half price) | `src/lib/model-rates.generated.ts:88-89` |
| Gemini Flex inference: `service_tier` flex, −50 %, best effort, sheddable (`503`), **no automatic upgrade** to standard, client timeouts ≥ 10 min recommended; the newest snapshot lists **Gemini 3.5 Flash-Lite** | **Search snippets of the official page** (ai.google.dev is not resolvable). The exact REST field casing must be confirmed live | https://ai.google.dev/gemini-api/docs/flex-inference |
| Gemini Batch: −50 %, 24 h target, inline or JSONL ≤ 2 GB; whether cache discounts stack is **not stated** | Search snippets | https://ai.google.dev/gemini-api/docs/optimization ; https://developers.googleblog.com/en/scale-your-ai-workloads-batch-mode-gemini-api/ |

**Action for the owner:** allow `developers.openai.com` and `ai.google.dev` in the session's network settings. Two things must be read live before K3 and K4 are built: the flex eligible-model tables and the Gemini request field.

---

## 3. Kept items

### K1. Summary rebuilds during a backfill (BF-2, narrowed and corrected)

**Mechanism I confirmed.**
- In batch mode, the dream pass applies the ended batch's extraction answers first (`backfillMemories`, `memory-dreamer.ts:168-173`).
- That moves the rebuild sources: new facts, and digest order via `ConversationMemory.updatedAt`. So `maybeConsolidate` (`:201-209`) builds a different prompt from the one it queued last round.
- The queued rebuild answer is therefore billed (`dream.ts:98-110`) and never used.
- A GitHub push between submit and apply, or a 5 s GitHub timeout, moves the key the same way (`memory.ts:2257-2264`).
- The breaker never trips, because the same job's extraction answers *are* matched (`plan.ts:117-121`).
- In sync mode nothing is orphaned, but a long import rebuilds the summary on every productive tick.

**Change (three parts).**
1. **Gate.** In both modes, offer `maybeConsolidate` / `maybeConsolidateProject` from the dreamer only when one of these holds:
   - `pass.remaining === 0 && outcome.rereadQueued === 0`; or
   - the summary is older than the **same 3 h staleness cap** that aux-routing K3 introduces.

   Files:
   - `src/lib/memory-dreamer.ts:181-210`.
   - The cap lives in `summaryRebuildDecision` (`src/lib/memory-lifecycle.ts:2046-2069`) as a new `maxStalenessMs` input, so it is shared with aux K3.
2. **Consume before mutate (batch mode only).** When the account's ended jobs carry a `memory/consolidate*` request, run the rebuild check right after `sweepExpiredMemories` and **before** `backfillMemories`.
   - The sources are then the ones the prompt was built from, and the key matches.
   - The second call at the end of the pass is throttled by the summary that was just written (5-min throttle).
   - Facts extracted later in the same pass have `createdAt > summary.updatedAt`, so they stay uncovered and are injected as notes. That is correct.
   - Files:
     - `src/lib/memory-dreamer.ts` (order).
     - `src/lib/batch/dream.ts` / `store.ts`: expose "has ended rebuild answers" from `BatchJobRow.requests[].label`; no schema change.
3. **A GitHub failure is not "no repos".**
   - `gatherGithubContext` returns `[]` both for "not connected" and for "timed out / non-OK" (`memory.ts:2247-2273`).
   - Today the second case rebuilds the summary **without the user's repositories**. That is a quality bug, and in batch mode it also orphans answers.
   - Fix: return `null` on a failed fetch when a connection exists. In `consolidateMemories`, skip the rebuild (`status:"failed", transient:true`) unless it is user-forced ("Regenerate").
   - Do **not** re-sort the repo lines. The prompt labels them "most recently active", and order is a signal the summary may use.

**Rejected part:** the slot-keyed snapshot key (R3).

**Saving** (`calc-report.txt`):
- **Batch import of 200 chats, Haiku 5.5:**
  - one rebuild costs $0.000475;
  - an extraction round costs $0.00147;
  - so rebuilds are 24 % (account only) to 56 % (account plus 3 projects) of a round's spend;
  - 33 orphaned rounds cost **$0.016–0.063 per import**.
- **Sync-mode import** (Gemini, Qwen, or batching off): ~100 rebuilds fall to ~7, saving **$0.09 (Haiku 5.5) to $0.33 (Flash-Lite, excluding thinking)** per import.
- Steady state ≈ 0 today.
- **Why it matters beyond imports:** aux-routing K3 moves *every* dirty-summary rebuild into the dreamer. Without part 2, each one is exposed to the GitHub and digest drift above.

**Quality risk: low.**
- During an import the summary may be up to 3 h stale. Newer facts are injected as notes (`coveredBySummary`), as aux K3 already accepts.
- The apply-time guard `summarySourcesStillHold` (`memory.ts:2470-2474`) is unchanged.
- Part 3 *improves* quality.

**Tests.**
- `tests/memory-dreaming.test.ts`:
  - a pass with `remaining > 0` offers no rebuild;
  - `remaining === 0 && rereadQueued === 0` offers one;
  - a 3 h-stale summary offers one regardless.
- `tests/batch-api.test.ts`: an ended job holding a `memory/consolidate` answer is matched when the pass consumes it before extraction (`matchedCount` counts it).
- `tests/memory-lifecycle.test.ts`: `maxStalenessMs`.
- `tests/memory-summary-changes.test.ts` / `tests/memory-consolidation-race.test.ts`:
  - a GitHub fetch failure on a connected account returns `failed` and leaves the old summary;
  - "not connected" still rebuilds.
- `npm run test:memory` and `npm run memory:bench` must be unchanged.

**Measure.**
- Per `BatchJob`, split by request label: `matchedCount/requestCount` for `memory/consolidate*`. Target ≈ 1 (today ≈ 1/M during backfills).
- Rebuild calls per backfilled account (K6 labels).
- Count of rebuilds skipped for a GitHub failure.

### K2. Delete provider-side batch data once results are stored (BF-7, narrowed)

**Why.**
- Anthropic keeps batch requests and responses for 29 days, and batches are **not ZDR-eligible**.
- The OpenAI input file holds the decrypted chat messages being distilled. The code never deletes either.
- This is not a cost item. It is the precondition for using Batch for anything more (K5's pre-warm included), because every new purpose would widen that retention.

**Change.**
- `src/lib/batch/providers.ts`: add `purge(provider, batchId)` to `BatchTransport`.
  - Anthropic: `messages.batches.delete(id)`.
  - OpenAI: `files.delete()` for `input_file_id`, `output_file_id` and `error_file_id`, read from `batches.retrieve`.
- `src/lib/batch/dream.ts` `pollBatchJobs`: call it after `markBatchEnded` (answers encrypted and stored) and after `markBatchFailed`, including stale jobs, which need a cancel first.
- A purge failure is logged and retried next tick. It never blocks billing.
- `src/lib/batch/store.ts` + migration: a nullable `purgedAt` on `BatchJob`, so a sweep can retry unpurged jobs older than 1 h.
- Document in `docs/pricing/COST_ENGINEERING.md` §3 that a ZDR deployment must set `BATCH_API_ENABLED=0` for Anthropic.

**Saving:** $0. **Quality risk:** none. Answers are already stored in Juno, encrypted.

**Tests.** `tests/batch-api.test.ts`, with a fake transport:
- `purge` is called once per ended job and once per failed job;
- it is called only after `markBatchEnded`;
- a purge failure leaves the job `ended` with `purgedAt` null, and it is retried.

**Measure.** An alert on any `BatchJob` older than 24 h with `purgedAt IS NULL`.

### K3. A flex lane for worker-script utility calls, Gemini and OpenAI (BF-3 and BF-4, narrowed)

**Scope.** Only calls made from the long-running workers, where nobody waits and no route deadline applies:
- **(a)** the dreamer's synchronous walk: always for Gemini-policy accounts; for OpenAI accounts when batching is off or the breaker has tripped;
- **(b)** the reflection sweep (`origin === "sweep"`), after aux-routing K9's skip-when-unchanged.

Page and button reflections, everything in `after()` hooks and every route stay standard. **Anthropic and Qwen get nothing** (no flex tier), and **the model never changes**.

**Why flex and not Batch here.**
- Flex is synchronous. The reflection claim (`reflect.ts:90-99`), the index-based goal mapping and the dream pass's "call, then apply" shape all stay exactly as they are.
- The discount is the same 50 %.

**Change.**
- `src/lib/model-rates.generated.ts` + `scripts/model-sync/*`: an `OfficialRateEntry.flex: {input, output, cacheRead?} | null`, parsed from the official pricing pages.
  - A model without the column is **never** sent the field. This gates BF-3's "is Flash-Lite eligible" and BF-5's "is Sol eligible" on the lab's own page.
- `src/lib/gemini.ts` (REST body) and `src/lib/openai-compat.ts:421` (next to `priority`): `serviceTier?: "flex"`, passed through `streamChat` (`src/lib/llm.ts`).
  - Read back the served tier: OpenAI `service_tier` in the response. For Gemini, read the field the docs name (to confirm live).
- `src/lib/memory.ts` `runUtilityPrompt`:
  - a `lane?: "flex"` option;
  - on flex, use a 10-min attempt timeout and no 45 s total deadline (`memory.ts:259-260`);
  - on 429/503, or a flex timeout before any event, **retry once at standard immediately**;
  - do **not** call `noteLiveProviderFault` for those (`memory.ts:496`).
- Callers:
  - `scripts/memory-dreamer.ts` / `src/lib/batch/dream.ts` `sync:` passes `lane:"flex"`;
  - `src/lib/agents/reflect.ts` passes `lane:"flex"` only when `options.origin === "sweep"`.
- Throughput:
  - the dreamer loop is sequential (`scripts/memory-dreamer.ts:52-77`), and so is the reflector;
  - add a per-tick wall-clock budget (for example 8 min), plus a concurrency of 2–3 accounts, so one slow flex call cannot starve the tick.
- `src/lib/pricing.ts` / `src/lib/spend.ts`: `recordSpend({ servedTier })` prices `flex` from the new column, from the **served** tier, never the requested one. The user's usage windows then really get the saving.

**Saving** (`calc-report.txt`):
- **Profile B (Gemini 3.5 Flash-Lite):**
  - dreaming $0.067 → $0.033 saved;
  - rebuilds $0.16 → $0.08 saved, *only once aux K3 has moved rebuilds into the dreamer*;
  - reflection $0.288 → $0.144 saved per active proactive agent (≈ $0.036 for an idle agent after aux K9);
  - total without agents ≈ **$0.11/mo (1.1 %)**.
- **OpenAI accounts:** Luna is priced like Haiku, so reflection saves ≈ $0.036 per active agent.
- **Phase 2 (gated):** after-turn extraction for Gemini/OpenAI accounts on flex is worth ≈ $0.10/mo (1 %) for B.
  - It runs in `after()` in the web process, and a slow flex call delays cross-chat freshness by its latency.
  - Ship it only if the phase-1 data shows flex P95 < 30 s and a 503 rate < 5 % for that model. Otherwise do not.
- These figures exclude Flash-Lite's thinking tokens (aux-routing K1). The 50 % applies to whatever is billed.

**Quality risk: low.**
- Same model, same prompt, same parser.
- The only cost is wall-clock time on jobs that have none to lose, and a standard retry bounds it.
- Ideas still arrive within the 6 h interval as the passive notification they already are (`reflect.ts:213-221`).

**Tests.**
- `tests/gemini-request.test.ts`: the flex body field is present only with `serviceTier`, and absent for a model with `flex: null`.
- `tests/openai-compat-round.test.ts`: `service_tier:"flex"` is sent and `priority` is unaffected.
- A new `tests/utility-flex-lane.test.ts`, with a fake `streamChat`:
  - 503 → one standard retry;
  - no `noteLiveProviderFault`;
  - the served tier is billed.
- `tests/agents-reflect-sweep.test.ts`: only the sweep passes `lane`.
- `tests/cost-engineering-pricing.test.ts`: flex pricing comes from the served tier.

**Measure (needs K6).** Per utility label and model:
- served-tier mix;
- flex 429/503 rate and standard-retry rate;
- P50/P95 latency;
- $ per Gemini-policy account-month, before and after;
- dreamer tick duration and accounts per tick (they must not fall).

### K4. Opt-in economy mode for unattended Work runs (BF-5, narrowed)

**Change.**
- **A per-routine setting**, "Economy: may finish later, uses less of your usage", **off by default**.
  - It is shown only when the routine's model has a `flex` rate (K3's column): OpenAI and Gemini.
  - It applies only to runs with `origin` `schedule` or `trigger` (`isAttendedOrigin`, `src/lib/work/notifications.ts:71-73`).
- **`scripts/work-runner.ts:595-625`:** a `tiered()` wrapper next to `steerable()`.
  - It sets `request.serviceTier = "flex"` while the run is in economy mode.
  - It switches the **rest of the run** to standard as soon as either of these happens:
    - steering is delivered (someone is now engaged); or
    - the run resumes from a question a person answered.
  - On 429/503 it replays that request at standard.
- **`runner/agent-core/src/providers/openai-compat.ts`, `openai-responses.ts` (and the Gemini adapter, if Work drives Gemini):** send `service_tier`, and read back the served tier.
  - `timeouts.ts:23`: the 120 s silence deadline becomes a per-request value. It is 15 min only on a flex attempt and 120 s everywhere else, so stall detection is unchanged for standard requests.
- **`src/lib/spend.ts` `recordWorkRunSpend` / `src/lib/pricing.ts`:** price by served tier. `src/lib/agent-proxy.ts:796, 895, 959` treats a served `flex` as a discount tier for any proxied path.
- **Excluded:** Code autofix (`src/lib/code-autofix-dispatch.ts`). A developer whose PR is red is waiting for it. See R6.

**Saving.**
- One daily GPT-6 Sol routine (8 requests × (9K cached + 6K fresh + 1.5K out)): $0.0288 per request, $6.91/mo, so **$3.46/mo saved** if flex halves cached input too ("additional discounts from prompt caching", per the official guide snippet).
- A daily Luna routine saves $0.17/mo.
- Anthropic-model routines save $0.

**Quality risk.**
- Output: none. Same model, same request.
- Latency: the run may finish later. The user chose that explicitly for that routine, so this is not an interactive turn.

**Tests.** A new `tests/work-flex-tier.test.ts`, with a fake provider:
- an economy schedule run sends flex;
- steering flips the remaining requests to standard;
- a 429 replays at standard;
- a manual or attended origin never sends flex;
- a model without a `flex` rate never sends it.

Also:
- `tests/agent-proxy-spend.test.ts`: a served flex is billed at the flex rate.
- The runner timeout test covers the per-request deadline.

**Measure.** Per economy run:
- served-tier mix and standard fallbacks;
- step P95;
- finish time minus fire time;
- $ per run, against the same routine's previous 4 weeks;
- the opt-out rate after the first week, which shows whether the latency was acceptable.

### K5. A durable UI-translation store and a batch pre-warm (BF-6)

**Confirmed.**
- The `Map` cache (`route.ts:13-15`) is emptied by every restart of the single `juno-backend` process.
- Catalog: 10,788 strings and 365,101 source chars. As JSON it is ≈ 636K chars over 360 requests of 30 ids.
- Ids are content hashes, so a stored row can never serve outdated English.
- Only catalog literals are translated, so a shared store exposes nothing about any user.

**Change.**
1. A `UiTranslation(locale, id, text, model, createdAt)` table (raw SQL, like `batch/store.ts`) with a unique `(locale, id)`.
   - `route.ts:90-97` reads the `Map`, then the table, then the walk.
   - `route.ts:173-179` writes misses through to both.
2. **Validation before persisting.** A bad translation would otherwise become permanent; today it is accidentally "healed" by the next restart. Keep the existing non-empty and ≤ 600-char checks, and require that every placeholder, URL, number and product name in the source string also appears in the translation.
3. `scripts/i18n-prewarm.ts`:
   - diff the catalog against the table per locale;
   - translate the gaps with the **same system prompt and parser**, through Batch where the platform walk's first candidate is batch-capable, and the sync walk otherwise;
   - run it from `deploy/deploy.sh` (non-blocking) or nightly in `juno-sweepers`;
   - it depends on K2 (purge).
4. An admin purge per locale (`DELETE … WHERE locale = $1`) for a bad batch.

**Saving.**
- Haiku 5.5: ≈ $0.129 per locale for the full catalog ($0.065 batch).
- Today ≈ 30 restarts × k locales × fraction viewed f: **$3.49/mo** (k = 3, f = 0.3) to **$9.68/mo** (k = 5, f = 0.5). It is ≈ 4.6× that if the platform walk lands on Flash-Lite.
- After: a one-time ≈ $1.23 for 19 locales in batch, plus new strings. **≈ −90 to −97 %.**
- The locale mix and f are assumptions; the unattributed meter (`memory.ts:286-291`) gives the real figure.

**Quality risk: none or positive.** Same model and prompt. Translations become stable, and cold-locale visitors stop seeing English while the walk runs.

**Tests.** A new `tests/i18n-translation-store.test.ts`:
- a table hit makes no model call;
- a miss writes through;
- a translation missing a placeholder is not persisted;
- a changed source string (new id) misses.

`tests/i18n-format.test.ts` stays green.

**Measure.** Daily `i18n` call count and $ (unattributed meter), and the miss rate per locale in the hour after a deploy. Target ≈ 0 for strings older than the last pre-warm.

### K6. Lane and served tier in the meter (M0, merged with aux-routing K11)

**Change.**
- aux K11 already labels every utility call (`role: utility:<label>` on `llm.request`, `src/lib/llm/request-meter.ts`).
- Add `lane` (`standard|flex|batch`) and `servedTier` to the same record.
- `recordSpend` takes `servedTier`; its `batch` flag already exists (`src/lib/spend.ts:227-232`).
- If per-purpose ledger rows are wanted, add a nullable `purpose` column to `ApiSpend` (`prisma/schema.prisma:1904-1938`). Do not overload `source`, which is `web|app`.

**Saving:** none. It is how K1–K5 are measured. **Quality risk:** none.

**Tests.**
- `tests/tool-metering.test.ts` / `tests/pricing-billable.test.ts`: a flex-served request is priced at the flex rate; a request that asked for flex and was served standard is priced at standard.

---

## 4. Rejected items, and why

### R1. BF-1: fold after-turn extraction into the dreamer

Rejected. Each of the following blocks it on its own.

1. **It breaks a user setting.**
   - After-turn extraction is gated only by `memoryEnabled` (`post-processing.ts:35`).
   - The dreamer also requires `memoryBackgroundLearning` (`memory-dreamer.ts:62`, `memory-dreaming.ts:73`). The setting's own copy reads "Between sessions, … reads **older** chats it hasn't learned from yet" (`src/components/settings/sections/memory.tsx:92-94`).
   - Deferring would either stop implicit learning entirely for everyone who switched that off, or redefine their switch behind their back.
2. **It is a freshness regression on answers.**
   - Today a fact said in chat A is extracted seconds after A's answer, and it is in chat B's very next turn as a note.
   - Deferred, it waits for the **whole account** to be idle for 10 min (`dreamEligibility` reads the newest message *anywhere*), plus batch latency (< 1 h typically, up to 24 h).
   - An all-day user with gaps under 10 min is not extracted until they stop.
   - Answers in B that would have used the fact get worse. That fails the owner's "same answer quality", on the feature the owner wants to beat ChatGPT and Claude with.
3. **It does not scale.** Dreamer capacity is 5 accounts per 10 min, sequential (≈ 720 account-visits a day). Every active account would need a visit per session. Raising it is an unmeasured DB and ops change.
4. **It adds a gate.** `checkUsageWindows` (rolling windows) gates the dreamer, while after-turn extraction is gated by the monthly budget only. An account in a spent 5-hour window would stop learning.
5. **The fact cap.** It is 12 per call (`memory-extraction.ts:30`), so five turns coalesced into one call can return a fifth of the facts. No bench shows parity.
6. **The saving is small:** $0.044/mo (A, 0.48 %), $0.16/mo (B, 1.6 %), $0.044/mo (C). These figures are recomputed and match the findings' arithmetic.

**What remains instead:**
- Gemini/OpenAI after-turn extraction on flex, but only if K3 phase 2's latency gate clears.
- Aux-routing R6's acknowledgement allowlist ("thanks", "ok", emoji-only).
- **Measure first, through K6:** the share of `memory/extract` calls that return zero facts. If it is high, a no-content skip is the right lever, not deferral.

### R2. BF-1 "extract-on-switch"

Rejected.
- "Awaited with a 3 s cap" adds up to 3 s to an interactive turn.
- "Behind `after()`" lands after B's first turn has already assembled its memory context, so it does not "keep today's freshness exactly".
- There is no version of it that meets both rules.

### R3. BF-2 slot-keyed rebuild with a submit-time snapshot

Rejected as written.
- `coveredBySummary` marks a fact covered when `createdAt ≤ summary.updatedAt` (`memory-lifecycle.ts:2079-2089`).
- A summary built from a snapshot at T0 and written at T1 (hours later) would therefore mark **every fact learned in (T0, T1] as covered without containing it**. Those facts would vanish from every chat until the next rebuild.
- Setting `entryCount` from the snapshot does not help, because coverage does not read it.
- A correct version needs a `sourcesAsOf` column threaded through `coveredBySummary`, `summaryRebuildDecision` and `summaryPredatesForget`. K1's consume-before-mutate gets the same orphan fix without any of that.

### R4. BF-3(b): a Gemini Batch transport

Rejected as redundant.
- Gemini Flex (K3) gives the same 50 % synchronously, with no new submit/poll/parse code, no new provider-side retention surface and no key-drift problem.
- Whether Gemini's cache discounts stack inside batch jobs is not stated in its docs.
- Reconsider only if flex's 503 rate for Flash-Lite turns out to be high (K3's measurement).

### R5. BF-4 as written: Anthropic Batch for reflection, slot key, pending claim

Rejected as written.
- Goals are applied **by index into the goal list read at apply time** (`reflect.ts:183-205`; `reflection.ts:209-210` only bounds the index by `goalCount`).
- An answer computed before a goal was completed or added would attach check-ins and ideas to the wrong goal. The person would see a check-in note under a goal it was not about.
- The fix needs an id-keyed snapshot, a pending-claim column and a 6 h fallback.
- After aux K9 (idle agents 4/day → 1/day), all of that buys ≈ $0.009 per idle agent and ≈ $0.036 per active agent on Haiku.
- OpenAI and Gemini agents get the same 50 % from K3's flex with none of the redesign.
- Revisit Anthropic reflection batching only if K6 shows reflection is a material share of Anthropic accounts' spend.

### R6. BF-5 parts

- **Default-on flex for scheduled runs.** A routine fires *at* its due time ("the morning briefing at 8:00"), and there is no presence signal (`notifications.ts:65-70`). Turning on flex for everyone makes results arrive later than the person expects, with no choice offered. K4 makes it opt-in.
- **The deadline rule "timeToDue > remainingSteps × p95".** For a scheduled run, timeToDue ≈ 0 at fire time, so the rule either never enables flex or requires firing early. Firing early changes how fresh the content is.
- **Code autofix.** It is triggered by a CI webhook on a PR a developer is actively waiting to merge. That is attended in practice, even though `origin` says otherwise.
- **Topic triggers by default.** They react to events ("when X arrives, do Y"), where timeliness is the point. They are included only when the person opts that routine into economy mode.

### R7. BF-7 parts

- **"One batch per model per tick across accounts."**
  - Today one provider batch holds one account's prompts (`dream.ts:201-229`), so a custom_id → account mix-up is impossible by construction.
  - Packing several accounts' decrypted messages into one batch introduces exactly that failure mode: one user's memory facts applied to another user. In exchange it saves **no tokens**, only HTTP calls.
  - Not acceptable.
- **The generic `deferred/` framework** (JobClass × lanes × `DeferredSlot` table × per-purpose breaker). None of the kept items needs it:
  - K3 and K4 are inline flex;
  - K1 and K2 are changes inside `batch/*`;
  - K5's pre-warm is a script.
  - Build it only when a second queued purpose is actually approved.

### R8. BF-8: a 1 h `cache_control` on the extraction system prompt inside batches

Rejected.
- **The arithmetic assumes only the first request writes.** Batch requests are "processed asynchronously and concurrently" (official docs), so every miss writes at 2×. Per request, the prefix costs h × 0.1 + (1 − h) × 2.
  - At the documented 30 % floor, the prefix costs 1.43×. That is **+9.9 % of input, a loss**, against the claimed −4 %.
  - Break-even needs a 52.6 % hit rate for 1 h, or 21.7 % for 5 m.
- **The prefix is often too short to cache.** The extraction system prompt is ≈ 250 tokens of instructions plus up to 40 known facts (`memory-extraction.ts:35-54`). It is below Haiku 5.5's 512-token minimum until an account has roughly 17 facts. A first import, the main batch workload, starts at zero.
- **Tiny batches cache badly.** A typical job is 6 requests, processed concurrently, which is the worst case for cache hits.
- **The upside is nothing.** Total-spend impact was ≈ 0 even in the findings.

### R9. BF-9: live evals through Batch

Rejected.
- `eval-juno` live cases use web search, tool probes, reasoning effort and `latencyMs` (`scripts/eval-juno.ts:24-56`). The batch layer carries only system plus one user text, so it would evaluate a different request from the one production sends.
- `memory-bench --live` is a few dozen small utility calls, so the 50 % is worth cents per run.
- Operator-only, with negligible value.

---

## 5. Order of work and overlaps

1. **K6** (with aux-routing K11). Nothing below can be verified without it.
2. **K2** (purge). It is privacy-first, and K5's pre-warm depends on it.
3. **K5** (translation store). It is independent and has the largest certain platform saving.
4. **K1** (rebuild gate, consume-before-mutate, GitHub failure). Ship it together with aux-routing K3, behind one `test:memory` + `memory:bench` run. They share the 3 h cap.
5. **K3 phase 1** (flex in the worker scripts), once the flex tables have been read live (see §2).
6. **K4** (economy routines), after K3's flex column and served-tier billing exist.
7. **K3 phase 2** (after-turn extraction on flex), only if phase-1 latency and 503 data clear the gate.

**Overlaps (counted once):**
- aux-routing F6 → R1 here.
- aux-routing F12 (OpenAI flex) → K3 and K4 here.
- aux-routing F9 batching → R5 here (and K3 for OpenAI/Gemini).
- aux-routing K3 provides the rebuild relocation, and K1 here makes it orphan-safe.
- The cache-prefix lane has no overlap.

---

## 6. Sources

- Anthropic, **fetched 2026-10-31:**
  - [Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing): 50 %, < 1 h typical, 24 h expiry, 29-day retention, ZDR not eligible, DELETE endpoint, unbilled errored/canceled/expired requests, best-effort cache hits of 30–98 %, 1 h TTL recommendation, Haiku 5.5 batch $0.05 / $0.25.
  - [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): 1.25× / 2× / 0.1×, 512-token minimum on the 5.5 models, organization and workspace isolation, ≤ 4 breakpoints, stacking with Batch.
- OpenAI, search snippets of the official pages (developers.openai.com is blocked in this session):
  - [Flex processing](https://developers.openai.com/api/docs/guides/flex-processing)
  - [Azure OpenAI flex processing](https://learn.microsoft.com/en-ca/Azure/foundry/openai/how-to/flex-processing) (corroborates the 50 % rate and the no-auto-fallback rule)
  - Standard rates from `src/lib/model-rates.generated.ts` (verified 2026-10-18 against https://developers.openai.com/api/docs/pricing).
- Google, search snippets (ai.google.dev is blocked in this session):
  - [Flex inference](https://ai.google.dev/gemini-api/docs/flex-inference)
  - [Optimization / Batch](https://ai.google.dev/gemini-api/docs/optimization)
  - [Batch Mode announcement](https://developers.googleblog.com/en/scale-your-ai-workloads-batch-mode-gemini-api/)
- In repo: `docs/pricing/COST_ENGINEERING.md` §3; `scratchpad/cost/aux-routing-verified.md` (K1, K3, K9, K11, R6); `scratchpad/cost/verify-bf/calc-report.txt`.
