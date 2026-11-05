# Output and reasoning tokens: findings

Dimension: `max_tokens` defaults, reasoning effort and thinking budgets per model and per task, verbosity, retries that regenerate answers, continuation, aborted streams, and duplicate requests on reconnect.

Repo: `/home/user/juno` at `e532983ea`. I only read files; nothing in the repo was changed. The helper scripts used to compute the wire parameters are in `docs/handoff/2026-10-31/cost/scripts/`.

Constraint, as the owner set it: the user-chosen model, its effort and its answer quality do not change. Every change below touches only auxiliary work: titles, memory, moderation, triage, research side stages, Code reviewers. The exceptions are O6, which changes nothing the user chose and should improve tool-use quality, and O9, a safety cap.

---

## 0. How the estimates are built (read this first)

**Prices** come from the repo's rate table `src/lib/model-rates.generated.ts`, marked verified 2026-10-18. I re-checked the Anthropic rows today on platform.claude.com/docs/en/about-claude/pricing.

| Model | Input $/MTok | Output $/MTok (thinking billed as output) |
|---|---|---|
| Claude Haiku 5.5 | 0.10 | 0.50 |
| Claude Opus 5.5 | 4 | 20 |
| Claude Fable 5.1 | 10 | 50 |
| Gemini 3.8 Flash | 0.75 | 3.75 |
| Gemini 3.5 Flash-Lite | 0.30 | 2.50 |
| GLM-5.3 FlashX | 0.37 | 1.25 |
| GPT-6 Luna | 0.10 | 0.50 |
| MiniMax M2.7-highspeed | 0.60 | 2.40 |

**Thinking tokens per auxiliary call.** These are assumptions, not measurements, and they drive every percentage below. I picked them for a short, structured prompt (at most about 3k tokens in, at most about 300 visible tokens out):

| Level | Assumed thinking tokens (range) |
|---|---|
| off / none / minimal | ~50 (0–150) |
| low | ~150 (50–400) |
| medium | ~600 (300–1,500) |
| high | ~1,200 (500–3,000) |
| max | ~2,500 (1,000–6,000) |

Section O10 explains how to replace these numbers with real ones. `llm.request` already records `tokens.reasoning` for every request.

**Per-turn reference profiles** (µ$ means micro-USD, millionths of a dollar):

- **P1, Anthropic-anchored, Sonnet 5.5 chat.** About 17,000 µ$ per cached turn (COST_ENGINEERING.md §5).
- **P2, OpenAI-anchored, FREE default GPT-6 Luna at Low.** About 800 µ$ per turn:
  - input: 10.5k cached × 0.01 + 1.5k fresh × 0.10 ≈ 255 µ$
  - output: (800 visible + 300 reasoning) × 0.5 ≈ 550 µ$
- **P3, Google-anchored, Gemini 3.8 Flash chat at medium.** About 10,500 µ$ per turn:
  - input: 10.5k × 0.075 + 1.5k × 0.75 ≈ 1,900 µ$
  - output: (800 + 1,500) × 3.75 ≈ 8,600 µ$
- **Background calls per saved turn.** I assume 2.0 effective calls:
  - memory extraction: about 1 per turn
  - AI moderation: about 1 on moderated accounts, unless the quick regex screen settles it first
  - title: about 0.1
  - follow-up pills: about 0.3, native apps only
  - history summary: about 0.05
- **Triage.** `/api/chat/clarify` runs on about 60% of turns. That is my estimate of what `quickPreflightSkip` lets through; it skips messages of 8 characters or fewer, code and errors, attachments, messages over 2,000 characters and "just answer".

---

## 1. What happens today: every model call outside the user's own chat turn

The **wire** column is what actually goes to the provider. I computed it by calling the repo's own builders (`geminiGenerationConfig`, `buildAnthropicThinkingBits`, `clampMaxTokens` and the allowance in `llm.ts`) from scratch scripts.

