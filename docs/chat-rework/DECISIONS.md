# Chat rework: decisions

These are the owner-facing decisions for the rework of tool calling, the thinking animation, the right
panel, Research, and the motion design behind them. They come from the audit in `audit/`, in particular
`internal-tools-e2e-trace.md`, the root-cause list the tool work starts from. `SPEC.md` turns them into
exact contracts. Where the two disagree, this file wins.

Scope is the **web app**. The Mac Chat redesign (worktree `juno-glass`) mirrors it later, and the
server stays wire-compatible with shipped native builds.

---

## 1. Tool calling

**T1. Fix the five root causes first. They are why tool calling "doesn't work".**

- **RC-1.** Every Juno runtime tool (`read_document`, `inspect_image`, the page reader, `code_interpreter`)
  is classified by the approval broker from its own declared risk. A read is allowed with no prompt.
  `onApprovalRequest` and the provider `callId` reach the broker, and the stall watchdog is paused
  while any tool runs. Today every one of these calls waits invisibly for an approval, then dies at 120 s.
- **RC-2.** Every tool-capable model can search and read the web, not only Anthropic, Google and xAI.
- **RC-3.** A connector that fails to connect says so: a warning row, a note to the model, and
  "Connected tools ready" listing only the connectors that really connected.
- **RC-4, RC-5 and RC-7.** Provider fixes:
  - Gemini gets sanitized schemas.
  - Gemini gets the enveloped tool text, `exec.text`.
  - Pre-Gemini-3 models keep their function tools.
  - Compat thinking models get their `reasoning_content` back on tool rounds.
- **RC-13.** Every adapter hands the broker the provider's call id.
- **RC-14.** Failures reach the model:
  - a failed call returns `is_error`;
  - malformed arguments are reported back to the model, not silently turned into `{}`.

**T2. One tool contract.** Every Juno-native tool is a `ToolSpec` in one registry. It carries:

- an id and a title;
- a description written to Anthropic's template: what it does, when to use it, when not to, the
  inputs, what it returns, what to do next;
- a portable input schema: `type`, `properties`, `required`, `items`, `enum` and `description` only;
- a `risk`: `read` | `write` | `external` | `destructive`. The risk drives approval, and `read`
  never asks;
