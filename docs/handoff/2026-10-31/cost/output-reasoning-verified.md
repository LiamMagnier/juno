# Output and reasoning tokens: verification

**Reviewer:** principal engineer, model quality. **Dimension:** output-reasoning. **Repo:** `/home/user/juno` at `e532983ea`, read-only.
**Input:** `scratchpad/cost/output-reasoning-findings.md` (O1–O12).

**Rules I applied:**
- The model the user picked, and the effort they picked, do not change on any turn they read.
- Interactive turns must not get noticeably slower.
- No cache may be shared across users.
- A change to auxiliary work that feeds something the user sees (a report, a verdict, a clarification card, a summary the model continues from) ships only behind an eval. Without an eval, it is rejected.

**What I ran.** All scratch files are in `scratchpad/cost/verify/or/`. Each was run with `scratchpad/bin/node node_modules/.bin/tsx` against the real repo modules.

| Script | What it checks | Output |
| --- | --- | --- |
| `floors.ts` | For every FREE model and every always-on lead model: the reasoning caps, the floor tier, and the wire body sent today vs at the floor | `floors-free.txt`, `floors-leads.txt` |
| `compaction-replay-probe.mts` | Drives the runner's real `compactConversation` (layered) through a provider that records each request | `compaction-replay-probe.txt` |
| `calc.mjs` | Every $ figure in this file | `calc-report.txt` |
| `rates.ts` | Registry rates (`getModelMetrics`) | — |
| `../or-haiku.ts` | Which Haiku the research worker resolves to | — |

**Overlap with sibling dimensions.** O1, O2 and O4 are the same levers as aux-routing K1, K2 and K4 (`aux-routing-verified.md`). I re-verified them independently and agree, with the corrections below. Their money is **counted once, there**, and not again here. O11's truncate half is voice-realtime V9.

---

## 0. Verdicts

| # | Item | Verdict | Saving (recomputed) | Ships |
| --- | --- | --- | --- | --- |
| K1 | O1: floor effort for utility calls on always-on models | **KEPT (narrowed)** = aux-routing K1 | −39% to −56% per call on Flash-Lite. −49% to −72% per call on GLM-5.3 FlashX. $0 on Anthropic, OpenAI, DeepSeek and Qwen accounts | Titles and pills now. Memory after memory-bench. Moderation after test-moderation |
| K2 | O2: triage at its floor tier, plus a `role` label | **KEPT** = aux-routing K2 step 1 | −31% to −43% per triage call. 450–1,013 µ$ per triaged web turn. Also lowers latency | After one `test:clarify` A/B run |
| K3 | O4 narrowed: research **judge and expand** at the floor, on **always-on chosen leads** only | **KEPT (eval-gated)** = aux-routing K4 | Opus 5.5: $0.06–0.90 per run by tier. Fable 5.1: $0.36–5.20 per run | Blocked on a live-judge eval |
| K4 | O6: send each tool round's reasoning back on compat labs | **KEPT** | Mainly a reliability fix: thinking-mode tool turns on DeepSeek, MiMo and Kimi fail on round 2 today. The cost saving is the failed round plus the regenerate | `must` labs now; `should` labs after measuring |
| K5 | **New:** the Code compaction summary replay omits the session's effort and cache key | **KEPT (new; step 2 measure-gated)** | Anthropic, when the session effort is not the default: $0.07–3.07 per summarize compaction on Opus 5.5, up to $7.84 on Fable 5.1 | Cache key now. Effort after one log query |
| K6 | O10: label every aux request; meter research workers and runner side calls, including thinking tokens | **KEPT (enabler)** = aux-routing K11, extended | None directly | First |
| K7 | O9 narrowed: repetition detector that **logs only** | **KEPT (shadow mode only)** | None until data exists | Now |
| R1–R11 | O3, O5 (all three side calls), O4 clarify and brief, O1 sub-items, O7, O8, O9 abort mode, O11 cap, O12 | **REJECTED** (§3) | — | — |

**Net new money in this dimension**, after deduplication: K5 (Code sessions) and K4 (failed DeepSeek, MiMo and Kimi tool turns that are no longer paid twice). Neither can be sized from the repo; §2 gives the decision rule and the query for each. The findings' headline (O1+O2 ≈ 8% of blended chat-path spend) was overstated:
- K1 is $0 on Anthropic- and OpenAI-anchored accounts.
- Triage runs only on web sends (`src/hooks/use-chat.ts` is the only caller of `/api/chat/clarify`).
- The "60% of turns triaged" figure is still an assumption.

Corrected, the web-turn share for a Sonnet-anchored user is **≈2.6–6.0%** (450–1,013 µ$ of ≈17,000 µ$ per turn). Native turns get 0%.

---

## 1. What I confirmed, and what I corrected

### Confirmed in code