| Call site | Model picked | Effort passed | What goes on the wire | Verdict |
|---|---|---|---|---|
| `runUtilityPrompt` (`src/lib/memory.ts:469-476`): titles, memory extract and consolidate, moderation, follow-ups, history summary, memory edit, i18n, reflections, iMessage replies, teach | first FREE model of the conversation's provider (`utilityModelCandidates`, `memory.ts:127-141`), under the `same_provider` policy | **none** | Haiku 5.5: `thinking:{type:"disabled"}`, max 1,024 ✓<br>GPT-6 Luna: `reasoning.effort:"none"` ✓<br>DeepSeek Flash: `thinking:disabled` ✓<br>Grok 4.3: `none` ✓<br>MiMo and Qwen: off ✓<br>**Gemini 3.5 Flash-Lite: `thinkingLevel:"MEDIUM"`, `maxOutputTokens: 16,884`** ✗<br>**GLM-5.3 FlashX: no effort sent, so the API default `max` applies; `max_tokens: 16,884`** ✗<br>**MiniMax M2.7-highspeed: always reasons, no control** ✗ | O1 |
| Preflight triage (`src/lib/preflight-triage.ts:249-257`), on about 60% of turns | Gemini 3.8 Flash, then GLM-5.3 FlashX, then GPT-6 Luna (`:70-94`, ranked by intelligence) | **none** | **Gemini 3.8 Flash: `MEDIUM`, `maxOutputTokens 17,584`**<br>**GLM fallback: `max`** | O2 |
| Research worker (`src/lib/research/agents/worker-loop.ts:365-383`, sent at `worker.ts:437`) | Claude Haiku 5.5 (`worker.ts:90-120`) | no `thinking` field | Haiku 5.5 **thinks by default at medium** (Anthropic's per-model table). `max_tokens: 2,048` holds thinking and answer together | O3 |
| Research clarify, brief and expand (`src/lib/research/tools.ts:553-569`, `:632-645`, `:928-940`) | the user's lead model | none | always-on models run at the API default: Opus 5.5 medium (max 17.4k), Fable high (max 33k), GLM-5.3 and Kimi K3 max | O4 |
| Research citation judge (`src/lib/research/run.ts:962-971`, then `tools.ts:256-266`), 24, 48, 96 or 160 calls per tier (`domain.ts:1318-1364`) | the user's lead model | none | same as the row above, at `JUDGE_OUTPUT_TOKENS = 200` (`domain.ts:2225`). On Fable the wire allows 33,024 tokens | O4 |
| Research audit-assist (`tools.ts:951-965`) | worker model (Haiku 5.5) | none | Haiku 5.5 disabled ✓ (it goes through `streamChat`) | ok |
| Research planner (`tools.ts:381-400`, `:440-449`) | lead model | `plannerReasoningEffort`, which is low or the model's floor (`tools.ts:360-366`) | ✓ already right | precedent |
| Research lead review (`agents/lead.ts:247-257`) and writer (`tools.ts:1059-1075`) | lead model | none, so the model's default | core research quality: leave as is | measure only |
| Memory dreaming through the Batch API (`src/lib/batch/providers.ts:53-58`) | cheapest batch-capable utility model | "none" where the model can disable thinking, else "low" | ✓ **the policy every other auxiliary path should copy** | precedent |
| Code auto-reviewer (`runner/agent-core/src/harness/auto-review.ts:144-152`), Work judge (`work/judge.ts:112-146, 273`), compaction summary (`compaction.ts:655-678`) | inherit the session model (`agent.ts:920-929`, `harness/routing.ts:223-229`) | none | on an always-on parent the API default runs: Opus 5.5 medium plus 16k headroom, Fable high plus 32k (`providers/thinking.ts:128-158`) | O5 |
| Chat tool rounds on OpenAI-compatible labs (`src/lib/openai-compat.ts:674-682`) | user's model | user's | **reasoning is not sent back** on the assistant tool-call message | O6 |
| OpenAI chat reasoning summary (`src/lib/openai-responses.ts:415, 494`) | user's model | user's | `reasoning.summary:"detailed"` on every turn that reasons | O7 |

Two smaller bugs feed O1 and O2:

- **Catalog regex order** (`src/lib/model-metrics.ts:815` comes before `:844`). `/3\.[56]-flash/` also matches `gemini-3.5-flash-lite`, so the Flash-Lite rule never runs. That rule says "defaults to MINIMAL for speed". Measured with the scratch script: `reasoningCaps(gemini-3.5-flash-lite).defaultLevel === "medium"`. No test covers this.
- **`clampReasoningEffort` handles an unsupported tier by returning the model's default** (`model-metrics.ts:1028-1039`). So asking Gemini 3.8 Flash for "minimal" sends **MEDIUM**. I confirmed this with the scratch script. A fix that sends "minimal" everywhere would quietly do nothing on half the lineup. It has to use the model's own floor, the way `geminiContinuationConfig` already does (`gemini-core.ts:309-345`).

---

## 2. Findings

### O1. Utility calls: send an explicit "floor" effort (the Batch layer's rule) instead of nothing

**Today**
- `runUtilityPrompt` calls `streamChat` with no `reasoningEffort` (`memory.ts:469-476`). What happens next depends on the adapter:
  - **Anthropic, OpenAI, DeepSeek, xAI, MiMo, Qwen:** thinking is turned off. ✓
  - **Google:** `geminiThinkingConfig` clamps `null` to the catalog default (`gemini-core.ts:251-266`). Because of the regex bug that is MEDIUM on 3.5 Flash-Lite, the first Google utility candidate. Google's own default is minimal.
  - **Zhipu:** GLM-5.3 always thinks. `openai-compat.ts:428-439` sends no `reasoning_effort` when the effort is undefined and cannot be disabled, so Z.ai runs at its default, **max** (repo citation at `model-metrics.ts:883-888`).
  - **MiniMax:** M2.7-highspeed reasons on every call with no control (`model-metrics.ts:950-958`).
- On top of that, `llm.ts:145-161` gives always-on non-Anthropic models a "high" thinking allowance (+16,384), so a 160-token follow-up request goes out with `max_tokens` 16,884.
- Timeouts make it worse. `ATTEMPT_TIMEOUT_MS = 20s` (`memory.ts:259`) and a timed-out attempt is marked transient and **retried once after 2.5s at the same effort** (`memory.ts:498`, `:585-597`). A max-effort GLM call that thinks past 20s is paid for twice and returns nothing.
- The billing code underneath also undercounts these calls. An aborted attempt has no usage event, so the ledger bills it by character count (`memory.ts:509-518`), and that count sees only the prompt. Thinking tokens the provider already generated never reach the ledger.

**Opportunity**

For every utility call:
1. If the model can turn thinking off, send the off switch (the adapters already do this when the effort is `undefined`).
2. Otherwise send the model's floor tier: the first tier of its own ladder.
3. Fix the Flash-Lite regex order.
4. Drop `includeThoughts` on utility calls; the walk throws reasoning events away.
5. Within a provider, rank controllable models ahead of uncontrollable ones. For MiniMax that would mean allowing M3.1-Flash (effort low, $0.60 output) or M3 (can be switched off) for background work, instead of M2.7-highspeed ($2.40 output, always reasoning). Note that both of those are marked PRO.

**Saving, per call** (2,000 tokens in, 150 visible out)

- Gemini 3.5 Flash-Lite:
  - today, MEDIUM: 2,000 × 0.30 + (150 + 600) × 2.50 = 600 + 1,875 = **2,475 µ$**
  - at MINIMAL: 600 + 200 × 2.50 = **1,100 µ$**
  - saving: **−56% per call**
- GLM-5.3 FlashX:
  - today, max: 740 + 2,650 × 1.25 = **4,052 µ$**
  - at low: 740 + 300 × 1.25 = **1,115 µ$**
  - saving: **−72% per call**, before counting the timeout retries avoided

**Saving, per account**
- P3 (Google-anchored): 2 utility calls × 1,375 µ$ = 2,750 µ$ per turn, out of about 17,800 µ$ per turn. Utility plus triage together (with O2): **about 21% of that user's chat-path spend**.
- Anthropic- and OpenAI-anchored accounts: no change. They already run Instant.
- Blended across all accounts, assuming 15–20% of turns are anchored to Google, Zhipu or MiniMax: **about 3–5% of chat-path spend**.

**Quality risk: low.**
- Six of the ten utility providers already run these exact prompts with thinking off.
- Google itself defaults Flash-Lite to minimal.
- The prompts are format-bound: three lines, a JSON verdict, a title.
- The one prompt that benefits from some thought is memory extraction. Low or minimal is still thinking on the always-on models.

**Implementation sketch**
- `src/lib/model-metrics.ts`:
  - move the `3.5-flash-lite` and `3.1-flash-lite` checks above `/3\.[56]-flash/`
  - add `auxiliaryEffort(model)`:
    - non-reasoning model → `undefined`
    - model that can turn thinking off → `undefined`
    - otherwise → the first entry of `REASONING_TIERS` that the model's tiers include
  - this is the same rule as `plannerReasoningEffort` (`research/tools.ts:360`) and `batch/providers.ts:56-58`, so move it into one shared helper
- `src/lib/memory.ts:469`: pass `reasoningEffort: auxiliaryEffort(model)`, and `role: \`utility:${opts.label}\`` (see O10).
- `src/lib/llm.ts:146`: no change needed. A floor tier passed in shrinks the allowance from 16,384 to 2,048 or 4,096 by itself.
- `src/lib/gemini-core.ts`: add an `includeThoughts` flag; set it false when `role` starts with `utility`.
- `src/lib/memory.ts:498`: after a timeout, retry at the floor effort, or don't retry at all for walks the caller can redo later (memory, titles).
- Tests:
  - pin `reasoningCaps(gemini-3.5-flash-lite).defaultLevel === "minimal"`
  - pin `auxiliaryEffort` for every FREE chat model
  - snapshot the utility wire bodies

**How to measure**
- `llm.request` records with `role` starting `utility:`, grouped by provider. Compare before and after:
  - `tokens.reasoning / tokens.output`
  - `costUsd` per 1,000 turns
  - share with `ok=false`
  - latency
- Quality:
  - `scripts/memory-bench.ts` and `scripts/recall-bench.ts` on Google- and Zhipu-anchored accounts at the old and new effort
  - `scripts/test-moderation.ts`
  - the parse-failure rate from `[label] … unusable output` logs

### O2. Preflight triage: run at its floor effort, and log it as triage rather than chat

**Today**
- Triage calls `streamChat` without an effort (`preflight-triage.ts:249-257`).
- The first candidate, Gemini 3.8 Flash, therefore gets `thinkingLevel: MEDIUM` and `maxOutputTokens` 600 + 16,384 = 16,984. With four questions (research mode) it is 1,200 + 16,384.
- The fallback, GLM-5.3 FlashX, runs at max.
- The server budget is short: `FIRST_ATTEMPT_TIMEOUT_MS = 2,000` and `TOTAL_DEADLINE_MS = 2,800` (`:35-36`). The client also gives up at 3.5s (`src/hooks/use-chat.ts:1830`).
- Thinking at medium makes timeouts more likely. A timed-out triage is still paid for (`:268-283`; the provider bills the tokens it generated, and the ledger again sees only the prompt by character count). Its result is thrown away.
- Triage passes neither `promptCache` nor `role`, so its `llm.request` records are logged as **`role: "chat"`** (`llm.ts:212`). Today its cost cannot be told apart from chat.

**Opportunity**
- `reasoningEffort: auxiliaryEffort(model)`: LOW on Gemini 3.8 Flash, which has no minimal; low on GLM-5.3.
- `role: "triage"`.

**Saving, per call** (1,800 tokens in: a 730-token system prompt, about 600 for the message, about 500 for recent turns; 80 visible out)

- today, MEDIUM: 1,800 × 0.75 + (80 + 600) × 3.75 = 1,350 + 2,550 = **3,900 µ$**
- at LOW: 1,350 + 230 × 3.75 = **2,212 µ$**
- saving: **−43% per call**
- per turn (about 60% of turns triaged): about **1,000 µ$**

**Saving, as a share of a user's spend**
- P1 (Sonnet): 1,000 of about 19,900 µ$ per turn, **−5%**.
- P2 (GPT-6 Luna): 1,000 of about 3,700 µ$ per turn, **−27%**. Triage costs more than the whole chat turn for FREE users.
- If medium thinking is really only 300 tokens, the saving falls to about 340 µ$ per turn (P1 −1.7%, P2 −9%).
- Timeouts avoided add to this.
- Cross-lane note: routing triage to the conversation's own utility model (Luna or Haiku with thinking off, about 275 µ$) is far cheaper still. That decision belongs to the routing dimension.

**Quality risk: low.**
- The system prompt asks for a narrow yes/no-plus-one-question JSON and says "DEFAULT TO NOT ASKING".
- Fewer timeouts means more clarifications actually reach the user inside the 2s window.

**Implementation:** `src/lib/preflight-triage.ts:249`. Add the effort and `role: "triage"`. Optionally set `promptCache: "none"`: the system prompt is the same for everyone, but at 730 tokens it is under every lab's minimum size for caching.

**How to measure:**
- `llm.request` with `role="triage"`: reasoning tokens, `latencyMs`, share with `ok=false`
- the count of `[clarify-triage] … timed out` log lines
- the share of `needsClarification:true` results, before and after
- a small labelled set of messages to check precision of the ask decision

### O3. Research worker (Haiku 5.5) thinks at the API default because no thinking setting is sent

**Today**
- `anthropicWorkerRequest` (`worker-loop.ts:365-383`) sends no `thinking` and no `output_config.effort`.
- On Claude Haiku 5.5, "No `thinking` field" means **adaptive thinking**, default effort **medium**. This is in Anthropic's per-model table, fetched today.
- `max_tokens: 2,048` has to hold thinking plus a tool call. A step that thinks long ends at `max_tokens` and wastes that call.
- Calls per run: a standard run is 4 workers × 2 rounds × up to 41 calls (`domain.ts:1330-1340`).
- These requests use the SDK directly, so **they are not in `llm.request`**. Today nobody can see their reasoning tokens.

**Saving** (assume 200 calls per standard run; per call: about 10k cached + 2k written tokens in, 120 visible out, about 250 thinking at medium; follow-ups that only process tool results often skip thinking)

- per call today: 10,000 × 0.01 + 2,000 × 0.125 + (120 + 250) × 0.5 = 100 + 250 + 185 = **535 µ$**
- per call at `effort:"low"` (about 80 thinking): **450 µ$**, a saving of **−16% of worker spend**
- per run: 200 × 85 µ$ ≈ **$0.017**, about **1% of a standard Opus-5.5-led run** (about $2; see O4)
- one more saving: thinking blocks are kept in the transcript on Haiku 5.5, so they are also re-read as cached input on every later call

**Quality risk: medium.** The worker's step choices are part of research quality. Use `effort:"low"`, not `thinking:{type:"disabled"}`. Anthropic warns that Haiku 5.5 with thinking off "can skip a tool call it needs" when JSON output is also requested.

**Implementation:**
- `worker-loop.ts:365`: add `output_config: { effort: "low" }`, set once per worker. A constant setting keeps the worker's cache: Anthropic invalidates the cache only when the effort changes.
- Wrap the call in `createRequestMeter` so `role: "research:worker"` records exist.

**How to measure:**
- an A/B on `scripts/seed-research-e2e.ts` goals: findings per worker, cited-claim support rate, `stop_reason=max_tokens` count
- reasoning tokens per call from `usage.output_tokens_details.thinking_tokens`

### O4. Research side stages on the user's lead model: set an effort for each stage instead of the model default

**Today**
- These stages pass no effort:
  - clarify (700 tokens, `tools.ts:553-569`)
  - brief (600, `:632-645`)
  - gap expansion (512, `:928-940`)
  - **citation judge** (200 tokens per call; 24, 48, 96 or 160 calls by tier)
- So an always-on lead model thinks at its API default:
  - Opus 5.5: medium, with max_tokens raised to 17.4k
  - Fable 5.1: high, 33k
  - GLM-5.3 and Kimi K3: max
- The planner on the same model already uses `plannerReasoningEffort` (low).
- The pre-spend estimate prices these calls at their visible cap (`modelCallEstimateMicroUsd`, `domain.ts:2274-2287`), while the wire allows tens of thousands of thinking tokens more. The run's spending ceiling cannot see this spend.

**Saving** (standard run, Opus 5.5 lead; my illustrative build of a run comes to about $2.0)

- Judge calls:
  - 48 calls × (1,500 × 4 + (80 + 600) × 20) = 48 × 19,600 µ$ = **$0.94**, about 45% of the run
  - thinking is 69% of that
- Clarify, brief and expand: 3 × (2,000 × 4 + 1,000 × 20) ≈ **$0.084**
- Clarify, brief and expand moved to floor/low: saves 3 × 450 × 20 ≈ **$0.027** (−1.3% of the run). Quality risk **low**: the planner already runs at low, and these are rewrites and question lists.
- Judge moved to low: saves 48 × 450 × 20 ≈ **$0.43 (−21% of the run)**.
  - The same move on a Fable lead (high to low): about **$2.5 per run**.
  - If medium thinking per judge call is only 200 tokens, the Opus saving falls to about $0.05 (−2.5%).
  - Quality risk **medium**. The judge decides what counts as supported, and adaptive low still thinks when Claude judges it needed. Gate it on a live eval (below).
- The lead review and the writer stay at the model default. They are the research itself.

**Implementation:**
- `research/tools.ts`: pass `reasoningEffort: plannerReasoningEffort(model)` from `clarifyResearchGoal`, `planResearchQueries` (the brief) and `expandResearchQueries`.
- `research/run.ts:970`: `researchModelCompletion({ …, reasoningEffort: JUDGE_EFFORT })`, behind an environment flag defaulting to the current behaviour until the eval passes.
- `domain.ts`: price auxiliary calls at the visible cap plus the floor tier's headroom, so `affordable()` holds.

**How to measure:**
- `scripts/eval-research-citations.ts` uses **stub** judges today; its own header says "A live-model judge is NOT run here". Add a live-judge mode and compare supported-precision against the human labels in `src/lib/eval/research-citation-cases.ts` at the default effort and at low. Ship low only if precision stays at or above the 95% bar.
- `llm.request`: pass `role: "research:judge"`, `"research:clarify"` and so on through `utilityCompletion`.

### O5. Code runner side calls (auto-reviewer, Work judge, compaction summary) inherit an always-on parent's default effort

**Today**
- These three calls pass no effort.
- `anthropicThinkingBits` (`runner/agent-core/src/providers/thinking.ts:139-153`) gives Opus 5.5 medium with +16k headroom, and Fable high with +32k.
- So a 300-token allow/deny review, or a 100-token YES/NO judge, thinks like a coding turn.
- The reviewer runs on every approval in `auto` mode (`agent.ts:907-912`). It sends `cache:false` and has no cache key.

**Saving, per review** on Opus 5.5 (1,500 in, 60 visible out)
- medium: 6,000 + 660 × 20 = **19,200 µ$**
- low: 6,000 + 210 × 20 = **10,200 µ$**
- saving: **−47% per review call**
- at 30 reviews per session: about $0.27 per session, roughly **1–3% of a Code session's spend**

**Quality risk**
- **medium** for the reviewer. It is a fail-closed safety gate; a lower effort could mean more false denies or allows.
- **low** for the Work judge, which answers YES/NO on "is this an attempt at the thing" and is told anything arguable is YES.
- **low** for compaction.

**Implementation:**
- Add `reasoningEffort` to the three `provider.stream` calls, using an `auxiliaryEffort` copy in `runner/agent-core/src/providers/thinking.ts`. That file is a deliberate copy of the website's module and must be kept in sync.
- Start with the judge and compaction; put the reviewer behind a flag.

**How to measure:**
- replay a sample of logged approval requests (tool name and input only) through the reviewer at both efforts; compare decision agreement and deny rate
- record runner usage per role

### O6. OpenAI-compatible tool rounds drop the round's reasoning, so later rounds re-think, and some labs may reject the request (400)

**Today**
- `openai-compat.ts:674-682` builds the assistant tool-call message from text and `tool_calls` only.
- The repo's own capability table says what each lab needs sent back (`src/lib/model-tools.ts:86-150`):
  - **must**: DeepSeek ("a tool round without every earlier turn's reasoning_content is a 400"), Moonshot, MiMo
  - **should**: Zhipu, MiniMax (`reasoning_details`), Qwen, Mistral small and medium
- The send-back logic exists in the **unwired** `src/lib/llm/compat-loop.ts:340-375` (`compatToolCallMessage`), but the production adapter does not call it.
- Effect on the "should" labs: each tool round starts its reasoning from nothing. That costs reasoning tokens, and the labs' docs tie it to worse tool use.
- Effect on the "must" labs: it may break thinking-mode tool turns outright. Check this.

**Saving.** Illustrative, not measured: a 3-round tool turn at about 1,000 thinking tokens per round, where rounds 2 and 3 drop to about 400 with reasoning preserved.
- Saves 1,200 of 3,000 thinking tokens (**−40% of reasoning tokens on those turns**).
- Sending reasoning back adds about 1,000–2,000 tokens of input on later rounds. Input costs a quarter to an eighth of output and is mostly cached, so the net saving is about 30%.
- As a share of all spend: small, about 0.5–2%, depending on how much tool traffic runs on these labs. The main payoff is quality and reliability.

**Quality risk: none to low.** This sends back what each lab asks for. It is how `openai-responses.ts:475-482` already treats OpenAI (`reasoning.encrypted_content`).

**Implementation:**
- Port `compatToolCallMessage` and `compatHistoryAssistantMessage` into `openai-compat.ts` round assembly, keyed by `toolCapabilitiesFor(model).replay`.
- Add per-lab wire tests: probes P4, P5 and P7 are already named in `model-tools.ts`.

**How to measure:**
- `llm.request` records with `round ≥ 1` on zhipu, minimax, qwen and deepseek: mean `tokens.reasoning` per round, before and after
- the tool-turn error rate on DeepSeek and Kimi

### O7. OpenAI `reasoning.summary: "detailed"` on every reasoning turn: check whether it is billed

**Today.** `openai-responses.ts:397-415, 490-495` asks for `summary:"detailed"` whenever the effort is not "none". The code's own note says summary tokens "bill as output tokens … ≈ 2.5k output tokens" on a hard prompt.

**Opportunity, if that is true.** Use `"auto"` (or "concise" where it is accepted) for turns that are not displayed with reasoning: voice, background Work, API v1. Or use "auto" everywhere and accept a coarser reasoning panel.

**Saving, if billed.** Up to about 2.5k output tokens per hard turn: about $0.025 on GPT-6.1 Sol at $10/MTok. Possibly **5–15% of OpenAI reasoning-turn output**.

**Uncertain.** developers.openai.com could not be reached from this session to confirm whether summaries are billed. On Anthropic, summary generation is documented as **free** ("Summary generation: No charge"), so `display:"summarized"` there needs no change.

**Quality risk:** none for the answer. Only the visible reasoning trail gets less detailed.

**How to measure:** an A/B over 50 fixed prompts, `detailed` against `auto` against no summary. Compare `usage.output_tokens − output_tokens_details.reasoning_tokens − visible text tokens`. If the remainder disappears without summaries, they are billed.

### O8. Gemini and utility caps: bound the thinking headroom to the task

**Today**
- `clampMaxTokens` raises every request to at least 1,024 (`provider-limits.ts:114`).
- `streamChat` adds +16,384 for always-on non-Anthropic models (`llm.ts:145-161`).
- `buildAnthropicThinkingBits` adds 16k to 32k headroom for Opus 5.5 and Fable even when 200 tokens were asked for (`anthropic-thinking.ts:136-143, 192-205`).

**Effect.** A cap bills nothing by itself. These caps matter in two ways:
- They are the only stop on a runaway (see O9).
- They break the research pre-spend bound (O4).

**Opportunity.** With O1, O2, O4 and O5 in place, the floor tier's headroom applies automatically (2,048–8,192 instead of 16k–32k). No further change is needed beyond making the estimates use the same numbers.

**Saving:** it bounds the tail; it is not a recurring saving. **Risk:** low.

### O9. No guard against runaway output on the chat path

**Today**
- Paid plans set `maxOutputTokens: 200,000` (`plans.ts:118-250`). This is clamped to each lab's ceiling: 64k for Anthropic plus thinking headroom up to 128k, 128k for OpenAI, 131k for Zhipu, MiniMax and MiMo.
- The stream budget guard (`chat-budget-guard.ts`) stops only at the account's remaining budget.
- Nothing detects degenerate repetition. That happens occasionally on open-weight reasoning models (GLM, Qwen, MiniMax).

**Saving**
- One runaway to a 128k cap costs $6.40 on Fable or $0.30 on GLM-5.3.
- Overall it is probably **under 0.5% of spend**, but the per-incident cost is large, and it hurts users near their budget.

**Opportunity.** In `pumpTurnStream` (`src/lib/chat/turn/run-stream.ts:44`), add a cheap n-gram repetition detector over the last ~4k characters of visible text. On a confident loop (the same 200+ characters repeated 8+ times), abort the upstream stream and end the turn as `length` with Continue offered.

**Quality risk: low.** Make it conservative and log every trigger. Never apply it to code blocks without a much higher threshold, because generated tables and code repeat legitimately.

**How to measure:** trigger count per 10k turns, and output tokens per turn at p99.9 before and after.

### O10. Measurement gap: request records do not say which job they were for

**Today**
- The `llm.request` role is inferred from `promptCache` (`llm.ts:212`): utility is "utility", research lead and writer are "auxiliary", and **triage is "chat"**.
- Nobody passes `role` (`grep 'role: "'` finds no caller).
- Research workers bypass `streamChat`, so they produce no record at all (`worker.ts:437, 544`).
- So no one can see what titles, memory or moderation cost, or how much of it is reasoning.

**Opportunity.** Pass `role` from every caller (`utility:<label>`, `triage`, `research:<stage>`, `code:reviewer`) and meter the research worker. No saving by itself, but it is the instrument that turns O1–O5 from estimates into measurements.

**Implementation:** `memory.ts:469`, `preflight-triage.ts:249`, `research/tools.ts:290`, `research/agents/lead.ts:247`, `research/agents/worker.ts` (wrap in `createRequestMeter`), and runner usage per role.

**Query:** total `costUsd` and `tokens.reasoning / tokens.output` grouped by `role` and `provider`, over 7 days, before and after each change.

### O11. Realtime voice: no per-response output cap and no truncation after the user interrupts

**Today**
- The OpenAI GA session update (`relay/src/providers/registry.ts:27-39`) sets no `max_output_tokens`.
- `interrupt()` sends `response.cancel` only (`relay/src/providers/openai-realtime.ts:234-241`). It never sends `conversation.item.truncate`, so assistant audio the user never heard stays in context and is re-read as input on every later turn.

**Opportunity**
- Cap response output at the p99.9 of measured voice replies.
- Truncate at the audio position the user actually heard.

**Saving.** Output audio is the most expensive token class in the product, so the cap bounds runaway monologues. Truncation is mostly an input-side saving that grows with call length. Size it from relay usage (`input_token_details.audio_tokens`). Est. 2–10% of realtime spend on calls with barge-ins.

**Quality risk:**
- none for truncate: the model then holds what the user actually heard
- low for a p99.9 cap

**Not verified this session:** the current Realtime GA field names. developers.openai.com was unreachable, so check `max_output_tokens` and the truncate event shape before shipping.

### O12. Verbosity: leave chat alone, apply only to auxiliary calls (negligible)

- Nothing in the repo sends OpenAI's `text.verbosity`. Its values are low, medium and high, default medium, GPT-5 family and later.
- Setting it on chat would change answer length, which violates the brief, so no change there.
- On utility calls the outputs are already shaped by the prompt (three lines, a JSON verdict). `verbosity:"low"` would save well under 1% of utility output.
- Optional, very low priority. Risk: none.

---

## 3. Checked and found fine (no change)

- **Retries do not replay paid answers.** SDK clients run with `maxRetries: 0`. The single chat retry fires only when the provider rejected the request before sending any event (`chat/turn/pre-stream-retry.ts:11-45`). Gemini's network retries also stop once a stream has begun (`gemini-network.ts:110`).
- **Continuation is narrow.** Gemini auto-continues only when thinking took at least half the cap and the answer had already started, at most twice, at the model's thinking floor, and never after a Stop (`gemini-finish.ts:223-246`, `gemini-core.ts:309-345`, `gemini.ts:442-481`). A long answer that is merely long gets a Continue button, not a second automatic request.
- **Aborted streams.**
  - A chat generation is deliberately not tied to the browser request (`run-turn.ts:876`). Its answer is saved and replayed, so its tokens are not wasted.
  - Stop aborts the generation's own controller, which closes the provider stream upstream.
  - Design edit is tied to `req.signal`.
  - Follow-up pills are shared through a cache, so one reader leaving does not waste the fill.
- **Reconnects do not duplicate requests.**
  - Web resend rules: only `idempotent` (dedup keys, `REQUEST_ALREADY_SUBMITTED`), `verify`, or `drain-only` (`chat/send-retry.ts:1-33`, `chat/turn/accept.ts:219-252`). Resuming reads the frame log (`reconnectFromLog`).
  - Native: "never re-POSTed automatically, so reconnect cannot duplicate or double-bill" (`NativeChatAPIClient.swift:1083`).
- **Anthropic `display:"summarized"`.** Billing is the same as omitted, and summary generation is free (Anthropic docs). Kept.
- **Tool rounds on OpenAI Responses** send back `reasoning.encrypted_content` (`openai-responses.ts:475-482`), so reasoning is not paid for twice. On compat labs it is (O6).
- **Batch dreaming** already uses the right effort rule (`batch/providers.ts:53-58`).

---

## 4. Order to do it in

1. **O10** (role labels and the worker meter). Do it first so every later change is measured.
2. **O1 + O2** (the floor-effort helper, the Flash-Lite regex fix, triage). Low risk, largest share of chat-path spend for Google-, Zhipu- and MiniMax-anchored accounts and for FREE users.
3. **O4, the clarify, brief and expand part** (low risk).
4. **O6** (send back reasoning on compat labs). A quality and reliability fix that also saves reasoning tokens.
5. **O3, O4 judge, O5 reviewer.** Behind flags, gated on the evals named in each.
6. **O7, O9, O11, O12.** Verify first, or treat as tail guards.

**Rough blended effect on chat-path spend** (auxiliary work only, model mix of 50% Anthropic, 30% OpenAI and 20% other):
- O1 + O2: about **4–11%**, central estimate about 8%
  - per turn: (0.5 × 1,013) + (0.3 × 1,013) + (0.2 × 3,763) ≈ 1,563 µ$ saved
  - out of about 14,600 µ$ blended per turn
  - the low end assumes medium thinking is 300 tokens, not 600
- Research: O3 + O4 is about 2–23% of research-run spend. Almost all of it is the judge, which is the medium-risk part.
- Code: O5 is about 1–3% of a Code session.

---

## 5. Sources

**Fetched today**
- Anthropic, Thinking (per-model "No `thinking` field" table: Haiku 5.5 is "Adaptive thinking"; `disabled` is accepted at effort high or below): https://platform.claude.com/docs/en/build-with-claude/thinking
- Anthropic, Steering thinking (effort defaults: "`medium` (default on Claude Opus 5.5 and Claude Haiku 5.5)", "`high` (default on most models)"; thinking billed as output; summary generation free; changing effort invalidates cache breakpoints; `max_tokens` caps thinking and answer together): https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost
- Anthropic, Pricing (Haiku 5.5 $0.10/$0.50; Opus 5.5 $4/$20; Sonnet 5.5 $2/$10; Fable 5.1 $10/$50; Batch API −50%): https://platform.claude.com/docs/en/about-claude/pricing

**OpenAI verbosity** (search results, not fetched)
- [Controlling the length of OpenAI model responses](https://help.openai.com/en/articles/5072518) (values low, medium, high; default medium; GPT-5 family)
- [GPT-5 new params and tools cookbook](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_new_params_and_tools)
- [community confirmation of the default](https://community.openai.com/t/whats-the-default-verbosity-and-reasoning-for-gpt-5-model/1357054)

**Could not be fetched from this session**
- ai.google.dev and developers.openai.com did not resolve; they need to be added to the session's allowed network domains.
- For Gemini thinking levels and defaults (3.5 Flash-Lite minimal; 3.8 Flash low, medium or high, default medium), GLM-5.3's default `max`, Kimi K3's default `max`, the OpenAI `"none"` effort, and the Realtime fields, these findings rely on the repo's own cited docs and read dates (`src/lib/model-metrics.ts:730-990`, `src/lib/model-reasoning-capabilities.ts:30-44`). Re-verify those before shipping O1, O2, O7 and O11.
