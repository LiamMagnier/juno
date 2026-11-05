# Auxiliary model calls: inventory, waste, savings

Dimension: every model call that is **not** the user-visible answer. Repo read at
`e532983ea` (read-only). The user's chosen chat model is never changed by anything
below. Where a call already runs on the user's chosen model (research lead, code
reviewer), the fix keeps that model and only trims thinking or caches.

---

## 0. Method, prices, reference profile

**What "the utility model" is.** Most aux calls go through `runUtilityPrompt`
(`src/lib/memory.ts:293`). It walks `utilityModelCandidates()` (`memory.ts:127`):
up to two FREE-plan chat models per provider, **fastest first**, then filtered by the
background policy (`background-provider-policy.ts:113`, default `same_provider`).
The per-provider order, computed from the registry
(`scratchpad/cost/scripts/utility.ts`):

| Provider | 1st (used) | 2nd (fallback) |
| --- | --- | --- |
| anthropic | claude-haiku-5-5 $0.10/$0.50 | claude-haiku-4-5 $1/$5 (10x) |
| openai | gpt-6-luna $0.10/$0.50 | gpt-5.6-luna $0.20/$1.20 |
| google | gemini-3.5-flash-lite $0.30/$2.50 (MINIMAL thinking) | gemini-3.1-flash-lite (deprecated) |
| zhipu | glm-5.3-flashx $0.37/$1.25 (always thinks) | glm-4.5-flash (legacy, free) |
| minimax | MiniMax-M2.7-highspeed $0.60/$2.40 (deprecated) | MiniMax-M2.5 $0.30/$1.20 |

Thinking is switched off for utility calls wherever the model allows it: OpenAI
gets `reasoning_effort:"none"` (`openai-compat.ts:429-437`), Haiku 5.5 gets
`thinking:disabled` (`anthropic-thinking.ts:174-182`), and Flash-Lite defaults to
MINIMAL. Models whose thinking **cannot** be disabled (`canDisable:false`) run at
their default level when a caller passes no effort. `clampReasoningEffort`
(`model-metrics.ts:1033`) returns `defaultLevel`. Several findings below come from this.

**Prices.** These come from `src/lib/model-rates.generated.ts` (verified 2026-10-18 from the labs'
pages). I re-checked the Anthropic figures today against the official page:

- Haiku 5.5 costs $0.10/$0.50, rising to $0.50/$2.50 above 100K prompt tokens.
- Sonnet 5.5 costs $2/$10, with cache reads at $0.10, 5m writes at $2.50 and 1h writes at $4.
- Opus 5.5 costs $4/$20, with cache reads at $0.20.
- The Batch API is 50% off.
- The minimum cacheable prompt is 512 tokens on Haiku/Sonnet/Opus 5.5 and 4,096 on Haiku 4.5.
- Cache writes cost 1.25x for 5m and 2x for 1h, with up to 4 breakpoints.

OpenAI's and Google's doc hosts would not resolve from this sandbox
(`developers.openai.com` and `ai.google.dev` need to be allowed in network
settings). For those I used web search results and the repo's verified table (§7).

**Reference profile.** This is the "busy Pro user" from `docs/pricing/COST_ENGINEERING.md` §5: 300 chat
turns a month on Sonnet 5.5, costing about **$8.9/month** after the October cache fixes (dreaming included).
I added these aux assumptions, which are stated rather than measured:

- 60 new conversations and 30 return visits a month.
- 70% of web sends pass `quickPreflightSkip`.
- Memory is on.
- 5% of turns are private.
- Half the replies are viewed on a native app.
- The deployment has a Google key (this affects triage, F1).

Token counts are chars/4, the codebase's own rule. Static prompt sizes were measured with
`scratchpad/cost/scripts/prompts.mjs`: triage system 2,903 chars (~730 tok), moderation 1,798 (~450),
judge 844 (~210), title 384 (~100), follow-ups 632 (~160), extraction rules 503 (~125) plus the
known-facts list, consolidation 1,217 (~300), history summary 1,078 (~270), research lead 2,717 (~680).

---

## 1. Inventory: what happens today