**Utility calls send no effort.**
- `runUtilityPrompt` calls `streamChat` with no `reasoningEffort` and no `role` (`src/lib/memory.ts:469-476`).
- `streamChat` adds the "high" allowance (+16,384 tokens) to every always-on non-Anthropic model (`src/lib/llm.ts:145-150`).
- Run against the real builders (`floors-free.txt`):
  - Gemini 3.5 Flash-Lite and 3.6 Flash: `{"maxOutputTokens":16584,"thinkingLevel":"MEDIUM"}`
  - Gemini 3-flash-preview: `HIGH`
  - GLM-5.3 Flash and FlashX: `max_tokens=16584`, no effort sent, so the API default `max` applies
  - Haiku 5.5: `disabled`
  - Sonnet 5.5: `between_tools`
  - GPT-6 Luna: `none`
- 8 of 32 FREE models differ at the floor:
  - `gpt-5-mini`
  - five Gemini rows
  - two GLM-5.3 rows

**Catalog order bug.**
- At `model-metrics.ts:815`, `/3\.[56]-flash/` matches `gemini-3.5-flash-lite` before the Flash-Lite branch at `:844`. Result: `defaultLevel: "medium"`.
- `clampReasoningEffort` returns the model's **default** for an unsupported tier (`:1028-1039`). Confirmed: `"minimal"` on Gemini 3.8 Flash goes out as `MEDIUM`.
- A floor helper therefore has to read the model's own ladder, as `geminiContinuationConfig` already does (`gemini-core.ts:309-345`).

**Timeouts and billing.**
- `ATTEMPT_TIMEOUT_MS = 20_000`. A timed-out attempt is marked transient and retried once after 2.5 s (`memory.ts:259, 498, 585-597`).
- An aborted attempt is billed from characters of visible text only (`memory.ts:509-518`), so thinking tokens are not counted. That is a metering issue; it belongs in `metering-findings.md`.

**Triage.**
- `attemptTriage` sends no effort, no `role` and no `promptCache` (`preflight-triage.ts:249-257`), so `llm.ts:212` labels it `"chat"`.
- Candidates are ranked by intelligence (`:70-94`), so Gemini 3.8 Flash goes first at MEDIUM.
- Time budget: 2,000 ms first attempt and 2,800 ms total (`:35-36`).

**Research worker.**
- `anthropicWorkerRequest` sends no `thinking` and no `output_config` (`research/agents/worker-loop.ts:365-383`). The worker resolves to `claude-haiku-5-5` (`or-haiku.ts`).
- Anthropic's table: Haiku 5.5 with "No `thinking` field" = adaptive thinking, default effort `medium`.
- The worker pushes `response.content` back into the transcript unchanged (`worker.ts:450`). Haiku 5.5 is a keep-all model, so those thinking blocks are re-read as input on later calls.
- No `llm.request` record exists for worker calls. They use the SDK directly (`worker.ts:437`).

**Research side stages.**
- `expandResearchQueries` runs on the lead (`runLeadModel`, `tools.ts:903-937`) with no effort.
- The citation judge runs on the user's chosen lead only when `plan.envelope.chosen` is set (`run.ts:962-972`); otherwise it uses `runUtilityPrompt`.
- `JUDGE_OUTPUT_TOKENS = 200`, while the wire allows 16,584 tokens on Opus 5.5 and 32,200 on Fable 5.1 (`floors-leads.txt`).
- `auditEstimateMicroUsd` prices only the visible cap (`domain.ts:2274-2287, 2359-2362`).

**Code runner side calls.** Auto-review (`harness/auto-review.ts:145-152`, `cache:false`), the Work judge (`work/judge.ts:112-146`), the goal check (`:237-273`) and the compaction summary (`compaction.ts:654-680`) all omit `reasoningEffort`. On Opus 5.5, `anthropicThinkingBits` then runs adaptive medium with headroom; on Fable 5.1 it runs high.

**Compat tool rounds.**
- `openai-compat.ts:674-682` builds the assistant tool-call message from `content` and `tool_calls` only.
- Round reasoning is streamed out (`:598-611`) but never kept.
- `compatToolCallMessage` and `compatHistoryAssistantMessage` exist in `src/lib/llm/compat-loop.ts:243-375` and are tested (`tests/compat-reasoning-replay.test.ts`), but **nothing in production calls them**. A grep of `src/` for `runCompatLoop` and `compatToolCallMessage` outside that file finds nothing.

**OpenAI summaries.** `reasoning.summary:"detailed"` is sent whenever the effort is not `none` (`openai-responses.ts:415, 490-495`). The research `utilityCompletion` discards reasoning events (`tools.ts:302`).

**No guard against runaway output.** Paid plans set `maxOutputTokens: 200000` (`plans.ts:118-250`). `pumpTurnStream` has no repetition guard (`chat/turn/run-stream.ts:44`).

