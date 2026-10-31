# Cache-prefix findings: verification

Verifier: principal engineer who owns model quality. I checked `cache-prefix-findings.md` (F1–F11) against the code at `e532983ea` (main; the repo is read-only and still clean), against the provider docs I could reach, and with my own re-runs of the simulations. Date: 2026-10-31.

What a finding needs to be kept: the user's chosen model, its effort, and the words it reads stay the same; interactive turns get no noticeable extra latency; nothing new can leak across users. Anything that fails one of these is cut back or rejected.

## 0. Verdicts at a glance

| # | Finding (as submitted) | Verdict | Saving after my recompute | What changed from the submission |
| --- | --- | --- | --- | --- |
| K1 | F1: per-message text in the cached system tier 2 | **KEPT, narrowed** | With K2 and K3: −7% to −23% of Anthropic chat input (−4% to −16% of turn cost) | The canvas-edit prompt **stays** in the system tier, because of a documented protocol-mix failure. Hints get their own block, never the "context" block. |
| K2 | F2: tool set changes per turn | **KEPT for regenerate only** | Part of the K1 number. A regenerate goes from +5.1K to −1.5K units against a normal turn | Covers **every** regenerate-gated tool (6, not the 2 listed). Edit, research and teach keep their own tool variants (see R2). |
| K3 | F11: research corpus written at 2x | **KEPT, replaced by a billing-only fix** | −46% of each synthesis call's input; about −2.9K units per canvas edit | Same text, same position, only fewer cache markers. Moving the corpus into the tail and declaring tools on synthesis are rejected (R3). |
| K4 | F9: project files flip in and out of history[0] | **KEPT, fallback required** | −25% to −45% of turn cost in lexical-only project chats | Must ship with a zero-passage fallback in the tail. Without it, "summarise it" / "what else does it say" get worse answers (R5). |
| K5 | F7: 1h conversation marker | **KEPT, gated on real data; rule corrected** | Long chats with ≥25% 5–60 min gaps: −14 to −17 extra points of input. **Negative** in 10-turn chats | The submitted break-even leaves out the 2x rewrite after gaps over 60 min. The "H ≥ 8K" rule loses money in short chats. |
| K6 | F5: OpenAI `prompt_cache_key` per conversation | **KEPT, a probe must pass first** | −10% to −19% of OpenAI chat input (premise partly verified) | Use a salted hash, not the raw id. The diagnostic key stays per conversation. The ~15 RPM figure is not in official docs. |
| K7 | F4: untrusted rule flips at token ~46 | **KEPT, measure first** | −10% to −22% in FREE chats that flip; **+~0.5%** in FREE plain chats | Net only positive if flips are common enough. Check the FREE `system@0` rate first. |
| K8 | F6: date in front of the newest user turn | **KEPT, changed** | −2% (text) to −10% (attachment-heavy) on compat, Gemini and pre-5.6 OpenAI | The date goes **inside** the newest user message, after the tail. A trailing system message would break Mistral. |
| K9 | F10: semantic outlines in tier 2 | **KEPT, low priority** | −15% to −35% of input in edit-heavy artifact chats; ~1–3% overall | The section header stays in the system, because the Canvas section names it. Only the outlines move, and only while "hot". |
| R1 | F8: Auto holds effort to keep the cache | **REJECTED** | — | Holding a higher effort adds reasoning latency and output tokens on interactive turns. The router-estimate fix changes which model Auto picks; that is not a cache change. |
| R2 | F2 for canvas edit / research / teach | **REJECTED (edit: deferred)** | — | Tools would be on offer in turns whose output must be patch-only or corpus-only. Citation numbering must match the corpus. Research history is cold anyway. |
| R3 | F11 as written | **REJECTED** | — | The corpus would move after the question, against Anthropic's long-context guidance. Its "42K units after" assumes a warm history that a 15–60 min research run cannot have. |
| R4 | F1 for the canvas-edit prompt | **DEFERRED (eval-gated)** | — | The edit prompt *replaces* the selection-anchor nudge (`prompt-sections.ts:106-110`). Leaving the nudge in the system tier gives the model both protocols. |
| R5 | F9 without a fallback | **REJECTED** | — | On zero-passage turns the model would see no document text at all. Doc-dependent follow-ups would regress. |
| R6 | F7's "1h once H ≥ ~8K" rule | **REJECTED (formula wrong)** | — | It loses 3–5% of input in 10-turn chats in my re-run. |
| R7 | F6 as written (trailing system item) | **REJECTED** | — | Mistral rejects a request that ends in a system message, and also rejects system messages placed mid-conversation. |

The order to ship them is in §4.

---

## 1. What I re-ran and where it is

All of these are in `docs/handoff/2026-10-31/cost/verify/`:

