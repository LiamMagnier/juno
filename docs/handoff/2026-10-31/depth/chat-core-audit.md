# Chat core quality: Alevr vs ChatGPT and Claude (depth audit)

Date: 31 October 2026. Repo `/home/user/juno` at `main` HEAD `e532983ea`. Read-only static review plus one local script that builds the real system prompt (`scratchpad/depth/scripts/prompt-size.ts`). Nothing was run against a deployment, so no latency number below is a production measurement. Where a number is an estimate, the text says so.

Scope: the everyday answer. How long until the first word appears, how the stream looks, how answers render and cite, how the reasoning shows, what search does, Auto, edit/branch/regenerate/stop/continue, long chats, chat search, the sidebar, shortcuts, error and offline states, and what the main system prompt makes the model write. Features already being built in parallel are not re-specified: share with specific people, per-chat memory off, AI-powered artifacts, PDF/Google export, locked chats, Drive/OneDrive attach, connectors in voice, tone sliders, MCP Apps widgets, plugins. The full UI/motion redesign is also out of scope.

## Source limitations

- `help.openai.com`, `openai.com`, `techradar.com`, `searchenginejournal.com` and `fonearena.com` failed DNS from this session. They are outside the session's allowed network domains. Every ChatGPT claim comes from web-search excerpts of those pages or from press. Treat ChatGPT details as lower confidence. To fetch them directly, `help.openai.com` and `openai.com` have to be allowed in the session's network settings.
- `support.claude.com` was fetched directly for the release notes, web search, chat search and extended thinking articles.
- Competitor claims are documentation and press claims, not hands-on checks.

## The short version

Alevr's chat core is strong at failure handling. Dropped streams resume from a frame log, sends are retried safely across deploys, Auto fails over before the first byte, branches form a real tree, and long chats are virtualised and paged. On most of these Alevr is equal to or ahead of ChatGPT and Claude.

It is weakest at three things a person notices on every turn:

1. **The wait before the first word.** On the web, most ordinary messages wait for a separate LLM triage call (up to 3.5 s) before the chat request is even sent. The message bubble does not appear until that call returns. The server then runs about 13 pipeline stages one after another. Every few turns in a long chat, it can also wait up to 8 s for a history summary. None of the pre-send wait shows up in the server's own TTFT trace.
2. **How search answers cite.** Ordinary web-search answers cite as underlined markdown links. The ChatGPT-style inline pill, the hover card with the passage, and Alevr's claim-level citation audit (a real differentiator) only switch on for Deep Research.
3. **What the default answer reads like.** On a typical web turn the stable system prompt is about 8,000 tokens (estimate). About 85% of it is feature contracts: artifact JSON schemas, Live UI components, tasks, images, memory tags. There is no section on how to write a good everyday answer: length, formatting, citing, uncertainty. Live UI is told to appear "by default". No eval exercises the real prompt.

The 12 ranked improvements below fix these first. Most of them are small, because the infrastructure is already there.

---

## 1. Capability table

Legend: **missing**, **weaker**, **equal**, **ahead** (Alevr relative to the better of the two competitors). CG = ChatGPT, CL = Claude.

