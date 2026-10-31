# Measurement and guardrails: metering, pricing, limits (cost lane)

Repo `/home/user/juno` at `e532983ea`. Read-only audit, 2026-10-31. All dollar figures below come from the
repo's own pricing code (`estimateGenerationCostUsd`, `estimateTurnCostUsd`, `workRunPricing`,
`usageWindowGrid`), run by the simulation scripts in
`docs/handoff/2026-10-31/cost/sim/` (`sim.ts`, `work.ts`, `util.ts`).
Token shapes are stated assumptions. They are not production measurements, because production
measurements do not exist yet in a form that can be queried (see M3).

## Summary

User limits are **100% cost-based**. No plan has a message cap: `PLANS[*].monthlyMessages` is `null`
on every plan (`src/lib/plans.ts:69,92,115,140,167,197,222,247`). The monthly budget is EUR at 55%
of the HT price (`src/lib/spend.ts:62-71`). The 5-hour and weekly windows are carved from that budget
(`src/lib/spend-ceiling.ts:496-530`). So every dollar a user is charged less for the same work
turns straight into more usage for anyone at a limit. Cheaper calls already pass through to users
automatically, but only when the ledger charges what the provider actually billed.

That condition fails on two paths:

* **Work runs** are charged **5.6x to 22x** the provider's bill.
* **Deep-research workers** are charged **5x** the provider's bill on the default worker model.

Fixing these gives users the biggest increase in usage this lane can deliver. It does not change
the models, the prompts or the answers.

The measurement layer is half built. A good per-request record exists (`llm.request`, with a
prefix-break diagnostic), but:

* it goes only to PM2 stdout;
* it covers only `streamChat` callers;
* it cannot tell a title from a memory extraction;
* the durable ledger (`ApiSpend`) stores no cache, reasoning or call-site columns.

Cache hit rate per call site, cost per turn including background work, and savings proven after
deploy can't be computed today.

