# Aux-routing findings: verification

**Reviewer:** principal engineer, model quality. **Dimension:** aux-routing. **Repo:** `/home/user/juno` at `e532983ea`, read-only.
**Input:** `scratchpad/cost/aux-routing-findings.md` (F1–F13).
**Rule applied:**
- The user-chosen model and its answers stay the same.
- No added latency on an interactive turn.
- No new cross-user exposure.
- Anything that changes a user-visible output either ships behind an eval or is rejected.

Scripts I ran (all in `scratchpad/cost/`):
- `verify-aux-cands.ts`: triage and utility candidate lists.
- `verify-aux-lite.ts`: default thinking for each utility pick.
- `verify-aux-anth.ts`: Anthropic thinking parameters with no effort passed.
- `verify-aux-calc.mjs`: every $ figure below.

Each was run with `scratchpad/bin/node node_modules/.bin/tsx` against the real registry modules.

---

## 0. Verdict summary

| # | Item | Verdict | Profile $/mo saved (ref. Pro user, $10.34/mo) | Ships |
| --- | --- | --- | --- | --- |
| K1 | **(New)** Utility/triage calls send the **lowest thinking tier to models that cannot turn thinking off** (Flash-Lite runs at MEDIUM by a catalog-order bug; GLM-5.3 runs at MAX) | **KEPT** | $0 for Anthropic/OpenAI/Qwen accounts. ≈$0.5/mo per Gemini-policy account, ≈$0.6–1.6 per Zhipu account (assumed thinking volumes) | Titles/pills now. Memory jobs after memory-bench. Moderation after test-moderation |
| K2 | F1 triage: low thinking now; price-ranked model only behind a triage eval; fix role label | **KEPT (narrowed)** | $0.11–0.22 now; up to $0.27–0.55 if the eval clears Luna | Step 1 now, step 2 eval-gated |
| K3 | F2 consolidation: no mid-session summary rebuild (staleness cap, forget path, dreamer selection) | **KEPT (amended)** | ≈$0.45–0.6 | After memory-bench |
| K4 | F3 narrowed: `expand` and the lead-model **citation judge** at the lowest tier, **only on always-on leads** | **KEPT (eval-gated)** | per research run: Opus 5.5 deep −$0.54, max −$0.90 (assumed thinking) | Judge blocked on a live-judge eval |
| K5 | F8: rank utility candidates by effective price within a provider | **KEPT** | −60% of Zhipu-account aux spend; $0 for A/O/G | Now |
| K6 | F4: persist follow-up pills per reply | **KEPT** | ≈$0.02 | Now (low priority) |
| K7 | F5 narrowed: skip titling when the title context is frozen | **KEPT (narrowed)** | ≈$0.01 | Now (low priority) |
| K8 | F7: private-mode moderation verdict cache | **KEPT** | ≈$0.005 (mainly removes up to 12 serial calls) | Now |
| K9 | F9 narrowed: reflection skip-when-unchanged with a daily floor | **KEPT (narrowed)** | ≈$0.05/idle agent | Now; batching is BF-4 |
| K10 | F11: auto-review prompt cache with an **explicit breakpoint after the user instructions** | **KEPT (amended)** | Code sessions: −83% of the reviewer's prefix input when the prefix is ≥512 tok; 0 below | Now |
| K11 | F13: label aux calls; meter triage aborts | **KEPT (corrected)** | enabler | First |
| — | F6 extraction coalescing | **MERGED into batch-flex BF-1** (count once there). The trivial-skip part is narrowed (see R6) | — | — |
| — | F12 OpenAI flex | **MERGED into batch-flex BF-3/BF-5** (not counted here) | — | — |
| — | F9 batching | **MERGED into BF-4** | — | — |
| R1–R9 | see §3 | **REJECTED** | — | — |

**Roll-up (reference Anthropic/Sonnet 5.5 profile, kept items only, no double counting):**
- **Immediately:** K2 step 1 ($0.11–0.22) + K3 (≈$0.5) + K6/K7/K8 (≈$0.035) ≈ **$0.65–0.75/mo, about 6–7% of $10.34**.
- **If the triage eval clears GPT-6 Luna** (K2 step 2): **$0.8–1.1/mo, 8–10%**.

The findings file claimed ≈$1.2 (−12%). The difference comes from three corrections:
- Triage call volume: the native apps never call `/api/chat/clarify`, so it is 105–210 calls a month, not 210.
- The rejected deterministic triage skips.
- The rejected title rule.

Gemini- and Zhipu-policy accounts get K1 on top, which is the largest aux lever for them.

---

## 1. What I confirmed, and what I corrected in the source