- `parallelSafe`, `timeoutMs` and an icon kind;
- human status copy, generated from the arguments: a running label ("Searching the web for
  *X*"), a done label ("Searched the web"), and a result figure ("10 results").

The UI never shows a raw tool id. MCP tools are mapped into the same shape. The server's
annotations set their risk; when an annotation is missing, the risk is `external`, which asks.

**T3. The chat tool set.** The model decides when to call a tool. Tools are not buttons.

| Tool | What it does | Attached when |
|---|---|---|
| `web_search` | Juno's multi-engine search (`src/lib/web-search.ts`). Returns results with ids the model can cite | Web is on, and the model has no native search. Native search stays where it exists (Anthropic, Gemini, xAI, and OpenAI through the Responses hosted tool where the adapter supports it) |
| `web_fetch` | Reads one page or PDF as clean text. **Only for a URL with provenance**: it appeared in the conversation's user messages or in an earlier tool result. It replaces `browser_agent` in chat, which advertised click and type actions it never performed | Web is on (every model) |
| `read_document`, `inspect_image` | Unchanged, but they now work (RC-1) | As today |
| `run_code` (the current `code_interpreter`) | Python in the remote sandbox, for analysis, charts and files | A remote sandbox is configured and the plan allows it. It no longer needs an attachment. Never on a host process |
| `search_chats` | Searches the user's own past conversations; results are read-only | Saved, non-private turns |
| `current_time` | Date, time and timezone for the user | Always, on tool-capable models |
| `calculate` | Safe arithmetic and unit maths with no `eval` | Always, on tool-capable models |
| `start_task` | Hands the work to a Work task | As today |
| `suggest_research` | Shows a "Research this" chip. Nothing runs until the user clicks it | Web is on, research is entitled, and research is not already armed |
| MCP connectors | As today, plus the fixes above | As today |

Memory stays on the existing `<juno:memory>` path in this rework. Memory tools are a later step.

**T4. Web is on by default** when the plan allows it. A stored explicit "off" is respected, and the
model decides when to search. This follows Claude and ChatGPT: a toggle is not a prerequisite for
tools.

**T5. The loop.**

- **Budget.** A round budget scaled by effort replaces the flat cap of 6: 4 at low, 10 at default,
  16 at high, 24 at max. It sits inside the existing wall-clock and spend guards.
- **Parallelism.** Parallel-safe `read` calls in one round run concurrently, at most 4 at a time.
  Everything else runs in order. All results go back to the model in one message.
- **Duplicates.** Within a turn, a repeat of the same tool with the same normalised arguments
  returns the cached result.
- **Timeouts.** Each tool has its own timeout, and the row shows it.
- **Final round.** The last round has tools off and carries a one-line "answer from what you have"
  note.

**T6. The ordered run timeline.** It replaces the inference that splits a run into
Research/Think/Write.

- **Order.** Every activity event gets a server `seq`. Every reasoning part and every tool call
  carries the `round` it belongs to, so the UI can interleave thinking and tools truthfully.
- **Tool record.** A tool call is a typed record that is updated in place under one id:
  `callId`, `tool`, `title`, `status`, `startedAt`, `endedAt`, `figure`, `error`, the redacted
  args and result, and `approval`.
  - `status` is one of `queued`, `awaiting_approval`, `running`, `succeeded`, `failed`, `denied`,
    `expired`, `cancelled`.
  - The UI never matches on a title prefix.
- **Persistence.** Approvals are persisted with the call and survive `done` and a reload.
- **Answer text.**
  - Text a model writes in a round that ends in tool calls is **commentary**. It is stored as a
    timeline item, not glued to the answer ("Let me check.The answer…" is fixed).
  - The answer is the text of the final round.
  - If the final round wrote nothing, the fallback is today's concatenation.

**T7. Memory across turns.** When an earlier assistant turn used tools, the history the model sees
carries a short note of what was called and what came back. The note is capped and truncated. A
follow-up such as "what did page 3 say?" then works without re-fetching.

## 2. The thinking animation and the right panel

**U1. The run block is inline first.** One component above each answer, from send to done. It
replaces the `StreamStatus`→strip handoff.

- **While working:**
  - one status line: a glyph, a phase label with a shimmer, and the elapsed time in tabular
    numerals;
  - below it, the live steps as they happen: the latest reasoning excerpt, tool rows with their own
    running, done and failed state, and "Waiting for your approval" with the card anchored to its
    call.
- **When the answer starts:** the block folds, with a `grid-rows` collapse and no jump, into one
  summary line: "Thought for 12s · 5 sources · ran code ›".
- **Clicking the summary** expands the full chronological timeline inline. That is one click, not
  two.
- **Nothing that was visible while streaming unmounts without a collapse** (bug B2).

**U2. The thinking indicator.** This follows the motion audit's recommendation (§3.3,
"Concept A").

- **One signature for every working state.** It replaces the old dot matrix's paint-heavy loop and
  the other working vocabularies the audit counted on a single turn (shine, sweep, globe, spinners,
  pulsing dots).
- **The glyph is a phase-typed matrix.**
  - An 18 px 3×3 grid. Only the opacity of each dot's lit layer loops.
  - Each phase has its own pattern:
    - Thinking: a travelling point.
    - Searching: a column sweep.
    - Reading: a row sweep.
    - Tool: an orbit.
    - Writing: the bottom row types.
  - Waiting and failed do not move.
  - At done the dots gather into the 6 px resting dot.
- **The label** carries a compositor-only shimmer.
- **Timing.**
  - Every loop runs on one period, `--loop` = 2.4 s, the `breathe` family, locked to the page clock.
  - After 20 s of continuous work the run goes calm: no shimmer, and a 4.8 s glyph.
- **Ink and paint.**
  - One muted ink. The accent appears only for "waiting for you". Coral is never decoration.
  - Only `transform` and `opacity` animate. There is no `box-shadow` trail and no `height` in the
    transcript.
- **Pacing.**
  - No label for the first 400 ms, so a fast answer never flashes "Thinking".
  - A shown label stays at least 600 ms.
  - Label changes are at least 700 ms apart, and the newest phase wins.
  - Clock ticks never restart an animation.