**Relay.** The OpenAI session update sets no output cap (`relay/src/providers/registry.ts:27-39`). `interrupt()` sends only `response.cancel` (`openai-realtime.ts:234-241`).

**"Checked and found fine" (§3 of the findings).** I spot-checked `maxRetries: 0` on all three SDK clients and the pre-first-byte retry rule (`chat/turn/pre-stream-retry.ts`). Both hold.

### Corrections to the findings

1. **O4 clarify and brief are dead paths.** Both engines set `draftPlan` (`run.ts:946, 1030`). `stages/planning.ts:73` skips clarify when `draftPlan` exists, and `:313` routes to `doStructuredPlanning`. Their claimed $0.027 per run is $0.
2. **O4's judge input was overstated.** `JUDGE_SYSTEM` is ≈870 chars (`claims.ts:94`) and the passage is at most 1,600, so input is ≈700 tokens, not 1,500. Thinking dominates more than the findings assumed. Recomputed in K3.
3. **`plannerReasoningEffort` is the wrong helper** for "lowest tier", as aux-routing found. It returns `low` for Sonnet 5.5, Haiku 5.5 and Luna, which are non-thinking at their defaults today, so it would turn thinking **on** (`floors-free.txt`, `planner=low` on every Anthropic and OpenAI row). K1 and K3 use a new floor helper that returns `undefined` for any model that can turn thinking off.
4. **The Flash-Lite regex fix is not needed for the saving.** Both branches put `minimal` first on the ladder, so the floor is `minimal` either way. The fix would change the default thinking level for people who **chose** Flash-Lite in chat (MEDIUM → MINIMAL), and that is a user-chosen-model change (R6).
5. **O5 compaction: lowering effort would raise cost.** The layered summary is sent as a *prefix replay* so that it can read the prompt cache (`compaction.ts:632-636`). Anthropic: "The resolved effort value is rendered into the prompt, so changing it between requests invalidates cache breakpoints." Setting a different effort on the replay forfeits the cache it was built to read. And today **it already omits the session's effort**, which is K5.
6. **O1's `includeThoughts` drop has no billing effect.** Gemini bills the full thought tokens whatever summary is returned; this rests on community and third-party sources, because ai.google.dev was blocked. Anthropic documents "Summary generation: No charge".
7. **Triage volume.** Native apps never call `/api/chat/clarify`, so O2 applies to web sends only.

### Provider rules, checked against official docs (fetched 2026-10-31)

**Anthropic thinking** (per-model table):
- Haiku 5.5 with "No `thinking` field" = adaptive thinking. `disabled` = "Thinking off at `high` effort or below".
- Opus 5.5 and Fable 5.1 reject `disabled`.
- Haiku 5.5 with thinking off "can skip a tool call it needs when you also request JSON output".
- Haiku 5.5, Opus 5.5, Sonnet 5.5 and Fable 5.1 keep all prior thinking blocks, which "are billed as input tokens like the rest of the conversation history".
- "Changing … the effort value all invalidate cache breakpoints: message-level breakpoints always miss, and tool and system-prompt breakpoints can miss too."

**Anthropic steering thinking:**
- "`medium` (default on Claude Opus 5.5 and Claude Haiku 5.5)"; "`high` (default on most models)".
- "Setting `effort` explicitly to the model's default is equivalent to omitting it and does not break the cache."
- `max_tokens` "is a hard cap on total output for the request, thinking and response text combined".
- Thinking is billed as output. Summary generation: "No charge". `usage.output_tokens_details.thinking_tokens` gives the reasoning count.

**Anthropic pricing:**

| Model | Input | 5m write | 1h write | Hit | Output |
| --- | --- | --- | --- | --- | --- |
| Opus 5.5 | $4 | $5 | $8 | **$0.20 (0.05x)** | $20 |
| Sonnet 5.5 | $2 | $2.50 | $4 | **$0.10 (0.05x)** | $10 |
| Fable 5.1 | $10 | $12.50 | $20 | **$0.25 (0.025x)** | $50 |
| Haiku 5.5 (≤100K prompt) | $0.10 | — | — | $0.01 | $0.50 |
| Haiku 5.5 (>100K prompt) | $0.50 | — | — | — | $2.50 |

All prices are per million tokens. Batch is −50%. The 1M context is billed at standard prices on 4.6 and later models, except Haiku 5.5.

**DeepSeek** (official page blocked; search snippets of `api-docs.deepseek.com/guides/thinking_mode` and a DeepSeek GitHub discussion): "For requests carrying the tools parameter, the reasoning_content must be fully passed back … If your code does not correctly pass back reasoning_content, the API will return a 400 error." This matches the repo's own audit (`docs/chat-rework/audit/gap-provider-tool-capabilities.md:50-61`), which also lists MiMo, and Kimi K2.5/K2.6 with a 400 error string.