| # | Capability | ChatGPT | Claude | Alevr today (evidence) | Gap |
|---|---|---|---|---|---|
| 1 | Pre-send latency (Enter → request leaves) | Sends at once; asks in-band when needed (deep research asks scoping questions) [O3] | Sends at once | Web `send()` runs a **blocking LLM triage** `/api/chat/clarify` for any message over 8 characters without code or attachments, aborted at 3.5 s (`src/hooks/use-chat.ts:1809-1871`, timeout l.1830). The server triage budget is 2.8 s (`src/lib/preflight-triage.ts:35`), plus auth, rate limit, plan/budget reads and decryption of 6 messages (`src/app/api/chat/clarify/route.ts`). The user bubble is only added after it returns (`startGeneration`, `use-chat.ts:1632`). Native apps never call it (no `chat/clarify` in `native/`). | **weaker** |
| 2 | Server prep before the provider call | n/a (not published) | n/a | About 13 awaited stages, mostly in series (`src/app/api/chat/route.ts:79-337`): account, identity, model, tokens, accept, history, then memory∥project, skills, approvals, tools (MCP open, ≤5 s/server, 300 s list cache), semantic outlines, cross-conversation. `serverPrepMs`/`requestTtftMs` are logged, but per `docs/OPEN_DECISIONS.md:668-678` they are "Measured, not yet improved… Nothing in the pipeline was reordered". The trace starts at route entry (`route.ts:65`), so it misses item 1. | **weaker** (unmeasured end to end) |
| 3 | Long-chat compaction stall | n/a | "Infinite" chats: earlier messages summarised near the limit (24 Nov 2025) [C1] | Rolling summary exists (`src/lib/chat/history-compaction.ts`). It is recomputed **inline** when the window moves, waiting up to 8 s (`src/lib/chat/history-summary-store.ts:42,218-221`, called from `src/lib/chat/turn/history.ts:64`). The window moves every 8 messages once past 24 (`src/lib/chat/context-assembly.ts:18,30`). | **weaker** (periodic stall) |
| 4 | Answer starts while still thinking | GPT-6 "can begin answering while it continues to think"; Instant answers web-search questions "44% sooner" than GPT-5.6 Instant [O1][O2] | Thinking shown as a collapsible summary with a timer; answer follows [C4] | Reasoning streams and is shown live (`src/components/chat/thought-inline.tsx`, `src/lib/chat/reasoning-headline.ts`). The answer waits for thinking to end. "Answer now" exists only as a design mock (`src/app/dev/design/juno/states.tsx:76`). | **weaker** |
| 5 | Default thinking effort | Instant by default; user picks Medium/High/Extra High [O1] | Adaptive thinking with an effort setting [C4][C9] | Composer default is `reasoningEffort: "high"` (`src/components/app/app-provider.tsx:77`). It applies to every turn on an explicitly chosen reasoning model (`src/lib/chat/turn/model.ts:103-108`). Only Auto picks effort per message (`src/lib/auto-model.ts:321-349`). | **weaker** (slow "hi" on explicit models) |
| 6 | Streaming smoothness | Smooth (not documented) | Smooth (not documented) | Pacer releases text at the arrival rate, a word at a time, with a 280 ms ink-in fade through the CSS Highlight API (`src/lib/chat/stream-pacer.ts`, `src/components/chat/stream-text.tsx`). Half-formed tables, fences and headings are held back (`src/components/chat/markdown.tsx:201-247`). Benchmarked on 300 prose deltas: 0 long tasks (`docs/rework/program/PERFORMANCE.md:28,146-147`). | **ahead** |
| 7 | Render cost on large streamed blocks | n/a | n/a | `setCut` fires every animation frame (`stream-text.tsx:178`). Each frame re-splits the whole message (`markdown.tsx:1086`; `splitIntoBlocks` scans ahead with `lines.slice(i + 1).find` on every blank line, l.184, which is quadratic). It also re-parses and re-highlights the whole last block (`markdown.tsx:352,400`). A 400-line code fence or a 200-row table is re-highlighted 60×/s. Not benchmarked: the perf fixture is prose only. | **unmeasured risk** |
| 8 | Markdown, math, code | Rich rendering, runnable code in some tools | Rich rendering | GFM, KaTeX and highlight.js loaded lazily per block (`src/components/chat/markdown-plugins.ts`). `\(`/`\[` are normalised (`markdown.tsx:120`), currency is protected from maths (`markdown-currency.ts`), there is no language guessing (`detect: false`), demoted headings, wide tables scroll, fences carry filenames, and JS/TS/Python/SQL run in the browser (`code-run.tsx`, `CODE_RUN_RULE` `system-prompt.ts:123`). | **ahead** (code), **equal** (rest) |
| 9 | Inline citation display | Inline citations plus a Sources button/sidebar [O4] | "Every response includes citations… relevant quotes" [C3] | ChatGPT-style pill with a hover card exists (`src/components/chat/source-chip.tsx:284-310`). It only renders for numbered `[n]` with `cited` sources (`markdown.tsx:978`), and only Deep Research marks sources `cited` (`src/lib/chat/turn/research-stage.ts:106`). Ordinary search is forced to `citationsNumbered: false` (`src/lib/search/alevr/turn.ts:96-110`) and told to "cite them as markdown links" (`src/lib/chat/prompt-sections.ts:17`). These render as underlined primary-colour links (`globals.css:3387`). The Sources pill sits at the end (`message-item.tsx:1515`). | **weaker** |
| 10 | Claim-level citation check | no | no | Audit with contested/stale/rival detection (`src/lib/research/citation-audit-core.ts`), **only when sources are `cited`** (`src/components/chat/citation-audit.tsx:723`), so Deep Research only. | **ahead in research / missing in chat** |
| 11 | When to search | Model decides; GPT-6 "better at determining when a search is necessary" [O2] | "Claude searches the web when it helps" [C3] | Web search is on by default (`app-provider.tsx:77`) and the model decides (`WEB_DESCRIPTION`, `src/lib/tools/specs/web-search.ts:90`). | **equal** |
| 12 | Search rounds and depth | Faster search answers (see #4) [O2] | Multiple sources per search [C3] | 5 results by default, 8 at most, 300-character snippets (`web-search.ts:53-55`). Full page text is prefetched but kept out of the result (`src/lib/web/search.ts:186-208`), and the model is told to "open the 1 to 3 most relevant results with web_fetch before stating specifics" (`web-search.ts:90`, `prompt-sections.ts:17`). So a typical search answer takes at least 3 model calls: search, fetch, answer. | **weaker** (latency) |
| 13 | Freshness and ranking | Not documented | Not documented | BM25 + freshness half-life + host diversity (`src/lib/search/alevr/rank.ts:135-140`), `recency` arg, news vertical, page dates shown to the model (`web-search.ts:66-71`), query and page caches. | **equal / ahead** (infra) |
| 14 | Query rewriting | Not documented | Not documented | The model writes the queries; the description gives rules (2-8 words, broad then narrow, one query per compared item) (`web-search.ts:90`). There is query hygiene (DLP, private spans), but no rewriting. | **equal** |
| 15 | Auto routing | Auto/Instant/Thinking; complaints about losing a "true Auto" [O5] | No auto router; user picks the model | Expected-total-cost router with measured evidence and failover (`src/lib/router/decide.ts:1-31`). | **ahead** |
| 16 | Auto in a conversation | Not documented | n/a | Difficulty comes from regexes over **this message only** (`auto-model.ts:199`, `src/lib/router/task-class.ts:1-16`). A short follow-up ("why?", "now do it in Rust") after a hard turn is graded simple. There is no affinity to the previous turn's model (no sticky or cache term in `decide.ts`), so a lab switch loses the warm prompt cache for system plus history (up to 60k tokens, `history-compaction.ts:46`). | **weaker** |
| 17 | Edit and branch | Edit, version pager, branch in new chat [P1] | Edit with pager | Real tree with siblings and an active path (`src/lib/chat/branch-model.ts`), edit PATCH (`src/app/api/messages/[id]/route.ts`), fork (`src/app/api/conversations/[id]/fork`). | **equal** |
| 18 | Regenerate options | Try again, change model | Retry | Try again · Switch model · More concise · Add details (`src/components/chat/message-item.tsx:386-451`). | **equal / ahead** |
| 19 | Stop | yes | yes | `stop()` plus `/api/chat/cancel`; partial answer kept. | **equal** |
| 20 | Continue a cut-off answer | n/a | n/a | "Continue" only for `length`/`network_error` (`message-item.tsx:1141`). It **sends a visible user message** "Continue from where you left off." (`use-chat.ts:2488-2490`), which splits the answer across two bubbles and breaks a code block or table in the middle. Free is capped at 4,096 output tokens (`src/lib/plans.ts:71`). | **weaker** |
| 21 | Steer a running answer | "Update" a running GPT-5 Pro / deep research reply with new context, Nov 2025 (press) [P2] | Not documented | Messages typed during a turn are **queued** and sent after it ends (`use-chat.ts:1876-1897`). Only Research takes guidance at round boundaries (`src/lib/research/stages/workers.ts:549`). | **missing** |
| 22 | Edit an answer in place | Writing blocks (Canvas removed) [O6] | "Edit Claude's drafts in place": highlight and type the change (12 Jun 2026) [C1] | In an artifact: yes (`canvas-panel.tsx` selection Modify). In a chat answer, the selection bar has Ask, Quote, Explain, Copy but no edit (`src/components/chat/answer-selection-bar.tsx:17-24`). | **missing** |
| 23 | Long-chat rendering | Not documented | Users report sluggish very long chats [C5] | Virtualised after 24 rows (`src/hooks/use-transcript-window.ts:21,418`), paged history of 60 then 120 (`src/lib/chat/history-page.ts`), anchor-stable streaming, only the streaming row re-renders (`PERFORMANCE.md:165-170`). | **ahead** |
| 24 | Chat search | Unified search across chats, projects, images, documents, with filters (Jul 2026, press) [P3] | Ask Claude to search past chats (RAG tool calls, citations to the conversations) [C2] | Unified search across 8 sources: titles, bodies (blind-token index over encrypted text), projects, files, knowledge, artifacts, memory, Work (`src/app/api/search/route.ts`, `src/lib/search/index.ts`). Type, date and project filters (`command-palette.tsx:720-760`). Find in chat (`conversation-find.tsx`). The model can call `search_chats`. Keyword and stem matching only, no semantic recall. | **equal** (keyword) |
| 25 | Sidebar organisation | Projects, pinned chats, archive | Starred chats, projects (third-party) [P4] | Pinned chats lead Recent, pinned projects, "Needs you", archive with restore (`src/components/app/app-sidebar.tsx:597,872,1068-1075`). A `Folder` model and API exist (`prisma/schema.prisma:647`, `src/app/api/folders/route.ts`) but **nothing in the web UI uses them**. | **equal** (dead folder code) |
| 26 | Keyboard shortcuts | Cmd+/ sheet, Cmd+Shift+O, copy last reply (third-party) [P5] | Cmd+K search (third-party) [P4] | Global shortcuts (`src/hooks/use-global-shortcuts.ts`), sheet on Cmd+/ (`command-palette.tsx:1561-1570`), search palette. | **equal** |
| 27 | Errors and retry | Users report lost replies and "Resume stream unavailable" [P6] | n/a | One bounded retry before the first byte, with Auto moving to the next candidate (`src/lib/chat/turn/pre-stream-retry.ts`). Deploy-safe idempotent re-send (`src/lib/chat/send-retry.ts`). Error card offers "Answer with <model>" (`src/lib/chat/turn/failure-recovery.ts`). Request id in start failures (`route.ts:476-481`). | **ahead** |
| 28 | Offline and reconnect | Backgrounded tabs can lose the reply (press) [P6] | n/a | Generation continues on the server after a disconnect. The client reattaches from `?after=seq` with Tether backoff and shows "Waiting for network"/"Reconnecting in 4s" (`use-chat.ts:954-1035`, `src/components/chat/connection-status.tsx`). It resumes when a chat that was mid-generation is reopened (`use-chat.ts:1130`). | **ahead** |
| 29 | System prompt: answer craft | Characteristics (warmth, headers/lists, emoji) [O7]; default rich formatting | Styles: Concise/Formal/Explanatory/custom [C6] | Identity line plus "Reply intent" (BUILD / UNDERSTAND / ANSWER→"Plain prose") (`src/lib/chat/system-prompt.ts:270,286-291`). **No** guidance on length, when to use lists, tables or headers, maths delimiters, citation placement, dates for time-sensitive facts, uncertainty, or no openers/closers. Six presets, of which only "Concise" covers verbosity (`src/lib/personalities.ts`). | **weaker** |
| 30 | System prompt: size and focus | n/a | n/a | Measured with the real builder: about **8,031 tokens** of stable prompt on a typical web turn (32,124 characters ÷ 4, an estimate), plus search nudge and tool schemas. Canvas contract ≈3,055 tokens (JSON schemas for DESIGN/SPREADSHEET/DOCUMENT/PRESENTATION), Live UI ≈2,343, Tasks ≈610, Memory ≈528, untrusted rule ≈360, images ≈258, routines ≈228. All of it is sent on "hi". | **weaker** (attention, prefill) |
| 31 | Tool-use policy | n/a | n/a | Careful and explicit: only real tools are mentioned (`prompt-sections.ts:144-146`), conservative task hand-off (`system-prompt.ts:226-245`), untrusted-content rule, code-run honesty (`prompt-sections.ts:65-82`). Live UI is told "reach for one by default" (`system-prompt.ts:155`). | **equal** (policy), **risk** (Live UI overuse) |
| 32 | Turning visuals down | Settings → Personalization → Layout and visuals → Simple [O8] | n/a | No setting (no `liveUi`/visuals field in `prisma/schema.prisma` or `src/components/settings/sections/`). | **missing** |
| 33 | Evaluating everyday answers | n/a | n/a | `npm run eval:juno` makes single calls with its own system prompt, "You are a careful assistant…" (`scripts/eval-juno.ts:36`), and checks format compliance (`src/lib/eval/suite.ts:166-230`). The product's composed prompt is never evaluated, and there is no pairwise judge against ChatGPT or Claude outputs. The workflow bench grades deliverables, not chat answers (`docs/quality/WORKFLOW_BENCHMARK.md`). | **missing** (enabler) |
| 34 | Client-side TTFT metric | n/a | n/a | No client metric from Enter to the first visible character (no `firstToken`/`performance.mark` in `use-chat.ts`/`chat-view.tsx`). | **missing** |

Alevr is equal or ahead, with no action needed in this area: streaming pacing, resume and reconnect, deploy-safe sends, pre-stream failover, branching tree, regenerate menu, virtualisation and paging, unified search breadth, code rendering and in-browser run, reasoning trace (inline plus full panel with "Thought for Ns", `activity-timeline.tsx:361`), Auto's cost model, and search ranking infrastructure.

---

## 2. Ranked improvements

The ranking puts what a person feels on the most turns first, then how cheap it is given what exists. Each item notes overlap with the cost workstream (task 18) or the parallel builds.

### CC-1. Instant send: no blocking triage before ordinary answers

- **User-visible outcome.** Press Enter and the message appears in the transcript at once (within 100 ms), and the answer starts without a "Checking…" pause. Ordinary turns get 0.5-3.5 s back (estimate: triage is a non-streamed JSON call to a fast model with a 2.0 s first-attempt budget). When a question really blocks a good answer, the model asks in-band with the `choices` view the web already draws.
- **Competitor evidence.** Neither ChatGPT nor Claude puts a separate model call in front of an ordinary send. ChatGPT asks scoping questions only for deep research [O3]. Its GPT-6 launch is framed as speed, with search answers starting 44% sooner [O2]. Alevr's own native apps never call the triage (no `chat/clarify` in `native/`), so web is the slow client.
- **Current code.** `src/hooks/use-chat.ts:1809-1871` (blocking fetch, 3.5 s abort), `src/lib/preflight-clarification.ts:86-112` (`quickPreflightSkip` skips only ≤8 characters, maths, code, attachments, >2,000 characters, "just answer"), `src/app/api/chat/clarify/route.ts` (rate limit, plan, budget, decrypting 6 messages), `src/lib/preflight-triage.ts:35-36`. In-band alternative already taught: `LIVE_UI_DO_SECTION` "choices" (`src/lib/chat/system-prompt.ts:195`).
- **Implementation sketch.**
  1. In `send()`, take the triage path only for `deepResearch` (scoping stays, it saves a multi-minute run). Every other send goes straight to `startGeneration`. Keep the code behind `CHAT_PREFLIGHT_MODE = off | research | all` (server env exposed through client features), defaulting to `research`.
  2. In the system prompt, sharpen the in-band rule (one line in "Reply intent"): "If one missing detail would change the whole answer, ask one short question with a `choices` view and give what you can meanwhile; otherwise state your assumption in one clause and answer."
  3. Keep `/api/chat/clarify` for research and for a later opt-in ("Ask me before answering" in the composer `+` menu, if the owner wants it).
- **Acceptance tests.**
  - Playwright: type "what should I cook tonight with leeks and eggs" and press Enter. The user bubble is in the DOM within 100 ms, there is no request to `/api/chat/clarify`, and `/api/chat` is requested within 50 ms.
  - The same with Deep Research armed still calls `/api/chat/clarify` and can show the scoping card.
  - The unit test for `send()` routing covers modes `off`, `research` and `all`.
  - Eval (CC-8): on 30 ambiguous prompts ("plan my trip"), the model asks via `choices` or states an assumption in at least 90% of cases and never asks for something it could infer.
- **Size** S. **Impact** H. **Risks:** losing a few good clarifications on vague prompts. This is mitigated by the in-band rule and measured by the CC-8 ambiguity set. It also removes one model call per message, which helps the cost workstream.

### CC-2. TTFT pipeline: measure Enter to first word, stream first, prepare in parallel, never block on compaction

- **User-visible outcome.** The first sign of life (title, then "Reading 2 files…" or reasoning) arrives within about 250 ms of the request. Long chats never pause every fourth reply. The owner sees real Enter-to-first-word p50/p95 in `/admin/turns`.
- **Competitor evidence.** GPT-6 is marketed on time to first response [O2]. Claude made long chats "infinite" through compaction without a visible pause [C1].
- **Current code.** Serial stages at `src/app/api/chat/route.ts:79-337`. The trace starts at `route.ts:65`. "Measured, not yet improved" is recorded at `docs/OPEN_DECISIONS.md:668-678`. Memory waits for history only to read the latest user message (`route.ts:152`), which `input.message` already holds on a normal send. Inline compaction waits up to 8 s (`history-summary-store.ts:42,170-245`; `turn/history.ts:64`). MCP open is budgeted at 5 s per server (`OPEN_DECISIONS.md` §15).
- **Implementation sketch.**
  1. **Measure first (S).** The client stamps `performance.now()` at Enter, then at the first `meta` frame, the first reasoning delta and the first visible text character. It posts `{sendToMetaMs, sendToFirstTokenMs, sendToFirstTextMs, preflightMs}` with the generation id to a new `POST /api/chat/receipt` field. The route already exists (`src/app/api/chat/receipt`). These join `TurnTrace.latency` (`src/lib/chat/turn/trace.ts:60-81`) and the `/admin/turns` percentiles.
  2. **Stream first (M).** Right after `acceptTurn` (the user message and receipt are durable), return the SSE `Response` and send `meta`. Move `resolveHistory … composeTurnSystem` into an async `prepare()` awaited inside `runTurn`'s stream start. Emit one `activity` row only if prep passes 400 ms ("Reading project files", "Connecting Linear"). Stall watchdog and budget guard start as today.
  3. **Parallelise (S-M).** Run `resolveAccount ∥ resolveAssistantIdentity`. Run `resolveHistory ∥ resolveMemory(latest = input.message unless regenerate) ∥ open MCP toolset early` (the connector list is known after `resolveTurnTokens`). Run `semanticArtifactContext ∥ resolveCrossConversation ∥ resolveTools`. Keep the ordering contracts in `tests/chat-turn-pipeline.integration.test.ts`.
  4. **Background compaction (S).** In `finalizeOutputs`, if `planHistorySummary` says the next turn's window will move, write the summary then (after the reply, off the critical path). In the turn, cap the wait at 300 ms. On a miss, use the stored summary and keep one extra `HISTORY_STEP` verbatim (a slightly larger prompt for one turn) instead of waiting.
- **Acceptance tests.**
  - Integration test with a fake provider and fixture DB: `serverPrepMs` p50 ≤ 250 ms and p95 ≤ 900 ms on a no-connector turn. `meta` frame before any history read completes (ordering assertion).
  - Long-chat fixture (60 messages): no turn's `serverPrepMs` includes summariser time. The summary row is written by the previous turn's `after()`.
  - `/admin/turns` shows the new client fields. A turn without a receipt shows "—", not 0.
- **Size** M. **Impact** H. **Risks:** reordering touches a pipeline with many invariants (skill narrowing, taint, approvals). Do it stage by stage behind the integration test. A turn that fails during `prepare()` must now end with an `error` frame instead of a JSON 500. The client already handles both, but check `DurableFirstSubmissionStartError` (`route.ts:453-462`).

### CC-3. Inline citations on every search answer (pills, hover passage, audit)

- **User-visible outcome.** Every web-backed sentence ends in a small site-name pill ("nature", "gov.uk"). Hover shows title, passage and date. The Sources pill lists exactly what was cited. The existing claim check ("supported / contested / stale") becomes available on ordinary search answers, not only Deep Research. Native apps show the same pills.
- **Competitor evidence.** ChatGPT search shows inline citations plus a Sources button and sidebar [O4]. Claude: "Every response includes citations… direct citations, source links, and relevant quotes" [C3]. Neither offers claim-level verification, which Alevr already has.
- **Current code.** Pill and hover card: `src/components/chat/source-chip.tsx:284-330`. The pill is gated on `cited` (`markdown.tsx:978`). The chat path is forced to links (`src/lib/search/alevr/turn.ts:96-110`, `citationsNumbered: false`). Link instruction: `prompt-sections.ts:17`, `web-search.prompt.ts` `CITE_LINKS_LINE`. The numbered path already exists (`numberedResult`, `citeNumberedLine`, `web-search.ts:195-213`). Audit gate: `citation-audit.tsx:723`. Provider-native fallbacks carry annotations with positions (`src/lib/llm/responses-loop.ts:362`, `src/lib/meta-web-search.ts:84-98`, `src/lib/hosted-web-search.ts`).
- **Implementation sketch.**
  1. One registry per turn. Pass the route accumulator's `SourceRegistry` into `createAlevrSearchTurn` instead of a private one (`turn.ts:99`), so the `[n]` the model sees is the index in the persisted `Message.sources` (SPEC §2.11).
  2. Set `citationsNumbered: true` and register with `cited: true`. Change the nudge to "cite as [n] directly after the claim it supports; one to three per claim; never cite a source you did not use".
  3. Provider-native search (the fallback): convert `url_citation` annotations (start and end index) into `[n]` markers in the accumulator as text is written, and mark those sources `cited`.
  4. Client fallback for old messages and any stray link: in `markdown.tsx:1008`, when an `<a href>` matches a message source URL, render `SourceChip` instead of a body link.
  5. Audit cost control: on chat answers run the deterministic tiers only (free, already in `citation-audit-core.ts`). The judge model runs when the reader opens "Check sources".
  6. Native: `SourcesPill.swift`/`MessageRow.swift` render `[n]` as a chip (follow-up for the native team).
- **Acceptance tests.**
  - Unit: a search turn's `[3]` resolves to `Message.sources[2]` after persist and reload.
  - Playwright: a search answer renders ≥1 `.cite-pill`, and hover shows the snippet. No `<a>` to a cited URL renders as a body link.
  - Eval (CC-8 search set): ≥95% of factual sentences in search answers carry a citation, and 0 citations point outside the corpus (the existing `UNRESOLVED CITATIONS` check).
  - Old messages with markdown links render as pills.
- **Size** S-M. **Impact** H. **Risks:** models that over-cite and clutter the prose (cap at 3 per sentence in the prompt; render a run of adjacent markers as one pill, "nature +2"). An off-by-one between registries is caught by the persist and reload unit test. Pills styling follows the redesign.

### CC-4. An answer-craft contract, with feature contracts loaded only when needed

- **User-visible outcome.** Answers lead with the point and size themselves to the question. Short questions get short answers. They use lists for steps, a table only for real comparisons, headings only in long answers, and no "Great question!" and no closing offer to help. Time-sensitive facts carry a date. Uncertainty is said plainly. Interactive views appear when they help, not by habit, and a "Simple" visuals setting turns them down.
- **Competitor evidence.** ChatGPT has Characteristics (headers/lists, emoji, warmth) [O7] and a Layout and visuals → Simple setting [O8]. Claude has Styles (Concise, Formal, Explanatory, custom) [C6]. Both ship opinionated default formatting. Alevr's tone sliders are being built in parallel. This item is the default they adjust.
- **Current code.** `src/lib/chat/system-prompt.ts:269-291` (identity + intent only). Live UI "reach for one by default" (l.155). Canvas schemas of about 3,055 tokens (l.295-383). Live UI about 2,343 tokens (l.154-203). Measured with `scratchpad/depth/scripts/prompt-size.ts`: about 8,031 tokens stable per web turn. Presets: `src/lib/personalities.ts`.
- **Implementation sketch.**
  1. Add `ANSWER_CRAFT_SECTION`, about 350 tokens, constant (cache-stable), right after the identity line:
     - Length: lead with the answer; match the question's size.
     - Formatting:
       - Prose for conversation.
       - Numbered list for sequences.
       - Table when there are at least 3 items × 2 attributes.
       - Headings only above about 300 words.
       - Bold for at most a few key terms.
     - Maths in `$…$`/`$$…$$`.
     - Code always fenced with a language.
     - Citations: per CC-3, plus a date on time-sensitive facts; where sources disagree, say so.
     - Honesty:
       - Separate what you know from what you infer.
       - Never invent URLs or numbers.
       - Say when you could not verify.
     - Voice:
       - No openers that praise the question.
       - No closing offers.
       - At most one follow-up question.
     - Language: the user's own.
  2. Progressive disclosure. Replace the full DESIGN/SPREADSHEET/DOCUMENT/PRESENTATION JSON schemas and the Live UI component catalogue in the stable tier with a short index (about 400 tokens: the types, when to use each, one tiny example). Load the full schema in either of two ways:
     - (a) A `read_format_guide({kind})` tool the model calls before writing that artifact or view. It is cheap, cached per kind, and acts as a tool round only when needed.
     - (b) The existing intent detectors (`detectBackgroundWork`, `detectImageIntent` in `turn/prompt.ts:151-188`), extended with an artifact/Live UI intent, which append the relevant schema to the system prompt for that turn.
     Start with (b) for the semantic schemas. Keep the base Live UI contract until CC-8 shows parity.
  3. Calibrate Live UI: "Use a view when the reader will change a number, compare 3+ options, follow steps, or practise; otherwise prose." Remove "by default".
  4. Add `Settings.answerVisuals = "rich" | "simple"` (Prisma column, settings section, `/api/v1` field for native). `simple` drops `LIVE_UI_DO_SECTION` and adds "use a view only when asked".
- **Acceptance tests.**
  - `buildSystemPromptSections` snapshot: stable tier ≤ 4,000 tokens on a typical web turn and byte-identical across users with the same toggles (the cache invariant).
  - CC-8 everyday set: pairwise win or tie ≥ 55% against the current prompt. Median answer length on the "short question" subset falls by at least 30%. Artifact and Live UI format validity is unchanged (existing validators) on the artifact subset.
  - `answerVisuals=simple`: 0 `live-ui` fences on the everyday set.
- **Size** M. **Impact** H. **Risks:** progressive disclosure can make artifacts worse if the detector misses. Run (b) behind a flag and A/B with CC-8. Tone sliders (built in parallel) must append after this section so a user setting wins. This also lowers prefill and cache-read cost, which helps the cost workstream.

### CC-5. One-round search answers: passages in the results

- **User-visible outcome.** Most "what's the latest…" answers start after one search instead of search → open page → answer. That cuts one or two model rounds per search turn: estimated −1 to −4 s and fewer tokens re-sent per round.
- **Competitor evidence.** GPT-6 Instant answers web-search questions "44% sooner" [O2]. Claude "processes multiple sources before responding" in one visible step [C3].
- **Current code.** 300-character snippets (`web-search.ts:55`). Raw page text is held back in the prefetch (`src/lib/web/search.ts:186-208`). The prompt mandates `web_fetch` "before stating specifics" (`web-search.ts:90`, `prompt-sections.ts:17`). The passage finder already exists (`src/lib/search/alevr/find.ts`, BM25 `passagesOf`).
- **Implementation sketch.**
  1. In `toChatResults`, for the top 3 results with prefetched text, rank `passagesOf(text)` against the query with `bm25Scores` and attach the best passage (≤600 characters, with its offset) to the result line, inside the existing untrusted envelope (`wrapUntrusted`, `web-search.ts:212`).
  2. Reword: "Each result may include its most relevant passage. Answer from passages when they state the fact; open a page with web_fetch only when the passage is cut off, the claim needs context, or the user asked about that page."
  3. Track `searchRounds` and `fetchesPerSearch` in the turn trace.
- **Acceptance tests.**
  - Unit: a search result with prefetch carries a passage containing the query terms, and the output stays inside `<<<…>>>` markers.
  - Live eval (CC-8 search set, 40 fresh-fact prompts): median model rounds per search answer ≤ 2 (from ≥ 3), citation accuracy not lower (audit verdicts), freshness check passes.
  - Injection fixture: a passage containing instructions does not change behaviour (the existing taint tests extended).
- **Size** S-M. **Impact** H. **Risks:** about 1.5k more tokens per search result list. That is net cheaper than a round, which re-sends the whole context. Passages carry a little more injection surface; they sit in the same envelope as snippets.

### CC-6. Adaptive thinking for explicit models, plus "Answer now"

- **User-visible outcome.** On an explicitly chosen reasoning model, "hi" and "thanks" answer instantly, while hard prompts still think. While a model thinks, an "Answer now" link ends the thinking and writes the answer from what it has.
- **Competitor evidence.** ChatGPT: Instant by default with levels to choose, and GPT-6 starts answering while thinking [O1]. Claude: adaptive thinking with an effort parameter [C9]. Gemini ships "Answer Now" (press, not a direct competitor) [P7].
- **Current code.** Default `reasoningEffort: "high"` (`src/components/app/app-provider.tsx:77`), passed through for explicit models (`turn/model.ts:103-108`). The per-message effort picker exists but serves Auto only (`auto-model.ts:321-349`). The slider is `reasoning-slider.tsx`.
- **Implementation sketch.**
  1. Add an `"auto"` effort value, the new default, for explicit models. The server maps it with `pickAutoReasoningEffort(model, classifyPromptComplexity(message + CC-7 carry-over))`. A user who moves the slider pins that level, as today.
  2. On models with native adaptive thinking (Claude), send adaptive thinking with the matching effort instead of a fixed budget.
  3. "Answer now": a link in the live reasoning row. It calls `POST /api/chat/cancel` with `{mode: "finish"}`. Where the provider supports it, the loop ends the reasoning stream and issues a final no-thinking call with the reasoning so far as a note (reuses `requestFinal` in `src/lib/llm/loop.ts`). Otherwise it is a no-op and the link is not shown.
- **Acceptance tests.**
  - Unit: effort `"auto"` + "hi" → `null` or the lowest tier. A hard proof prompt → `high`/`max`. A pinned slider is honoured.
  - Live: TTFT p50 on the everyday set with an explicit thinking model falls by ≥40% against `high` (trace `ttftMs`).
  - "Answer now" during reasoning produces a complete answer within 5 s and a `finishReason` that records it.
- **Size** M. **Impact** H (speed on every explicit-model turn). **Risks:** under-thinking a deceptively short hard prompt. Mitigations: CC-7 carry-over, "Think harder" in the regenerate menu, and CC-8 reasoning set. This overlaps with the cost workstream: it saves reasoning tokens.

### CC-7. Auto that remembers the conversation: follow-up difficulty and cache affinity

- **User-visible outcome.** After a hard question, "why?" or "now in Rust" stays on a model and depth that can answer it. Auto stops hopping labs mid-thread, which keeps one voice and lets the warm prompt cache make replies start faster.
- **Competitor evidence.** ChatGPT users explicitly ask for a "true Auto" that keeps choosing model and effort well [O5].
- **Current code.** Message-only regex grading (`auto-model.ts:199`; `router/task-class.ts:1-16`, "regexes over the prompt"). No previous-model term in `router/decide.ts`. `Message.model` is persisted (`prisma/schema.prisma`, Message `model`).
- **Implementation sketch.**
  1. Pass `previous: {modelId, taskClass, complexity, at}` (from the last assistant row on the active path) into `RouteInput`. For messages under 120 characters that read as follow-ups (anaphora, imperative edits, "why/how come/and", or no new nouns), complexity = max(own, previous − 1 level), and taskClass inherits.
  2. Add a cache-affinity credit to `expected_total`. If `previous.modelId` is a candidate and `now − at` < the provider's cache TTL, subtract `(cachedPrefixTokens × (input_price − cache_read_price))` and the latency gain from prefill.
  3. Show it in the routing receipt: "Kept on <model> to continue the thread".
- **Acceptance tests.**
  - Router unit tests: the follow-up "why?" after an `expert` coding turn routes at least `hard`; a new unrelated short question does not inherit; affinity flips a near-tie toward the previous model but never overrides a hard filter.
  - The router eval (`evaluateRouter`, `src/lib/eval/runner.ts:286`) gains 10 two-turn cases.
- **Size** M. **Impact** M. **Risks:** a stale inheritance that over-spends. Bound it to the last turn and a 30-minute window. This overlaps with the cost workstream (cache reads).

### CC-8. An everyday-answer eval on the real prompt, scored against ChatGPT and Claude

- **User-visible outcome.** Indirect. Every prompt and routing change above ships with evidence that answers got better, not just different.
- **Competitor evidence.** This is how the competitors' own changes are framed (OpenAI claims faster search answers and better source use [O2]). Without it, Alevr can only assert parity.
- **Current code.** `scripts/eval-juno.ts:36` uses a generic system prompt; `src/lib/eval/suite.ts` checks format compliance. The workflow bench can already import competitor outputs (`docs/quality/WORKFLOW_BENCHMARK.md:14-21`).
- **Implementation sketch.**
  1. `bench/answers/`: about 150 frozen prompts in sets. *Short* (40), *how-to* (25), *compare* (20), *fresh facts with search* (40), *ambiguous* (15, for CC-1), *follow-up pairs* (10, for CC-7).
  2. A runner that builds the **real** composed prompt through `composeTurnSystem` with fixture settings (no DB) and calls `streamChat`.
  3. `prepare/import --product chatgpt|claude` like the workflow bench, for answers a person copies.
  4. Graders:
     - Deterministic: length, list/table/heading use, citation presence and resolution, banned openers.
     - A pairwise LLM judge with position swapping and a rubric (correct, direct, well formatted, cites, honest), on a fixed judge model.
  5. Report per set: win/tie/loss, median tokens, rounds, TTFT.
- **Acceptance tests.**
  - `npm run bench:answers -- run --mock` passes offline with authored outputs.
  - The live run writes `bench/answers/results/<id>/report.md` with per-set win rates.
  - Changing `ANSWER_CRAFT_SECTION` changes the prompt hash in the report.
- **Size** M. **Impact** H (enabler for CC-1, CC-3 to CC-7). **Risks:** judge bias. Use position swap, a fixed judge, and a held-out set. If the repository becomes public, the frozen prompts are contaminated (same caveat as the workflow bench).

### CC-9. Edit an answer in place

- **User-visible outcome.** Select a sentence or paragraph of a reply (a drafted email, a cover letter) and choose **Rewrite**. Type "warmer" or "mention the deadline". Only that span changes, as a new version of the same answer with the change highlighted. The version pager lets the reader go back.
- **Competitor evidence.** Claude: "Edit Claude's drafts in place: highlight the text you want changed and type the change" (12 Jun 2026) [C1]. ChatGPT replaced Canvas with in-chat writing blocks [O6].
- **Current code.** Selection bar actions are Ask, Quote, Explain, Copy (`src/components/chat/answer-selection-bar.tsx:17-24`, `src/lib/answer-selection.ts`). Answer versions already exist (`src/app/api/messages/[id]/versions`). An exact-patch protocol exists for artifacts (`src/lib/artifact-edit.ts` `parseArtifactPatch`/`applyArtifactPatch`, `SELECTION_ANCHOR_NUDGE` in `prompt-sections.ts:84`).
- **Implementation sketch.**
  1. Add a **Rewrite** action with an inline field.
  2. `POST /api/messages/[id]/rewrite {start, end, instruction}` (offsets from the existing source-offset attributes, `markdown.tsx:696-720`) runs a small turn: the system prompt plus "replace ONLY this span; return the replacement text", on the conversation's model at low effort.
  3. The server splices it in, saves a new version (`MessageVersion` path) and returns the diff range.
  4. The client highlights the changed range for 2 s.
  5. Billing and taint as a normal turn.
- **Acceptance tests.**
  - Unit: the splice keeps every byte outside `[start, end)`.
  - Playwright: select the second paragraph, Rewrite "shorter". The first and third paragraphs are identical, the pager shows 2/2, and Undo returns to 1/2.
  - The rewrite of a span that contains a code fence keeps the fence balanced.
- **Size** M. **Impact** M (high for writing tasks). **Risks:** offsets drift after normalisation. Use the existing source-offset map, which is exact per block. It is also needed natively later.

### CC-10. Seamless Continue in the same bubble

- **User-visible outcome.** When an answer hits the length cap, **Continue** carries on inside the same bubble. A half-written code block or table closes correctly, and no "Continue from where you left off." message appears in the transcript.
- **Competitor evidence.** Neither competitor documents this in 2026. It matters more for Alevr because Free is capped at 4,096 output tokens.
- **Current code.** `use-chat.ts:2488-2490` (visible user message), `message-item.tsx:1141,1486`, `src/lib/plans.ts:71`.
- **Implementation sketch.**
  1. `regenerate` gains `mode: "continue"` with `regenerateMessageId`. The server sends history plus the partial assistant text, as an assistant prefill where the provider supports it (Anthropic) or as the last assistant message plus a hidden instruction ("continue exactly where this stops; do not repeat").
  2. The new text is appended to the same `Message` row, saved as a new version of it. The client applies deltas to the existing bubble.
  3. Fence and table state from `closeDangling` (`markdown.tsx:228`) decides whether the continuation must reopen a fence.
- **Acceptance tests.**
  - Fixture: an answer cut inside a ```ts fence. Continue gives one bubble with one balanced fence and no duplicated last line (overlap check ≤ 1 line).
  - No user message is persisted.
  - The usage receipt shows the continuation as its own spend.
- **Size** S-M. **Impact** M. **Risks:** duplicated text at the seam. Trim the longest suffix/prefix overlap before appending.

### CC-11. Steer a running answer

- **User-visible outcome.** While Alevr is searching or thinking on a long turn, the reader can type "focus on EU prices only" and press **Update**. The note reaches the model at the next round and the answer bends to it, without stopping or starting over. Short replies still queue as today.
- **Competitor evidence.** ChatGPT "Update" adds context to a running GPT-5 Pro / deep research reply (press, Nov 2025) [P2]. Claude's chat does not document it.
- **Current code.** The queue sends after the turn ends (`use-chat.ts:1876-1897`). Research takes guidance at round boundaries (`src/lib/research/stages/workers.ts:549`). The chat tool loop has round boundaries (`src/lib/llm/loop.ts`, `roundBudgetFor`).
- **Implementation sketch.**
  1. `POST /api/chat/steer {generationId, text}` writes to the generation registry (`src/lib/chat/generation-registry.ts`).
  2. The loop checks it between rounds. If present, it appends a user-role note "The user added while you worked: …" (fenced, the user's own words) before the next request and emits an `activity` row "Your note was added".
  3. Persist it as a USER message flagged `steer` (rendered small, inline in the run) so history and branches stay truthful.
  4. On single-round turns with no boundary left, fall back to queueing.
- **Acceptance tests.**
  - Fake provider, 3-round turn: a steer posted during round 1 appears in round 2's request messages, and the transcript shows the steer row. With no rounds left it is queued.
  - Private chats: same behaviour, nothing persisted.
- **Size** M. **Impact** M. **Risks:** it breaks prompt-cache continuity mid-turn (one extra uncached segment only). Approval and taint rules apply to the note as user text, not as untrusted content.

### CC-12. Bound streaming render cost for big code fences and tables

- **User-visible outcome.** Long code answers and wide tables stream as smoothly as prose on a mid-range laptop and phone, with no stutter once a fence passes a few hundred lines.
- **Competitor evidence.** Claude users report sluggish rendering in very long chats [C5]. Alevr already leads on prose streaming and should hold that lead on code-heavy answers.
- **Current code.**
  - Per-frame `setCut` (`stream-text.tsx:178`).
  - Whole-message `splitIntoBlocks` per render (`markdown.tsx:1086`), with an O(lines²) look-ahead (l.184).
  - Full last-block re-parse and highlight (`markdown.tsx:352,400`).
  - The perf benchmark is prose only (`PERFORMANCE.md:28`).
- **Implementation sketch.**
  1. Make `splitIntoBlocks` incremental: memoise on the previous content prefix and re-split only from the last block's offset, and precompute the next non-blank line index in one backward pass.
  2. Inside an open fence while streaming, split the code into settled lines (highlighted once, memoised by line index) plus the live last line (plain until the newline).
  3. Throttle the re-parse of a last block over 4 kB to 20 Hz while the pacer still runs at 60 Hz for the text cut.
  4. Add a perf scenario to `scripts/perf`: a 600-line TypeScript fence and a 150-row table streamed in 25 ms deltas.
- **Acceptance tests.**
  - New perf scenario: 0 long tasks over 50 ms locally and ≤2 at CPU ×4, and main-thread script time within 1.5× of the prose scenario.
  - Visual snapshot: the highlighted output is identical to the non-incremental path after the stream ends.
- **Size** S-M. **Impact** M. **Risks:** highlight-state bugs at line boundaries inside multi-line strings and comments. Settle highlighting per line only when the grammar state at the line end is the same as in a full pass. Otherwise re-highlight the fence at most every 250 ms.

### Also noted (small, not ranked)

- **Folders are dead code on the web.** The `Folder` model and `/api/folders` exist, but no component uses them. Either delete them or decide that projects are folders. Not a user gap: projects and pins cover it, as at Claude.
- **Semantic chat search.** The blind-token index is keyword and stem only (`src/lib/recall/index-core.ts`). An optional embedding pass over titles and summaries (not bodies, to keep the encryption model) would find "that chat about my landlord". M size; check the privacy model first.
- **Table actions.** Markdown tables have no copy or export action (only `data-table-block.tsx` offers CSV). Add Copy (TSV/Markdown) and Download CSV on hover. S.

---

## 3. Suggested order

1. CC-1 (S), the measurement half of CC-2 (S), and CC-8 (M) in the first sprint. These remove the largest felt delay and give the yardstick for the rest.
2. CC-3, CC-5 and CC-4 next. Search answers become cited and one-round, and the default voice changes, all measured with CC-8.
3. The rest of CC-2, then CC-6 and CC-7 (speed and Auto).
4. CC-9 to CC-12 as polish and depth.

Cross-workstream notes:
- CC-1, CC-4, CC-5, CC-6 and CC-7 also cut API spend (fewer calls, smaller prompts, fewer rounds, fewer reasoning tokens, more cache hits). Share the numbers with the cost workstream.
- CC-4 defines the defaults that the parallel tone-slider work adjusts.
- CC-3 and CC-9 need small UI pieces (pill run, Rewrite field) that the redesign should style.

---

## Sources

OpenAI. Fetch blocked; claims are from search excerpts of official pages unless marked press:
- [O1] GPT-6 and other models in ChatGPT: https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt (thinking levels Instant/Medium/High/Extra High; a response may begin while thinking continues)
- [O2] GPT-6 for everyone: https://openai.com/index/gpt-6-for-everyone/ (interleaved thinking and answering; "44% sooner" on web-search questions, via press excerpts of the launch, e.g. https://www.fonearena.com/blog/494446/openai-gpt-6-features.html/amp and https://www.searchenginejournal.com/chatgpt-gpt-6-intelligent-ui/592249/)
- [O3] Deep research in ChatGPT: https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt (scoping questions; cited in the parity matrix)
- [O4] ChatGPT search, inline citations plus Sources button (secondary reports of OpenAI's description): https://www.seroundtable.com/chatgpt-search-38337.html, https://geotoolbox.ai/blog/chatgpt-citations
- [O5] Community request for a "true Auto" mode: https://community.openai.com/t/bring-back-a-true-auto-mode-let-chatgpt-choose-the-model-and-reasoning-effort/1388693
- [O6] Model release notes (Canvas removed in favour of writing blocks): https://help.openai.com/en/articles/9624314-model-release-notes
- [O7] Characteristics in ChatGPT: https://help.openai.com/en/articles/20001038-characteristics-in-chatgpt
- [O8] Intelligent UI in ChatGPT (Layout and visuals → Simple): https://help.openai.com/en/articles/20001598-intelligent-ui-in-chatgpt

Anthropic, fetched directly:
- [C1] Claude release notes: https://support.claude.com/en/articles/12138966-release-notes (24 Nov 2025 infinite conversations through summarisation; 12 Jun 2026 edit drafts in place; 12 Mar 2026 inline charts; 11 Aug 2025 search past chats)
- [C2] Chat search and memory: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- [C3] Enabling and using web search: https://support.claude.com/en/articles/10684626-enabling-and-using-web-search
- [C4] Using extended thinking (collapsible thinking summary with timer): https://support.claude.com/en/articles/10574485
- [C5] Long-chat rendering complaint (Reddit snapshot quoting the help centre): https://reddit.sentinel-team.org/posts/1rjh9m1/snapshots/2026-03-04T15%3A12%3A56.583662Z
- [C6] Configuring and using styles: https://support.claude.com/en/articles/10181068
- [C9] Adaptive thinking and effort (platform docs): https://platform.claude.com/docs/en/build-with-claude/extended-thinking

Press and secondary (lower confidence):
- [P1] ChatGPT branch conversations: https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-has-added-a-great-new-feature-and-its-one-i-know-ill-be-using-a-lot, https://bgr.com/1959993/chatgpt-branch-conversations-new-feature-now-available/
- [P2] ChatGPT mid-response "Update": https://alternativeto.net/news/2025/11/chatgpt-now-lets-users-add-context-to-live-queries-without-restarting/, https://www.techradar.com/ai-platforms-assistants/chatgpt/you-can-now-interrupt-chatgpt-as-it-learns-to-take-feedback-on-the-fly
- [P3] ChatGPT unified search (Jul 2026): https://www.digitaltrends.com/computing/chatgpts-new-search-tool-saves-you-from-digging-through-old-chats-files-and-images/, https://www.notebookcheck.net/ChatGPT-New-search-finds-your-old-chats-images-and-documents.1344318.0.html
- [P4] Claude starred chats and shortcuts (third-party guides): https://www.guideflow.com/tutorial/how-to-star-a-chat-from-the-sidebar-in-claudeai, https://claudeimplementation.pages.dev/blog/claude-keyboard-shortcuts
- [P5] ChatGPT keyboard shortcuts (third-party): https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-keyboard-shortcuts-guide
- [P6] ChatGPT lost responses on background tabs / "Resume stream unavailable": https://superchargebrowser-website.pages.dev/library/fix-chatgpt-network-error-chrome-background/, https://smartscope.blog/en/blog/chatgpt-resume-stream-unavailable-2026/
- [P7] Gemini "Answer Now": https://www.storyboard18.com/amp/how-it-works/google-adds-answer-now-button-to-gemini-for-faster-ai-responses-87863.htm