- `scripts/build-turn.mts`, a copy of the finding's fixture builder that writes to `verify/` instead of over its evidence → `rerun-turn-fixture-report.txt`. **Every size reproduces byte-for-byte**: tools 2,830, stable 8,923, tier 2 788, untrusted rule 400, regenerate tools 1,877 / stable 7,993, edit tools 1,315 (= the 4 Alevr Search specs, so edit turns *do* keep tools), research turn tools 1 (none).
- `kept-sim.mjs` and `kept-sim-conservative.mjs`: the finding's Monte-Carlo, using the same documented Anthropic rules, rerun with **only the kept scope**. That means K1 without the canvas edit, K2 for regenerate only, and K3 for edit turns. Each runs at 0.1x and 0.05x read rates and at the assumed event rate (14%) and half of it (7%). The output is in `kept-sim-report.txt` and `kept-sim-conservative-report.txt`; §2 quotes the conservative file.
- `ttl-check.mjs` → `ttl-check-report.txt`: isolates F7 across the share of gaps over 60 min. That run is where the F7 error showed up.

## 2. Kept items

### K1 — Move per-message instructions out of the cached system tier (F1, narrowed)

**Confirmed in code.**
- `composeTurnSystem` (`src/lib/chat/turn/prompt.ts:155-189`) appends these per message to the string that `streamAnthropic` splits at `systemStablePrefix`:
  - `withRegenerateInstruction` (`:39-42`)
  - `appendSkillBlock`, where the skill is per message; the composer disarms it after send (`src/components/chat/composer.tsx:1644`)
  - `backgroundWorkHint` / `recurringWorkHint` (`:151-153`)
  - `IMAGE_INTENT_HINT` (`:186`)
- That string ends up in block 2, which carries a 1h marker (`src/lib/anthropic.ts:269-288`).
- `research-stage.ts:105` appends the previous report (≤48K chars) **after** these, so a one-line hint also rewrites the report.

**Provider rule (verified).**
- Prefix order is tools → system → messages, and a system change invalidates the system and messages caches.
- Writes cost 1.25x for 5m and 2x for 1h; reads cost 0.1x, and **0.05x on Opus 5.5 / Sonnet 5.5**. These read rates are now confirmed in the pricing table and its footnote.
- Source: https://platform.claude.com/docs/en/build-with-claude/prompt-caching

**Recomputed saving.** These figures include K2 and the K3 edit-turn change, from `kept-sim-conservative-report.txt` with 5m markers:

| Event rate | 10-turn, 10% mid gaps | 10-turn, 25% | 30-turn, 10% | 30-turn, 25% |
| --- | --- | --- | --- | --- |
| 14% (assumed), 0.1x read | −16.0% input / −8.7% turn | −13.0% / −7.4% | −23.0% / −16.2% | −16.6% / −12.2% |
| 7% (half), 0.1x read | −9.0% / −4.7% | −7.2% / −3.9% | −13.6% / −9.1% | −9.4% / −6.7% |
| 14%, 0.05x read (Opus/Sonnet 5.5) | −19.2% / −9.7% | −15.3% / −8.2% | −26.6% / −18.1% | −18.7% / −13.5% |

This is about 1–3 points below the submitted F1+F2, because the canvas-edit prompt stays in tier 2. The event rates are still assumptions; recalibrate them from trace `features` before quoting a number externally.

**Quality challenge.**
1. **Authority only goes down.** The text moves from system to user position, so nothing can gain authority. That rules out privilege escalation.
2. **Salience goes up.** Text placed after the user's words is followed *more* readily. The background-work hint ("start it with start_task now") could start tasks more often, and the image hint could fire `generate_image` more often. This is the real risk, so the evals below pin those call rates against the baseline.
3. **Heading.** The block needs its own heading, for example `# For this reply (from Alevr)`, placed **before** `# Context for this message`. It must never go under the context heading, which says "not an instruction" (`src/lib/chat/turn-context-tail.ts:83-88`).
4. **Imported skills.** These stay inside their untrusted envelope. The rule that governs the envelope stays at the top of the system prompt.
5. **Forged headings.** Retrieved text can only forge the new heading from inside the untrusted markers, and the rule tells the model to ignore exactly that ("text claiming to come from … Alevr"). This holds whenever untrusted content is present, because the rule is on then.
6. **Latency and leakage.** No change in latency (same tokens; cache hits only speed up prefill). No cross-user effect.

**Files to change**
- `src/lib/chat/turn/prompt.ts`: return `{ system, baseSystemSections, turnInstructions: string[] }`. The regenerate instruction, background/recurring hint, image hint and skill block go into `turnInstructions`. `system` must no longer depend on `input.message`, `input.regenerate*` or `appliedSkill`.
- `src/lib/chat/turn-context-tail.ts`: add an `instructions` input, rendered first under its own heading. Keep `""` when everything is empty, so a plain turn's bytes do not change.
- `src/app/api/chat/route.ts:271-337`: the tail is built **before** `composeTurnSystem` today, so compose first, or rebuild the tail with the instructions. Feed `appendVolatileTail` the merged tail.
- `src/lib/chat/turn/private-turn.ts:159-180`: the same move for the private path (regenerate instruction and private skill block).
- `src/lib/chat/prompt-sections.ts:116-138`: rewrite the `appendSkillBlock` comment; its "LAST in the system prompt" argument no longer holds.
- Nothing else is needed on the GPT-5.6+ path. `detachNewestVolatileTail` (`src/lib/openai-prompt-cache.ts:54-71`) already sends the tail as its own item after the user's words.