**Not verifiable from this session:** ai.google.dev, developers.openai.com and api-docs.deepseek.com do not resolve. That leaves open:
- Gemini levels and defaults
- GLM-5.3 and Kimi K3 default `max`
- whether OpenAI bills summaries
- Realtime field names

These rest on the repo's dated citations in `model-metrics.ts:730-990`. **Those domains must be allowed in the session's network settings** to close them.

---

## 2. Kept items

### K1. Floor effort for utility calls on always-on models (O1, narrowed; same as aux-routing K1, counted there)

**Change.**
- Add `utilityReasoningFloor(model)` to `src/lib/model-metrics.ts`:
  - It returns `undefined` when `!model.reasoning`, `canDisable`, `onOff` or `tiers.length === 0`. Those callers stay byte-identical to today.
  - Otherwise it returns `REASONING_TIERS.find(t => caps.tiers.includes(t))`.
  - It never goes through `clampReasoningEffort`, which falls back to the model's default (correction 3).
- Give `runUtilityPrompt` an option `reasoning?: "floor" | "default"`, defaulting to `"default"`. Callers opt in per label:
  - **Now:** `titles`, `follow-ups`.
  - **After memory-bench parity:** memory extract and consolidate, dreaming, history summary, agent reflection.
  - **After `npm run test:moderation` parity:** moderation.
  - **Never:**
    - `channels/reply.ts` (user-visible answers)
    - `teach/server.ts`
    - `api/memory/edit`
    - `api/i18n/translations`
- `llm.ts` needs no change. A floor tier passed in shrinks the allowance from 16,384 to 2,048 or 4,096 by itself (`floors-free.txt`: 16,584 → 2,248 on Flash-Lite, 4,296 on GLM-5.3).

**Saving per call** (2,000 tokens in, 150 visible out; `calc-report.txt`):

| Model | Today → floor | Per call | Change |
| --- | --- | --- | --- |
| Flash-Lite | MEDIUM → MINIMAL | 1,725–2,475 → 1,050–1,100 µ$ | **−39% to −56%** |
| GLM-5.3 FlashX | MAX → LOW | 2,178–4,053 → 1,115 µ$ | **−49% to −72%** |

Anthropic, OpenAI, DeepSeek and Qwen accounts save $0. Monthly per-account figures are in aux-routing K1 (≈$0.54 for a Gemini account, ≈$1.61 for a Zhipu account).

**Quality and latency.** Titles and pills are decoration and already run without thinking on Haiku and Luna, so there is no risk. Memory and moderation are gated. Latency only improves, and fewer attempts hit the 20 s timeout and its retry.

**Tests.**
- `tests/model-reasoning-capabilities.test.ts`: pin the floor for every FREE model:
  - `gemini-3.5-flash-lite` → `minimal`
  - `gemini-3.8-flash` → `low`
  - `glm-5.3-flash(x)` → `low`
  - `gpt-5-mini` → `minimal`
  - `claude-haiku-5-5`, `claude-sonnet-5-5`, `gpt-6-luna`, `deepseek-flash` → `undefined`
- `tests/utility-attempt.test.ts`: `"floor"` forwards the tier and `"default"` forwards nothing.
- `tests/background-provider-callers.test.ts`: the "never" callers do not opt in.
- `tests/model-effort-wire.test.ts`: snapshot the Gemini and GLM utility bodies at the floor.

**Measure.**
- `llm.request` with `role` starting `utility:` (K6), by provider and model, 7 days before and after:
  - `tokens.reasoning / tokens.output`
  - `costUsd` per call
  - p50 and p95 `latencyMs`
  - share with `ok=false`
- `[label] … unusable output` and `timed out after` log counts.

### K2. Triage at its floor tier, plus a role label (O2; same as aux-routing K2 step 1, counted there)

**Change** (`src/lib/preflight-triage.ts:249`):
- Pass `reasoningEffort: utilityReasoningFloor(model)`. That is `low` on Gemini 3.8 Flash and GLM-5.3; Luna stays at `none`.
- Pass `role: "utility:triage"` and `promptCache: "none"`. The 730-token system prompt is below every lab's caching minimum.

**Saving per call** (`calc-report.txt`): 2,400–3,900 → 1,650–2,213 µ$ (**−31% to −43%**). Per triaged web turn that is 450–1,013 µ$. The range spans assumed thinking of 300–600 tokens at MEDIUM and 100–150 at LOW, which K6 replaces with measurements.

**Quality and latency.**
- Triage is on the send critical path (`use-chat.ts:1825-1830` awaits it, with a 3.5 s abort). Less thinking means a faster first token and fewer 2 s timeouts.
- It also changes what the user sees: more triage results will now arrive in time, so more clarification cards may appear. Check this first.
- **Gate:** run `npm run test:clarify` (`scripts/test-clarify.ts`) once at MEDIUM and once at LOW, with the same battery. Ship if:
  - shape violations stay at 0, and
  - expectation-mismatch warnings at LOW ≤ at MEDIUM.

