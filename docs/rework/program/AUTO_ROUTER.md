# Auto Router 2.0, feedback loop, Auto UX, budgets, data-use policy, evaluation

Vertical for BRIEF §25 (Auto Router 2.0), §26 (feedback loop), §27 (Auto UX), §49 (cost control), §51 (provider data-use policy in routing) and §53 (evaluation harnesses). Branch `rework/router`. Maturity entries: `auto_routing`, `cost_budgets`, `evaluation_harness` in `src/lib/capabilities.ts`.

## Decisions (written before implementation)

1. **Extend, don't fork.** `pickAutoModel` (the one real call site, `src/app/api/chat/route.ts`) delegates to a pure decision function, `routeAuto` in `src/lib/router/decide.ts`. Every environmental fact (provider health, rate-limit pressure, tool-probe verdicts, measured evidence, remaining budget, attestation) is an input, so every branch is testable and the eval harness can replay decisions. `classifyPromptComplexity` stays the one complexity grader.
2. **Hard filters are never traded against price.** Plan, provider configured, data-use terms, modality (vision, web search), context window, availability and remaining budget filter first; only survivors are scored.
3. **Unknown terms are ineligible.** A provider whose API data-use terms were not verified from a primary source cannot be chosen by Auto. Hand-picking stays possible. The owner clears each one (see blockers).
4. **Telemetry holds no content and no user.** One row per saved-chat turn, keyed only by message id (nulled after 30 days), never in private chats.
5. **Budgets: one vocabulary, no new store.** Account, agent, routine and run ceilings already existed with their own gates; `src/lib/budgets.ts` gives them one shape and one sentence. Enforcement stays where it was.
6. **The eval stops claiming E2E.** The old `scripts/eval-juno.ts` (pure functions) becomes `scripts/domain-checks.ts`; the new suite labels every record mock, live or not_run.

## Implemented

### Router (`src/lib/router/`)

- `task-class.ts` — task class (everyday, writing, reasoning, coding, research, agentic, structured_output, long_context, vision), the needs that apply (reasoning, coding, research, tool reliability, structured output, long context, vision), token estimates (CJK-aware), prior tool rounds, and receipt-voice signals ("repository-scale coding", "reliable tool use"). Agentic and long-context turns are routed one stakes level above their wording.
- `decide.ts` — `routeAuto`: hard filters → per-candidate effort (`pickAutoReasoningEffort`) → prior success from intelligence vs. the required level (effort-boosted, code-specialist boost, tool-reliability/probe/structured-output/long-context penalties) → posterior from evidence → scoring:

  ```text
  expected_total = call
                 + expected_tool_rounds × 0.45 × call
                 + expected_retries × call
                 + (1 − p_success) × (strongest candidate's call + reader's time × preference)
                 + expected_latency × value of a second
  ```

  Reader's time per failed turn: $0.005 simple, $0.04 medium, $0.20 hard, $0.60 expert. Preferences: balanced, quality (failure ×3, latency ×0.5), economy (failure ×0.35). Output: model, effort, profile, ranked candidates with every cost component, alternates on other providers, exclusion counts, a degraded flag, and the "Selected for" reasons built from that decision.
