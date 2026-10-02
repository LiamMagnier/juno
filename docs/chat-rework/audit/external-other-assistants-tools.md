# External audit: how the other assistants implement tools, thinking and research

Audit date: **23 September 2026**. Scope: Google Gemini, Perplexity (Search, Research, Labs, Computer, Comet), xAI Grok, Mistral Le Chat (now **Vibe**), Microsoft Copilot, Meta AI, DeepSeek, Kimi, Manus and Genspark, plus the open standards: MCP 2025-11-25 and 2026-07-28, MCP Apps, Agent Skills, WebMCP, AG-UI/A2UI and the MCP Registry. Claude and ChatGPT appear only in the matrix, because their deep dives are separate audits.

This report feeds the Juno rework of tool calls, the thinking animation, the right sidebar and Deep Research. It is research only. No Juno source was changed.

## 0. Method and confidence labels

- Sources are official docs, help centers, changelogs and blogs first. Reputable press and third-party teardowns come second. I fetched or searched every one of them during this pass. Several vendor pages (perplexity.ai changelog/blog, help.openai.com, neowin, cybernews) returned HTTP 403 to the fetcher. For those I relied on search-engine abstracts of the same page and say so.
- Each claim carries a date and a link. Labels:
  - **[V]**: verified in a source dated 2026. The date given is the source's date.
  - **[V-25]**: verified, but the source is from 2025, so the claim may be stale.
  - **[3P]**: comes from a third-party guide or review, not the vendor. Treat it as likely, not certain.
  - **[O]**: well-known product behaviour from before 2026 that I did not re-verify in this pass.
  - **[I]**: my own inference or recommendation.
- Summaries are paraphrased. There are no long quotes.

---

## 1. Executive summary

1. **Chat assistants have become agent workspaces.** From Feb to Aug 2026 every major player shipped a long-running agent next to or inside chat:
   - Perplexity **Computer** (25 Feb 2026)
   - Mistral **Vibe Work**: Le Chat was renamed Vibe (28 May / 1 Jun 2026)
   - Google **Gemini Spark** (I/O, 19 May 2026)
   - OpenAI **ChatGPT Work** (9 Jul 2026)
   - xAI **Grok Bot** (11 Aug 2026)
   - Microsoft **Copilot Cowork** (GA 17 Sep 2026)

   All of them share one UX grammar: plan first, stream steps, use a side panel for progress and artifacts, ask before writes, and let work run in the background with a notification at the end.
2. **Tools are auto-invoked by default, and toggles are reserved for expensive modes.**
   - Gemini dropped the `@YouTube`/`@Maps` mention pattern in Oct 2025. Public services are now called from plain prompts.
   - Grok 4 was trained to pick its own tools.
   - Perplexity always searches.

   The only things still behind a menu are long or costly runs: Deep Research, image, video and music generation, and agent/Work modes. Search, fetch, code, maps and widgets are not.
3. **Standalone "Deep Research" is being absorbed into the general agent.**
   - Perplexity moved Deep Research *into* Computer in Jun 2026.
   - Mistral turned Deep Research into a *Skill* inside Vibe Work.
   - Microsoft **retired** consumer Deep Research on 18 Aug 2026.
   - ChatGPT's agent mode was removed in Aug 2026 in favour of ChatGPT Work.

   Only Gemini and ChatGPT still ship a dedicated research tool with its own report viewer.
4. **Named depth tiers are disappearing from consumer research.** No consumer research product exposes "Deep / Max"-style research tiers today.
   - Gemini's app has one "Deep Research". Its API splits Deep Research and Deep Research Max, but the app does not show that split.
   - ChatGPT has one "Deep research".
   - Where a depth choice survives, it is framed as **effort** on a slider (Perplexity: Light, Standard, High, Ultra) or as a model mode (Grok: Auto, Fast, Expert, Heavy).
   - Mistral collapsed "Think mode" into a plain fast/think toggle.

   This directly supports the user's request to drop Juno's `quick / standard / deep / max` names.
5. **Plan approval before long work is now table stakes.**
   - Gemini: "Edit plan" then "Start research".
   - ChatGPT Deep Research: editable plan since Feb 2026.
   - Perplexity Computer: plan previews with approval gates, May 2026.
   - Vibe Work: sign-off before execution.
   - Mistral Deep Research: editable plan, Jul 2025.
6. **Per-function write approvals with "Always allow" are the settled pattern.** Vibe Work offers Continue, Always allow or Decline, plus a per-connector **Functions** tab that splits *interactive* (write) tools from *read-only* tools. Perplexity added "Always ask" connector controls (Aug 2026). Gemini Spark stops before sending, modifying or purchasing. MCP marks tool annotations as untrusted hints, so the host must classify tools itself. Juno already does this in `action-approval.ts`.
7. **Thinking is moving *out* of the transcript.**
   - Gemini moved "Show thinking" from inline expansion to a separate bottom sheet (teardown Mar 2026; shipped in the May redesign).
   - ChatGPT opens an Activity side panel [O].
   - Perplexity collapses its steps to "Completed N steps".
   - Gemini added **"Answer now"** (Jan 2026) to cut thinking short without switching model.

   The consensus is a one-line live status in the transcript, with the full trace in a panel or sheet.
8. **Tool results render as native UI, not text.** Examples:
   - Gemini's map-first place cards (Dec 2025)
   - Perplexity finance, sports and weather widgets
   - Gemini dynamic view and visual layout (Nov 2025)
   - Claude inline visualisations (Mar 2026)
   - **MCP Apps**: `ui://` HTML resources in sandboxed iframes. MCP's first official extension, co-developed by Anthropic and OpenAI (Jan 2026) and adopted by Claude (26 Jan 2026) and by ChatGPT apps, which are now called "plugins".
9. **MCP changed a lot in 2026.** Spec **2026-07-28** makes the protocol stateless:
   - no `initialize`
   - no session IDs
   - Multi Round-Trip Requests (`input_required`) replace server-initiated elicitation and sampling
   - tasks move to an extension
   - Roots, Sampling and Logging are deprecated
   - `tools/list` results can be cached through `ttlMs`/`cacheScope`

   Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), `outputSchema`/`structuredContent`, `icons`, and the `isError` semantics that let the model self-correct are all current. Any Juno tool registry should follow this shape.
10. **Differentiators to borrow**, beyond table stakes:
    - live browser view with **take over** (Gemini Spark, Manus, Grok Bot)
    - task **replay** (Manus)
    - **wide/parallel subagent grids** (Manus Wide Research, Kimi Agent Swarm, Perplexity Computer, Meta AI)
    - claim-level **Check sources** on text selection (Perplexity, Jul 2026) and Gemini "Double-check"
    - **Model Council** multi-model comparison (Perplexity)
    - email-the-agent (Spark, Perplexity, Manus)
    - motion that tracks cognitive state (Gemini "Neural Expressive", May 2026)

---

## 2. Industry direction, September 2026

