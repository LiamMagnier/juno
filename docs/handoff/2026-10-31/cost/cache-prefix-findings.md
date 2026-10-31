# Prompt-cache hit rate on the main chat turn

Dimension: how much of each main chat turn's input is read from the provider prompt cache, and what still breaks the cached prefix between turns, users and conversations. Repo state: `e532983ea` (main), read-only. Date: 2026-10-31.

The rule behind every finding: savings come only from cache layout, routing keys and TTLs. The model the user picked, its effort, and the text it sees all stay the same. Where a finding moves text (from the system prompt to the per-turn tail), the bytes the model reads do not change; only their position does.

## Scripts and raw outputs (all in this folder)

| File | What it does |
| --- | --- |
| `scripts/build-turn.mts` | Builds the **real** system prompt (`buildSystemPromptSections` + `composeSystemPrompt`) and the real tool definitions (Alevr Search specs, `start_task`, `propose_routine`, `generate_image`, `draft_skill`) using fixtures. It imports pure repo modules only. It reports token sizes per section and the first byte where each per-turn variant diverges from a normal turn. Output: `turn-fixture-report.txt`, `turn-fixture-system-normal.txt`, `turn-fixture-tools-normal.json`. |
| `scripts/cache-sim.mjs` | Monte-Carlo of Anthropic caching (4,000 conversations per cell) using the documented rules: prefix order, writes only at breakpoints, the A/B/C mixed-TTL billing, TTL counted from request start, reads refresh the entry. It is fed the measured segment sizes. Outputs: `cache-sim-report.txt`, plus `cache-sim-report-read005.txt` for the 0.05x read rate of Opus 5.5 / Sonnet 5.5. |
| `scripts/flip-sim.mjs` | Same rules, isolating flips that change the prefix at its head: the project reference files at history position 0, and the untrusted-content rule at the top of the stable tier. Output: `flip-sim-report.txt`. |
| `scripts/auto-switch.mts` | Runs the real Auto router (`pickAutoModel`, every provider configured with dummy keys, as in `tests/auto-model-cheapest.test.ts`) over 5 realistic multi-turn conversations, FREE and PRO. It counts model and effort changes between consecutive turns. Output: `auto-switch-report.txt`. |

Run them from `/home/user/juno` with `TSX_TSCONFIG_PATH=/home/user/juno/tsconfig.json node --conditions=react-server --import tsx <script>` (the `.mjs` files run with plain `node`).

Token figures use a blended 3.6 characters per token. No tokenizer is installed, and real counts may differ by about ±15%. The **shares** below do not depend on this ratio. "Units" means base-input-token equivalents: read 0.1x, 5m write 1.25x, 1h write 2x, fresh 1x, output 5x (a Sonnet-class $3 / $15 model).

---

## 1. What a typical turn looks like today

### Measured sizes (web client, web search on (the default, `app-provider.tsx:77`), memory on, 1.4K-character memory summary)

| Segment | Tokens | Cache marker (Anthropic) | Varies with |
| --- | --- | --- | --- |
| Tools: 4 Alevr Search specs + `start_task` + `propose_routine` + `generate_image` | **2,830** | last tool, 1h (`anthropic.ts:301-313`) | toggles, turn kind |
| System stable tier (`system-prompt.ts:265-481`) | **8,923** | 1h (`anthropic.ts:285-288`) | feature flags; some flags change per turn (§F2, §F4) |
| System tier 2 (memory summary 359 + search nudge 238 + run-code note 189) plus **everything `composeTurnSystem` appends** | **788** + per-turn text | 1h | per message (§F1) |
| Date block (`anthropic.ts:289`) | 37 | none, but it sits before `messages`, so it is part of the conversation prefix | daily |
| History (block-anchored window, `context-assembly.ts`) | grows by ~1.05K per turn | — | — |
| Newest user message (own words) | ~150 | 5m (`anthropic-cache.ts:48-70`) | — |
| Volatile tail (ranked memory notes, retrieved extracts, references) | 0–600+ | after the marker (uncached by design) | per message |

The cacheable head is about **12.5K tokens** before any history. Stable-tier breakdown: Canvas 3,394; Live UI (base + the "views people act on" section) 2,603; Tasks 677; Memory rules 587; Untrusted rule 400; Reply intent 348; Images 286; Routines 253; Pre-answer clarification 167; Runnable code 157; identity 46.

### Where each per-turn variant first diverges from a normal turn (`turn-fixture-report.txt`)

| Turn kind | Tools same? | Stable same? | Tier 2 same? | First divergence | Consequence on Anthropic |
| --- | --- | --- | --- | --- | --- |
| Image-intent message | yes | yes | **no** | tier 2 | tier 2 rewritten at 2x, whole history at 1.25x |
| Regenerate ("more concise") | **no** | **no** | **no** | tools, char 4,744 | everything after the tools segment |
| Teach intent (`draft_skill`) | **no** | **no** | yes | tools, char 8,177 | everything |
| Deep-research turn | **no** | **no** | yes | tools, char 1 | everything |
| Canvas targeted edit | **no** | **no** | yes (+ edit prompt) | tools, char 4,734 | everything |
| Web search off (FREE plan, or toggled off) | **no** | **no** | **no** | tools, char 10 | everything (a separate variant) |
| Skill applied (no tool narrowing) | yes | yes | **no** | tier 2 | tier 2 + history |
| Native macOS/iOS | **no** | **no** | yes | tools | separate variant (fine: per client) |