**Confirmed in code (file:line as of `e532983ea`):**
- **Triage.** `triageModelCandidates` ranks by intelligence first (`src/lib/preflight-triage.ts:79-90`). If Google is configured, it picks `gemini-3.8-flash` (i9 s8, $0.75/$3.75), then `glm-5.3-flashx`, then `gpt-6-luna`.
- **Triage effort and timeout.** No `reasoningEffort` is passed (`:249`), so `geminiThinkingConfig` sends `thinkingLevel: "MEDIUM"`. I ran it: `clamp(null) = medium`. The first-attempt timeout is 2,000 ms (`:37`). Triage is **on the send critical path**: `use-chat.ts:1820` sets status `checking` and awaits it, with a 3.5 s client abort.
- **Triage metering.** No `role` and no `promptCache` are passed, so `llm.ts:192` labels it `"chat"`.
- **Triage crosses providers.** It ignores the background policy, and `background-provider-policy.ts:5-8` defines it as background work.
- **Utility calls send no effort.** `runUtilityPrompt` passes no `reasoningEffort` (`src/lib/memory.ts:470-476`). Haiku 5.5 → `thinking:{type:"disabled"}` (verified). GPT-6 Luna → `reasoning_effort:"none"` (`openai-compat.ts:429-437`; Responses path `mapResponsesEffort`).
- **Summary placement.** The memory summary is in the per-user `variable` system section (`src/lib/chat/system-prompt.ts:431-441`). The official caching docs confirm that a system change invalidates system and messages caches (tools → system → messages).
- **Consolidation runs after every turn.** `finalize.ts:174-185` calls `maybeConsolidate` after every answered turn, with a 5-min throttle (`memory-lifecycle.ts:2019,2046`).
- **Follow-ups.** The native apps refetch pills on every display of a reply (`native/macOS/JunoDesktop/App/FollowUpChips.swift:71-74`). The server cache is process-local, 10 min (`src/lib/chat/follow-up-cache.ts`). **The web app never calls `/api/chat/follow-ups`** (grep: no caller in `src/`).
- **Titles.** A web chat schedules `first_user`, `thinking`, `writing` and `completed` through one debounce (`chat-view.tsx:854-900`). `canAutoRenameChatTitle` returns true for `source==="ai"` (`src/lib/title-ownership.ts:110`).
- **Private moderation.** It re-classifies every user text in the client-held history, serially (`src/lib/chat-moderation.ts:21-41`, `src/lib/moderation-ai.ts:270`).
- **Reflection.** It claims the agent and calls the model with no "anything changed?" test (`src/lib/agents/reflect.ts:90-176`).
- **Auto-review.** It calls the parent model with `cache:false`, maxTokens 300 and no effort (`runner/agent-core/src/harness/auto-review.ts:145-152`). On Opus 5.5 that is adaptive thinking at medium.

**Corrections to the findings file:**

1. **"Flash-Lite defaults to MINIMAL" is false.** In `src/lib/model-metrics.ts`, the branch `/3\.[56]-flash/` (line 815, default `medium`) is tested **before** `/3\.5-flash-lite/` (line 844, intended default `minimal`). The second branch is unreachable for `gemini-3.5-flash-lite`. I ran it: `defaultLevel: "medium"`, `geminiThinkingConfig(undefined) = {thinkingLevel:"MEDIUM"}`.
   - Every Gemini-policy utility call (titles, pills, extraction, consolidation, moderation, summaries) therefore thinks at MEDIUM, billed at the $2.50/M output rate.
   - This is the basis of K1.
2. **GLM-5.3 Flash/FlashX run utility calls at MAX** (`model-metrics.ts` zhipu branch: `caps(["low","high","max"], false, false, "max")`; I ran it: `clamp(null)=max`). The findings said only "always thinks".
3. **Triage volume.** Only the web sends triage (`src/hooks/use-chat.ts` is the only caller). The profile's "half on native" therefore means 105–210 triage calls a month, not 210.
4. **Research brief and clarify are dead paths in production.**
   - Both engines set `draftPlan` (`src/lib/research/run.ts:946,1030`).
   - `planning.ts:73` skips `clarify` whenever `draftPlan` exists.
   - `planning.ts:313` routes planning to `doStructuredPlanning`, so `planResearchQueries` (the brief call) never runs.
   - Live aux calls on the lead are `expand` (`tools.ts:928`), the review (`agents/lead.ts:247`), and the citation judge when the person chose the model (`run.ts:963-972`).
   - The structured planner already runs at low (`tools.ts:388-400`).