**Tests.** New `tests/preflight-triage.test.ts`: the floor is forwarded, the role is `utility:triage`, and Luna gets no effort.

**Measure.**
- `llm.request` with `role=utility:triage`: `tokens.reasoning`, `latencyMs`, share with `ok=false`.
- `[clarify-triage] … timed out` lines per day.
- Card show and accept rate, before and after.

### K3. Research judge and expand at the floor, on always-on chosen leads (O4 narrowed; same as aux-routing K4, counted there)

**Scope.** Only `expandResearchQueries` (`tools.ts:928`) and the chosen-lead judge (`run.ts:970` → `researchModelCompletion`).
- Only when `utilityReasoningFloor(lead)` is defined: Opus 5.5, Fable 5.1, GPT-6 Astra and 6.1 Sol, Gemini 3.x Pro and Flash, GLM-5.3, Kimi K3 (`floors-leads.txt`).
- Clarify and brief are dropped (correction 1).
- The lead review and the writer are not touched; they are the research itself.

**Saving per run** (judge input ≈700 tokens, 80 visible out; thinking assumed; `calc-report.txt`):

| Lead | Per call | 24 calls | 48 | 96 | 160 |
| --- | --- | --- | --- | --- | --- |
| Opus 5.5 (medium → low, 200→80 to 400→120 thinking) | −29% to −45% | $0.06–0.13 | $0.12–0.27 | $0.23–0.54 | $0.38–0.90 |
| Fable 5.1 (high → low, 400→100 to 800→150) | −48% to −64% | $0.36–0.78 | $0.72–1.56 | $1.44–3.12 | $2.40–5.20 |

**Quality gate (blocking).** The judge's verdicts repair a report the user reads, on the model they chose.
- `scripts/eval-research-citations.ts` only runs stub judges today ("A live-model judge is NOT run here"). Add a `--live <model> --effort <tier>` mode over `src/lib/eval/research-citation-cases.ts`.
- Ship only if, against the same model at its default effort:
  - verdict agreement is ≥98%,
  - supported precision is ≥95%, and
  - there is **zero** increase in false "supported".
- Expand ships on parity of the unanswered-question share and sources per objective, over 10 fixed goals run through `scripts/seed-research-e2e.ts`.

**Files.**
- `src/lib/research/tools.ts`: `researchModelCompletion` accepts `reasoningEffort` and forwards it to `utilityCompletion`, which already takes it (`:286-300`); expand passes the floor.
- `src/lib/research/run.ts:970`: pass the floor, behind `RESEARCH_JUDGE_FLOOR=1`.

**Tests.** `tests/research-run-models.test.ts`, `tests/research-citations.test.ts`: the effort is forwarded only for always-on leads, and is absent for Sonnet 5.5 and Luna leads.

**Measure.** `llm.request` with `role=research:citation` / `research:expand` (K6): `tokens.reasoning`, `costUsd` per run, and the audit's verdict distribution per tier.

### K4. Send each tool round's reasoning back on OpenAI-compatible labs (O6)

**Confirmed today.**
- The production adapter (`streamOpenAICompat`) drops reasoning from every assistant tool-call message (`openai-compat.ts:674-682`).
- It also never adds `reasoning_content` to DeepSeek history when tools are offered.
- The correct helpers exist in `src/lib/llm/compat-loop.ts` and are unit-tested, but nothing calls them.

**Who is affected.**
- **DeepSeek V4 Pro and V4.1 Flash, at any effort other than Instant.** The official rule above says this is a 400 once `tools` are present. Defaults are Instant (`defaultLevel: null`, `floors-free.txt`), so only people who picked a thinking level are hit, and those are the people who care most.
- **MiMo with thinking on**, per the repo audit.
- **Kimi K3**: always on; enforcement still to be probed (P5).
- **"should" labs: GLM-5.3, MiniMax `reasoning_details`, Qwen 3.8.** Each tool round starts reasoning from scratch.

**Change.**
- `src/lib/openai-compat.ts`:
  - Accumulate the round's reasoning: `roundReasoning += reasoningText`, and keep the last MiniMax `reasoning_details` shape. Do this in the delta loop at `:598-611`.
  - Build the tool-call message with `compatToolCallMessage(toolCapabilitiesFor(model), assistantText, roundReasoning, calls)` in place of the literal at `:674-682`.
  - Build assistant history with `compatHistoryAssistantMessage` when `compatToolsOffered(...)` holds. Today only DeepSeek `must` adds a field there.
- Ship `replay: "must"` now. Put `replay: "should"` behind `COMPAT_REASONING_REPLAY_SHOULD`.

**Cost.**
- **Today:** a thinking-mode tool turn on DeepSeek, MiMo or Kimi pays for round 1 (≈2,300 µ$ on DeepSeek Flash with 12k in and 800 thinking), then fails. A regenerate pays again.
- **After:** round 2 re-reads ≈800 reasoning tokens as input (≈120 µ$).
- For "should" labs the net effect is unmeasured. The findings' "−40% of reasoning tokens" is illustrative only, so it is not claimed here.