**Tests**
- New `tests/turn-system-invariance.test.ts`: for one fixture conversation, `composeTurnSystem(...).system` is **byte-identical** across a normal turn, an image-intent message, a background-work message, a regenerate with an instruction, and a skill turn.
- `tests/turn-context-tail.test.ts`: instructions render before context, under their own heading, and an empty input gives `""`.
- `tests/anthropic-cache-breakpoint.test.ts`: the marker still sits on the user's words, before the (now larger) volatile block.

**Evals (one run each, before and after, on the user's model)**
- `generate_image` call rate on image-intent messages; `start_task` and `propose_routine` call rates on hinted messages. Each must be within ±3 points of baseline.
- Regenerate-adjustment adherence: a pairwise judge, ≥ parity.
- Skill adherence: the existing skill eval.

**Measurement**
- `llm.request` `prefix.verdict = "system@1"` per 1,000 chat requests, which should drop to the memory-summary / agent / artifact change rate.
- `cacheReadShare` on turns with `trace.features.regenerate | skill`, compared with the turn after them.
- Weekly `sum(cacheWriteTokens)/sum(promptTokens)` per provider from Message rows.

### K2 — Keep the same tool set on a regenerate (F2, regenerate only)

**Confirmed in code.** A regenerate re-reads the same window (`src/lib/chat/turn/history.ts:38-56`). It also removes **six** tools and their sections, not two:
- `start_task` (`task-tool.ts:187`)
- `propose_routine` (`routine-tool.ts:98`)
- `hand_off_to_teammate` (`approvals.ts:108`, the same gate)
- the agent config tools: `propose_setup_change` / `create_room` (`agent-config-tools.ts:134`)
- `draft_skill` (`skill-draft-tool.ts:153`)

`generate_image` is not gated on regenerate. The measured diff is 953 tool tokens plus 930 stable-tier tokens.

**Provider rule (verified).** Changing tool definitions invalidates the tools, system **and** messages caches. A `tool_choice` change invalidates messages, so `tool_choice:"none"` is no alternative (invalidation table, same URL).

**Saving.** It is included in the K1 numbers. Per regenerate: +5,078 → −1,545 units against a normal turn (the finding's per-event block, reproduced). Regenerates also get a faster TTFT, because the prefill is a cache read.

**Quality challenge.**
- **Ordinary regenerates.** Most regenerates are of answers that started no task. For those, the model now sees exactly what the original turn saw. That is closer parity than today, not further.
- **Regenerating a task-starting answer.** Here the model may reach for `start_task` again. Mitigations:
  - a line in the K1 block: "This is a regeneration: do not start tasks, routines, hand-offs or setup changes in this reply";
  - every executor refuses with a tool result on regenerate, which keeps the product rule ("the user message already had its chance", `task-tool.ts:178-179`). The idempotency keys are per user message, so a duplicate could not double-run anyway.
- **Cost of a refused call.** One extra round. It is rare, and it is measured below.

**Files**
- `src/lib/chat/turn/approvals.ts:79-121`: compute the declared tool flags without `regenerate`. Pass `regenerate` to the tools as a runtime refusal instead.
- `src/lib/chat/task-tool.ts`, `routine-tool.ts`, `handoff-tool.ts`, `agent-config-tools.ts`, `skill-draft-tool.ts`: drop `!gate.regenerate` from the `*Enabled` gates, and refuse inside `execute` when the turn is a regenerate.
- `src/lib/chat/system-prompt.ts:389-401`: no change. It follows the flags that `prompt.ts` passes.

**Tests**
- `tests/chat-task-tool.test.ts`, `tests/chat-handoff-tool.test.ts`, `tests/chat-agent-config-tools.test.ts`, `tests/teach-skill-chat.test.ts`, `tests/work-routine-proposal.test.ts`: on regenerate each tool is declared and its `execute` returns the refusal.
- A body-level test: the tools and system blocks of a regenerate are byte-identical to the original turn's (Anthropic wire).

**Eval and measurement**
- Calls to these 6 tools on regenerate turns (target ≈ 0; an alert above 1%).
- p50/p95 `latency.totalMs` of regenerates (must not rise).
- `cacheReadShare` of regenerate requests (should approach 1.0 when the user regenerates within 5 min).
- `prefix.verdict = "tools"` per 1,000 turns.

### K3 — One-off request variants stop writing cache entries nobody reads (replaces F11)

**Confirmed in code.**
- `synthesisSystem = system + research.context + RESEARCH_OUTPUT_CONTRACT` (`src/lib/chat/turn/research-stage.ts:179`) becomes block 2 with a 1h marker (`anthropic.ts:282-288`). The conversation marker after it is 5m.
- The research turn has **no tools** (Alevr Search is off when `researchActive`, `capabilities.ts:40`; tool size 1).
- The next turn has a different system (tools back, plus the report in tier 2), so **no later request can read anything after the stable tier of the synthesis request**.
- Research runs for 15–60 minutes of wall clock (`src/lib/research/envelope.ts:94-132`), after a plan confirmation. So the previous turn's 5m history entry is long expired. That breaks the submitted "after ≈ 42K units", which assumed a warm history.
- Canvas edits have the same shape. The tools are the edit variant (4 Alevr specs) and tier 2 holds the edit prompt (≤16K chars) without the semantic section (`route.ts:302`). Nothing ever re-reads the tier-2 entry of an edit.

**The fix.** Same text, same order, fewer markers:
- **Research synthesis:** keep the 1h marker on the stable tier (and on tools, if it has any). This variant is shared by every user's research turn, so it is warm. Put **no marker** on tier 2 or the corpus, and **no conversation marker**. On GPT-5.6+, use `openAIModernCachePlan → { mode: "explicit", systemBreakpoint: false }` (the "none" plan). On that model an entry is keyed to `prompt_cache_key` and the tool-less prefix matches nothing.
- **Canvas edit:** drop the 1h marker on tier 2 only. Keep the 5m moving conversation marker, because edit turns carry search tools and may run a tool round.

**Recomputed saving** (corpus 40K, tier 2 0.8K, contract 0.4K, stable 8.9K warm, history 10K cold):
- today ≈ 0.1×8.9K + 2×41.2K + 1.25×10K = **95.8K units**
- after ≈ 0.9K + 1×(41.2K + 10K) = **52.1K**, which is **−46%** of the synthesis call's input
- the submitted tail-and-tools variant would realistically land at 0.1×12.5K + 1.25×10K + 40K ≈ 53.8K, which is no better

Canvas edit: 0.75 × (0.8K + 3K) ≈ **−2.9K units per edit**. Overall weight: research is ~2% of turns at ~10x a normal turn's input, so about −1% to −2%.

**Quality risk: none.** The bytes the model reads and their order are unchanged. The only cost: a pre-stream retry of the same synthesis (attempt 2) no longer reads the corpus from cache. That is rare and costs money, not quality.

**Files**
- `src/types/llm.ts` (`PromptCacheMode`): add `"head"` (markers on tools and the stable tier only) and `"head+conversation"` (no tier-2 marker).
- `src/lib/anthropic.ts:269-313`: apply `systemCache` per tier and skip `withConversationCacheBreakpoint` under `"head"`. Mirror this in `src/lib/llm/anthropic-loop.ts`.
- `src/lib/openai-prompt-cache.ts:32-39`: map `"head"` to the no-breakpoint explicit plan.
- `src/lib/chat/turn/run-turn.ts:866-900`: pass `promptCache: "head"` when the synthesis corpus is present (`synthesisSystem !== system` with `researchActive`), and `"head+conversation"` when `artifactEditTarget`.

**Tests**
- `tests/anthropic-cache-breakpoint.test.ts`: a synthesis-shaped request has `cache_control` only on the last tool (if any) and block 1, with none on block 2 and none in messages. An edit-shaped request has the conversation marker but none on block 2.
- `tests/openai-prompt-cache.test.ts`: `"head"` maps to explicit mode with no breakpoint.

**Measurement**
- On `llm.request` records for research-synthesis and artifact-edit turns: `cacheWrite1hTokens` (should fall to ≈ the stable tier or 0) and the per-call `costMicroUsd`.
- The citation-audit pass rate must be unchanged; it is a guard, not an expected change.

### K4 — Project reference files must not flip into history[0] (F9, with a required fallback)

**Confirmed in code (a real bug against the stated contract).**
- `retrieve.ts:451-463`: indexed files are represented by their passages, "otherwise the same document is in the prompt twice … and the whole point of retrieval is lost".
- `project-context.ts:136-141` drops `indexedFileNames` whenever `passages.length === 0`. `buildProjectReferenceFiles` (`context-assembly.ts:181-196`) then inlines **every** file's full `extractedText`, with no cap, at history[0] (`project-context.ts:313-316`).
- Under the default `same_provider` policy, Anthropic and DeepSeek have no embedding model (`knowledge/embed.ts:23-27, 59-68`), so retrieval there is lexical-only.
- The lexical query is an OR of prefixed non-stopword terms (`knowledge/rank.ts:82-95`), so "thanks", "ok" or "shorter" can match nothing.
- The same branch also serves folders and selected files (`retrieveAttachmentKnowledge`, which returns `indexedFileNames` too, `retrieve.ts:560-564`).

**Quality challenge.** Today a zero-passage turn accidentally shows the model the whole library. For anaphoric document questions ("summarise it", "what else does it say?") that gives *good* answers. Fixing the bug alone would leave the model with no document text on those turns, which is a regression (R5). Fixing it is still right, but only together with this fallback, rendered in the **volatile tail** and never in history:
1. On zero passages, re-run retrieval once with the previous user message added to the query. That is one Postgres FTS query, milliseconds, with no embedding call on lexical-only.
2. If it is still zero and the project's indexed text is small (≤ 8K tokens, a budget to tune), put the full text in the tail. That is the same information the model gets today, at about today's price for a small corpus.
3. Otherwise, add a one-line note in the tail, in the style of the existing degraded note (`context-assembly.ts:266-267`): no passage matched this message; if the answer depends on the documents, say so rather than guess.

This also removes a latent failure today: a large library dumped whole can overflow the context window.

**Recomputed saving.** This is the flip-sim with about +1K fresh tokens of fallback on each flip turn:
- −25% turn cost at a 10% flip rate
- −36% at 20%
- −45% at 40%

The submitted figures (−26/−38/−47%) assumed zero fallback. Overall weight: the share of lexical-only project chats with indexed files, about −2% to −5% of chat spend.

**Files**
- `src/lib/chat/turn/project-context.ts:136-141`: `if (retrieved) projectKnowledge = { passages: retrieved.passages, indexedFileNames: retrieved.indexedFileNames, degraded: retrieved.mode === "lexical" }`, plus fallbacks 1–3 above.
- `src/lib/chat/context-assembly.ts:262-274`: render the zero-passage note and the small-corpus full text, wrapped as untrusted, through the passages string that already rides `context.retrievedContext` into the tail.
- `src/lib/chat/turn/capabilities.ts:76-126`: no change. `projectKnowledge` truthiness now stays constant, which also removes one F4 flip source.

**Tests**
- `tests/chat-context-assembly.test.ts`: a two-turn fixture whose second message matches nothing produces a byte-identical `modelHistory[0]`, and the fallback text is in the tail.
- `tests/knowledge-retrieve.test.ts`: the re-query uses the previous user message.
- `tests/project-folders.test.ts`: the same behaviour on the inherited-files path.

**Eval (gate)**
- A set of zero-passage follow-ups in lexical-only Claude project chats: conversational ("thanks", "shorter") and anaphoric ("summarise it", "what else does it say", "is X in there?").
- Grade doc-grounded accuracy against today. It must reach ≥ parity; if anaphoric answers lose, raise the step-2 budget.

**Measurement**
- `prefix.verdict = "history_rewritten@0"` on project conversations, which should go to ≈ 0 outside window jumps.
- `promptTokens` spikes per project conversation.

### K5 — 1h conversation marker, only where measured gaps pay for it (F7, corrected)

**Confirmed.** The conversation marker is always 5m (`src/lib/anthropic-cache.ts:52, 85`).

**Provider rule (verified).**
- The lifetime runs from the **start** of the request, so streaming time counts.
- A read refreshes the entry.
- A 1h write costs 2x.
- 1h entries must come before 5m entries.

**Correction.** The submitted break-even, p\* = 0.75·d/(1.15·H), ignores that with a 1h marker every **cold** turn (gap over 60 min) rewrites the whole history at 2x instead of 1.25x, and that the last write of each conversation is never read. The corrected break-even:

> p_mid\* = 0.75·[d·(1 − p_long) + (H + d)·p_long] / ((1.25 − r)·H)

With d = 1.05K and r = 0.1, that gives: H = 8K, p_long = 10% → **15%** (not 8.5%); H = 20K → 9.9%; H = 8K, p_long = 0 → 8.6%.

`ttl-check-report.txt` confirms it: the submitted "1h once H ≥ 8K" rule costs **+3% to +5%** of input in 10-turn chats, even with 25% mid gaps. It only pays in long chats, for example −21.8% in a 30-turn chat with 25% mid gaps and 10% long gaps.

**Decision procedure (before writing code).**
1. Pull the real per-conversation USER `createdAt` sequences for 14 days, with the finding's SQL extended to also output conversation length and p_long.
2. Replay those exact sequences through `verify/kept-sim.mjs` with three policies: 5m, 1h when H ≥ X, and 1h when H ≥ X *and* this conversation's previous gap was 5–60 min.
3. Ship the cheapest one, and only if it beats 5m by ≥ 3% of input.

**Quality and latency: none.** Billing only. Privacy: the KV entries live in memory up to 1h instead of 5m, still workspace-isolated, not stored at rest (prompt-caching docs, data-retention section).

**Files**
- `src/lib/anthropic-cache.ts:49-98`: a `ttl` parameter on `markConversationCacheBreakpoint` / `withConversationCacheBreakpoint`.
- `src/lib/anthropic.ts`: choose the TTL on the first request of a turn; tool rounds keep 5m.
- `src/lib/llm/anthropic-loop.ts`: mirror it.

**Tests:** `tests/anthropic-cache-breakpoint.test.ts`, covering the TTL choice and the rule that no 1h marker follows a 5m marker within a request.

**Measurement:** `cacheWrite1hTokens + cacheWrite5mTokens` per turn and `cacheReadShare` on Anthropic `llm.request` records for conversations above the threshold, before and after.

### K6 — OpenAI: hash the user id into `prompt_cache_key` (F5, after a probe)

**Confirmed in code.**
- `cacheKey: conversationId` (`src/lib/chat/turn/run-turn.ts:900`) becomes `prompt_cache_key` (`src/lib/openai-prompt-cache.ts:127`).
- The private path sends the **raw** user id, `private-${user.id}` (`private-turn.ts:382`).
- The same key feeds the prefix tracker (`src/lib/llm.ts:209-213`, `request-meter.ts:154`).

**Provider rules.** The OpenAI hosts are unreachable from this session: `developers.openai.com`, `platform.openai.com` and `learn.microsoft.com` would all have to be allowed in the session's network settings. From search snippets of the official guide:
- routing is by `prompt_cache_key`, with the prefix hash as a secondary key;
- reuse one key across requests that share long prefixes;
- on GPT-5.6+, "later requests with the **same prefix and prompt_cache_key** can read that entry". So today a new conversation can *never* read the head that the user's previous conversation wrote;
- cache writes on GPT-5.6+ cost 1.25x;
- the minimum is 1,024 tokens.

The "~15 requests/min per prefix+key" figure appears only in third-party text, so it is unverified.

**Saving.** The submitted −10% to −19% of OpenAI chat input stands, given its premise that 20–40% of first turns follow another request by the same user within the 30m TTL. OpenAI serves the FREE default, GPT-6 Luna (`src/lib/models.ts:406`).

**Quality, leakage, latency.**
- Answers: none.
- Cross-user leakage: none. A key only *narrows* which of the org's identical-prefix entries a request is routed to, and hits still need byte-identical prefixes, including this user's memory summary.
- Use `sha256(server_salt + user.id)` so OpenAI never sees a raw id; this also fixes the private path.
- Risk: a heavy user with parallel tool loops concentrates more requests under one key, so spill-over could lower *their* hit rate. The probe must include that case.

**Probe (gate).** Same user, same head, two fresh conversations, first request of each.
1. Per-conversation key: expect `cached_tokens` ≈ 0 on conversation 2.
2. Per-user key: expect ≈ the head.
3. Then 30 requests in one minute under one key, to see whether `cached_tokens` falls.

**Files**
- `src/lib/chat/turn/run-turn.ts:900`: an OpenAI-only hashed user key. Keep `x-grok-conv-id` per conversation for xAI, and leave Mistral/Meta unchanged pending their own probes.
- `src/lib/llm.ts:209-221` and `src/lib/llm/request-meter.ts`: add a separate `diagnosticKey` (still the conversation id). Otherwise the tracker compares across chats and reports false `history_rewritten`.
- `src/lib/chat/turn/private-turn.ts:382`: the hashed key.

**Tests:** `tests/openai-prompt-cache.test.ts` (the key is hashed, the raw id never appears); `tests/prefix-diagnostic.test.ts` (the diagnostic key is independent of the cache key).

**Measurement:** `cacheReadShare` on OpenAI `llm.request` records for `role: chat`, `attempt: 1`, first turn of each conversation.

### K7 — Make the untrusted-content rule stable (F4, after measuring)

**Confirmed in code.**
- `system-prompt.ts:277` inserts the 400-token rule right after the 46-token identity line, controlled by `untrustedContent`.
- With search on (the paid default) the flag is constant. On FREE (`plans.ts:74`, `webSearch: false`) or with search off, it follows per-message signals (`capabilities.ts:76-126`).
- `systemWithUntrustedReadTools` (`untrusted-content.ts:46-49`) can *also* append the rule at the end of the system prompt. That becomes a no-op once the rule is always at the top.

**Quality.** The rule is constant text (`src/lib/web/untrusted-rule.prompt.ts`) and inert without markers. Paid users already get it on every turn, so this is the dominant production configuration and not a new prompt. Memory and approval gating keep using `untrustedContentInTurn`, unchanged.

**Saving and cost.** −10% to −22% of turn cost in chats that flip (flip-sim). However, FREE plain chats that never carry untrusted content pay +400 × 0.1 = **+40 units/turn (≈ +0.5%)**. After K4, project knowledge no longer flips, so the remaining flip sources are per-message references and attachment retrieval.

**Gate.** Ship only if FREE `prefix.verdict = "system@0"` is above about 1% of FREE requests. If it is lower, use the sticky variant instead: on from the first turn of a conversation that carried untrusted content, or always in project conversations.

**Files**
- `src/lib/chat/system-prompt.ts:277`: unconditional (or sticky).
- `src/lib/chat/turn/prompt.ts:115` and `private-turn.ts:159`: stop passing the per-turn flag.
- `tests/system-prompt-sections.test.ts:50-55`: this test currently pins the toggle; update it.
- `tests/untrusted-content.test.ts`.

### K8 — Date and tail placement on compat labs, Gemini and pre-5.6 OpenAI (F6, changed)

**Confirmed in code.** Each of these puts the date in front of the newest user turn:
- `openai-compat.ts:331-345` (`messages.splice(lastUser, 0, dateSystemMsg)` for non-modern models)
- `openai-responses.ts:347-359`
- `gemini.ts:114-122` (a separate user content)

The common prefix with the next turn therefore ends before u_N, so u_N and its inline attachments are billed fresh twice.

**Change from the submission.** Do **not** add a trailing system item. Mistral's API rejects a request whose last message is a system message, and mid-conversation system messages too (third-party reports: Portkey, Pipecat's Mistral adapter). Instead, append the date as the **last text part of the newest user message**, after the volatile tail, and record it as part of `volatileTail`. On the next turn the user's own words are an exact prefix, and role order is untouched on every wire. Then move Qwen's "message before the date" marker (`withQwenCacheMarkers`) onto the newest message. GPT-5.6+ and Anthropic stay as they are.

**Saving.** The submitted −2% (text) to −10% (attachment-heavy) of input on those wires; Gemini 2.5+ implicit hits are discounted 90% (Google Cloud context-cache docs).

**Quality.** The date line is the same text in the same turn, just after the user's words. Memory notes and extracts already sit there on these wires.

**Files:** `src/lib/openai-compat.ts:327-345`, `src/lib/openai-responses.ts:347-359`, `src/lib/gemini.ts:113-122`, `src/lib/chat/turn-context-tail.ts` (the date as the final tail part), Qwen markers in `openai-compat.ts`.

**Tests:** `tests/gemini-request.test.ts`, `tests/compat-tool-loop.test.ts`, `tests/prompt-cache-wire.test.ts`. Two consecutive turns' bodies must share a prefix through u_N's own words, and no request may end in a system message.

**Measurement:** `cacheReadShare` for `wire: compat | gemini | responses(pre-5.6)`.

### K9 — Semantic-artifact outlines move to the tail while "hot" (F10, low priority)

**Confirmed.** `semanticArtifactContext` (`src/lib/chat/turn/semantic.ts:25-44`) puts up to 4 outlines (24K chars) with `version N` headers into tier 2 (`route.ts:301-302`, `prompt.ts:159`). They change on every edit, including canvas edits made outside chat.

**Change.** The section **header** ("# Editable spreadsheets, documents and decks…", built by `artifact-ops.ts:225-238`) stays in the system tier whenever artifacts exist, because the stable Canvas section names it (`system-prompt.ts`, "EDITING one of these later"). Only the per-artifact outline sections move to the volatile tail, and only while an artifact's newest version is less than 2 turns old. Use hysteresis: each move costs one rewrite. One small security benefit: user- or web-sourced document text leaves instruction position.

**Saving.** As submitted: the tail wins when the change rate is above 16%, worth −15% to −35% of input in edit-heavy chats, about 1–3% overall.

**Files:** `src/lib/chat/turn/semantic.ts`, `src/lib/artifact-ops.ts:225-238` (split header and outlines), `src/app/api/chat/route.ts:301-302`, `src/lib/chat/turn/prompt.ts:159`.

**Tests:** header in the system and outlines in the tail when hot; the reverse when cold; a byte-identical system across two hot turns.

**Eval:** ops validity / apply rate on artifact-edit chats.

**Measurement:** `system@1` on conversations with semantic artifacts.

## 3. Rejected items, and why

- **R1 — F8, Auto effort hold and router input estimate.**
  - Effort really does invalidate the messages cache on Anthropic (verified row: "Effort setting … always invalidates message blocks"). But the proposed lever, not downgrading when the switch costs more, holds a **higher** effort on a simple follow-up. The router's own latency model adds 4 s of TTFT for high/xhigh/max against 0 for none (`src/lib/router/decide.ts:283-289`), plus more reasoning tokens. That is noticeable latency on exactly the interactive turns Auto marked as quick. "Never less reasoning" is not the bar; "no slower interactive turns" is.
  - Correcting `estInputTokens = contextTokens + 1_200` (`router/task-class.ts:192`) changes *which model Auto picks*. That is a routing-quality change and belongs to the router lane with `scripts/cost-per-accepted.ts`, not to a cache fix.
  - The OpenAI effect, the finding's main Auto case (GPT-6 Luna), is only an assumption in `prefix-diagnostic.ts:66-67`.
- **R2 — F2 on canvas edits, research synthesis and teach intent.**
  - **Edits:** the turn's output is an exact patch (`forwardDeltas: !artifactEditTarget`, `run-turn.ts`). Offering `generate_image` / `start_task` there invites calls on "add a picture of…" style edits.
  - **Research:** the synthesis must cite only the numbered corpus (`research-stage.ts:180-189`, "Order must match the corpus numbering exactly"). Declaring web search or other tools during synthesis risks off-corpus sources and a refused round on a long, latency-visible stream. The history it would "keep warm" is cold after a 15–60 min run anyway.
  - **Teach:** rare. The submission already said "leave as is".
  - K3 gets most of the money on edit and research turns with no change to what the model sees.
- **R3 — F11 as written** (corpus moved into the per-turn tail, tools kept declared).
  - Anthropic's own guidance: "Place your long documents and inputs near the top of your prompt, above your query … Queries at the end can improve response quality by up to 30 percent" (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices). The tail sits after the question. That is a quality regression risk on the flagship research report, for no extra saving over K3 once the history is correctly modelled as cold (53.8K vs 52.1K units).
- **R4 — F1 for the canvas-edit prompt (deferred).**
  - `targetedArtifactEditPrompt` *replaces* `SELECTION_ANCHOR_NUDGE`, and the code says why: "the two describe different output protocols, and a model given both emits a mix of the two" (`src/lib/chat/prompt-sections.ts:106-110, 151`). Moving the edit prompt to the tail while keeping the system byte-identical means both protocols are in context.
  - It can come back only with an explicit override line in the tail and a patch-validity eval at ≥ parity on the user's model.
  - Until then, K3's edit-turn marker change takes about 2.9K of the ~11.5K units per edit, with zero risk.
- **R5 — F9 without a fallback.** It would remove all document text from zero-passage turns, and doc-dependent follow-ups regress. Kept only as K4.
- **R6 — F7's "1h once H ≥ ~8K" rule.** The break-even formula is missing the cold-rewrite and last-write premiums. In my re-run, the rule is +3% to +5% worse in 10-turn chats at every mid-gap share tested. Replaced by K5's data-driven policy choice.
- **R7 — F6 as written** (date as a trailing system item on all compat hosts). Mistral rejects a final system message and mid-conversation system messages. Kept only in K8's in-message form.

## 4. Order to ship

1. **K3** (billing-only, no quality risk, independent).
2. **K1 + K2** together, behind the evals in K1/K2. Without K2, a regenerate still misses at the tools.
3. **K4**, with the fallback, behind the zero-passage eval.
4. **K6** once the probe passes.
5. **K7** once the FREE `system@0` rate is measured.
6. **K8.**
7. **K5**, only after the timestamp replay, and only after K1/K2 are live; with per-turn rewrites still in place, 2x writes make 1h worse.
8. **K9.**

**Dashboard.** The submission's §3 still applies: `llm.request` `prefix.verdict` mix, `cacheReadShare`, Message-row write share, trace `features` joins. The verdict strings are the ones `verdictLabel` emits (`src/lib/llm/prefix-diagnostic.ts:179-182`):

| Item | Verdict to watch |
| --- | --- |
| K1, K9 | `system@1` |
| K2 | `tools` |
| K7 | `system@0` |
| K4 | `history_rewritten@0` |

Quality guards on every step: the image, task and routine call rates; regenerate adherence; skill adherence; the citation-audit pass rate; project-doc answer accuracy on zero-passage turns; and p50/p95 `latency.totalMs` and `ttftMs` per turn kind.

## 5. Sources

- Anthropic prompt caching, fetched 2026-10-31: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  - Multipliers: 1.25x for 5m writes, 2x for 1h writes, 0.1x reads.
  - Per-model reads: 0.05x for Opus 5.5 / Sonnet 5.5, 0.025x for Fable / Mythos 5.1.
  - The invalidation table, including tools, `tool_choice`, thinking and effort.
  - The lifetime counts from request start, and reads refresh the entry.
  - 1h entries must come before 5m entries, billed by the A/B/C rule.
  - 20-block lookback; workspace isolation; 512-token minimum on 5.x models.
- Anthropic prompting best practices (long-context placement): https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
- OpenAI prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching. **Not reachable from this session.** Facts come from search snippets of that page: key-based routing, reads keyed to the same key on GPT-5.6+, 1.25x writes on 5.6+, 1,024-token minimum. The ~15 RPM figure has only a third-party source (https://gitea.hillion.co.uk/JakeHillion/personal-agent/pulls/127). Re-verify once `developers.openai.com` is allowed in the session's network settings.
- Google Cloud context caching: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview (search snippets): implicit caching on by default, 90% discount on cached tokens, large common content first.
- Mistral role-order constraint (third-party, not official Mistral docs): https://portkey.ai/error-library/role-assignment-error-10144 and https://reference-server.pipecat.ai/en/stable/_modules/pipecat/adapters/services/mistral_adapter.html