5. **`plannerReasoningEffort` is the wrong helper for "lowest tier".**
   - It returns `"low"` for models that *can* disable thinking (Haiku 5.5, GPT-6 Luna, Sonnet 5.5).
   - Passing it where callers send no effort today would turn thinking **on**: Haiku 5.5 goes from `disabled` to adaptive low; Luna from `none` to `low`.
   - That costs more and changes outputs.
   - F1's and F3's implementation notes must use a new floor helper (K1).
6. **F11's 3.3K-token prefix is the maximum** (6 × 2,000 chars). Two corrections:
   - The system policy alone is ≈360 tokens, below the 512-token minimum, and typical sessions carry short instructions. Caching only applies when system + instructions ≥ the model minimum.
   - The generic runner `cache:true` path puts the breakpoint on the **newest** block (`markConversationBreakpoints`), which here contains the pending call. That would pay a 1.25x write every review and read nothing. An explicit breakpoint is required (K10).
7. **F13's `source: label` field.** `recordSpend` `source` is `"web" | "app"` (`src/lib/spend.ts:201`), not a purpose. Use the `llm.request` `role` instead, or add a new `purpose` column.
8. **The dreamer does not select accounts whose conversations are all processed** (`src/lib/memory-dreamer.ts:50-66`). Moving rebuilds there (F2) needs a "summary dirty" selection clause.

**Provider rules checked against official docs:**
- **Anthropic pricing page** (fetched 2026-10-31):
  - Haiku 5.5: $0.10/$0.50 at ≤100K prompt tokens, rising to $0.50/$2.50 above.
  - Sonnet 5.5: $2/$10, with 5m writes $2.50, 1h writes $4, hits $0.10.
  - Opus 5.5: $4/$20, with 5m writes $5, 1h writes $8, hits $0.20.
  - Batch: −50%.
- **Anthropic prompt-caching page** (fetched 2026-10-31):
  - Minimum cacheable prompt: 512 tokens on Haiku/Sonnet/Opus 5.5, 4,096 on Haiku 4.5.
  - Up to 4 breakpoints and a 20-block lookback.
  - A system change invalidates the system and messages caches.
  - Caches are isolated per organization and, on the Claude API, per workspace.
- **Gemini 3 grounding:** per *executed search query*, $14/1,000 after 5,000 free a month. This comes from search snippets of the official pricing page; ai.google.dev itself was blocked.
- **OpenAI flex:** priced at Batch rates, and "Resource Unavailable" responses are not billed. This comes from search snippets of the official guide; developers.openai.com was blocked.
- Gemini and OpenAI official pages could not be fetched. **`ai.google.dev` and `developers.openai.com` must be allowed in the session's network settings** to close this.

---

## 2. Kept items

### K1 (new). Lowest thinking tier for aux calls on models that cannot turn thinking off

**Today.**
- `runUtilityPrompt` and triage send no effort.
- Models with `canDisable:true` already run non-thinking: Haiku 5.5 (disabled), GPT-6 Luna (none), Qwen 3.8 Flash (off).
- Always-on models run at their catalog default:
  - Gemini 3.5 Flash-Lite at **MEDIUM**, because of the catalog-order bug.
  - GLM-5.3 Flash/FlashX at **MAX**.
  - Gemini 3.8 Flash (triage) at **MEDIUM**.
- `streamChat` also adds the 16,384-token "high" allowance to these (`llm.ts:145-150`).

So the product's own baseline, on its two main labs, is *non-thinking* aux work. The Gemini and Zhipu runs think by accident, not by design.

**Change.**
- Add `utilityReasoningFloor(model)` to `src/lib/model-metrics.ts`:
  - It returns `undefined` when `!model.reasoning`, `canDisable`, `onOff`, or there are no tiers. Callers stay exactly as they are today.
  - Otherwise it returns the shallowest tier in `TIER_ORDER` that the model lists: `minimal` on Flash-Lite, `low` on GLM-5.3 and Gemini 3.8 Flash.
- Add a `reasoning?: "floor" | "default"` option to `runUtilityPrompt`. The default stays `"default"`, so nothing changes unless a caller opts in.
- Opt in per label:
  - **Now (decoration only):** `titles` (`src/lib/titles.ts`), `follow-ups` (`src/app/api/chat/follow-ups/route.ts`).
  - **After memory-bench parity:** `memory/extract` and `memory/consolidate*` (`src/lib/memory.ts`), dreaming (`src/lib/batch/dream.ts`, `src/lib/memory-dreaming.ts`), `chat/history-summary` (`src/lib/chat/history-summary-store.ts`), `agent-reflection` (`src/lib/agents/reflect.ts`).
  - **After `npm run test:moderation` parity:** moderation (`src/lib/moderation-ai.ts`), which is safety.
  - **Never:**
    - `src/lib/channels/reply.ts` (user-visible answers).
    - `src/lib/teach/server.ts`.
    - `src/app/api/memory/edit/route.ts` (user waits on an exact edit).
    - `src/app/api/i18n/translations/route.ts` (UI copy).
    - Research claim analysis (`src/lib/research/claim-analysis.ts`; research is handled under K4).