**Quality risk.** None. This sends back what each lab documents, the same way `openai-responses.ts:475-482` already replays `encrypted_content`. The model and effort stay the user's.

**Tests.**
- `tests/production-adapter-loops.test.ts` (it already drives `streamOpenAICompat` with scripted SSE). Add:
  - a two-round DeepSeek thinking case: the round-2 request's assistant message carries `reasoning_content` equal to the streamed text;
  - a MiniMax case with `reasoning_details` carrying the kept shape;
  - a Qwen "should" case where empty reasoning means the field is absent;
  - DeepSeek Instant: no field.
- `tests/compat-reasoning-replay.test.ts`: assert `openai-compat.ts` imports the helpers, so the unwired copy cannot drift again.
- Live probes P4, P5 and P7 (`model-tools.ts`).

**Measure.**
- `llm.request` with `round ≥ 1` on deepseek, mimo and moonshot: share with `ok=false` (should drop to near 0).
- On zhipu, minimax and qwen: `tokens.reasoning` and `tokens.input` per round. Keep "should" only if the $ value of reasoning saved exceeds the $ value of input added.

### K5 (new). The Code compaction summary replay must carry the session's effort and cache key

**Found.**
- The layered compaction summary is sent "as a continuation of the conversation (same system, tools and message prefix) so it reads from the prompt cache" (`runner/agent-core/src/compaction.ts:632-636`).
- But neither `compactConversation` nor `requestModelSummary` receives the session's `reasoningEffort` or `cacheKey` (`loop.ts:403-415`, `567-577`; `agent.ts:694-703`).
- The main loop sends both (`loop.ts:701-702`; `agent.ts:805-806`, `cacheKey: this.store.id`).
- Probe output (`compaction-replay-probe.txt`): the summary request is `{"tools":1,"msgs":179,"maxTokens":8192}`, with no effort, no cache key, and caching left on (the default).

**Why it costs money.**
- On Anthropic, a different resolved effort or thinking type "invalidate[s] cache breakpoints". Any session whose effort is not the API default therefore gets its replay rewritten at 1.25x, and nothing ever reads that write back. Examples:
  - Opus 5.5 at high, xhigh, max or low (default is medium).
  - Sonnet 5.5 or Haiku 5.5 with thinking on. The replay sends `between_tools` or `disabled`, and `toAnthropicMessages` also strips thinking blocks when thinking is off.
- Sessions at the default effort are unaffected: "Setting `effort` explicitly to the model's default is equivalent to omitting it".
- On OpenAI, xAI, Mistral and Meta, the missing `cacheKey` sends the replay without the session's `prompt_cache_key`, so it can be routed away from the server that holds the prefix.

**Saving.**
- P = the replayed prefix:
  - ≈94K tokens on a 200K window (trigger 126K minus the 32K protected tail)
  - ≈640K on a 1M window (800K minus 160K)
- f = the share of P before the first message the prune layer changed, whose cache entry is still live. Only that share can be read.

| Model | P | f = 0.3 | f = 1.0 |
| --- | --- | --- | --- |
| Opus 5.5 | 94K | $0.14 | $0.45 |
| Opus 5.5 | 640K | $0.92 | $3.07 |
| Sonnet 5.5 | 94K | $0.07 | $0.23 |
| Sonnet 5.5 | 640K | $0.46 | $1.54 |
| Fable 5.1 | 94K | $0.35 | $1.15 |
| Fable 5.1 | 640K | $2.35 | $7.84 |

Savings are per summarize compaction (`calc-report.txt`).

**The offset.** A user who chose a higher effort now gets their summary written at that effort: about +2,000 thinking tokens, or $0.02 (Sonnet 5.5), $0.04 (Opus 5.5) or $0.10 (Fable 5.1). A user who chose a lower effort pays less on both sides.

**Why f is uncertain.** The prune layer rewrites old tool results before the summary layer runs (`harness/context.ts:76-96`). Anthropic also only reads entries written at earlier breakpoints within their 5-minute TTL. So f may well be small.

**Change, in two steps.**
1. **Now (no downside):** thread `cacheKey` through:
   - `CompactConversationInput.cacheKey`, passed from the loop's `opts.cacheKey` at `loop.ts:567` and from `this.store.id` at `agent.ts:694`;
   - `requestModelSummary`, replay branch only.
   This changes routing on OpenAI-family labs only. There is no write premium, and output does not change.