### Baseline cached-token share (simulation, `cache-sim-report.txt`)

Assumptions: per-turn events are regenerate 4%, image intent 2%, background/recurring hint 2%, skill 3% and canvas edit 3% (14% of turns in total). 30% of turns carry a 600-token tail. 900 output tokens per turn. Reply gaps: 65% under 5 min, 25% between 5 and 60 min, 10% over 60 min. Shared heads (tools + stable) are assumed warm across users, which is the conservative case for "before".

| Conversation | Cached share of input today | Input units / turn | Of which 5m writes |
| --- | --- | --- | --- |
| 10 turns | **80.6%** | 5,868 | 2,802 |
| 30 turns | **69.6%** | 12,594 | 7,840 |
| 10 turns, previous research report in tier 2 (+13K) | **74.6%** | 15,436 | 2,802 |

Note: at a 0.1x read rate, **cache writes cost more than cache reads** on every row. Each turn writes its delta (previous reply + new message ≈ 1.05K tokens) at 1.25x, which is about 1.3K units against roughly 1.4K units of reads. Every avoidable miss adds another 1.25x write of the entire history. So the levers are: avoid misses (F1, F2, F4, F9), and make writes outlive the reply gap (F7).

### Already fixed — not repeated here

These items are fixed and verified in code: `docs/pricing/COST_ENGINEERING.md` §1 #1–#25. That covers memory notes and retrieval moved to the tail, the moving tool-loop marker, the volatile-tail marker placement, the GPT-5.6+ layout, utility prompts set to `promptCache: "none"`, Qwen markers, research-worker markers, and the sorted Mac Code keys. The prefix diagnostic (`llm/prefix-diagnostic.ts`) and the `llm.request` meter already exist. The findings below are what remains.

---

## 2. Findings

Summary, ranked by expected saving on total chat-turn spend:

| ID | Finding | Est. saving | Quality risk |
| --- | --- | --- | --- |
| F1 | Per-message text (image/background/recurring hints, regenerate instruction, skill block, canvas-edit prompt) is appended to the cached system tier 2. Each occurrence rewrites tier 2 and the whole history, and the next turn rewrites the history again | −10% to −16% of chat-turn input; −29% to −34% in chats carrying a research report (combined with F2: −16% to −29% input, −9% to −24% turn cost) | low |
| F2 | The tool set and stable sections change per turn (regenerate, canvas edit, research, teach intent). Tools head the prefix, so these turns miss everything; a regenerate could have been a 100% hit | with F1, see above; a regenerate turn goes from +5.1K to −1.5K units against a normal turn | low |
| F7 | Conversation marker TTL is fixed at 5m; the 1h break-even is history-dependent | −3% to −22% of chat-turn input (on top of F1+F2) when the marker uses 1h once history ≥ ~8K tokens | none |
| F9 | Project reference files are inlined at history position 0 only on turns whose retrieval found no passage. This always happens for Claude project chats under the default `same_provider` policy, because retrieval is lexical-only there | −26% to −47% of turn cost in affected chats; ~−2% to −5% overall | low–medium |
| F5 | OpenAI `prompt_cache_key` is the conversation id, so every new conversation's first turn re-writes the ~12.5K-token head, which is identical for that user | −10% to −19% of OpenAI chat input (to verify; docs unreachable from this session) | none |
| F4 | `UNTRUSTED_CONTENT_RULE` toggles at position 2 of the stable tier on turns without web search (FREE plan, search off). Retrieval and references make it flip per message | −10% to −22% of turn cost in affected chats; ~−1% to −3% overall | low |
| F10 | Semantic-artifact outlines (up to 24K characters) sit in tier 2 and change on every edit | −15% to −35% of input in artifact-editing chats; ~−1% to −3% overall | low |
| F11 | The deep-research corpus is appended to tier 2 with a 1h marker: written at 2x, read zero times. The turn also drops every tool | −40% to −55% of that call's input; ~−1% to −2% overall | low |
| F6 | Gemini, OpenAI-compatible labs and pre-5.6 OpenAI splice the date in front of the newest user turn and keep the tail inside it, so the previous user message and its attachments are re-billed every turn | −2% (text chats) to −10% (attachment-heavy) of input on those providers | low |
| F8 | Auto changes effort per message (14% of consecutive turn pairs) with no switch cost in the router, and the router under-counts input by ~11K tokens | −5% to −10% of Auto-turn input | none–low |

All percentages are estimates from stated assumptions, not production measurements. §3 lists how to measure each one.

---

### F1 — Per-message text lives in the cached system tier

**What happens today**

`composeTurnSystem` (`src/lib/chat/turn/prompt.ts:43-191`) builds one string. `streamAnthropic` (`anthropic.ts:269-288`) splits it at `systemStablePrefix` into block 1 (stable) and block 2 ("everything else"), and puts a 1h marker on each. "Everything else" includes text decided **per message**:

- `withRegenerateInstruction` (`prompt.ts:37-41`): the regenerate adjustment.
- `appendSkillBlock` (`prompt.ts:156-170`; `prompt-sections.ts:134-140`): the skill for this one message (`turnSkillSlug` from the message token).
- `targetedArtifactEditPrompt` (`prompt.ts:136-144`): the canvas edit contract plus artifact source/outline, up to 16K characters.
- `backgroundWorkHint` / `recurringWorkHint` (`prompt.ts:145-150`, `work-intent.ts:59-104`): set by `detectBackgroundWork(input.message)`.
- `IMAGE_INTENT_HINT` (`prompt.ts:183-186`): set by `detectImageIntent(input.message)`.
- In `research-stage.ts:105`, the previous research report (up to 48K characters) is appended **after** all of the above. A one-line hint therefore also forces a 2x rewrite of the report.

System blocks precede `messages`, so a change in block 2 invalidates block 2 and **the whole history** after it. The next normal turn changes block 2 back. The history entry from before the event usually has expired by then (5m TTL, and the event turn did not refresh it), so the history is rewritten a second time. **A one-turn hint costs two history rewrites.**

**Per-event cost** (simulation, 10-turn chats, short gaps; `cache-sim-report.txt`, last block). A normal turn's input is 3,184 units.

| Event | Extra input units today | After F1+F2 |
| --- | --- | --- |
| Image-intent hint (34 tokens) | **+8,791** (2.8x a normal turn) | +34 |
| Skill block (~1K tokens) | **+10,746** | +1,012 |
| Canvas edit (3K-token prompt) | **+14,518** | +3,036 |
| Regenerate | **+5,078** | **−1,545** (a full read) |

**Saving** (F1 alone, assumed event mix): −9.7% input (10 turns) and −11.4% (30 turns). With a research report in tier 2: −15% to −16%. Combined with F2: −16.3% / −21.1% input and −9.2% / −15.5% turn cost. In report-carrying chats: −27% to −29% input. With the 0.05x read rate of Opus 5.5 / Sonnet 5.5: −19% input (10 turns). Savings scale roughly linearly with the event rate. If real events are half my assumption (7% of turns), halve the figures.

Arithmetic check for one image-intent turn, on the analytic model rather than the simulation (10-turn chat, H ≈ 5K):
- tier 2 rewrite: 2 × 0.82K = 1.6K units
- history rewrite: 1.25 × 5K = 6.3K units
- next turn's second history rewrite: about 1.25 × 5K × P(entry expired) ≈ 3K units
- less the normal reads it replaces: about −1K units
- **net ≈ +9.9K**, which matches the simulation's +8.8K.

**Quality risk: low.** The model receives the same words; they move from the end of the system prompt to the newest user message, after the user's own words. Two cautions:
- The tail heading today says it is "not an instruction" (`turn-context-tail.ts:83-88`). These items **are** instructions, so they need their own block ("# For this reply (from Alevr)"), not the context block. Claude and GPT-5.x follow per-turn system-reminder text in the user turn reliably; Claude Code itself works this way.
- An imported skill stays inside its untrusted envelope. The rule that governs it stays at the top of the system prompt.

Run the existing eval for each behaviour: `generate_image` call rate on image intents, honoured regenerate adjustments, skill adherence, and patch validity on canvas edits.

**Implementation sketch**
- `src/lib/chat/turn/prompt.ts`: return `{ system, turnInstructions: string[] }`, where `turnInstructions` holds the regenerate instruction, hints, skill block and edit prompt. Make `system` independent of `input.message` and `input.regenerate*`.
- `src/lib/chat/turn-context-tail.ts`: add an `instructions` section with its own heading, rendered before the context section.
- `src/app/api/chat/route.ts:221-246` and `src/lib/chat/turn/private-turn.ts` (same composition) pass them in.
- `src/lib/chat/turn/research-stage.ts:105`: unchanged (it is stable); it simply stops being rewritten.
- Test: `system` is byte-identical for a normal turn, an image-intent turn, a regenerate, a skill turn and a canvas edit of the same conversation.

**How to measure**
- `llm.request` records: the share of `prefix.verdict = "system@1"` (tier-2 change). It should drop to roughly the memory-summary/agent/artifact change rate.
- `cacheReadShare` on turns with `trace.features.regenerate | skill | artifactEdit`, compared with the turn after them.
- Message rows: `sum(cacheReadTokens)/sum(promptTokens)` per conversation, before and after.

---

### F2 — Tools and stable sections change per turn (tools head the prefix)

**What happens today**

Anthropic invalidates **tools, system and messages** when tool definitions change. This is the first row of the invalidation table at platform.claude.com/docs/en/build-with-claude/prompt-caching. The following gates are decided per turn and remove tools **and** their stable-tier sections:

- **Regenerate:** `!gate.regenerate` in `chatTaskToolEnabled` (`task-tool.ts:187`) and `chatRoutineToolEnabled` (`routine-tool.ts:98`) removes `start_task` and `propose_routine`, plus `TASK_HANDOFF_SECTION` and `ROUTINE_SECTION` (`system-prompt.ts:389-394`). A regenerate re-sends exactly the prefix the original turn wrote (`turn/history.ts:44-56` re-reads the same window). It could read 100% from cache; instead it misses from the tools onward.
- **Canvas targeted edit / research:** `!gate.artifactEdit` and `!gate.researchActive` (`task-tool.ts:190-191`, `image-tool.ts:124-125`) remove task, routine and image tools plus their sections.
- **Teach intent:** `detectTeachIntent` reads the last few user messages (`route.ts:249`). It switches `draft_skill` and `TEACH_SECTION` on for a few turns and then off: two full misses per teaching episode.

**Saving:** F2 alone shows about 0% in the simulation, because those turns also change tier 2. Together with F1 it unlocks the combined numbers above. For a regenerate, it is the difference between +5.1K and −1.5K units. The subsequent normal turn also stops missing.

**Quality risk: low.** Declare tools per **conversation**, not per turn, and enforce the turn-level rule where the action happens:
- `start_task.execute` refuses on a regenerate when the original message already started a task. This is the stated reason for the gate (`task-tool.ts:178-179`).
- Canvas edits and research synthesis get a one-line "do not call tools in this reply" in the F1 instruction block. The executors refuse if called anyway.

The model sees one or two more tool descriptions on those turns (432–562 tokens each). That is a negligible distraction risk, and it is visible in evals (patch validity, research report format).

Do not use `tool_choice: "none"` for this. Per the same table, a `tool_choice` change invalidates the messages cache.

**Implementation sketch**
- `src/lib/chat/turn/approvals.ts:79-101`: compute `taskToolOn` / `routineToolOn` / `imageToolOn` without `regenerate`, `artifactEdit` and `researchActive`. Pass those flags to the tools as runtime refusals instead (`task-tool.ts`, `routine-tool.ts`, `image-tool.ts`).
- `system-prompt.ts:389-401`: the sections follow the conversation-level flags.
- Teach: either always declare `draft_skill` on the web (+724 tokens at 0.1x ≈ 72 units per turn) or leave it as is (rare).
- `research-stage.ts:178`: see F11.

**How to measure:** the `prefix.verdict = "tools"` count per 1,000 turns. Today it should cluster on regenerate, edit and research turns; join with trace `features`. Also the `cacheReadShare` of regenerate turns, which should approach 1.0.

---

### F7 — Conversation marker TTL: use 1h once history is large enough

**What happens today:** the marker on the newest user block is always 5m (`anthropic-cache.ts:52, 85`). COST_ENGINEERING #6 left this as "measure first". Two documented facts make 5m tighter than it looks: the TTL is counted **from the start of the request**, so streaming time counts; and a 1h write costs 2x against 1.25x for 5m (prompt-caching docs, "When does the cache lifetime start?"). A 90-second Opus answer leaves the reader 3.5 minutes to reply.

**Arithmetic.** Let d be the per-turn delta (≈ 1.05K tokens: previous reply + new message) and H the history.
- A 1h marker costs an extra 0.75·d on every turn.
- It saves (1.25 − 0.1)·H on every turn whose gap falls between 5 and 60 minutes.
- Break-even mid-gap share: **p\* = 0.75·d / (1.15·H)**. That is 13.7% at H = 5K, 6.8% at H = 10K and 3.4% at H = 20K.

Simulation (`cache-sim-report.txt`), F1+F2 with a 5m marker against F1+F2 with a 1h marker:

| Mid gaps (5–60 min) | 10-turn chat (H avg ~5K) | 30-turn chat (H avg ~15K) |
| --- | --- | --- |
| 10% | 1h **worse** (+12% input) | about even (+2%) |
| 25% | 1h better (−3%) | 1h better (**−22%** input) |
| 40% | 1h better (−14%) | 1h better (**−37%**) |

Applying 1h **today**, without F1/F2, is worse in most cells: the event-driven rewrites would then cost 2x. Sequence it after F1/F2.

**Rule:** use 1h on the conversation marker when history ≥ ~8K tokens (p\* ≤ ~8.5%), and 5m below that. Tool-loop rounds keep 5m: they are seconds apart, and the 1h entries must precede the 5m ones, which holds with one moving marker.

**Quality risk: none.** Billing only.

**Implementation sketch:** add a `ttl` parameter to `markConversationCacheBreakpoint` / `withConversationCacheBreakpoint` (`anthropic-cache.ts`). Choose it in `streamAnthropic` (`anthropic.ts`) from the estimated history tokens, 1h on the first request of a turn only. Mirror it in `llm/anthropic-loop.ts`.