- **Do not "fix" the catalog default for Flash-Lite as a cost lever.** That would change the thinking level of users who *chose* Flash-Lite for chat (R9). Report the ordering bug to the owner as a product decision.

**Saving** (assumptions: thinking tokens saved per call are 250 on Flash-Lite and 1,500 on GLM-5.3; ~860 non-moderation aux calls a month in the profile):
- Gemini account: 860 × 250 × $2.50/M ≈ **$0.54/mo**.
- Zhipu account: 860 × 1,500 × $1.25/M ≈ **$1.61/mo** on FlashX, or **$0.65** on Flash after K5.
- Anthropic, OpenAI and Qwen accounts: **$0**.
- The latency gain is real on every account where it applies.

**Quality risk.**
- **None** for titles and pills, which are decoration and already non-thinking on Haiku/Luna.
- **Low** for memory jobs, gated on memory-bench.
- **Low–medium** for moderation, gated on test-moderation, or left out.

**Tests.**
- `tests/model-reasoning-capabilities.test.ts`: assert `utilityReasoningFloor`:
  - `gemini-3.5-flash-lite` → `minimal`
  - `glm-5.3-flash(x)` → `low`
  - `gemini-3.8-flash` → `low`
  - `claude-haiku-5-5` → `undefined`
  - `gpt-6-luna` → `undefined`
  - `claude-opus-5-5` → `low`
- `tests/utility-attempt.test.ts`: `runUtilityPrompt({reasoning:"floor"})` forwards the floor to `streamChat`, and the default forwards nothing.
- `tests/background-provider-callers.test.ts`: the "never" callers do not pass `"floor"`.
- `npm run test:memory`, `scripts/memory-bench.ts` (before vs after, same seed), `npm run test:moderation`.

**Measure.**
- `llm.request` rows with role `utility*`, grouped by provider and model: mean `tokens.reasoning`, `costUsd` per call, p50/p95 latency, 7 days before and after.
- The share of attempts that timed out (`[label] … timed out after` lines).

### K2. F1 triage: low thinking now, cheaper model only behind an eval

**Step 1 (ship now).**
- Pass `utilityReasoningFloor(model)` in `attemptTriage` (`src/lib/preflight-triage.ts:249`). That is `low` on 3.8 Flash and `low` on GLM. Luna stays `none`.
- Set `role: "utility:triage"` and `promptCache: "none"`.
- **Per call** (assumptions: ~1,500 tokens in, 40 JSON out, 400 thinking at MEDIUM vs 120 at LOW): $0.0028 → **$0.0017 (−38%)**.
- **Per month** at 105–210 calls: $0.29–0.58 → $0.18–0.36, **saving $0.11–0.22/mo**.
- **From 2027-01-01** (Flash at $1.50/$7.50): saving $0.22–0.44.
- **Latency:** this *reduces* time-to-first-token on every non-skipped web send, because triage is on the critical path, and it lowers 2 s timeouts.

**Step 2 (eval-gated).**
- Rank the candidates that clear the bar (i ≥ 7, s ≥ 8) by effective price: input + output + the expected thinking at the floor tier.
- On today's registry, `gpt-6-luna` instant comes first: **$0.00017/call (−94%)**, total $0.018–0.036/mo, saving **$0.27–0.55/mo**.
- This also removes the GLM-at-MAX fallback, which cannot finish in its ≤800 ms leftover window.
- **Gate:**
  - Extend `scripts/test-clarify.ts` with a fixed labelled set (≥150 prompts covering follow-ups, questions, build requests and non-English).
  - Require ≥95% agreement on `needsClarification` with the current model.
  - Require a blind pairwise check of question quality with no loss.
  - Require no rise in timeouts.
- If Luna fails, keep Gemini 3.8 Flash at low (step 1 only).

**Owner decision, not a cost item.**
- Triage sends conversation text to a different lab than the user chose, which breaks the `same_provider` default.
- Binding it to the policy would leave Anthropic conversations with no eligible triage model (Haiku 5.5 is graded s6/i5), so clarifications would disappear there.
- Raise this separately.

**Files.**
- `src/lib/preflight-triage.ts` (candidate order, effort, role).
- `src/lib/model-metrics.ts` (floor helper, from K1).

**Tests.**
- **New** `tests/preflight-triage.test.ts`:
  - The ordering is price-first among eligible models when the step-2 flag is on.
  - The floor effort is forwarded.
  - The role is `utility:triage`.
