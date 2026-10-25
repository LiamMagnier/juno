# Competitive matrix — 2026-10-25

Phase 0 baseline. What ChatGPT, Claude, Gemini, Perplexity and Grok ship as of
**2026-10-25**, next to what Juno (public name Alevr) has today. The "Juno today"
column uses the statuses in [AUDIT.md](./AUDIT.md). It does not repeat them.

## How to read this

- **Labels:** `GA` = generally available (possibly a staged rollout). `Beta`,
  `Preview` (research preview) and `Exp` (labelled experiment) are as the vendor
  labels them. `Ann.` = announced, not shipped. `?` = not verified in this pass;
  read it as "unknown", not "absent".
- **Sources:** every claim cites `[id]` from the source list at the end. Every
  source was accessed on 2026-10-25. The source type is marked:
  - **OF**: official page, fetched directly.
  - **OS**: official page, read only through search-result snippets.
  - **S**: secondary source (press, blog, aggregator).
  - **T**: tertiary (Wikipedia).
- **Fetch failures:** openai.com, x.ai, gemini.google, blog.google and
  perplexity.ai did not resolve from this sandbox (DNS `ENOTFOUND`). Claims for
  OpenAI, xAI, Google and Perplexity therefore rest on OS/S sources. Treat
  anything from a single S source as provisional.
- **Dates:** a date in a cell is the vendor or press date of the change
  (YYYY-MM-DD, or MM-DD within 2026).

## Matrix

