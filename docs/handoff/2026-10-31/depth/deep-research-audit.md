# Deep Research: depth and quality audit (Alevr vs ChatGPT deep research vs Claude Research)

Date: 2026-10-31. Repo: `/home/user/juno` (read-only, static reading; nothing was run against providers). Scope: capability, behaviour, quality, speed, cost. UI only where a feature needs new UI. Features already being built in parallel are not re-specified here: share with people, per-chat memory off, AI artifacts, PDF/Google Docs/Slides export, locked chats, Drive/OneDrive attach in composer, connectors in voice, tone sliders, MCP Apps widgets, plugins.

**Bottom line.** Alevr's research engine is already deeper than both competitors in three places: (1) a claim-level citation audit that shows the passage it checked; (2) live progress you can steer (guide, pause, finish now) with interim answers; (3) durable leases with recovery floors. The gaps users will notice are elsewhere:
- **Sources.** Of the person's connected apps, Research can read only Apple Calendar and Apple Mail. Gmail, Drive, Google Calendar, Outlook, OneDrive/SharePoint, Slack, Notion, GitHub and custom MCP servers are all connected in Alevr, but none of them can be a research source. ChatGPT and Claude both treat connected apps as sources.
- **Report shape.** Every report is forced into a product-comparison template (decision matrix, comparative matrix, "rate limits and IP terms" gotchas), whatever the question. Reports never contain charts.
- **Follow-ups.** They see only the newest report, truncated to 48k characters, with citation numbers that do not match the report the person is reading.
- **Speed and cost.** Any single flagged claim triggers a full rewrite of the report. Worker tool calls run one after another. Every research search fans out to every paid engine at 1.5x the result count.

---

## 1. Competitor evidence (as of late Oct 2026)

Network note: `help.openai.com`, `macrumors.com`, `androidcentral.com` and `en.wikipedia.org` do not resolve from this session. OpenAI claims below come from search-result excerpts of the official help page and from press coverage; they are marked as such. Anthropic pages were fetched directly.