- `scripts/test-clarify.ts`: agreement report.

**Measure.**
- `llm.request` rows with role `utility:triage`: calls/day, `costUsd`, `tokens.reasoning`, p50/p95.
- `[clarify-triage] … timed out` lines per day.
- Client clarification-card show and accept rate, before and after.

### K3. F2 consolidation: no summary rebuild while the account is active

**Mechanism confirmed.** A rebuild rewrites the per-user system section, so the next turn (usually within 5 minutes) rewrites the system tail at the 1h rate and the whole history at the 5m rate.

**Saving** (Sonnet 5.5; 18 invalidations/month assumed):
- Per invalidation: 1.5K × $4/M + 12K × $2.50/M − 13.5K × $0.10/M = **$0.035**, so ×18 = $0.62/mo.
- **After:** rebuild calls fall from $0.078 to $0.016 (25 at the batch price). The residual is at most a 1h tail rewrite on return ($0.11 worst case) plus a few capped rebuilds.
- **Saving ≈ $0.45–0.6/mo.**

**Amendments.** These are required for no quality or privacy loss:
1. **Staleness cap.** Rebuild anyway if the summary is older than 3 hours. Otherwise all-day users, with gaps under 10 minutes, accumulate uncovered facts, which then compete for the ranked-notes token budget in `selectMemoriesForContext` (`memory.ts:2136-2160`).
2. **Forget and correction path.** Already safe. `summaryPredatesForget` and `summaryPredatesMemoryChange` stop the stale summary from being injected (`memory.ts:2103-2107`). Keep the synchronous rebuild on forget, and keep the explicit "Regenerate" button synchronous.
3. **Dreamer selection.** Add a clause to `findAccountsToDream` (`src/lib/memory-dreamer.ts:50-66`) for accounts whose summary is dirty (fact count differs from `entryCount`) and that have been idle ≥ `DREAM_IDLE_MINUTES`. Without it, an account whose chats are all extracted inline is never visited. Capacity is 5 accounts per 10 minutes (`memory-dreaming.ts:37`): raise it or prioritise dirty-and-idle accounts.
4. **No-dreamer deployments.** If the dreamer has no heartbeat, keep today's inline behaviour (self-hosted deployments may not run `npm run memory:dreamer`; production does, per `deploy/deploy.sh`).
5. **Provider.** The dreamer passes a `null` conversation provider, so the account default decides `same_provider`. This differs from finalize, which uses the turn's provider. The summary already spans all chats, so this is acceptable, but document it in the policy audit.

**Files.**
- `src/lib/chat/turn/finalize.ts:174-185` (mark dirty instead of rebuilding).
- `src/lib/memory-lifecycle.ts` `summaryRebuildDecision`: add `lastActiveAt` and `maxStalenessMs` inputs and return `"throttled"` while active.
- `src/lib/memory.ts` `maybeConsolidate` / `maybeConsolidateProject`: pass `lastActiveAt`.
- `src/lib/memory-dreamer.ts` (selection).
- `src/app/api/voice/transcript/route.ts:88-90`, the same pattern.

**Tests.**
- `tests/memory-lifecycle.test.ts`:
  - active → throttled
  - active + older than cap → rebuild
  - idle → rebuild
  - forget-newer → rebuild
- `tests/memory-dreaming.test.ts`: a dirty idle account is selected.
- `tests/memory-summary-changes.test.ts`.
- `npm run test:memory` and memory-bench unchanged.

**Measure.**
- Per day: `role=chat` request records whose `prefix.verdict` starts `system@`, and their `tokens.cacheWrite`, joined to `MemorySummary.updatedAt`.
- `utility:memory/consolidate*` calls and cost.
- P95 lag from fact to summary.

### K4. F3 narrowed: research `expand` and the chosen-model citation judge on always-on leads

**Scope.**
- Only `expandResearchQueries` (`src/lib/research/tools.ts:928`) and the judge on the person's chosen lead (`researchModelCompletion`, `run.ts:963-972`).
- Only when the lead **cannot disable thinking**: Opus 5.5, Fable, Mythos, GPT-6 Astra and 6.1 Sol, the Gemini Flash and Pro lines.
- Use `utilityReasoningFloor(model)`, **not** `plannerReasoningEffort`. The latter would turn thinking on for Sonnet 5.5, Luna and similar leads (correction 5).
- The model stays the user's.

**Saving** (assumed thinking per judge call: 400 at default, 120 at the floor; Fable 800 at high):