- **One loop owner on screen.** It is the transcript line, or the panel's running row when the
  panel is open.
- **Reduced motion.** Each phase has a static signature, an opacity breath shows the run is live,
  and labels cross-fade. There is no shimmer and no travel.
- **Inline steps.** Under the live line there is a fixed 2-slot "peek" of the latest steps: tool
  rows with their own state. It grows by translating, never by resizing. It collapses at the first
  answer token, scroll-anchored, before any answer text renders. That keeps U1's "live steps"
  without the layout jump.

**U3. The right panel ("Activity") is the detail surface.** Reading the thinking does not require it.

- **Layout, top to bottom:**
  - a header with the live phase or "Thought for Xs", aligned with the chat header's height;
  - **Timeline**: reasoning as readable prose, interleaved with tool rows in the order they happened;
    a row expands to its arguments and result, and failures read as failures;
  - **Sources**: split into *Cited* and *Also read*;
  - **Details**: model, effort, context, and the memory used, with Forget.
- **What leaves the panel:** Cost as a headline figure, the five-way filter, the Summary/Full radio,
  and the Research/Think/Write ledger.
- **Identity.** The panel is keyed by the message's stable client key, so it no longer closes when an
  answer completes (bug B1). It enters and exits *with* its content.

**U4. One right-column shell**, used in this rework by the Activity and Research panels. The canvas
and the file viewer adopt it later. The Artifacts & Design session (branch
`wip/artifacts-design-audit`) is reworking the canvas, so this rework changes nothing in
`CanvasPanel` or `DocumentViewer` beyond the shared coexistence rule in `chat-view`. The shell:

- the same header height, fill and 16 px gutter;
- close, and back on narrow screens;
- enter and exit transitions that are safe under reduced motion;
- no ad-hoc `z-40`.

Below the split, the panel is a sheet that keeps the composer reachable.

**U5. Performance.**

- No panel re-render per answer token.
- The 1 Hz clock lives in a leaf component.
- Reasoning derivations are memoised.
- No animation runs while invisible.

**U6. Accessibility.** One polite announcer speaks phase boundaries (searching, using a tool, waiting
for approval, writing, done). Accessible names include the counts and any warning.

**U7. Verification.** Everything is verified in `/dev/run` and `/dev/research` galleries: scripted
fixtures played by a stepper, both themes, and reduced motion.

## 3. Research

**R1. One feature, called "Research".**

- "Deep" is dropped from every UI string.
- **No level names anywhere** in the web UI: no Quick, Standard, Deep or Max.
- The server ignores `researchEffort` from old clients and logs it.
- The run's envelope comes from `researchBudgetFor(scope, plan, remaining budget)`:
  - `scope` is the planner's decomposition: questions, breadth and freshness;
  - the envelope sets workers, rounds, pages, clock, tokens, judge calls and the spend ceiling;
  - the envelope is frozen on the run.
- No pre-run depth control. The person changes the scope by editing the plan, and the estimate line
  follows the edit. After a run, "Keep researching" is the only way to go further.

**R2. One gate: the scope card.**

- The plan and up to 3 optional clarifying questions share one card:
  - the approach sentence;
  - 3–6 questions, editable in place;
  - the sources;
  - an estimate line: "About 12 min · reads up to ~150 pages".
- **Start** is primary.
- A tiny scope (1 question and at most 3 min) skips the card.

**R3. One completion path.**

- Every run goes through the background engine.
- On completion, an assistant message is persisted into the conversation: a cited summary of
  120–250 words and a report card.
- A typed "yes" or "start" confirms through the same path.

**R4. Live progress.**

- **Transcript:** a one-line row showing the phase sentence, working time, a favicon stack,
  "N sources" and "Open ›". It is not a console in the transcript.
- **Right panel "Research":**
  - **Progress**: the questions with their status, the activity stream, and "Found so far" with
    quotes;
  - **Sources**: Cited, Read and Found;
  - **Plan**.
- **Controls:** Pause, Resume, Finish now, and Cancel (which confirms).

**R5. The report.**

- It opens in the panel, with a full-screen reader.
- **Structure:** the bottom line first, key findings, one section per question, where sources
  disagree, what could not be established, method, and sources (Cited, then Read-not-cited).