**How to measure (decide before shipping).** Compute the real reply-gap distribution:
```sql
WITH u AS (
  SELECT "conversationId", "createdAt",
         LAG("createdAt") OVER (PARTITION BY "conversationId" ORDER BY "createdAt") AS prev
  FROM "Message" WHERE role = 'USER' AND "createdAt" > now() - interval '14 days')
SELECT avg((extract(epoch FROM "createdAt" - prev) <= 270)::int)  AS under_4m30,
       avg((extract(epoch FROM "createdAt" - prev) BETWEEN 270 AND 3540)::int) AS mid,
       avg((extract(epoch FROM "createdAt" - prev) > 3540)::int) AS over_59m
FROM u WHERE prev IS NOT NULL;
```
After shipping, compare `cacheWrite5m + cacheWrite1h` per turn on Anthropic `llm.request` records for conversations with H ≥ 8K, before and after.

---

### F9 — Project reference files flip in and out of history position 0 (bug)

**What happens today**
1. `project-context.ts:136-141` sets `projectKnowledge` **only when this question's retrieval returned passages**. With zero passages, it stays `null`, and the `indexedFileNames` that `retrieveProjectKnowledge` returned (`knowledge/retrieve.ts:507-512`) are dropped.
2. `buildProjectReferenceFiles(project, projectKnowledge)` (`context-assembly.ts:181-196`) excludes indexed files only when they are listed in `knowledge.indexedFileNames`. With `null` it inlines the **full extracted text of every project file**.
3. `prependToFirstUserTurn` (`project-context.ts:313-316`) puts that text into the **first user message of the window**, the first history item.

Every turn whose retrieval comes back empty therefore changes history item 0. That rewrites the entire history on every provider and pays the full document text, at 1.25x on Anthropic. The next turn with a match flips it back, which is a second rewrite.

When does retrieval come back empty? Whenever the vector leg is missing and the lexical OR-query matches nothing ("thanks!", "shorter please", "ok"). The vector leg is missing for every conversation on a provider with no embedding model under the **default** `same_provider` policy (`background-provider-policy.ts:36`; `knowledge/embed.ts:23-27, 68-74`). That covers Anthropic, DeepSeek, Kimi, xAI, MiniMax and Meta. **Every Claude project chat with indexed files is lexical-only.**

**Saving** (`flip-sim-report.txt`; 20K tokens of documents, 12-turn chats, short gaps):

| Flip probability per turn | Turn cost today | After fix | Saving |
| --- | --- | --- | --- |
| 10% | 11,036 units | 8,160 | **−26%** |
| 20% | 13,121 units | 8,160 | **−38%** |
| 40% | 15,437 units | 8,160 | **−47%** |

Overall weight: the share of turns in lexical-only project chats with indexed files, guessed at 3–8% of chat turns. That gives roughly **−2% to −5% of total chat spend**. The per-conversation effect is the largest found.

**Quality risk: low–medium.** Today, a content-free follow-up accidentally shows the model the whole library on that one turn; normal turns never do. The fix makes behaviour consistent: indexed files are always represented by retrieved extracts in the tail. For "summarise the whole document"-style follow-ups that match nothing lexically, offer `read_document` for project files, or reuse the previous turn's passages. Do not re-inline everything.

**Implementation sketch**
- `project-context.ts:136-141`: keep `indexedFileNames` whenever `retrieved` is non-null, even with zero passages. For example, `projectKnowledge = { passages: [], indexedFileNames, degraded }`, so `buildProjectReferenceFiles` excludes them every turn. `buildProjectPassages` renders nothing for an empty list.
- Check `turnCarriesUntrustedContent` (`capabilities.ts`): `projectKnowledge` truthiness then stays constant, which also stabilises F4.
- Test: a two-turn fixture whose second message matches nothing must produce byte-identical `modelHistory[0]`.

**How to measure:** `prefix.verdict = "history_rewritten@0"` on `llm.request` records of project conversations. It should go to ≈ 0 outside window jumps. Also the `promptTokens` spikes per project conversation, which should disappear.

---

### F5 — OpenAI: a per-conversation cache key makes every new chat's first turn cold

