# External audit: deep research products, and what Juno's Research should become

Written 2026-09-23, on branch `web/tools-thinking-research` (worktree `juno-tools`), as a read-only audit.
This audit covers other products. It is one of a set. The other reports describe Juno as it stands today,
and this one does not repeat them:
[`internal-research-ui.md`](./internal-research-ui.md), [`internal-research-backend.md`](./internal-research-backend.md),
[`internal-thinking-and-right-panel.md`](./internal-thinking-and-right-panel.md) and
[`internal-design-system-motion.md`](./internal-design-system-motion.md). The recommendations in §11 are
written to fit what those audits found.

Products covered: **ChatGPT deep research** and **Claude Research** in depth, then Gemini Deep
Research (in the app and through the API), Perplexity (Research, Labs, Advanced Deep Research,
Computer), Grok DeepSearch/DeeperSearch, Kimi-Researcher and Kimi Agent. Four successors and
neighbours are covered more briefly: Microsoft 365 Copilot Researcher, NotebookLM Deep Research,
Claude Code's `/deep-research` skill, and the OpenAI and Gemini deep-research APIs.

---

## 0. Method and evidence legend

- **Sources.** I used vendor help centres, launch posts, API docs, engineering write-ups, arXiv
  papers, reputable press and UX teardown sites, all found and read on 2026-09-23. Some vendor
  pages returned HTTP 403 to the fetcher: `help.openai.com`, `openai.com/index/…`,
  `chatgpt.com/features`, `perplexity.ai/changelog` and `perplexity.ai/help-center`. For those, the
  facts come from one of three places: search-engine extracts of the page itself, OpenAI's PDF
  mirror of its launch post on `cdn.openai.com` (read in full), or press that reported the page.
- **Budget.** The web-search budget for the session ran out near the end. A few UI details could
  not be checked again against a 2026 source, and they are tagged **[K]**.
- **Tags** used on every claim that matters:
  - **[P]** primary: the vendor's own doc, post, API doc, system card or paper, read this session.
  - **[S]** secondary: press, review, teardown or third-party guide, read this session.
  - **[K]** prior knowledge of the product up to mid-2025, not checked again this session. Treat it as
    likely but unverified.
  - **[I]** my inference or recommendation.
- **Dates.** Claims are dated in the form "as of <month year>, per <source>". Where a source gave no
  date, the date shown is when it was published or last updated.
- **Wording.** Everything is paraphrased. Quotes are rare and short.

---

## 1. Executive summary: the twelve things that matter for Juno

1. **No leading consumer product asks people to choose a research depth.** ChatGPT has a single
   "deep research" entry. When your quota runs out it silently switches to a cheaper *lightweight*
   variant, and nobody picks it (Apr 2025, [S] TechCrunch). Claude has a single Research toggle, and its
   lead agent sizes its own effort from rules written into its prompt (Jun 2025, [P] Anthropic
   engineering). The Gemini app also has a single Deep Research tool ([P] Gemini help). Named levels
   survive only in a few places:
   - developer APIs: Gemini "Deep Research" vs "Deep Research Max" (Apr 2026, [P]), framed as
     interactive vs background use rather than as a quality ladder;
   - Grok: DeepSearch vs DeeperSearch ([S]);
   - NotebookLM: Fast Research vs Deep Research (Nov 2025, [S]).

   **→ Remove Quick/Standard/Deep/Max from every Juno surface. Let the planner size the run, and state
   the size as a time estimate and a scale sentence on the plan.** [I]