### ChatGPT deep research
- **[O-DR]** *Deep research in ChatGPT*, https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt (search excerpt, not fetched). You can edit the plan before it starts; view progress in real time; **interrupt to adjust focus and update which sources it can access**. **Sites > Manage sites** focuses research on specific websites. "Deep research uses available read actions from connected apps. It does not use app write actions as part of research."
- **[O-FEB]** February 10–11, 2026 update (press; OpenAI's own post did not appear in results):
  - Runs on a GPT-5.2-based model; one later source says 5.6.
  - Full-screen report viewer with a table of contents on the left and citations on the right.
  - Export to **Markdown, Word, PDF**.
  - Restrict research to specific websites or connected apps; adjust scope or add sources mid-run.
  - **Charts, tables and visual summaries** in reports; one outlet also reports a methodology section.
  - Sources: https://www.technobezz.com/news/openai-upgrades-chatgpt-deep-research-with-source-selection-and-document-viewer, https://www.androidheadlines.com/2026/02/chatgpt-deep-research-full-screen-document-viewer-update.html, https://kingy.ai/news/openai-transforms-deep-research-with-new-viewer-and-gpt-5-2-integration/, https://www.pulse.bot/ai/news/openais-deep-research-now-runs-on-gpt-52-and-lets-users-search-specific-websites-c27a7f5d-db61-47af-8f43-4c07844e16f8/, https://www.newsbytesapp.com/news/science/chatgpt-gets-better-at-research-with-gpt-52/tldr
- **[O-LIM]** Limits. Third-party figures put Plus at about 10 runs/month and Pro ($200) at about 250. OpenAI's pricing page reportedly says only "Limited / Expanded / Maximum" (https://aiplanfinder.com/chatgpt-usage-limits, https://www.cometapi.com/chatgpt-pricing-2026-free-vs-go-vs-plus-vs-pro/). Low confidence.
- **[O-G6]** GPT-6 and Intelligent UI rolled out from Oct 7, 2026. No source ties deep research to GPT-6 yet (https://www.androidheadlines.com/2026/10/openai-bringing-gpt-6-ai-models-chatgpt-everyone.html).
- Not found: completion notifications, follow-up Q&A over the report's corpus, continuing or refreshing a report.

### Claude Research
- **[C-R]** *Use Research on Claude*, https://support.claude.com/en/articles/11088861-using-research-on-claude-ai (fetched):
  - Paid plans, on web, Desktop and Mobile.
  - **Runs on Claude Opus 5.5, falling back to Opus 4.8, regardless of the chat's model.**
  - Web search must be on.
  - Searches the web and connected tools, **including Google Workspace (Gmail, Google Calendar, Google Docs) and other connectors enabled for the chat**. "Claude can use tools from your connectors automatically, without asking for approval each time."
  - Mobile: web only, no connectors. Local MCP servers are not available.
  - "Multiple searches that build on each other". Uses limits faster than chat.
- **[C-ENG]** *How we built our multi-agent research system*, https://www.anthropic.com/engineering/multi-agent-research-system (fetched):
  - Orchestrator-worker design. The Opus lead with Sonnet subagents beat single-agent Opus by **90.2%** on Anthropic's internal research eval.
  - Effort scaling: one agent with 3–10 calls for a simple fact; 2–4 subagents with 10–15 calls each for a comparison; more than 10 subagents for complex research.
  - The lead starts 3–5 subagents in parallel; **each subagent uses 3+ tools in parallel**. Together these cut research time by **up to 90%** on complex queries.
  - About 15x the tokens of chat.
  - A **CitationAgent** places citations after the research ends.
  - LLM-judge rubric: factual accuracy, citation accuracy, completeness, source quality, tool efficiency. A single 0–1 score plus pass/fail. Started with about 20 queries; human testing caught issues the automation missed.
  - Source-quality heuristics favour primary sources.
  - Agents resume from checkpoints rather than restarting. Rainbow deployments avoid breaking runs in flight.
- **[C-ADV]** Advanced Research, May 1, 2025: most runs take 5–15 minutes, complex ones up to **45 minutes**; "hundreds of sources"; citations link to the originals (https://www.maginative.com/article/anthropic-launches-claude-integrations-and-expands-research-capabilities/, https://getcoai.com/news/ai-research-mode-extends-to-45-minutes-for-claudes-reports).
- **[C-RN]** Release notes, https://support.claude.com/en/articles/12138966-release-notes (fetched): no Research-specific entry in 2026. Related: "Edit Claude's drafts in place" (Jun 12, 2026); the Microsoft 365 connector gained write tools (Jul 2026).

---

## 2. Capability-by-capability table

Gap key: **missing** (Alevr lacks it), **weaker**, **equal**, **ahead**.

| # | Capability | ChatGPT deep research | Claude Research | Alevr today (evidence) | Gap |
|---|---|---|---|---|---|
| 1 | Web search sources | Yes | Yes | Every keyed engine at once, merged by reciprocal-rank fusion, with query and page caches (`src/lib/research/tools.ts:740-750` `mode: "fanout"`; `src/lib/search/search-engine.ts:571-608`) | equal |
| 2 | Uploaded files / project / library as sources | Files yes | Not documented in the help article [C-R] | Yes. Files and project on by default, library and memory opt-in (`private-sources.ts:40-56,172`; `private-retrieval.ts:46-85`) | ahead |
| 3 | **Connected apps as sources** (Gmail, Drive, Calendar, Outlook, OneDrive/SharePoint, Slack, Notion, GitHub, custom MCP) | Yes, read actions only [O-DR] | Yes, automatic, Google Workspace included [C-R] | **Apple Calendar and Apple Mail only** (`private-retrieval.ts:34-37`). Every other connector is skipped as "no read-only search this run can use" (`private-retrieval-core.ts:386-388`). Yet first-party Gmail, Google Calendar, Drive, Outlook, M365 and Slack exist with read tools (`first-party-connectors/providers.ts:13-19`, `tools.ts:30-110`), as do GitHub, Notion and Figma MCP (`connectors.ts:100-160`) | **missing** |
| 4 | Private data kept out of web queries | Not documented | Not documented | Every web query is stripped of private-source content against a per-run fingerprint (`stages/context.ts:457-512`) | ahead |
| 5 | Site restriction (only / never these sites) | Yes, Manage sites [O-DR][O-FEB] | No | **No.** Pinned URLs are fetched, but search is not restricted ("Preferred URLs are priorities, not a domain allowlist", `docs/research-workspace.md:249-250`; `stages/corpus.ts:348`) | **missing** |
| 6 | Clarifying questions | Yes | Sometimes | 0–3 optional clarifications from the planner (`planner.prompt.ts:118`) | equal |
| 7 | Editable plan before start (web) | Yes | No gate | Edit questions, revise up to 5 times, toggle sources, pin URLs (`components/research/scope-card.tsx:444-490`; `engine.ts:583-717`) | ahead |
| 8 | Editable plan before start (native iOS/macOS) | Yes (apps) | n/a | **Confirm or cancel only** (`NativeResearchRun.swift:750-767`); no question edits, no source switches | weaker |
| 9 | Real-time progress | Activity sidebar | Step and source count | Deep Field: real sources by stage, per-question coverage, "What we know so far" (`components/research/deep-field.tsx`, `emerging-answers.tsx`) | ahead |
| 10 | Interrupt / steer mid-run | Yes, new instructions and sources [O-DR] | Stop only | Guide, pause, finish now, stop, add a URL. Guidance waits for the **next round boundary** (`stages/workers.ts:552-562`), and a worker's clock runs up to **12 min** (`envelope.ts:237`) | equal on features, **weaker on latency** |
| 11 | Multi-agent orchestration and effort scaling | Not documented | Lead plus 3–5 to 10+ subagents [C-ENG] | One worker per question (1–8, `domain.ts:622`), up to 16 delegations per round (`domain.ts:1481`), 1–6 rounds with adaptive extra rounds (`depth.ts`), lead review every round (`agents/lead.ts`) | equal |
| 12 | Parallel tool calls inside a subagent | n/a | 3+ in parallel [C-ENG] | **Sequential.** `for (const call of turn.calls) { … await … }` (`agents/worker-loop.ts:227-300`); the prompt never asks for batching | **weaker** (speed) |
| 13 | Worker model class | n/a | Sonnet subagents [C-ENG] | Haiku first (`agents/worker.ts:90-120`) | weaker? Unmeasured (see R7) |
| 14 | Query diversity and dedupe | n/a | n/a | MECE vectors, mapping queries, near-duplicate guard (Jaccard 0.8), leads, multilingual signals (`query-dedupe.ts`, `leads.ts`, `planner.ts`) | ahead |
| 15 | Source quality ranking | Implicit | Primary-source heuristics [C-ENG] | Deterministic tiers; aggregators demoted and not fetched while better sources exist (`source-policy.ts:69`; `stages/workers.ts` `rankByPolicy`) | ahead |
| 16 | Scholarly, government and filings verticals | Implicit | Implicit | **None.** No OpenAlex, Crossref, arXiv, PubMed or EDGAR backend. The fusion comment mentions them but no backend exists (`search/fusion.ts:55-57`; `search/alevr/backends.ts:129-180`) | weaker |
| 17 | Fetch depth: PDF | Yes | Yes | Layout-aware PDF columns and tables (`src/lib/search/pdf-layout.ts`) | ahead |
| 18 | Fetch depth: JS-rendered pages | Yes (browser) | Yes | JSON-LD and hydration state extracted (`src/lib/web/embedded-data.ts`). Headless rendering is **opt-in** (`crawler.ts:83-86`, `RESEARCH_HEADLESS`) and **not set** in `render.yaml` | weaker |
| 19 | Time to result | 5–30 min | 5–45 min [C-ADV] | Clock 15/20/30/60 min by plan (`envelope.ts:70-127`), plus writer up to 6 min (`stages/writer-text.ts:9`), plus audit, plus a **second full writer pass** most of the time (row 24) | equal; the revision makes it slower |
| 20 | Partial results before the report | No | No | "What we know so far" (`emerging-answers.tsx`) | ahead |
| 21 | Report structure fits the question | Adaptive | Adaptive | **One fixed template for every question**: Executive verdict and decision matrix, comparative matrix, vector deep dives, gotchas ("hidden rate limits, token quotas … cancellation friction"), disagreements, gaps, methodology (`corpus.prompt.ts:53-100`). The planner insists on "everything a decision needs" and 2–5 exact metrics per vector (`planner.prompt.ts:113-115`). No archetype field on the scope (`src/types/research.ts:15-21`) | **weaker** |
| 22 | Charts and visuals in the report | Yes [O-FEB] | Not documented | **None.** The reader renders Markdown (`report-document.tsx:157`). Live UI has `chart`/`timeline`/`metric` (`src/lib/live-ui/spec.ts:143-170`), but the writer is never asked for them | **missing** |
| 23 | Inline citation accuracy | Inline links | Inline; CitationAgent [C-ENG] | Claim audit: deterministic checks first, then a judge (≤40 calls), table cells too, rival figures, staleness, contested claims (`citation-audit-core.ts:1-40`; `envelope.ts:482-484`) | ahead |
| 24 | What happens to an unsupported claim | n/a | n/a | Annotated in place ("(partly supported)" and similar, `claim-analysis.ts:2535-2575`). **Any repair sends the whole report back for a full rewrite** (`stages/validation.ts:141-148`; `tools.ts:1035-1050`; `MAX_REVISION_ROUNDS = 1`, `domain.ts:634`) | ahead on honesty, **weaker on speed, cost and prose** |
| 25 | Citation inspection UI | Citation rail | Linked citations | Hover card with the **verbatim passage** checked, "Open at passage" text fragment, pager (`citation-card.tsx:13-24`) | ahead |
| 26 | Report viewer | Full screen, table of contents, citations rail [O-FEB] | Chat or artifact | Full-screen reader with contents, support mark per claim, cited-source rail (`report-fullscreen.tsx`) | equal |
| 27 | Export | Markdown, Word, PDF [O-FEB] | Copy / artifact | Markdown, DOCX (`api/research/[id]/export/route.ts:37`), print-to-PDF (`report-export.tsx:60-68`); Mac exports Markdown and PDF (`ResearchReportWindow.swift:107-116`); Google Docs in flight elsewhere | equal |
| 28 | Follow-up Q&A over the report | Chat follow-ups | Chat follow-ups | The **newest** completed report, truncated to **48,000 characters**, is pasted into **every** later turn (`chat/turn/research-stage.ts:94-108`). Numbering uses the writer's corpus order, but the visible message is renumbered so [1] is the first cited (`completion-core.ts:110-140`), so "[3]" means different sources to the person and the model. No retrieval over the 50–250 pages read | equal on features, **weaker on accuracy** |
| 29 | Continue / extend / refresh a report | Not documented | Not documented | "Go further" only prefills the composer, and a fresh run re-does everything. `ResearchRun` has no parent link (`prisma/schema.prisma:4427-4472`) | missing on all three; an opening to lead |
| 30 | Durability / resume | Server-side | Checkpoints [C-ENG] | Leases, a sweeper worker, bounded stage retries, recovery floors (`scripts/research-worker.ts`; `engine.ts` drive; `docs/rework/program/RESEARCH_V2.md` §2) | ahead |
| 31 | Completion notification | Not found | Not found | Tab title, toast and browser notification (`completion-watch.ts:1-30`), plus inbox and push (`stages/context.ts:239-265`); iOS research notifications (`JunoMobileResearchNotifications.swift`) | ahead |
| 32 | Failure handling | Rarely visible | Rarely visible | Planner floors, widening sweep, evidence digest fallback, "Try again" (`RESEARCH_V2.md` §2) | ahead |
| 33 | Cost transparency / limits | Monthly counter | Shares chat limits | Usage windows are the only limit; live spend shown; refusal says why (`RESEARCH_V2.md` §6) | equal |
| 34 | Quality measured end to end | Internal | LLM-judge rubric [C-ENG] | **No live end-to-end eval.** The citation eval uses stub judges, "A live-model judge is NOT run here" (`scripts/eval-research-citations.ts:9-13`); "Not established: a provider-backed live run, cost/quality evaluation" (`docs/rework/program/RESEARCH.md`) | **missing** |

### Cost per run today (a static estimate, not measured)

The constants say where the money goes. Treat these as a model to check against `research.estimate.actual` logs and spend rows by `kind: "research"`.

- **Search fan-out.** Every research query goes to every keyed engine at `perEngineCount(count) = ceil(count × 1.5)` (`search-engine.ts:549-551`), with count 12/20/30 by breadth (`envelope.ts:219`).
  - Price per query from `metering.ts:70-81`, at 20 results with all four engines keyed: Tavily $0.008 + Serper $0.002 + Brave $0.005 + Exa (30 results) $0.057 ≈ **$0.07/query**. Exa alone is about 80% of that.
  - Run volume: about 10 searches per worker-round, so 6 workers × 2 rounds ≈ 120 worker searches, plus about 20 sweep and follow-up searches. That puts search alone in the **$5–10 range** when nothing is cached.
- **Worker loop.** Haiku, ~11k prompt tokens per call (`WORKER_CONTEXT_CHARS/2 + system`, `envelope.ts:232-234`), × (toolCalls+1) × workers × rounds. Prompt caching is on (`worker-loop.ts:1-3`, `withConversationCacheBreakpoint`). This is the second-largest line.
- **Writer.** Up to 120k input tokens plus 16,384 output (`domain.ts:2182`) on the lead model. The revision (row 24) adds another full-length output, with input mostly cached.
- **Audit.** 8–40 judge calls (`envelope.ts:407`).

**Implication:** the cheapest real saving is search fan-out (R8), and the cheapest time saving is the revision pass (R4). Both improve speed at the same time.

---

## 3. Ranked improvements

Order is by how much a person will feel the difference, then cost to build. R7 (the eval harness) should **start first in parallel**: R2, R4, R8 and the worker-model question all need it to prove "same or better quality".

---

### R1. Connected apps as research sources, searched by the researchers themselves
- **Size L. Impact H.**
- **User-visible outcome.** At the plan gate, the source switches list everything they have connected: Gmail, Google Drive, Google Calendar, Outlook, OneDrive/SharePoint, Slack, Notion, GitHub, plus any custom MCP server with read tools. With Drive and Gmail on, "Prepare me for the Acme renewal" cites the contract PDF in Drive, last month's thread with Acme, and the public news. Each private citation is marked "(your sources)". Researchers can follow a lead inside a mailbox ("search for the thread that mentions the SLA credit") instead of relying on one keyword sweep.
- **Competitor evidence.** ChatGPT: "uses available read actions from connected apps", and the run can be limited to apps [O-DR][O-FEB]. Claude: Gmail, Calendar, Docs and other connectors, "automatically, without asking for approval each time" [C-R].
- **Current code.**
  - `src/lib/research/private-retrieval.ts:34-37`: `SEARCHABLE_CONNECTORS` holds only `apple-calendar` and `apple-mail`. Lines 64-81 offer only those.
  - `private-retrieval-core.ts:299-388`: a single pre-sweep with hard-coded `list_events` / `search_messages`. Any other connector is skipped as `notRead`.
  - `agents/protocol.ts:99-152`: worker tools are web-only (`search`, `open_page`, `find_in_page`, `note_finding`, `done`).
  - Already available: read tools with `readOnlyHint` (`first-party-connectors/tools.ts:30-111`); the toolset's `accessFor(tool) === "read"` and `unattended` mode (`private-retrieval.ts:149-170`); the query-sanitising fingerprint (`stages/context.ts:457-512`).
- **Implementation sketch.**
  1. **Registry.** In a new `src/lib/research/connector-sources.ts`, map each connector to `{kind, searchTool, readTool, argsFor(query), parseHits(body), parseItem(body)}`:
     - `gmail`: `search_messages` / `read_message`.
     - `google-drive`: `search_files` with `fullText contains '…'` / `read_file`.
     - `google-calendar` and `outlook`: `search_events`.
     - `microsoft-365`: `search_files` / `read_file`.
     - `slack`: `search_messages` / `read_channel`.
     - `notion` and `github` MCP: their search and read tools.
     - **Generic MCP fallback:** any tool whose `accessFor === "read"` and whose name matches `/search|query|find|list/` gets a query argument chosen from its schema.

     Replace `SEARCHABLE_CONNECTORS` with this registry, and offer every connected, configured, unblocked connector in `privateSourceOptionsFor`. Keep the `kind` values `mail`/`calendar`/`connector`, which are additive in `PRIVATE_SOURCE_KINDS`.
  2. **Worker tools.** Add `search_private {source, query}` and `open_private {source, id}` to `WORKER_TOOLS`, shown only when the run enabled private options. Results become `ResearchSource` rows at `https://private.invalid/<kind>/<id>` (same addressing, so audit and citations work unchanged), with a body cap and a passage split. `note_finding` keeps its verbatim-quote rule.
  3. **Sweep.** Keep the current pre-sweep as the seed. Planner vectors may name "your Drive" in `primarySources` (already supported, `planner.prompt.ts:66-70`) and get a private delegation.
  4. **Budgets.** Cap private calls per worker (e.g. 8) and per run (e.g. 60). Bill none (first-party) or the MCP's metered cost.
  5. **Native and mobile.** Same options through `GET /api/research/:id` (`plan.sources.options` is already on the wire).
- **Acceptance tests.**
  - `tests/research-private-sources.test.ts`, extended with scripted Gmail, Drive and Slack toolsets:
    - (a) options list every connected, configured, unblocked connector;
    - (b) a worker `search_private` → `open_private` → `note_finding` yields a cited private source;
    - (c) a write tool is never callable (`accessFor !== "read"` → refused);
    - (d) web queries issued after a private read never contain a token from the private fingerprint (property test over 100 random mails);
    - (e) an approval-required connector is skipped with `SKIP.refused`;
    - (f) blocked connectors are never offered.
  - Live check: a Drive plus Gmail run cites at least one Drive file and one Gmail thread, both marked "(your sources)".
- **Risks.**
  - Prompt injection from mail and docs. Mitigation: `wrapUntrusted` is already used for tool output; keep connector text out of the planner.
  - Privacy leaks into web queries. Mitigation: the fingerprint, plus a test.
  - Rate limits on Google and Slack APIs. Mitigation: per-host semaphore keyed by connector.
  - Over-sharing in shared messages. Mitigation: snippets are already blanked for private sources (`completion-core.ts:126-128`).

---

### R2. Reports shaped to the question (archetypes), with cited charts
- **Size M. Impact H.**
- **User-visible outcome.** "Why did the Roman Republic fall?" returns a narrative explainer with a timeline and historiographic debate, not a "decision matrix" with "hidden rate limits". "How big is the EU heat-pump market?" returns a market-sizing report with a cited bar chart and the method behind each figure. "Copilot vs Cursor" keeps today's decision layout. Charts are real, interactive figures whose every value has a citation and is audited.
- **Competitor evidence.** ChatGPT's Feb 2026 update added charts, tables and visual summaries, and a methodology section [O-FEB]. Both competitors adapt structure to the request; neither forces a decision matrix.
- **Current code.**
  - `corpus.prompt.ts:53-100`: one fixed contract. Bottom line with decision matrix, comparative matrix, gotchas listing "hidden rate limits, quotas … IP and training terms, cancellation friction".
  - `planner.prompt.ts:113-115`: vectors must "cover everything a decision needs", with 2–5 exact metrics each.
  - `src/types/research.ts:15-21`: no archetype on the scope.
  - The reader renders plain Markdown (`report-document.tsx:157`).
  - Live UI already renders `chart` / `timeline` / `metric` / `table` (`src/lib/live-ui/spec.ts:143-170`), and the chat Markdown recognises Live UI fences (`src/lib/live-ui/fence.ts`, `components/chat/markdown.tsx:48`).
- **Implementation sketch.**
  1. Add `scope.archetype` to `ResearchScope`, the planner schema and the parser. Values: `decision | landscape | explainer | literature_review | quantitative | timeline | profile | how_to`. The default for older plans is `decision`, which keeps the wire additive. The planner picks one; the person can change it at the gate (one select in the scope card).
  2. Make the planner rules archetype-aware. "metrics" is required only for `decision` and `quantitative`. Explainer and literature-review vectors carry `questions`, `schools of thought` and `key studies` instead.
  3. Split `reportWriterContract` into a shared core (summary, title, question sections, disagreements, gaps, methodology) plus per-archetype sections:
     - decision: verdict and matrix;
     - landscape: map of players and segments;
     - literature_review: evidence table by study design and strength;
     - quantitative: figures with method;
     - timeline: dated events;
     - profile: facts box;
     - how_to: steps.

     `report-structure.ts` (both copies) must learn the new markers. Native readers already split on headings generically.
  4. **Figures.** The writer may emit `<!-- juno:figure kind="bar|line|timeline" title="…" -->` followed by a small Markdown table (x, y, unit, [n] per row). In `report-document.tsx`, convert each figure to a Live UI `chart`/`timeline` spec. The citation audit already reads table cells (`tableClaims`), so every plotted value is checked like any cell. Print and DOCX export fall back to the table.
  5. Gotchas and matrix sections become optional by archetype.
- **Acceptance tests.**
  - Planner parse round-trips `archetype`; older plans read as `decision`.
  - The contract for each archetype contains its markers and not the others' (snapshot test).
  - A figure block becomes a chart spec, and a figure row with no `[n]` is flagged by the audit.
  - R7 harness, 8 fixed non-decision prompts (history, medicine, science explainer, market size, biography): the judge's "structure fits the question" score improves over the baseline, with no loss on factual or citation scores.
- **Risks.**
  - The archetype is misclassified. Mitigation: editable at the gate; `decision` remains a valid fallback.
  - Models emit malformed figure tables. Mitigation: a lenient parser; on failure render as a table.
  - Charts imply precision the sources lack. Mitigation: only cited rows are plotted, with the unit and date in the caption.

---

### R3. "Ask the research": follow-ups grounded in everything the run read, numbered like the report on screen
- **Size M. Impact H.**
- **User-visible outcome.** After a report, "what did the Gartner source say about Europe specifically?" or "show me every figure about churn" is answered from the 50–250 pages the run actually read, not only the report text. Citations use the same numbers as the report the person is looking at, and point at the same passages, with hover cards. Asking about an earlier report in the same chat works too. Chats with a report no longer pay roughly 12k tokens of pasted report on every unrelated turn.
- **Competitor evidence.** Both offer chat follow-ups. Neither documents retrieval over the run's corpus, so this is a chance to lead [O-DR][C-R].
- **Current code.**
  - `src/lib/chat/turn/research-stage.ts:94-108`: newest completed run only, `report.slice(0, 48000)`, sources ordered by `fetchedAt`, all marked `cited: true`, appended to the system prompt every turn.
  - Numbering mismatch: the visible message is renumbered so [1] is the first cited (`completion-core.ts:110-140`), but the context uses writer numbering.
  - Passages exist (`ResearchPassage`, `prisma/schema.prisma:4549-4563`).
- **Implementation sketch.**
  1. **Fix numbering now** (size S on its own). Build the reference from the completion message's `sourceOrder` (store it on `plan.completionOrder`, or read the assistant message's `sources`) and renumber `run.report` with the same `mapping` before injecting.
  2. Add a `research_lookup {query, runId?}` chat tool, enabled whenever the conversation has a completed run. It does hybrid retrieval over that run's `ResearchPassage` rows and `ResearchFinding` quotes: Postgres full-text plus `contentTokens` overlap, top 8 passages, each returned with the source's **visible** number. Replace the 48k paste with a compact header: title, summary, section list, source list with visible numbers, and "call research_lookup for details". Keep the short paste for models without tools.
  3. Cover all runs in the conversation (latest first; `runId` to pick one).
  4. In the reader, "Ask about this" on a selected passage seeds the composer with the quote and the run id.
- **Acceptance tests.**
  - Unit: the context's [n] equals the visible message's [n] for a fixture where the writer's first citation is [7].
  - `research_lookup` returns only the owner's passages (ownership test); numbering is stable across calls.
  - Token test: a non-research follow-up turn's system prompt is at least 80% smaller.
  - R7 harness, 20 follow-up questions whose answers are in read but uncited sources: answered with a correct citation at least 70% of the time vs the current baseline.
- **Risks.**
  - Retrieval misses. Mitigation: keep the summary and section list in context.
  - Older conversations. Mitigation: fall back to the current paste when no passages exist.

---

### R4. Fix flagged claims in place, section by section, instead of rewriting the whole report
- **Size M. Impact H** (speed, cost, prose).
- **User-visible outcome.** Reports arrive 3–5 minutes sooner on a typical run. Final prose no longer carries inline "(partly supported)" notes where a correct statement was available. The few claims that cannot be fixed are still marked, honestly.
- **Competitor evidence.** Claude places citations with a dedicated CitationAgent pass rather than regenerating the report [C-ENG]. Speed is a headline claim in both products [C-ENG][C-ADV].
- **Current code.**
  - `stages/validation.ts:141-148`: `shouldRevise` is true whenever `validation.repaired`. Any partially supported or contradicted claim triggers it (`claim-analysis.ts:2535-2575`).
  - `tools.ts:1035-1050`: the revision is a **full** writer call with the whole corpus and draft, up to 16,384 output tokens (`domain.ts:2182`).
  - `MAX_REVISION_ROUNDS = 1` (`domain.ts:634`). A second full audit follows.
- **Implementation sketch.**
  1. Group repairable claims by their `<!-- juno:section=… -->` span (`report-structure.ts` already parses spans).
  2. For each affected section, call `reviseSection`, in parallel, on the lead model or one class down. Input: the section text, each flagged claim with verdict, supporting, contradicting and rival passages (`citation-audit-core.ts` already computes them), and the sources cited in that section. Output: a replacement section only. Rules: keep unflagged sentences verbatim, correct figures from the passage, drop what nothing supports.
  3. Splice the replacement sections in, and re-audit only the claims in replaced sections. Carry unchanged verdicts forward by claim hash.
  4. Fall back to today's full revision only when more than 50% of sections are affected or the draft has dangling citations everywhere.
  5. Record `report_revision {phase, sections:[…]}` events so the timeline can show "Corrected 3 claims in 2 sections".
- **Acceptance tests.**
  - Fixture with 2 flagged claims in 1 of 8 sections: exactly one revision call, the other 7 sections byte-identical, re-audit only touches that section's claims.
  - Over 50% of sections flagged triggers a full rewrite.
  - Cost test: revision output tokens are at most 30% of the full-rewrite baseline on the fixture.
  - R7 harness: citation-accuracy score not lower than baseline; median time-to-report lower by at least 2 min.
- **Risks.**
  - Seams between rewritten and kept sections. Mitigation: pass the neighbouring sections' first and last paragraphs as read-only context.
  - The summary contradicts a corrected section. Mitigation: re-derive the summary's figures from the bottom-line section after the splice (one cheap call), or re-audit the summary claims.

---

### R5. Speed pack: parallel tool calls inside each researcher, and a report that streams in
- **Size S–M. Impact H** (time to result).
- **User-visible outcome.** The same research finishes noticeably sooner, because three pages are opened at once instead of one after another. While the report is being written, the reader shows sections as they land ("Drafting: 3 of 9 sections") instead of a spinner for up to 6 minutes.
- **Competitor evidence.** Anthropic: subagents "use 3+ tools in parallel"; combined with parallel subagents this cut research time by up to 90% [C-ENG].
- **Current code.**
  - `agents/worker-loop.ts:227-300` runs each turn's calls sequentially with `await` in a `for` loop.
  - The worker prompt (`agents/worker.ts`, `agents/protocol.ts`) never asks for batched calls.
  - The writer streams internally, but only the final text is stored (`tools.ts:1059-1075`, then `stages/synthesis.ts:116-122` `report_ready`).
  - Per-host fetch limit 2 (`stages/limits.ts:176`) and the host semaphore (`agents/scheduler.ts:90-96`) already exist.
- **Implementation sketch.**
  1. In `worker-loop.ts`, partition a turn's calls. `search`, `open_page` and `find_in_page` run through `Promise.all`, with budget counters reserved up front (`toolCalls += n`, refuse beyond `maxToolCalls`) and results pushed in call order. `note_finding` and `done` stay sequential and run after the reads.
  2. Add to the worker system prompt: "When you need several pages or searches, request them in the same turn."
  3. Set `parallel_tool_calls: true` (OpenAI-compatible), and do not disable parallel tool use (Anthropic).
  4. **Draft streaming.** Every ~5 s while the writer streams, persist `plan.draftReport` (capped, ≤1 write per 5 s) and emit `report_progress {sections}`. The reader renders the draft greyed with "Checking citations next".
- **Acceptance tests.**
  - Scripted adapter returning 3 `open_page` calls in one turn: the 3 fetches overlap in time (fake clock), the per-host limit holds, the tool-call budget counts 3, and results keep call order.
  - A cancellation mid-batch aborts all three.
  - Draft persists at most once per 5 s; a resumed run ignores a stale draft.
  - R7 harness: median investigation time down by at least 25% at equal pages read.
- **Risks.**
  - Burst load on one host. Mitigation: the per-host semaphore.
  - Over-spend in one turn. Mitigation: pre-reserve.
  - A draft shows claims the audit later corrects. Mitigation: label it a draft; show the audited version only once it is ready.

---

### R6. Guidance reaches the researchers within seconds, not at the next round
- **Size S. Impact M.**
- **User-visible outcome.** "Focus on Europe only" or "ignore vendor blogs" changes what the running researchers search for within about 30 seconds. The guidance line flips from "Queued" to "Applied by 4 researchers".
- **Competitor evidence.** ChatGPT: interrupt to adjust focus and add sources while the report is generating [O-DR][O-FEB].
- **Current code.**
  - `stages/workers.ts:552-562`: `applySteering` runs only at a round boundary.
  - Workers can run up to 12 minutes per round (`envelope.ts:237,463`).
  - The UI already distinguishes queued from applied guidance (`NativeResearchLiveView.swift:376-385`; `components/research/steer.ts`).
- **Implementation sketch.**
  1. Give `RunWorkerInput` a `guidance(): Promise<string[]>` port, reading `plan.steering` entries newer than the worker's start (cached, polled at most every 15 s).
  2. In `worker-loop.ts`, before each model turn, append any new guidance as a user message ("The person just added guidance: …; adjust your next searches").
  3. Mark entries `appliedLive: [workerIds]`. Still convert them to constraints at the boundary as today.
  4. A pinned URL added mid-run is fetched immediately by the sweep's reader, not at the next boundary.
- **Acceptance tests.**
  - Scripted worker with a guidance entry inserted after turn 2: turn 3's transcript contains it, and the event `steering_applied_live` lists the worker.
  - The boundary conversion still happens exactly once.
  - Guidance while paused stays queued.
- **Risks.** Changing the transcript mid-way invalidates the prompt cache. Mitigation: append only, never edit earlier messages.

---

### R7. A live research quality and cost harness (start first)
- **Size M. Impact H** (it is what lets every other change claim "same or better").
- **User-visible outcome.** Indirect. Releases stop regressing research quality, and the team can say with data where Alevr beats ChatGPT and Claude on its own question set, and at what cost per run.
- **Competitor evidence.** Anthropic's LLM-judge rubric (factual accuracy, citation accuracy, completeness, source quality, tool efficiency); a single 0–1 score plus pass/fail; about 20 queries to start; humans in the loop [C-ENG].
- **Current code.**
  - `scripts/eval-research-citations.ts:9-13` audits fixed reports with stub judges ("A live-model judge is NOT run here").
  - Docs state live runs and cost/quality evaluation were never established (`docs/rework/program/RESEARCH.md`, Deep Field verification; `docs/research/PROTOCOL_UPGRADE.md`, "Needs a real-provider check").
  - `research.estimate.actual` logs exist; spend rows carry `kind: "research"`.
- **Implementation sketch.**
  1. `scripts/eval-research-live.ts` plus `src/lib/eval/research-live-cases.ts`. About 30 prompts across archetypes and languages (EN, FR, DE). Each prompt has must-cover facts (with a URL that states them), forbidden claims, and archetype.
  2. Run on a dedicated owner account through the real engine (`researchEngine()`, auto-confirm). Record time to plan, time to report, pages read, searches, cost per line item (search by engine, worker, writer, audit, revision), and audit summary.
  3. **Judge:** a fixed model and prompt implementing the five-dimension rubric, plus must-cover recall and forbidden-claim checks against the report.
  4. **Pairwise:** for 10 prompts, store ChatGPT and Claude reports captured by hand (`bench/research/competitors/*.md`) and run a blind pairwise judge.
  5. Write `docs/rework/program/evidence/research-live-<date>.json`. Gate: no dimension drops by more than 0.03 vs the last baseline. Cost and time deltas are printed.
  6. Use it to decide the open questions: worker model class (Haiku vs Sonnet on hard vectors), Exa on or off (R8), archetypes (R2).
- **Acceptance tests.**
  - The harness runs headless with `--cases 3 --dry` (no providers, scripted engine) in CI.
  - A full run produces the JSON with every field.
  - The judge is reproducible: the same report scored twice differs by at most 0.05.
- **Risks.**
  - Cost, about $5–15 per prompt. Mitigation: a nightly subset of 8, the full set before release.
  - Judge bias toward long reports. Mitigation: a length-normalised rubric item, plus human spot checks.

---

### R8. Spend less on search, read better sources: tiered engines and free scholarly and filings backends
- **Size M. Impact H** (cost), **M** (quality).
- **User-visible outcome.** Research runs cost noticeably less, so they use less of the person's 5-hour and weekly windows and they get more runs. Academic, medical and finance questions cite the paper, the PubMed record or the SEC filing directly.
- **Competitor evidence.** Not documented by either. Primary-source preference is in Anthropic's heuristics [C-ENG].
- **Current code.**
  - Research search runs `mode: "fanout"`, meaning every keyed backend for every query (`tools.ts:740-750`; `search/alevr/service.ts:54-55,256-342`).
  - Each engine is asked for `ceil(count × 1.5)` results (`search-engine.ts:549-551`), with count 12/20/30 (`envelope.ts:219`).
  - Prices: `metering.ts:70-81`. Exa at 30–45 results is $0.057–$0.087 per query.
  - No scholarly or filings backend exists (`search/alevr/backends.ts:129-180`; the comment at `fusion.ts:55-57` names OpenAlex, Crossref and PubMed, which were never built).
- **Implementation sketch.**
  1. **Tiered fan-out** in `alevr/service.ts`, new mode `"research"`:
     - Ask the two cheapest high-quality backends first (Serper and Brave by the `DEFAULT_QUALITY` and price table).
     - Add Tavily or Exa only when fewer than N new unread URLs come back, when engine overlap is low, or when the query is semantic or long-tail (no entity, more than 8 words).
     - Ask each engine for `count`, not `count × 1.5`.
     - Use Exa `highlights` instead of `text` for worker searches. Workers see 300-character snippets and open pages themselves (`stages/workers.ts:330-370`).
  2. **Verticals** (free APIs, polite rate limits, stored like any source): OpenAlex works, Crossref, arXiv, PubMed E-utilities, SEC EDGAR full-text search. Routing:
     - The planner's `sourceKinds` and the `primarySources` vocabulary (paper, trial, filing, 10-K) route a vector's queries to the right vertical.
     - Workers get `search {query, vertical?}`.
     - `source-policy.ts` already ranks these hosts as primary (`source-policy.ts:69`).
  3. Show per-engine spend in the methodology footprint.
- **Acceptance tests.**
  - Unit: research mode calls at most two engines when they return ≥ N new URLs, and escalates when they do not.
  - Per-engine count equals `count`.
  - An OpenAlex fixture parses to hits with DOI URLs.
  - A vector with `primarySources: ["peer-reviewed trials"]` issues at least one PubMed or OpenAlex query.
  - R7 harness: search spend per run down by at least 50%, with completeness and source-quality scores not lower.
- **Risks.**
  - Recall loss on hard queries. Mitigation: the escalation rule, measured by R7.
  - Vendor terms for free APIs. Mitigation: a User-Agent with contact; EDGAR's 10 requests/second rule.
  - Scholarly noise on consumer questions. Mitigation: route only when the vector asks for it; RRF weights below web.

---

### R9. Site controls: only these sites, never these sites
- **Size S–M. Impact M.**
- **User-visible outcome.** At the gate or mid-run, "Only search: sec.gov, investor.apple.com" or "Never use: reddit.com, medium.com". The run obeys it in search, link hops and worker opens, and the methodology says so. Pinned URLs stay as they are.
- **Competitor evidence.** ChatGPT: Sites > Manage sites, and limiting research to particular domains [O-DR][O-FEB].
- **Current code.**
  - Only `pinnedSources` exists, as "priorities, not a domain allowlist" (`docs/research-workspace.md:249-250`; `stages/corpus.ts:348`; `domain.ts:1051`).
  - The scope card has web and private switches and a pinned list (`scope-card.tsx:444-490`).
- **Implementation sketch.**
  1. Add `plan.siteRules = {only: string[], never: string[]}`: validated hostnames (max 20 each) in `api/research/protocol.ts`, editable via `decidePlan` and `/steer`.
  2. Enforce it:
     - Append `site:` / `-site:` to Serper and Brave queries.
     - Pass `include_domains` / `exclude_domains` to Tavily and `includeDomains` / `excludeDomains` to Exa (verify against current vendor docs).
     - Post-filter fused results by host (`canonicalUrl` host match, subdomains included).
     - Refuse `open_page` and link hops outside the rule with a worker-visible message.
  3. With `only` set, the near-duplicate guard and "widen the sweep" (F5) stay inside the rule. When the rule yields nothing, the run says so instead of quietly leaving it.
  4. Gate UI: two token fields under Sources. Native gets the same fields (R11).
- **Acceptance tests.**
  - Every issued query on every engine carries the restriction (spy on engine calls).
  - A fused result from a forbidden host is dropped.
  - A worker opening a forbidden URL gets a refusal and no fetch.
  - A steer adding `never` applies from the next tool call (with R6).
- **Risks.** Over-restriction yields empty runs. Mitigation: an explicit message plus an offer to widen.

---

### R10. Continue, extend and refresh a report (run lineage)
- **Size M. Impact M.**
- **User-visible outcome.**
  - "Go further" and "Update this report" start a run that already knows what the parent read. It investigates only the open questions or what changed since the report date, then produces a new version with a "What changed since 12 Oct" section.
  - An "Update monthly" option schedules it.
  - Follow-on runs finish in a fraction of the time and cost.
- **Competitor evidence.** Neither documents continuing or refreshing a deep research report. This is a chance to lead. ChatGPT has generic scheduled tasks [O13 in the parity matrix].
- **Current code.**
  - No parent link on `ResearchRun` (`prisma/schema.prisma:4427-4472`).
  - "Go further" only seeds the composer (`components/research/research-recap.tsx:54-55,204-207`; `RESEARCH_V2.md` §3).
  - Page and query caches already make re-reads cheaper (`tools.ts:793-810`).
  - Work triggers exist for scheduling (`src/lib/work/triggers.ts`).
- **Implementation sketch.**
  1. Add `ResearchRun.parentRunId String?` (index), plus `plan.lineage {parentRunId, mode: "extend" | "refresh", since}`.
  2. At planning, the planner sees the parent's objectives, gaps and open questions.
     - **Extend:** vectors are the parent's open items.
     - **Refresh:** the same vectors, with `freshness` set to `since` and recency queries.
  3. At the corpus stage, copy the parent's citable sources and findings by reference: new `ResearchSource` rows pointing at the same snapshot hash, so numbering and the audit work. Mark them `inherited`. Refresh re-fetches the parent's primary sources conditionally (ETag) and flags changed ones.
  4. The writer gets a `changes` section contract, and the diff against the parent's figures comes from the gap audit's metric matcher (`metric-match.ts`).
  5. **Schedule:** a Work trigger that starts a refresh run. Notify only if the report materially changed (any metric differs, or a new primary source).
- **Acceptance tests.**
  - An extend run issues no search already in the parent's ledger (dedupe across lineage).
  - Inherited sources keep their passages, and the audit can cite them.
  - Refresh with an unchanged ETag fetches nothing new and writes "no material change".
  - A scheduled refresh notifies only on change.
- **Risks.**
  - Stale inherited facts. Mitigation: refresh re-checks dated figures older than `since`.
  - Schema migration. Mitigation: additive nullable column.

---

### R11. Read JavaScript-only pages in production
- **Size M. Impact M.**
- **User-visible outcome.** Pages that render only in a browser (pricing configurators, dashboards, many SaaS docs) stop showing up as "could not read". The report cites them like any page.
- **Competitor evidence.** Both read rendered pages via a browser (ChatGPT's agentic browsing; Claude's web fetch). No direct quote; implied by "hundreds of sources" [C-ADV].
- **Current code.**
  - Headless rendering exists but is opt-in: `RESEARCH_HEADLESS` (`crawler.ts:83-86`), not set in `render.yaml`.
  - JSON-LD and hydration extraction covers many shells (`src/lib/web/embedded-data.ts`). A pure client-rendered page without embedded JSON stays `needs_browser` / `empty_document` (`docs/research/PROTOCOL_UPGRADE.md`, "Still open").
  - A hardened Chromium image already exists for agent computers (`deploy/agent-computers/Dockerfile:44-72`, seccomp profile, CDP gate).
- **Implementation sketch.**
  1. A small render service that reuses the agent-computers image (or Playwright on the research worker host). Endpoint `POST /render {url}`: returns the DOM after network idle (8 s cap), with the same SSRF guard on every request (`headlessRequestAllowed`, `crawler.ts:119`).
  2. The crawler calls it only for `needs_browser` outcomes, at most K per run (e.g. 15), with the per-host limit.
  3. Cache rendered pages in the page cache like any fetch.
  4. Bill render time to the run as `fetch` cost.
- **Acceptance tests.**
  - Fixture SPA page (`tests/fixtures/reading/empty-spa.html`) served locally: rendered text extracted, tables preserved.
  - SSRF: a redirect to 169.254.169.254 is refused.
  - The cap holds.
  - R7 harness: share of `needs_browser` outcomes in final source lists drops by at least 70%.
- **Risks.** Sandbox escapes and abuse. Mitigation: reuse the hardened image, no cookies, no persistence, egress guard.

---

### R12. Native gate parity: edit the plan and choose sources on iOS and macOS
- **Size M. Impact M.**
- **User-visible outcome.** On iPhone and Mac, the plan card lets the person:
  - edit, reorder or delete questions;
  - answer clarifications;
  - switch sources (web, files, Drive, Gmail with R1), set site rules (R9) and the archetype (R2);
  - press Revise or Start.

  It is the same gate as the web, so a run started on the phone is not a lesser run.
- **Competitor evidence.** ChatGPT's plan editing is available in its apps [O-DR]. Claude Mobile runs web-only research without connectors [C-R], so Alevr would be ahead on mobile.
- **Current code.**
  - `NativeResearchRun.swift:750-767`: `decideResearchPlan(confirm:)` sends only `confirm` or `cancel`.
  - No source options in the native model (no `sources` / `options` field in `NativeResearchRun.swift`).
  - The server already accepts `questions`, `answers`, `sources` and `pinnedSources` on `/api/research/:id/plan` (`engine.ts:583-717`).
- **Implementation sketch.**
  1. Decode `plan.sources.options`, `plan.objectives` and `scope` into `NativeResearchRun`.
  2. Add `decideResearchPlan(decision: .confirm | .revise | .cancel, questions:, answers:, sources:, pinnedSources:, siteRules:)` matching `api/research/protocol.ts`.
  3. Build the SwiftUI plan editor using the redesign's components (being designed separately). This item only adds the capability and its model.
- **Acceptance tests.**
  - `NativeResearchRunStageBTests`: options decode; a revise request body matches the server zod schema (contract test against `contracts/`).
  - A snapshot of the plan editor with 5 questions and 3 sources.
  - Manual: edit a question on iPhone, Start; the web shows the edited question.
- **Risks.** Contract drift. Mitigation: the existing native contract checks (`npm run capabilities:check`).

---

## 4. Suggested sequencing

1. **Wave A (1–2 weeks):**
   - R7 harness (dry mode first);
   - R3 step 1, the numbering fix (S);
   - R5 parallel tool calls (S);
   - R6 live guidance (S);
   - R4 targeted repair (M).

   Fast, mostly invisible plumbing that users will feel as faster, cleaner reports. Prove each with R7.
2. **Wave B:**
   - R1 connectors as sources (L, the biggest visible gap);
   - R2 archetypes and charts;
   - R3 research_lookup;
   - R8 search tiering and verticals.
3. **Wave C:** R9 site rules, R10 lineage and refresh, R11 rendering, R12 native gate.

## 5. Things checked and found strong (do not rework)

- **Citation audit and passage hover cards:** `citation-audit-core.ts`, `citation-card.tsx`.
- **Privacy guard on web queries:** `stages/context.ts:457-512`.
- **Durability:** leases, sweeper, bounded retries, recovery floors (`RESEARCH_V2.md` §2).
- **Notifications:** web, push, iOS.
- **Planner and sweep:** MECE planner, near-duplicate guard, leads, gap audit and adaptive depth (`PROTOCOL_UPGRADE.md`).
- **Reading depth:** PDF layout and embedded-data extraction.