2. **Measure-gated:** thread `reasoningEffort` the same way (`opts.reasoningEffort`, `this.reasoningEffort`), replay branch only. Leave the fallback non-replay request (`cache:false`) exactly as it is.
   - **Decision rule:** from runner usage on `context_compacted` events with `strategy:"summarize"`, take sessions **at the default effort** (they already match). If their median `cacheReadTokens / inputTokens` is ≥ 0.2, ship step 2: the read saving then beats the extra thinking at P ≥ 94K.
   - If it is lower, the replay design itself rarely hits. Raise that with the cache-prefix owner (for example, cache only system and tools on the replay) instead of shipping step 2.

**Quality risk.** None. The summary is written by the user's model at the user's effort, which is the configuration they chose, rather than the API default. No cache is shared: `store.id` is per session, and Anthropic caches are workspace-isolated.

**Tests** (`runner/agent-core/src/test/compaction.test.ts`):
- The layered replay request carries `cacheKey` (step 1), and `reasoningEffort` (step 2), equal to the loop's.
- The non-replay retry still sends `cache:false` and no effort.
- `test/agent.test.ts`: manual `/compact` passes `store.id`.

**Measure.**
- Runner usage per compaction: `cacheReadTokens`, `cacheWriteTokens` and `inputTokens`, split by "session effort == default".
- Cost per summarize compaction, before and after.

### K6. Label every aux request; meter research workers and runner side calls (O10; aux-routing K11 extended)

**Change.**
- **Labels** (as in K11):
  - `runUtilityPrompt` passes `role: \`utility:${label}\`` (`memory.ts:469`).
  - Triage passes `"utility:triage"`.
  - `utilityCompletion` passes `research:${label}` (`research/tools.ts:290`).
- **New here, research workers:** wrap each `client.messages.create` / `chat.completions.create` in `worker.ts:437, 544` with `createRequestMeter({ role: "research:worker", … })`. Feed it `usage.output_tokens_details.thinking_tokens`, or `completion_tokens_details.reasoning_tokens` on compat. Today no per-request record exists.
- **New here, runner side calls:**
  - Add `reasoningTokens?` to the runner `Usage` (`runner/agent-core/src/types.ts:11`).
  - Read it in `providers/anthropic.ts` from `output_tokens_details.thinking_tokens`. Today it is not captured anywhere in the runner.
  - Tag usage per side call: `reviewer`, `work-judge`, `goal-check`, `compaction`.

**Saving.** None directly. This is the instrument that turns K1–K5 from assumptions into measurements. It also decides whether R1 and R4 (rejected today) are ever worth revisiting.

**Tests.**
- `tests/usage-metering-coverage.test.ts`: every `runUtilityPrompt` caller yields a labelled role.
- `tests/research-worker.test.ts`: one meter record per worker call with `role=research:worker` and a reasoning count.
- `runner/agent-core/src/test/thinking.test.ts`: usage parse carries `reasoningTokens`.

### K7. Repetition detector in shadow mode (O9, narrowed)

**Change.**
- New `src/lib/chat/turn/repetition-watch.ts`, fed from the text branch of `pumpTurnStream` (`run-stream.ts:44`).
- Run it incrementally, every ≥1,000 new characters, over the last 4,000 characters of visible text outside code fences.
- On a 200+ character unit repeated 8 or more times back to back, log `chat.repetition_suspect` with provider, model, characters so far, period and repeat count.
- **It never aborts.**

**Why shadow mode only.** Some legitimate requests repeat on purpose ("write this line 100 times", refrains, generated fixtures). Aborting would cut a real answer from the user's model. The findings estimate the saving at under 0.5% of spend, with no measured incidents. Data comes first.

**Tests.** New `tests/repetition-watch.test.ts`:
- Fires on a synthetic loop.
- Silent on markdown tables, numbered lists and fenced code.
- Cost is O(n) per check.

**Measure.**
- Triggers per 10k turns, by model.
- p99.9 output tokens per turn.
- A manual review of 50 triggers.
- An abort mode is a separate decision, made only if the triggers are near-certain loops on specific open-weight models.

---

## 3. Rejected

- **R1. O3: research worker (Haiku 5.5) at `effort:"low"`.**
  - The saving is 535 → 450 µ$ per call, ≈$0.017 per standard run (`calc-report.txt`): under 1% of a run.
  - The worker's step choices are research quality, in a product meant to beat ChatGPT and Claude deep research.
  - Anthropic warns that lower effort on Haiku 5.5 trades depth, and that thinking off "can skip a tool call it needs".
  - Not worth an eval cycle. Keep the meter (K6) and revisit only if measured worker reasoning turns out large.
- **R2. O5: auto-reviewer at a lower effort.** It is a fail-closed safety gate on the user's own session model. A missed deny is unbounded harm; the saving is ≤$0.27 per auto-mode session (`calc-report.txt`). There is no labelled approval set to prove "zero extra allows". Only its caching (aux-routing K10) is kept.
- **R3. O5: compaction summary at a lower effort.**
  - It would change the effort on a request built to read the session's cache, which invalidates it per Anthropic's rule, so it would *raise* cost (correction 5).
  - The summary is what the user's model continues from, so its quality is answer quality.
  - Replaced by K5, which does the opposite.