- **Citation hover cards** show the verbatim supporting quote.
- **Support marks:** supported, partly, or not checked. "Unsupported" appears only when a judge
  actually looked.
- **Export:** Markdown, and PDF through the print pipeline. File names use the report title.

**R6. Steering is an explicit composer mode.**

- While a run works, the composer offers "Guide the research". Guidance is applied at the next round
  boundary.
- The composer's Stop controls only the chat stream. It never cancels a run.

**R7. Completion is noticed.**

- The tab title changes and a toast appears when the person is elsewhere in the app.
- A browser notification is opt-in, asked on the first Start of a run estimated over 5 minutes.

**R8. The engine fixes that come first** (backend audit B1–B8):

- release leases at gates and heartbeat through long stages;
- make the chat hand-off non-claimable;
- a judge cap marks claims "not checked", never "unsupported";
- structured planner output with a larger cap;
- today's date goes into every research prompt;
- the writer's corpus is packed to a token budget, the writer is timeboxed, and an empty report
  fails;
- the writer and audit are reserved before each round;
- the goal comes from the user's words plus conversation context, not the clarification wrapper.

## 4. The Library bug (separate, same branch)

A Library delete hides the file from the Library only (`Attachment.libraryRemovedAt`). A chat or
project that uses the file keeps it. A file nothing else uses is tombstoned as before.

Backfilling files deleted before the fix changes production data, so it waits for the owner's go.

## 4b. Resolutions of the audit critic's contradictions (2026-09-23)

- **Wire compatibility is a hard constraint.** Shipped native builds reject any SSE frame `type`
  they don't know: `NativeChatAPIClient.swift` hits `default: throw malformedResponse`, and the
  OpenAPI `ChatSSEEvent` is a closed `oneOf`. Therefore:
  - **No new SSE frame types.** Everything in T6 rides on existing frames as *added optional
    fields*: `seq`, `round`, the tool record, `commentary`, and so on.
  - Existing fields keep their meaning.
  - Activity titles that native parses stay as they are, or are duplicated into typed fields while
    the old title remains.
  - A web-only frame is allowed only if the server sends it solely to clients that declare support,
    through a request flag. The web client sets the flag and native clients don't.
- **Where the thinking lives.** U1 and U2 as amended above:
  - The live line plus a fixed 2-slot peek of the latest steps.
  - The peek collapses at the first answer token, before any answer text, with scroll anchoring. It
    is the only automatic height change in the transcript.
  - The full timeline expands inline **only on the user's click**.
  - The Activity panel holds the details.
  - "Writing" is shown only in Research. A chat turn settles at its first answer token, and if a
    tool starts after text has begun, it re-enters a working phase.
- **Round budgets.** 4 / 10 / 16 / 24 for low / default / high / max. Final.
- **The ordering in RC-1.** `browser_agent` leaves chat (T3) *before* the broker trusts declared
  risk. Only `read_document`, `inspect_image`, `web_fetch`, `web_search`, `search_chats`,
  `current_time` and `calculate` are auto-allowed reads. `run_code` runs in a remote sandbox on the
  user's own data, so it is `read`. A connector without annotations stays `external`.
- **Research report writer.** The named research-lead model writes the report, and the provenance
  line says which model. The persisted chat summary is written by the same model in the same pass.
- **Native Research path.** Shipped native clients keep today's in-chat path: `deepResearch: true`,
  auto-confirm, and the chat model streams the report. The web moves to the background engine with
  a persisted summary message. The Mac session adopts the new contract later. This is a transitional
  split, recorded in the handoff.
- **Estimate line.** Time and pages only: "About 12 min · reads up to ~150 pages". Spend shows in
  the panel's details, in the plan's currency (EUR).
- **i18n.** Argument-bearing copy is rendered as a fixed, translatable phrase plus separate argument
  nodes: `<span>Searching the web for</span> <q>query</q>`. That way the exact-match AutoTranslate
  catalog still matches the fixed part. Plurals use distinct whole phrases ("1 source" / "5 sources"
  → the key "sources" with a number node) and never concatenation. The `gap-dynamic-copy-i18n`
  report is the authority on the mechanism.

## 4c. Defaults for the owner questions in the gap reports (conservative; the owner can override)