| # | Call (file:line) | Trigger / frequency | Model today | In / out tokens (typical) | $/call (ref) | Profile $/mo |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | **Preflight triage**: `preflight-triage.ts:72` (picker), `:249` (`streamChat`), via `app/api/chat/clarify/route.ts:85`, called from `hooks/use-chat.ts:1832` | **Every web send** not skipped by `preflight-clarification.ts:86` (about 70%) | Smartest fast FREE model across **all** configured labs, **not policy-bound**: `gemini-3.8-flash` (i9, $0.75/$3.75; $1.50/$7.50 from 2027-01-01). No effort is passed, so thinking runs at **MEDIUM** (`model-metrics.ts:812`, then `gemini-core.ts:265`) | ~1,500 in (730 system, ≤6×800-char context, ≤2,500-char message) / ~40 JSON + ~400 thinking (assumed) | 1,500×0.75e-6 + 440×3.75e-6 = **$0.0028** (2027: $0.0055) | 210 × 0.0028 = **$0.58** (2027: $1.16) |
| A2 | **AI moderation**: `moderation-ai.ts:227`. Saved turns: `chat/turn/finalize.ts:76`. Private turns: `private-turn.ts:614` | Every non-owner turn (`admission.ts:192`). Private turns re-check **every earlier user message** (`chat-moderation.ts:22-42`, loop at `moderation-ai.ts:270`) | Utility (Haiku 5.5) | ~700 / ~25 (cap 200) | $0.000083 | 300 → $0.025 (+private repeats) |
| A3 | **Memory extraction**: `memory.ts:1515`, `:1669`, `finalize.ts:171` | Every turn with memory on and an answer | Utility | ~1,000 (125 rules + 40 known facts ≈ 600 + message ≤1,200 chars) / ~60 | $0.00013 | $0.039 |
| A4 | **Memory consolidation**, account (`memory.ts:2557` → `:2388`) and project (`:2776` → `:2725`), from `finalize.ts:174-185` | After **every** turn, rebuilds when the fact count changed and ≥5 min have passed (`memory-lifecycle.ts:2019,2046`) | Utility | 5K–12K (facts up to 45,000 chars, `memory.ts:2237`, plus digests, projects and GitHub) / ~800 (cap 1,400) | $0.0009–0.0016 | 30–90 rebuilds → ~$0.08 |
| A4′ | **Hidden cost of A4.** The summary sits in the **cached per-user system tier** (`chat/turn/prompt.ts:105-107`, `system-prompt.ts:435`) | Each mid-session rebuild changes those bytes, so the **next main-model turn rewrites its cache** | (Sonnet 5.5, the user's model) | 1.5K tail at 1h write + 12K history at 5m write, instead of 13.5K cache read | 0.006 + 0.030 − 0.00135 ≈ **+$0.035 per invalidation** | ~18 → **$0.63** |
| A5 | **Titles**: `titles.ts:91`, `app/api/conversations/[id]/title/route.ts:97`. Project name at `titles.ts:201` | Web: phases `thinking`, `writing` and `completed`, each once per conversation **per page session** (`components/chat/chat-view.tsx:855-905`). `onMeta` (`:546`) re-arms it on every turn. The server lets an AI title be renamed again **forever** (`title-ownership.ts`, `canAutoRenameChatTitle`: `source==="ai" → true`). Native: 2 per conversation (`NativeConversationStore.swift:2074`) | Utility | 250–2,700 (≤8 messages) / ~10 | $0.00003–0.00027 | 270 calls → $0.028 |
| A6 | **Follow-up pills**: `app/api/chat/follow-ups/route.ts:162` | Native only: `FollowUpChips.swift:72` and `NativeFollowUpStrip.swift:80` fetch on **every conversation open** and every new reply. The cache is process-local, 10 min, single instance (`follow-up-cache.ts:52`) and lost on restart | Utility | ~2,000 / ~60 (cap 160) | $0.00023 | ~225 → $0.05 |
| A7 | **History rolling summary**: `chat/history-summary-store.ts:126` | Only past 24 messages, once per 8-message step (`context-assembly.ts:30`), incremental, `cheapestFirst` | Utility | ≤5.5K / ~900 | ~$0.001 | ~8 → $0.008 (already efficient) |
| A8 | **Dreaming, backfill, re-reads**: `batch/dream.ts:176`, `memory-dreaming.ts` | Idle ≥10 min, 5 accounts per 10-min tick | Batch API (Anthropic/OpenAI, 50%) | small | $0.0025 | $0.10 (already in the $8.9) |
| A9 | **Agent reflection**: `agents/reflect.ts:146` | Every 6 h per proactive agent (`agents/domain.ts:321`) **even with no new input**. Not batched | Utility | ~2–3K / ≤900 | ~$0.0006 | $0.07 per agent |
| A10 | Research **brief, expand, clarify**: `research/tools.ts:632`, `:928`, `:560` | 1 to a few per run | **Lead model** (the user's model, or the strongest configured). **No effort passed**, so always-on models think at their default: Opus 5.5 medium, Fable high | ≤1K–3K / ≤600 + default thinking | Fable: 1–4K thinking × $50/M = $0.05–0.20 per call (assumed) | per run |
| A11 | Research **lead review**: `research/agents/lead.ts:247` | Once per round | Lead. `promptCache:"short"` is good, but no effort is passed | ~3–6K / review JSON + default thinking | — | per run |
| A12 | Research **citation judge**: `research/claims.ts:207` (utility walk), or the lead model when chosen (`research/run.ts:963-972`) | **One call per claim/passage pair**, up to 24/48/96/160 per run by tier (`research/domain.ts:1328-1364`). `promptCache:"none"` | Utility, or the **user's lead model** with no effort | ~750 / ~40 + default thinking (assumed 400) | Opus 5.5: 750×4e-6 + 440×20e-6 = **$0.0118** | deep run: 96 × 0.0118 = **$1.13 per run** |
| A13 | Research **plan**: `research/tools.ts:655` | 1–2 per run | Lead at **low** (`plannerReasoningEffort`, `tools.ts:360`): already right | — | — | — |
| A14 | **Voice delegate**: `relay/src/providers/gemini-delegate.ts:83,163` | Each "ask_backend_model" during a Gemini Live call | gemini-3.8-flash at low/high by voice tier, with `google_search` attached unless `RELAY_GEMINI_DELEGATE_WEB_SEARCH=0` | 1–3K / short | tokens ≈ $0.002–0.005; **grounding $0.014 per search** after 5,000 free/month (Gemini 3) | grounding fee ≈ 3–10x the token cost |
| A15 | **Code-agent auto-review**: `runner/agent-core/src/harness/auto-review.ts:145` | Every gated tool call in auto mode | **Parent model** (`agent.ts:921-928`, inherited via `routing.ts`), `cache:false` | 360 system + ≤6×2,000-char user instructions + ≤6,000-char call: up to ~5K / ≤300 | Opus 5.5 at 3.3K stable prefix: $0.013 per review of prefix alone | per code session |
| A16 | Memory edit (`app/api/memory/edit/route.ts:107`), Teach (`teach/server.ts:75`), UI translation (`app/api/i18n/translations/route.ts:127`, process cache, $5/day ceiling) | User-initiated or platform | Utility | — | — | negligible |
| A17 | Embeddings: `knowledge/embed.ts:137`. Queries per turn at `memory.ts:1996` and `knowledge/retrieve.ts:311` | Per turn plus on writes | text-embedding-3-small $0.02/M | — | ~$0.00001 | negligible |
| A18 | Health and capability probes: `provider-health.ts:137`, `model-capability.ts:281` | 1-token completion per lab per 10 min | Cheapest-tier model | ~10 / 1 | ~$0 | negligible |

Out of scope because user-visible: chat turns, `channels/reply.ts` (answers on the utility walk), design edit, scheduled tasks, research workers and the writer.

**Profile totals (estimates).**

| | $/month |
| --- | --- |
| Aux calls, excluding dreaming (A1+A2+A3+A4+A5+A6+A7 = 0.58 + 0.025 + 0.039 + 0.08 + 0.028 + 0.05 + 0.008) | **$0.81** |
| Hidden cache invalidation (A4′) | **$0.63** |
| **Aux-attributable total** | **$1.44** |
| **Total spend** (8.9 + 1.44) | **≈ $10.34** |

Aux-attributable spend is therefore about **14% of total**. Triage (A1) and consolidation (A4 + A4′) together are **85% of it**.

Research is billed separately and per run. On a thinking frontier lead, the judge stage alone is about $1.1 for a deep run and $1.9 for a max run.

---

## 2. Findings (ranked by $ × confidence)

### F1. Preflight triage: cheapest qualifying model, lowest thinking, skip follow-ups and plain questions

**Today.** See A1. The picker ranks by intelligence first (`preflight-triage.ts:85-90`), so the
$0.75/$3.75 Gemini 3.8 Flash beats GPT-6 Luna, which is i8, s9, $0.10/$0.50 and thinking-off capable.
No `reasoningEffort` is passed, so 3.8 Flash thinks at MEDIUM. 3.8 Flash has no off and no minimal
setting, only low/medium/high (`model-metrics.ts:812`). That runs against a **2,000 ms** first-attempt
timeout (`preflight-triage.ts:37`), so timeouts, billed attempts and fallbacks are likely (measure this).

Two side issues:

- Triage ignores the background policy, so an Anthropic user's text goes to Google. This is a privacy gap as well as a cost one.
- Triage is metered as role `"chat"`, because no role or `promptCache` is set (`llm.ts:192`).

**Saving.** Three steps, cumulative:

1. Pass the lowest tier on the same model (3.8 Flash "low"; thinking assumed to fall from 400 to 120 tokens). Output becomes 160×3.75e-6 = $0.0006, so the call costs **$0.0017 (−39%)**.
2. Rank the candidates that clear the bar (i≥7, s≥8) by **effective price**. GPT-6 Luna, thinking off, comes first: 1,500×0.1e-6 + 40×0.5e-6 = **$0.00017 per call (−94%)**.
3. Skip deterministically when the conversation already has an assistant reply and the message is not a long build/write/plan request, and skip plain questions (ending in "?" or starting with a wh-word, ≤25 words). `TRIAGE_SYSTEM`'s own NEVER-ask rules already cover these cases. I assume this removes 50% of the remaining calls.

Profile: 210 × $0.0028 = $0.58 becomes 105 × $0.00017 = $0.018. That saves **$0.56/mo, ≈5.4% of total spend and ≈97% of this call site**, and ≈10% of total at 2027 Flash rates.

If you keep Gemini 3.8 Flash and do only steps 1 and 3: 105 × 0.0017 = $0.18, which saves $0.40 (3.9%).

**Quality risk: low** for steps 1 and 3; **low–medium** for step 2 (Luna is graded i8, Gemini i9).

- Validate the model swap offline first: run both models on a fixed eval set of triage prompts and require ≥95% agreement on `needsClarification` plus a blind check of question quality.
- The skip rules only drop cases the triage prompt itself says to answer directly.

**Implementation.**

- `src/lib/preflight-triage.ts`: order `triageModelCandidates` by price among those clearing the bar; pass the lowest supported effort ("none", "minimal" or "low", the same rule as `plannerReasoningEffort`); set `role:"utility:triage"` and `promptCache:"none"`; go through the policy (`resolveBackgroundCandidates`).
- `src/app/api/chat/clarify/route.ts`: pass the conversation provider and policy, and add the follow-up skip from the `recentMessages` count.
- `src/lib/preflight-clarification.ts` `quickPreflightSkip`: add the question-form skip. It is shared with the client, so `use-chat.ts:1811` also saves the round-trip.

**Measure.**

- `llm.request` rows with role `utility:triage`: calls per day, sum of `costUsd`, mean `tokens.reasoning`, p50/p95 latency.
- Count of `[clarify-triage] … timed out` log lines.
- Client: share of sends that showed a clarification card, and its accept/skip rate, before and after.

### F2. Consolidation: never rebuild the summary mid-session; rebuild at idle through the Batch API

**Today.** See A4 and A4′. `maybeConsolidate` runs after every turn. A rebuild every ≥5 min, whenever
any fact was added, rewrites the bytes of the main model's cached per-user system tier, and the next
turn in that chat pays cache writes on the system tail and the whole history.

**Saving.**

- *Invalidations:* about 18/mo × $0.035 = $0.63 falls to near zero. The rebuild happens after ≥10 min idle, when the 5m history cache has expired anyway. The residual is the 1h tail rewrite if the user comes back within the hour: 1.5K × $4/M = $0.006, so 18 × 0.006 = $0.11 in the worst case.
- *Calls:* 30–90 rebuilds fall to about one per session that learned something (~25/mo), at the batch price. 60 × $0.0013 = $0.08 becomes 25 × $0.00065 = $0.016.

Total: **≈$0.6/mo, ≈5.8% of total spend and ≈85% of consolidation-attributable cost.**

**Quality risk: low.** Facts newer than the summary still reach every turn as ranked notes:
`memory.ts:2136-2138` excludes only facts the summary already covers, and the notes ride the per-turn tail.

- Keep the synchronous rebuild or scrub when a **forget** lands after the summary (`summaryPredatesForget`), so privacy is unchanged.
- The explicit "Regenerate" button stays synchronous.
- The memory page may show a summary up to idle time plus one tick old.

**Implementation.**

- `src/lib/chat/turn/finalize.ts:174-185`: replace the inline rebuild with "mark dirty", unless a forget is newer than the summary.
- `src/lib/memory-lifecycle.ts` `summaryRebuildDecision`: return "throttled" while the account was active within `DREAM_IDLE_MINUTES`.
- `scripts/memory-dreamer.ts` and `src/lib/batch/dream.ts`: they already call `maybeConsolidate` with the batch layer. Pick dirty accounts first. The cap of 5 accounts per 10-min tick (720 accounts/day, `memory-dreaming.ts`) must scale or prioritise.

**Measure.**

- `llm.request` rows with role `chat` and `prefix.verdict` starting `system@`, which marks a per-user tier change. Count them per day and sum `tokens.cacheWrite`, before and after.
- `utility:memory/consolidate` calls and cost.
- Fact-to-summary latency.
- Memory eval and bench (`npm run test:memory`, `scripts/memory-bench.ts`) unchanged.

### F3. Research aux calls on thinking leads: lowest thinking tier, and batched citation judging (same model)

**Today.** See A10–A12. `utilityCompletion` passes no effort for brief, expand, clarify, review and the
lead-model judge, so Opus 5.5 thinks at medium and Fable at high on short JSON or prose tasks. The judge
makes one call per claim/passage pair with no caching. The plan call already runs at low (`tools.ts:388`),
which shows the codebase considers low enough here.

**Saving** (Opus 5.5 lead, deep tier, 96 judge calls; thinking assumed 400 at default and 120 at low):

- Low thinking: $0.0118 becomes 750×4e-6 + 160×20e-6 = $0.0062 per call (**−47%**). The run's judge cost falls from $1.13 to $0.60.
- Also batching 4 pairs per call: per pair, input ≈ (230 + 4×530)/4 ≈ 590 tokens = $0.0024, and output ≈ 70 tokens = $0.0014. That is $0.0038 per pair and **$0.36 per run (−68%)**.
- Brief and expand on Fable at high: assumed 1–4K thinking × $50/M = $0.05–0.20 per call, falling to about $0.01–0.03 at low.

The model stays the user's.

**Quality risk.**

- **Low** for brief, expand and clarify.
- **Low–medium** for the judge at low thinking: it is entailment against a ≤1,600-char passage.
- **Medium** for batching: gate it on ≥95% verdict agreement with the per-pair judge on the citation eval set (`tests/research-citations.test.ts` fixtures, claim eval).

**Implementation.**

- `src/lib/research/tools.ts` `utilityCompletion`: when the caller gives no effort, default to `plannerReasoningEffort(model)`. This covers `researchModelCompletion` too.
- `src/lib/research/agents/lead.ts:247`: low effort.
- `src/lib/research/claims.ts` plus `citation-audit-core.ts`: a batched `JudgeCompletion` over N pairs returning a JSON array.
- `src/lib/research/domain.ts`: the cost constants.

**Measure.**

- Per run: `tokens.reasoning` and `costUsd` per label (citation, brief, expand, review).
- Research cost per tier.
- The audit's unverified share and verdict distribution.

### F4. Follow-up pills: persist per reply, generate once, skip when not useful

**Today.** See A6. Every open of a conversation on the Mac or iPhone regenerates the pills once the 10-min
process cache has expired or the backend has restarted.

**Saving.** I assume each reply is fetched 1.5x on average, so persisting the result cuts 33%. Skipping
replies under 200 chars, error or stopped replies, and replies older than 24h with nothing stored cuts
about 20% more. Together about **−45% of calls**: $0.05 becomes $0.028/mo, 0.2% of total.

**Quality risk: none** (the same text is served).

Optional merge: on a native first exchange, combine title `completed` and follow-ups in one call, saving one call per new chat.

**Implementation.** In `src/app/api/chat/follow-ups/route.ts`, store the result keyed by (assistant message id, content hash), for example an encrypted JSON column on `Message`. Keep `follow-up-cache.ts` for in-flight dedupe.

**Measure.** `utility:follow-ups` calls per assistant message (target ≤1.0), and pill click-through.

### F5. Titles: drop the `writing` phase; stop renaming AI titles after the first exchange

**Today.** See A5. A web chat makes 3 calls when it is new and 3 more on the first send of every later page session,
for a title whose context, the first 8 messages, barely changes.

**Saving.** New chats go from 3 to 2 calls and return visits from 3 to 0. Profile: 270 calls become 120 (**−56%**), $0.028 becomes $0.012.

**Quality risk: none or low.** The `completed` call sees strictly more than `writing`.

**Implementation.**

- `src/components/chat/chat-view.tsx:892`: remove the `writing` scheduling.
- The title route: when `titleSource==="ai"` and the conversation has more than 2 messages, return `renamed:false`, or skip when a stored hash of the title context is unchanged.

**Measure.** `utility:title` calls per new conversation (target ≤2) and per returning conversation (≈0).

### F6. Memory extraction: skip trivial turns, coalesce, defer to idle and batch

**Today.** See A3. Each turn pays about 750 tokens of per-user rules and known facts to read a message that is often one line.

**Saving.**

- Skip deterministically: ≤12 chars, acknowledgements, "continue", "thanks", pure code or paste. Assumed 30% of turns.
- Extract inline only when ≥3 user messages or ≥1,500 chars are unprocessed. Otherwise leave it to the dreamer at idle; the high-water mark already makes this resumable.
- Amortised input falls from (750+250)/1 to (750+3×250)/3 = 500 tokens (**−50%**), and deferred chunks get the batch price (**−50%** again on that share).

Together **≈−65–75%**: $0.039 becomes about $0.012/mo.

**Quality risk: low.**

- Within a chat, the facts are already in context.
- The chat model's own `<juno:memory>` tags (`system-prompt.ts:415`) still save explicit facts immediately.
- Cross-chat availability is delayed by up to about 20 min.

**Implementation.** `src/lib/memory.ts` `extractConversationMemory` (threshold option), `finalize.ts:171`, and the dreamer, which already reads pending conversations.

**Measure.** Extraction calls per turn, facts created per 100 user messages, and memory-bench recall unchanged.

### F7. Private-mode moderation is O(N²)

**Today.** See A2. Each private request re-classifies every earlier user message in the client-held history, up to 12 with
`HISTORY_LIMIT` 24 (`context-assembly.ts:18`), one after another. A 12-turn private chat makes 78 calls instead of 12.

**Saving.** Keep "clean" verdicts keyed by an HMAC of (userId, text) in a process-local LRU for 24h, and classify only unseen texts.

- 78 calls become 12 (−85%); steady state goes from 12 calls per turn to 1 (−92%).
- Dollars are small on Haiku (about $0.004/mo in the profile), but it removes up to 12 sequential model calls from `after()`.

**Quality risk: none.** New or edited text has a new HMAC and is still classified, and hits are recorded as today.
No plaintext is retained.

**Implementation.** `src/lib/moderation-ai.ts` `moderateUserMessages`.

**Measure.** Classify calls per private request (target ≈1).

### F8. Rank utility candidates by real price, not speed; keep deprecated "highspeed" tiers out

**Today.** See §0. Speed comes first (`memory.ts:137`), and `cheapestFirst` sorts by the coarse 1/2/3 `cost` tier.

- Zhipu uses glm-5.3-flashx ($0.37/$1.25, always thinks) over glm-5.3-flash ($0.15/$0.50, the same i8 grade).
- MiniMax uses the deprecated M2.7-highspeed ($0.60/$2.40) over M2.5 ($0.30/$1.20).

**Saving.** About −60% on every aux call of Zhipu conversations and −50% for MiniMax; zero for Anthropic, OpenAI and Google, whose picks are already the cheapest.
Weighted by an assumed ≤10% share of conversations on those labs: about −5% of aux spend.

**Quality risk: low** (same grade, slower). Aux jobs run in `after()` or at idle and do not need s10.

**Implementation.** `memory.ts` `utilityModelCandidates`: an effective-price key from `getModelMetrics` (input + output weight + expected thinking for `canDisable:false`), drop deprecated models unless they are the only option, and keep speed-first only for interactive purposes. Apply the same to `batch/dream.ts` `chooseBatchModel`.

**Measure.** Utility $/call by provider in `llm.request`.

### F9. Agent reflection: skip when nothing changed; batch the rest

**Today.** See A9. Reflection runs 4 times a day per proactive agent even when it has no new tasks, notes, goal check-ins or idea decisions.

**Saving.** I assume 60% of runs would be skipped and the rest batched (Batch API, 50%): **−80%**, so $0.07 per agent per month becomes about $0.014.

**Quality risk: low.** With no new input, the ideas would repeat. Goal check-ins that are due still force a run.

**Implementation.** `src/lib/agents/reflect.ts`: a pre-check comparing the max `updatedAt` of its inputs with `lastReflectedAt`, before the claim. For batching, `reflect-sweep.ts` and the batch layer (COST_ENGINEERING §3 lists this as "not batched yet").

**Measure.** Reflections per agent per day, and the idea accept rate.

### F10. Voice delegate grounding fee: measure, then gate search

**Today.** See A14. Google Search grounding is attached to every delegate call. Each grounded search costs $0.014
after 5,000 free a month (Gemini 3 bills per search query), which is 3–10x the call's tokens. The prompt
also invites delegation for calculations and reasoning, which never need search.

**Saving.** $0.014 for each grounded call avoided. This depends on the grounded share, which is unmeasured.

**Quality risk: medium.** The voice model could misjudge how recent the information must be.

**Implementation.** `relay/src/providers/gemini-delegate.ts`: add `needs_current_info: BOOLEAN` to `GEMINI_DELEGATE_DECLARATION`, and send `tools:[{google_search:{}}]` only when it is true.

**Measure first.** The share of delegate calls whose response has `groundingMetadata`, and searches per call. Count the existing `onCostUsd` charges with `grounded=true`.

### F11. Code-agent auto-review: cache the stable prefix (same model)

**Today.** See A15. The call uses `cache:false`, while the system prompt and user-instructions block are byte-identical
across reviews in a session.

**Saving.** Opus 5.5 with a 3.3K prefix and 10 reviews:

- Today: 10 × 3.3K × $4/M = $0.132.
- Cached: one 5m write (3.3K × $5/M = $0.0165) plus 9 reads (3.3K × $0.20/M each, $0.006 total) = $0.022.

That is **−83% on the prefix input**.

**Quality risk: none** (same model, same bytes). Routing the reviewer to a fast sibling is **not** recommended without a safety eval.

**Implementation.** `runner/agent-core/src/harness/auto-review.ts:145`: use the short cache, with `user_instructions` inside the cached prefix and `pending_call` last.

**Measure.** The reviewer's cache-read share in runner usage.

### F12. OpenAI flex tier for non-urgent synchronous aux work (verify model support)

**What.** For OpenAI-routed aux calls that nobody waits on and that are not already batched, set `service_tier:"flex"`:
extraction (F6 inline remainder), reflection, consolidation fallback, and durable-run judge or brief on OpenAI leads.

- Flex bills at Batch rates (about 50%) with higher latency.
- "Resource unavailable" responses are not charged; fall back to standard when they happen.

**Saving.** About −50% on those calls for OpenAI accounts.

**Quality risk: none** (same model; latency only).

**Caveat.** Sandbox DNS blocked `developers.openai.com`. Secondary sources say flex covers the GPT-5.6 Sol/Terra/Luna line. Confirm GPT-6 Luna and GPT-6.1 Sol on the official pricing page first.

**Implementation.**

- `openai-responses.ts` and `openai-compat.ts`, next to the existing `service_tier = "priority"` (`openai-compat.ts:421`).
- A `serviceTier` option threaded from `runUtilityPrompt`.
- `pricing.ts`: bill flex at the batch multiplier.

**Measure.** Flex 429 rate and cost per call.

### F13 (enabler). Label every aux call so the savings can be measured

**Today.**

- `runUtilityPrompt` sends no role (`memory.ts:469-476`), so every site is just `"utility"`.
- Triage is logged as `"chat"`.
- Research `utilityCompletion` logs as `"utility"`, not research.
- `ApiSpend` rows of kind `utility` carry no purpose, so the usage page cannot say which aux site spends.
- `attemptTriage` bills timeouts at a character floor with no output, which under-reports thinking spent before the abort.

**Fix.**

- Pass `role: \`utility:${label}\`` from `runUtilityPrompt`, `"utility:triage"` from triage, and `research:${label}` from research.
- Add `source: label` to these `recordSpend` calls.
- Read the provider's usage on abort where the stream delivered it.

**Saving.** None directly; this is how F1–F12 are verified.

**Quality risk: none.**

---

## 3. Not recommended or already optimal

- **History summary (A7):** incremental, step-aligned (moves once per 8 messages), `cheapestFirst`, bounded. Keep.
- **Dreaming (A8):** already on the Batch API. Wiring Gemini Batch would be a separate small gain.
- **Merging moderation into extraction:** it saves only about 250 tokens a turn. Moderation is budget-exempt and runs when generation failed; extraction is budget-gated and runs only on an answer. The coupling risk is medium. Skip.
- **Merging triage into the answer:** this would change the answer path. Excluded.
- **Prompt caching for the small static aux prompts** (moderation ~450, judge ~210, title ~100, follow-ups ~160 tokens): below the minimums (OpenAI 1,024; Haiku 5.5 512 tokens). Extraction's per-user ~750-token prompt could use a "short" cache when turns are <5 min apart, worth ≤$0.01/mo; F6 coalescing makes it moot.
- **Embeddings and health probes:** negligible.
- **UI translation:** already cached and capped. It could be pre-generated at build time to remove it entirely.

---

## 4. Roll-up for the reference profile

| | Before $/mo | After $/mo |
| --- | --- | --- |
| Triage (F1) | 0.58 | 0.02 |
| Consolidation calls and invalidations (F2) | 0.71 | 0.03–0.13 |
| Extraction (F6) | 0.039 | 0.012 |
| Follow-ups (F4) | 0.05 | 0.028 |
| Titles (F5) | 0.028 | 0.012 |
| Moderation (F7) | 0.025+ | ~0.021 |
| History summary | 0.008 | 0.008 |
| **Aux-attributable** | **≈1.44** | **≈0.13–0.23** |
| **Total spend** | **≈10.34** | **≈9.1** |

That is **≈−12% of total spend** (−84–91% of aux-attributable spend) with the chat model untouched.
After 2027-01-01, when Gemini Flash doubles, F1 alone is worth ≈10% of total.

Research is separate. For runs whose lead is a thinking frontier model, F3 cuts the judge stage
by 47–68% ($1.13 → $0.36–0.60 per deep run on Opus 5.5), plus most of the brief and expand thinking.

---

## 5. Verification queries (after deploy)

1. **Aux spend by site.** Group the `llm.request` log lines by `role`, summing `costUsd`, `tokens.output`, `tokens.reasoning` and counting calls per day. Compare 7 days before and after each change.
2. **Cache invalidations caused by memory.** Count `role=chat` records with `prefix.verdict` matching `^system@`, and their `tokens.cacheWrite`, joined in time with `MemorySummary.updatedAt`.
3. **Triage health.** `[clarify-triage]` timeout lines per day, and the clarification card shown and accepted rates.
4. **Quality guards.**
   - memory-bench and memory-eval recall.
   - Citation-eval verdict agreement (F3).
   - Shadow agreement of the triage decision on an eval set (F1).
   - Pill click-through (F4).
   - Title regenerations per conversation (F5).

---

## 6. Assumptions to replace with real numbers

These are unmeasured inputs that the estimates above rest on.

- Thinking tokens per light call: 3.8 Flash at MEDIUM ≈ 400, at LOW ≈ 120; Opus 5.5 default ≈ 400, low ≈ 120; Fable high on a brief 1–4K.
- 70% of web sends reach triage, and 50% of those are follow-ups or questions.
- About 18 mid-session summary rebuilds a month are each followed by a warm-cache turn.
- 1.5 views per reply on native.
- 5% private turns.
- 60 new conversations and 30 revisits a month.

---

## 7. Sources

- Anthropic pricing (fetched 2026-10-31): https://platform.claude.com/docs/en/about-claude/pricing. Haiku 5.5 $0.10/$0.50 (≤100K prompt), batch 50%, Sonnet/Opus 5.5 cache hits 0.05x.
- Anthropic prompt caching (fetched 2026-10-31): https://platform.claude.com/docs/en/build-with-claude/prompt-caching. Minimum 512 tokens on Haiku/Sonnet/Opus 5.5, 4,096 on Haiku 4.5; 5m write 1.25x, 1h write 2x; 4 breakpoints; hits refresh the TTL.
- OpenAI flex processing: https://developers.openai.com/api/docs/guides/flex-processing (found by search; not fetchable from this sandbox).
- Secondary sources on flex: https://www.maginative.com/article/openai-introduces-flex-processing-lower-prices-for-non-urgent-ai-workloads/ and https://dev.classmethod.jp/en/articles/openai-flex-processing/ (Batch-rate pricing; GPT-5.6 Luna/Terra/Sol support flex).
- OpenAI pricing: https://developers.openai.com/api/docs/pricing (not reachable here; the repo's `model-rates.generated.ts` verified 2026-10-18 lists GPT-6 Luna at $0.10/$0.50, cached $0.01).
- Google pricing: https://ai.google.dev/pricing (search snippet). Grounding on Gemini 3: 5,000 free searches/month, then $14 per 1,000 searches, billed per search query. The Gemini 3.8 Flash rate change on 2027-01-01 matches `model-metrics.ts:131` and `relay/src/providers/gemini-delegate.ts`.
- Gemini caching: https://ai.google.dev/gemini-api/docs/caching (not reachable from this sandbox; the implicit-cache minimums are unverified here).
- Repo: `docs/pricing/COST_ENGINEERING.md` §1 #16, §1 #23, §3 and §5 (baseline profile and the existing aux cache fixes).