- **R4. O5: Work judge and goal-criteria check at a lower effort.**
  - The saving is ≈4,400 µ$ per Work run on Opus 5.5 (`calc-report.txt`): negligible.
  - The goal check decides whether a standing goal is MET, and a false MET stops the user's work early.
  - The "addressed" verdict is shown as an unmet note.
  - Not worth the risk or the eval.
- **R5. O4: clarify and brief savings.** No saving exists. Both are dead in production (correction 1).
- **R6. O1 sub-items:**
  - **(a) Fixing the Flash-Lite catalog order as a cost lever.** It changes the default thinking of users who chose Flash-Lite in chat. Report it to the owner as a bug and a product decision. K1 does not need it (correction 4).
  - **(b) Dropping `includeThoughts`.** No billing effect (correction 6).
  - **(c) Changing the post-timeout retry.** K1 removes most of the timeouts that are long because of thinking, and the retry is the walk's fallback for an overloaded provider.
  - **(d) Letting FREE background work use PRO-gated MiniMax M3 or M3.1-Flash.** That is an entitlement change. Price ranking among eligible models is aux-routing K5.
- **R7. O7: `reasoning.summary` `"detailed"` → `"auto"`.**
  - Billing is unverified: developers.openai.com is blocked, and the repo comment's "≈2.5k output tokens" measures summary size, not billing.
  - The detailed reasoning panel is a user-visible feature the owner wants at ChatGPT parity.
  - For aux callers that discard reasoning (research `utilityCompletion`), even a billed summary is a few planner and expand calls per run, which is negligible.
  - Optional: the findings' 50-prompt A/B probe, only if the owner wants the answer.
- **R8. O8: thinking headroom.** It is not a separate lever; the cap bills nothing, and K1–K3 shrink it automatically. Re-pricing the research pre-spend estimate (`domain.ts`) changes `affordable()` and could refuse stages a user paid for. That belongs to the metering dimension.
- **R9. O11: per-response output cap on realtime voice.** A p99.9 cap by definition cuts 0.1% of legitimate spoken answers (a story, a long explanation), and no runaway has been measured. The `conversation.item.truncate` half is voice-realtime V9 (OpenAI is the fallback path there) and is not counted here.
- **R10. O12: `text.verbosity`.** Not allowed on chat, because it changes answer length. Utility prompts already bound their output, so the saving there is under 1% of utility output. Not worth a change.
- **R11. O9 abort mode.** Not before K7's shadow data (see K7).

---

## 4. Order

1. **K6** (labels, worker meter, runner thinking tokens). Everything below is measured with it.
2. **K4 `must` labs** (a correctness fix), **K5 step 1** (cache key) and **K7** (shadow mode).
3. **K1** titles and pills; **K2** after one `test:clarify` A/B run.
4. **K5 step 2**, after the one usage query in its decision rule.
5. **K1** memory labels, after memory-bench. **K4 `should` labs**, after one week of round metrics.
6. **K3**, after the live-judge eval. **K1** moderation, after test-moderation.

---

## 5. Sources

**Fetched 2026-10-31:**
- Anthropic, Thinking: per-model "No `thinking` field" table; Haiku 5.5 `disabled` caveat; keep-all preservation; configuration changes invalidate caching. https://platform.claude.com/docs/en/build-with-claude/thinking
- Anthropic, Steering thinking: effort defaults; effort changes invalidate cache; an explicit default equals omitting it; `max_tokens` caps thinking and text together; summary generation is free; `thinking_tokens`. https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost
- Anthropic, Pricing: the rates table above; Batch −50%; 1M context at standard pricing. https://platform.claude.com/docs/en/about-claude/pricing

**Search results only** (the official host was blocked):
- DeepSeek thinking mode (reasoning_content must be passed back with tools, or 400): https://api-docs.deepseek.com/guides/thinking_mode/ and https://github.com/deepseek-ai/deepseek-harness/discussions/739
- OpenAI reasoning summaries (billing not settled by any result): https://developers.openai.com/api/docs/guides/reasoning.md
- Gemini thought summaries (billed on full thought tokens; community source): https://discuss.ai.google.dev/t/pricing-for-gemini-2-5-api-with-and-without-thinking-option-in-the-official-release/94510

**Repo:**
- Prices: `src/lib/model-rates.generated.ts` (verified 2026-10-18).
- Caps: `src/lib/model-metrics.ts:673-1040`.
- Replay audit: `docs/chat-rework/audit/gap-provider-tool-capabilities.md:50-61`.

**Sibling verifications, for overlap:** `scratchpad/cost/aux-routing-verified.md` (K1, K2, K4, K5, K10, K11) and `scratchpad/cost/voice-realtime-findings.md` (V9).