- Availability: unhealthy providers (`provider-health.ts`) are excluded; if all are down, Auto answers anyway and flags `all_providers_unavailable`. Rate limits (`provider-pressure.ts`, fed from the route's 429s) raise expected retries rather than veto.
- Budget: candidates whose call plus tool rounds exceed the room left (the tighter of the monthly remainder and the binding usage window, `chat-inputs.ts autoBudgetRoom`) are dropped; if none fit, the cheapest call is chosen and flagged `over_budget`; the downstream spend gate still decides.
- Fallback in the route: when the pick cannot route (unprobed model, provider down since), the route walks the decision's own ranking before the generic `selectModel` fallback; every substitute under Auto must also pass the data-use policy. A replaced pick recomputes the effort and marks the receipt `rerouted`.
- `NoAutoCandidateError` replaces the old "last resort" that ignored the plan: the route answers 503 `AUTO_NO_ELIGIBLE_MODEL` with the reason.

### Provider data-use policy (`src/lib/router/data-policy.ts`, BRIEF §51)

| Provider | Training on API data | Retention | Jurisdiction | Source (read 2026-10-04) | Auto |
|---|---|---|---|---|---|
| Anthropic | no | — | US | [privacy.claude.com](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training) | eligible |
| OpenAI | no (unless opted in) | 30 days abuse logs | US | [developers.openai.com your-data](https://developers.openai.com/api/docs/guides/your-data) | eligible |
| Google Gemini | paid: no; unpaid: yes | temporary (paid) | US | [ai.google.dev terms](https://ai.google.dev/gemini-api/terms) | only with paid-tier attestation |
| Mistral | Scale: no; Experiment: yes | 30 days | EU | [help.mistral.ai](https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training) | only with paid-tier attestation |
| xAI | no without permission | 30 days | US | [docs.x.ai security FAQ](https://docs.x.ai/developers/faq/security) | eligible |
| Meta (standard tier) | no | — | US | `docs/models-september-2026.md` | eligible; `-contributor` tiers never |
| Alibaba Qwen | no | — | PRC (endpoint SG) | [Model Studio FAQ](https://www.alibabacloud.com/help/en/model-studio/faq-about-alibaba-cloud-model-studio) | eligible |
| DeepSeek | yes (privacy policy) | — | PRC | [DeepSeek privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) | never |
| Zhipu, Moonshot, MiniMax, MiMo, LongCat, Seedance | unknown | — | PRC | none verified | never until verified |

- `AUTO_ROUTER_PAID_TIER_PROVIDERS=google,mistral` is the owner's attestation that the deployment's keys are on paid, no-training tiers. Code cannot check it; it is never defaulted on.
- Per-user boundary (`Settings.autoDataBoundary`): `verified_no_training` (default), `exclude_prc`, `eu_us_only`. It can only narrow. Settings → Models → Auto.
- **Behaviour change:** before this branch Auto's cheapest-first ranking sent simple prompts to `zhipu:glm-4.7-flash` ($0). That provider's terms are unverified, so Auto no longer uses it. The account default model (`qwen:qwen3.8-flash`) is unaffected, because a default is the reader's selection rather than Auto's choice.

### Telemetry and feedback loop (BRIEF §26)

- Table `RoutingOutcome` (migration `20261004190500_auto_router_telemetry`): router version, auto/hand-routed, task class, complexity, model, provider, effort, latency, tool rounds, retries, completion state (completed / partial / failed / stopped), finish reason, user regenerated, user switched model, user edited (the prompt was edited and re-sent, discarding the answer), thumbs feedback, cost, and the router's expected total (for calibration).
- Written once per saved-chat turn from the generation's `finally` (`route.ts`), best-effort, never blocking. Signals: regenerate (and model switch) in the chat route, prompt edit in `PATCH /api/messages/[id]`, thumbs in `POST /api/messages/[id]/feedback`.
- Aggregation: one SQL `GROUP BY (modelId, taskClass)` over 90 days, cached 5 minutes per process; the success rule in SQL is pinned to the pure `outcomeSucceeded` by an integration test.
- The router reads aggregates only: cells with fewer than **20** turns are ignored; above that every rate is shrunk toward its prior with a pseudo-count of **30**. A unit test shows 200 measured failures moving Auto off a model.

**Telemetry policy.** No message content, prompt hash, user id or conversation id is stored. Private chats, research notices and the deterministic smoke provider write nothing. `messageId` exists only so later signals can find the row; it is nulled after 30 days, and rows are deleted after 180 days (opportunistic prune once a day from the evidence load). Nothing trains on content; the router learns from aggregates of the columns above. Telemetry is not shown to users.

### Auto UX (BRIEF §27)

- `Message.routing` stores the receipt `{ v, effort, taskClass, reasons, degraded, rerouted, rerouteReason, image, factors }`, built from the decision that ran, and cleared when a regenerate is hand-routed. Serialized to every client as `ClientMessage.routing`. `factors` and the reader's sentence are described under "Intelligent Auto (Part 4.2)" below.
- `src/components/chat/auto-receipt.tsx`: in the turn's metadata row (hover/focus, as before) the model reads **Auto · Gemini 3.8 Flash · High**; clicking it opens **Selected for** with the decision's reasons. Phones: the same line, sentence and reasons in the More menu. Older versions in the pager show no receipt. Hand-routed turns show only the model name. Exact model selection is unchanged.
- Settings → Models → Auto: *Optimise for* (Balanced / Best answer / Lowest cost) and *Labs Auto may use*.
- Verified in `/dev/routing` (real `MessageItem`, receipt line, popover, rerouted state, developer decision table) with headless Chrome, desktop light and phone dark.

### Budgets (BRIEF §49)

- `src/lib/budgets.ts`: `BudgetLine { scope: account | agent | routine | run, ceiling, spent, held, window, resetsAt }`, `bindingBudget` (least room left; ties go to the narrower scope), `remainingUnder`, and one sentence (`describeBudgetLine`: "$3.10 of $5.00 this week"). Adapters wrap the existing numbers: `checkBudget` (account), `Agent.budgetMicroUsd` + `memberSpendMicroUsd` (agent), `WorkSchedule.maxCostMicroUsd` (routine), `WorkRun`/`ResearchRun` ceilings (run).
- `src/lib/budgets-store.ts`: a routine's spend this billing period; an agent's line in the same weekly window its cap is enforced in.
- Surfaces where the user sets them: the agent profile gains **What it may spend** (spend vs. weekly cap, editable through the existing `PATCH /api/agents/[id]`); the routine editor shows what its runs have cost this period beside its ceiling (`spentThisPeriodMicroUsd` on the schedule APIs); account (Settings → Billing) and run (Work run panel, research controls) already showed ceiling and spend and are unchanged.
- Auto reads the remaining account room as a router input (above).

### Evaluation (BRIEF §53)

- `src/lib/eval/suite.ts`: one task per §53 category with a deterministic grader and an authored mock. Model-written code is executed in a separate Node process under `--permission` (no file system, no child processes) with a 2 s timeout.
- `src/lib/eval/runner.ts`: `runEvalSuite` (records success, latency + its source, cost + its source, tool count, model, provider, effort, task class, errors, citation quality) and `evaluateRouter` (benchmark-shaped classes — SWE-bench-like, GPQA-like, τ-bench-like, needle, chart, SimpleQA-like, small talk — plus the suite's tasks, each under eight scenarios: default terms, attested paid tiers, quality, economy, EU/US boundary, primary provider down, budget just below the pick, 200 measured failures).
- `npm run eval:juno` (mock, default), `EVAL_LIVE=1 npm run eval:juno` (real calls where keys exist), `--write` saves JSON to `docs/rework/program/evidence/`. Deep Research, memory, agent persistence, browser and Computer Use are recorded `not_run` with the reason and the harness that does cover them.
- `npm run domain:checks` runs the old pure-function checks under an honest name.

## Changed

- `src/lib/auto-model.ts`: `pickAutoModel` delegates to the router and returns the decision; the unused `resolveModelFallbackChain` and the cheapest-first ranking were removed.
- `src/app/api/chat/route.ts`: router inputs (evidence, probes, budget room, settings, attestation), data-policy-aware substitution, runner-up fallback, receipt persistence (saved and private paths), telemetry, rate-limit pressure.
- `prisma/schema.prisma`: `Message.routing`, `Settings.autoPreference`, `Settings.autoDataBoundary`, `RoutingOutcome`.
- `tests/plan-paywall.test.ts`: Auto on FREE now refuses with `NoAutoCandidateError` instead of returning a model FREE cannot call.

## Removed

- The claim that `scripts/eval-juno.ts` ran end-to-end evaluations (file moved to `scripts/domain-checks.ts`).
- `resolveModelFallbackChain` (dead code; the decision's `alternates` and ranking replace it).

## Tests

| Command | Result |
|---|---|
| `NODE_OPTIONS=--conditions=react-server npx tsx --test tests/router-decide.test.ts tests/auto-model.test.ts tests/plan-paywall.test.ts tests/model-selection.test.ts tests/work-models.test.ts` | pass |
| `NODE_OPTIONS=--conditions=react-server npx tsx --test tests/budgets.test.ts tests/agents-budget.test.ts tests/eval-harness.test.ts` | pass |
| `JUNO_ROUTER_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/juno_router_test NODE_OPTIONS=--conditions=react-server npx tsx --test tests/router-telemetry.integration.test.ts tests/budgets-store.integration.test.ts` | pass (throwaway DB, migrations applied) |
| `npm run eval:juno` | 12/12 mock tasks pass, 5 categories not_run |
| `npm run domain:checks` | 38/42 — the same four failures as before this branch (escalation classifier and registry tools), untouched |

## Benchmarks

`docs/rework/program/evidence/eval-2026-10-04-mock.json` holds the mock run and the router table (all providers treated as configured). Highlights:

- Simple asks (chat, writing, formatting, multilingual) go to `openai:gpt-6-luna` Instant, expected total ≈ $0.002; with OpenAI down they go to `qwen:qwen3.8-flash` or `meta:muse-spark-1.3`.
- SWE-bench-shaped repository bug fix: `meta:muse-spark-1.3` High by default; `google:gemini-3.8-flash` High once paid tiers are attested; `gpt-6-luna` High under economy, with Meta down, under a budget below the pick, or after measured failures on Meta.
- GPQA-shaped reasoning: Muse Spark 1.3 High → Gemini 3.8 Flash High (attested) → Grok 4.7 High when Meta is down.
- These are routing decisions on catalogue priors. **No model quality was measured**: no live run was possible in this checkout (no eligible provider key).

## Security considerations

- Data-use filtering is deterministic, in trusted code, applied to the pick, to every substitute and to the platform-budget degrade path under Auto. A hand-picked model is never filtered or substituted across providers (existing rule).
- Unknown terms default to ineligible; the boundary setting is enum-validated and can only narrow.
- Telemetry carries no content or user identifiers; the message link expires. Writes are best-effort and cannot fail a turn.
- The eval executes model code only in a permission-restricted subprocess with a timeout.
- `/dev/routing` 404s in production.

## Remaining blockers

1. **Owner — provider terms:** verify API data-use terms for Zhipu, Moonshot, MiniMax, MiMo, LongCat and Seedance from primary sources, then update `PROVIDER_DATA_POLICIES` (they are ineligible for Auto until then). Re-read the others periodically.
2. **Owner — paid-tier attestation:** set `AUTO_ROUTER_PAID_TIER_PROVIDERS` for Google and/or Mistral if the deployment keys are on paid tiers.
3. **Owner — legal:** data residency and cross-border transfer (PRC providers, `docs/SUBPROCESSORS.md`) and the AI/data-processing disclosure for routing telemetry. Not solved in code.
4. **Live evaluation:** needs provider keys; then `EVAL_LIVE=1 npm run eval:juno -- --write`.
5. **Measured evidence:** starts accumulating only after the migration is deployed.
6. **Signed-in chat check** of the receipt (verified on the real component in `/dev/routing`, not in an authenticated session).
7. **Native:** macOS/iOS do not render `routing` or the Auto settings yet; the field is additive and ignored by older clients.
8. **Saved-context sizing (local increment, 2026-10-14):** Auto now reads an owner-scoped, bounded history estimate before selecting a provider, including attachments, project instructions/reference coverage and connector reserves. Substitutions remain inside the context/vision-eligible ranking. Private history is counted once without saved-context reads. Regression coverage includes a real disposable-database Chat turn and platform-budget fallback; the database suites are wired into CI. Unparsed-document expansion and tool schemas remain estimates, and a retrieval failure that falls back to whole project files is not a guaranteed fit. Retries per turn are recorded as 0 because the chat path has no automatic retry; regenerations are recorded as signals instead.

## Intelligent Auto (master brief Part 4.2, 2026-10-25)

Branch `claude/w5-auto-routing`. What changed, and why.

### A truthful internal receipt on every routed answer

`RouteDecision.factors` (`src/lib/router/decide.ts`) is stored on the receipt as `factors` (`src/lib/router/receipt.ts`). Each field is the decision's own fact, never a re-derivation:

| Factor | Source in the decision |
|---|---|
| `selected` | the router's pick (`Message.model` is the model that answered; they differ only with `rerouted`) |
| `complexity` | `profile.complexity`, the stakes-adjusted level the router acted on |
| `modality` | `input`: text or text and image (`profile.needs.vision`); `output`: image only when the turn wants a picture **and** the answering model can call the image tool |
| `tools` | web search, image generation, connectors offered, whether tool reliability was a need |
| `contextTokens` | `profile.estInputTokens`, the estimate the context-window filter used |
| `providerHealth` | providers reported down that had eligible models; rate-limit pressure on the answering provider |
| `cost` | catalogue price tier (low/medium/high) and the expected spend of the turn (call + tool rounds + retries) |
| `latency` | expected seconds to a complete answer and its tier (fast < 6 s, slow ≥ 20 s) |
| `plan`, `preference` | the account's plan and Auto preference when it chose |
| `candidates`, `choice` | models scored; `lowest_cost`, `better_odds` (the pick costs clearly more per call than the cheapest, the same rule as the "better odds" reason) or `only_option` |
| `pSuccess`, `evidence` | first-try odds; where they came from (`prior`, `measured`, `reliability`), on how many turns, and `shiftedFrom` when measured outcomes changed the pick |
| `budgetSaver`, `routerVersion` | the low-budget rule; the router version |

On a reroute (`src/lib/chat/turn/model.ts`), the per-model facts (cost, latency, odds, evidence, pressure) are the answering model's own scored row and `selected` keeps the original pick. `rerouteReason` says whether the pick was unreachable or the platform's daily capacity sent Auto to a cheaper model (the popover used to say "could not be reached" for both).

`parseRoutingReceipt` drops a malformed `factors` block whole and keeps the rest of the receipt; receipts written before `factors` existed parse unchanged.

### A concise reason for the reader

`receiptSummary(receipt)` builds one plain sentence from the factors: "A quick everyday question, so Auto chose a fast, low-cost model.", "Complex coding, so Auto chose a model more likely to get it right first time, with High thinking.", "This conversation is long (about 301k tokens), so Auto chose a model with room for all of it." It names a capability only where it was a hard filter (vision, web search, the image tool, the context window), describes a trade-off only as `choice` records it, uses "fast" and "low-cost" only when the tiers say so, and shows no scores or prices. Reroutes, relaxed rules, a measured shift ("Results on similar Alevr requests tipped the choice.") and skipped providers are said too. It never runs past 200 characters (`RECEIPT_SUMMARY_MAX_CHARS`): the lead sentence is always given whole, and a secondary sentence (the measured shift, a skipped provider) is added only while the whole stays within the cap, so nothing is cut mid-sentence. An exhaustive test over every combination of the fields the sentence reads (1.6 million) pins it; before the cap was enforced, one combination reached 217. It is the first line of the existing "Selected for" popover (`src/components/chat/auto-receipt.tsx`) and, on phones, of the receipt entry in the answer's More menu (`message-item.tsx`); older receipts show their reasons as before.

When nothing fit the remaining budget, the decision does not pick on expected total: it tries the cheapest call and the spend gate decides. The sentence says exactly that ("Nothing fit what's left of your budget, so Auto tried the lowest-cost model."), and the reason line reads "lowest cost, as nothing fit your remaining budget" in place of the expected-cost comparison. The earlier "Auto chose the model that fits what's left of your budget" and "kept within your remaining budget" were false by construction. When every provider was also down, that stays the lead ("Every eligible provider was reporting trouble, so Auto went ahead with one rather than refuse."; it no longer says "the best one", which the price-ordered case is not), and the budget appears in the reason line.

### Routing from measured outcomes, not only keywords

The outcome columns the code already records (thumbs, regenerations, model switches, edits, errors, latency) now reach the decision in three more ways (`src/lib/router/evidence.ts`):

- **Reliability pools across task classes.** Errors (`completionState` failed or partial) are counted per cell and pooled per model. When a (model, task class) cell is below the 20-turn guard, the model's shrunk error rate across every class multiplies its prior odds (prior error rate 3%, the same pseudo-count of 30). A model failing everywhere now loses odds before twenty failures land in one class. A believed cell is used alone, since its successes already count its errors.
- **Measured latency.** The aggregate sums latency of completed turns only (a turn that failed fast says nothing about speed), and above the guard the shrunk measured mean replaces the latency prior in the expected total.
- **The decision says when measurement chose.** Each candidate also carries its total on priors alone; if the prior-only winner differs, the decision records `shiftedFrom`, the reasons say "results on similar Alevr requests favoured it over X", and the summary says so. Never when price chose: whenever the budget fallback orders by call price (`RouteDecision.priceOrdered`, also set when every provider was down as well and `degraded` reports that), no shift is computed and no measurement reason is given. A review found the all-providers-down case claiming "results on similar Alevr requests favoured it over Gemini 3.8 Flash" for a pick made on price.

The success rule is unchanged (completed and not regenerated, switched, edited or thumbed down), and the SQL aggregate is pinned to the pure rule, now including `errors` and the completed-only latency, by `tests/router-telemetry.integration.test.ts`.

### Telemetry honesty

- An ending the platform caused writes **no** outcome row (`endingSaysNothingAboutModel`): a process drain or a lost receipt lease (both finish as `error`) and the account's budget guard (finishes as `user_stopped`). They used to count against whichever model was streaming.
- `firstTokenMs` is now recorded. Both timings come from the turn trace, which measures the first token and the whole turn from one start (`outcomeTimings`, `src/lib/router/telemetry-rules.ts`); a first version took the turn length from `runTurn`'s later clock and stored one row with 65 ms to first token on a 49 ms turn. Without a trace, the length comes from `runTurn`'s clock and the first token is null. Across the 47 rows two runs of the pipeline test wrote, 41 carry a first token (the other 6 are turns that failed before any text) and none exceeds its turn.
- The pure rules (`completionStateFor`, `endingSaysNothingAboutModel`, `outcomeTimings`) live in the client-safe `telemetry-rules.ts` and are re-exported by `telemetry-store.ts`, so unit tests import them without the react-server condition, as CI runs them.
- A hand-routed turn's task class uses the same request facts Auto uses (web search, connectors), so it lands in the same evidence cell.
- Fixed: under the low-budget rule the "saving your remaining budget" reason was a fifth line and the receipt cut it. Decision facts (comparison, measured shift or samples, budget rules) are now kept, and task signals fill what room is left, giving way entirely when the facts take all four lines.

### Tests (2026-10-25)

Unit tests run as CI's unit gate runs them (`npx tsx --test tests/*.test.ts`, no `NODE_OPTIONS`). The first report of this increment ran them only with `--conditions=react-server`, which hid that `router-evidence.test.ts` imported a `server-only` module and failed whole under CI; that is fixed (above) and the numbers below replace it.

| Command | Result |
|---|---|
| `npx tsx --test tests/router-receipt.test.ts tests/router-evidence.test.ts tests/router-representative-prompts.test.ts` (no `NODE_OPTIONS`) | 58 pass, 0 fail (16 + 20 + 22) |
| The 37 unit test files that import a changed module (router, auto-model, chat turn, chat route, eval, message item), no `NODE_OPTIONS` | 478 pass, 3 skipped, 0 fail, excluding `wave2-p1-lint.test.ts`, which fails identically on `claude/premium-design-pass` (11 pass, 16 fail, 8 cancelled; untouched here) |
| `tests/router-telemetry.integration.test.ts` on a throwaway Postgres 16 | 8 pass |
| `tests/chat-turn-pipeline.integration.test.ts` on a throwaway Postgres 16 (real `POST /api/chat`; asserts the persisted factors, a completed turn's row with both timings, and no row for a turn drained mid-stream) | 21 pass. With the platform-ending guard removed from `run-turn.ts`, the new case fails ("the drained turn wrote no outcome row"). |
| `npm run native:wire:check` | up to date (no wire type changed in the review fixes) |

### Not done, and limits

- Measured cost is not used to calibrate the call estimate: rows store the expected **total** (`expectedMicroUsd`, which includes failure and latency terms), not an expected call cost, so the two cannot be compared without a schema change.
- `retryCount` stays 0: the chat path has no automatic retry (see the trace's `attempts`).
- A thumbs-up counts the same as a kept answer with no rating; it carries no extra weight.
- The capacity reroute (`rerouteReason: "capacity"`) is covered by unit tests of the receipt, not by a database test of the route: the pipeline test's forced platform budget found no cheaper eligible model, so it took the non-rerouted branch.
- The native apps do not render `factors` or the sentence yet.
- The popover's new first line and the phone More-menu sentence were not checked in a browser: no dev server was run for this increment.
- `image-route.ts` still gives "kept within your remaining budget" for its own over-budget fallback. Those reasons are not shown to the reader (only `receipt.image` is), so it was left alone.
- With every provider down and nothing in budget, the sentence leads with the providers and leaves the budget to the reason line: the receipt's single `degraded` flag cannot carry both, and adding a factor was not worth a wire change.

## Next milestone

Run the live suite with keys; deploy the migration; after two weeks of outcomes, compare the router's `expectedMicroUsd` with actual cost and success per (model, task class) and recalibrate the reader's-time constants; render the receipt natively; extend the suite to replayable Deep Research and memory jobs.

## Competitor comparison (primary docs, read 2026-10-04)

- **ChatGPT Auto** routes between Instant and Thinking; OpenAI's release notes record that from 14 September 2026 Plus and Pro no longer switch to Thinking automatically ([ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)). Single-vendor, so there is no cross-provider data-use question. Alevr's Auto chooses across labs and must filter by terms, which is why the policy table exists.
- **Perplexity "Best"** picks a model per query inside Search ([Perplexity Help Center](https://www.perplexity.ai/help-center/en/articles/10354919-what-advanced-ai-models-are-included-in-my-subscription)); it does not show per-answer reasons. Alevr shows "Selected for" from the decision record.
- **OpenRouter Auto Router** routes from aggregate market spend per task type and honours account privacy settings, including a `data_collection: deny` provider filter; its data-policy tags are described as best knowledge rather than definitive ([OpenRouter Auto Router](https://openrouter.ai/blog/announcements/introducing-the-new-auto-router/)). Alevr's equivalent excludes unverified terms by default and learns from its own completion outcomes (success, regenerations, edits, cost), not from spend popularity.