| Lead | Tier | Calls | Today | After | Saving per run |
| --- | --- | --- | --- | --- | --- |
| Opus 5.5 | deep | 96 | $1.13 | $0.60 | **$0.54** |
| Opus 5.5 | max | 160 | $1.89 | $0.99 | **$0.90** |
| Fable | deep | 96 | $4.75 | $1.49 | ≈$3.3 |

`expand` is a few calls per run, a minor share.

**Quality gate (blocking for the judge).**
- `scripts/eval-research-citations.ts` scores stub judges only ("A live-model judge is NOT run here"). Add a `--live <modelId> --effort <tier>` mode over `src/lib/eval/research-citation-cases.ts`.
- Ship the judge change only if, against the default-effort judge on the same model:
  - supported precision stays ≥95% (the §8.3 bar), and
  - verdict agreement is ≥98%, and
  - there is **zero increase in false "supported"**.
- `expand`: ship on parity of per-run coverage (unanswered-question share and sources per objective) on 10 fixed research goals.

**Files.**
- `src/lib/research/tools.ts`: the `expandResearchQueries` effort; `researchModelCompletion` accepts and forwards `reasoningEffort`.
- `src/lib/research/run.ts:971`: pass the floor.
- `src/lib/research/domain.ts`: judge cost estimate.
- `scripts/eval-research-citations.ts`.

**Tests.**
- `tests/research-planner-fallback.test.ts`: pattern for asserting the forwarded effort.
- `tests/research-run-models.test.ts`.
- `tests/research-citations.test.ts`.

**Measure.**
- Per run and per label (`citation`, `expand`): `tokens.reasoning` and `costUsd`.
- The audit's verdict distribution and unverified share per tier, before and after.

### K5. F8: rank utility candidates by effective price within a provider

**Confirmed.**
- `utilityModelCandidates` sorts by speed first (`memory.ts:137`).
- Zhipu picks `glm-5.3-flashx` ($0.37/$1.25, s10) over `glm-5.3-flash` ($0.15/$0.50, s8, the same i8 grade).
- MiniMax: both FREE models are deprecated or legacy, so price ranking simply puts M2.5 ($0.30/$1.20) first.
- Anthropic, OpenAI, Google and Qwen picks are already the cheapest.

**Change.** Within each provider, sort by effective price (`getModelMetrics` in/out, plus the expected thinking at the K1 floor), then by speed. Keep the provider-diverse ordering. Apply the same key in `chooseBatchModel` (`src/lib/batch/dream.ts`).

**Saving.** About −60% of Zhipu-account aux spend; it multiplies with K1. $0 elsewhere.

**Quality risk.** Low: same grade, still s8. These jobs run in `after()` or at idle.

**Tests.** `tests/utility-spend.test.ts` and `tests/background-provider-callers.test.ts`: assert the order per provider from the registry.

**Measure.** Utility $/call by provider in `llm.request`.

### K6. F4: persist follow-up pills per reply

**Change.** Store pills keyed by (assistant message id, content hash). Two options:
- Cheapest: an encrypted JSON column on `Message`, behind a migration in `prisma/schema.prisma`.
- Alternative: a client cache per `replyID` in `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeFollowUpClient.swift`.

Keep `src/lib/chat/follow-up-cache.ts` for in-flight dedupe.

Native only, since the web never calls the route.

**Saving.** ≈$0.02/mo (assumed 1.5 views per reply).

**Quality risk.** None: the same text is served, the key includes content, and the data stays inside the user's own scope.

**Tests.** `tests/follow-ups-route.test.ts`: a second request for the same reply makes no model call, and an edited or regenerated reply makes one.

**Measure.** `utility:follow-ups` calls per assistant message (target ≤1.0).

### K7. F5 narrowed: titles skip when the context is frozen

**Change.**
- In `src/components/chat/chat-view.tsx` (`scheduleAutoTitle`, ≈ line 854), skip all phases when `titleSource === "ai"` and the conversation already had ≥8 non-empty messages at page load. Both client and server read only the first 8 (`titleMessages`, `chat-view.tsx:213-218`; route `take: 8`), so the title context cannot change.
- Optionally drop the `writing` phase. `thinking` already gives an early title.
- Do **not** stop AI renames after the first exchange (R8).

**Saving.** ≈$0.01/mo. **Quality risk.** None.

**Tests.** A component test or unit test of the scheduling predicate. Extract it as a pure function next to `titleMessages`.

**Measure.** `utility:title` calls per returning conversation.

### K8. F7: private-mode moderation verdict cache

**Change.** In `src/lib/moderation-ai.ts` `moderateUserMessages`, keep a process-local LRU (24 h) of **clean** verdicts, keyed by HMAC-SHA256(server secret, `userId` ‖ classifier version ‖ text).
- Classify only texts not in the cache.
- Hits are never cached, so a flagged text is re-checked and recorded as today.