| ID | Finding | Effect on what users are charged (headroom) | Effect on provider spend | Quality risk |
|---|---|---|---|---|
| M1 | Work runs bill cache reads at the full input rate, then re-price cumulative tokens as a single request (long-context surcharge) | Work ledger −82% (Sonnet/Opus 5.5) to −95% (Haiku 5.5); 5.6x–22x more Work per window | 0 directly. Users at cap will spend up to their (designed) budget | none (billing only; fewer runs cut short) |
| M2 | Research worker loop billed as one giant request, so Haiku 5.5's >100K-token price (5x) applies to the whole loop | Worker ledger −80%; whole research run −56% (tier-2 run: $1.69 → $0.74) | 0 directly | none (billing only; more rounds fit the run budget) |
| M3 | No durable per-request or per-call-site telemetry; `ApiSpend` has no cache, reasoning or call-site columns; 6 paid paths bypass the request meter | enables proof of every other lever | 0 directly; prerequisite for the measured 10–35% from caching and routing work | none |
| M4 | No cost dashboard or provider-invoice reconciliation | catches over-billing like M1/M2 within a day | 0 directly; catches regressions | none |
| M5 | Regression tests: prefix stability covered for chat adapters only; nothing pins aux routing, per-request billing, Work cache pricing or rate freshness | protects M1/M2 | protects every caching saving | none |
| M6 | 5m vs 1h conversation-cache decision is still waiting for reply-gap data (COST_ENGINEERING §1 #6) | — | −11% to −26% of input cost on chat turns with 5–60 min gaps, *if* the data supports it (formula below) | none (same tokens, same model) |
| M7 | Pricing table: Anthropic re-verified exact today; OpenAI and Google pages unreachable from this sandbox; no flex tier and no explicit-cache storage price modelled; two price doublings are scheduled | prevents over- and under-billing on rate changes | prerequisite for flex and explicit caching | none |
| M8 | Passing savings to users: hold the $ budgets constant, show "≈ N messages left", set `API_COST_EUR_PER_USD` | +8% headroom if the FX rate is set (to verify); savings made visible | 0 (budget policy) | none |
| M9 | Char-count floors and `max(fromTokens, fromCaller)` can over-charge rows that already have reported usage; this is unmeasured | likely 0–5% of output cost on GPT-tokenizer English (unverified) | 0 | none |

---

## What happens today

### Where costs are recorded

| Layer | File:line | What it stores | Gaps |
|---|---|---|---|
| Per-request record `llm.request` | `src/lib/llm/request-meter.ts:55-102`, wired at `src/lib/llm.ts:209-219` | provider, model, `role`, context tier, round, attempt/retry/fallback, fresh / cache-read / cache-write 5m / 1h / output / reasoning tokens, `cacheReadShare`, tool fees, list cost, latency, TTFT, prefix verdict (`first`, `stable`, `system@i`, `history_rewritten@i`…) | Sink is `logSync` to stdout only, with **"no log shipper"** (`src/lib/logger.ts:17`). `role` is only ever `chat`, `utility` or `auxiliary`: **no `streamChat` caller passes `role`** (all 9 call sites), and `runUtilityPrompt` does not forward its `label` or `purpose` (`src/lib/memory.ts:469-476`). |
| Ledger `ApiSpend` | `prisma/schema.prisma:1904-1938` | userId, agentId, model, `kind` (10 values), `source` (web/app), promptTokens, completionTokens, costMicroUsd, groundingQueries, idempotencyKey | **No cacheRead / cacheWrite 5m / 1h, no reasoningTokens, no callSite / purpose, no conversation or generation id.** Every utility job lands in `kind:"utility"` (`src/lib/memory.ts:546`), so titles, follow-ups, moderation, memory work, summaries and the citation judge can't be told apart. |
| Message row | `prisma/schema.prisma:925-950` | promptTokens, completionTokens, `cacheReadTokens`, `cacheWriteTokens`, `costMicroUsd` (assistant turns) | Chat turns only. No reasoning tokens and no 5m/1h split. |
| Turn trace `chat.turn` | `src/lib/chat/turn/trace-sink.ts:25-52` | latency, usage, cost | Ring of 200 per process, lost on restart; shown at `/admin/turns`. |
| Cost per accepted result | `scripts/cost-per-accepted.ts` | chat-turn cost ÷ kept turns, per task class and model | Chat only; a CLI, not a dashboard. |

**Paid paths the request meter never sees** (they call providers directly, not through `streamChat`):

* research workers (`src/lib/research/agents/worker.ts`, which by its own comment is "the largest volume of prose Juno sends anywhere");
* Work runs (`scripts/work-runner.ts` via `runner/agent-core`);
* the Code agent proxy (`src/app/api/agent/[...path]/route.ts`);
* Batch dreaming (`src/lib/batch/providers.ts`);
* realtime voice (`relay/src/providers/*`);
* embeddings, TTS, STT and media.

They do write `ApiSpend`, but leave no request-level cache trace.

### Pricing table

`src/lib/model-rates.generated.ts` has 104 rows, all `verified: 2026-10-18`, generated by the nightly
`scripts/model-sync/cron.sh`. Re-checked today against Anthropic's page
(<https://platform.claude.com/docs/en/about-claude/pricing>): every Claude row matches exactly.
That covers input, 5m and 1h writes, and reads, including Fable/Mythos 5.1 reads at 0.025x, Opus and
Sonnet 5.5 reads at 0.05x, and Haiku 5.5's price step for prompts over 100K tokens ($0.10 → $0.50 input,
`longContext.inputMultiplier: 5`). Batch is 50% and stacks with caching. Fast mode on Opus 5.5 is
$8/$40. The cache rules (1h write 2x, 5m write 1.25x, 4 breakpoints, 20-block lookback, 1h entries
before 5m) match <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>.

**Could not be verified from this session.** `developers.openai.com` and `ai.google.dev` do not
resolve here (they are outside the session's network allowlist; they must be allowed to re-check).
Search results for the OpenAI pages
(<https://developers.openai.com/api/docs/guides/prompt-caching>,
<https://developers.openai.com/api/docs/guides/flex-processing>, and the Azure mirror
<https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching>) confirm the following:

* `prompt_cache_key` is required for reliable matching on GPT-5.6+;
* the minimum cached lifetime is 30 minutes on 5.6+;
* only `24h` retention exists for gpt-5.5;
* the minimum prompt is 1,024 tokens;
* flex is `service_tier:"flex"`, billed at Batch rates (50%).

The repo's OpenAI and Gemini rows can't be re-confirmed until those hosts are reachable.

**Pricing gaps that later levers will hit:**

* No flex tier. `batchPriceMultiplier` covers `batch:true` only (`src/lib/pricing.ts:894-903`), and
  `service_tier` is only ever `priority` or `ultrafast` (`src/lib/openai-compat.ts:421`).
* No price for Gemini explicit-cache storage ($/token-hour).
* Relay voice has its own duration-based rate table (`relay/src/providers/registry.ts:157,187,201`).
  GPT-Live is billed $0.05 per input-minute with the delegate estimated separately; the table's own
  comment says it "reads low".

**Scheduled price changes** (`src/lib/scheduled-prices.ts`): Gemini 4 Argon doubles on 2026-12-01,
in 30 days. Gemini 3.6–3.8 Flash doubles on 2027-01-01. A user on those models gets about half the
turns per window afterwards, so any savings dashboard must separate *price* effects from
*efficiency* effects (M4).

### Limits

Plan budgets (`src/lib/spend.ts:62-71`, `budgetForPlan` :80) and the windows
(`src/lib/spend-ceiling.ts:432,453,496-530`; the window floor is 10 × the $0.25 Work hold = $2.50).
Computed with `usageWindowGrid` for a 31-day October:

| Plan | Month | Weekly gate | 5-hour gate |
|---|---|---|---|
| FREE | $0.20 | $0.20 | $0.20 |
| LITE | $5.00 | $2.50 (floor) | $2.50 |
| PRO | $11.00 | $2.50 (floor; pace would be $2.48) | $2.50 |
| PLUS | $27.50 | $6.21 | $3.10 |
| MAX | $55.00 | $12.42 | $6.21 |

Admission (`src/lib/metering/unit-prices.ts:229-239`) refuses only when a window or the month is
spent, or when the call's own estimate exceeds what is left. The chat route's mid-stream guard is
cache-aware (`src/lib/chat-budget-guard.ts:20-34`). Chat-turn settlement re-prices each provider
request on its own, through `estimateTurnCostUsd` (`src/lib/turn-pricing.ts:15-90`). That is correct.

What a PRO weekly gate buys on Sonnet 5.5, at 18K input and 800 output per turn (repo pricing):

* uncached: $0.0440 per turn, so **57 turns**;
* 16.5K cached: $0.0126 per turn, so **198 turns**;
* cold turn with a 5m write: $0.0522 per turn.

This is the conversion rate from caching savings into "usage gets better".

---

## M1. Work runs are charged 5.6x to 22x what the provider billed

### What happens

1. `scripts/work-runner.ts:3499-3505` and `src/lib/metering/work-pricing.ts:24-31` give the runner's
   guard input, output and cache-write rates. They give it **no cache-read rate**, by design: "The
   base rate, not the cache-adjusted … one".
2. `runner/agent-core/src/work/budget.ts:193-212` (`record`) prices
   `step.inputTokens × input rate`. `inputTokens` *includes* cache reads (`runner/agent-core/src/types.ts:11-27`),
   and the comment says "Cache READS stay at the full input rate — over-billing a discount the run
   did get". The runner does cache: there are Anthropic `cache_control` markers at
   `runner/agent-core/src/providers/anthropic.ts:102-109,277-279`, and a per-lab plan in
   `runner/agent-core/src/providers/prompt-cache.ts`.
3. `recordWorkRunSpend` (`src/lib/spend.ts:387-450`) then calls `recordSpend` with the
   **cumulative** `promptDelta` and `completionDelta` and no cache fields. `recordSpend` re-prices
   those as a single request (`estimateTurnCostUsd` with no receipts, so the fallback path) and keeps
   `max(fromTokens, fromCaller)` (`src/lib/spend.ts:299`). On GPT models, cumulative input over 272K
   triggers the 2x/1.5x long-context surcharge (`src/lib/pricing.ts:857-863,879-882`). On Haiku 5.5,
   over 100K triggers 5x.

### Arithmetic

`sim/work.ts` models a 40-step run: 12K starting context, +1.2K per step, 700 output tokens per step,
the newest block written each step and everything older read.

| Model | Provider truth (per request, cached) | Runner guard | `recordSpend` recompute | Ledger (max) | Overcharge |
|---|---|---|---|---|---|
| claude-sonnet-5-5 | $0.563 | $3.141 | $3.112 | $3.141 | 5.6x |
| claude-opus-5-5 | $1.125 | $6.283 | $6.224 | $6.283 | 5.6x |
| gpt-6.1-sol | $0.533 | $3.112 | $6.084 | $6.084 | 11.4x |
| gpt-6-luna | $0.033 | $0.156 | $0.304 | $0.304 | 9.1x |
| claude-haiku-5-5 | $0.035 | $0.157 | $0.778 | $0.778 | 22.3x |

Hand check for Sonnet 5.5:

* reads ≈ 1.357M × $0.10/M = $0.136;
* writes 58.8K × $2.50/M = $0.147;
* output 28K × $10/M = $0.280;
* total $0.563.

A PRO user's weekly gate is $2.50. Today, **one** 40-step Sonnet run ($3.14 on the ledger) cannot
finish inside a week's window. At provider truth, about 4 fit.

**Saving at this call site.** The Work ledger falls 82% (Sonnet/Opus), 89–91% (GPT) or 95%
(Haiku 5.5). Provider spend for a given run is unchanged. Headroom grows 5.6x–22x.

**Operator note.** Users at the cap will now actually use the compute their plan budget was sized
for (55% of the HT price). That is the designed margin, not a loss, but finance should expect Work
provider spend per capped user to rise towards that design.

**Quality risk: none.** Same model, prompts and steps. Runs that were stopped by an inflated ceiling
now finish, so quality goes up.

### Implementation sketch

* `runner/agent-core/src/work/budget.ts`: add `cacheReadMicroUsdPerMillion` to `WorkModelPricing`,
  and price `(inputTokens − cacheRead − cacheWrite) × input + cacheRead × read + cacheWrite × write`.
  Keep a per-request long-context check, using the `longContext` from `tokenRate`, applied **to that
  step's own `inputTokens`**.
* `src/lib/metering/work-pricing.ts`: return `cacheReadMicroUsdPerMillion: micro(rate.cacheRead)`
  and, for Anthropic, the 5m write rate.
* `src/lib/spend.ts` `recordWorkRunSpend`: pass the cache deltas, and stop handing cumulative tokens
  to the single-request recompute. Either pass `requestUsages` (the runner already has per-step
  usage) or mark the row `preReconciled: true`, so `recordSpend` trusts `costUsd`. This is safe
  because the guard is now per request and cache-aware.
* Tests: see M5 (`work-billing-per-request.test.ts`).

### How to measure

Compare `ApiSpend(kind='work')` per run against Σ of per-step `estimateGenerationCostUsd`. Once M4
lands, compare against Anthropic `cost_report` for the run's day. Expected result: the ratio falls
from about 5.6 to about 1.0, and the share of Work runs ending in `budget_exceeded` or the window
limit drops.

---

## M2. Deep-research workers are charged 5x on the default worker model

### What happens

* `researchWorkerModel()` (`src/lib/research/agents/worker.ts:89-119`) prefers Anthropic Haiku and
  resolves to **`claude-haiku-5-5`** (the sim prints `anthropic:claude-haiku-5-5`).
* A worker makes `toolCallsPerWorker + 1` calls: 26, 41, 61 or 81 by tier
  (`src/lib/research/domain.ts:1322-1358`). Each call carries at most `WORKER_CONTEXT_CHARS`
  (80K chars, about 20K tokens) plus a 6K-char system prompt (`domain.ts:2193,2318`). **No single
  request crosses 100K tokens.**
* `runLoop` (`worker.ts:381-417`) adds up the whole loop's input, output and cache tokens and prices
  them as **one** request (`estimateGenerationCostUsd`, then `recordSpend` without `requestUsages`).
  Cumulative input is well over 100K, so `longContextMultipliers` (`pricing.ts:857-863`) multiplies
  every token by 5.
* Anthropic's page says Haiku 5.5's prompt length is per request: "Each request is priced on its
  own".
* The inflated `costMicroUsd` feeds `bill(current, result.costMicroUsd, "worker")`
  (`src/lib/research/stages/workers.ts:714`) and `budgetExhausted` (`engine.ts:171`), and the run
  budget is sized from the window (`engine.ts:416-421`). Workers stop early, and the user's window
  drains 5x faster.
* The chat path had this exact bug and fixed it (`src/lib/turn-pricing.ts` header;
  `scripts/bench-chat-audit.ts:86` "previousAggregateEstimateUsd"). Research workers were left on
  the old path.

### Arithmetic

`sim/sim.ts` models 24 calls, a 3K system prompt growing 2.5K per call, 400 output tokens per call
(762K cumulative input):

* Haiku 5.5, cached: billed $0.0969 against $0.0194 per request, **5.00x**.
* Haiku 5.5, uncached: $0.4050 against $0.0810, 5.00x.
* GPT-6 Luna fallback: 1.97x.
* Gemini 3.1 Pro: 1.96x.
* Haiku 4.5 (no tier): 1.00x.

A whole research run, tier 2 (4 workers × 2 rounds × 41 calls), with these assumptions: about 18K
context per call, about 85% cache read, 400 output tokens per call; search $0.001 and page fetch
$0.0005 (`domain.ts:2104-2106`); planner, lead and writer on Sonnet 5.5 at about $0.26:

* each worker: 41 × (15K × $0.01 + 3K × $0.125 + 400 × $0.50)/M ≈ $0.030 real, $0.149 billed;
* eight worker runs: $0.24 real, $1.19 billed;
* plus about $0.24 in vendor fees and $0.26 for lead and writer.

**Run ledger today ≈ $1.69; at provider truth ≈ $0.74, so −56%.** On a PRO weekly gate of $2.50,
that is 1.5 runs a week today and 3.4 after the fix.

**Quality risk: none.** Billing only. More rounds fit the same budget, so depth goes up.

### Implementation sketch

* `src/lib/research/agents/worker-loop.ts`: keep a `requests: GenerationCostOpts[]` alongside the
  totals (each `turn` already has its own usage at :157-198).
* `worker.ts` `runLoop`: compute `estimateTurnCostUsd(model, total, requests)` and pass
  `requestUsages` to `recordSpend`.
* Route the worker's provider calls through a `createRequestMeter` (role `research.worker`), so they
  also emit `llm.request` lines. The adapter calls in `worker.ts` already read the usage fields
  (:440-600).

### How to measure

Track `ApiSpend(kind='research')` per run ÷ run count before and after. Track the share of runs that
end with `budget`. Use the new `research.worker` `llm.request` lines for `cacheReadShare`. Track
worker rounds completed per run.

---

## M3. Durable telemetry per request and per call site (the instrumentation needed to prove savings)

**Today:** see the "Where costs are recorded" table above.

**Saving: 0% directly.** This is what turns "estimated −34%" (`docs/pricing/COST_ENGINEERING.md` §5)
into a measured number, and what catches the next M1/M2 within a day.

### Design

1. **`callSite` everywhere, as a closed union.** Examples: `chat.turn`, `chat.private`,
   `utility.title`, `utility.follow_ups`, `utility.moderation`, `utility.memory_extraction`,
   `utility.memory_consolidation`, `utility.memory_edit`, `utility.history_summary`,
   `utility.translation`, `utility.preflight`, `research.planner`, `research.lead`,
   `research.worker`, `research.writer`, `research.citation_judge`, `design.edit`, `work.step`,
   `code.proxy`, `batch.dream`, `embed.knowledge`, `embed.memory`, `voice.relay`, `voice.tts`,
   `voice.stt`, `media.*`, `probe.capability`.
   * `src/types/llm.ts`: make `role`/`callSite` **required** on `streamChat` opts (`src/lib/llm.ts:77`).
   * `runUtilityPrompt` (`src/lib/memory.ts:293`) already receives `purpose` and `label`; forward
     `callSite: "utility." + purpose` into `streamChat` and `recordSpend`.
   * `RecordSpendInput` (`src/lib/spend.ts:186`): add a required `callSite`. There are about 20
     writers (`grep recordSpend(`).
2. **`ApiSpend` columns** (nullable, so old rows read as unknown, following the convention the
   `Message.cacheReadTokens` comment sets): `callSite`, `cacheReadTokens`, `cacheWrite5mTokens`,
   `cacheWrite1hTokens`, `cacheWriteTokens`, `reasoningTokens`, `requests` (number of provider
   requests in the row), `generationId` (hashed), `conversationId` (hashed), `serviceTier`
   (standard, batch, flex, priority), `ratesVerified` (the `verified` date of the rate row used).
   Add an index on `(createdAt, callSite)`. One migration in `prisma/migrations/`.
3. **`ProviderRequestDaily` rollup.** Its key is `(day, provider, model, callSite, contextTier,
   prefixVerdictClass)`. Its sums: requests, totalInput, fresh, cacheRead, cacheWrite5m,
   cacheWrite1h, output, reasoning, costMicroUsd, retries, fallbacks, usageMissing.
   * Fed by the `request-meter` sink: an in-process map, flushed every 60 s with
     `INSERT … ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x`. No content and no per-user rows, so
     there is no privacy surface beyond what `llm.request` already logs.
   * Wire the same sink into the research worker (M2), the runner (posting per-step usage with the
     usage report), the agent proxy, `batch/dream.ts` and the relay spend route, so the rollup
     covers every paid path.
4. **Per-user savings view.** Store `Message.reasoningTokens` and the write split, so the native and
   web cost badges and "cost per turn" use one source.

### Metrics this enables

These go on the M4 dashboard.

* **Cache read share by call site** (tokens): `Σ cacheRead / Σ totalInput`. Target for `chat.turn`
  on Anthropic is ≥ 80% (COST_ENGINEERING §6).
* **Cache dollar efficiency:** `1 − cost / cost_if_uncached` per call site, which shows the money
  caching saved.
* **Write readback:** cache-write tokens at request n that were *read* at n+1 within the TTL,
  per `cacheKey`, from the prefix tracker (`src/lib/llm/prefix-diagnostic.ts`). Writes never read
  are pure waste at 1.25x or 2x.
* **Prefix breaks per 100 requests by reason** (`system@i`, `history_rewritten@i`, `tools`, `model`,
  `settings`), from the request meter's `prefix.verdict`.
* **Cost per chat turn, all-in:** `chat.turn` $ plus every `utility.*` row with the same
  `generationId` or `conversationId`, divided by turns. The background overhead estimate today
  (Haiku 5.5: moderation ≈ $0.000145, follow-ups ≈ $0.00028, plus about $0.0002 amortised for
  title, memory and summary) is ≈ $0.0006 per turn, about 5% of a cached Sonnet 5.5 turn.
  Under `same_provider` with an xAI conversation, the pick is `grok-4.3` ($1.25/$2.50), which is
  ≈ $0.005 per turn. That needs measuring, not guessing.
* **Price-normalised cost per turn.** Re-price each period's tokens at one fixed rate table, so the
  Argon and Flash doublings don't hide efficiency gains.

---

## M4. Admin cost report and provider-invoice reconciliation

**Today:** `/admin/turns` shows a 200-turn in-process ring (`src/app/(app)/admin/turns/page.tsx`).
`/api/admin/users` gives a per-user `groupBy` cost (`src/app/api/admin/users/route.ts:77-94`). There
is no per-call-site view, no cache view and no reconciliation. Ledger figures are list-price
*estimates*, and nothing compares them with what the labs invoiced.

### Implementation sketch

* **`/admin/costs`** (owner-gated, like `/admin/turns`), reading `ProviderRequestDaily` and
  `ApiSpend`, with these panels:
  1. Spend by call site, stacked by day.
  2. Cache read share and dollar efficiency per call site and provider.
  3. Prefix-break reasons, top 10.
  4. All-in cost per chat turn, by model and conversation provider.
  5. Background overhead per turn.
  6. Batch share of batch-eligible work, and the `BatchJob` matched/request ratio.
  7. Retries and fallbacks as a % of cost.
  8. **Ledger vs invoice** per provider per day.
* **`scripts/cost-reconcile.ts`.** It reads Anthropic `GET /v1/organizations/cost_report` (daily, in
  USD) and `GET /v1/organizations/usage_report/messages` (`group_by[]=model`, which carries
  uncached, cached and cache-creation tokens), with an Admin API key
  (<https://platform.claude.com/docs/en/manage-claude/usage-cost-api>). It does the same with the
  OpenAI organization usage and costs API and the Google billing export.
  * Alert when `|ledger − invoice| / invoice` is over 5% for a provider-day. Ledger above invoice
    means users are over-charged (M1/M2 would have shown up as Anthropic ledger ≫ invoice). Ledger
    below invoice means a metering hole.
  * Mail it the same way `router/failure-alert.ts` mails the operator.

**Quality risk: none.** These are read-only reports.

---

## M5. Regression tests that pin prefix stability, aux routing and billing

**Already pinned** (keep these):

* `tests/prompt-cache-wire.test.ts`: byte-prefix across tool rounds and turns on the serialized
  Anthropic, Responses and Compat bodies; `"none"` has no markers; the request meter's records.
* `tests/prefix-diagnostic.test.ts`
* `tests/turn-context-tail.test.ts`
* `tests/anthropic-cache-breakpoint.test.ts`
* `tests/openai-prompt-cache.test.ts`
* `runner/agent-core/src/test/prompt-cache*.test.ts`
* `tests/auto-model-cheapest.test.ts`
* `tests/usage-metering-coverage.test.ts` (every paid module listed)

**Add:**

| Test | Pins | Fails today? |
|---|---|---|
| `tests/billing-per-request.test.ts` | For each multi-request writer (chat turn, research worker, Work run, Code proxy): the ledger equals Σ of per-request `estimateGenerationCostUsd` ± 1 µ$. Uses a 24-call Haiku 5.5 worker fixture and a 40-step Sonnet and GPT Work fixture from `sim/*.ts`. | **Yes** (M1, M2) |
| `runner/agent-core/src/test/work-budget.test.ts` (+case) | A step with `cacheReadTokens` is priced at the read rate. A step under 272K is never surcharged however long the run. | **Yes** (M1) |
| `tests/utility-routing.test.ts` | For every `BackgroundPurpose` × every policy mode × every configured lab, the walk's first candidate is cost tier 1. No utility call inherits the conversation's chosen model. `promptCache` defaults to `"none"`. A snapshot of per-lab picks with $ per 1k calls (2K in, 150 out): Haiku 5.5 $0.275, Luna $0.275, Gemini 3.5 Flash-Lite $0.975, grok-4.3 $2.875, … (`sim/util.ts`). A change to the pick shows up as a diff, not a silent price move. | no (pins current behaviour) |
| `tests/research-worker-prefix.test.ts` | On the worker loop's serialized bodies: tools, system and transcript stay a byte prefix between elision jumps (`ELIDE_STEP=4`, `worker-loop.ts:83`), and markers move to the newest block. | unknown (no test exists) |
| `tests/memory-extraction-prefix.test.ts` | Multi-chunk extraction sends a byte-identical system prompt across chunks (it is the only `"short"` utility). | unknown |
| `tests/history-summary-stability.test.ts` | Summary bytes don't change between window jumps (COST_ENGINEERING §2), checked across 8 simulated turns. | unknown |
| `tests/call-site-coverage.test.ts` | Every `streamChat(` and `recordSpend(` call site in `src/`, `scripts/` and `relay/` passes a `callSite` from the union, in the style of `usage-metering-coverage`. | **Yes** (no call site passes one) |
| `tests/rates-freshness.test.ts` | Every `OFFICIAL_RATES` row has `verified` within 45 days. Every model with `cacheRead` has `cacheRead < input`. Every Anthropic row has both `cacheWrite5m` and `cacheWrite1h`. Every `scheduled-prices` change date is in the table's future, or is already applied. | no (13 days old today) |
| `tests/window-sizing.test.ts` (+case) | The budget → windows mapping is pure $ (a cheaper rate table leaves `budgetMicroUsd` unchanged). That keeps "savings pass to users" structural (M8). | no |

---

## M6. Measure reply gaps before choosing the cache TTL for chat history (5m vs 1h)

**Today:** tools and system are cached at 1h, and the conversation marker at 5m
(`src/lib/anthropic-cache.ts`; COST_ENGINEERING §1 #5/#6, marked "Measure it before switching").
Nothing measures it.

**How to measure:** `scripts/cache-ttl-gap-report.ts`, read-only, using `Message.createdAt` per
conversation and no content. It computes the distribution of the gap between an assistant message
and the next user message: p5 = P(gap ≤ 5 min) and p60 = P(gap ≤ 60 min), split by model.

### Arithmetic

Per-turn input cost, in units of base price × tokens, for history H and new tokens Δ:

* 5m TTL: `1.25Δ + p5·r·H + (1−p5)·1.25H`
* 1h TTL: `2Δ + p60·r·H + (1−p60)·2H`

The difference (5m − 1h) is `−0.75Δ + H·(−0.75 + (2−r)·p60 − (1.25−r)·p5)`. For Sonnet and Opus
5.5 (r = 0.05), 1h wins when `1.95·p60 − 1.2·p5 > 0.75 + 0.75Δ/H`.

Examples with H = 12K and Δ = 1.5K on Sonnet 5.5:

| Assumed gaps | 5m TTL | 1h TTL | Result |
|---|---|---|---|
| p5 = 0.5, p60 = 0.85 | 9,675 units = $0.0194 | 7,110 units = $0.0142 | **1h is 26% cheaper on input**, about −19% of the whole turn with 800 output tokens |
| p5 = 0.8, p60 = 0.95 | — | — | 1h is 11% cheaper on input |
| p5 = 0.9, p60 = 0.95 | — | — | **1h is 22% more expensive** |

The data decides. A per-conversation choice is also possible: use 1h only when this conversation's
last gap was over 5 minutes. Anthropic's ordering rule ("1h before 5m") is already met, because
tools and system are 1h.

**Quality risk: none.** Same tokens, same model.

---

## M7. Keep the pricing table current, and price what the other lanes will use

* **Freshness.** Add `tests/rates-freshness.test.ts` (M5), and make `scripts/model-sync/cron.sh` open
  its branch when *any* rate changes. It already does with `MODEL_SYNC_BRANCH=1`; make sure
  production runs with that set.
* **Before any flex adoption** (aux or background on OpenAI): add `serviceTier: "flex"` to
  `GenerationCostOpts` and the ledger, priced at `batchPriceMultiplier`. Without it, flex calls are
  billed at standard price (the "never underbill" max), so users would see no saving. Flex is beta
  with limited models and longer latency (search results for
  <https://developers.openai.com/api/docs/guides/flex-processing>); recheck the model list once the
  host is reachable.
* **Before any Gemini explicit caching:** model storage at $/MTok-hour as a fee row (callSite
  `cache.storage`). Otherwise the ledger undercharges, and an explicit cache can quietly cost more
  than the implicit 10% hits it replaces. The implicit/explicit split and the storage pricing are
  described at <https://ai.google.dev/gemini-api/docs/caching>; the exact rates could not be
  fetched from here.
* **Batch + Haiku 5.5:** the batch price for prompts over 100K is $0.25/$1.25. Keep batch requests
  under 100K each (`src/lib/batch/plan.ts`). The Anthropic batch doc recommends the 1h cache for
  shared context, because batches can take longer than 5 minutes and hits are best-effort
  (<https://platform.claude.com/docs/en/build-with-claude/batch-processing>).
* **Voice:** move the relay rates into the generated table, or pin them with a test against a
  single source. Today `relay/src/providers/registry.ts` duplicates them, and GPT-Live delegation
  is an estimate (USAGE_METERING_AUDIT, "Remaining risks").

**Quality risk: none.**

---

## M8. Passing savings to users (so usage actually gets better)

### Mechanics today

Budgets are fixed dollar amounts, and windows are fixed shares of them. So any reduction in
*charged* cost per unit of work increases how much work fits, 1:1, for users at a limit. Users below
their limit see no change, and the saving becomes margin. There is no message counter to raise.

### Proposals, in order

1. **Fix M1 and M2 first.** They are pure headroom: Work up to 5.6–22x, research runs about 2.3x.
2. **Hold dollar budgets constant as provider costs fall.** Write it into `spend.ts` beside
   `BUDGET_EUR`, and pin it with the window-sizing test (M5). Caching and routing savings then
   reach users automatically. On PRO, a cached Sonnet turn is $0.0126 against $0.044, which is 198
   turns a week instead of 57.
3. **Make the savings visible.** On the usage meters (`src/components/settings/sections/billing.tsx:204-245`
   and the native Usage screen), show "≈ N more messages on <model> this window". Compute it as
   the window remainder ÷ the user's trailing 20-turn median `Message.costMicroUsd` for that model.
   Offer the same as a `GET /api/usage` field, so web, iOS and macOS show one number. When cache
   share rises, N rises, and users can see it.
4. **`API_COST_EUR_PER_USD`.** `eurPerUsd()` (`spend.ts:74-78`) defaults to 1, so €11 is treated as
   $11. If production doesn't set it, plan budgets buy about 8% fewer dollars of model time than the
   euros pay for (at an assumed ~1.08 USD/EUR; check the live rate). Setting it is a one-line env
   change that is +8% headroom on every plan, and it stays inside the 55% design.
5. **Don't exempt background overhead from the windows.** It is about 5% of a turn (M3), and an
   exemption would hide it. Show it as its own line instead; `usage-breakdown.ts` already has a
   `utility` surface.

**Risk.** Margin moves towards the 55% design for capped users. There is no quality risk.

---

## M9. Char floors and "max of two estimates" on rows that already have reported usage

**What happens.** `resolveBillableTokens` lifts the output count to `ceil((answer + reasoning chars)/4)`
whenever that is higher (`src/lib/pricing.ts:998`), even when the provider reported output tokens.
`recordSpend` then keeps `max(fromTokens, fromCaller)` (`spend.ts:299`).

For English on OpenAI-style tokenizers (often over 4 chars per token) the floor can exceed the true
output count on low-reasoning turns. On Claude, chars/4 is usually below the true count, so it
rarely binds. This is unmeasured: I estimate 0–5% of output cost on affected rows.

**Sketch.** Add `floorBound: boolean` to the `llm.request` record and to `ApiSpend`. If it binds on
more than 1% of rows *with* `usageReported: true`, apply floors only when usage is missing.

**Quality risk: none.**

---

## Sources

* Anthropic pricing, fetched 2026-10-31: <https://platform.claude.com/docs/en/about-claude/pricing>
* Anthropic prompt caching: <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
* Anthropic Message Batches: <https://platform.claude.com/docs/en/build-with-claude/batch-processing>
* Anthropic Usage and Cost Admin API: <https://platform.claude.com/docs/en/manage-claude/usage-cost-api>
* OpenAI prompt caching (search result only; host unreachable from this session): <https://developers.openai.com/api/docs/guides/prompt-caching>
* Azure mirror of the OpenAI prompt-caching guide: <https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching>
* OpenAI flex processing (search result only): <https://developers.openai.com/api/docs/guides/flex-processing>
* Gemini context caching (search result only): <https://ai.google.dev/gemini-api/docs/caching>

`developers.openai.com` and `ai.google.dev` must be allowed in this session's network settings
before the OpenAI and Gemini rows can be re-verified.