| Shift | Evidence (dated) | Implication for Juno [I] |
|---|---|---|
| Chat → agent workspace | Perplexity Computer launched 25 Feb 2026 as a multi-model agent ([Semafor](https://www.semafor.com/article/02/25/2026/perplexity-launches-computer-super-agent)) [V]. Vibe Work, 28 May 2026 ([Mistral](https://mistral.ai/news/vibe-agent/)) [V]. Gemini Spark, 19 May 2026 ([TechCrunch](https://techcrunch.com/2026/05/19/google-introduces-gemini-spark-a-24-7-agentic-assistant-with-gmail-integration/)) [V]. ChatGPT Work, 9 Jul 2026 ([Digital Applied](https://www.digitalapplied.com/blog/chatgpt-work-openai-agent-launch-2026)) [3P]. Grok Bot, 11 Aug 2026 ([AY Automate](https://www.ayautomate.com/blog/grok-bot-xai-ai-agents-explained)) [3P]. Copilot Cowork GA, 17 Sep 2026 ([Releasebot](https://releasebot.io/updates/microsoft/microsoft-copilot)) [3P]. | Chat and "Work" should share one tool, step and approval renderer. Juno already has Work and Code surfaces, so avoid building a third visual language. |
| Auto-invoked tools | Gemini dropped `@Maps`/`@YouTube`; public services are now auto-invoked from natural prompts (Oct 2025, [9to5Google](https://9to5google.com/2025/10/18/gemini-youtube-google-maps-apps/)) [V-25]. Grok 4 was trained with RL to choose tools itself (9 Jul 2025, [xAI](https://x.ai/news/grok-4)) [V-25]. | Web search, fetch and code should be available to the model on every turn by default, with a per-chat off switch, instead of the current opt-in `webSearch` toggle. |
| Research folds into the agent | Perplexity moved Deep Research into Computer (11 Jun 2026, [MarkTechPost](https://www.marktechpost.com/2026/06/11/perplexity-moves-deep-research-into-computer-routing-research-subtasks-across-20-frontier-models-for-reports-decks-and-dashboards/)) [3P]. Mistral turned legacy Deep Research into a Skill ([Mistral docs](https://docs.mistral.ai/vibe/choose-chat-work-code)) [V]. Copilot retired consumer Deep Research on 18 Aug 2026 ([GeekWire](https://www.geekwire.com/2026/microsoft-starts-merging-its-copilot-consumer-and-business-apps-in-advance-of-super-app-rollout/)) [V]. | Research should be one tool with one scope control. Its plan, progress and report should use the same components as agent tasks. |
| Tiers → effort | Perplexity added an Effort slider (Light, Standard, High, Ultra) on 17 Sep 2026; it maps to the orchestrator model and its reasoning depth ([SQ Magazine](https://sqmagazine.co.uk/perplexity-computer-effort-controls-model-selection/), [AlphaSignal](https://alphasignal.ai/news/perplexity-computer-adds-four-effort-presets-to-control-ai-task-depth)) [3P]. Vibe's Think mode became a fast/think toggle ([Mistral docs](https://docs.mistral.ai/vibe/choose-chat-work-code)) [V]. Claude added effort Low/Medium/High/Max on 28 May 2026 ([Linas](https://linas.substack.com/p/anthropic-claude-2026-every-launch-guide)) [3P]. | Replace named research tiers with a scope estimate derived from the plan and the reasoning effort. If a control is shown, express it as time and sources, not brand words. |
| Plan-then-execute | See §6. | The research plan card should be the template for every long task. |
| Side panel for progress | Gemini Spark: a work panel and a progress chip at the top of the thread ([Google Help](https://support.google.com/gemini/answer/17094507?hl=en&co=GENIE.Platform%3DDesktop)) [V]. Perplexity Computer: a context panel with live progress, artifacts and credits (29 May 2026, via search abstract of the [changelog](https://www.perplexity.ai/changelog/computer-in-microsoft-365-improved-context-visibility-and-new-analytics)) [V]. Vibe: a Todos panel ([Mistral docs](https://docs.mistral.ai/vibe/work/safety-and-approvals)) [V]. | The right sidebar should become an **Activity / Context panel** with Steps, Sources and Files, not just a thought dump. |
| Interactive UI in chat | MCP Apps is the first official MCP extension, co-developed by Anthropic and OpenAI (Jan 2026, [SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)) [V]. Claude interactive connectors launched 26 Jan 2026 ([Claude blog](https://claude.com/blog/interactive-tools-in-claude)) [V]. ChatGPT apps were renamed **plugins** in Jul 2026 and are built on the MCP Apps standard ([Drag](https://www.dragapp.com/blog/what-happened-to-chatgpt-plugins/), [Posterly](https://www.poster.ly/guides/chatgpt-guide)) [3P]. | Juno's MCP connectors should render `ui://` resources when a server offers them. |

---

## 3. Product by product

### 3.1 Google Gemini (app, web, Mac and Windows apps)

**Status and cadence**

- Gemini 3 launched 18 Nov 2025. Gemini 3.1 Pro followed on 19 Feb 2026, 3.5 at I/O on 19 May 2026, and 3.6 Flash on 21 Jul 2026 ([release notes](https://gemini.google/release-notes/)) [V].
- A native Mac app shipped 15 Apr 2026 (Option+Space) and a Windows app on 10 Sep 2026 (Alt+Space) ([release notes](https://gemini.google/release-notes/)) [V].
- The "Neural Expressive" redesign was announced at I/O on 19 May 2026 ([9to5Google](https://9to5google.com/2026/05/19/gemini-app-google-io-2026/)) [V].

**Tool inventory**

| Tool | How it is invoked | Notes |
|---|---|---|
| Google Search grounding | Automatic | Answers carry a **Sources** button at the bottom plus inline sources, which open a side panel of links ([Google Help via search](https://support.google.com/gemini/answer/14143489?hl=en&co=GENIE.Platform%3DAndroid)) [V]. |
| Google Maps | Automatic (no `@` since Oct 2025) | Since 11 Dec 2025: map first, emoji-themed pins, then place cards with photo, rating, review summaries and tips ([9to5Google](https://9to5google.com/2025/12/11/gemini-app-google-maps-visual/)) [V-25]. |
| YouTube, Flights, Hotels | Automatic from natural prompts ([9to5Google](https://9to5google.com/2025/10/18/gemini-youtube-google-maps-apps/)) [V-25] | Video and result cards [O]. |
| Personal Intelligence (Gmail, Photos, YouTube, Search history; Calendar "soon") | **Opt-in** (off by default), with a per-conversation on/off toggle in Tools | Beta from 14 Jan 2026 ([9to5Google](https://9to5google.com/2026/01/14/gemini-personal-intelligence/), [CNBC](https://www.cnbc.com/2026/01/14/google-launches-personal-intelligence-in-gemini-app-challenging-apple.html)) [V]. The per-chat toggle arrived in the Feb 2026 Tools redesign ([9to5Google](https://9to5google.com/2026/02/06/gemini-tools-redesign-android/)) [V]. |
| Connected Apps (Workspace, Keep, Tasks, Spotify, Canva, GitHub, Google Home…) | Automatic once connected, plus `@` for personal apps | 13 new third parties, including OpenTable (UK), Ticketmaster, Zocdoc, Otter and Granola, rolled out from 13 Aug 2026 ([9to5Google](https://9to5google.com/2026/08/13/gemini-is-getting-over-a-dozen-new-connected-apps-heres-the-list/)) [V]. |
| Tools menu (toggles) | Create image (Nano Banana), Canvas, Deep Research, Create video (Veo / Gemini Omni), Create music (Lyria 3 Pro), Guided Learning, Personal Intelligence | Menu as of Mar 2026 ([AI Blew My Mind](https://aiblewmymind.substack.com/p/google-gemini-guide-every-feature-explained)) [3P], confirmed after I/O ([9to5Google](https://9to5google.com/2026/05/19/gemini-app-google-io-2026/)) [V]. The Feb 2026 redesign turned Tools into a named menu with an "Experimental features" section carrying a Labs badge ([9to5Google](https://9to5google.com/2026/02/06/gemini-tools-redesign-android/)) [V]. |
| Canvas | Toggle, or suggested | Documents and code, vibe-coded apps, and turning text or reports into web pages, infographics, quizzes and audio ([release notes](https://gemini.google/release-notes/), 20 May 2025) [V-25]. |
| Dynamic view / Visual layout (generative UI) | A/B tested, automatic when enabled | Dynamic view codes a custom interactive UI for each prompt. Visual layout is a magazine-style view built from modules (18 Nov 2025, [PPC Land](https://ppc.land/google-launches-gemini-3-with-generative-ui-for-dynamic-search-experiences/), [Google Research](https://research.google/blog/generative-ui-a-rich-custom-visual-interactive-user-experience-for-any-prompt/)) [V-25]. |
| Double-check response | User action | Re-checks the answer against Search ([AI Blew My Mind](https://aiblewmymind.substack.com/p/google-gemini-guide-every-feature-explained)) [3P]. |
| Scheduled actions | Standing configuration | Launched 19 Jun 2025 ([release notes](https://gemini.google/release-notes/)) [V-25]. |
| Gemini Spark (agent) | Separate agent surface (Pro/Ultra, 18+, not in the EU/UK) | Runs up to **15 tasks at once**. Shows a **work panel** (steps, files touched, schedules) and a **progress chip** at the top of the thread. Stop button; "Take over task" for remote browser work; pauses for passwords and payments; asks before sending, modifying or purchasing ([Google Help](https://support.google.com/gemini/answer/16596215?hl=en&co=GENIE.Platform%3DDesktop), [Spark help](https://support.google.com/gemini/answer/17094507?hl=en&co=GENIE.Platform%3DDesktop)) [V]. Spark has its own Gmail address and uses Chrome ([TechCrunch](https://techcrunch.com/2026/05/19/google-introduces-gemini-spark-a-24-7-agentic-assistant-with-gmail-integration/)) [V]. |
| Daily Brief | Automatic agent | An overnight digest in the side panel with "Top of mind" and "Looking ahead" sections, plus shortcuts to create reminders and drafts ([9to5Google](https://9to5google.com/2026/05/19/gemini-app-google-io-2026/)) [V]. |

**What the Gemini API exposes (useful as a capability reference)**

- Built-in tools: Google Search, Google Maps, Code Execution, URL Context, Computer Use (preview, client-side) and File Search.
- Gemini 3 can combine built-in and custom tools in one turn, which the docs call "tool context circulation" (docs updated 18 Aug 2026, [ai.google.dev](https://ai.google.dev/gemini-api/docs/tools)) [V].

**Thinking UI**

- Model picker: Fast / Thinking / Pro. Deep Think is selected from the prompt bar for Ultra ([Google blog](https://blog.google/products/gemini/gemini-3-deep-think/)) [V-25].
- **"Show thinking"** expands a collapsible block of thought summaries with bold step headers [O].
- A Mar 2026 teardown showed "Show thinking" moving to a **separate bottom sheet** that also names the model, instead of pushing the answer down inline ([Android Authority](https://www.androidauthority.com/gemini-ui-changes-apk-teardown-3650199/)) [V]. The May 2026 Android redesign went further and moved "See thinking steps" into the overflow menu ([9to5Google via search](https://9to5google.com/2026/05/03/gemini-full-redesign/)) [V].
- **"Answer now"** sits next to the spinning status indicator on Pro and Thinking. Tapping it shows "Skipping in-depth thinking" and answers faster *on the same model*. The older "Skip" button used to switch to Fast (18 Jan 2026, [9to5Google](https://9to5google.com/2026/01/18/gemini-answer-now/), [Android Police](https://www.androidpolice.com/gemini-app-rolls-out-feature-to-skip-in-depth-thinking/)) [V].
- Deep Think runs take minutes. Gemini notifies you when the answer is ready ([Google blog](https://blog.google/products/gemini/gemini-3-deep-think/)) [V-25].

**Deep Research (consumer app)**

- **Entry:** "+" / Tools → Deep Research. **Sources** picker: Google Search (default), Gmail, Drive, Chat, uploaded files and NotebookLM notebooks.
- **Plan:** Gemini proposes a plan, the user can **Edit plan**, then presses **Start research**.
- **Run:** 5–10 minutes or more. The user can leave, and a notification arrives when it is done.
- **Output:** a report in **Canvas** with export to Docs, copy, **Audio Overview**, infographics, quizzes, web pages and sharing. Ultra adds charts, diagrams and interactive simulators ([Google Help](https://support.google.com/gemini/answer/15719111), [overview](https://gemini.google/overview/deep-research/)) [V].
- **Progress:** a "thinking panel" shows what the agent has learnt and what it will do next ([Phil Schmid](https://www.philschmid.de/deep-research-update)) [V]. It also listed the websites being researched in 2025 [O].
- **No depth tiers in the app** [V: none mentioned in the help center].
- **API only** (Apr 2026): `deep-research-preview-04-2026` (fast, meant to be streamed into a client UI) and `deep-research-max-preview-04-2026` (most comprehensive; roughly $1–3 vs $3–7 per task). The API adds collaborative planning, MCP/File Search/URL Context/Code Execution tools, streamed `thought`/`text`/`image` deltas, reconnection via `interaction_id` + `last_event_id`, and background mode with polling (docs updated 17 Sep 2026, [ai.google.dev](https://ai.google.dev/gemini-api/docs/interactions/deep-research)) [V]. Google keeps the tier naming to the developer surface.

**Motion and visual language: Neural Expressive (May 2026)**

- A pill-shaped composer, fluid animations, haptics and new typography.
- Responses lead with the key point in bold, followed by inline images, narrated videos, timelines and interactive visuals.
- Live runs *inline* as a centred waveform pill.
- The model picker is back to a top-left dropdown ([9to5Google](https://9to5google.com/2026/05/19/gemini-app-google-io-2026/), [Dezeen](https://www.dezeen.com/2026/05/19/google-rolls-out-neural-expressive-redesign-of-gemini-ai-tool/)) [V].
- Commentators describe the motion as tracking cognitive load: the UI "breathes" while it processes, retrieves or switches mode, instead of showing a spinner ([urdesignmag](https://www.urdesignmag.com/google-gemini-neural-expressive-redesign-2026/)) [3P].
- The Android redesign added a colourful, pulsating gradient background and thin rounded outline icons ([Android Headlines via search](https://www.androidheadlines.com/2026/05/google-gemini-app-redesign-ui-overhaul-2026.html)) [3P].

**Patterns to steal [I]:** "Answer now", thinking in a separate surface, map-first place cards, per-conversation data toggles, a progress chip plus work panel for long tasks, an editable research plan, research sources scoped to web, mail, drive and files, and report outputs that convert into other formats.

---

### 3.2 Perplexity (answer engine, Research, Labs, Computer, Comet)

**Status and cadence.** The product is changing very fast. Key 2026 releases (from the [Releasebot mirror](https://releasebot.io/updates/perplexity-ai) of the Perplexity changelog; the vendor pages returned 403) [3P, cross-checked with search abstracts of perplexity.ai pages]:

| Date | Release |
|---|---|
| 6 Feb | Upgraded Deep Research on Opus 4.5/4.6. Quotas were cut sharply, which drew criticism ([MakeUseOf](https://www.makeuseof.com/bought-annual-perplexity-subscription-lied/)) |
| 25–27 Feb | **Computer**: a multi-model orchestrator |
| 6 Mar | Custom Skills; Model Council |
| 13 Mar | Computer for Pro; **Bring Your Own Connector (MCP)**; Comet Enterprise |
| 27 Mar | Comet iOS; inline editing of assets; Deep Research asset generation (slides, sheets, dashboards, sites) |
| 26 Apr | Projects replace Spaces; Personal Computer for Windows |
| 4 May | **Plan previews with approval gates**; inline file diffs; website publishing |
| 29 May | **Context panel** with live progress and artifacts |
| 19 Jun | Deep Research inside Computer; `/` command panel; **forking**; improved inline confirmation UI |
| 13–27 Jul | Brain memory; mid-task model switching; **Check Sources**; **Source Context Panel** |
| 24 Aug | Computer in Email; "Always ask" connector approvals; MCP server as agent plugin |
| 17–21 Sep | **Effort Mode** (Light, Standard, High, Ultra); Skills Marketplace; Side Chat |

**Tool inventory and invocation**

- **Search** is always on: every query hits the web ([eWeek](https://www.eweek.com/news/perplexity-ai-cheat-sheet/)) [3P].
- **Pro Search** breaks a question into sub-queries and steps. It is toggled with the Pro button or Shift+Enter ([Perplexity Help, via search](https://www.perplexity.ai/help-center/en/articles/10352903-what-is-pro-search)) [V].
- The composer's **"+" menu** unifies Deep Research, Model Council, "Create files and apps", "Learn step by step" and Spaces/Projects ([Second Talent](https://www.secondtalent.com/resources/perplexity-ai-features-capabilities-2026/)) [3P].
- **Labs** (2025–26) runs 10–30 minute projects with three tabs: **Tasks** (live sub-task list), **Assets** (charts, CSVs, code, images) and **App** (a rendered mini web app) ([DataCamp](https://www.datacamp.com/tutorial/perplexity-labs), [InfoQ](https://www.infoq.com/news/2025/06/perplexity-labs)) [V-25/3P].
- **Computer**: a goal is split into subtasks that are routed to specialised sub-agents across ~19–20 models, for example Nano Banana for images, Veo 3.1 for video and Gemini for research. Deep Research inside Computer uses "Search as Code", where the model writes retrieval code that runs thousands of lookups in parallel ([MarkTechPost](https://www.marktechpost.com/2026/06/11/perplexity-moves-deep-research-into-computer-routing-research-subtasks-across-20-frontier-models-for-reports-decks-and-dashboards/), [BuildFastWithAI](https://www.buildfastwithai.com/blogs/what-is-perplexity-computer)) [3P].
- **Finance**: live charts, filings, screener and watchlists; Plaid brokerage linking since Mar 2026. Premium sources include PitchBook, CB Insights and Statista ([Sid Saladi](https://sidsaladi.substack.com/p/perplexity-finance-101-2026-the-complete), [Releasebot](https://releasebot.io/updates/perplexity-ai)) [3P].
- Widgets for sports, weather and trending stocks; interactive shareable charts [3P].
- **Comet** is an agentic browser with a right-hand **Assistant** sidebar (Cmd/Alt+A). It *asks first* before acting inside the browser ([XDA](https://www.xda-developers.com/perplexity-comet-smart-assistant/), [Comet resources](https://www.perplexity.ai/comet/resources/articles/comet-assistant-vs-agent)) [3P].

**How tool activity is visualised**

- **Answer view:** tabs for Answer, Links and Images. Research shows as collapsed steps with plain-language labels ("Searching the web", …) and a **"Completed N steps"** label ([AI UX Playground, 15 Jun 2026](https://aiuxplayground.com/teardowns/perplexity/output/)) [3P].
- **Loading phases:** Searching (globe), Reading (book), Writing (pen). One third-party design reconstruction gives three dots staggered by 200 ms on a 1.4 s ease-in-out cycle, and source cards that fade up over 0.3 s with a 100 ms stagger ([Blake Crosley](https://blakecrosley.com/guides/design/perplexity)) [3P, approximate].
- **Citations:**
  - Inline domain chips such as "foxsports +2".
  - Clicking a chip opens a popover with title, excerpt and a "1/2" pager.
  - A favicon stack with "10 sources" sits next to share and copy.
  - A sources side panel stays open next to the answer.
  - Selecting text offers **"Add to follow-up"** and **"Check sources"**.
  - Feedback chips separate retrieval quality ("Good/Wrong sources") from writing quality ([AI UX Playground citations](https://aiuxplayground.com/teardowns/perplexity/citations/)) [3P].
- **Computer:** a **context panel** shows live progress, generated artifacts and credit usage beside the conversation. Long or credit-heavy tasks get a **structured plan to approve, edit or revise** before sub-agents start. Notifications fire both for completion and for "needs your input" (May 2026) [V via search abstracts]. The Sep 2026 Effort slider lives on the web only ([SQ Magazine](https://sqmagazine.co.uk/perplexity-computer-effort-controls-model-selection/)) [3P].

**Research depth naming**

- 2025: "Pro Search" plus a "Research" mode (formerly "Deep Research") plus "Labs".
- 2026: Research moved into Computer, and depth is now set by the **Effort** slider (Light, Standard, High, Ultra). Each level maps to an orchestrator model and reasoning depth, and lower levels cost fewer credits [3P].

**Patterns to steal [I]:** "Completed N steps" as the collapsed summary, domain+N citation chips with a popover pager, a favicon stack with a count, text-selection "Check sources", a plan approval gate, a context panel holding progress, artifacts and cost, notifications for "needs input", and forking a thread.

---

### 3.3 xAI Grok

**Status.** Grok 4 shipped 9 Jul 2025, 4.5 on 8 Jul 2026, 4.6 on 12 Aug 2026 (a 500K-token context aimed at long-running agents), and 4.7 on 21 Sep 2026 ([Codersera](https://codersera.com/blog/grok-4-6-launch-guide-2026/), [Wikipedia](https://en.wikipedia.org/wiki/Grok_(chatbot))) [3P].

**Modes and tiers.** The consumer mode picker is **Auto / Fast / Expert / Heavy** ([Mundobytes](https://mundobytes.com/en/What-are-the-heavy--expert--fast--and-auto-modes-in-Grok-used-for/)) [3P]. Heavy runs several agents in parallel: planner, verifier, writer. xAI's Grok 4 launch described Heavy as parallel test-time compute that considers several hypotheses at once ([xAI](https://x.ai/news/grok-4)) [V-25]. The research tiers **DeepSearch** (capped at about 10 iterations) and **DeeperSearch** (more steps) were still documented in May 2026 ([Suprmind](https://suprmind.ai/hub/grok/grok-features/)) [3P]. Grok is the only mainstream product that still exposes *named research depth tiers*, and even there they sit beside a mode picker.

**Tool inventory**

- Web search, **X search** (keyword and semantic, including viewing media) and a code interpreter. Grok 4 decides when to search and refines its own queries ([xAI](https://x.ai/news/grok-4)) [V-25].
- The API's server-side tools are Web Search, X Search, Code Interpreter, Image Generation and Collections Search. Tool calls stream as events, and source URLs are returned automatically ([xAI docs](https://docs.x.ai/docs/guides/tools/overview)) [V].
- **Imagine**: image and video. Video with native audio launched Feb 2026 ([Suprmind](https://suprmind.ai/hub/grok/grok-features/)) [3P].
- **Build Mode** (28 Jul 2026 beta, widened in Aug) builds a working site, app or game with a **live preview inside the chat** and publishes it to a `grok.me` link or a custom domain ([xAI](https://x.ai/news/grok-build-mode)) [V].
- Projects, Memory and Tasks at grok.com/tasks [3P].
- **Grok Bot** (11 Aug 2026 beta): named, role-specific bots listed in a messaging-style sidebar.
  - Each bot has its **own persistent cloud computer** with a **live view of its screen**.
  - A Routines panel handles recurring work.
  - **Teach-a-task** lets you record a demonstration for the bot to repeat.
  - The bot chooses between a plugin and raw browser control by itself.
  - For logins it hands control back to the user ("sign in, then hand it back") ([AY Automate](https://www.ayautomate.com/blog/grok-bot-xai-ai-agents-explained)) [3P].

**Thinking UI**

- The answer is preceded by a "Thoughts" panel that can be expanded or collapsed. xAI's own Grok 4 demo shows "thought for 1 minute" with the search strategy visible ([xAI](https://x.ai/news/grok-4)) [V-25].
- Clones of the Grok UI render typed steps (thinking, search, observation, conclusion) as collapsible rows with animated appearance ([grok-react-ui](https://github.com/rajkstats/grok-react-ui)) [3P].
- **Caution:** Think mode reportedly *raises* hallucination on summarisation tasks. Vectara's measurement is 20.2% vs 5.8% ([Suprmind](https://suprmind.ai/hub/grok/grok-features/)) [3P]. Do not force thinking on for summarise or extract tasks [I].

**Patterns to steal [I]:** a live preview and one-click publish for built apps, a persistent computer per agent with a live view, handing logins back to the user, and routines.

---

### 3.4 Mistral Le Chat → Vibe

**Status.** Le Chat was **renamed Vibe** (reported 1 Jun 2026). It now has three modes in the sidebar: **Chat (legacy, being phased out)**, **Work** and **Code** ([WinBuzzer](https://winbuzzer.com/2026/06/01/mistral-rebrands-le-chat-as-vibe-for-work-and-coding-xcxwbn/), [Mistral docs](https://docs.mistral.ai/vibe/choose-chat-work-code)) [V]. Work Mode and remote agents launched 5 May 2026 with Mistral Medium 3.5 ([InfoQ](https://www.infoq.com/news/2026/05/mistral-agents-lechat/)) [V]. "Vibe gets to work" followed on 28 May 2026 ([Mistral](https://mistral.ai/news/vibe-agent/)) [V].

**How the legacy Chat features were remapped into Work** ([Mistral docs](https://docs.mistral.ai/vibe/choose-chat-work-code)) [V]. This is directly relevant to the user's "remove level names" request:

| Legacy Le Chat feature | Vibe Work equivalent |
|---|---|
| Agents | **Skills**, invoked with `@` |
| Think mode | **fast/think toggle** |
| Deep Research mode | **Deep Research Skill** |
| Code Interpreter | native in Work (paid plans) |
| Memories | Knowledge Base |

**Tool inventory**

- Web search, code interpreter, Canvas, image generation, Libraries (document knowledge bases), memories and knowledge base, and scheduled tasks (daily, weekly, monthly) ([WinBuzzer](https://winbuzzer.com/2026/06/01/mistral-rebrands-le-chat-as-vibe-for-work-and-coding-xcxwbn/), [Mistral](https://mistral.ai/news/vibe-agent/)) [V].
- **Connectors:** 20+ MCP-powered connectors shipped 2 Sep 2025, with custom remote MCP from day one ([Mistral](https://mistral.ai/news/le-chat-mcp-connectors-memories/)) [V-25]. The directory is now 60+ [3P].
- Memories let users add, edit or remove any entry, and can import from ChatGPT [V-25].
- Deep Research mode (17 Jul 2025) proposed a plan that the user could **Edit** (add, remove, reorder steps) before pressing **Start research**, and asked clarifying questions ([SiliconANGLE](https://siliconangle.com/2025/07/17/mistral-ai-brings-deep-research-le-chat-alongside-image-editing-voice-mode/), [Mistral](https://mistral.ai/news/le-chat-dives-deep/)) [V-25].

**Tool and approval UX in Vibe Work.** This is the most explicit public spec of any product audited ([Mistral docs: Safety and approvals](https://docs.mistral.ai/vibe/work/safety-and-approvals)) [V]:

- **Plan sign-off** before starting.
- A **Todos panel**: a live checklist of done and upcoming steps.
- **Reasoning summaries** that explain decisions and comparisons.
- **Tool transparency**: every function call shows its name, inputs, outputs and status (pending / succeeded / failed), and can be expanded.
- **Approval** before anything that creates, modifies, sends, posts or deletes in an external system. Options are **Continue** (once), **Always allow** (this session) and **Decline**. The docs tell users to check the recipients, content and destination before approving.
- A per-connector **Functions** tab lists **Interactive** tools (write) and **Read-only** tools, each with an "Always allow" toggle. Grants are per user.

**Patterns to steal [I]:** the Continue / Always allow / Decline trio with the exact payload visible, per-function grants grouped by read vs write, a Todos panel, and collapsing named modes into a toggle plus skills.

---

### 3.5 Microsoft Copilot (consumer, merging with Microsoft 365)

**Status**

- Fall release 23 Oct 2025: Mico avatar, Groups, memory with view/edit/delete, connectors to email, calendar and drives, **Copilot Mode in Edge** with **Actions** and **Journeys**, and Learn Live ([VentureBeat](https://venturebeat.com/ai/microsoft-copilot-gets-12-big-updates-for-fall-including-new-ai-assistant), [Windows Forum](https://windowsforum.com/threads/microsoft-copilot-with-mico-memory-groups-and-edge-actions-redefine-ai-assistants.386350/)) [V-25].
- **From 18 Aug 2026, Microsoft retired Podcasts, Group Chat, consumer Deep Research and Mico.** Deep Research's successor, *Researcher*, is limited to Microsoft 365 Premium. The consumer and business apps merged into one "Microsoft Copilot" app (copilot.cloud.microsoft) ahead of a "Super App" that combines chat, coding, Cowork and AutoPilot agents ([GeekWire](https://www.geekwire.com/2026/microsoft-starts-merging-its-copilot-consumer-and-business-apps-in-advance-of-super-app-rollout/)) [V].

**Modes.** The support page lists Quick response, Think Deeper (up to ~10 s), Study and learn, **Smart** (GPT-5, fast or deep chosen automatically) and Search. It also says Copilot shows its chain of thought while it evaluates a prompt ([Microsoft Support](https://support.microsoft.com/en-us/microsoft-copilot/conversation-modes-in-microsoft-copilot)) [V]. Press reports add "Smart Plus" and say Quick Response was removed in early 2026 ([Windows Noticias](https://en.windowsnoticias.com/Copilot-full-comparison-of-modes:-Smart--Quick-Response--Think-Deeper--Study-and-Learn--and-Search/), [MS Q&A](https://learn.microsoft.com/en-us/answers/questions/5792101/quick-response-mode-missing-in-copilot)) [3P]. The lesson: six overlapping modes confused users, and Microsoft is consolidating on the auto-routed **Smart** [I].

**Tools**

- Search with citations, image generation (remains free), Vision, voice, Pages and connectors.
- **Edge Actions** run in a *distinct tab* with progress UI and a stop control. Visual cues show when Copilot is reading, listening or acting, and it needs explicit consent to read tabs or history ([Windows Forum](https://windowsforum.com/threads/edge-copilot-mode-ai-assistant-with-actions-and-journeys-in-the-browser.386377/), [Microsoft Support](https://support.microsoft.com/en-us/microsoft-copilot/browse-with-copilot)) [V-25].
- On the Microsoft 365 side (2026):
  - interactive partner app UIs inside Copilot chat through the Agent Store (13 Apr 2026)
  - **"Plan with Copilot"**, which previews intended Excel changes before running them (17 Sep 2026)
  - Cowork GA with multi-model routing and a browser through Edge
  - the always-on "Scout" autopilot (2 Jun 2026)

  ([Releasebot](https://releasebot.io/updates/microsoft/microsoft-copilot)) [3P].

**Patterns to steal / avoid [I]:** *steal* visible "reading / acting" indicators and preview-before-apply. *Avoid* mode proliferation, and avoid retiring features abruptly without migrating the user's content.

---

### 3.6 Meta AI

- **Muse Spark** (8 Apr 2026, proprietary) brought a new app look, two modes (**Instant** and **Thinking**), parallel **subagents** (for example drafting an itinerary, comparing destinations and finding activities at once), a Shopping mode, web search, image generation, "visual coding" of sites and games, and photo analysis ([Meta Newsroom](https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/)) [V].
- The **agentic update** (24 Jul 2026, Muse Spark 1.1) adds plans that follow through, email and calendar, slide generation, research deep dives, daily briefings, reminders, and **steering mid-task** (change focus or tone, cut a section) ([Meta Newsroom](https://about.fb.com/news/2026/07/meta-ai-muse-spark-doesnt-just-think-it-acts/)) [V].
- **AI Mode for Facebook** (15 Jun 2026) synthesises answers from public posts, Groups and Reels [3P].
- The Meta acquisition of Manus was blocked by China's NDRC on 27 Apr 2026 and unwound on 15 Jun 2026 ([Wikipedia](https://en.wikipedia.org/wiki/Manus_(AI_agent))) [3P].

**Pattern to steal [I]:** steering while running, meaning the user can edit the running plan without cancelling it.

---

### 3.7 DeepSeek

- The composer long had two toggles, **DeepThink** (reasoning on or off) and **Search**. Reasoning renders as a **collapsible raw trace above the reply** [O; described by [deepseek-online](https://deepseek-online.org/)] [3P].
- **V4 / V4-Pro (24 Apr 2026)** replaced the lone DeepThink toggle with two named modes on chat.deepseek.com: **Instant Mode** and **Expert Mode**. V4-Pro became available through Expert Mode at GA ([DeepSeek API news](https://api-docs.deepseek.com/news/news260424/), [GA note](https://api-docs.deepseek.com/news/news260813/), [SCMP](https://www.scmp.com/tech/policy/article/3349345/chinas-deepseek-adds-instant-and-expert-chatbot-modes-ahead-much-awaited-v4-release)) [V]. V4.1-Flash followed on 9 Sep 2026 ([Wikipedia](https://en.wikipedia.org/wiki/DeepSeek_(chatbot))) [3P].
- The consumer app has **no agent, connectors or MCP** (none documented) [I from absence].

**Lesson [I]:** even the most minimal product has converged on *two* speed modes plus search. Showing raw chain-of-thought is a DeepSeek signature, but other vendors show summaries.

---

### 3.8 Kimi (Moonshot)

- Modes: **Instant / Thinking / Agent / Agent Swarm (beta)**, introduced with K2.5 in Jan 2026 ([Kimi](https://www.kimi.ai/ai-models/kimi-k2-5), [InfoQ](https://www.infoq.com/news/2026/02/kimi-k25-swarm/)) [V].
- K3 (Jul 2026) is described as an open ~2.8T-parameter model ([Kimi Help](https://www.kimi.com/en/help/agent/agent-overview)) [V].
- **Kimi Agent** (the "OK Computer" lineage, 26 Sep 2025):
  - its own virtual computer (file system, browser, terminal)
  - 20+ built-in tools: code, terminal, browsing, image and audio generation
  - task planning with **real-time progress display**
  - proactive retries
  - deliverables in Excel, Word, PPT and deployed web apps

  ([Kimi Help](https://www.kimi.com/en/help/agent/agent-overview)) [V].
- Entry points: OK Computer, **Agent Swarm** (up to 300 sub-agents per the help center; the K2.5 launch said 100 sub-agents and 1,500 tool calls), **Deep Research**, Websites, Docs & Sheets, and Slides [V].
- I could not verify the fine-grained UI (todo list vs file browser layout) from public text [gap].

---

### 3.9 Manus

- **Status:** independent again as of 11 Aug 2026 after the Meta deal was unwound. Manus 1.6 shipped 15 Dec 2025 with **Max** agent, mobile development, **Design View** and Wide Research on Max sub-agents ([Manus blog](https://manus.im/blog/manus-max-release), [Wikipedia](https://en.wikipedia.org/wiki/Manus_(AI_agent))) [V-25/3P]. Agent tiers are **Lite / Standard / Max** ([Manus review](https://www.layer3labs.io/guides/manus-ai-explained)) [3P].
- **Feature map** from the official docs index ([llms.txt](https://manus.im/docs/llms.txt)) [V]: Projects, Skills, Design View, Wide Research, Slides, Scheduled Tasks, Data Analysis & Visualization, Multimedia, **Mail Manus**, Collab, **Cloud Browser**, **Browser Operator**, Desktop ("My Computer"), Meeting Minutes, a full Website Builder (publish, domains, payments, analytics), MCP Connectors and **Custom MCP Servers**.
- **Visualisation:**
  - A live dashboard shows the agent's actions, with **pause and intervene** ([Willo review, 9 Jul 2026](https://www.willo.ai/blog/manus-review)) [3P].
  - **Task Replay** lets you step back through browser screenshots, code logs and decision points [3P].
  - **Cloud Browser:** watch it live; it prompts a **take-over** for CAPTCHAs, SMS codes or MFA and then hands back; sessions are managed in Settings; passwords are not stored ([Manus docs](https://manus.im/docs/features/cloud-browser.md)) [V].
  - **Browser Operator** works in a dedicated tab of the user's own Chrome or Edge. The user approves each session, clicks into the tab to take over, closes it to stop, and all actions are logged ([Manus docs](https://manus.im/docs/features/browser-operator)) [V].
  - **Wide Research** shows a **grid of sub-tasks with live completion counts**. It gives each item its own agent and context, has been tested to about 250 items, and is not useful under about 10 items. It outputs sortable tables ([Manus docs](https://manus.im/docs/features/wide-research.md)) [V].
- The "Manus's Computer" right-hand panel that switches between browser, terminal and editor views, with a timeline scrubber, is well known from 2025 [O]. The help center confirms users can take over the browser or VS Code ([Manus Help](https://help.manus.im/en/articles/11711218-how-can-i-take-over-manus-browser-or-vs-code)) [V].

---

### 3.10 Genspark

- **Super Agent** orchestrates specialist agents and tools, "80+ tools" per reviews ([Cybernews via search](https://cybernews.com/ai-tools/genspark-ai-review/)) [3P]. The 2025 hierarchy had three tiers ([Why Try AI, Jul 2025](https://www.whytryai.com/p/genspark-beginner-guide)) [V-25]:
  - advanced agents: Fact Check, Data Table, Deep Research, AI Slides, AI Sheets, **Call For Me**
  - basic agents: chat, image, video, translation
  - later additions: AI Drive, Docs, Secretary, **AI Browser** and Pods
- **Call For Me** places real phone calls through the OpenAI Realtime API ([OpenAI case study](https://openai.com/index/genspark/)) [V-25].
- **AI Workspace 6.0** (20 Jul 2026) has four layers: SecondBrain (memory), Super Agent (engine), Build/Office/Content suites (tools) and GenTeam (collaboration) ([Genspark blog](https://www.genspark.ai/blog/genspark-ai-workspace-6)) [3P via search]. Workspace 4.0 added **Claw for Desktop** with computer use and browser use, plus Office plugins ([Genspark blog](https://www.genspark.ai/blog/genspark-ai-workspace-4)) [3P].
- **Sparkpages** turn a query into an organised, sourced page. Genspark is the clearest example of *tool-as-deliverable*: slides, sheets, docs, pages and calls are all first-class outputs [I].

---

## 4. Open standards (state as of Sep 2026)

### 4.1 MCP core spec

**2025-11-25** ([changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)) [V]:

- **Icons** on tools, resources, templates and prompts (SEP-973). An icon has `src`, `mimeType`, `sizes` and `theme: light|dark`.
- Tool-name guidance (SEP-986).
- Elicitation enums: titled or untitled, single or multi-select, with defaults.
- **URL-mode elicitation** (SEP-1036), used for OAuth or credential flows the client never sees.
- **Tool calling inside sampling** (SEP-1577).
- **Experimental tasks** (SEP-1686), for durable, polled, deferred results.
- **Input validation errors are returned as tool-execution errors, not protocol errors, so the model can self-correct** (SEP-1303).
- JSON Schema 2020-12 as the default dialect.
- Client ID Metadata Documents for registration.

**2026-07-28** (current; [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)) [V]:

- **Stateless protocol.** There is no `initialize` handshake and no `Mcp-Session-Id`. Every request carries its protocol version and client capabilities in `_meta`, and a new `server/discover` RPC advertises what the server supports. Cross-call state uses explicit, server-minted **handles** passed as ordinary tool arguments.
- **Multi Round-Trip Requests (MRTR).** A server can answer `tools/call` with `resultType: "input_required"` plus `inputRequests` (for example an elicitation form). The client retries with `inputResponses` and an opaque `requestState`. This *replaces* server-initiated `elicitation/create`, `sampling/createMessage` and `roots/list`. Every result now carries `resultType`.
- **Tasks** moved out of core into the extension `io.modelcontextprotocol/tasks`, which polls with `tasks/get` and sends input with `tasks/update`.
- `subscriptions/listen` replaces the GET stream and `resources/subscribe`. Progress notifications still flow on the originating request's stream. SSE resumability (`Last-Event-ID`) was removed, so a broken stream must be re-issued.
- **Caching:** `tools/list` and other list results carry `ttlMs` and `cacheScope`. Servers **should** return tools in deterministic order, for client caching and prompt-cache hits.
- `inputSchema` and `outputSchema` accept any JSON Schema 2020-12 keyword, and `structuredContent` can be any JSON value.
- **Deprecated:** Roots, Sampling, Logging and Dynamic Client Registration. CIMD is now the preferred registration.

**Tool definition shape, current** ([Tools spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools); fields checked against the `schema/2026-07-28/schema.ts` file on the spec repo's `main` branch) [V]:

- `name` (1–128 chars, `[A-Za-z0-9_.-]`, case-sensitive), `title`, `description`, `icons[]`, `inputSchema` (object root), optional `outputSchema`, optional `annotations`, and `_meta`.
- **Display-name precedence:** `title` → `annotations.title` → `name`.
- **`ToolAnnotations`** (all *hints*; "clients should never make tool use decisions based on annotations from untrusted servers"):

  | Hint | Default | Meaning |
  |---|---|---|
  | `readOnlyHint` | **false** | The tool does not modify its environment. |
  | `destructiveHint` | **true** | It may do destructive, not merely additive, updates. Only meaningful when not read-only. |
  | `idempotentHint` | **false** | Repeating the call with the same arguments has no extra effect. Only meaningful when not read-only. |
  | `openWorldHint` | **true** | It talks to an open world (for example the web) rather than a closed domain (for example memory). |

- **Result content types:** `text`, `image` (base64 + mime), `audio`, `resource_link` (a URI with name, description and mime), and embedded `resource`. Each can carry annotations: `audience: ["user"|"assistant"]`, `priority`, `lastModified`. `structuredContent` should also be serialised into a text block for backward compatibility.
- **Two error channels:** protocol errors (unknown tool, malformed request) are JSON-RPC errors. **Execution errors** (API failure, validation, business rules) come back as `isError: true` results, and the spec says clients *should* pass these to the model so it can recover.
- **Host obligations (SHOULD):**
  - show which tools are exposed
  - show **clear visual indicators when tools are invoked**
  - **confirm** sensitive operations
  - **show tool inputs before calling**, to prevent exfiltration
  - validate results, apply timeouts, and keep an audit log
- **Name collisions** across servers: prefix names with a server identifier. Do not rely on `serverInfo.name` being unique.

### 4.2 MCP Apps (first official extension; spec dated 2026-01-26)

([SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp), [spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [MCP blog 21 Nov 2025](https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/)) [V]

- **Resources and tool links:**
  - UI templates are `ui://` resources with MIME type `text/html;profile=mcp-app`.
  - They are **pre-declared**, so the host can prefetch and review them.
  - A tool links to its UI through `_meta.ui.resourceUri`.
  - `visibility: ["model","app"]` allows **app-only tools** that the model never sees.
- **Security:**
  - rendering in a **sandboxed iframe**; web hosts use a **double-iframe proxy**
  - a CSP built from declared `connectDomains`, `resourceDomains`, `frameDomains` and `baseUriDomains`
  - permission prompts for camera, microphone, geolocation and clipboard
  - optional **user consent for UI-initiated tool calls**
- **View → host requests:** `ui/initialize`, `tools/call`, `resources/read`, `ui/message`, `ui/open-link`, `ui/update-model-context`, `ui/request-display-mode` (inline, fullscreen or **pip**).
- **Host → view notifications:** `tool-input`, **`tool-input-partial`** (streamed arguments), `tool-result`, `tool-cancelled`, `host-context-changed` (theme, locale, timezone, size), `size-changed`, `resource-teardown`.
- **Theming:** standard CSS custom properties for colour, type and spacing.
- **Adoption:** Claude (26 Jan 2026) and ChatGPT, whose apps are now "plugins" on the Apps SDK and aligned with MCP Apps [V/3P]. Microsoft 365 Agent Store app UIs (Apr 2026) are similar in spirit [3P].

### 4.3 Agent Skills (SKILL.md)

- Anthropic released Agent Skills as an open standard on 18 Dec 2025, stewarded at agentskills.io.
- By Mar 2026 about **32 tools** had adopted it, including ChatGPT/Codex, VS Code/Copilot, Gemini CLI, Mistral and Kiro.
- Format: a folder containing `SKILL.md` (YAML frontmatter with name and description, then markdown), plus optional scripts, references and assets ([agentskills GitHub](https://github.com/agentskills/agentskills), [Paperclipped](https://www.paperclipped.de/en/blog/agent-skills-open-standard-interoperability/)) [V/3P].
- Consumer adopters: Perplexity Custom Skills (Mar 2026) and Skills Marketplace (Sep 2026), Vibe Skills, ChatGPT plugins bundling skills, and Claude's Skills Marketplace (~600 at launch, 1 May 2026, per [Linas](https://linas.substack.com/p/anthropic-claude-2026-every-launch-guide)) [3P].

### 4.4 WebMCP ("site tools")

- A web page registers tools for agents. `navigator.modelContext` first shipped in Chrome 146 Canary (Mar 2026). The spec is moving the API to `document`, and Chrome deprecated the `navigator` form in 150 ([DEV](https://dev.to/ai-agent-economy/webmcp-in-2026-which-browsers-support-navigatormodelcontext-complete-compatibility-status-1oe4), [Search Engine Journal](https://www.searchenginejournal.com/chatgpt-adds-webmcp-support/587237/)) [3P].
- **ChatGPT's desktop built-in browser** lets Work and Codex discover and use site tools ([ChatGPT Learn](https://learn.chatgpt.com/docs/webmcp)) [V].
- As of May 2026 most other agents still scrape the DOM or use pixels ([StudioMeyer](https://studiomeyer.io/en/blog/webmcp-reality-check-may-2026)) [3P].

### 4.5 AG-UI and A2UI (agent ↔ UI)

AG-UI is CopilotKit's event protocol, with integrations in Microsoft Agent Framework, Google ADK, AWS Strands and Bedrock AgentCore ([AG-UI docs](https://docs.ag-ui.com/introduction), [Medium](https://medium.com/@visrow/a2a-mcp-ag-ui-a2ui-the-essential-2026-ai-agent-protocol-stack-ee0e65a672ef)) [V/3P]. Its event taxonomy is a good reference for Juno's SSE `activity` events ([events](https://docs.ag-ui.com/concepts/events)) [V]:

| Group | Events |
|---|---|
| Lifecycle | `RunStarted/Finished/Error`, `StepStarted/Finished` |
| Text | `TextMessageStart/Content/End` |
| Tool calls | `ToolCallStart`, `ToolCallArgs` (streamed argument deltas), `ToolCallEnd`, `ToolCallResult` |
| State | `StateSnapshot`, `StateDelta` (JSON Patch), `MessagesSnapshot` |
| Reasoning | `ReasoningStart`, `ReasoningMessageStart/Content/End`, `ReasoningEnd`, `ReasoningEncryptedValue` |
| Activity | `ActivitySnapshot/Delta` |
| Subagents | `SubagentStarted/Finished/Error` |
| Escape hatches | `Raw`, `Custom` |

**A2UI** (Google) is a declarative JSON component tree that the client renders natively. It is the "safe generative UI" alternative to arbitrary HTML [3P].

### 4.6 MCP Registry

Preview since 8 Sep 2025 at registry.modelcontextprotocol.io. Server metadata lives in `server.json`, with verified namespaces (GitHub or DNS). The 2026 goals are a stable Registry API v1 and sub-registries ([GitHub](https://github.com/modelcontextprotocol/registry), [Registry charter](https://modelcontextprotocol.io/community/working-groups/registry)) [V]. This is a possible source for a Juno "add custom connector" catalogue [I].

---

## 5. Thinking and reasoning display compared

| Product | How reasoning is enabled | Live state | After completion | Content | Controls | Where |
|---|---|---|---|---|---|---|
| Gemini | Fast / Thinking / Pro picker; Deep Think | Spinner plus status; "Answer now" next to it [V] | "Show thinking" | Summaries with bold step headers [O] | **Answer now** (keeps model) [V] | Moving from inline to a **separate sheet** with model info; mobile puts "See thinking steps" in the overflow menu [V] |
| Perplexity | Pro Search / Effort slider | Phase label (Searching → Reading → Writing) and live steps [3P] | "Completed N steps" (collapsed) [3P] | Step labels, queries, sources | Rewrite with a different depth or model [3P] | Inline collapsible, plus the Computer context panel [V] |
| Grok | Auto / Fast / Expert / Heavy; Think | "Thinking" | "Thought for 1 minute" [V-25] | Thoughts, including search strategy | Expand, collapse | Inline "Thoughts" panel |
| Vibe (Mistral) | fast/think toggle [V] | Todos panel ticking live [V] | Reasoning summaries [V] | Summaries plus tool I/O | Approvals mid-run | Side panel plus inline tool cards |
| Copilot | Smart (auto) / Think Deeper | "Shares chain of thought while evaluating" [V] | — | Summary | — | Inline |
| DeepSeek | Instant / Expert (V4); DeepThink toggle | "Thinking…" | "Thought for N s" collapsible [3P/O] | **Raw** trace | Expand | Inline, above reply |
| Meta AI | Instant / Thinking [V] | Subagents working [V] | — | — | **Steer mid-task** [V] | Inline |
| Kimi | Instant / Thinking / Agent / Swarm [V] | Real-time task progress [V] | — | — | — | Agent workspace |
| ChatGPT *(ref)* | Auto / Instant / Thinking / Pro + effort [3P] | Shimmering status text [O] | "Thought for Xs" opens an Activity panel [O] | Summaries plus sources | Skip / answer now [O] | Side panel |
| Claude *(ref)* | Effort Low / Medium / High / Max (28 May 2026) [3P] | "Thinking" plus timer [O] | Collapsible thought process [O] | Summarised thinking [O] | — | Inline |

**Consensus [I]:**

- (a) A one-line live status in the transcript that names the *current action*, not a generic "thinking".
- (b) An elapsed timer, turned into "Thought for Ns" when done.
- (c) Summaries rather than raw chain-of-thought (DeepSeek is the exception).
- (d) The full trace in a panel or sheet, not pushing the answer down.
- (e) A way to cut thinking short without changing model.

---

## 6. Research features compared, and how depth is named

| Product | Entry point | **Depth naming exposed to consumer** | Plan review | Live progress | Output | Duration |
|---|---|---|---|---|---|---|
| Gemini app | Tools → Deep Research | **None**; a single "Deep Research". API only: Deep Research vs **Max** [V] | Edit plan → Start research [V] | Thinking panel; websites list [V/O] | Canvas report; Docs export; Audio Overview; infographic, quiz, web page; Ultra: charts and simulators [V] | 5–10+ min; notification [V] |
| ChatGPT | Tools → Deep research | **None**; the lightweight version is used silently when quota runs out ([Wikipedia](https://en.wikipedia.org/wiki/ChatGPT_Deep_Research)) [V-25] | Editable plan since Feb 2026; restrict to sites; connect apps and MCP [V] | Real-time progress; **interrupt and refine mid-run** [V] | **Fullscreen report viewer**: TOC on the left, citations column on the right ([MacRumors](https://www.macrumors.com/2026/02/11/chatgpt-deep-research-mode-document-viewer/)) [V] | 5–30 min [V] |
| Perplexity | "+" → Deep Research; now inside Computer | **Effort: Light / Standard / High / Ultra** (slider, Sep 2026) [3P] | Plan preview with approval gate (May 2026) [V] | Context panel; steps; credits [V] | Reports, decks, dashboards, live sheets, websites [V] | Minutes, background; notifications [V] |
| Grok | DeepSearch / DeeperSearch plus modes | **Named tiers** (DeepSearch, DeeperSearch; Expert, Heavy) [3P] | — | Thoughts panel [3P] | Sectioned answer [3P] | 30–60 s (DeepSearch) [3P] |
| Mistral Vibe | `@Deep Research` Skill in Work | **None**; a skill plus the fast/think toggle [V] | Plan sign-off [V]; 2025 mode had Edit plan [V-25] | Todos panel, tool cards [V] | Canvas docs, charts [V] | — |
| Copilot | *Retired for consumers 18 Aug 2026*; Researcher in M365 Premium [V] | — | "Plan with Copilot" (Excel) [3P] | — | — | — |
| Kimi | Agent → Deep Research [V] | Mode names (Agent / Swarm) [V] | — | Real-time progress [V] | Long report [V] | — |
| Manus | Wide Research | Agent tier **Lite / Standard / Max** [3P] | — | **Grid of sub-tasks with counts** [V] | Sortable tables and matrices [V] | Long |

**Takeaway for the user's request [I]:** the two biggest consumer research products (Gemini and ChatGPT) show **no depth tier names at all**. They have one Research tool, an editable plan, a background run and a great report viewer. Where depth still appears it is an *effort* dial (Perplexity) or leftover model-mode naming (Grok, Manus). Juno's `quick / standard / deep / max` should go. The plan should carry a scope estimate (sources, minutes, cost ceiling) that the user can nudge.

---

## 7. Capability matrix

**Legend**

- ● = shipped and invoked **automatically** by the model
- ◐ = shipped, but needs a **user toggle, mode, menu or plan tier**
- R = **retired** in 2026
- ○ = not offered (as far as public sources show)
- ? = could not verify

Claude and ChatGPT cells are best-effort; see their dedicated audits. The **Juno today** column is left blank for the synthesizer.

| # | Capability | Claude | ChatGPT | Gemini | Perplexity | Grok | Le Chat / Vibe | Copilot | Juno today |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Web search, grounded with citations | ● [O] | ● [O] | ● [V] | ● always on [V] | ● [V-25] | ● [V] | ● (+ Search mode) [V] | |
| 2 | Social-network search | ○ | ○ | ○ | ? | ● X search [V-25] | ○ | ○ | |
| 3 | Fetch / read a given URL | ● web fetch [O] | ● [O] | ● URL context [V] | ● [O] | ● [O] | ? | ● Edge tabs, with consent [V-25] | |
| 4 | Long-form research agent | ◐ Research [O] | ◐ Deep research [V] | ◐ Deep Research [V] | ◐ in Computer + Effort [V/3P] | ◐ DeepSearch / DeeperSearch [3P] | ◐ Deep Research Skill [V] | R (18 Aug 2026) [V] | |
| 5 | Editable plan before long run | ? | ● (Feb 2026) [V] | ● [V] | ● (May 2026) [V] | ? | ● [V] | ◐ M365 Plan with Copilot [3P] | |
| 6 | Research source scoping (sites, mail, drive, files) | ? | ● sites, apps, MCP [V] | ● Search, Gmail, Drive, Chat, files, Notebooks [V] | ● connectors, files [V] | ? | ● connectors [V] | — | |
| 7 | Code execution sandbox | ● [3P] | ● [O] | ● (API; app analysis) [V] | ● Labs, Computer [V] | ● [V] | ● paid [V] | ◐ M365 Python in Excel [3P] | |
| 8 | Office file creation (docx, xlsx, pptx) | ● incl. Docs/Slides beta (16 Sep 2026) [3P] | ● via Work [3P] | ◐ export to Docs/Sheets [V] | ● [V] | ? | ● [V] | ● M365 [3P] | |
| 9 | Canvas / side-by-side editing | ● Artifacts [O] | ● Canvas [O] | ◐ Canvas [V] | ◐ inline asset editing [V] | ? | ● Canvas [V] | ● Pages [O] | |
| 10 | Build and publish a web app from chat | ● Artifacts [O] | ● Sites beta [V] | ◐ Canvas [V-25] | ● pplx.app / Vercel [V] | ◐ Build Mode, grok.me [V] | ? | ◐ `/app` in Cowork [3P] | |
| 11 | Generative / interactive UI inline | ● visualisations (Mar 2026) [3P] | ● plugin UIs [3P] | ● dynamic view, visual layout, rich responses [V] | ● widgets, charts [3P] | ◐ Build preview [V] | ● charts, dashboards [V] | ● Agent Store app UIs [3P] | |
| 12 | Image generation / editing | ○ (Claude Design for visuals) [3P] | ● Images 2.5 [3P] | ◐ Create image [V] | ● GPT Image 2 [3P] | ● Imagine [3P] | ● [V] | ● free [V] | |
| 13 | Video generation | ○ | ? | ◐ Veo / Omni [V] | ◐ via Computer (Veo 3.1) [3P] | ● Imagine video [3P] | ○ | ? | |
| 14 | Music / audio generation | ○ | ○ | ◐ Lyria 3 Pro [3P] | ○ | ○ | ○ | R Podcasts [V] | |
| 15 | Audio overview of a report | ○ | ○ | ● [V] | ? | ○ | ○ | R [V] | |
| 16 | Maps and local rich cards | ? | ● [O] | ● map-first place cards [V-25] | ? | ? | ○ | ? | |
| 17 | Finance, sports, weather widgets | ? | ● + credit score (Sep 2026) [3P] | ● [O] | ● Finance hub, widgets [3P] | ? | ○ | ● [O] | |
| 18 | Personal data (mail, calendar, photos) | ● connectors [O] | ● multi-account Google (Aug 2026) [3P] | ◐ Personal Intelligence, per-chat toggle [V] | ● connectors [V] | ◐ Grok Bot plugins [3P] | ● [V] | ● connectors [V-25] | |
| 19 | Third-party connector directory | ● [V] | ● 1,400+ plugins [3P] | ● Connected Apps (+13 in Aug 2026) [V] | ● [V] | ◐ [3P] | ● 60+ [3P] | ● Agent Store [3P] | |
| 20 | Custom remote MCP server | ● [O] | ● developer mode [3P] | ? (API DR supports MCP) [V] | ● BYO connector [V] | ? | ● [V-25] | ◐ Studio [O] | |
| 21 | MCP Apps / in-chat app UI | ● (26 Jan 2026) [V] | ● [3P] | ? | ? | ? | ? | ● M365 [3P] | |
| 22 | Per-function write approvals + "always allow" | ● [O] | ● [O] | ● confirms send, modify, buy [V] | ● "Always ask" (Aug 2026) [3P] | ◐ login handoff [3P] | ● Continue / Always / Decline + Functions tab [V] | ● explicit consent [V-25] | |
| 23 | Memory (view, edit, delete) | ● (free since Mar 2026) [3P] | ● [O] | ● [V] | ● Brain (Jul 2026) [3P] | ● [3P] | ● Knowledge Base [V] | ● [V-25] | |
| 24 | Projects / custom assistants | ● Projects (redesigned 17 Sep 2026) [3P] | ● Projects; GPTs retiring (Sep 2026) [3P] | ● Gems, Notebooks [V] | ● Projects [3P] | ● Projects [3P] | ● Skills (`@`) [V] | ? | |
| 25 | Skills (SKILL.md) | ● [3P] | ● in plugins [3P] | ◐ Spark skills [V] | ● marketplace [3P] | ◐ teach-a-task [3P] | ● [V] | ● Cowork skills [3P] | |
| 26 | Scheduled / recurring tasks | ● Cowork `/schedule` [3P] | ● incl. webhook triggers (Aug 2026) [3P] | ● Scheduled actions, Spark schedules [V] | ● [3P] | ● Tasks, Routines [3P] | ● [V] | ◐ autopilots [3P] | |
| 27 | Proactive daily digest | ? | ● Pulse [O] | ● Daily Brief [V] | ? | ? | ? | ? | |
| 28 | Remote / cloud browser agent | ● Chrome ext. GA, built-in browser in Cowork (26 Aug 2026) [3P] | ● cloud browser; agent mode R (Aug 2026) [3P] | ● Spark [V] | ● Comet, Computer [V] | ● Grok Bot [3P] | ? | ● Edge Actions [V-25] | |
| 29 | Live view with **take over** | ? | ? | ● "Take over task" [V] | ? | ● live screen [3P] | ? | ● visible tab + stop [V-25] | |
| 30 | Local desktop / computer control | ◐ Cowork VM [3P] | ● macOS/Windows computer use [V] | ◐ Mac screen context [V] | ● Personal Computer [3P] | ○ | ◐ Code CLI [V] | ● Windows [O] | |
| 31 | Parallel sub-agents | ● Research multi-agent [O] | ● [V] | ● DR parallel sub-tasks [V] | ● Computer [V] | ● Heavy [V-25] | ? | ● Cowork [3P] | |
| 32 | Multi-model side-by-side | ○ | ○ | ○ | ● Model Council [3P] | ○ | ○ | ○ | |
| 33 | User-facing reasoning control | ◐ Low / Med / High / Max [3P] | ◐ Auto / Instant / Thinking / Pro [3P] | ◐ Fast / Thinking / Pro [V] | ◐ Effort 4-step [3P] | ◐ Auto / Fast / Expert / Heavy [3P] | ◐ fast / think [V] | ◐ Smart / Think Deeper [V] | |
| 34 | Skip thinking mid-run | ? | ● [O] | ● Answer now [V] | ○ | ○ | ○ | ○ | |
| 35 | Claim-level source check | ○ | ○ | ● Double-check [3P] | ● Check Sources (Jul 2026) [3P] | ○ | ○ | ○ | |
| 36 | Background run + notification | ● [O] | ● [O] | ● [V] | ● [V] | ● [3P] | ● [V] | ● [3P] | |
| 37 | Email the agent | ○ | ○ | ● Spark Gmail address [V] | ● Computer in Email [3P] | ○ | ○ | ○ | |
| 38 | Voice live with camera or screen | ● [O] | ● [O] | ● inline Live pill [V] | ● [3P] | ● camera mode [3P] | ● Voxtral [V-25] | ● Vision [O] | |

**Secondary matrix (the long tail)**

| Capability | Meta AI | DeepSeek | Kimi | Manus | Genspark |
|---|---|---|---|---|---|
| Web search | ● [V] | ◐ Search toggle [3P] | ● [V] | ● [V] | ● [V-25] |
| Reasoning modes | Instant / Thinking [V] | Instant / Expert [V] | Instant / Thinking / Agent / Swarm [V] | Lite / Standard / Max agent [3P] | model routing [3P] |
| Agent with own computer | ● (Jul 2026) [V] | ○ | ● virtual computer [V] | ● cloud browser, sandbox [V] | ● Claw desktop, AI Browser [3P] |
| Parallel sub-agents | ● [V] | ○ | ● up to 300 [V] | ● Wide Research grid [V] | ● [3P] |
| Deliverables (docs, slides, sheets, sites) | ● slides [V] | ○ | ● [V] | ● + website builder [V] | ● [V-25] |
| MCP / connectors | ? | ○ | ? | ● incl. custom MCP [V] | ● [3P] |
| Live view / take over / replay | ? | ○ | ● progress [V] | ● / ● / ● [V] | ? |
| Phone calls | ○ | ○ | ○ | ○ | ● Call For Me [V-25] |
| Steer mid-run | ● [V] | ○ | ? | ● intervene [3P] | ? |

---

## 8. UX patterns: table stakes vs differentiators (Sep 2026)

### 8.1 Table stakes (at least three major products ship each)

1. **Auto tool use with visible indicators.** Invoked tools show up the moment they run. MCP says hosts SHOULD show clear visual indicators ([spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).
2. **A step list that collapses into a summary line.** Perplexity uses "Completed N steps", Grok "Thought for…", and ChatGPT and Claude "Thought for Ns" [V/O].
3. **Sources as favicons, with counts and a panel.** A favicon stack with "N sources", inline domain chips, and a sources side panel (Perplexity, Gemini) [V].
4. **Live status that names the action.** Searching, Reading, Writing, Running code, Creating image [3P/O].
5. **An elapsed timer during thinking**, becoming a duration afterwards [O].
6. **Plan preview and editing before long runs** (Gemini, ChatGPT, Perplexity, Vibe) [V].
7. **Background execution with notifications**, including "needs your input" (Gemini, Perplexity, Vibe, Grok Bot) [V].
8. **Write approvals with once / always / deny** and the exact payload shown (Vibe, Perplexity, Gemini Spark, Copilot) [V].
9. **A side panel for progress and artifacts**, separate from the transcript (Spark work panel, Perplexity context panel, Vibe Todos, ChatGPT Activity) [V/O].
10. **Rich result cards for structured tools**: maps, stocks, weather, sports, images and files (Gemini, Perplexity, ChatGPT, Copilot) [V/O].
11. **Stop at any time**; *also* "Answer now" for thinking (Gemini) [V].
12. **Deliverables as files** (docx, xlsx, pptx, pdf, sites) with preview and export (Perplexity, Kimi, Manus, Genspark, ChatGPT, Claude, Vibe) [V/3P].
13. **A connector directory plus custom MCP** (Claude, ChatGPT, Perplexity, Vibe, Manus) [V].
14. **A reasoning control with ≤4 levels** (every product) [V].

### 8.2 Differentiators (one or two products; worth copying selectively)

| Pattern | Who | Why it matters [I] |
|---|---|---|
| **Answer now** (skip thinking, same model) | Gemini [V] | Respects the user's wait; cheap to build if the provider supports it, or emulate by streaming the answer with a lower effort. |
| **Check sources** on selected text | Perplexity [3P], Gemini Double-check [3P] | Trust at claim level; fits Juno's citation chips. |
| **Live view + take over + replay** | Manus [V], Gemini Spark [V], Grok Bot [3P] | Needed if Juno's `browser_agent`/`computer` tool does anything beyond reading. |
| **Wide research grid** (N items → N agents) | Manus [V], Kimi Swarm [V] | Juno has `agent/swarm.ts`; a grid view makes it legible. |
| **Model Council** | Perplexity [3P] | Juno is multi-provider, so a natural fit. |
| **Fullscreen report viewer** (TOC + citations column) | ChatGPT [V] | The right home for research output. |
| **Interrupt and steer mid-run** | ChatGPT DR [V], Meta AI [V] | Changes direction without losing progress. |
| **Forking a thread** | Perplexity [V] | Lets the user explore alternatives. |
| **Motion that tracks state** | Gemini Neural Expressive [V/3P] | Motion as information, not decoration. |
| **Per-conversation data toggles** | Gemini Personal Intelligence [V] | Privacy clarity for connectors and memory. |
| **Build and publish to a link** | Grok Build Mode [V], Perplexity [V], ChatGPT Sites [V] | Juno has artifacts, so publishing is the next step. |
| **Email the agent** | Spark [V], Perplexity [3P], Manus [V] | Not a priority for Juno. |
| **Phone calls** | Genspark [V-25] | Out of scope. |

### 8.3 Anti-patterns seen in the market (avoid)

- **Mode sprawl.** Copilot exposed six modes, then consolidated them and removed Quick Response [3P].
- **Unannounced removals.** ChatGPT agent mode was removed with no deprecation notice (Aug 2026) [3P]. Copilot retired Podcasts, Groups and Deep Research, with a download-before-deletion warning [V].
- **Silent quota cuts on a research tier.** Perplexity's Deep Research quota fell more than 99% (Feb 2026) [3P].
- **Forcing reasoning on summarisation.** It measurably raised hallucination for Grok Think [3P].
- **Trusting server-declared annotations.** The MCP spec says don't [V]. Juno already treats them as evidence only.

---

## 9. Motion and visual notes useful for the thinking and sidebar rework

- **Gemini Neural Expressive (May 2026):**
  - motion corresponds to cognitive state (processing, retrieving, switching mode)
  - a pulsating gradient background on Android
  - haptics confirm state changes
  - a pill composer
  - Live docks inline as a waveform pill instead of taking over the screen
  - responses lead with a bold key point
  - thin, rounded outline icons

  ([9to5Google](https://9to5google.com/2026/05/19/gemini-app-google-io-2026/), [urdesignmag](https://www.urdesignmag.com/google-gemini-neural-expressive-redesign-2026/), [Android Headlines via search](https://www.androidheadlines.com/2026/05/google-gemini-app-redesign-ui-overhaul-2026.html)) [V/3P]
- **Perplexity** (third-party reconstruction, approximate): an icon per phase, three dots staggered 0/200/400 ms on a 1.4 s ease-in-out loop, source cards that fade up over 0.3 s with a 100 ms stagger, and 15 px body text at 1.8 line-height with a ~680 px measure ([Blake Crosley](https://blakecrosley.com/guides/design/perplexity)) [3P].
- **Copilot in Edge:** distinct visual cues for reading, listening and acting [V-25].
- **Gemini Spark:** a progress chip pinned to the top of the thread, which opens the work panel [V].
- **Implication for Juno [I]:**
  - Keep the ThinkingDots and `shimmer-text` language, but make it **state-typed**: a different, subtle motion for *thinking*, *searching/reading*, *running code*, *waiting for you* and *writing*.
  - Keep it at 150–300 ms for transitions, animate transform and opacity only, and honour `prefers-reduced-motion`. Juno already does this for private mode.
  - Stagger new source and favicon arrivals at 60–100 ms.
  - Never animate layout height in the transcript. Collapse and expand inside the panel instead.

---

## 10. Prioritised recommendations for Juno

Context from `docs/JUNO.md` and `src/lib/chat/tool-policy.ts` (read-only look) that these recommendations assume:

- The SSE event types are `activity`, `reasoning`, `sources`, `delta` and `done`.
- The right dock column is `ActivityTimeline` → `ThoughtProcessPanel`. It cannot be open at the same time as the canvas column.
- Research tiers are `quick / standard / deep / max`, with chat defaulting to `deep`.
- Runtime tools are `browser_agent`, which rides the `webSearch` toggle, plus `read_document` and `inspect_image`. `code_interpreter` is offered only when a file is attached and a sandbox exists.
- `action-approval.ts` already has risk classes (`read_only`, `reversible_write`, `external_write`, `destructive_or_sensitive`, `unknown`) and decisions (`allow_once`, `allow_scope`, `deny`).

### P0: fix the foundation ("tool call doesn't work")

1. **One tool-call lifecycle for every tool** [I; modelled on AG-UI and MCP].
   - Emit `tool.start {callId, tool, title, icon, category, risk, parentStepId}`, then `tool.args.delta`, `tool.args.end`, `tool.progress {message, pct?}`, and finally `tool.result {status: ok|error|denied|cancelled, durationMs, summary, content[], structured?, resourceLinks[]}`.
   - Errors split into `protocol` and `execution`. Execution errors go back to the model, as the MCP spec requires.
   - Native search, fetch, code, image generation, research, connectors and MCP all use this contract.
   - Persist it as ordered **message parts**, so a reload renders exactly what the live stream showed.
   - Display name precedence follows MCP: `title` → `annotations.title` → `name`.
2. **Auto-available core tools.**
   - `web_search`, `web_fetch` (read URL) and `code_interpreter` (not only when a file is attached) are on by default, and the model decides when to call them.
   - A per-chat "Tools: auto / off" switch replaces the per-message `webSearch` toggle.
   - Keep the exfiltration guard that tool-policy.ts was written for. Enforce it at the tool (a URL and query-string exfil check after untrusted content, or a domain allowlist for fetches the model makes after reading untrusted text), not by hiding the tool.
   - This matches Gemini, Grok and Perplexity [V].
3. **Transcript rendering.**
   - A running turn shows **one live status row**: an icon plus a present-progressive label ("Searching the web", "Reading 6 pages", "Running Python"), then the timer.
   - When done it collapses to a **summary line** ("Searched 3 queries · read 9 pages · ran code · 14 s") with a **favicon stack**.
   - Clicking the line opens the right panel on that turn.
   - Inline cards appear *only* for results the user needs to see: an image, a created file, a map, a widget, an approval, or an MCP App UI.
4. **Approval card** (Vibe pattern [V]).
   - The card shows the exact payload: recipient, subject and body diff, target resource.
   - Buttons: **Allow once / Always allow for this tool / Deny** (`allow_once`, `allow_scope`, `deny`).
   - A connector **Functions** settings page groups tools into *Read-only* and *Makes changes*, each with an Always allow toggle.
   - MCP annotations stay as evidence only, as today.
5. **Right sidebar → "Activity" panel** with tabs:
   - **Steps**: a typed timeline of thinking, tool calls with input and output, sub-agents, and approvals.
   - **Sources**: favicon, title, snippet; hover highlights the citing claims.
   - **Files**: artifacts, created files, images.
   - **Plan**: the checklist, for research and tasks.

   Other rules for the panel:
   - It follows the running turn and can be pinned to a past turn.
   - It should be a **tab alongside Canvas**, not mutually exclusive with it.
   - On mobile it becomes a sheet, as Gemini now does [V].
   - Keep the "the form cannot lie" rule: real durations vs zero-duration facts.
6. **Thinking.**
   - In the transcript: a single live line with the *latest summary header* and a timer. Afterwards: "Thought for 12 s ›", which opens the panel.
   - Add **"Answer now"**. It maps to an effort downgrade or an early-stop when the provider supports one; otherwise, hide the button.
   - Show raw reasoning only where the provider returns it, inside the panel, and never by default.
   - Do not force thinking on summarise or extract prompts (the Grok evidence above).
7. **Research rework with no tier names.**
   - **One "Research" tool** in the composer.
   - Flow: optional clarifying questions → **plan card**, with editable steps, source scope (Web / specific sites / connectors / files / memory) and a **scope estimate** shown as numbers ("~60 sources · ~8 min · up to $4").
   - A single **"Faster ↔ More thorough"** slider moves the estimate live and maps internally to breadth × depth × page budget. Default it from the model and reasoning effort.
   - Then **Start**: a background run with a notification. Progress lives in the Activity panel (plan checklist, a live source counter with favicons, the current action). The user can **interrupt and steer mid-run** (ChatGPT, Feb 2026 [V]).
   - The report opens in a **fullscreen reader** with a TOC and a citations column (ChatGPT [V]), plus exports (PDF, DOCX, MD), "Turn into canvas/slides", and **Check sources** on text selection (Perplexity [3P]).
   - Delete `quick / standard / deep / max` from the UI and API copy. Keep them only as internal presets, if at all.

### P1: add the tools users expect (ordered by value ÷ effort)

| Tool | Why (market evidence) | Notes [I] |
|---|---|---|
| `web_fetch` (read URL) | Gemini URL context [V], Claude web fetch [O] | Auto. Untrusted-content envelope as today. |
| Always-on `code_interpreter` | Every major product has it [V] | Charts come back as image or file parts. Needs the remote sandbox. |
| `create_file` (docx, xlsx, pptx, pdf, csv, md) | Perplexity, Kimi, Manus, Claude, Vibe [V/3P] | Result is a file chip with preview and download. |
| `generate_image` / `edit_image` as a **model-callable tool** | ChatGPT, Grok, Perplexity, Vibe [V/3P] | Keep the composer toggle as a hint, not a gate. |
| `places_search` + map card | Gemini map-first cards [V-25] | Structured `outputSchema` renders a native map and place list. |
| `quote` / `weather` / `sports_score` widgets | Perplexity, ChatGPT, Copilot [3P/O] | Structured output with native cards; cheap and visible wins. |
| `conversation_search` (past chats) and a visible `memory` tool | Claude, ChatGPT, Perplexity Brain, Vibe KB [3P/V] | Show "Saved to memory" and "Used memory" chips with undo. |
| `schedule_task` | Everyone [V] | Juno already has `juno-scheduler`. |
| **MCP Apps rendering** (`ui://`) | Claude, ChatGPT [V/3P] | Sandboxed double iframe, CSP from `_meta.ui`, consent for UI-initiated calls, `tool-input-partial` streaming. |
| Custom remote MCP (URL + OAuth/CIMD) | Claude, ChatGPT, Perplexity, Vibe, Manus [V] | Target the 2026-07-28 stateless spec with 2025-11-25 fallback. |
| Skills (SKILL.md) | Adopted across the industry [V/3P] | `src/lib/chat/skills.ts` exists; align it with the open format. |

### P2: differentiators that suit Juno's multi-provider identity

- **Model Council**: run 2–4 models in parallel and show a diff or consensus view. Perplexity's is multi-model [3P], and Juno already has 15+ providers.
- **Wide research grid**: a visual for `agent/swarm.ts` with N parallel items and completion counts, like Manus [V].
- **Live browser view with take over and replay** for `browser_agent`/`computer.ts`, if they gain write abilities (Manus, Gemini Spark [V]).
- **Declarative generative UI** in the A2UI spirit, extending Juno's `:::learning` blocks. It avoids arbitrary HTML while matching Gemini's rich responses [I].
- A **progress chip** pinned to the top of the thread for background runs, as in Gemini Spark [V].

### Naming and copy rules [I]

- Live labels are present progressive ("Searching…"); finished labels are past tense with counts ("Searched 3 queries").
- No model, tier or effort jargon in step labels.
- Tool names shown to users come from `title` or a friendly mapping, never raw snake_case.
- Errors have three parts: what happened, why, and what to do next ([Zylos, May 2026](https://zylos.ai/research/2026-05-28-agentic-ux-frontend-design-patterns-ai-agents/)) [3P].

---

## 11. Gaps and unverifiable items

- Perplexity's changelog, blog and help pages, help.openai.com, cybernews and neowin returned **403** to the fetcher. Their content comes from search-engine abstracts or the Releasebot mirror.
- Several Claude and ChatGPT cells in §7 are **[O]** or **[3P]**. The dedicated audits should overwrite them.
- Grok's official release notes page (grok.com/release-notes) rendered empty. Grok mode names come from third-party guides.
- Kimi and Genspark in-run UI (layout of todos, files and preview) is not described in the public text I could fetch.
- The Gemini app's exact Deep Research progress panel in 2026 (site list vs thought list) is not described in current help text. The site list is a 2025 observation.
- The Perplexity motion timings are a third-party reconstruction, not Perplexity's spec.

---

## 12. Source index (primary first)

**Standards**

- MCP changelog 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP changelog 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25/changelog
- MCP Tools (2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- MCP schema.ts (ToolAnnotations): https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts
- MCP Apps SEP-1865: https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp · spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx · blog: https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/
- MCP Registry: https://github.com/modelcontextprotocol/registry
- AG-UI events: https://docs.ag-ui.com/concepts/events
- Agent Skills: https://github.com/agentskills/agentskills
- WebMCP in ChatGPT: https://learn.chatgpt.com/docs/webmcp

**Google**

- Release notes: https://gemini.google/release-notes/
- Deep Research help: https://support.google.com/gemini/answer/15719111
- Gemini Agent / Spark help: https://support.google.com/gemini/answer/16596215 · https://support.google.com/gemini/answer/17094507
- API tools: https://ai.google.dev/gemini-api/docs/tools · Deep Research API: https://ai.google.dev/gemini-api/docs/interactions/deep-research
- Press: 9to5Google (Answer now, Personal Intelligence, Tools redesign, Neural Expressive, Maps cards, connected apps), Android Authority teardown, TechCrunch Spark, Google I/O 2026 list: https://blog.google/innovation-and-ai/technology/ai/google-io-2026-all-our-announcements/

**Perplexity**

- Releasebot mirror: https://releasebot.io/updates/perplexity-ai
- AI UX Playground teardowns: https://aiuxplayground.com/teardowns/perplexity/output/ · /citations/
- MarkTechPost (DR in Computer); SQ Magazine and AlphaSignal (Effort Mode); Semafor (Computer launch)

**xAI**

- https://x.ai/news/grok-4 · https://x.ai/news/grok-build-mode · https://docs.x.ai/docs/guides/tools/overview · Suprmind guide · AY Automate (Grok Bot)

**Mistral**

- https://docs.mistral.ai/vibe/work/safety-and-approvals · https://docs.mistral.ai/vibe/choose-chat-work-code · https://mistral.ai/news/vibe-agent/ · https://mistral.ai/news/le-chat-mcp-connectors-memories/ · InfoQ, WinBuzzer

**Microsoft**

- https://support.microsoft.com/en-us/microsoft-copilot/conversation-modes-in-microsoft-copilot · GeekWire merger and retirements · Releasebot M365 · VentureBeat fall release

**Others**

- Meta: https://about.fb.com/news/2026/04/introducing-muse-spark-meta-superintelligence-labs/ · https://about.fb.com/news/2026/07/meta-ai-muse-spark-doesnt-just-think-it-acts/
- DeepSeek: https://api-docs.deepseek.com/news/news260424/
- Kimi: https://www.kimi.com/en/help/agent/agent-overview
- Manus docs index: https://manus.im/docs/llms.txt (wide-research, cloud-browser, browser-operator) · https://manus.im/blog/manus-max-release
- Genspark: https://www.whytryai.com/p/genspark-beginner-guide

**Claude and ChatGPT reference cells**

- Claude interactive connectors: https://claude.com/blog/interactive-tools-in-claude
- ChatGPT DR viewer: https://www.macrumors.com/2026/02/11/chatgpt-deep-research-mode-document-viewer/
- ChatGPT what's new: https://learn.chatgpt.com/docs/whats-new
- Releasebot for Claude and ChatGPT
- Linas (Anthropic 2026 launches)