**Saving.** A 12-turn private chat goes from 78 calls to 12; the steady state from 12 calls per turn to 1. That is ≈$0.005/mo, but it removes up to 12 serial model calls from `after()`.

**Privacy.**
- No plaintext is stored, and the key is per user and keyed, so there is no cross-user reuse.
- **Confirm with the private-mode spec** that an in-memory keyed hash for 24 h is acceptable; if not, scope it to the request stream's lifetime.

**Quality risk.** None. The verdict is per text with no context, so identical text gives an identical input.

**Tests.** `tests/chat-moderation.test.ts`:
- An unchanged history classifies only the new text.
- An edited text is re-classified.
- Different users do not share entries.
- A flagged text is never cached.

**Measure.** Classify calls per private request (target ≈1).

### K9. F9 narrowed: reflection skip-when-unchanged, with a daily floor

**Change.** In `src/lib/agents/reflect.ts`, after `reflectionDue` and **before the claim**:
- Skip if all of these hold:
  - the newest `updatedAt` / `createdAt` / `decidedAt` across goals, kept notes, work sessions, ideas and the agent row is ≤ `lastReflectedAt`;
  - no goal check-in is due (`goalCheckInDue`);
  - no goal `dueAt` falls within the next interval;
  - the last reflection is <24 h old.
- The 24 h floor exists because the prompt carries relative times and today's date (`formatAgentWhen`, `today`), so "nothing changed" is not exactly "same answer".
- Batching stays with BF-4.

**Saving.** For an idle agent, 4 reflections a day become 1: −75%, ≈$0.05 per agent per month.

**Quality risk.** Low. `parseReflection` already de-duplicates against open and dismissed ideas.

**Tests.** `tests/agents-reflect-sweep.test.ts` and `tests/agents-domain.test.ts`:
- Skip when unchanged.
- Run when a note is added, a check-in is due, a due date is near, or 24 h have passed.

**Measure.** Reflections per agent per day, and the idea accept rate, before and after.

### K10. F11 amended: auto-review prompt cache, explicit breakpoint

**Change.** In `runner/agent-core/src/harness/auto-review.ts`, split `requestText` into two content blocks:
1. `<user_instructions>…`
2. `<pending_call>…`

Then:
- On Anthropic, put an explicit `cache_control` on the **system** and on **block 1 only**, and never on the pending call. Add a provider option such as `cacheBreakpoints: "explicit"`; do not use `cache:true`, which marks the newest block (correction 6).
- On OpenAI and compatible providers, send a stable `prompt_cache_key` per session (`review-${sessionId}`), via `runner/agent-core/src/providers/prompt-cache.ts`.
- Keep the same model, the same thinking and the same bytes.

**Saving.** Applies only when system + instructions ≥ the model minimum (512 tokens on 5.5-generation models; 1,024 on OpenAI automatic caching).
- 800-token prefix, 10 reviews: $0.032 → $0.0054 (−83%).
- 3.3K-token prefix: $0.132 → $0.022.
- Below 512 tokens: no effect, and no cost, because markers below the minimum are ignored.

**Safety.** Unchanged. The reviewer still sees identical bytes; caches are workspace-isolated, and the only shared part is the public policy text.

**Tests.** `runner/agent-core/src/test/prompt-cache.test.ts`: the reviewer request has a breakpoint on the instructions block and none on the pending call. Also add a parse test for the two-block request.

**Measure.** Reviewer `cache_read_input_tokens` share; reviewer cost per code session.

### K11. F13 corrected: label every aux call

**Change.**
- `runUtilityPrompt` passes `role: \`utility:${label}\`` to `streamChat`, which already accepts `role` (`llm.ts:192`).
- Triage passes `"utility:triage"`.
- Research `utilityCompletion` passes `research:${label}`.
- Leave `recordSpend.source` alone, since it is `"web" | "app"`. If per-purpose ledger rows are wanted, add a nullable `purpose` column to `ApiSpend` (schema change).
- In `attemptTriage`, keep usage when the stream delivered it before an abort.

**Saving.** None directly. This is how K1–K10 are measured, so it ships first.

**Quality risk.** None.

**Tests.** `tests/usage-metering-coverage.test.ts`: every `runUtilityPrompt` caller produces a labelled role.

---

## 3. Rejected

- **R1. F3: batching 4 claim/passage pairs per judge call.** Rejected on safety.
  - The judge wraps each fetched passage in the untrusted envelope precisely because a page may try to grade its own citation (`claims.ts:191-199`).
  - Putting several untrusted passages in one context lets one hostile page sway the verdicts on *other* claims.
  - It also couples the verdicts of the pairs in a batch.
  - The judge's verdicts repair the user-visible report.