These defaults unblock implementation. The handoff lists each one for the owner to confirm. The
cost choices lean toward spending less.

- **Search engines in chat.** `web_search` uses one primary keyed engine: the first of Tavily,
  Serper, Brave and Exa that is configured. It falls back to one other only on failure.
  - No public SearXNG, DuckDuckGo scrape or Wikipedia in chat. If no keyed engine exists, chat
    `web_search` is not offered.
  - Research keeps its own fan-out for now.
  - Every search is metered at the engine's real per-query cost, from now on only. There is no
    backfill.
- **FREE.** No web search or fetch, `run_code`, connectors or `start_task`, which today is always
  refused anyway. FREE gets `current_time`, `calculate`, `read_document`, `inspect_image` and
  `search_chats`. No Research.
- **Private chats.** `current_time` and `calculate` are always available. `web_search` and
  `web_fetch` are available only when web is toggled on *in that chat*.
  - No `search_chats`, connectors, code or tasks.
  - The read tools here bypass the broker, so a private chat leaves no durable receipt.
- **Lockdown.** Only `current_time` and `calculate` are allowed. Lockdown now also stops
  provider-native search and Research, to match its Settings copy ("reading included").
- **Voice.** Unchanged in this rework.
- **Workspace keys.** No new keys, because a new key is a native contract change.
  - `web_search` and `web_fetch` follow `webSearch`.
  - `search_chats` follows `memoryRecall`, scoped to the project inside a project.
  - `run_code` follows the closest existing key. If none fits, it is off inside a workspace that
    restricts tools.
- **Skills.** A skill that lists tools also narrows native search and the new tools.
- **`run_code`.** Only on paid plans, and only when a remote sandbox is configured. It is metered
  per call.
- **Research money.**
  - `researchBudgetFor` sizes the run within a per-plan cap, taken from the entitlements gap report
    §6.5 as the starting table.
  - It checks the monthly budget, not the 5-hour and weekly windows. Research has its own capped
    share of the month.
  - `RESEARCH_CHAT_BUDGET_USD` stays only as an owner override clamp.
  - `POST /api/research` stops accepting a client-set or `null` ceiling.
  - The estimate line shows no amount.
  - Research spend is unified under `kind: "research"`.
- **Ledger.** Juno tool fees are recorded as `kind: "chat"` with model `juno-tool:<id>`. There is no
  enum migration.
- **Frontier turn cost.** The budget guard is enforced on tool events mid-loop. It checks the
  binding usage window, not only the month. When the budget would be exceeded, the loop ends in the
  final answer round instead of failing.
- **Gemini grounding** beyond the free quota is recorded at its real cost.
- **Memory on turns tainted by untrusted content.** Strict, as today: no write.
- **Anthropic fetch.** Juno's `web_fetch` everywhere, for one sources and UI path.
- **Fetch identity.** An honest User-Agent that names Juno and says the fetch is user-initiated.
  One-off user-initiated fetches do not enforce `robots.txt`; the Research crawler keeps its
  current policy.
- **Provenance "ancestor paths".** A site root is allowed for any URL already on the ledger for that
  host.
- **i18n.**
  - This rework uses the pragmatic rule in §4b: fixed phrases and argument nodes, whole-phrase
    plurals, and durations and numbers through `Intl` in the UI locale.
  - Streaming regions are marked `data-no-auto-translate`, and AutoTranslate skips mutations inside
    them.
  - The full ICU MessageFormat pipeline and receipt v2 are follow-ups.
  - Content language (D-1) is option C: the explicit setting, else the question's language, else
    the UI locale, frozen per run.
  - Non-English UIs show a localised phase label in the status line (D-5 ii).
- **Already fixed on this branch.** The Node 24 pinned-DNS failure is c899d6f7: every pinned fetch
  threw `ERR_INVALID_IP_ADDRESS`, so Research page reads and Work fetches were failing. It can ship
  on its own.

## 5. What this rework does not do

- It does not change native Swift. The server keeps accepting old fields, and the Mac session gets
  the spec.
- It adds no interactive browser to chat. That belongs in Work.
- It adds no memory tools, `ask_user` card, image-generation tool, scheduled tasks or report sharing
  links. These are listed as next steps in the handoff.
- Nothing is merged to main and nothing is deployed without the owner's go.