**What happens today:** `cacheKey: conversationId` (`run-turn.ts:900`) becomes `prompt_cache_key` (`openai-prompt-cache.ts:117-124`). The private path already uses `private-${user.id}` (`private-turn.ts:382`). OpenAI routes by prefix plus key, and the repo's own note says the key is "required for reliable matching on GPT-5.6+" (`openai-prompt-cache.ts:7-8`). A new conversation therefore lands on a machine that has never seen this user's head. The tools + stable + tier-2 head (~12.5K tokens, byte-identical across that user's chats) is re-written on every conversation's first turn. On GPT-5.6+ that write is 1.25x at the explicit system breakpoint.

Anthropic needs no key: an identical prefix is shared within the workspace (prompt-caching docs, "Cache storage and sharing"). So this gap is OpenAI-specific, and OpenAI serves the FREE default (GPT-6 Luna).

**Arithmetic** (GPT-5.6+, 5-turn chats):
- A cold first turn ≈ 1.25 × 12.5K + 0.2K ≈ 15.8K units.
- A warm one ≈ 0.1 × 12.5K + 0.2K ≈ 1.45K units.
- Later turns ≈ 3.5K units, so the average turn costs (15.8 + 4 × 3.5)/5 = 5.96K.
- If 40% of first turns follow a request by the same user within the 30m TTL: (0.6 × 15.8 + 0.4 × 1.45 + 14)/5 = 4.81K, which is **−19% input**. At 20%: **−10%**.

**Quality risk: none.** Routing only.

**Caveat.** The OpenAI prompt-caching guide (developers.openai.com/api/docs/guides/prompt-caching) could not be fetched from this session: the host is outside the allowed network. Search snippets confirm the 1,024-token minimum, key-based routing, and "keep each prefix + key under ~15 requests per minute". A per-user key stays far below 15 RPM except during heavy parallel tool loops. Verify before shipping with a two-conversation probe: same user, same head, measure `cached_tokens` on the second conversation's first request with the per-conversation key and with the per-user key.

**Implementation sketch**
- `run-turn.ts:900`: pass `cacheKey: hash(user.id)` for OpenAI hosts. Keep the conversation id as the **diagnostic** key: `createRequestMeter` (`llm.ts:209-221`) needs a separate `diagnosticKey`, or the prefix tracker would compare across chats.
- Keep `x-grok-conv-id` per conversation for xAI, whose semantics are per conversation.
- Optional: on GPT-5.6+, split the system input into two `input_text` parts with the breakpoint on the stable part (`openAIResponsesSystemInput`, `openAISystemMessage`). A memory-summary change then still reads tools + stable (11.7K).

**How to measure:** `cacheReadShare` of the first request of each conversation on OpenAI `llm.request` records (`role: chat`, `round: 1`, first turn), before and after.

---

### F4 — The untrusted-content rule toggles at the head of the stable tier

**What happens today:** `if (opts.untrustedContent) parts.push(UNTRUSTED_CONTENT_RULE)` (`system-prompt.ts:277`) inserts 400 tokens **right after the 46-token identity line**. The flag is `turnCarriesUntrustedContent` (`chat/turn/capabilities.ts:76-126`). With web search on (paid default) it is constantly true. Without web search (FREE plan, `plans.ts:74`; or the user toggled search off), it depends on per-message signals:
- `projectKnowledge`, which is set only when passages came back (see F9);
- `attachmentKnowledge`;
- `contextTokensUntrusted` (references named in this message).

Every flip changes the stable tier at token ~46. That costs everything after it on every provider. On OpenAI, the rendered prefix diverges after ~50 tokens.

**Saving** (`flip-sim-report.txt`, shared stable variants assumed warm): −10% / −16% / −22% of turn cost at 10% / 20% / 40% flip probability. That applies to FREE-plan project and reference chats and to search-off users. Overall ≈ −1% to −3%.

**Quality risk: low.** Always include the rule. It describes markers that only appear around untrusted text, so on a plain chat it is inert. It costs 400 tokens × 0.1 = 40 units per turn. Keep `untrustedContentInTurn` for what it also gates (memory writes, task approvals); only the prompt text becomes unconditional. Side benefit: one fewer variant of the cross-user shared head, so more first-turn hits.

**Implementation sketch:** `system-prompt.ts:277` pushes the rule unconditionally (or add an `untrustedRuleAlways` option); `prompt.ts:115` and `private-turn.ts:144-175` stop passing per-turn `untrustedContent` into the prompt builder; update `tests/untrusted-content.test.ts`.

**How to measure:** `prefix.verdict = "system@0"` (stable-tier change) on FREE-plan conversations; it should reach ≈ 0.

---

### F10 — Semantic-artifact outlines in tier 2 change on every edit

**What happens today:** `semanticArtifactContext` (`chat/turn/semantic.ts:25-44`) puts outlines of up to 4 workbooks, documents or decks (24K characters ≈ 6.7K tokens) into `base` → tier 2 (`prompt.ts:159`, `route.ts:301`). Each section header carries `version N` (`artifact-ops.ts:229-237`), and the outline changes with each edit. Edit-heavy chats therefore rewrite tier 2 at 2x and the history at 1.25x on almost every turn.

**Arithmetic** (outline O = 3K, H = 8K, tier 2 V = 0.8K):
- An edit turn with the outline in the system costs 2 × 3.8K + 1.25 × 8K + 0.1 × 11.7K ≈ 18.8K units, against 2.35K unchanged: **+16.5K per change**.
- In the tail, the outline costs O × (1 − 0.1) = **+2.7K per turn**, with no change penalty.
- The tail wins when the change rate c > 16%.
- At c = 25%: system 4.1K against tail 2.7K, which is **−34% of that overhead** and about −15% to −35% of input in those chats.

**Quality risk: low.** Same text, labelled "current version". It is not instruction-bearing, and the edit contract stays in the system tier.

**Implementation sketch:** in `route.ts:301` / `prompt.ts:159`, when any listed artifact's newest version was created in the last 2 turns ("hot"), put the outline in the volatile tail. Otherwise leave it in the system, so a settled document stays cached. Do not move it back and forth on every turn: each move costs one rewrite.

**How to measure:** `prefix.verdict = "system@1"` on conversations with semantic artifacts, and their per-turn `cacheWrite` tokens.

---

### F11 — The research synthesis corpus is written to the 1h cache at 2x and never read

**What happens today:** `synthesisSystem = system + research.context + RESEARCH_OUTPUT_CONTRACT` (`research-stage.ts:178`) lands in tier 2, which carries `ttl: "1h"` (`anthropic.ts:282-288`). The corpus (tens of thousands of tokens) is used by this one request, so it is billed at 2x instead of 1x. The turn also drops every tool (F2), so the whole history is rewritten, and the next turn rewrites it again. COST_ENGINEERING #14 noted the miss but not the 2x premium.

**Arithmetic** (corpus 40K, head 12.5K, H = 10K):
- today ≈ 2 × (0.8K + 40K) + 1.25 × 10K + head ≈ **95K units**
- after, with the corpus in the tail and tools and system unchanged: 0.1 × 23K + 40K ≈ **42K units**
- that is **−55% of the call's input**.

Research synthesis turns are perhaps ~2% of chat turns but about 10x a normal turn's input, so overall ≈ −1% to −2%.

**Quality risk: low.** Same corpus and same output contract. The contract can stay in the system tier only if it is constant; otherwise it moves with the corpus. Check the citation-audit pass rate on a research eval.

**Implementation sketch:** `research-stage.ts:176-180` returns the corpus as a tail block (via F1's instruction/context tail) instead of `synthesisSystem`. Keep the declared tools per F2. For a non-Anthropic writer that re-reads the corpus, the existing `systemStablePrefix` corpus tier (COST_ENGINEERING #18) is the model to follow.

**How to measure:** `cacheWrite1h` tokens on `llm.request` records of research-synthesis turns, which should fall to ≈ 0, and their `cacheReadShare`.

---

### F6 — Date and tail placement on Gemini, OpenAI-compatible labs and pre-5.6 OpenAI

**What happens today**
- `openai-compat.ts:340-345` and `openai-responses.ts:344-359` (non-modern layout) insert the date as a system item **in front of** the newest user turn.
- `gemini.ts:114-122` inserts a user part there instead.
- On these paths the volatile tail stays inside the newest user message (`appendVolatileTail`).

Consider turn N+1's request: `[…, a_{N−1}, u_N, a_N, date, u_{N+1}]`. Turn N wrote `[…, a_{N−1}, date, u_N]`. The common prefix ends **before u_N**, so u_N, including every attachment inlined in it, is billed at full price twice.

The comment at `openai-responses.ts:345-347` ("costs at most one interval") understates this: the cost is the whole previous user message. The modern GPT-5.6+ layout (`detachNewestVolatileTail`, date last; COST_ENGINEERING #22) fixes it for OpenAI only.

**Arithmetic**
- Text turns lose ~150 tokens × 0.9 ≈ 135 units per turn (~2–3% of input).
- Attachment turns lose the attachment once more. Example: an 8K-token PDF text on 8% of turns costs 0.08 × 8K × 0.9 ≈ 580 units per average turn, **~10% of input** for attachment-heavy users.
- Gemini implicit caching gives a 90% discount on hits for 2.5 and later (docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview). DeepSeek, Kimi and GLM have similar cache discounts (COST_ENGINEERING ledger table).

**Quality risk: low.** This is the same layout already in production for GPT-5.6+. Check that each compat lab's chat template accepts a trailing system/user part. Qwen's markers (`withQwenCacheMarkers`) expect the date position; move their "end of stable history" marker to the newest user message.

**Implementation sketch:** generalise `detachNewestVolatileTail` + "date after everything" to `openai-compat.ts`, `openai-responses.ts` (all hosts) and `gemini.ts`. Keep the attachment parts **before** the detached tail.

**How to measure:** `cacheReadShare` on `llm.request` for `wire: compat | gemini | responses (pre-5.6)`, plus `prefix.verdict` (the diagnostic already treats a mid-history date as part of the prefix, `prefix-diagnostic.ts:19-23`).

---

### F8 — Auto: no prompt-cache switch cost in the router

**What happens today:** Auto picks the model **and** effort from the current message alone (`chat/turn/model.ts:133-186`; `auto-model.ts:321-349`).
- `auto-switch-report.txt`: over 42 consecutive turn pairs (5 conversations × FREE/PRO), Auto stayed on one model (GPT-6 Luna) but changed effort on **14%** of pairs, for example `high → instant` after the refactor request and `instant → low → instant` across "make it a bit more formal".
- An effort change invalidates the messages cache on Anthropic, and can invalidate system and tools as well (prompt-caching docs, "How does prompt caching work with thinking?"). The repo's diagnostic assumes OpenAI's reasoning setting also changes the rendered prefix (`prefix-diagnostic.ts:66-67`).
- The router's cost model prices all input at the full rate. `callCost` (`router/decide.ts:276-280`) estimates input as `contextTokens + 1_200` (`router/task-class.ts:192`), whereas the measured system + tools head is ~12.5K tokens. Under-counting input by ~11K tilts the ranking toward output price and makes cache state invisible.

**Arithmetic:** each avoided effort switch saves about 1.15 × (12.5K + H) ≈ 20K units if the whole prefix is invalidated, or 1.15 × H ≈ 6K if only messages are. Holding a higher effort on a simple follow-up can cost more reasoning output than that, so this must be a **cost comparison, not a rule**. If about two-thirds of the 14% of switches are cheaper held, that is ~9% of Auto turns × 6–20K units ≈ **−5% to −10% of Auto-turn input**.

**Quality risk: none–low.** The intelligence floor and any **upward** switch are unchanged; only ties and downgrades consider the cache. Holding an effort level only ever means more reasoning, never less.

**Implementation sketch**
- `router/decide.ts`: add `switchMicroUsd = prefixTokens × (writeRate − readRate) × inputPrice` for every candidate whose `(model, effort)` differs from the conversation's last served pair. Read it from the last assistant `Message.model` plus the stored effort.
- `router/task-class.ts:192`: use the real head size, e.g. the `build-turn` measurement as a constant per client and toggles.
- `chat/turn/model.ts`: pass the incumbent.

**How to measure:** `prefix.verdict = "settings"` and `"model"` counts on Auto turns, and `scripts/cost-per-accepted.ts` per task class, before and after, so quality does not regress.

---

## 3. Measuring all of it (one dashboard)

All the instrumentation already exists. Make these four cuts:

1. **`llm.request` log lines** (`src/lib/llm/request-meter.ts`): group by `prefix.verdict` (`stable`, `tools`, `system@0`, `system@1`, `settings`, `model`, `history_rewritten@i`) per 1,000 chat turns, split by provider and plan. The mapping to findings:
   - F1, F10 → `system@1`
   - F2 → `tools`
   - F4 → `system@0`
   - F9 → `history_rewritten@0`
   - F8 → `settings` / `model`
   Target: `stable` ≥ 95% of non-first requests.
2. **`cacheReadShare`** on the same records: cached input / total input. Targets (Anthropic): 80.6% → ≥ 88% (10-turn chats) and 69.6% → ≥ 85% (30-turn) once F1, F2 and F7 are in.
3. **Message rows:** `sum(cacheReadTokens)/sum(promptTokens)` and `sum(cacheWriteTokens)/sum(promptTokens)` per provider, weekly. The write share is the number F1, F2 and F7 move most.
4. **Trace features** (`createTurnTrace` → `features.regenerate | skill | artifactEdit | research`): join with (1) to confirm each event's miss disappears, and to recalibrate this document's event rates. The per-event costs in §F1 make the recalibration a multiplication.

Quality guardrails, one run per change: the existing evals for image-intent tool calls, regenerate adjustments, skill adherence, canvas patch validity, research citation audit and project-doc answers. Watch `scripts/cost-per-accepted.ts`, the router's kept-turn rule: cost per accepted result should fall and the kept rate should hold.

## 4. Combined estimate

Gaps assumed at 65% under 5 min, 25% between 5 and 60 min, and 10% over 60 min, with the stated event mix.

| Change set | 10-turn chats | 30-turn chats |
| --- | --- | --- |
| F1 + F2 | −16% input / −9% turn cost | −21% input / −16% turn cost |
| F1 + F2 + F7 (adaptive 1h) | −19% / −11% | −39% / −29% |

On top of that, only where they apply:
- F9: −26% to −47% in lexical project chats.
- F4: −10% to −22% in FREE/search-off flips.
- F5: −10% to −19% of OpenAI input.
- F10, F11, F6 and F8: small overall (~1–3% each) but large in their own chats.

If main chat turns are ~75–80% of API spend, the F1 + F2 + F7 bundle alone is worth about **−8% to −20% of total spend**, depending mostly on conversation length and reply gaps. Measure the gaps with the SQL in F7 before choosing the TTL.

## 5. Sources

- Anthropic prompt caching, fetched 2026-10-31: https://platform.claude.com/docs/en/build-with-claude/prompt-caching (docs.claude.com redirects there). Facts used:
  - order is tools → system → messages, with at most 4 breakpoints and a 20-position lookback;
  - invalidation table: tool definitions invalidate everything; the web-search toggle and speed invalidate system and messages; `tool_choice` and images invalidate messages; thinking and `output_config.effort` invalidate messages and possibly system/tools;
  - 5m write 1.25x, 1h write 2x, reads 0.1x (0.05x Opus 5.5 / Sonnet 5.5, 0.025x Fable / Mythos 5.1);
  - the 1h entries must precede 5m entries, billed by the A/B/C rule;
  - the lifetime counts from request start;
  - minimum cacheable prompt is 512 tokens on 5.x models;
  - caches are isolated per workspace;
  - cache hits are not deducted from rate limits.
- OpenAI prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching. **Not reachable from this session** (the host is outside the allowed network; it must be allowed in the session's network settings to re-verify). Search snippets used: the 1,024-token minimum, `prompt_cache_key` routing, and staying under ~15 RPM per prefix + key. GPT-5.6+ breakpoint and 30m TTL details are taken from the repo's own citations (`openai-prompt-cache.ts`, COST_ENGINEERING #22–23) and are unverified here.
- Google context caching: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview. Facts used: implicit caching is on by default with a 90% discount on Gemini 2.5+; explicit caching has storage cost; a 2,048-token minimum on Vertex.