- **R2. F3: low effort on the lead review** (`research/agents/lead.ts:247`).
  - The review decides coverage, gaps and when to stop. That is the core research judgement on the model the user chose for a product the owner wants to beat ChatGPT and Claude deep research.
  - There is no eval that would catch a regression.
  - The planner's low effort was set to fix empty or truncated JSON (`tools.ts:353-359`), not for cost, so it is no precedent.
- **R3. F3: brief and clarify savings.** No saving exists. Both are dead paths in production, because `draftPlan` is set (correction 4).
- **R4. F1/F3 implementation via `plannerReasoningEffort`.** It would raise cost and change outputs on Haiku 5.5, GPT-6 Luna and Sonnet 5.5 leads, all of which are non-thinking today. Replaced by `utilityReasoningFloor` (K1).
- **R5. F1 step 3: deterministic skips** (any message with a prior assistant reply, unless it is a long build/write/plan request; anything ending in "?"; wh-questions of 25 words or fewer).
  - "Can you write me a cover letter?" and "now build me a landing page for my bakery" are build requests that the triage prompt may legitimately ask about.
  - The prompt's "never ask" on follow-ups is conditional ("context already pins down what the user means").
  - The codebase removed a keyword layer for exactly this reason (`preflight-triage.ts:21-24`).
  - **Replacement (measure only):** log triage decisions bucketed by `{hasAssistantReply, questionForm}` for 2 weeks. Skip a bucket only if its ask rate is under 1% *and* its card-accept rate is low.
- **R6. F6: "≤12 chars" and "pure code/paste" extraction skips.** Short messages carry durable facts ("I'm vegan", "I'm a nurse", "call me Sam"), and pastes reveal the stack the extractor learns from. Only an explicit acknowledgement allowlist is acceptable: "thanks", "ok", "continue", "go on", emoji-only. The extractor reads only user text, so a bare "yes" can yield nothing anyway. The rest of F6 merges into BF-1.
- **R7. F10: gating Google Search on the voice delegate.**
  - Attaching `google_search` is not itself billed. Gemini 3 bills per search query the model actually executes, and `gemini-delegate.ts` charges only when `groundingMetadata` is present.
  - Gating hands the "needs current info" decision from Flash to the voice model. A wrong call is an ungrounded answer **spoken** to the user: a quality and safety regression on an interactive path.
  - Correct metering (per executed query, an in-call memo) is voice-realtime V11.
- **R8. F5: "stop renaming AI titles after the first exchange".** It changes behaviour: titles legitimately refine over the first 8 messages. Replaced by the frozen-context skip (K7).
- **R9. Fixing the Flash-Lite catalog default as a cost lever.** It changes the default thinking of users who chose Flash-Lite for chat, which violates the user-chosen-model rule. Report it to the owner as a bug and product decision instead. K1 achieves the aux saving without touching chat.
- **Merged, not counted here:**
  - F6 coalescing and deferral → BF-1, with its extract-on-switch mitigation.
  - F12 OpenAI flex → BF-3/BF-5. GPT-6 Luna/Sol flex eligibility is unverified, and developers.openai.com is blocked.
  - F9 batching → BF-4.

---

## 4. Order of work

1. K11 (labels).
2. K1 for titles and pills, and K2 step 1 (both quality-neutral, latency-positive).
3. K5.
4. K3 and K1 memory labels, together behind one memory-bench run.
5. K8, K9, K10, K6, K7.
6. K2 step 2 after the triage eval.
7. K4 after the live-judge eval.
8. K1 moderation after test-moderation.

---

## 5. Sources

- Anthropic pricing (fetched 2026-10-31): https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic prompt caching (fetched 2026-10-31): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- **Gemini pricing and grounding** (search snippets only; ai.google.dev blocked): https://ai.google.dev/gemini-api/docs/pricing, https://discuss.ai.google.dev/t/gemini-api-grounding-billing-for-requests-exceeding-daily-free-tier/102927
- **OpenAI flex** (search snippets only; developers.openai.com blocked): https://developers.openai.com/api/docs/guides/flex-processing, https://dev.classmethod.jp/en/articles/openai-flex-processing/
- **Repo:**
  - Prices: `src/lib/model-rates.generated.ts` (verified 2026-10-18), `src/lib/model-metrics.ts`, `src/lib/scheduled-prices.ts`.
  - Baseline profile: `docs/pricing/COST_ENGINEERING.md` §5.
  - Sibling findings, for overlap: `scratchpad/cost/batch-flex-findings.md` (BF-1..BF-5), `scratchpad/cost/voice-realtime-findings.md` (V11).