2. **The flow the leaders converged on in 2026** runs: describe the task → (optional) clarify → *a
   plan you can edit* → Start → *live progress you can steer* → *a full-screen report with a
   contents list and a sources rail* → export to Markdown, Word or PDF → follow-ups.
   - ChatGPT added the editable plan, mid-run steering, trusted-site limits, apps/MCP as sources and
     the full-screen reader on 10–11 Feb 2026 ([S] MacRumors, The Decoder, Neowin).
   - Gemini has had an editable plan since launch ([P] help; [S] ZenML write-up of the team's talk).
     It added *collaborative planning* to its API in Apr 2026 ([P] Gemini API docs).
3. **ChatGPT's 2026 version puts approving the plan where clarifying questions used to be.** One
   reviewer says it replaced the old up-front questions (Feb 2026, [S] Your Everyday AI). The help
   centre still says it *may* ask them ([S] help-centre extract). Juno today has two gates in a row
   (clarify, then plan), and the user pays attention twice. **→ Merge them into one "scope card".**
   [I]
4. **Live progress sits outside the message body.**
   - ChatGPT's original design opened a *right-hand sidebar* showing a summary of steps and sources
     (Feb 2025, [P] OpenAI launch post).
   - Gemini shows "Show thinking" and "Sites browsed". The count of sites updates live, and you can
     open a source while the run is still going ([P] Google blog; [S] ZenML).
   - Claude shows a live count of sources and the elapsed time ([S] hands-on reviews, Jun 2025).
   - Perplexity collapses to "Completed N steps", with a stack of favicons and a count of sources
     ([S] AI UX Playground, Jun 2026).

   **→ Juno's right dock, which the internal audit found empty during research, should become the
   live research panel. The transcript keeps one compact row.** [I]
5. **Everyone tells you that you can leave.** ChatGPT and Gemini notify you when the run finishes ([P]).
   Gemini built an asynchronous task manager for exactly this ([P] Gemini overview). **Juno has no
   notification channel at all.** [I, verified by grep]
6. **Report length differs sharply between products.** Reviewers see 30+ pages from ChatGPT and
   Gemini and about 5 from Claude ([S] 2025–26 comparisons). Gemini's team found that people *read a
   long wait as thoroughness* ([S] ZenML). **→ Juno should keep reports short by default, cited and
   expandable, and not pad them.** [I]
7. **Citation hover cards are now standard.** ChatGPT's inline chip shows the publisher's favicon
   and name, then "+N" when more sources back the claim. Its popover gives the headline, a dated
   snippet and a 1/N pager ([S] AI UX Playground, Jul 2026). Gemini numbers its citations, adds a
   Works Cited list, and separates sources it used from sources it read and did not use ([S]).
   **→ Juno can go further than all of them, because it stores the verbatim quote behind every
   finding. Put that quote in the hover card.** [I]
8. **Citation accuracy is the weak axis for everyone, and more searching makes it worse.**
   - Links worked 94–100% of the time, but only 39–77% of claims were actually supported by the page
     cited. Fact accuracy fell about 42% as tool calls went from 2 to 150 (2026, [P] arXiv 2605.06635).
   - 3–13% of the URLs deep-research agents cite are fabricated, the highest rate of any system type
     tested (2026, [P] arXiv 2604.03173).
   - Most citation errors in a final report enter at the orchestrator or writer. Handing the writer
     raw single-document snippets instead of synthesised notes cuts that error rate sharply (2026,
     [P] arXiv 2608.24306).

   **→ Juno's findings, each backed by a quote, are the right foundation. The writer must cite only
   pages it actually visited, work from quotes, and never label a claim "unsupported" when it was
   simply not checked.** [I]
9. **Two architecture schools.** The first is a single browsing model trained end-to-end with
   reinforcement learning: OpenAI's o3 deep research model and Kimi-Researcher ([P]). The second is
   an orchestrator with workers, where effort scaling lives in the prompt and a citation pass runs at
   the end: Anthropic ([P]), Perplexity Computer ([S]), and Microsoft's Critique, which splits
   generating from reviewing ([S]). Juno is already the second kind. **→ Borrow Anthropic's
   effort-scaling rules to size the run and a generate/critique split to check it, and keep the
   provider-neutral engine.** [I]
10. **Typical durations:**

    | Product | Typical run | Source |
    |---|---|---|
    | ChatGPT | 5–30 min, 8–45 min observed with steering | [P] launch post; [S] Feb 2026 review |
    | Claude | 5–45 min, most 5–15 | [P] Claude blog |
    | Gemini app | about 5–10 min | [P] help |
    | Gemini API | 60 min at most, most under 20 | [P] API docs |
    | Perplexity | 2–4 min at launch, about 3–6 min in 2026 | [S] |

    **→ Show an estimate before Start and a live "about N min left" during the run.** [I]
11. **Steering mid-run is now expected.** ChatGPT lets you interrupt with a follow-up or new sources
    without restarting ([S] Feb 2026). Anthropic writes that running subagents synchronously blocks
    steering ([P]). Juno's steering stops working once the plan is approved (internal UI audit,
    problem #1). **→ Make steering an explicit composer mode and apply it between rounds.** [I]
12. **Outputs are growing beyond the report.** In 2026 the outputs expanded:
    - ChatGPT Work can deliver research as an editable document, a presentation, a spreadsheet or a
      Site (Sep 2026, [S] release trackers).
    - Perplexity builds decks, dashboards and spreadsheets ([S]).
    - Gemini adds charts, infographics and interactive simulators, plus audio overviews ([P]/[S]).

    **→ This is P2 for Juno. Get the report, its citations and export right first.** [I]

---

## 2. Timeline

| Date | Product | Event | Source |
|---|---|---|---|
| Dec 2024 | Gemini | Deep Research launches in Gemini Advanced, with a plan you can edit before it runs | [K]; plan flow confirmed [P] help |
| 2025-02-02/03 | ChatGPT | Deep research launches for Pro, up to 100 queries a month, built on an early o3 tuned for browsing. It takes 5–30 min, shows a sidebar of steps and sources, and notifies when done | [P] launch post (PDF mirror) |
| 2025-02-14 | Perplexity | Deep Research launches: dozens of searches, hundreds of sources, 2–4 min, exports to PDF or a Page | [S] TechCrunch, Perplexity blog extract |
| 2025-02-25 | ChatGPT | System card: an early o3 trained with RL on browsing and Python tasks graded by rubric, with a separate o3-mini summarising the chain of thought | [P] system card |
| Feb–Mar 2025 | Grok | DeepSearch, then DeeperSearch | [S] |
| 2025-03-13 | Gemini | Deep Research free for all users | [P] Gemini release notes |
| 2025-03-19 | Gemini | Tips post: Edit plan, Show thinking, Sites browsed, Audio Overview, Export to Docs | [P] Google blog |
| 2025-04 | ChatGPT | BrowseComp benchmark released; deep research scores 51.5% | [S] |
| 2025-04-15 | Claude | Research beta for Max, Team and Enterprise in the US, Japan and Brazil | [P] Claude blog |
| 2025-04-24 | ChatGPT | Lightweight deep research on o4-mini, switched in automatically at the quota | [S] TechCrunch |
| 2025-05-01 | Claude | Advanced Research runs up to 45 min; Integrations launch | [P] Claude blog |
| 2025-05-20 | Gemini | Reports open in Canvas: visuals, quizzes, file uploads | [P] release notes |
| 2025-06-03 | Claude | Research reaches the Pro plan | [P] Claude blog |
| 2025-06-13 | Anthropic | "How we built our multi-agent research system" | [P] |
| 2025-06-20 | Kimi | Kimi-Researcher: end-to-end RL, about 23 steps and 200+ URLs per task | [P] |
| 2025-06-26 | OpenAI API | `o3-deep-research` and `o4-mini-deep-research` | [P] cookbook |
| 2025-07-17 | ChatGPT | Agent mode launches; deep research stays a separate entry in Tools | [S] |
| 2025-11-05 | Gemini | Gmail, Drive and Chat become research sources | [P] Google blog |
| 2025-11-13 | NotebookLM | Deep Research, alongside Fast Research | [S] 9to5Google, MakeUseOf |
| 2025-12-11 | Gemini API | Deep Research agent on Gemini 3 Pro: HLE 46.4%, DeepSearchQA 66.1%, BrowseComp 59.2% | [P] Google blog |
| 2026-02-04 | Perplexity | Advanced Deep Research on Opus 4.5 (later 4.6), plus the open DRACO benchmark | [S] TestingCatalog, AIM |
| 2026-02-05 | Claude | Opus 4.6: BrowseComp 86.8% with a multi-agent harness and compaction; HLE with tools 53.0% | [P] Anthropic |
| 2026-02-10/11 | ChatGPT | Deep research moves to GPT-5.2 and gains plan editing, live progress, interrupt and steer, trusted sites, MCP/apps, a full-screen reader with contents list, and MD/Word/PDF export | [S] MacRumors, The Decoder, Neowin |
| 2026-02-17 | Grok | Grok 4.20 beta with four agents (coordinator, research, logic, contrarian) | [S] |
| late Feb 2026 | Perplexity | Perplexity Computer, which orchestrates 20+ models | [S] |
| 2026-03-26 | ChatGPT | Legacy deep-research mode removed; old runs stay readable | [S] |
| 2026-03-30 | Microsoft | Researcher adds Critique (one model generates, another reviews) and Council (GPT and Claude run in parallel, a third model judges) | [S] |
| ~Mar 2026 | Gemini | Visual reports with charts, diagrams and simulators for Ultra; not offered when Gmail or Drive are sources | [S] |
| 2026-04-21 | Gemini API | Deep Research and Deep Research Max on Gemini 3.1 Pro: collaborative planning, MCP, inline charts | [P] Google blog, API docs |
| Jun 2026 | Claude Code | First-party `/deep-research` skill: fans out searches, fetches sources, checks claims adversarially, writes a cited report | [S] paddo.dev |
| 2026-06-11 | Perplexity | Deep Research moves inside Computer (Max only): BrowseComp 83.8%, HLE 50.5%, DeepSearchQA 85.0% | [S] MarkTechPost |
| 2026-07-21 | Gemini | Gemini 3.6 Flash supports Deep Research | [P] release notes |
| 2026-09-09/10 | ChatGPT | Deep research in ChatGPT Work and Codex, delivering a document, presentation, spreadsheet or Site | [S] releases.sh, Releasebot |

---

## 3. Product deep dives

Each product is described in the same order: entry → depth → clarify → plan → progress → steer and
stop → report → citations → export → follow-ups → notifications → limits → duration → architecture
→ benchmarks → failure modes → motion and visual design.

### 3.1 ChatGPT deep research (OpenAI)

**Entry.**
- 2025: you picked "deep research" in the composer and could attach files ([P] launch post).
- As of Sep 2026: the Tools "+" menu, or type `/deep research` ([P] OpenAI Academy, updated
  2026-09-02). A *redesigned entry point in the sidebar* arrived in Feb 2026 ([S] MacRumors),
  with a landing page of starter prompts and recent reports ([P] Academy).
- Since Sep 2026 it is also in ChatGPT Work and in Codex ([S]).
- Agent mode (Jul 2025) is a separate entry that also browses visually ([S]).

**Depth or levels.**
- The user never picks a level. There is one "deep research".
- A *lightweight* variant on o4-mini is used automatically once the full allowance is spent. OpenAI
  described it as shorter but keeping the depth and quality people expect (Apr 2025, [S] TechCrunch).
- Hovering the deep-research control shows how many runs are left and when the allowance resets
  ([S] 2026 guides).
- Published quotas have changed over time:
  - Pro: 100 a month at launch ([P]), then 250 a month, half of them lightweight (Jun 2025, [S]
    Wikipedia).
  - Plus, Team and Enterprise: 25 a month. Free: 5 a month, lightweight only (Apr–Jun 2025, [S]).
  - As of Sep 2026 OpenAI no longer prints counts for most plans. Guides cite "Limited / Expanded /
    Maximum" and an in-product counter that resets 30 days after first use ([S] McKelvey, 2026).
    Edu is said to get 5 per rolling 24 h ([S]).
  - ChatGPT Business charges about 50 workspace credits per extra task ([S]).

**Clarify.**
- ChatGPT's pipeline has three stages: an *intermediate model* (the docs name gpt-4.1) asks
  clarifying questions, the prompt is *rewritten*, and only then does the deep-research model run.
  The API skips the first two stages and recommends developers rebuild them ([P] OpenAI API guide
  and cookbook). The current API guide names a faster model for this; the text I read said
  `gpt-6-astra`.
- In 2025 the questions came as a short numbered list of about 2–5 plain-text questions. You could
  answer in free text or say "just start" [K].
- In the Feb 2026 flow, one hands-on review says the generated plan now needs explicit approval
  *instead of* the up-front questions ([S] Your Everyday AI, 2026-02-18). The help centre still says
  it "may ask clarifying questions" ([S] extract). **Inference:** questions are asked when the model
  judges them necessary; otherwise the plan does the clarifying. [I]

**Plan.**
- Since Feb 2026 you can see the plan and edit it before research starts ([S] multiple).
- An "Update" control lets you change the approach ([S] Your Everyday AI).
- Whether the plan starts on its own after a countdown is **not documented anywhere I could reach**.
  I found no evidence of auto-start. [unknown]

**Source controls (Feb 2026).**
- "Manage sites" lets you list domains, with a switch between *only these sites* and *prioritise
  these sites but allow the full web* ([S] Your Everyday AI; [P] Academy).
- Apps and MCP servers act as read-only sources, and admins govern them with role-based access
  ([P] Academy).
- Files can be uploaded at the start and during the run ([S]).

**Live progress.**
- 2025: once running, a **sidebar opened on the right** with a summary of the steps taken and the
  sources used ([P] launch post). A 2025 hands-on reported a right panel showing activity and sources
  in real time, finishing in 11 minutes after 25 sources ([S] search extract).
- The trace in the launch post uses a consistent grammar: **a short heading in the progressive form**
  ("Piecing together clues", "Clarifying key properties", "Choosing citations"), then a first-person
  paragraph of one or two sentences ("I'm narrowing down the search to …"), then search-action rows
  ([P] launch-post PDF).
- A **separate custom-prompted o3-mini** writes these summaries of the chain of thought ([P] system
  card).
- 2026: progress is visible live. A small grey link at the bottom opens the live activity: the
  hundreds of sources examined, the dozens that will be cited, and the reasoning steps ([S] Your
  Everyday AI).
- A finished message gets a one-line summary header along the lines of "Research completed in Nm ·
  N sources · M searches" [K].

**Steer, pause, stop.**
- 2026: you can interrupt with follow-up prompts or new sources and redirect *without restarting*
  ([S] The Decoder, Neowin, Android Central, blockchain.news).
- There is a stop or cancel control [K].
- I found no documented "finish now with what you have".

**Report.**
- 2025: the report arrived inside the chat. Embedded images and charts were promised "in the next
  few weeks" ([P] launch post).
- Since Feb 2026 there is a **full-screen document viewer**, separate from the chat window
  ([S] MacRumors, 2026-02-11; Your Everyday AI):
  - a **table of contents in a left column** that jumps to sections;
  - a **right column of citations** that can be expanded;
  - top-right actions: download, copy contents, and open the activity summary.
- ChatGPT Work (Sep 2026) can write the research as an editable document with citations, or as a
  presentation, spreadsheet or Site ([S]).

**Citations** (ChatGPT generally, as of Jul 2026, [S] AI UX Playground).
- Inline chips show the publisher's favicon and name ("Reuters", "AP News"), with **"+N"** when
  several sources back one claim. Long names get truncated.
- Clicking or hovering opens a popover anchored to the chip: publisher, full headline, a dated
  snippet, and a **1/N pager** for claims with several sources.
- A "Sources" row under the reply shows a favicon stack and opens a right-hand panel of cards
  (logo, headline, relative time, snippet).
- The teardown notes a weakness: opening a chip does not highlight the matching card in the panel.
- The API returns citations as annotations with `url`, `title`, `start_index` and `end_index`. The
  docs require inline citations to be visible and clickable ([P] API guide).

**Export.**
- 2025: native PDF export with styled text, tables, images and clickable citations, at first on the
  browser only ([S] Medium / allthings.how).
- Feb 2026: **Markdown, Word and PDF** ([S] MacRumors; gend.co).

**Follow-ups.** Ask in the same chat; the report is the context [K]. From 2026 you can steer mid-run
instead of starting again ([S]).

**Notifications.** You can step away and are notified when it finishes ([P] launch post).

**Duration.** 5–30 min at launch ([P]). With steering, 8–45 min was observed in Feb 2026 ([S]).

**Architecture.**
- An early version of o3 tuned for browsing, trained with RL on browsing tasks (search, click,
  scroll, read files) and a sandboxed Python tool. Tasks ran from auto-gradable ones to open-ended
  ones graded against rubrics by a chain-of-thought grader ([P] system card, 2025-02-25).
- The launch post plots pass rate against the maximum number of tool calls: **more browsing
  improved results** ([P]). Compare the 2026 paper in §10, which found more tool calls *reduced*
  factual accuracy of citations.
- It moved to a GPT-5.2-based model on 2026-02-10 ([S]).
- API: `background: true` for long jobs, webhooks when done, `max_tool_calls` to cap cost, and tools
  for web search, file search (up to 2 vector stores), remote MCP (search/fetch shape) and a code
  interpreter ([P] API guide). Background mode keeps data about 10 minutes, so it is not compatible
  with zero data retention ([P]).
- Safety guidance: prompt injection and data exfiltration through web pages and MCP. Advised
  mitigations are trusted servers only, logging tool calls, doing public research and private access
  as separate stages, and validating tool arguments ([P]).

**Benchmarks.**

| Benchmark | Score | Date | Source |
|---|---|---|---|
| Humanity's Last Exam | 26.6% | Feb 2025 | [P] |
| BrowseComp | 51.5% | Apr 2025 | [S] |
| DeepResearch Bench (RACE overall / citation accuracy / effective citations) | 46.98 / 77.96% / 40.79 | 2025 leaderboard | [P] |

**Failure modes.**
- OpenAI's own list: hallucinated facts and wrong inferences, trouble telling authoritative
  information from rumour, poor confidence calibration, and formatting errors in reports and
  citations ([P] launch post).
- Researchers warn that people may take the output uncritically ([S] Wikipedia).
- Reports run long ([S] comparisons).
- Prompt injection and exfiltration through connected sources ([P]).

**Motion and visual design** [K unless marked]:
- The active status line uses ChatGPT's **shimmering text**, a moving gradient clipped to the
  glyphs, a technique widely copied ([S] CodePen/Medium recreations).
- The activity panel slides in from the right edge. Step headings appear in order, each with its
  summary paragraph beneath, and source rows show favicons.
- When finished, the live state collapses to a single summary line that can be opened again.
- The 2026 reader is a full-screen overlay with three columns ([S]).

### 3.2 Claude Research (Anthropic)

**Entry.** Click "+" at the bottom left of the composer, then **Research**. A blue indicator shows it
is on, and clicking it again turns it off. Web search must be on. Paid plans only (Pro, Max, Team,
Enterprise) on web, desktop and mobile. (As of Jun 2026, [P] Claude help centre, updated 2026-06-02.)
An earlier UI put the toggle under a "Search and tools" control ([S]).

**Depth or levels.**
- A single toggle. The help centre's guidance ([P], Jun 2026):
  - *web search* for questions one or two tool calls can answer;
  - *extended thinking* for reasoning that needs no fresh data;
  - *Research* for work needing five or more tool calls over one to three minutes or more;
  - Research and extended thinking can be combined.
- Effort is scaled **by the lead agent itself**, from rules in its prompt ([P] engineering post,
  2025-06-13):
  - simple fact-finding: one agent, 3–10 tool calls;
  - direct comparisons: 2–4 subagents, 10–15 calls each;
  - complex research: 10 or more subagents with clearly divided responsibilities.
- Runs last "five to 45 minutes" depending on complexity, and most finish in 5–15 ([P] Claude blog,
  May 2025).

**Clarify.**
- The model asks questions *as ordinary chat text* when it thinks they are needed. In one review it
  asked three, about scope, time horizon and emphasis (Jun 2025, [S] AI Goes to College).
- It does not always ask: another reviewer got none ([S] Micah Walter, Jun 2025).
- The help centre does not describe this step ([P]).

**Plan.**
- There is **no editable plan gate**. The lead agent plans and saves the plan to memory so it
  survives the context window being truncated ([P] engineering post).
- One review describes a breakdown of the query into parts being shown at the start ([S] Micah
  Walter). The Academy tutorial says Claude "plans its approach" before searching ([P] Academy).

**Live progress.** A counter of sources ("over 450", "709") and the elapsed time are visible ([S]
Micah Walter; AI Goes to College). The research process can be opened [K]. The Academy mentions
progress indicators while Claude searches and analyses ([P]).

**Steer and stop.** Mid-run steering is not documented. Anthropic's post says the lead waits for its
subagents synchronously, which *prevents steering* during their work and lets one slow subagent hold
up the whole run ([P]).

**Report.**
- A cited report delivered in an artifact or document pane beside the chat. One test produced 8
  pages ([S] AI Goes to College).
- Reviewers see Claude's reports as **concise** (about 5 pages) next to 30+ from ChatGPT and Gemini
  ([S] comparisons).
- Downloadable as **Markdown or PDF** ([S] Micah Walter). Can be published as a shared artifact ([S]).

**Citations.** "Every claim … links back to its source" ([P] Academy). A dedicated
**CitationAgent** processes the finished draft to place citations at specific spans ([P] engineering
post). In DeepResearch Bench, Claude with search showed the highest citation accuracy among LLMs
with search tools ([P] benchmark paper extract). One 2026 study put it at 94% against 78% for
OpenAI deep research ([S] search extract of arXiv 2605.06635).

**Limits.** Research counts against normal usage but uses limits up faster ([P] help).

**Architecture** (as of Jun 2025, [P] engineering post):
- **Orchestrator and workers.** A LeadResearcher plans, starts 3–5 subagents in parallel, and each
  subagent calls 3+ tools in parallel. This cut research time by up to 90% on complex queries.
- **Memory** keeps the plan once the context passes about 200k tokens.
- **CitationAgent** runs as a separate final pass.
- **Token economics.** A multi-agent run uses about 15× the tokens of a chat, and a single agent
  about 4×. On BrowseComp, token usage alone explains about 80% of the variance in performance; token
  usage, tool calls and model choice together explain about 95%.
- **Result.** Multi-agent Opus 4 with Sonnet 4 workers beat single-agent Opus 4 by 90.2% on an
  internal eval.
- **Prompting lessons:**
  - start with short, broad queries, then narrow;
  - use extended thinking to plan and interleaved thinking after each tool result;
  - give each tool a clear, distinct description;
  - apply heuristics against SEO content farms and prefer primary sources;
  - brief each delegate fully: objective, output format, tool guidance and boundaries;
  - a tool-testing agent that rewrote tool descriptions cut task time by 40%.
- **Evaluation.** Start with about 20 real queries. An LLM judge scores factual accuracy, citation
  accuracy, completeness, source quality and tool efficiency. Human testers catch bias in source
  selection.
- **Production.** Execution has to be durable and resumable, errors have to be handled so agents
  can adapt, full tracing is needed, and "rainbow deployments" protect runs that are already in
  flight.

**2026 state.**
- The consumer Research help article was updated in Jun 2026 but describes no change to the UX ([P]).
- Claude Code gained a first-party **`/deep-research` skill** that fans out searches, fetches
  sources, *adversarially verifies claims* and writes a cited report (Jun 2026, [S] paddo.dev).
- Opus 4.6 scored **BrowseComp 86.8%** (multi-agent, with web search, fetch and compaction) and
  **HLE with tools 53.0%** (2026-02-05, [P]).
- Opus 5.5 (2026-09-22) is described as a reliable researcher on report tasks that include fact
  checking ([S] release tracker).

**Motion and visual design** [K]. The live block has a subdued animated indicator, a source counter
that ticks up, and an elapsed timer. When the run ends, a document card opens in the side pane. The
colour and weight are quiet, with no large progress bars.

### 3.3 Gemini Deep Research (Google): app and API

**Entry (app).** Click **Deep Research** in the prompt box's tools. Choose the sources: Google Search
is always included, and Gmail, Drive, Chat and NotebookLM notebooks can be added when those apps are
connected ([P] Gemini help, desktop). The source picker is a dropdown inside Tools (Nov 2025, [P]
Google blog).

**Depth or levels.**
- The app has **one** Deep Research. Its model has moved over time: 1.5 Pro → 2.0 Flash Thinking →
  2.5 Pro → Gemini 3 ([P] Gemini overview). Gemini 3.6 Flash also supports it from 2026-07-21 ([P]
  release notes). Paid tiers get higher limits, not a different named mode ([P] help).
- The **API** exposes two agents (Apr 2026, [P]):
  - `deep-research-preview-04-2026`, "for speed & efficiency", meant to be streamed into a UI;
  - `deep-research-max-preview-04-2026`, for maximum comprehensiveness in asynchronous or background
    jobs such as nightly reports, using more compute at test time to reason, search and refine.

  Google frames the choice by *use case*, not as a quality ladder.

**Clarify.** The plan is where clarification happens. The team's reasoning was that a person given a
research task would ask questions first. They call the editable plan an "editable chain of thought"
([S] ZenML write-up of the Gemini team's talk).

**Plan.**
- Gemini writes a multi-step research plan. **Edit plan** (in natural language) comes before
  **Start research** ([P] help; [P] tips post, Mar 2025).
- The team added an explicit Edit button after finding that *people did not edit the plan by
  chatting*: the ability had to be visible ([S] ZenML).
- The API has the same flow: `collaborative_planning=True` returns a plan, the user refines it with
  `previous_interaction_id`, and setting the flag to false runs it ([P] API docs).

**Live progress.**
- **Show thinking** lists the reasoning steps. **Sites browsed** lists the websites ([P] tips post).
- The count of sites **updates as it changes**, and you can **open any source mid-run** ([S] ZenML,
  where the team calls this a deliberate choice for trust; [S] Explore AI Together).
- The API streams `step.delta` events carrying `thought`, `text` or `image`, needs
  `thinking_summaries: "auto"`, and resumes with `last_event_id` after a dropped connection (about
  600 s timeout) ([P] API docs).

**Leaving and notification.** "You can leave the chat" and Gemini notifies you on web or mobile ([P]
help). Google built an **asynchronous task manager** that keeps state shared between the planner and
the task models, so one failed call does not restart the job ([P] Gemini overview). The team built
new infrastructure for scheduling, state, recovery, progress and notifications *across devices*
([S] ZenML).

**Duration and the latency paradox.**
- About 5–10 min in the app ([P] help). The API allows 60 min at most and most jobs finish under 20
  ([P]).
- The team had a 15-minute "hardcore mode" but shipped a 5-minute version with hard limits. Looking
  back, they said users "would have tolerated or even preferred" longer runs, because people *read
  longer runs as thoroughness* ([S] ZenML).

**Report.**
- Opens as an **artifact beside the chat in Canvas** ([P] release notes, May 2025; [S] ZenML).
- Actions: **Export to Docs** (citations become a works-cited section), **Audio Overview** (a
  podcast-style discussion), and **create** a web page, infographic, quiz or visual ([P] help, tips).
- **Visual reports** for Ultra add embedded charts, diagrams and interactive simulators. They are not
  available when Gmail or Drive are used as sources ([S] gend.co, Mar 2026; Android Central).
- The API offers `visualization: "auto"` for inline charts, returned as base64 images ([P]).

**Citations.**
- Numbered inline citations point to a **Works Cited** list. Link dropdowns sit at the end of
  paragraphs ([S] Cottrill Research).
- Gemini separates **sources used in the report** from **sources read but not used**. A Nov 2025
  community thread reports a bug where every source was listed as "read but not used" ([S] Gemini
  community).
- Reviewers noted that citations **lack publication dates** (only the access date is shown) and that
  some linked sources did not quite match the text ([S] Cottrill).
- On DeepResearch Bench, Gemini 2.5 Pro Deep Research had the most **effective citations** (111.21
  per report) but lower accuracy (81.44%) than Perplexity (90.24%) ([P] leaderboard).

**Follow-ups.** Ask in the chat. Gemini answers from the research or goes back to the web ([P] tips).
The API continues with a normal Gemini model through `previous_interaction_id` ([P]).

**Cost (API).** Deep Research costs about $1–3 a task (about 80 searches, 250k input tokens, 60k
output). Max costs about $3–7 (about 160 searches, 900k input, 80k output) ([P] API docs).

**Architecture.**
- A planner breaks the task into sub-tasks and fans out many queries. Iterative planning grounds each
  step on everything gathered so far and looks for missing information and discrepancies ([S] ZenML;
  [P] Dec 2025 blog).
- A 1M-token context combined with RAG ([P] overview).
- A custom post-trained model. The team noted a tension: reasoning models may answer from memory
  instead of from sources ([S] ZenML).

**Evaluation.** An *ontology of use cases*: broad-and-shallow, deep-and-narrow, comparison and
compound. They also track behaviour: plan length, planning iterations, and sites browsed ([S] ZenML).

**Benchmarks.**
- Dec 2025 (Gemini 3 Pro agent): HLE 46.4%, DeepSearchQA 66.1%, BrowseComp 59.2% ([P]).
- DeepSearchQA is Google's benchmark: 900 hand-written causal-chain tasks across 17 fields, scored
  only when the answer set is *fully correct* ([P]/[S] Hugging Face paper page).
- Scores for Deep Research Max were not published in anything I could read.

**Motion and visual design** [K]. The plan card is a numbered list of steps with a "Ready in a few
mins" style estimate and two buttons (Edit plan, Start research). While running, a compact status
shows a count of sites that climbs, and the thinking panel expands inline. On completion the Canvas
panel slides in beside the chat.

### 3.4 Perplexity: Research, Labs, Advanced Deep Research, Computer

- **Research mode** (launched 2025-02-14 as "Deep Research"): dozens of searches, hundreds of
  sources, finishing "in 2–4 minutes". Exports to PDF or shares as a Perplexity Page. Free users get
  a small daily allowance and Pro gets much more ([S] TechCrunch, Perplexity blog extract). Guides
  describe 2,000–3,000-word outputs with PDF and document export ([S]).
- **Labs** (May 2025): 10+ minute projects that produce *assets* such as charts, spreadsheets and
  mini-apps [K]. It differs from Research by **what it produces, not by depth**. [I]
- **Advanced Deep Research** (2026-02-04): built on Claude Opus 4.5, then 4.6. Can produce
  presentations, spreadsheets, dashboards and websites. It came with the open **DRACO** benchmark: 100
  tasks across 10 domains and 40 countries, drawn from anonymised production queries and graded by an
  LLM judge against expert rubrics on accuracy, completeness, objectivity and citations. Max users
  first, then Pro ([S] TestingCatalog; [P] arXiv 2602.11685 abstract).
- **Deep Research inside Perplexity Computer** (2026-06-11, Max only) ([S] MarkTechPost;
  aiunpacker):
  - It orchestrates **20+ models**, with Opus 4.6 as the core engine, and uses "search as code" to
    run thousands of retrieval steps in parallel.
  - **It shows the subtasks and which model handles each one before running, and you can reassign
    them.**
  - Reported scores: BrowseComp 40.7% → 83.8%, HLE 36.4% → 50.5%, DeepSearchQA 81.9% → 85.0%.
  - DRACO average latency was about 460 s, and standard runs take about 3–6 min.
- **UI** (as of Jun 2026, [S] AI UX Playground):
  - a collapsed "Completed N steps" disclosure, with steps named in plain language ("Searching the
    web");
  - a **favicon stack with "N sources"** beside share, copy and rewrite;
  - inline chips showing the *domain* plus "+N", which open popovers with title, snippet and a 1/2
    pager;
  - a right-hand sources panel of cards (favicon, domain, title, snippet);
  - Answer, Links and Images tabs.
- **Benchmarks** ([P] DeepResearch Bench, 2025): the highest citation accuracy (90.24%) with the
  fewest effective citations (31.26), and RACE 42.25.

### 3.5 Grok DeepSearch and DeeperSearch (xAI)

- Turned on with a UI toggle, or by starting the prompt with "Use DeepSearch:" ([S] Suprmind 2026).
- The loop splits the question into sub-queries and searches **the web and X** in parallel. It
  follows fresh links, summarises each batch into a scratchpad, and stops at **10 steps or a time
  limit** ([S]).
- A "Thoughts" view shows the intermediate steps ([S]).
- **DeeperSearch** (Mar 2025) goes further through linked sources and takes noticeably longer ([S]).
- In 2026 the apps expose **Auto / Fast / Expert** modes, where Auto picks Fast or Expert, plus
  **Heavy**, marketed as 16 agents on the top tier ([S]).
- Grok 4.20 (beta 2026-02-17) runs four named agents: a coordinator, a researcher, a logic agent and
  a contrarian, which check each other ([S]).
- **This is the clearest example of named depth levels still being used.** [I]
- Failure modes reported:
  - reasoning mode raised hallucination on summarisation to 20.2%, against 5.8% without reasoning, on
    Vectara's benchmark;
  - "citation rigor inconsistent" ([S]).

### 3.6 Kimi-Researcher and Kimi Agent (Moonshot)

- **Kimi-Researcher** (2025-06-20) ([P] project page):
  - trained end-to-end with RL (REINFORCE) and three tools: parallel internal search, a text browser
    and code execution;
  - averages **23 reasoning steps and 200+ URLs** per task;
  - a *context-management* mechanism keeps what matters and drops documents it no longer needs,
    allowing trajectories of 50+ iterations and about 30% more iterations overall;
  - HLE rose from 8.6% to **26.9%** through RL alone; xbench-DeepSearch **69%**.
- Promised in the UX: interactive visual reports, research traces you can follow, and citations
  ([S]). Asking clarifying questions first is [K].
- **Kimi Agent** (as of Sep 2026, [P] Kimi help):
  - models K2 (Sep 2025), K2.5 (Jan 2026), K2.6 (Apr 2026) and K3 (Jul 2026);
  - task planning with a *real-time progress display*;
  - 20+ tools, and deliverables as Excel, Word, PPT, web pages or reports;
  - **Agent Swarm** coordinates up to 300 sub-agents and 4,000+ tool calls, about 4.5× faster than a
    single agent;
  - Deep Research produces long-form reports and *visualisation* reports.

### 3.7 Neighbours and successors

- **Microsoft 365 Copilot Researcher** (2026-03-30) ([S] Microsoft Tech Community extract,
  Constellation, Let's Data Science):
  - **Critique**: one model plans, retrieves and drafts; a second model from another lab reviews it as
    an expert before the final report.
  - **Council**: a GPT model and a Claude model write separately and in parallel. A third model judges
    them and shows where they agree and disagree.
  - Reported +7.0 points on DRACO over Perplexity Deep Research (Opus 4.6).
- **NotebookLM** (2025-11-13): **Fast Research vs Deep Research** from a picker on the left. Deep runs
  in the background, and you import its report and 20+ sources into the notebook ([S] 9to5Google,
  MakeUseOf).
- **Claude Code `/deep-research`** (Jun 2026): fans out searches, fetches, checks claims
  adversarially and writes a cited report ([S]).
- **OpenAI deep-research API** and the **Gemini Deep Research API**: described in §3.1 and §3.3
  ([P]).

---

## 4. Comparison matrix (as of Sep 2026)

| Stage | ChatGPT | Claude | Gemini app | Perplexity | Grok |
|---|---|---|---|---|---|
| Entry | Tools "+" / `/deep research` / sidebar entry [P][S] | "+" → Research, blue chip; needs web search [P] | Tools → Deep Research, with a source picker [P] | Mode: Research (Labs, Computer separate) [S] | Toggle or "Use DeepSearch:" [S] |
| Named depth levels | **None**; lightweight variant switched in by quota [S] | **None**; agent sizes itself [P] | **None** in app; API has DR vs Max [P] | By output type (Research, Labs, Computer), not depth [I] | **Yes**: DeepSearch/DeeperSearch, Fast/Expert/Heavy [S] |
| Clarify | Clarifier model plus prompt rewrite; in 2026 largely replaced by plan approval [P][S] | Model asks in chat, 0–3 questions [S] | The plan is the clarification [S] | Not up front [K] | No [K] |
| Plan gate | **Editable plan, explicit approval** (Feb 2026) [S] | None [P] | **Edit plan → Start research** [P] | Computer: subtask and model preview, reassignable [S] | Plan visible (unclear) [S] |
| Source controls | Sites only or prioritised; apps/MCP; files mid-run [S][P] | Web + Workspace + integrations [P] | Search + Gmail/Drive/Chat/NotebookLM [P] | Web + connectors + premium data [S] | Web + X [S] |
| Live progress | Right sidebar of steps and sources (2025); live activity link (2026) [P][S] | Source counter + timer [S] | Show thinking + Sites browsed, count updates live, sources clickable [P][S] | Steps list + favicon stack [S] | Thoughts view [S] |
| Mid-run steering | **Yes** (interrupt, add sources) [S] | No (synchronous subagents) [P] | No (task "locks") [S] | Computer: reassign subtasks [S] | No [K] |
| Leave and notify | Yes [P] | Unclear [K] | Yes, across devices [P] | Background (Computer) [S] | No [K] |
| Report surface | Full-screen viewer: contents left, citations right [S] | Artifact pane beside chat [S] | Canvas beside chat [P] | Inline answer + tabs; Pages [S] | Inline [S] |
| Citations | Favicon + name chips, +N, popover with snippet and pager [S] | Linked citations placed by a CitationAgent [P] | Numbered + Works Cited; used vs read-not-used [S] | Domain chips + N, popover pager [S] | Inline web and X [S] |
| Visuals | Images and charts [P] | Tables [K] | Charts, diagrams, simulators (Ultra), audio overview [S][P] | Charts, decks, dashboards [S] | No [K] |
| Export | **MD, Word, PDF** [S] | MD, PDF, artifact link [S] | **Docs**, audio, share [P] | PDF, Page, doc [S] | Copy [K] |
| Typical duration | 5–30 min (8–45 observed) | 5–45, most 5–15 | about 5–10 | about 2–6 | fast |
| Report length | Long (30+ pages observed) [S] | Concise (about 5 pages) [S] | Long [S] | 2–3k words [S] | Short [K] |
| Limits | Counter shown on hover; Pro 250 a month; others unpublished [S] | Counts against usage, burns faster [P] | Daily; higher for Pro/Ultra [P] | Pro limited; Max unlimited or credits [S] | Tiered [S] |

---

## 5. Choosing depth without named levels: what the leaders do instead

**The problem Juno has.** Juno surfaces four level names (Quick/Standard/Deep/Max) on the research
chip ("Deep research · Deep"). It derives the level from the chat model's cost tier plus the thinking
effort (`src/lib/research/auto-effort.ts:35-46`). The tier then changes the team size by 12×, the
pages by 24× and the wall clock by 12× (`domain.ts:1026-1075`), even though the report is written
by a different model from the one the person picked (internal UI audit #5). This combines the worst
of both approaches: a jargon label, and a control nobody knows they are using.

**Six patterns seen in the market:**

| Pattern | Who | How depth is set | What the user sees |
|---|---|---|---|
| A. The agent sizes itself | Claude ([P]) | Rules in the lead prompt tie query complexity to the number of agents and calls | Only duration and source count while it runs |
| B. A variant swapped in by quota | ChatGPT lightweight ([S]) | The system picks the smaller model when the allowance is low | A counter on hover; shorter reports |
| C. The plan shows the scope | Gemini, ChatGPT 2026 ([P][S]) | The number and breadth of plan steps *are* the scope; editing the plan changes the scope | A plan card with steps and a time estimate |
| D. Split by use case (API) | Gemini DR vs Max ([P]) | Interactive vs background | A developer choice, not a consumer one |
| E. Split by output type | Perplexity Research vs Labs vs Computer ([S]) | What you want back (answer, assets, deliverables) | Different modes |
| F. Named levels | Grok, NotebookLM ([S]) | The user picks | Labels such as "DeeperSearch" or "Deep" |

**Recommendation for Juno: A + C + B, and never F.** [I]

1. **The planner sizes the run (A).** One structured planner call returns the plan *and* a scope
   estimate: how many sub-questions, breadth (narrow, comparative or broad), freshness needs, and the
   expected number of sources. A deterministic function maps the estimate to workers, rounds, pages
   and wall clock, using Anthropic's rules as the starting table:
   - 1 sub-question: 1 worker, 3–10 calls;
   - 2–4: 2–4 workers, 10–15 calls each;
   - 5 or more, or broad: up to the cap.
2. **The plan card states the size in human terms (C):** "About 12 min · 5 questions · reads up to
   ~150 pages · stops at $4". The person changes the scope by **editing the plan**: removing a
   question shortens the run, and adding one or making it broader lengthens it. The estimate
   recalculates as they edit. No level word is ever shown.
3. **Budget and quota shape the run silently, and say so (B).** When the monthly research budget or
   the run's spend ceiling is low, the estimator shrinks the envelope and the card says one line:
   "Shortened to fit this month's research budget." Nobody picks it.
4. **Depth can be added after the fact instead of before.** The report offers "Go deeper" on a
   section, "Keep researching" while the run is live, and "Research this further" as a follow-up.
   This replaces "pick Max up front".
5. **Remove the coupling to the chat model and thinking effort** (`researchEffortFor`). Depth should
   follow the *question*, not the model picker. Keep one named research-lead model in settings and in
   the report's provenance line.

---

## 6. Progress UIs and motion: catalogue and what to adopt

### 6.1 Patterns observed

| Pattern | Seen in | Adopt? |
|---|---|---|
| A right-hand panel of live activity (steps and sources) | ChatGPT 2025 [P]; Claude process pane [K]; Perplexity sources panel [S] | **Yes.** It is the home of the live run [I] |
| Step headings in the progressive form plus a first-person line of 1–2 sentences, written by a separate summariser | ChatGPT [P] | **Yes.** Juno's lead/worker events can produce this grammar [I] |
| A single status line with shimmering text | ChatGPT [K], widely copied [S] | **Yes, on one element only.** Juno already has `shimmer-text` at 2.2 s [I] |
| A counter of sites or sources that updates as it changes | Gemini [S]; Claude [S] | **Yes**, with Juno's `RollingNumber`, throttled [I] |
| Sources open *during* the run | Gemini [S] | **Yes** [I] |
| Examined vs cited counts (hundreds vs dozens) | ChatGPT 2026 [S]; Gemini used vs read-not-used [S] | **Yes**: "212 read · 38 cited" [I] |
| Favicon stack + "N sources" | Perplexity [S]; ChatGPT Sources row [S] | **Yes** [I] |
| Collapse to "Completed N steps" / "Research completed in …" | Perplexity [S]; ChatGPT [K] | **Yes**, as the finished state of the transcript row [I] |
| Showing the plan and delegation (subtasks, who handles each) | Perplexity Computer [S] | **Partly.** Show sub-questions and their status, not model names [I] |
| Elapsed time; "you can leave" | Claude [S]; ChatGPT, Gemini [P] | **Yes.** Use working time only, as `workingElapsedMs` already does [I] |
| Live preview of the report's outline while writing | Not seen | **Optional (P2):** outline skeleton during synthesis [I] |

### 6.2 Grammar for the live activity

This is modelled on ChatGPT's published trace ([P] launch-post PDF) and adapted to Juno's events
(`domain.ts:392-445`). [I]

```
▸ Mapping the question                         (plan_drafted / plan_confirmed)
  I split this into 5 questions and will start with market size by region.
▸ Searching for EU adoption data                (worker_spawned + query_issued, one per worker)
  Three researchers are out. Eurostat and two trade bodies look like primary sources.
    ◦ "EU heat pump installations 2025 Eurostat"          12 results
    ◦ ec.europa.eu — Heat pumps in the EU (2026)            read · 3 quotes
▸ Checking what is still missing                (round_reviewed)
  Pricing is covered; installer capacity is thin, so I'm sending one researcher back.
▸ Writing the report                            (synthesizing)
▸ Checking 41 citations against their sources   (validating_citations)
```

Rules:
- Each heading is 2–5 words in the progressive form.
- The line under it is one first-person sentence written by the lead model at the round boundary.
  Do not summarise every page. [I]
- Query and page rows sit one level down and are collapsed by default after the step completes. [I]

### 6.3 Motion spec for Juno Research

All values use Juno's tokens (`internal-design-system-motion.md` §8). [I]

| Element | Trigger | Motion | Duration / easing | Reduced motion |
|---|---|---|---|---|
| Research chip | Armed from "+" | `pop` variant (y 4, scale .96→1) | `base` 220 / `spring` var (no overshoot) | opacity only, `fast` |
| Scope card | Planner returns | `rise` (y 6), then plan rows stagger 30 ms | `slow` 360 / `out-expo`; rows `base` | opacity, no stagger |
| Estimate line | Plan edited | digits roll (`RollingNumber`), and the text cross-fades if the unit changes | `base` / `in-out` | instant |
| Start → live row | Start | card height morphs to a one-line row; label cross-fades | `slow` 360 / `in-out`; label `fast` | cut plus opacity |
| Right dock | Start or row click | existing `slide-in-from-right-4` | `base` / `drawer`; exit `exit` 160 / `in` | fade |
| Live status sentence | Working states | `shimmer-text` loop, **on one element per screen**: in the dock header when it is open, otherwise in the transcript row | 2.2 s loop / `breathe` | static text + static dot |
| Activity step | New event batch (per flush, **keyed by event id, never re-keyed**) | opacity 0→1, y 4→0, stagger 30 ms within a batch | `base` / `out-soft` | opacity `fast` |
| Step completes | Next step starts | working glyph → check (`IconSwap`); heading ink foreground → muted | `fast` 120; ink `base` | swap without motion |
| Counters (read, cited, minutes) | Data change | `RollingNumber`, at most one update a second | `base` / `in-out` | jump |
| Favicon stack | New domain read | enters from x+8, scale .9→1, opacity; older favicons shift left; at most 5, then "+N" | `base` / `spring` var, 40 ms stagger | opacity only |
| Sub-question status dots | Coverage update | hollow → half → filled, with a text label (never colour alone) | `base` / `in-out` | instant + label |
| Writing phase | `synthesizing` | optional outline skeleton with `gen-sweep` 1.8 s | loop | static skeleton |
| **Completion** | `report_ready` | the row morphs into the report card (layout); the check draws once; the dock cross-fades from progress to the report; a toast if the person is elsewhere | one-shot `emphasis` 560 / `out-expo`; dock `slow` | opacity + text "Report ready" |
| Stop or pause | Control | the row's shimmer stops *at once* (no fade-out loop); the state sentence changes | `fast` | same |

**Budget for ambient loops:** at most **one** looping element visible at a time. This follows Juno's
existing "one breathing element on screen" rule (§9.4 of the motion audit), and it fixes the dozen
pulse rings the internal audit found (`run-timeline.tsx:686-705`).

---

## 7. Reports and citations: catalogue and target

### 7.1 What the leaders ship

- **Structure.** Title, then an executive summary, then themed sections with tables. ChatGPT and
  Gemini add long analytical sections, and Claude is shorter [S]. Gemini appends a numbered Works
  Cited and separates sources used from sources read but not used [S].
- **Reader.** ChatGPT's 2026 reader is full-screen with three columns: contents, document, citations
  [S]. Claude and Gemini put the report beside the chat as an artifact or in Canvas [S][P].
- **Citation affordance.** ChatGPT and Perplexity use a publisher chip with "+N" and a popover that
  pages through sources [S]. Gemini puts numbers at the end of paragraphs with dropdowns [S].
- **Outputs beyond text.** ChatGPT: images and charts, and in Work a document, deck, sheet or Site.
  Gemini: charts, simulators, audio, Docs. Perplexity: decks and dashboards [P][S].

### 7.2 Target for Juno [I]

1. **Bottom line first.** A one-paragraph answer of 60–120 words that answers the question as asked.
2. **Key findings.** 4–7 bullets, each cited.
3. **One section per plan question**, in the order the person approved. Each section opens with its
   answer, then gives the evidence. Use tables wherever there is a comparison.
4. **Where sources disagree.** Taken from Juno's `conflict_found` and `plan.conflicts`. No competitor
   gives this section its own heading; they fold it into the prose.
5. **What we could not establish.** Sub-questions left open or thin, stated honestly
   (`partially_completed`).
6. **Method.** One short paragraph: dates searched, number of sources read and cited, which search
   providers, the research-lead model, and a note if the provider roster is thin (a Juno truth already
   present in `run-timeline.tsx:589-633`).
7. **Sources.**
   - *Cited*: numbered, in citation order. Each entry gives publisher, title, **published date** (a
     gap Gemini leaves open) and accessed date.
   - *Read, not cited*: collapsed.

**Length policy.** Size to the scope, not to a level: about 600–1,200 words for 1–2 questions, about
1,500–3,000 for 5 or more. Never pad. A section can be expanded on request with "Go deeper". The
evidence: reviewers value Claude's brevity, and the ChatGPT/Gemini 30-page reports are a known
complaint ([S]). This also lowers citation error, because fewer claims means fewer chances to
mis-cite (§10).

**Citations.**
- Numbered superscripts `[n]`, stable across the report, rendered as small pills. This keeps Juno's
  numbered-corpus contract (`research-run-panel.tsx:115-120`).
- The hover or focus card shows favicon, publisher, title, published date, then **the verbatim quote
  that supports the claim**, highlighted. Juno already stores this quote in `ResearchFinding`, and no
  competitor shows one. The card also has **Open at passage**, using a text-fragment URL
  `#:~:text=…`, and a 1/N pager when a claim has several sources.
- A support mark per claim: *supported*, *partly supported*, or *not checked*. Use *unsupported* only
  when a judge actually looked (internal backend audit B4).

**Visuals (P2).** Charts only from numeric data extracted from a cited source, with that source cited
in the chart. No decorative images.

---

## 8. Architecture patterns and what they imply for Juno

| Pattern | Evidence | Implication for Juno |
|---|---|---|
| A single agent trained end-to-end with RL (browse + code) | OpenAI o3 DR [P]; Kimi-Researcher [P] | Not reproducible with provider APIs. Juno should stay orchestrated, and could use OpenAI's `o4-mini-deep-research` or Gemini's DR agent as optional *workers* (P2) [I] |
| Clarify → rewrite → research | OpenAI pipeline [P] | Juno's clarify (Haiku) + brief expansion already exist. Merge them into one planner call that also returns the scope estimate [I] |
| Orchestrator and workers, parallel subagents, prompt-based effort scaling, memory, a CitationAgent | Anthropic [P] | Juno has workers + lead + audit. Missing: prompt-based sizing (to replace tiers) and citation placement against raw quotes [I] |
| An async task manager with shared state; recover without restarting | Gemini [P] | Juno has durable runs and leases, but the internal audit found leases stall and double-run stages (B1–B3). **Fixing these comes before any UX work** [I] |
| Stream with resume (`last_event_id`) | Gemini API [P] | Replace polling with SSE and `Last-Event-ID`; keep polling as a fallback [I] |
| Background mode + webhooks | OpenAI API [P] | Juno's worker is already background. Add a notification fan-out on `report_ready` [I] |
| Generate/critique split across labs | Microsoft Critique [S] | For large scopes, a second-model review pass before the citation audit (P2) [I] |
| Context compaction for long searches | Opus 4.6 BrowseComp harness [P]; Kimi context management [P] | Workers should compact notes into findings (Juno's `page_summarized` already does this) and keep **quotes, not summaries**, for the writer [I] |
| Show subtask delegation before running | Perplexity Computer [S] | Show the sub-questions (not models) on the scope card [I] |

---

## 9. Benchmarks and evaluation

| Benchmark | Measures | Notable results (dated) |
|---|---|---|
| **BrowseComp** (OpenAI, Apr 2025; 1,266 questions) | Finding hard-to-find facts by persistent browsing | OpenAI DR 51.5% (2025) [S]; Gemini DR 59.2% (Dec 2025) [P]; Perplexity Computer DR 83.8% (Jun 2026) [S]; Claude Opus 4.6 multi-agent 86.8% (Feb 2026) [P] |
| **Humanity's Last Exam** (with tools) | Expert reasoning with retrieval | OpenAI DR 26.6% (Feb 2025) [P]; Kimi-Researcher 26.9% (Jun 2025) [P]; Gemini DR 46.4% (Dec 2025) [P]; Perplexity 50.5% (Jun 2026) [S]; Opus 4.6 53.0% (Feb 2026) [P] |
| **DeepSearchQA** (Google, 900 tasks, 17 fields) | Complete answer sets over causal chains | Gemini DR 66.1% [P]; Perplexity 85.0% [S] |
| **DeepResearch Bench** (100 PhD-level tasks, 22 fields; RACE + FACT) | Report quality (comprehensiveness, depth, instruction following, readability) and citation reliability | Gemini-2.5-Pro DR RACE 48.88 / citation accuracy 81.44% / 111.21 effective citations; OpenAI DR 46.98 / 77.96% / 40.79; Perplexity DR 42.25 / 90.24% / 31.26 [P]. DRB II was reported in Feb 2026 [S] |
| **DRACO** (Perplexity with Harvard, Feb 2026; 100 tasks, 10 domains) | Accuracy, completeness, objectivity, citation, against expert rubrics | Microsoft Researcher + Critique +7.0 over Perplexity DR (Opus 4.6) [S] |
| **xbench-DeepSearch** | Deep search | Kimi-Researcher 69% [P] |

**What Juno should run** [I]. There is no need to chase leaderboards. Build the harness Anthropic
describes:
- 20–40 real Juno research prompts, sampled across Gemini's four use-case types (broad-and-shallow,
  deep-and-narrow, comparison, compound).
- An LLM judge on Anthropic's five dimensions.
- A FACT-style citation check. Juno's `claims.ts` / `claim-analysis.ts` can supply this.
- **Behaviour metrics:** minutes, pages read, cited/read ratio, spend, citation-support rate, and
  support rate against tool calls. That last one watches for the information-overload effect in §10.
- A 10–20-task DRACO or DeepResearch Bench subset, run monthly, to sanity-check model swaps.

---

## 10. Failure modes, with evidence, and Juno mitigations

| Failure | Evidence | Mitigation in Juno [I] |
|---|---|---|
| **Citations that do not support the claim** | The link works 94–100% of the time, but only 39–77% of cited claims are supported ([P] arXiv 2605.06635, 2026) | Allow a claim to be cited only when it matches a stored quote. Audit every claim, not only the first 40 (backend audit B22). Show support marks |
| **Information overload**: more searching gives worse facts | Fact accuracy fell about 42% as tool calls went from 2 to 150 ([P] same paper). OpenAI's 2025 chart shows pass rate *rising* with tool calls ([P]) | Stop on *saturation*, not on page quotas. Write from findings, not the whole corpus. The context budget in synthesis is missing today (backend B7) |
| **Fabricated or dead URLs** | 3–13% hallucinated URLs and 5–18% not resolving; DR agents worst; a checker tool cut the rate to under 1% ([P] arXiv 2604.03173) | Restrict the writer to IDs of visited sources, never raw URLs. Check each URL's health before publishing. Record the snapshot date |
| **Errors introduced by the orchestrator or writer** | Most final-report citation errors start at the orchestrator. Raw snippets give 3.8% error vs 70.8% for synthesised notes ([P] arXiv 2608.24306) | The writer gets `claim + quote + source id` from `ResearchFinding` rather than summaries. Add a guideline: never state something uncited |
| **Hallucinated facts, rumour taken as authority, poor calibration** | OpenAI's own limitations list ([P]) | Source-quality heuristics (primary > aggregator > SEO), "Where sources disagree" and "What we could not establish" sections, plain-language confidence |
| **SEO content farms** | Anthropic's lesson ([P]) | Keep the ranking penalties; show the source type in the Sources tab |
| **Stale sources and missing dates** | Gemini citations lack dates ([S]); stale URLs ([P]) | Extract published dates, apply the freshness rule from the plan's evidence contract, and show the date in hover cards |
| **Over-long reports** | 30+ pages from ChatGPT and Gemini ([S]) | Length policy in §7.2 |
| **Reasoning models answering from memory** | Gemini team ([S]) | Juno already refuses to answer silently from model knowledge (`research-workspace.md`). Keep that |
| **Prompt injection and exfiltration** through pages or MCP | OpenAI API guide ([P]); OpenAI system card trained resistance ([P]) | Page text is already handled as untrusted. Stage private sources separately; never put private data into URLs |
| **No steering while subagents run** | Anthropic ([P]) | Apply steering at round boundaries and let the lead re-plan (§11.12) |
| **Losing work on failure** | Gemini's async manager ([P]); Anthropic's resumable runs ([P]) | Fix Juno's lease release and heartbeats (backend B1–B3) |

---

## 11. Redesign recommendation for Juno Research (prioritised)

### 11.1 Principles

1. **One feature, called Research.** No "Deep", no depth names, anywhere: UI strings, tooltips, wire
   fields shown to clients, or the native mirror. Prompts written for the model can keep any wording.
2. **One gate before spending, none for small jobs.** Questions and plan share a single scope card. A
   tiny scope starts straight away, as Claude does.
3. **The transcript holds the conversation; the right dock holds the work; the report is a document.**
4. **Honest numbers.** Working time, "read" vs "cited", spend against the ceiling. At most one moving
   thing per screen.
5. **Every claim can be traced to a visited page and a quote.**
6. **You can leave, and Juno tells you when it is done.**
7. **Steering is an explicit mode**, not a side effect of `isBusy`.

### 11.2 States the user can see, mapped to the engine

| User-visible state | Sentence (copy) | Engine states |
|---|---|---|
| Armed | chip "Research" | none (composer) |
| Scoping | "Working out the plan…" | `accepted`, `clarifying`, `planning` |
| Needs you | "Check the plan to start" | `awaiting_clarification` + `awaiting_plan_confirmation` → **merged** into `awaiting_scope_confirmation` |
| Researching | "Searching and reading · 43 sources so far" / "Checking what's still missing" | `investigating`, `reviewing` |
| Writing | "Writing the report" | `synthesizing` |
| Checking | "Checking 41 citations against their sources" | `validating_citations` |
| Paused | "Paused. Nothing is being spent." | `paused` |
| Needs input mid-run | "A question for you" | `awaiting_user_input` |
| Done | "Report ready" | `completed` |
| Done with gaps | "Report ready. Two questions stayed open." | `partially_completed` |
| Stopped | "Stopped. Nothing was written." / "Stopped early. Report written from what was found." | `cancelled` / finish-now → `partially_completed` |
| Couldn't finish | "Couldn't finish: <reason>. You weren't charged for the report." | `failed` |

### 11.3 Wireframes

```
TRANSCRIPT (conversation column)
────────────────────────────────────────────────────────────────
 You: How big is the EU heat-pump installer shortage, and who is fixing it?

 ┌ Research ─────────────────────────────────────────────────┐
 │ How big is the EU heat-pump installer shortage…           │   ← scope card (one gate)
 │ I'll size the gap by country, then look at training       │
 │ programmes and manufacturer schemes, favouring EU and     │
 │ national statistics.                                      │
 │                                                           │
 │ What I'll look into                          [+ Add]      │
 │  1. Installer shortfall by country, 2024–2026     ⋮  ✕    │
 │  2. Training capacity and pipelines               ⋮  ✕    │
 │  3. Manufacturer and utility programmes           ⋮  ✕    │
 │  4. Policy levers (EU and national)               ⋮  ✕    │
 │                                                           │
 │ Would sharpen this (optional)                             │
 │  Which countries matter most?  [All EU] [DE, FR, IT] [__] │
 │                                                           │
 │ Sources  Web · Prioritise: eurostat.ec.europa.eu  [Edit]  │
 │ About 12 min · reads up to ~150 pages · stops at $4       │
 │                                      [Edit in chat] [Start ⌘↵] │
 └───────────────────────────────────────────────────────────┘

 after Start, the card becomes one row:
 ◌ Searching and reading · 6 min · ◐◑◒◓◔ 43 sources     Open ›
                                         (favicon stack)

 after completion, the row becomes the answer:
 Juno: The EU is short of roughly … [1][2] …  (120–250 words, cited)
 ┌ Report ───────────────────────────────────────────────────┐
 │ The EU heat-pump installer gap, 2024–2026                 │
 │ 14 min · 38 cited of 212 read · every citation checked    │
 │                                         [Open report]     │
 └───────────────────────────────────────────────────────────┘

RIGHT DOCK: live (replaces the empty/stale thought panel during research)
──────────────────────────────────────
 How big is the EU heat-pump installer…
 Searching and reading                  ⏸  Finish now  ⋯
 6 min · about 6 left · $1.40 of $4
 [ Progress ] [ Sources 212 ] [ Plan ]
 ── Questions ─────────────────────────
  ● Installer shortfall by country    covered
  ◐ Training capacity                 in progress
  ○ Manufacturer programmes           next
  ○ Policy levers                     next
 ── Activity ──────────────────────────
  ✓ Mapping the question
    Split into 4 questions; starting with country data.
  ◌ Searching for training capacity
    Two researchers are reading national apprenticeship data.
      ◦ "Germany SHK Ausbildung Wärmepumpe 2025"   9 results
      ◦ bibb.de: Ausbildungszahlen 2025       read · 2 quotes
 ── Found so far ──────────────────────
  "Germany needs ~60,000 more installers by 2030"  bibb.de
 (when scrolled up: [Jump to latest])

RIGHT DOCK: finished (same dock, cross-fades to the reader)
──────────────────────────────────────
 The EU heat-pump installer gap…  [⤢ Full screen] [Export ▾] [Share]
 Contents ▾
 Bottom line …[1][2]
 Key findings …
 (hover [2] → card: favicon · publisher · title · 12 Mar 2026
              "…the quoted sentence that supports the claim…"
              Open at passage ›      1/2 ‹ ›)

FULL-SCREEN READER (ChatGPT 2026 layout, Juno styling)
┌ Contents ─┬──────── Document ────────────┬─ Sources ──────┐
│ Bottom    │                              │ Cited (38)     │
│ line      │                              │ [1] Eurostat…  │
│ Findings  │                              │ Read, not cited│
│ 1 …       │                              │  (174) ▸       │
└───────────┴──────────────────────────────┴────────────────┘
```

On mobile, the dock becomes a full-height bottom sheet with the same three tabs, and the reader
becomes a full-screen page with the contents list in a menu. [I]

### 11.4 Entry and arming [I]

- The "+" menu item and chip are called **"Research"**. The chip carries **no detail word**.
- The tooltip reads: "Plans, reads the web and writes a cited report · usually 5–15 min". Add a
  quota or budget line in the style of ChatGPT's hover counter: "9 left this month" or "$22 of $30
  research budget left".
- Add a `/research` slash command.
- **Offer something quicker when it fits.** If the triage or planner judges the question to need one
  or two lookups (Claude's help draws the line at five or more tool calls), the scope card opens with
  "This looks quick. Answer with a web search instead?" [Answer now] [Research anyway]. That saves
  money and time on questions a normal search answers.
- Respect workspace and plan permissions **before** arming. The composer should not offer what the
  server will drop (internal UI audit #7).

### 11.5 Scope card: clarify and plan merged [I]

- Show the planner's approach sentence, 3–6 questions editable in place (reword, reorder, remove,
  add), and ≤3 optional clarifications. The clarifications carry suggestion chips that *fill the
  field* (Juno's current `ClarifyGate` already does this).
- Sources row: "Web" plus preferred sites, with an **only / prioritise** switch as in ChatGPT, plus
  attached files. Connectors come later, with staging (§10).
- The estimate line updates as the plan is edited.
- **Start** is primary and sticky. **Edit in chat** lets the person revise in natural language, as
  Gemini's Edit plan does. Cancel is secondary.
- Searches and evidence contracts stay behind "Details".
- **No auto-start by default.** No leader has been shown to do it, and it spends money. Offer a
  setting "Start research without confirming", default off. Runs sized at 1 question and ≤3 min
  skip the card.

### 11.6 Live run [I]

- **Transcript row** (one line): state sentence (shimmering only when the dock is closed), working
  time, favicon stack, "N sources", and "Open ›". Clicking opens the dock. The row does **not**
  expand into a console inside the transcript.
- **Right dock "Research"** with three tabs:
  - **Progress** (default): the questions with their status, the activity stream using the grammar
    in §6.2, and "Found so far" (the latest 3 findings with quotes).
  - **Sources**: sections for Cited (after writing) / Read / Found; each row gives favicon, title,
    domain, published date and number of quotes; there is a filter; rows open in a new tab.
  - **Plan**: the approved plan, including any steering changes.
- **Researcher lanes** collapse into a single line, "3 researchers working", which expands into lanes
  (Juno's `worker_*` events).
- **Coexistence with the canvas.** Keep the existing rule that the newest request wins. A live run
  shows its compact row whenever the dock has been taken by something else.

### 11.7 Steering, pause, stop [I]

- While a run is working, the composer shows a two-way switch: **Ask Juno** (normal chat, which must
  not affect the run) and **Guide the research**. Guidance is sent to `/steer`, appears in the
  activity stream as "You: focus on DE/FR/IT", and is applied at the next boundary between rounds.
- **Stop never follows an unrelated reply.** The composer's Stop controls only the chat stream
  (internal UI audit #2).
- Run controls live in the dock header: **Pause** / **Resume**, **Finish now** (write the report
  with what has been gathered), and **Cancel** in the overflow menu. Cancel asks for confirmation
  and states the spend so far.

### 11.8 Completion [I]

1. A **persisted assistant message**: a 120–250-word cited answer plus a report card. This gives one
   completion path (internal UI audit #3, #4).
2. The dock cross-fades to the report reader. **Full screen** opens the three-column reader.
3. **Notifications**:
   - the tab title becomes "Report ready · Juno" and the favicon gets a badge;
   - a toast if the person is elsewhere in the app;
   - an opt-in browser notification, asked for when they first press Start on a run estimated over 5
     min ("Notify me when it's ready");
   - native push through the Mac app;
   - optionally, email for runs over 15 min.
4. The report card shows provenance: working time, cited and read counts, the citation verdict, and
   the research-lead model.

### 11.9 Export, share, follow-ups [I]

- **Export**: Markdown (numbered footnotes plus a sources appendix; strip the model's own "Sources"
  section, internal audit #8), **DOCX**, **PDF** (reuse the print pipeline), and copy as rich text.
  Use the report title in file names, not `juno-deep-research-DATE.md`.
- **Share**: a read-only link to the report and its sources. Today "Share" copies the chat URL.
- **Follow-ups**:
  - the report is already scoped context for chat (keep this);
  - selecting text offers **Ask about this**, **Check this claim** (re-audits the claim and shows the
    quote) and **Go deeper**, which runs a scoped mini-run and appends a new version of the section;
  - **Update this report** re-runs the same plan for fresh data (P2). Scheduled refresh (P2) follows
    Perplexity's scheduled searches.

### 11.10 Copy to remove and add [I]

- **Remove:** "Deep research" (as the feature name in UI), "Quick", "Standard", "Deep", "Max",
  "Depth follows your model and thinking effort…", and "Pick a stronger model or raise thinking for
  a deeper run" (`composer.tsx:2512-2524`, `effort-copy.ts`).
- **Add:** "Research"; the estimate line; "You can leave. Juno will let you know when it's ready.";
  "Shortened to fit this month's research budget."; "Finish now"; "Guide the research".

### 11.11 Backend changes this implies

**P0: prerequisites and the contract the UI needs.**

1. **Replace tiers with a scope estimate.**
   - The planner's structured output (`plan-format.ts`) gains `scope: { questions, breadth, freshness,
     expectedSources, estimatedMinutes }`.
   - A pure function `envelopeFor(scope, money, quota)` returns the numbers the engine needs:
     workers, rounds, toolCallsPerWorker, pages, resultsPerQuery, tokens, wallClockMs, judgeCalls.
     Anthropic's rules are the table's anchors, clamped by the run's money ceiling.
   - Keep freezing the envelope on the run (`ResearchBudget`), minus the `effort` label.
   - **Delete `researchEffortFor`, `RESEARCH_EFFORT_COPY` and the effort chip.** Stop accepting
     `researchEffort` from clients: ignore it, logged, for one release.
   - Old runs keep `effort` for display only as a legacy field.
2. **One gate.**
   - The planner call returns the plan, ≤3 questions and the scope together. The state is
     `awaiting_scope_confirmation` (or `awaiting_plan_confirmation` reused).
   - One POST commits answers and edits. Answers still fold into `plan.constraints`, as they do today.
   - Skip the gate when `scope.questions ≤ 1 && estimatedMinutes ≤ 3`.
3. **One completion path.**
   - Every client uses the background engine.
   - On `report_ready`, persist an assistant `Message` (a summary with citations plus a `reportRef`)
     in the originating conversation.
   - The native path moves to the same contract (internal backend §3.1).
4. **Lease and heartbeat fixes** (internal backend B1–B3, B6–B8): release leases when parking at
   gates, send heartbeats through every long stage, reserve the writer's budget, and make an empty
   report `failed`, not `completed`.
5. **Streaming.**
   - `GET /api/research/[id]/stream` over SSE, with `Last-Event-ID` resume.
   - Events coalesced every ~500 ms, and source *deltas* sent instead of whole lists.
   - Polling stays as a fallback.
   - Add a server-written `activity` event per round, `{heading, line}`, from the lead model. This is
     the "summariser" grammar of §6.2, so the client never makes up prose.
6. **Steering that works.**
   - `/steer` is accepted in every working state and queued.
   - At the next boundary the lead reads the queue and may re-plan: add, drop or reword a question.
   - It emits `steering_applied` and `plan_revised`.
7. **Finish now.** A `control` action `finish` skips the remaining rounds and synthesises from the
   current findings, then ends `partially_completed` with a reason.
8. **Citation integrity.**
   - The writer receives `findings (claim, quote, sourceId)` and can cite **only** read `sourceId`s.
   - Audit every claim. "Not checked" is not "unsupported" (B4, B22).
   - Check URL health before publishing.
   - Extract and store the published date.
   - Strip the model's own trailing sources section.

**P1: product completeness.**

9. **Notifications.**
   - A `NotificationSubscription` table (Web Push, VAPID) and a fan-out on `report_ready` /
     `failed` / `awaiting_*`.
   - Email fallback for long runs, and native push through the Mac app.
10. **Structured report.** The writer returns a JSON outline (sections → paragraphs → claims →
    citation ids + support), and Markdown, DOCX and PDF render from it. This enables "Go deeper" on a
    section, versions, and the support marks.
11. **Quota model.** A monthly research allowance in runs or $, per plan, readable by the composer
    tooltip. The lighter envelope is substituted automatically, with the one-line disclosure.
12. **Source controls.** `preferredSites` with `mode: "only" | "prioritise"`, and attached files as
    sources. Connectors come later, staged separately from public web research.
13. **Evaluation harness** (§9) wired into CI as a nightly job over a fixed prompt set.

**P2: differentiation.**

14. "Go deeper" mini-runs per section, and report versions.
15. Scheduled refresh ("Update monthly").
16. Charts from extracted tables (code execution), always cited.
17. A critique pass by a second model for large scopes (Microsoft Critique).
18. Optional provider-native deep-research workers (OpenAI `o4-mini-deep-research`, Gemini DR agent)
    as one lane among many, with their citations normalised into Juno's corpus.

### 11.12 Order of work [I]

1. Backend P0 steps 4 → 1 → 2 → 3 → 5, in that order, so the UI has a truthful, streamable,
   single-path contract.
2. UI: scope card; transcript row and dock (Progress and Sources); completion message and dock
   reader; motion spec; copy sweep that removes the levels.
3. Backend P0 steps 6–8, with the UI for steering and finish-now.
4. Full-screen reader, export (DOCX, PDF), share link, notifications.
5. P1 steps 10–13, then P2.

---

## 12. Unknowns and open questions

- **ChatGPT plan auto-start:** is there a countdown, or does the plan wait for approval
  indefinitely? This could not be verified; the evidence points to explicit approval ([S]).
- **Claude Research in 2026:** no documented UX change since 2025 was found. The progress pane and
  report-pane details are [K] and should be checked against the live product before the redesign
  copies them.
- **Gemini Deep Research Max benchmark numbers** and the consumer app's mapping to Max (if any) were
  not published in anything I could read.
- **Perplexity 2026 in-app UI of Computer's plan preview** has only secondary descriptions.
- **Quotas in 2026** are mostly unpublished (ChatGPT) or tied to credits (Perplexity, ChatGPT
  Business). Juno has to set its own policy (§11.11 step 11).
- **Decision for Juno:** should research reports be written by the research-lead model (today's
  background path) or by the model the user selected? The recommendation is the lead model, named in
  provenance, with a setting to choose it. Tying it to the chat picker brings back the confusion
  levels were causing.

---

## 13. Sources (read 2026-09-23)

**OpenAI / ChatGPT**
- Introducing deep research (launch post, PDF mirror): https://cdn.openai.com/API/docs/deep_research_blog.pdf (page: https://openai.com/index/introducing-deep-research/)
- Deep Research System Card (2025-02-25): https://cdn.openai.com/deep-research-system-card.pdf
- Deep research in ChatGPT (help centre; 403 to fetcher, used via search extracts): https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt
- OpenAI Academy, Deep research resource (updated 2026-09-02): https://academy.openai.com/public/clubs/work-users-ynjqu/resources/deep-research
- Deep research API guide: https://developers.openai.com/api/docs/guides/deep-research
- Deep research API cookbook: https://developers.openai.com/cookbook/examples/deep_research_api/introduction_to_deep_research_api
- MacRumors, fullscreen document viewer (2026-02-11): https://www.macrumors.com/2026/02/11/chatgpt-deep-research-mode-document-viewer/
- The Decoder, GPT-5.2 + specific websites (2026-02-10): https://the-decoder.com/openais-deep-research-now-runs-on-gpt-5-2-and-lets-users-search-specific-websites/
- Neowin (2026-02): https://www.neowin.net/news/openai-upgrades-chatgpt-deep-research-with-gpt-52-and-real-time-controls/
- Your Everyday AI Ep 716 (2026-02-18): https://www.youreverydayai.com/ep-716-chatgpts-new-deep-research-update-5-ways-you-can-use-it-today/
- gend.co, ChatGPT deep research (2026-02-24): https://www.gend.co/blog/chatgpt-deep-research
- blockchain.news analysis of the Feb 2026 update: https://blockchain.news/ainews/openai-deep-research-update-app-connections-site-specific-search-real-time-progress-and-fullscreen-reports-2026-analysis
- TechCrunch, lightweight deep research (2025-04-24): https://techcrunch.com/2025/04/24/openai-rolls-out-a-lightweight-version-of-its-chatgpt-deep-research-tool/
- Wikipedia, ChatGPT Deep Research: https://en.wikipedia.org/wiki/ChatGPT_Deep_Research
- Legacy mode removal notice (2026-03-19): https://devicebase.net/en/openai-chatgpt/updates/legacy-deep-research-mode-deprecation-notice/8zc
- releases.sh, ChatGPT Sep 2026: https://releases.sh/openai/chatgpt ; Releasebot: https://releasebot.io/updates/openai/chatgpt
- Justin McKelvey, limits 2026: https://justinmckelvey.com/blog/chatgpt-deep-research
- aiinsider, 2026 guide: https://aiinsider.in/ai-learning/chatgpt-deep-research-feature-2026/
- AI UX Playground, ChatGPT citations (2026-07-10): https://aiuxplayground.com/teardowns/chatgpt/citations ; human-loop: https://aiuxplayground.com/teardowns/chatgpt/human-loop
- Agent mode (TechCrunch, 2025-07-17): https://techcrunch.com/2025/07/17/openai-launches-a-general-purpose-agent-in-chatgpt/

**Anthropic / Claude**
- How we built our multi-agent research system (2025-06-13): https://www.anthropic.com/engineering/multi-agent-research-system
- Claude takes research to new places (2025-04-15): https://claude.com/blog/research
- Claude can now connect to your world / Advanced Research (2025-05-01, updated 2025-06-03): https://claude.com/blog/integrations
- Use research on Claude (updated 2026-06-02): https://support.claude.com/en/articles/11088861-use-research-on-claude
- When should I use web search, extended thinking, and research? (updated 2026-06-02): https://support.claude.com/en/articles/11095361-when-should-i-use-web-search-extended-thinking-and-research
- Claude Academy, Using Research: https://academy.claude.com/tutorials/using-research
- Claude Opus 4.6 (2026-02-05): https://www.anthropic.com/news/claude-opus-4-6
- Micah Walter, hands-on (2025-06-04): https://www.micahwalter.com/posts/trying-out-claudes-research-mode
- AI Goes to College, hands-on (2025-06-10): https://aigoestocollege.substack.com/p/claude-releases-deep-research
- paddo.dev, three ways to build deep research with Claude: https://paddo.dev/blog/three-ways-deep-research-claude/
- Releasebot, Anthropic Sep 2026: https://releasebot.io/updates/anthropic

**Google / Gemini**
- Use Deep Research in Gemini Apps (help): https://support.google.com/gemini/answer/15719111
- Gemini Deep Research overview: https://gemini.google/overview/deep-research/
- Gemini release notes: https://gemini.google/release-notes/
- 6 tips for Deep Research (2025-03-19): https://blog.google/products-and-platforms/products/gemini/tips-how-to-use-deep-research/
- Deep Research with Gmail, Drive, Chat (2025-11-05): https://blog.google/products-and-platforms/products/gemini/deep-research-workspace-app-integration/
- Build with Gemini Deep Research (2025-12-11): https://blog.google/technology/developers/deep-research-agent-gemini-api/
- Deep Research Max (2026-04-21): https://blog.google/innovation-and-ai/models-and-research/gemini-models/next-generation-gemini-deep-research/
- Gemini Deep Research agent API docs: https://ai.google.dev/gemini-api/docs/deep-research
- Phil Schmid, Deep Research API update: https://www.philschmid.de/deep-research-update
- ZenML LLMOps DB, Building Gemini Deep Research: https://www.zenml.io/llmops-database/building-gemini-deep-research-an-agentic-research-assistant-with-custom-tuned-models
- gend.co, Gemini visual reports (2026-03-30): https://www.gend.co/blog/gemini-deep-research-visual-reports-2026
- Cottrill Research, source transparency: https://cottrillresearch.com/assessing-gemini-deep-research-with-2-5-pro-focus-on-source-transparency-and-relevancy/
- Gemini community thread, "read but not used": https://support.google.com/gemini/thread/389104437/deep-research-listing-all-sources-as-read-but-not-used?hl=en
- NotebookLM Deep Research: https://9to5google.com/2025/11/13/notebooklm-deep-research/ ; https://www.makeuseof.com/notebooklm-deep-research-fast-research/
- MindStudio, Deep Research Max review (2026-04-27): https://www.mindstudio.ai/blog/google-gemini-deep-research-max-api-review

**Perplexity**
- Introducing Perplexity Deep Research (2025-02-14): https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research ; TechCrunch: https://techcrunch.com/2025/02/15/perplexity-launches-its-own-freemium-deep-research-product/
- Advanced Deep Research + DRACO (2026-02-04): https://www.testingcatalog.com/perplexity-launches-advanced-deep-research-for-max-users/ ; DRACO paper: https://arxiv.org/abs/2602.11685
- Deep Research in Computer (2026-06-11): https://www.marktechpost.com/2026/06/11/perplexity-moves-deep-research-into-computer-routing-research-subtasks-across-20-frontier-models-for-reports-decks-and-dashboards/ ; https://aiunpacker.com/blog/perplexity-deep-research-comes-to-computer-new-ai-research-tool-explained
- AI UX Playground, Perplexity citations (2026-06-15): https://aiuxplayground.com/teardowns/perplexity/citations/

**xAI, Moonshot, Microsoft**
- Suprmind, Grok features 2026: https://suprmind.ai/hub/grok/grok-features/ ; BuildFastWithAI Grok DeepSearch review: https://www.buildfastwithai.com/ai-tools/grok-deepsearch
- Kimi-Researcher (2025-06-20): https://moonshotai.github.io/Kimi-Researcher/ ; Kimi Agent help: https://www.kimi.com/en/help/agent/agent-overview
- Microsoft Researcher, multi-model (2026-03-30): https://techcommunity.microsoft.com/blog/microsoft365copilotblog/introducing-multi-model-intelligence-in-researcher/4506011 ; https://www.constellationr.com/insights/news/microsoft-365-copilots-researcher-agent-goes-multi-model

**Benchmarks and failure-mode research**
- DeepResearch Bench: https://deepresearch-bench.github.io/ ; paper: https://arxiv.org/pdf/2506.11763
- DeepSearchQA: https://huggingface.co/papers/2601.20975
- BrowseComp: https://cdn.openai.com/pdf/5e10f4ab-d6f7-442e-9508-59515c65e35d/browsecomp.pdf
- Cited but Not Verified (2026): https://arxiv.org/html/2605.06635v1
- Detecting and Correcting Reference Hallucinations in Commercial LLMs and Deep Research Agents (2026): https://arxiv.org/html/2604.03173v1
- Who is the Agent to Blame? Localizing Faithfulness and Citation Mistakes in Agentic Deep Research (2026): https://arxiv.org/html/2608.24306
- Presenc AI, deep-research comparison (May 2026; marketing-grade, used only for rough ranges): https://presenc.ai/research/deep-research-mode-comparison-2026

**Juno files referenced**
- `src/lib/research/auto-effort.ts`, `src/lib/research/domain.ts` (tiers 950–1110, states 363–379,
  events 385–445), `src/components/research/effort-copy.ts`, `src/components/chat/composer.tsx`
  (2512–2527), `src/components/chat/research-run-panel.tsx`,
  `src/components/research/research-console.tsx`, `src/components/research/report-reader.tsx` (218),
  `src/components/chat/chat-view.tsx` (thought panel / canvas coexistence, 970–1010),
  `docs/research-workspace.md`, `docs/JUNO.md` (§ web search / deep research, 730–746).