| Capability | ChatGPT (OpenAI) | Claude (Anthropic) | Gemini (Google) | Perplexity | Grok (xAI) | Juno today (see AUDIT) |
|---|---|---|---|---|---|---|
| **Models & reasoning controls** | GPT-6 in Chat, GA from 10-07 (paid) and 10-08 (Free/Go): **GPT-6 Sol** on paid plans, **GPT-6 Luna** on Free/Go, replacing GPT-5.6 [O2,O3]. The Pro thinking level runs **GPT-6 Astra** (Astra reportedly launched 09-03) [O1,O17]. Work and Codex models were not changed by that release [O2]. | **Opus 5.5** (09-22), **Sonnet 5.5** (09-28), **Haiku 5.5** (10-07), **Mythos/Fable 5.1** (09-15): all GA [A1]. Mythos 5.1 is extended to vetted cyber users (10-06) [A1]. | **Gemini 4 Argon**: announced 09-30; in the Gemini app for AI Pro/Ultra from 10-13 (GA) [G1,G2]. Deep Think status conflicts (Argon "to replace" it) [G9]. API retired 3.7/3.5 Flash in favour of 3.8/3.6 Flash (10-08) [G4]. | Multi-model picker, reported to include GPT-6 Astra and an "Effort Mode" (09-21) [P1]. Computer orchestrates about 19 models [P5]. Own open-weight 27B model behind a Decisions API (10-01) [P1]. All S. | **Grok 4.7** (09-21) on API, Cursor and Grok Build [X4]; on Amazon Bedrock [X5]. Grok 5 not shipped [X6]. | 155 registered models (77 current) per `validate-models`. Per-model effort tiers audited (`tests/model-effort-wire.test.ts`). Auto routing: **Implemented and tested**. Model-sync job **red since 10-19** (P0, in progress). |
| **Interactive generated UI** | **Intelligent UI**, GA rollout from 10-07 to all tiers: diagrams, charts, forms, buttons and small on-the-fly tools. A native component library plus a streaming compiler renders it progressively. Not available on the Pro/Astra level or the older desktop apps. OpenAI says it is unfinished [O1,O4,O15]. | **Artifacts**: live artifacts on web and desktop (web only for artifacts created from 08-19) [A3]. Designs, decks and docs can be made as artifacts in any conversation (09-16); Claude Design/Slides/Docs are Beta on Enterprise, off by default [A2]. | Generative UI **"dynamic view"** and **"visual layout"**: Exp, gradual rollout since 2025-11 [G6]. 2026 status `?`. Canvas used for multi-step projects and prototypes (July 2026) [G5]. | Inline charts and 3D visuals (Oct 2026) [P1] (S). | Grok 4.6 marketed for "interactive visual work" (Aug 2026) [X8] (S, unverified). | **Live UI**: spec, web renderers, Swift twin and contract fixtures. **Implemented and tested.** The "intelligent views" are only on the unmerged branch `claude/premium-design-pass`. |
| **Streaming & thinking UX** | Progressive Intelligent UI. Vendor claim: GPT-6 Instant starts search-backed answers 44% sooner (one translation says 32%) [O4]. | Edit drafts in place in chat and Cowork (06-12) [A2]. Thinking display in 2026 `?`. | `?` | `?` | `?` | Stream pacer (web and Swift share a contract), reading-first follow machine, Tether reconnect, durable receipts. Chat streaming: **Production verified** (smoke on main, 10-18). |
| **Deep research & citations** | Deep research: legacy mode removed 03-26; accuracy and citation work 02-10 [O16]. MCP inside deep research reported, unverified [O16]. | Research `?` (not re-verified for 2026). Agent Skills standard donated to the AAIF (10-22) [A1]. | Deep Research exists; 2026 specifics `?`. | Deep Research moved into **Computer**: output as report, spreadsheet, deck, dashboard or site. "Check Sources" claim verification in Comet [P2]. Vendor BrowseComp claim 83.8% [P1] (S). | DeepSearch `?` (not re-verified for 2026). | Research engine: planner, durable worker/lease, claims and gap audit, citations, export. **Implemented and tested.** |
| **Computer use, background agents, scheduling** | **ChatGPT Work** (07-09): long-running background agent over Apps; makes sheets, slides, docs and web apps [O6,O7]. Scheduled Tasks rebuilt 06-2026: recurring, event triggers, monitoring [O6,O7]. Codex background computer use on macOS (04-2026) [O12]. Codex Cloud reusable environments (DevDay 09-29) [O11]. | **Cowork** merged into every conversation (09-16, Pro/Max, gradual) [A2]. Scheduled tasks run **in the cloud** by default from 10-06 [A3]. Computer use is Beta and needs the desktop app [A3]. Claude Tag, Slack delegation (06-23) [A2]. **Claude Duet** proactive agent, Preview (10-21) [A2]. | **Gemini agent** for business (10-08): subagents and a workplace identity [G3]. Chrome **Auto Browse**, AI Pro/Ultra, US (01-28; Android 08-18) [G8] (S). **Scheduled actions** [G5]. Project Mariner discontinued 05-04 [G7]. | **Perplexity Computer**: launched 02-25 (Max), extended to Pro/Ent 03-12; subagents [P4,P5]. Automations: scheduled and event-triggered (10-05) [P1]. Hybrid Compute on Mac (09-01) [P3]. All S. | **Grok Bot**: always-on agents, each on a persistent cloud computer. Early beta 08-11; changelog v0.75.5 on 10-23; in X Chat from 10-22; Slack Team Bots [X1,X2,X3]. Grok Build coding agent [X8]. | Work: cloud executor plus Mac hosts, schedules, event triggers, approvals. Orbit persistent agents. Mac computer use. Docker agent computers, **off by default**. Work/Orbit: **Partial**. Cloud-queue P0 in progress. |
| **Connected apps / MCP** | Connectors renamed **Apps** (12-2025); reportedly renamed "plugins" (07-2026) [O9,T]. ChatGPT is "fully compatible with the MCP Apps spec" [O9]. | Connectors on every surface; local MCP through desktop [A3]. Plugin directory plus developer portal (09-25) [A2]. M365 connector write tools (07-07) [A2]. | Gemini agent connects Workspace, M365, Slack and Jira (business) [G3]. | 400+ managed OAuth connectors plus custom MCP [P3,P5] (S). | Grok Bot connectors (Robinhood, Coinbase, Trello, PostHog, X DMs…) [X3] (S). | User MCP (OAuth, SSRF guard, approval broker), first-party Google Drive/M365, Composio, skills. **Implemented and tested.** Account MCP **not** in Code runtimes yet (PR #97). |
| **Memory & personalization** | Memory draws on past chats (06-25); project-only memory; per-project switch (08-14) [O8]. | Categorized memory entries (07-10). Memory spans chat and Cowork with editable Topics and a sensitive-topics setting (08-25) [A2]. Incognito skips memory [A4]. | "Memories" plus import of history from other AI apps (03-2026) [G5]. Personal Intelligence, now with Maps data [G9]. | Personal memory with management controls. **Brain** memory for Computer, Preview for Max (06-18) [P4,P6] (S). | Memory Beta since 2025-04 (EU/UK excluded at the time) [X7]. 2026 status `?`. | Memory v2: extraction, scopes, project memory, sensitive/suppression, dreaming, import. **Implemented and tested.** |
| **Image / video / docs / data** | **ChatGPT Images 2.0** (gpt-image-2, 04-22): thinking mode on paid plans [O13] (S). Standalone Sora reported shut down (app closed 04-26) [O14]: single S source, unverified. | File and document creation through artifacts (09-16) [A2]. Image/video generation: none found. | Image (Nano Banana) and video (Veo) `?` in this pass. | Computer outputs reports, sheets, decks and dashboards [P2] (S). | Grok Imagine image and video with audio [X6] (S). Grok Bot video creation (10-22) [X1]. | Image generation in chat and Auto (G04, on main). Video generation, attachments, OCR, Python data sandbox. **Implemented and tested.** |
| **Realtime voice** | **GPT-Live-1** (07-08; mini on Free), full-duplex. Video and screen share stayed in legacy Advanced voice as of mid-2026 [O10] (S). | Voice Beta on mobile, desktop and web. Opus/Sonnet available in voice (07-23). Connected apps usable in voice. Turn-based, not duplex [A5,A6] (S). | Gemini Live with camera and screen share on mobile [G10]. Mac app window sharing (04-2026) [G5]. | Voice: no 2026 evidence found (`?`). | Voice mode exists (2025) [X7]. 2026 status `?`. | Realtime relay across OpenAI Realtime, GPT-Live, Gemini Live, xAI, Qwen and MiniMax; voice memory and persona; computer view. **Implemented and tested.** Production smoke covers relay-token issuance only. |
| **Deliverables (docs / slides / sheets)** | Work makes **sheets, slides, docs, web apps** [O6]. | Decks and docs as artifacts (09-16). Design/Slides/Docs Beta on Enterprise; Smart reports Beta on Enterprise (09-10) [A2]. | Canvas prototypes [G5]. Workspace-native output `?`. | Report, spreadsheet, deck, dashboard, website (Computer) [P2] (S). | Grok 4.7 better at document and presentation creation [X4]. Grok Bot "pages" (10-22) [X1]. | Work deliverables (document, presentation, spreadsheet, report, site, validation). Markdown to docx/xlsx/pptx export. **Implemented and tested.** |
| **Projects / files / search** | Projects with project-only memory; shared projects stay project-only [O8]. | Projects on every Cowork surface [A3]. | Gems / Notebook `?`. | Spaces became **Projects** (07-30): shared files, Computer tasks, apps, Brain [P4] (S). | `?` | Projects and collaboration, knowledge ingestion and retrieval, conversation and unified search. **Implemented and tested.** |
| **Mobile / desktop apps** | Desktop "superapp" (ChatGPT + Codex + Atlas) announced 03-19. Linux desktop Preview. Codex Remote steers tasks from a phone [O11] (S). Older macOS/Windows apps lack Intelligent UI [O1]. | Desktop on macOS and Windows; Linux is Beta. Web, mobile, and a Chrome side panel [A3]. Code desktop: nested sessions, saved environments (10-14) [A7] (S). | Mac app (04-2026) [G5]; Android and iOS; Chrome panel [G8]. | Comet browser; Portable Computer for Windows and Linux [P1] (S). | Web, iOS, Android, X [X8] (S). Desktop `?`. | Native macOS (Alevr for Mac 1.12.2) and iOS, plus web. **Implemented and tested.** The macOS app CI job is timing out. |
| **Privacy controls** | Temporary chat and data controls `?` (not re-verified for 2026). | Incognito (no memory or history) [A4]. Enterprise zero data retention plus misuse detection (09-01) [A1]. HIPAA self-serve (07-14). Trusted-device gating for remote Code sessions (06-25) [A2]. | `?` (not re-verified). | Incognito turns off memory and history; AI data-retention opt-out [P6] (S). | `?` | Message and field encryption with key rotation, private (ephemeral) chat, export and delete, MFA. **Implemented and tested.** |

## Where Juno trails, on this evidence

1. **Model-native generated UI.** ChatGPT's Intelligent UI (GA, all tiers) has
   the model choose the layout and build small tools on the fly. Juno's Live UI
   has a bounded spec with both renderers. What it lacks is an automated
   measure of how often and how well Auto picks it, and the newest views are on
   an unmerged branch.
2. **Cloud agents that run while the laptop is closed.** Claude Cowork (cloud
   by default from 10-06), ChatGPT Work, Perplexity Computer and Grok Bot all
   sell this as the default. Juno's cloud paths are degraded:
   - Cloud Code runs fail closed in production (AUDIT §4, row 10b).
   - Cloud Work can queue with no executor (P0, in progress).
3. **Code runtimes with the account's connectors.** Claude Code and Codex both
   ship plugins/MCP in their Code products. Juno's PR #97 is unmerged.
4. **Verified quality.** Competitors ship staged GA rollouts. Juno has strong
   unit coverage, but its cross-platform end-to-end checks are not run in CI.
   The 30-workflow benchmark (PR #87) records 0 runs.

## Where Juno is at or near parity (claimed by code and tests, not measured head-to-head)

- **Breadth of models:** about 155 registered across about 14 labs. No
  competitor exposes other labs' models except Perplexity.
- **Realtime voice:** one relay over several providers.
- **Approval and receipt rigor:** one permission taxonomy, a conformance test,
  receipts bound to args, policy and expiry.
- **Native Mac and iOS clients** with shared Swift/web contracts.

## Sources (all accessed 2026-10-25)

| id | Type | URL | Used for |
|---|---|---|---|
| O1 | OS (fetch failed: DNS) | https://openai.com/index/gpt-6-for-everyone/ | Intelligent UI, tiers, Astra/Pro exclusion |
| O2 | OS | https://community.openai.com/t/gpt-6-is-now-rolling-out-to-all-chatgpt-users/1404163 | GPT-6 rollout dates, tiers, Work/Codex unchanged |
| O3 | OS | https://deploymentsafety.openai.com/gpt-6-october | GPT-6 Sol/Luna replace GPT-5.6 |
| O4 | S | https://www.searchenginejournal.com/chatgpt-gpt-6-intelligent-ui/592249/ | Intelligent UI behaviour, 44% claim |
| O5 | S | https://9to5mac.com/2026/10/07/openai-brings-gpt-6-to-chatgpt-and-debuts-intelligent-ui/ | Rollout date |
| O6 | OS | https://openai.com/index/chatgpt-for-your-most-ambitious-work/ | ChatGPT Work, deliverables, Scheduled Tasks |
| O7 | S | https://www.eesel.ai/blog/chatgpt-work ; https://porteden.com/blog/chatgpt-scheduled-tasks-tools/ | Work launch 07-09, Apps rename, schedule types |
| O8 | OS | https://help.openai.com/en/articles/11391654-chatgpt-business-release-notes | Memory (06-25, 08-14), projects |
| O9 | OS | https://developers.openai.com/plugins/changelog | MCP Apps compatibility |
| O10 | S | https://apidog.com/vi/blog/gpt-live-vs-advanced-voice-mode | GPT-Live-1 (07-08), no video in Live |
| O11 | S | https://capitalandcompute.net/blog/whats-new-in-codex-devday-2026/ | Codex DevDay 09-29, superapp, Remote |
| O12 | S | https://app.dealroom.co/news/feed/openai-s-codex-adds-background-computer-control-and-in-app-browser | Codex background computer use |
| O13 | S | https://neurohive.io/en/news/chatgpt-images-2-0-openai-launches-image-generation-model-with-reasoning-2k-resolution-and-multilingual-text/ | ChatGPT Images 2.0 |
| O14 | S (single source) | https://pictory.ai/?p=18934 | Reported Sora shutdown |
| O15 | S | https://www.techrepublic.com/article/news-gpt-6-intelligent-ui-charts-forms/ | Intelligent UI components |
| O16 | OS | https://help.openai.com/en/articles/6825453-chatgpt-release-notes | Deep research changes |
| O17 | S | https://felloai.com/all-we-know-about-chatgpt-6/ | GPT-6 Astra 09-03 |
| A1 | OF | https://www.anthropic.com/news | Model launches, AAIF skills donation, ZDR |
| A2 | OF | https://support.claude.com/en/articles/12138966-release-notes | Cowork, memory, artifacts, Duet, Tag, plugins |
| A3 | OF | https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile | Surfaces, cloud scheduled tasks, computer use Beta |
| A4 | OS | https://support.claude.com/articles/11817273-how-does-claude-s-memory-work | Incognito and memory |
| A5 | S | https://the-decoder.com/claudes-voice-mode-now-runs-on-anthropics-most-capable-models-across-all-platforms/ | Voice models, turn-based |
| A6 | S | https://www.androidauthority.com/claude-voice-mode-models-tools-3691101/ | Voice Beta, tools |
| A7 | S | https://pasqualepillitteri.it/en/news/24032/claude-code-desktop-nested-sessions-environments | Claude Code desktop 10-14 |
| G1 | S | https://9to5google.com/2026/09/30/gemini-4-argon-announcement/ | Gemini 4 Argon announcement |
| G2 | OS (fetch failed: DNS) | https://blog.google/innovation-and-ai/products/gemini-app/gemini-4-argon-availability/ | Argon in Gemini app, Pro/Ultra |
| G3 | S | https://techcrunch.com/2026/10/08/google-brings-agentic-ai-to-gemini-starting-with-businesses/ | Gemini agent (business) |
| G4 | OS | https://ai.google.dev/gemini-api/docs/changelog | Flash retirements 10-08 |
| G5 | OS (fetch failed: DNS) | https://gemini.google/release-notes/ | Memories import, scheduled actions, Canvas, Mac app |
| G6 | OS | https://support.google.com/gemini/answer/16741341 | Dynamic view / visual layout experiments |
| G7 | T | https://en.wikipedia.org/wiki/Project_Mariner | Mariner discontinued 05-04 |
| G8 | S | https://keywordseverywhere.com/news/gemini-updates/gemini-in-chrome/ | Chrome Auto Browse |
| G9 | S | https://mezha.net/eng/news/mezha-d9696fa9592fbbcaef37175e_gemini_app_adds | Personal Intelligence and Maps, Deep Think |
| G10 | OS | https://www.android.com/articles/gemini-on-android/ | Gemini Live camera and screen |
| P1 | S | https://www.theoxfordaischool.com/new-features-of-perplexity | Oct 2026 Perplexity changes |
| P2 | S (aggregator) | https://releasebot.io/updates/perplexity-ai | Computer in Comet, Check Sources, deliverables |
| P3 | S (vendor comparison) | https://chorus.com/compare/chorus-vs-perplexity | Connectors, MCP, Hybrid Compute |
| P4 | S | https://www.scriptbyai.com/perplexity-ai-timeline/ | Computer timeline, Projects, Brain |
| P5 | S | https://www.gend.co/blog/perplexity-computer-ai-agent-orchestration | Computer architecture |
| P6 | S | https://blog.memoryplugin.com/how-perplexity-memory-works/ | Memory and incognito |
| X1 | OS (fetch failed: DNS) | https://x.ai/changelog/bot | Grok Bot changelog (v0.75.5 10-23; 10-22 features) |
| X2 | S | https://runtimewire.com/article/x-adds-grok-bot-to-x-chat | Grok Bot in X Chat |
| X3 | S | https://aitoolsreview.co.uk/insights/grok-bot-agent-launch | Grok Bot design and connectors |
| X4 | S | https://www.marktechpost.com/2026/09/21/spacexai-releases-grok-4-7/ | Grok 4.7 |
| X5 | OS | https://aws.amazon.com/blogs/machine-learning/grok-4-7-is-now-available-on-amazon-bedrock/ | Grok 4.7 on Bedrock |
| X6 | S | https://felloai.com/all-we-know-so-far-about-grok-5/ | Grok 5 status, Imagine |
| X7 | S | https://www.ubergizmo.com/2025/04/grok-memory-feature/ | Grok memory (2025) |
| X8 | S | https://blog.mean.ceo/?p=9879 | Grok platforms, Grok Build, Grok 4.6 |
| T | T | https://en.wikipedia.org/wiki/ChatGPT | "plugins" rename claim |
