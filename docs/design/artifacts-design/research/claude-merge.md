# Claude's 16 Sept 2026 merge: Chat + Cowork + Artifacts, plus Claude Docs and Claude Slides

Researched 2026-09-23 for Juno (plan: merge Juno Artifacts and Juno Design into one surface).
Builds on `docs/design/artifacts-design/research/claude-primary-evidence.md` (the lead's first-hand notes on
the artifact platform, types and capabilities). That file is not repeated here; this file covers the merge
itself, the product surface around it, Docs, Slides, Cowork's history, and how people reacted.

Confidence tags: **[P]** primary (Anthropic/Claude page, help centre, release notes, or the Claude Docs
connector contract seen first-hand in this session) · **[S]** secondary (press, reviews, HN) · **[I]** inferred.
Dates are publication or "updated" dates. On 2026-09-23 most help-centre pages were marked "Updated this week";
the merge article and the web/desktop/mobile article were marked "Updated over a week ago" (i.e. around the
2026-09-16 launch). Other dates are given where known. A fact-check pass (end of file) re-fetched the sources
on 2026-09-23 and corrected this file in place.

---

## 0. TL;DR for Juno

1. **The mode picker is gone. Routing is implicit, but there are still ways to ask for a type directly.** The
   Chat/Cowork toggle under the message box went away. Claude "figures out what a task needs"
   ([blog](https://claude.com/blog/cowork-is-now-claude), 2026-09-16) [P]. You can still pick a type yourself
   with `/docs`, a templates gallery and a **New artifact** button in the **Artifacts** tab, and an **Output**
   option in the message box that offers Docs / Slides / Design. The help centre documents the Output option
   as part of the current message box ("selecting 'Output' then 'Docs' from the message box"), so it is not
   only a transitional Cowork control
   ([help: Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs);
   [help: artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)) [P].
   go9x saw it in the Cowork composer on accounts not yet migrated
   ([go9x](https://go9x.com/blog/claude-docs-slides-design), 2026-09-23) [S].
2. **Everything is an artifact at one link.** Docs, Slides and Design are typed artifacts. They live in the
   **Artifacts** tab in the sidebar, open in a panel **beside the conversation** that can go full screen, and
   are shared from a **Share** button. The share settings are: scope (only you / people / org / anyone with the
   link) and **latest version vs a specific version** ([help: publish & share](https://support.claude.com/en/articles/9547008-publish-and-share-artifacts)) [P].
3. **One conversation can hold several outputs.** Anthropic's flagship scenario has a report and a 5-slide deck
   made in one thread, so the slides already match the report ([blog](https://claude.com/blog/cowork-is-now-claude)) [P].
   Docs can be turned into Slides ([help: Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs)) [P].
4. **Autonomy is set by one control in the message box.** The permission control offers **Manual**
   (default: Claude asks before each action) and **Auto** (Claude keeps working, with automated safety review).
   You can change it mid-conversation ([help: merge](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude);
   [help: Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)) [P].
5. **Comments go to Claude in both directions.** In Docs you select text and comment. An **@Claude** mention
   makes Claude reply in the thread, make the edit and explain it. Claude also leaves its own comments while it
   drafts ([help: Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs)) [P].
   Design and Slides support comment-level access; Docs does not have a comment-only role yet [P].
6. **The marketing promises more than the help centre confirms.** The blog says the shareable link opens on
   your phone, and in the next sentence that you can select and move elements. It does not say outright that
   you edit on the phone, but press reads it that way (tbreak: "open the work on a phone, select an element to
   move it") [P/S]. The help centre says the **iOS/Android apps are view-only**: you can view artifacts, but
   templates, editing and sharing changes need web or desktop [P]. Docs and Design have **no version history**
   yet, although the general artifact system does [P].
7. **Main complaints:** routing you cannot see, loss of a guaranteed "chat-only" mode, token/cost worries,
   sidebar clutter (Design and Artifacts shown as first-class spaces), scheduled tasks hard to find, branching
   lost, a staged rollout that leaves paid users without the feature, and governance ("your AI policy just
   expired") ([HN](https://news.ycombinator.com/item?id=49729412), 2026-09-16; [smithstephen](https://www.smithstephen.com/p/claude-stopped-asking-which-mode), 2026-09-17) [S].

---

## 1. Timeline: from Cowork to "one Claude"

| Date | Event | Source | Conf. |
|---|---|---|---|
| 2026-01-12 | **Cowork** research preview in Claude Desktop (macOS), Max plan. Agentic knowledge work beyond code, running in an isolated VM. Built on the Claude Agent SDK. The user grants a folder. | [Release notes](https://support.claude.com/en/articles/12138966-release-notes); [TechCrunch, Russell Brandom](https://www.techcrunch.com/2026/01/12/anthropics-new-cowork-tool-offers-claude-code-without-the-code/) | P / S |
| 2026-01-16 | Cowork expands to Pro (macOS) | [Release notes](https://support.claude.com/en/articles/12138966-release-notes) | P |
| 2026-02 | Windows beta (unverified) | [secondary guides](https://techsy.io/en/blog/claude-cowork-guide) | S |
| 2026-02-24/25 | Plugin marketplace and admin controls (Team/Ent). **Scheduled tasks**. New **Customize** section (skills, plugins, connectors) | [Release notes](https://support.claude.com/en/articles/12138966-release-notes) | P |
| 2026-03-12 | Inline interactive charts and diagrams in responses ("custom visuals") | [Release notes](https://support.claude.com/en/articles/12138966-release-notes) | P |
| 2026-03-17/18 | **Dispatch**: one persistent conversation that runs on your computer and that you message from your phone | [Release notes](https://support.claude.com/en/articles/12138966-release-notes); [Forbes](https://www.forbes.com/sites/ronschmelzer/2026/03/20/claude-dispatch-lets-you-control-claude-cowork-with-your-phone/) | P / S |
| 2026-03-23 | Computer use research preview in Cowork and Claude Code (Pro/Max) | [Release notes](https://support.claude.com/en/articles/12138966-release-notes) | P |
| 2026-04-09 | Cowork **GA** on macOS and Windows (Desktop app), plus Cowork analytics, OpenTelemetry and role-based access for Enterprise. *(Corrected: the "shared home" line is in the 2026-07-07 entry, not this one.)* | [Release notes](https://support.claude.com/en/articles/12138966-release-notes) | P |
| 2026-04-16/17 | **Claude Design** (Anthropic Labs) launches at claude.ai/design (Opus 4.7, research preview, Pro/Max/Team/Ent) | [Anthropic news](https://www.anthropic.com/news/claude-design-anthropic-labs); [TechCrunch](https://techcrunch.com/2026/04/17/anthropic-launches-claude-design-a-new-product-for-creating-quick-visuals/) | P |
| 2026-04-20 | **Live artifacts** in Cowork: "Ask Claude to create a dashboard, report, or deck - and whenever you open it, Claude will refetch data from your Connectors" | [Felix Rieseberg on X](https://x.com/felixrieseberg/status/2046334841663389792) (posted 2026-04-20 21:07 UTC; text read via api.fxtwitter.com) | P |
| 2026-06-12 | "Edit Claude's drafts in place": a draft opens beside the chat; highlight the part to change, type the change, and Claude edits it where you marked it (the Cowork help calls the button **Edit with Claude**) | [Release notes](https://support.claude.com/en/articles/12138966-release-notes); [help: Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) | P |
| 2026-07-07 | Cowork on **web and mobile** (rollout starting with Max). Cloud sessions keep working after the laptop closes. Scheduled tasks run with no device online. Phone notifications for decisions. Usage limits doubled to Aug 5. Over 90% of Cowork usage is non-dev work. **"Chat and Cowork also share one home now, with one place for your projects and artifacts across both"**, the first structural step toward the merge | [Claude blog](https://claude.com/blog/cowork-web-mobile); [Release notes](https://support.claude.com/en/articles/12138966-release-notes) | P |
| 2026-07-13 | Public sharing and multiplayer editing for artifacts in Claude Code; artifacts can be created with Claude Tag | [@ClaudeDevs on X](https://x.com/ClaudeDevs/status/2076789349145092230) (2026-07-13, text read via api.fxtwitter.com); [Stacktree](https://stacktr.ee/blog/claude-artifacts-public-sharing) (2026-09-17) | P / S |
| 2026-08-19 | **Updated artifacts system**. New artifacts are saved to your account, shareable in the org, open on the web, can use connectors and ask Claude, and have version history. Pre-Aug-19 live artifacts cannot be edited in place | [Help: artifacts in Cowork](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork) | P |
| 2026-08-25 | "Memory now works across chat and Cowork in the cloud"; memory items listed and editable under **Topics** in Settings > Memory | [Release notes](https://support.claude.com/en/articles/12138966-release-notes) | P |
| 2026-08-26 | Built-in browser in Desktop. Claude in Chrome GA | [releasebot](https://releasebot.io/updates/anthropic/claude) | S |
| **2026-09-16** | **Cowork and chat become "one Claude"**. **Claude Docs** and **Claude Slides** (beta). **Claude Design works inside conversations** | [Claude blog](https://claude.com/blog/cowork-is-now-claude); [TechCrunch, Ivan Mehta](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/) | P |
| 2026-09-17 | **Projects redesigned**: a project becomes a coordinating conversation plus parallel threads. Beta in Claude Code cloud sessions | [Claude blog](https://claude.com/blog/projects-redesigned) | P |

**Reading [I]:** the merge happened in steps over several months: Cowork GA (Apr 9), then a shared home for
projects and artifacts together with cloud sessions on every surface (Jul 7), one artifact system (Aug 19),
shared memory (Aug 25), then the toggle was removed (Sep 16). The visible "merge" was the last step, after the
storage, memory and artifact layers were already shared. Note: the release notes have **no entry** for
2026-09-16 or 2026-09-17; the merge, Docs, Slides and Projects launches are documented only in the blog and
help-centre articles.

---

## 2. What was announced (Sept 16)

Sources: [Claude blog](https://claude.com/blog/cowork-is-now-claude) (2026-09-16, no byline) [P];
[help: merge](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude) [P];
[TechCrunch](https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/) (Ivan Mehta, 2026-09-16) [S].

- **Headline:** you no longer choose where a task goes, and Claude does more of the work. You can ask a quick
  question or hand over a report, and Claude keeps working after the laptop closes [P].
- **Stated rationale:** Anthropic had built Cowork as a separate place for bigger work and Design for visual
  work. Users said the frustrating part was deciding where a task belonged, and work started in one place did
  not carry over to the other. Now Cowork's and Design's capabilities are available from any conversation, with
  the context, skills and connectors you already have [P]. SiliconANGLE and TechCrunch give the same reason:
  customers struggled to pick the right tab ([SiliconANGLE, Mike Wheatley](https://siliconangle.com/2026/09/16/anthropic-brings-cowork-directly-inside-claudes-chat-interface/), 2026-09-16) [S].
- **Customer quote in the blog:** Andrew Keller (Senior Economist) describes Claude pulling cases from a legal
  research database, reading them, finding related cases, downloading them and filing them in a folder [P].
- **Scenario in the blog ("What it looks like"):** a weekly report is due at noon. Before leaving home you ask
  Claude to summarise pipeline changes in the standard format, flag delays, and make 5 slides for leadership.
  Claude asks clarifying questions if needed, and you check progress from your phone on the way in. When you
  arrive, the report and slides are ready and consistent because they came from the same conversation. You
  edit directly, leave comments for Claude, share, and can schedule the task weekly [P].
- **One link:** everything made in Design, Slides or Docs lives at one shareable link that opens on your phone.
  You can select an element and move it, or tell Claude what to change [P].
- **Control:** by default Claude asks before acting. An optional setting lets it keep working and check in only
  when something needs a closer look. You keep the final say [P].
- **Continuity:** chat users do not need to do anything. For Cowork users, chats, projects, artifacts,
  connectors and skills are all where they left them [P].
- **Claude Code stays a separate product** ([Fortune, Beatrice Nolan](https://fortune.com/2026/09/16/anthropic-merges-its-claude-chat-and-agentic-cowork-products-into-a-single-ai-assistant-as-part-of-a-push-to-build-an-ai-superapp/), 2026-09-16; SiliconANGLE) [S].
- **Framing in the press:** a "superapp" push that parallels OpenAI folding ChatGPT, Codex and possibly Atlas
  into one app (Fortune) [S]. Anthropic brings the productivity environment into AI, while Microsoft and Google
  bring AI into productivity suites (Maria Bell, CCS Insight, in [Computerworld](https://www.computerworld.com/article/4223177/anthropic-tries-to-make-claude-stickier-with-launch-of-docs-and-slides.html), 2026-09-17) [S].
- **Staff:** Felix Rieseberg (Anthropic) said on HN that it was his team's launch. He said it gives users more
  capabilities (local files and apps when you are at your computer; Claude keeps working "on its own computer"
  when you close the laptop) and lets you use Claude Design, Docs and Slides directly from conversations. He
  explained why that became possible: Artifacts were made "much more powerful", so whenever Claude makes an app,
  website, design system or anything else, "it can deploy an artifact with multiplayer features and databases"
  ([HN comment 49730108](https://news.ycombinator.com/item?id=49730108), 2026-09-16) [P-ish/S]. This is the
  most direct staff statement that the typed artifact substrate is what made the merge possible.
  *(Corrected:* the Boris Cherny post previously cited here, [x.com/bcherny/status/2100639991244427490](https://x.com/bcherny/status/2100639991244427490),
  is dated 2026-09-17 and is about the **Projects** redesign ("Projects are how I write a lot of my code these
  days... Rolling out now"). It does not say he used the merged product for weeks or that the rollout was
  deliberately slow. That paraphrase came from a search snippet and is unverified.)

---

## 3. What changed in the interface

### 3.1 Composer / message box
- **The Chat and Cowork options under the message box are removed.** The help centre's test for whether you
  have the new experience: if you still see separate "Chat" and "Cowork" options, you do not. Once switched,
  **you cannot go back** ([help: merge](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)) [P].
  Before the change, you picked Cowork from a toggle button below the input box, and the Chrome side panel
  opened straight into Cowork ([VentureBeat, Carl Franzen](https://venturebeat.com/technology/anthropic-is-killing-off-cowork-and-folding-it-into-claude-launching-claude-docs-and-claude-slides), 2026-09-16) [S].
- **Permission control in the message box:** the mode selector in the chat box offers **Auto** and
  **Manual (default)**. Legacy Cowork had a third mode, **Skip all approvals (Skip)**. The new experience lists
  only Auto and Manual ([help: Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)) [P].
- **"+" button (lower left) and "/" commands** open extra options ([help: get started](https://support.claude.com/en/articles/8114491-get-started-with-claude)) [P].
  Known commands: `/deep-research` (or + → **Research**), `/schedule` (scheduled tasks), `/docs` (new doc).
  `/design-sync` (sync a design system) is documented as a **Claude Code** command, not a message-box one ([help: merge](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude); [help: Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork); [help: Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs); [help: Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P].
- **The web search toggle is removed.** Claude searches when it helps [P].
- The **model picker** stays below the input on web and desktop, and at the top on mobile [P].
- **Welcome/home screen:** Anthropic's press image shows a welcome screen with options for the new Docs, Slides
  and Design betas ([Engadget, Mariella Moon](https://www.engadget.com/2259938/anthropics-claude-can-now-create-editable-documents-for-you-cowork-chat-together/), alt text, 2026-09-16) [S].
- **"Output" option (explicit type picker):** the help centre documents an **Output** option in the message
  box: "select 'Output' in the message box to choose a specific type"
  ([help: artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)),
  and "selecting 'Output' then 'Docs' from the message box"
  ([help: Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs)) [P]. go9x saw it
  in the Cowork composer ("Move from chat to Cowork and you'll see a new Output option, and under it the three
  new choices: Docs, Slides and Design"), and says that if it does not show, all three are in the **Artifacts**
  section of the left sidebar ([go9x](https://go9x.com/blog/claude-docs-slides-design), Jan Meinecke,
  2026-09-23) [S]. *(Corrected:* earlier text called it a transitional Cowork-only control. The help centre
  shows it is a current message-box control, so Anthropic ships an explicit output-type picker **alongside**
  implicit routing.)

### 3.2 Sidebar and navigation
- **Recents** now holds quick chats and Cowork tasks together in one list [P].
- **Artifacts tab** in the sidebar is the central library for all artifacts, including Docs, Slides and
  Design. It has a **templates gallery** and a **New artifact** button ([help: artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them); [help: artifacts in Cowork](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork)) [P].
- **Projects** keep files, instructions and context across conversations [P]. They are being redesigned as a
  coordinator conversation plus threads (Section 9).
- **Customize → Connectors** is where apps are connected (Drive, Gmail, M365, Slack) [P].
- Settings: **Settings > General → "Instructions for Claude"** (the former global Cowork instructions);
  **Storage folder** (Cowork's file store, on Desktop) and **Trusted folders**; **Settings > Usage** [P].
- HN users complain that the sidebar gives first-class space to Design and Artifacts that some never use, and
  ask for a customisable sidebar. They also say scheduled tasks take too many clicks to reach
  ([HN saratogacx](https://news.ycombinator.com/item?id=49729412), 2026-09-16) [S].

### 3.3 Where outputs appear
- Artifacts open **in a canvas / side panel beside the conversation** ([help: artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)) [P].
  A doc opens in a **right-side editable panel that can expand to full screen** (go9x) [S].
  Claude Design generates on a **canvas beside the conversation** ([help: Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P].
- Files Claude creates (docx, xlsx, pptx) appear **beside the conversation**, with previews and downloads [P] (unverified: source not re-checked).
- **Custom visuals** (inline HTML charts and widgets in the transcript) are ephemeral. You can copy them as an
  image, download them as SVG/HTML, or save them as an artifact. They are not available on iOS/Android. In
  Cowork sessions they do not support click-to-follow-up ([help: custom visuals](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat), 2026-04-22) [P].
- In Claude Code, Docs open in the desktop side panel, or as a link in the terminal [P].

### 3.4 Known limitations of the merged experience ([help: merge](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)) [P]
- "Add from GitHub" is not supported.
- **Conversation branching is not supported.**
- **Incognito chats fall back to the old experience** (no file creation or code execution).
- Search does not cover older Cowork tasks. You can still find them by name in Recents.
- **Dispatch** is not available to new users. Existing users keep it for now.
- Usage may be measured differently for accounts with and without the new experience during the rollout.

---

## 4. How a request is routed to a doc, a slide deck, a design or an agent task

- **Official line:** Claude decides whether a request needs a quick answer or a task. Cowork is now just
  Claude ([help: Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)) [P].
  Anthropic has not published a routing algorithm or a visible "routing to X" indicator [P, absence].
- **Guidance to users:** describe the outcome ("one-page summary", "spreadsheet with regional tabs"), the
  delivery format (Word, slide deck, Slack-pasteable message) and the inputs (files, links, connected apps).
  Claude offers suggestions when unsure ([help: merge](https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude)) [P].
  In practice you still say what you want (a document, a deck or a plain answer). Only the tab switch is gone
  ([aitoolsreview/aireiter](https://aireiter.com/blog/claude-cowork-is-now-claude-docs-slides-design)) [S].
- **Explicit ways in still exist:** `/docs`, the templates gallery, **New artifact**, the Artifacts tab, and
  the **Output** option in the message box (Docs / Slides / Design) [P].
- **Model-side routing rules (first-hand, this session's Claude Docs connector contract) [P]:**
  - A doc-shaped ask becomes a doc, even when phrased as a question. A quick question gets a chat answer. When
    a doc is made, the chat reply is one short line with the link. The findings go in the doc, not the chat.
  - The artifact platform's `quickstart(intent: document | slides | design | other)` picks the type and
    attaches the default design system (see claude-primary-evidence.md).
- **Complaints:** users want to see which product (Design/Docs/Slides/agent) the request was routed to (HN
  bcorigliano). They also want a guaranteed chat-only mode with no Cowork overhead (HN LoganDark, ChickeNES)
  ([HN](https://news.ycombinator.com/item?id=49729412)) [S]. Fortune cites a Stanford Digital Economy Lab
  analysis that agentic tasks used "roughly 1,000 times more tokens than simple chat reasoning tasks";
  SiliconANGLE raises the same cost risk (its Stanford citation was not confirmed on re-fetch). The worry is
  that routing simple questions through tool-calling machinery raises cost [S].

---

## 5. Claude Docs (beta)

Main source: [Get started with Claude Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P].
First-hand: the Claude Docs connector (MCP) contract in this session (`guide topic.index/comments/tabs`), read 2026-09-23 [P].

### 5.1 What it is
- **Living, rich-text documents** you write with Claude and colleagues. Stored in the Artifacts tab. Multiple
  **tabs** (sections) per doc [P].
- **Content model (connector) [P]:** a doc holds **tabs**. Tabs can be ordered and **nested as sub-tabs**, and
  can be linked with tab "chips". Each tab holds prose, pipe tables, **charts** (widgets embedded by chip),
  task lists (`- [ ]`), **Mermaid** diagrams, LaTeX, CSV grids and uploads. **Chips** are inline objects:
  @mentions, **date chips** (as-of, deadlines), **dropdown chips** tied to an enum (e.g. Status per table
  row), and embeds. The byline is an as-of date chip and an author mention.
- Charts can pull data from connected apps (Salesforce, Google Sheets…) but **do not auto-update**. You must
  refresh them manually [P].

### 5.2 Creating
- Ways in: ask in conversation ("Turn the plan into a product spec"), use the **templates gallery** in the
  Artifacts tab (guided prompts), type `/docs` in the message box, or select **Output → Docs** in the message
  box [P].
- Platforms: web and desktop have full editing. Claude Code opens docs in the desktop side panel or prints a
  link in the terminal. **iOS/Android are view-only** (no templates, no editing) [P].

### 5.3 How Claude writes a doc: skeleton first, then fills while you watch (motion/streaming) [P, first-hand connector contract]
- Claude's first action is to create the doc's **skeleton**: title, byline, and **one "pending" block per
  section**. Each pending block shows its *intent* in place (e.g. "Timeline: milestones by week", or
  "checking the launch thread…"). The doc is **opened on the user's screen right away**.
- Claude then fills **one section per call**, replacing each pending block with a heading and body in reading
  order, and posts a short chat line about what it is working on between sections. The contract gives the
  reason: a single tool call streams nothing, so a doc written in one call would show a long blank page and
  then a wall of text. The design goal is that users **see the plan in place, then watch it fill**.
- Creating the doc is fast: an outline returns in seconds, and every later write renders live into the open doc.
- **Concurrency:** people edit while Claude writes. Claude keeps a `rev` bookmark and reads only changed blocks.
  Edits to blocks Claude did not write are guarded by content hashes. If a person changed those words, **the
  person's words win**, and Claude says what it kept.

### 5.4 Editing and collaboration
- **Direct editing:** click in and type. Changes **auto-save** and show in real time to everyone [P].
- **Conversational edits:** e.g. "Tighten the intro, add a risks section". Claude edits and explains what it
  changed [P]. Legacy Cowork drafts also had **Edit with Claude** (highlight text, click, type a request)
  ([help: Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)) [P].
- **Comments** [P]:
  - Select text and comment for collaborators.
  - Mention **@Claude** in a comment to ask for an edit. Claude **replies in the thread, makes the change, and
    explains what it did and why**.
  - **Claude leaves its own comments while drafting** to explain choices or ask questions.
  - Connector mechanics (first-hand): comments are anchored to 3–6 quoted words. A thread is its first comment;
    replies and **resolve** are rows in the thread. A comment addressed to Claude carries `to: claude` and an
    `answered` flag, so a second session does not answer it twice. A comment **"sent to Claude"** arrives in
    the conversation as its own turn, and Claude must answer **in that doc thread**, not in chat. Limits:
    1,000 threads per doc, 100 comments per thread, 4 KB per comment body.
  - Rules Claude follows on comments: answer questions in the thread without editing; make requested changes;
    leave open points open; reply "needs the owner's answer" when no one has stated the fact.
- **Real-time multi-editor:** people with edit access work at the same time as you and Claude. Claude always
  respects the permissions of whoever made the request [P].
- The viewer publishes what the user is looking at and has selected (tab, block, selection, unsaved edits) into
  Claude's context (claude-primary-evidence.md) [P].

### 5.5 Sharing, export, admin
- **Roles:** Viewer (read) and Editor (read/edit/comment/export). **There is no comment-only role** [P]. The
  permission table in the sharing article lists Docs as View and Edit only ([help: share](https://support.claude.com/en/articles/9547008-publish-and-share-artifacts)) [P].
- **Scope by plan:** Team/Enterprise can invite people or groups or share org-wide, and **external sharing is
  not available**. Pro/Max can **only** share via a public link. Viewers need a Claude account. Only the owner
  can rename or delete, and **deletion is permanent** [P].
- **Export:** Word (.docx), PDF, Markdown, **Google Docs**. You can ask Claude to turn the doc into Claude
  Slides [P].
- **Admin:** on by default for Pro/Max/Team and **off by default for Enterprise**. Pro/Max users can turn it
  off in **Settings > Capabilities**. The org toggle is at **Organization settings > Artifacts > Docs**, and
  access can be limited to groups with the Docs capability (under Artifacts) in custom roles. Docs require
  artifacts to be enabled for the org [P].
- **Limitations:** **no version history**; no comment-only access; charts need a manual refresh; no external
  sharing on Team/Ent; not available with CMEK/ZDR/HIPAA; the Compliance API logs doc-level events only (not
  edits or comments); mobile is view-only [P]. Note that the Docs viewer bundle already includes
  `VersionBar` / `VersionPreviewPane` modules (claude-primary-evidence.md), so version history looks close [I].
  The Docs connector also shows the service already keeps revisions internally: it can read a doc "at rev N"
  (`atRev`) and has a `restore` op that rewinds a tab (connector `topic.editing`, first-hand 2026-09-23) [P].
  What is missing is the user-facing history UI, not the data.
- **Usage:** each request counts against plan limits in proportion to its size [P].
- **Reception (not hands-on):** a reviewer on Max 20x still had no Docs entry in his composer menu two days
  after launch. He says plainly that he has not used Docs, so his piece reports documented facts only. His
  verdict: "cool, and I could live without it... it removes a paste step. It does not replace your editor"
  ([Alarcon](https://christopheralarcon.com/blog/claude-docs), 2026-09-18) [S].
  Coursiv lists real-time co-editing semantics as undocumented ([Coursiv](https://coursiv.io/blog/claude-docs-slides-design)) [S].

---

## 6. Claude Slides (beta)

There is no dedicated help article that could be fetched. Sources are the blog, press, go9x's hands-on, the
sharing article, and the Slides artifact type contract (claude-primary-evidence.md).

- **What it is:** a deck built from your notes, reports or the work already in the conversation. "You can edit
  directly, present straight from Claude, or download as PowerPoint or PDF"
  ([blog](https://claude.com/blog/cowork-is-now-claude)) [P]. The artifacts feature page also lists export to
  "Google Slides, PPTX, PDF and more" ([claude.com/features/artifacts](https://claude.com/features/artifacts), n.d.) [P].
- **Editor (hands-on, go9x 2026-09-23) [S]:** "fully editable" controls like PowerPoint or Google Slides. The
  slide background **colour picker only offers design-system colours**. There are **speaker notes**, written by
  you or drafted by Claude, and a full-screen editing mode. A five-slide brief produced a deck in the
  organisation's design system with branded title slides and custom icons.
- **Type contract (first-hand, claude-primary-evidence.md) [P]:** 16:9 slides on a 1920×1080 canvas. `deck.json`
  holds the title, order, **sections** (a one-sentence outline per section), up to 4 font faces, and design
  systems. There is one HTML `<section>` per slide, using a closed set of elements: shapes, icons,
  **connectors**, a sandboxed **`<x-embed>` live mini-page**, and **speaker notes as `<aside>`**. Slide
  transitions are `fade | push | magic` (magic = morph). **Build-ins** are `fade | rise | pop`. The type
  supports multiplayer **room** presence, and a notes path readable only by admins.
- **Selecting and commenting:** you can select an element and move it, or leave Claude a comment on a slide
  ([blog](https://claude.com/blog/cowork-is-now-claude); [McKelvey](https://justinmckelvey.com/blog/claude-slides), 2026-09-19) [P/S].
  Slides and Design support **View / Comment / Edit** sharing roles. You can add people by name or email, or
  share with anyone in the org who has the link ([help: share](https://support.claude.com/en/articles/9547008-publish-and-share-artifacts)) [P].
- **Consistency with docs:** a deck made in the same conversation as a report "already matches" it [P].
  Serverman says documents and decks can be linked to keep them consistent ([Serverman](https://www.serverman.co.uk/ai/claude/claude-docs-and-slides-what-they-can-and-cant-do/)) [S].
- **Compared with Claude for PowerPoint (add-in):** use Slides for a first draft from notes, a report or numbers.
  Use the add-in when the deck must follow the company master template from slide 1, or to edit an existing
  deck ([McKelvey](https://justinmckelvey.com/blog/claude-slides); [help: PowerPoint add-in](https://support.claude.com/en/articles/13521390-use-claude-for-powerpoint)) [S/P].
- **Open questions:** Anthropic has not said whether PPTX export keeps editable text boxes and native shapes
  ([Coursiv](https://coursiv.io/blog/claude-docs-slides-design)) [S]. Chart and graphic accuracy is uncertain
  because the PowerPoint add-in had documented problems ([Serverman](https://www.serverman.co.uk/ai/claude/claude-docs-and-slides-what-they-can-and-cant-do/)) [S].
  Present-mode controls (presenter view, keyboard) are not documented in any source I could reach [gap].
- **Admin:** has its own toggle on the same **Organization settings > Artifacts** page as Docs and Design
  ([help: Design admin](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans)) [P].

---

## 7. Claude Design inside conversations

- **Two modes** ([help: Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)) [P]:
  - **Integrated (default):** Design works in any Claude conversation, in Claude Code, and from the Artifacts
    tab. You describe what you want and Claude generates a working design **on the canvas beside the
    conversation**.
  - **Standalone:** claude.ai/design "keeps working, and your existing projects stay where they are". It has
    its own admin setting. The help centre does not say in so many words that storage is separate; that
    existing standalone projects do not move into the Artifacts library is an inference [P/I].
- **Refinement methods:** direct canvas editing (drag, resize, align with rich layout controls), inline comments
  on a clicked area ("make this button padding larger"), chat for structural changes, and "tell Claude to save
  the current work before exploring an alternative" (manual branching, because there is no version history) [P].
  At the April launch Design also had adjustment sliders (spacing, colour, layout), direct text edits, and a
  web-capture tool ([Anthropic news](https://www.anthropic.com/news/claude-design-anthropic-labs), 2026-04-17) [P].
- Hands-on: the canvas has a Figma-like layout with pages, a layers panel and a properties panel on the right.
  One promo prompt produced 4 size variants (16:9, email, community, 1:1) (go9x) [S].
- **Design systems:** the org's brand is applied automatically. `/design-sync` (a Claude Code command) syncs
  from GitHub, design files or a local codebase. Enterprise admins can lock approved systems. There is a "Claude Design Admin" custom-role
  permission (publish, set defaults, delete) [P].
- **Export:** .zip, PDF, PPTX, standalone HTML. Direct integrations with Canva, Adobe Experience Manager,
  HubSpot, Miro, Netlify, Vercel and others. Handoff to Claude Code [P].
- **Admin toggles:** Design in conversations and the Artifacts tab is under **Org settings > Artifacts >
  Design** (on for Team, off for Enterprise by default). Standalone Design is under **Org settings >
  Capabilities > Claude Design**. Changes take up to 15 minutes ([help: Design admin](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans)) [P].
- **Limitations:** comments sometimes do not persist; limited simultaneous multi-person editing; no version
  history; output quality depends on the source design system; mobile is view-only [P].
- **Correction:** TNW wrote that Anthropic launched Claude Design in April "using Canva's design engine"
  ([TNW](https://thenextweb.com/news/anthropic-claude-cowork-merge-docs-slides), Ana Maria Constantin,
  2026-09-17). Anthropic's launch post says Design "is powered by... Claude Opus 4.7" and names Canva only as
  an export target ("export to Canva, PDF, PPTX, or standalone HTML"), with a Canva quote about bringing drafts
  "from Claude Design into Canva" ([Anthropic news](https://www.anthropic.com/news/claude-design-anthropic-labs),
  2026-04-17) [P]. Treat TNW's claim as wrong.
- **Lock-in incident:** in May 2026 a user lost access to their Claude Design projects after downgrading. Thariq
  (Claude team) promised downloads would stay possible after unsubscribing. Workaround: the account data export
  includes a `design_chats` folder ([HN 48128003](https://news.ycombinator.com/item?id=48128003), 2026-05-13/14) [S].

---

## 8. The "one shareable link" model, sharing and mobile

- **Share flow for the new experience (Design/Slides/Docs/Code artifacts) [P]**
  ([help: share](https://support.claude.com/en/articles/9547008-publish-and-share-artifacts)):
  open the artifact → **Share** → (Team/Ent) add people or groups and set access → choose scope → choose
  **Latest version** (viewers see live updates) or **Specific version** (a snapshot) → copy the link.
  - Scope on Pro/Max: *Only you* / *Anyone with the link*. On Team/Ent: *Only people with access* /
    *Everyone in your organization* / *Anyone with the link*. Enterprise owners must enable **External
    sharing** first [P].
  - Roles: Docs View/Edit. Design/Slides View/Comment/Edit. Other artifacts View/Edit [P].
  - Viewers need a Claude account. Artifacts that use connected apps or ask Claude cannot be shared externally.
    **A shared artifact uses the viewer's own connectors and access, not the owner's**, and each viewer
    approves their own connectors ([help: artifacts in Cowork](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork)) [P].
  - Old chat artifacts still use the previous "Publish" / "Share & copy link" flow. Unpublishing deletes their
    storage, and they cannot be re-published [P].
- **Versions:** every update to an updated-system artifact saves a new version, and you can restore or link a
  specific one ([help: artifacts in Cowork](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork)) [P].
  Docs and Design say "no version history yet" [P]. So version history exists for generic artifacts but not
  yet for the Docs and Design types.
- **Mobile:**
  - Marketing: one link you can open on your phone, and you can "select an element and move it" ([blog](https://claude.com/blog/cowork-is-now-claude)) [P].
    The two sentences are adjacent; the blog does not say explicitly that editing happens on the phone. Press
    reads it as phone editing: tbreak ("Users can open the work on a phone, select an element to move it, or ask
    Claude to change it", [tbreak](https://tbreak.com/claude-docs-slides-one-claude/), 2026-09-17) and
    mixed-news. TechCrunch only mentions "mobile access". VentureBeat's text as fetched does not make the claim [S].
  - Help centre: the iOS/Android apps can **view** artifacts in the Artifacts tab. **Editing and template
    selection need web or desktop**. **Sharing settings cannot be changed in the apps**. Docs and Design are
    view-only on mobile [P].
  - [I] Phone editing probably means the web link in a mobile browser, or is still planned. Either way, the
    native apps are view-only today. The Docs viewer bundle includes a `BottomSheet` module for mobile
    (claude-primary-evidence.md).
  - Agent tasks on mobile: start or steer tasks, answer Claude's questions, and get **phone notifications** when
    a task finishes or needs input ([help: web/desktop/mobile](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)) [P].

---

## 9. Control: "ask before acting" vs "keep working"

- **Manual (default):** Claude pauses before each action, and you choose **Allow** or **Deny** [P].
- **Auto:** Claude keeps working. It reviews each action for safety (e.g. data exfiltration, prompt injection)
  and blocks anything unsafe [P].
- The legacy Cowork **Skip** mode (no approvals and no automatic checks) is not offered in the new message-box
  control [P].
- The control lives in the **mode selector in the chat box** and can be changed **mid-conversation**. You can
  stop or redirect Claude at any time [P]. Computer use asks before permanently deleting files by default [P].
- Guidance and critique: use Manual for anything touching client files or connected accounts. Invisible routing
  makes policies that distinguish "Chat" from "Cowork" obsolete, and individual Pro/Max accounts convert without
  company oversight ([Stephen Smith](https://www.smithstephen.com/p/claude-stopped-asking-which-mode), 2026-09-17) [S].
  On HN, a user (Selkirk) said the merge removes a simple, easy-to-understand risk-management tool, and
  Anthropic did not address this directly (HN) [S].

---

## 10. What happened to Cowork's features

| Cowork feature | After the merge | Conf. |
|---|---|---|
| Chat/Cowork toggle | Removed. The new experience is permanent once enabled | P |
| Cowork tasks list | Merged into **Recents** with chats. Old tasks are not searchable but can be found by name | P |
| Background cloud execution | Kept. Tasks continue after you close the app, and results wait in the conversation | P |
| Local files / browser / computer use | Kept. They need Claude Desktop running (built-in browser or Claude in Chrome) | P |
| Scheduled tasks | Kept (`/schedule`). They run in the cloud with no device online | P |
| Projects | Kept. Files, instructions and context carry across conversations. Redesign underway (below) | P |
| Global instructions | Moved to **Settings > General → Instructions for Claude** | P |
| Cowork storage folder | Stays on Desktop. Find it via **Storage folder** in Settings. Granted folders are listed as **Trusted folders** | P |
| Task-local memory | Stays with its task. Account memory spans all conversations (Aug 25) | P |
| Dispatch | Not available to new users. Existing users keep it for now | P |
| Skills, plugins, connectors | Kept (Customize) | P |
| Artifacts (incl. live artifacts) | Kept. Pre-Aug-19 live artifacts work but can't be edited in place, so republish them to edit | P |
| Skip-all-approvals mode | Not offered in the new message-box control (Auto/Manual only) | P |
| "Add from GitHub", branching | Not supported in the new experience | P |
| Incognito | Uses the old experience (no file creation or code execution) | P |
| MCP file deletion | One XDA commenter says deleting files via MCP was removed and calls it a productivity loss ([XDA comments](https://www.xda-developers.com/anthropic-merges-claude-cowork-and-chat-into-one-singular-claude/)) | S (unverified) |

**Projects redesign (2026-09-17)** ([blog](https://claude.com/blog/projects-redesigned)) [P]: a project changes
from a folder into a **standing conversation with a "chief of staff"**. You brief the main project chat, and it
scopes, delegates, runs **parallel threads** (each a Claude Code cloud session on its own branch; overlapping
edits become merge conflicts), reviews and assembles the result. You follow progress "in the main project
chat, or dive into each individual thread", and you can steer "even from your phone". *(Corrected:* the blog
does not mention a progress sidebar.) There is shared project memory, and a **Library** that "collects the
files you add and the artifacts produced by Claude". The beta is for "select Claude Pro and Max subscribers who
use cloud sessions in Claude Code and don't have any existing projects on the web or desktop", with a waitlist;
chat, Cowork and Team/Enterprise come later. Coverage points out that the availability is narrower than the headline suggests
([MindStudio](https://www.mindstudio.ai/blog/claude-projects-redesign-cowork-chat-merge), 2026-09-19) and that
threads can use up limits quickly ([mixed-news](https://mixed-news.com/en/anthropic-merges-claude-cowork-into-chat-adds-claude-docs-slides/), 2026-09-18) [S].

---

## 11. Rollout and availability

- The merged experience rolls out gradually from 2026-09-16: **Pro and Max first**, on web, desktop and mobile,
  "over the coming weeks". **Team and Free will follow soon**. **Enterprise admins get at least 30 days'
  notice** [P].
- The rollout is staged **by account, not just by plan**, so two people on the same plan may get it weeks apart
  ([McKelvey](https://justinmckelvey.com/blog/claude-slides)) [S]. The help centre confirms that accounts on the
  same plan may get it at different times [P].
- Docs, Slides and Design are **beta on paid plans** (Pro, Max, Team, Enterprise), not on Free. Enterprise
  admins choose when to turn them on [P].
- There is no API for the unified routing or for the new types yet (Coursiv, aireiter) [S] (unverified: not
  found in the re-fetched Coursiv text; aireiter not re-checked).

---

## 12. Motion, streaming and presence (what is actually documented)

| Pattern | Detail | Source / conf. |
|---|---|---|
| Doc skeleton, then section-by-section fill | Title, byline and pending blocks (each showing its intent) appear within seconds and the doc opens on screen. Each section then replaces its placeholder in reading order, with short chat status lines between. Writes appear as whole blocks, not token by token | Docs connector contract (first-hand) [P] |
| Live co-editing | Everyone's edits, including Claude's, appear in real time. There is a room/presence capability | [help: Docs](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs) [P]; claude-primary-evidence.md [P] |
| Slide transitions and build-ins | Transitions `fade`, `push`, `magic` (morph). Build-ins `fade`, `rise`, `pop`. Durations and easing are not documented | Slides type contract (claude-primary-evidence.md) [P] |
| Agent progress | Progress indicators show what Claude is doing at each step, and it surfaces its reasoning and approach. Sub-agents run in parallel | [help: Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) [P] |
| Rotating tips / feature ads while Claude works | Users asked to be able to turn them off | HN [S] |
| Cross-device handoff | Push notifications when a task finishes or needs a decision. Resume on any surface | [help: web/desktop/mobile](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile) [P] |
| Inline custom visuals | HTML widgets in the transcript. Interactive (buttons, sliders). Can be saved as an artifact | [help: custom visuals](https://support.claude.com/en/articles/13979539-custom-visuals-in-chat) [P] |
| Design Play mode | Prototype links open in Play mode | claude-primary-evidence.md [P] |
| Mode toggle removal | Not animated. The Chat/Cowork option simply disappears once the account is migrated | help: merge [P] |

No source I could reach gives durations, springs or easing curves for the panel open/close, the full-screen
expansion or the streaming effects. Those would have to be observed first-hand.

---

## 13. Reactions and reported problems

**HN front page "Claude Cowork and chat are now one Claude"** (234 points, 225 comments, 2026-09-16,
[item 49729412](https://news.ycombinator.com/item?id=49729412)) [S]:
- **Losing chat as a "think first, act later" mode.** Some users valued a separate reasoning surface (Sherveen)
  and want a way to guarantee Cowork never kicks in (LoganDark, ChickeNES).
- **Routing is opaque.** Users ask which product handled the request (bcorigliano) and how Claude decides the
  effort level. Cowork writes intermediate files to disk, while chat answers inline (Centigonal).
- **Token and billing worries.** *(Corrected:* the Sn0wCoder and no_no_no_yes comments are about **ChatGPT**,
  where "Work" and scheduled tasks draw on Codex tokens, not about Claude billing.) The worry transfers to
  Claude by analogy, and the help centre concedes usage "may be measured slightly differently" during the
  rollout [P].
- **Safety regression.** Capabilities are now on by default rather than opt-in (Selkirk).
- **Chat is a poor interface for multi-day work.** Hard to track progress, e.g. which of 10 chats holds a
  question (cpinto). Users want tree branching (clumsysmurf), which the new experience does not support [P].
- **Sidebar clutter.** Design and Artifacts get first-class space. Users want a customisable sidebar, and
  scheduled tasks take too many clicks (saratogacx). Users want to turn off rotating tips.
- **Other requests:** org-wide skill/plugin management (jimmydoe, Kerbonut), cross-project memory (dbbk), a
  "Claude Sheets" (ecliptik).
- **Praise:** simpler for the ~95% of non-technical users (adrithmetiqa, alansaber). dbbk, a technical user,
  said he could not work out the difference between ChatGPT's Chat and Work modes (other than billing), which
  supports the "users can't pick a mode" rationale by analogy.
- **Staff framing:** Felix Rieseberg: "we made Artifacts much more powerful... it can deploy an artifact with
  multiplayer features and databases" (see Section 2).
- **Slides specifically:** worries about people presenting AI decks they have not read, and a claim that 40% of
  conference slides are now LLM-made with noticeably lower quality (idle_zealot, Cyan488, wasabi991011).

**Press and analysts [S]:**
- Cost: agentic routing may raise compute per query, citing the Stanford estimate of about 1,000x tokens (Fortune,
  SiliconANGLE, Coursiv).
- Coursiv summarises mixed reception: some welcome the Design integration, others question output quality
  ([Coursiv](https://coursiv.io/blog/claude-docs-slides-design)). (The "rename of existing features" wording
  was not found on re-fetch; unverified.)
- Gartner (Arun Chandrasekaran) calls it a move from assistant to an agentic platform for the full lifecycle of
  knowledge work, with near-term demand for recurring, template-driven work (status reports, board decks). Jack
  Gold doubts that suite users will switch. CCS Insight (Maria Bell) says it has to be compelling enough to form
  new habits ([Computerworld, Matthew Finnegan](https://www.computerworld.com/article/4223177/anthropic-tries-to-make-claude-stickier-with-launch-of-docs-and-slides.html), 2026-09-17).
- Reliability: a wrong figure in a board deck is expensive, so Docs and Slides need provenance, reliable
  calculations and granular edit controls ([Ultrathink](https://ultrathink.ai/news/claude-docs-and-slides-productivity-workspace), 2026-09-16).
- Google's advantage is that Gemini is built into Docs, Sheets and Slides ([Techweez](https://techweez.com/2026/09/17/claude-docs-slides/), 2026-09-17).
- TechCrunch's only opinion: it hopes OpenAI takes the cue and fixes ChatGPT's interface across platforms [S].
- Rollout frustration: paid users without access days later (Alarcon's Max account had no Docs entry on
  Sept 18; MindStudio on Projects access) [S].
- Governance: invisible routing makes AI-use policies obsolete (Stephen Smith) [S].

Reddit could not be reached from this environment (domain blocked for the crawler). The Verge's article
(["Anthropic launches Google Docs alternative"](https://www.theverge.com/ai-artificial-intelligence/996234/anthropic-one-claude-cowork-docs-slides), 2026-09-16) could not be fetched.

---

## 14. Contradictions and open questions

1. **Mobile editing:** the blog says you can open the link on your phone, and next to that that you can select
   and move elements; press (tbreak, mixed-news) reads this as phone editing. The help centre says the native
   apps are view-only and can't change sharing. Resolve first-hand (mobile web vs app).
2. **Docs comments:** Docs has no comment-only role. Slides and Design have View/Comment/Edit.
3. **Version history:** generic artifacts have versions and restore. The Docs and Design types say "no version
   history yet", but the Docs viewer ships `VersionBar` and `VersionPreviewPane`, and the Docs connector can
   already read a doc at an earlier rev and `restore` a tab.
4. **Permission modes:** the new message box has only Auto and Manual. Legacy Cowork also had Skip.
5. **Real-time co-editing in Docs:** the help centre says yes. Coursiv and Alarcon call it unconfirmed. The
   connector contract describes concurrent human edits with guards [P].
6. **Present mode** controls, speaker view and PPTX fidelity are undocumented.
7. **Routing transparency:** no indicator of the route taken is documented.
8. **TNW "using Canva's design engine"** is wrong: Anthropic's launch post names Opus 4.7 and lists Canva only as an export target.

---

## 15. Implications for Juno's Artifacts + Design merge [I]

- **Merge the storage and identity layer before the UI.** Anthropic shared the home, then artifacts, then
  memory, and removed the toggle last. For Juno: make DESIGN a regular artifact type in one library and one
  share model first, then collapse the entry points.
- **Implicit routing, plus explicit ways to pick a type.** Anthropic kept an explicit **Output** picker
  (Docs / Slides / Design) in the message box next to implicit routing. Keep a type picker (an Output menu,
  `/doc`, `/slides`, `/design`, a templates gallery, "New artifact") and consider showing which type Claude is making. Transparency was the top
  ask on HN.
- **Panel beside the chat → full screen → shareable link** is the progression users follow for every type.
  Design uses the same side canvas as Docs and Slides, not a separate app. Keep a standalone deep editor
  (Anthropic kept claude.ai/design with separate storage), but make the in-conversation panel the default.
- **Plan first, then fill, as the streaming model:** create a skeleton with intent placeholders, open it
  immediately, and fill one section at a time. This works for docs, slides and design boards alike.
- **Comments as the shared channel between people and the model:** anchored threads, @Claude or "send to
  Claude", Claude replying in the thread, and Claude leaving its own rationale comments. Record answered and
  resolved state so parallel sessions do not answer twice.
- **Pitfalls to avoid:** view-only mobile after promising phone editing; missing version history on the
  flagship types; a cluttered sidebar; hard-to-find scheduled or background work; losing branching; unclear
  cost when routing simple asks to heavy agent paths; lock-in (keep export available after a downgrade).

---

## Sources

| Title | URL | Date |
|---|---|---|
| Claude Cowork and chat are now one Claude (Claude blog) | https://claude.com/blog/cowork-is-now-claude | 2026-09-16 |
| Claude Cowork and chat are one Claude (Help Center) | https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude | updated wk of 2026-09-16 |
| Get started with Claude Docs (Help Center) | https://support.claude.com/en/articles/16923645-get-started-with-claude-docs | updated wk of 2026-09-16 |
| Get started with Claude Design (Help Center) | https://support.claude.com/en/articles/14604416-get-started-with-claude-design | updated wk of 2026-09-16 |
| Claude Design admin guide (Help Center) | https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans | updated wk of 2026-09-16 |
| Publish and share artifacts (Help Center) | https://support.claude.com/en/articles/9547008-publish-and-share-artifacts | updated wk of 2026-09-16 |
| What are artifacts (Help Center) | https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them | updated wk of 2026-09-16 |
| Use artifacts in Claude Cowork (Help Center) | https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork | updated wk of 2026-09-16 |
| Get started with Claude Cowork (Help Center) | https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork | updated wk of 2026-09-16 |
| Use Claude Cowork on web, desktop, and mobile (Help Center) | https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile | ~2026-09 |
| Custom visuals in chat and Cowork (Help Center) | https://support.claude.com/en/articles/13979539-custom-visuals-in-chat | 2026-04-22 |
| Get started with Claude (Help Center) | https://support.claude.com/en/articles/8114491-get-started-with-claude | updated wk of 2026-09-16 |
| Create and edit files with Claude (Help Center) | https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude | 2026-08-06 |
| Claude release notes (Help Center) | https://support.claude.com/en/articles/12138966-release-notes | Jan–Sep 2026 |
| Claude Cowork on web and mobile (Claude blog) | https://claude.com/blog/cowork-web-mobile | 2026-07-07 |
| Projects redesigned: from folder to conversation (Claude blog) | https://claude.com/blog/projects-redesigned | 2026-09-17 |
| Claude Artifacts feature page | https://claude.com/features/artifacts | n.d. (current) |
| Introducing Claude Design by Anthropic Labs | https://www.anthropic.com/news/claude-design-anthropic-labs | 2026-04-17 |
| Claude Docs connector contract (guide topic.index/comments/tabs), first-hand in session | (MCP, this session) | 2026-09-23 |
| TechCrunch: Anthropic merges Claude chat and Cowork in one interface (Ivan Mehta) | https://techcrunch.com/2026/09/16/anthropic-merges-claude-chat-and-cowork-in-one-interface/ | 2026-09-16 |
| TechCrunch: Anthropic's new Cowork tool (Russell Brandom) | https://www.techcrunch.com/2026/01/12/anthropics-new-cowork-tool-offers-claude-code-without-the-code/ | 2026-01-12 |
| TechCrunch: Anthropic launches Claude Design | https://techcrunch.com/2026/04/17/anthropic-launches-claude-design-a-new-product-for-creating-quick-visuals/ | 2026-04-17 |
| Fortune (Beatrice Nolan): superapp push | https://fortune.com/2026/09/16/anthropic-merges-its-claude-chat-and-agentic-cowork-products-into-a-single-ai-assistant-as-part-of-a-push-to-build-an-ai-superapp/ | 2026-09-16 |
| VentureBeat (Carl Franzen): killing off Cowork | https://venturebeat.com/technology/anthropic-is-killing-off-cowork-and-folding-it-into-claude-launching-claude-docs-and-claude-slides | 2026-09-16 |
| SiliconANGLE (Mike Wheatley) | https://siliconangle.com/2026/09/16/anthropic-brings-cowork-directly-inside-claudes-chat-interface/ | 2026-09-16 |
| Engadget (Mariella Moon) | https://www.engadget.com/2259938/anthropics-claude-can-now-create-editable-documents-for-you-cowork-chat-together/ | 2026-09-16 |
| XDA (Simon Batt) | https://www.xda-developers.com/anthropic-merges-claude-cowork-and-chat-into-one-singular-claude/ | 2026-09-16 |
| The Next Web (Ana Maria Constantin) | https://thenextweb.com/news/anthropic-claude-cowork-merge-docs-slides | 2026-09-17 |
| Computerworld (Matthew Finnegan) | https://www.computerworld.com/article/4223177/anthropic-tries-to-make-claude-stickier-with-launch-of-docs-and-slides.html | 2026-09-17 |
| tbreak (Abbas Jaffar Ali) | https://tbreak.com/claude-docs-slides-one-claude/ | 2026-09-17 |
| Techweez | https://techweez.com/2026/09/17/claude-docs-slides/ | 2026-09-17 |
| Ultrathink | https://ultrathink.ai/news/claude-docs-and-slides-productivity-workspace | 2026-09-16 |
| mixed-news (Shane S. Ellison) | https://mixed-news.com/en/anthropic-merges-claude-cowork-into-chat-adds-claude-docs-slides/ | 2026-09-18 |
| Stephen Smith: Claude stopped asking which mode | https://www.smithstephen.com/p/claude-stopped-asking-which-mode | 2026-09-17 |
| go9x: Claude Docs, Slides and Design (hands-on) | https://go9x.com/blog/claude-docs-slides-design | 2026-09-23 |
| Coursiv: open questions | https://coursiv.io/blog/claude-docs-slides-design | ~2026-09-17 |
| Serverman: what Docs and Slides can/can't do | https://www.serverman.co.uk/ai/claude/claude-docs-and-slides-what-they-can-and-cant-do/ | 2026-09-16 |
| Christopher Alarcon: Claude Docs verdict | https://christopheralarcon.com/blog/claude-docs | 2026-09-18 |
| Justin McKelvey: Claude Slides | https://justinmckelvey.com/blog/claude-slides | 2026-09-19 |
| aireiter: Cowork is now Claude | https://aireiter.com/blog/claude-cowork-is-now-claude-docs-slides-design | ~2026-09-17 |
| MindStudio: Projects redesign access | https://www.mindstudio.ai/blog/claude-projects-redesign-cowork-chat-merge | 2026-09-19 |
| Hacker News: Claude Cowork and chat are now one Claude | https://news.ycombinator.com/item?id=49729412 | 2026-09-16 |
| Hacker News: "Tell HN: Dont use Claude Design, lost access to my projects after unsubscribing" (302 points) | https://news.ycombinator.com/item?id=48128003 | 2026-05-13 (Thariq reply 2026-05-14) |
| Felix Rieseberg on X: Live Artifacts | https://x.com/felixrieseberg/status/2046334841663389792 | 2026-04-20 (read via api.fxtwitter.com) |
| @ClaudeDevs on X: artifacts public sharing + multiplayer in Claude Code | https://x.com/ClaudeDevs/status/2076789349145092230 | 2026-07-13 (read via api.fxtwitter.com) |
| Boris Cherny on X: Projects rollout (not the merge) | https://x.com/bcherny/status/2100639991244427490 | 2026-09-17 (read via api.fxtwitter.com) |
| Forbes: Claude Dispatch | https://www.forbes.com/sites/ronschmelzer/2026/03/20/claude-dispatch-lets-you-control-claude-cowork-with-your-phone/ | 2026-03-20 |
| releasebot: Claude updates | https://releasebot.io/updates/anthropic/claude | 2026-09 |
| Stacktree: artifacts public sharing and multiplayer | https://stacktr.ee/blog/claude-artifacts-public-sharing | 2026-09-17 (about the 2026-07-13 launch) |

---

## Fact-check (adversarial pass, 2026-09-23)

Method: re-fetched every primary URL cited for the 15 load-bearing claims, plus the secondary sources behind
surprising claims. Release notes were read from the raw page (all 2026 entries). HN threads were read in full
via the Algolia API (`hn.algolia.com/api/v1/items/<id>`). X posts were read via `api.fxtwitter.com`, and their
dates were cross-checked by decoding the status-ID timestamp. The Docs connector `guide` (topic.index,
topic.comments, topic.editing) was read first-hand. The web-search budget was used up, so second sources come
from direct fetches only.

**Verified (no change needed):** chat + Cowork merged 2026-09-16 with no toggle, and the switch cannot be
undone per account (help: merge). Claude decides "quick answer or a task" (help: Cowork). Docs and Slides are
beta on paid plans; Design works in conversations; Design launched 2026-04-17 (release notes, Anthropic
news). Manual (Allow/Deny) and Auto (safety review for exfiltration and prompt injection) modes; Skip not
offered in the new message box. Native mobile apps are view-only and cannot change sharing (help: Docs,
artifacts, Design, share). Docs: no version history, no comment-only role, Pro/Max link-only sharing, no
external sharing on Team/Ent, export to Word/PDF/Markdown/Google Docs. @Claude comment behaviour and Claude's
own drafting comments (help: Docs, quoted exactly). Skeleton-first doc writing: pending intent blocks, open
the doc right away, one section per call, and the "a call streams nothing" rationale (connector topic.index).
Comment limits of 1000 threads, 100 comments and 4096 bytes (topic.comments). The "their words win" guard
(topic.editing). Share flow (scope, then latest or specific version) and roles (Docs View/Edit; Design and
Slides View/Comment/Edit). Shared artifacts use the viewer's connectors. Artifacts that use connected apps or
ask Claude cannot be shared externally. Limitations: no GitHub import, no branching, incognito uses the old
experience, Dispatch closed to new users. Cloud sessions and notifications (2026-07-07). Memory across chat
and Cowork (2026-08-25). Updated artifacts system (2026-08-19, from help: artifacts in Cowork; not in the
release notes). Projects redesign (2026-09-17: coordinator, threads as Claude Code cloud sessions on branches,
Library, beta limited to select Pro/Max users with no existing projects). Rollout order and 30-day Enterprise
notice. Org settings > Artifacts > Docs/Slides/Design toggles, 15-minute propagation. Custom visuals
(2026-03-12; help updated 2026-04-22). Scheduled tasks (2026-02-25). HN thread 49729412 (234 points, 225
comments) and the commenters cited. HN 48128003 (Thariq's reply, the `design_chats` export). Live artifacts
post. @ClaudeDevs 2026-07-13 post. Quotes from Fortune, Computerworld, VentureBeat, SiliconANGLE, Engadget,
tbreak, XDA, mixed-news, MindStudio, smithstephen and McKelvey.

**Corrected in this file:**
1. *Timeline:* the "Chat and Cowork share one home... projects and artifacts" line belongs to the
   **2026-07-07** release note (Cowork on web and mobile), not the 2026-04-09 GA. The timeline and "Reading" are fixed.
2. *Timeline:* the 2026-07-07 "Editable drafts / Edit with Claude" row was misdated. The release note is
   **2026-06-12** ("Edit Claude's drafts in place"). The two rows are merged.
3. *Output picker:* the help centre documents **Output** in the current message box (help: Docs, artifacts).
   It is not only a "transitional Cowork" control. TL;DR 1, §3.1, §4 and §5.2 are updated.
4. *Boris Cherny:* the cited X post (2026-09-17) is about the Projects redesign. The paraphrase about the merge
   (used it for weeks, deliberately slow rollout) is not in it. Replaced with a correction note.
5. *HN billing complaints:* Sn0wCoder and no_no_no_yes were talking about ChatGPT/Codex tokens, and dbbk's
   "couldn't tell the modes apart" was about ChatGPT. The text is reworded. Typo fixed: ecliiptik is ecliptik.
6. *Projects:* the blog does not mention a "sidebar that tracks progress". Progress is followed in the main
   project chat or per thread.
7. *Alarcon:* not a hands-on review. He says he has not used Docs. The exact verdict is now quoted.
8. *Design standalone:* the help centre says existing projects "stay where they are" and Design has its own
   setting. "Separate project storage" was an inference and is now labelled that way. `/design-sync` is a
   Claude Code command.
9. *TNW:* the actual wording is "using Canva's design engine". The correction now cites Anthropic's launch post
   (Opus 4.7; Canva appears only as an export target).
10. *Mobile contradiction:* the blog does not literally say "edit on your phone". It puts "open on your phone"
    next to "select an element and move it". The press claim is now attributed to tbreak and mixed-news.
11. *Dates:* the live artifacts post is dated 2026-04-20 UTC (was ~04-21). Stacktree was published 2026-09-17
    (was ~2026-07). Updated dates for the help-centre pages are noted in the header.
12. *Additions from the checks:* Felix Rieseberg's HN line that artifacts now deploy "with multiplayer features
    and databases". The artifacts page lists "Google Slides" as a Slides export target. Docs can be switched
    off by Pro/Max users in Settings > Capabilities. The Docs connector already keeps revisions (`atRev`,
    `restore`), even though the help centre says Docs has no version history.

**Tagged unverified:** the Windows beta date (techsy); the "no API yet" claim (Coursiv/aireiter); Coursiv's
"rename of existing features"; the file-preview bullet in §3.3; SiliconANGLE's Stanford citation; the original
Boris Cherny paraphrase.

**Not independently re-checked (low stakes, left as written):** Forbes (Dispatch), Ultrathink, Techweez,
Serverman, aireiter, releasebot (2026-08-26 built-in browser and Chrome GA; releasebot matched on fetch).

**Source-policy pass (2026-09-23):** no claim in this file rests on leaked material, and it cites no values or
strings from the shipped Claude desktop app. One quote longer than 25 words (Felix Rieseberg's HN comment in
Section 2) was shortened to short quoted phrases with a paraphrase.
