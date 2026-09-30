# Anthropic / Claude: competitor research for the Juno Refoundation

Phase 0, research only. Written 2026-09-30 against `rework/refoundation` @ `1feb392c`.

**Method.** I read 30+ first-party pages live on 2026-09-30: the claude.com blog, the Claude Help Center (support.claude.com), the Claude docs (claude.com/docs), the Claude Code docs (code.claude.com), and the Claude Platform docs (platform.claude.com). They are listed in §4. I used press only to fill dates or UI details the first-party pages leave out, and I label every press claim **[press]**. Anything I could not confirm first-hand is marked **UNVERIFIED**. Juno claims cite `path:line` in the refoundation worktree. Many first-party docs pages are undated living documents. For those, the date given is the access date plus whatever version or date markers the page itself carries.

**Two caveats on Anthropic's own docs:**
- They lag each other. The Claude Code desktop page still describes three tabs (Chat, Cowork, Code), even though the 2026-09-16 merge removed the Chat/Cowork split for users who have the rollout.
- The standalone Research help article still describes a "blue indicator" toggle, while the merge article says Research is started with `/deep-research` or the **+** button.

Where the two disagree, I treat the newer merge article as authoritative and flag the conflict.

---

## 1. Summary: the product lessons that matter for Juno

1. **Anthropic reached Juno's "no mode switch" decision, and it validates `TWO_PRODUCTS.md`.** On 2026-09-16 Anthropic merged Chat and Cowork. Claude "decides whether that's a quick answer or a task", and "Manual" (ask before each action) is the default, with "Auto" as an opt-in ([blog](https://claude.com/blog/cowork-is-now-claude), [help](https://support.claude.com/en/articles/16761823)). Juno already does this with `start_task` (`docs/JUNO.md:1700`, `src/lib/chat/task-tool.ts:162-179`). The lesson is to *finish* it:
   - Remove the remaining mode-like toggles.
   - Let the person state their delegation posture in words ("propose first", "just start") and keep it as standing context.
2. **The biggest structural gap is coordination. One conversation should own many tasks.** Claude Code "Projects" is one coordinating conversation that starts parallel *threads*. Each thread appears as a card under the message that started it, and an **Overview** groups threads by *what needs you*: Ready for review, Waiting on you, Working, Landing, Idle, Resolved ([docs](https://code.claude.com/docs/en/claude-projects.md)). A Juno chat draws only its NEWEST task (`docs/JUNO.md:1739`, `src/components/chat/use-conversation-work.ts:181-186`).
3. **Anthropic scopes persistence to places, not personas.** Claude Tag gives one identity ("Claude") different access bundles per scope, memory per channel, and work in progress per thread. Every thread runs in an ephemeral sandbox that is released when idle, while the thread and its outputs stay durable ([docs](https://claude.com/docs/claude-tag/concepts/how-it-works)).
   - Juno's Agent is already the same bundle: thread, connectors, notes, routines and autonomy (`docs/JUNO.md:2050-2061`).
   - The principle to adopt: the agent is a *standing context*, and the face is a secondary signal.
   - The runtime lesson: an ephemeral sandbox per task, with durable deliverables, is the proven shape. A persistent per-agent desktop is not (`docs/JUNO.md:2056`).
4. **Artifacts are now Anthropic's output layer, not a chat feature.**
   - Typed templates: Docs, Slides, Design and Design Systems ([admin guide](https://support.claude.com/en/articles/16994751-artifacts-admin-guide-for-team-and-enterprise-plans)).
   - Live published pages with versions and a "which version viewers see" pin.
   - Comments that can be sent to Claude.
   - Runtime capabilities declared per page at publish time. Connector calls run as the *viewer*, after the viewer consents ([docs](https://code.claude.com/docs/en/artifacts)).
   - Juno's shares are snapshot pointers (`docs/JUNO.md:2393`), and main has no Deck, Doc or Design-system kind (`src/lib/message-content.ts:13`). Juno's own merge plan already models this (`docs/design/artifacts-design/04-MERGE-PLAN.md:212-226`); the gap is shipping it.
5. **Provenance and explanation belong on the object.** Claude Docs asks clarifying questions up front, "leaves comments explaining its choices", and records whether a person or the AI made each change ([help](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs)). Adopt the principle: explanations attach to the thing they explain, not to the chat scrollback.
6. **Approvals: Juno's mechanics are stricter; Anthropic's vocabulary is simpler.**
   - Anthropic's pieces:
     - Per-tool **Always allow / Needs approval / Blocked** settings.
     - Allow once / Always allow cards that appear *in the thread that needs them*.
     - An auto-mode classifier that treats boundaries stated in conversation ("don't push") as block signals and requires approvals to name the specific action.
     - A fallback to prompting after 3 consecutive or 20 total blocks ([docs](https://code.claude.com/docs/en/permission-modes.md)).
   - Juno's digest-bound, expiring, policy-pinned approvals are stronger (`src/app/api/work/protocol.ts:629-697`).
   - But Juno exposes three overlapping autonomy vocabularies:
     - 5 chat action policies (`src/lib/action-approval.ts:32-38`).
     - 3 Work policies (`src/lib/work/domain.ts:503-536`).
     - Per-agent `approvalMode`.

   Consolidate them into one ladder.
7. **Progress: say what is happening in one human line, and be honest about outcome.**
   - Agent view replaced raw tool text with "a colored state word and a classifier-written headline" ([what's new, July 2026](https://code.claude.com/docs/en/whats-new/2026-w28.md)).
   - Claude Tag edits one checklist in place.
   - Routines state that a green run status "does not mean the task in your prompt succeeded" ([docs](https://code.claude.com/docs/en/routines.md)).
   - Juno's plan state machine and structural validation (`docs/JUNO.md:1858-1884`) are better on honesty. Keep them, and add the one-line headline.
8. **The extension model has three nouns and one home.** Connectors give access, skills give method, plugins package both. All of them live under **Customize**, sync with the account to every surface, and follow the open Agent Skills spec. A reviewed directory carries Verified/Community labels and context-cost estimates ([docs](https://claude.com/docs/extend/overview)).
   - Juno already imports skills from repositories (`src/lib/skills/github.ts:1-26`).
   - Juno's rule that a skill can never widen a run's permissions (`docs/JUNO.md:1931`) is better than Anthropic's plugins, which run "as you".
   - Adopt the single home. Do not build a marketplace.
9. **Memory is at parity. Copy two things from Anthropic.** Claude's editable Topics, sensitive topics off by default, the never-stored list and per-project isolation ([blog, 2026-08-25](https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it)) match Juno (`docs/JUNO.md:1136-1256`). Juno is ahead on lifecycle. The two ideas worth copying:
   - A visible "saved to memory" moment above the composer.
   - Managed Agents **dreams**, which write consolidation into a *new* store that you review before adopting it; "the input store is never modified" ([docs](https://platform.claude.com/docs/en/managed-agents/dreams)).
10. **Do not copy Anthropic's sprawl.** Anthropic's current catalog:
    - Five ways to run parallel agents in Claude Code ([docs](https://code.claude.com/docs/en/agents.md)).
    - Two different things called "Projects".
    - A single-thread Dispatch that is closed to new users.
    - Five permission modes on the Code desktop, plus a pre-merge Cowork "Skip" mode.
    - Three marketplace tiers.
    - Emoji-titled artifacts.
    - Animated and colored status glyphs.

    Juno's advantage is one model per concept. The refoundation should protect it.

---

## 2. Capabilities, one by one

Each capability follows the same shape: (a) what it is today; (b) the user problem; (c) whether Juno solves it, and how; (d) whether Anthropic's solution is actually better; (e) the principle Juno should adopt; (f) what Juno should deliberately not copy.

### 2.1 Claude after the Chat/Cowork merge (2026-09-16)

**(a) What it is.**
- Chat and Cowork are one experience ([blog, 2026-09-16](https://claude.com/blog/cowork-is-now-claude); [help](https://support.claude.com/en/articles/16761823); [release notes, 2026-09-16](https://support.claude.com/en/articles/12138966-release-notes)). A person types, and Claude decides whether the request needs "an answer or a piece of work".
- The same conversation can search, read files, run code, produce finished files (docs, spreadsheets with formulas, decks), use connectors and schedule recurring work.
- Execution happens in two places. Long-running work runs "in the cloud" and continues after the app is closed. Local folders, browsing and computer use require Claude Desktop to stay open.
- There are two permission modes, set per conversation: **Manual** (the default: "requests permission before each action") and **Auto** ("works independently with automated safety checks"). The announcement says: "By default, Claude asks before taking an action. If you'd rather let it keep working and check in only when something needs a closer look, you can turn that on."
- Web search is now automatic, not toggled. Research is started with `/deep-research` or the **+** button.
- Tasks started on desktop appear on the phone "for monitoring and redirection".
- Stated gaps at launch: GitHub imports, conversation branching, Dispatch task assignment, and full search over older Cowork tasks are unavailable.
- Usage: agentic tasks "typically consume more quota".
- Rollout: Pro and Max over "the coming weeks"; Team and Free later; Enterprise gets ≥30 days' notice.
- Before the merge, Cowork had three approval levels: Manual, Auto and **Skip** ("No automatic checks or pauses") ([Cowork help](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)).
- UNVERIFIED: the exact post-merge sidebar and composer layout. No first-party page I read documents it, and the press pieces I opened admit they have no UI detail ([TestingCatalog] [press]; [DigitalApplied, 2026-09-16] [press]).

**(b) User problem.** Before the merge, users had to guess which product a request belonged in, and "could not carry work between those spaces" ([9to5Mac, 2026-09-16] [press]).

**(c) Juno today.** Juno solves this the same way, and did so earlier.
- "Work is not a place. It is what a conversation can do when the ask is big" (`docs/JUNO.md:1700`).
- The model decides whether to call `start_task`. The gate is `src/lib/chat/task-tool.ts:162-179`, and the prompt tells the model it decides and "the user has no switch for this" (`src/lib/chat/system-prompt.ts:58`).
- Juno differs in three ways:
  - Autonomy is a Work permission policy (`conservative | balanced | permissive`, default `balanced`: `src/lib/work/domain.ts:503-521`), not a per-conversation Manual/Auto toggle.
  - Private, voice, regenerate and research turns never carry `start_task` (`task-tool.ts:153-161`).
  - Research is still a composer tool with its own flow (`docs/JUNO.md:760-766`).

**(d) Is theirs better?** On the *principle*, no. It is the same decision, which is strong external validation. On *legibility*, partly:
- Anthropic's two-word autonomy choice (Manual/Auto) is easier to understand than Juno's layered policies.
- Anthropic's default of "asks before taking an action" is more conservative than Juno's `balanced` default. For a product that acts in connected apps, a conservative first run earns trust.
- Anthropic's version also has weaknesses: the doc drift (Research toggle vs `/deep-research`), and features lost at launch (branching, GitHub import).

**(e) Principle to adopt.**
- One conversation, one composer, and no mode to choose.
- Autonomy is a single, conversation-visible setting with two or three rungs, named by what the person will experience ("Ask me first" / "Check in only when needed").
- Execution location (cloud vs this Mac) is a property the product reports, not a mode the person picks up front.

**(f) Do not copy.**
- A "Skip checks" rung.
- Shipping the merge while help articles still describe the old toggles.
- Dropping capabilities at launch without saying so in the product. Anthropic stated these in a help article, not in the UI.

---

### 2.2 Projects (claude.ai Projects, and the new coordinator Projects in Claude Code)

**(a) What it is.** There are two different products under one name.
- **claude.ai Projects** ([help](https://support.claude.com/en/articles/9517075-what-are-projects)):
  - Self-contained workspaces with their own chats, a knowledge base and instructions.
  - Paid plans switch to RAG to "expand capacity by up to 10x".
  - Team and Enterprise can share with "Can view"/"Can edit".
  - Memory is isolated per project, with a project summary ([memory help](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)).
  - The same article says "a new projects version is rolling out starting with Claude Code, restructuring projects as single conversations with parallel cloud threads".
- **Claude Code Projects** (public beta, Pro and Max) ([docs](https://code.claude.com/docs/en/claude-projects.md)):
  - A project is "one ongoing conversation where Claude coordinates a stream of related work". Claude answers quick questions in place, starts a **thread** (a separate cloud session) for each piece of new work, or routes a follow-up to the thread already working in that area.
  - Settings: an optional **Goal**, "Context" (repositories, files, Drive folders), and **Project instructions** of up to 16,000 characters sent to every thread.
  - **Project memory** is a set of files with a `MEMORY.md` index.
  - The **Overview** pane groups threads by state (Ready for review / Waiting on you / Working / Landing / Idle / Resolved). Its other tabs are **Library** (inputs and files the threads produced), **Pull requests** and **Routines**.
  - Thread cards carry next-step buttons (Resolve conflicts, Fix CI, Address comments, Merge it, Review PR, Create PR). **Suggested threads** have a start button, or a "start all" button.
  - Model and effort are set separately for the coordinator and the threads. The default is Opus everywhere, at high effort for threads and low for the coordinator.
  - Delegation posture is expressed in words ("Propose threads and wait for my go-ahead", "Run at most two threads at a time"). Claude saves these to project memory, and "a thread limit you give this way isn't a hard cap". The enforced cap is 200 new threads per day.
  - A thread can run on the user's computer: **Work locally** in the **+** menu tags the message **Local**, and an "Allow Claude to work in a folder on your device" card offers "Allow once".
  - Approvals stay inside the thread that raised them: "Telling Claude in the project conversation to go ahead doesn't reach it."
  - Pause, Archive and Delete work at project level. Usage is shown per thread and per model.

**(b) User problem.** A goal that outlasts one session keeps producing tasks. Without a coordinator, "you decide what each one works on, repeat the same background at the start of each, and check back to see which finished or needs an answer".

**(c) Juno today.**
- Juno Projects bundle instructions and reference files injected into every turn (`docs/JUNO.md:2372-2380`), with isolated per-project memory (`docs/JUNO.md:1181-1190`). That is the older claude.ai model.
- A project can carry a role and narrow a run's budget (`docs/JUNO.md:1835-1836, 1937`).
- Work tasks do spawn from a chat, but the chat panel "follows a conversation's NEWEST task; a chat that has delegated twice draws the second run" (`docs/JUNO.md:1739`).
- Triage exists as the sidebar **Needs you** fold, "a fold, not a destination" (`src/components/app/app-sidebar.tsx:1672-1728`).
- Agents come closest to a coordinator: each is a thread with goals, tasks and routines (`docs/JUNO.md:2050-2061`).

**(d) Is theirs better?** Yes, for multi-task work, and that is where Juno is weakest.
- Anthropic makes the *conversation* the coordinator and every task a visible, openable child with its own composer, approvals and stop control. The triage view is grouped by what the person must do next.
- Juno's Needs-you fold solves attention but not coordination. A second task in a chat hides the first.
- Anthropic's version has its own problems: the name collision (the Chat "Projects" is a knowledge bundle; the Code "Projects" is a coordinator), and its guidance on when *not* to use a project is long.

**(e) Principle to adopt.**
- A conversation can own many tasks.
- Each task appears as a compact card at the point in the transcript where it was started, and opens to its own transcript, composer, approvals and Stop.
- One triage view (Juno's Needs-you fold) groups by the person's next action: review, answer, approve, done. It does not group by system state.
- Standing context (goal, instructions, memory) is set once and reaches every new task. Changes reach *new* tasks only; Juno already states the equivalent rule for attempts (`docs/JUNO.md:1918`).
- Delegation preferences said in words persist as project memory, and the product is honest that they are preferences, not caps.

**(f) Do not copy.**
- Two products named "Projects".
- A coordinator conversation that "has no connectors", which forces work into threads.
- Opus-at-high-effort defaults that burn plan limits quickly. Anthropic's own docs warn that Pro users will hit limits sooner.
- A new-thread-per-day cap as the only enforced limit. Juno's usage windows are the better bound (`docs/JUNO.md:1824-1846`).

---

### 2.3 Claude Docs (beta, 2026-09-16)

**(a) What it is** ([help](https://support.claude.com/en/articles/16923645-get-started-with-claude-docs); [artifacts help](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them); [blog](https://claude.com/blog/cowork-is-now-claude)).
- "A rich-text document saved to your Claude account", kept in the **Artifacts** tab across conversations.
- You create one by asking in any conversation, or from a template in the Artifacts tab. It works on web, desktop and Claude Code (as a connector, `claude.ai Claude Docs` ([Code docs](https://code.claude.com/docs/en/artifacts))); mobile can view but not edit.
- Claude "drafts it in front of you, asks clarifying questions up front, and leaves comments explaining its choices". People can mention `@Claude` in comments to request edits. The doc tracks "who made each change — person or AI".
- Real-time co-editing. Pro and Max share by link; Team and Enterprise share with specific people or groups, as viewer or editor.
- Exports: Word, PDF, Markdown and Google Docs. A doc can be converted into a presentation.
- Stated limits: **no version history yet**; charts don't auto-update; no CMEK/ZDR/HIPAA; no mobile editing. Docs "cannot be shared externally" on Team and Enterprise ([admin guide](https://support.claude.com/en/articles/16994751-artifacts-admin-guide-for-team-and-enterprise-plans)).

**(b) User problem.** Writing something other people will read and edit, with the AI as a co-author whose changes can be seen and questioned, without copying text out of chat into Google Docs.

**(c) Juno today.**
- Markdown artifacts carry versions, a diff and history in Canvas (`docs/JUNO.md:500-505`).
- Office export exists for **Markdown artifacts only**, to `.docx`, `.xlsx` or `.pptx` (`docs/JUNO.md:2381-2384`).
- There is no rich-text Doc kind on main (`src/lib/message-content.ts:13`), no multi-person co-editing, no Claude-authored explanatory comments and no per-change attribution for documents.
- A "Doc" kind with `head`, `assets` and `comments` capabilities is planned (`04-MERGE-PLAN.md:212-226`).

**(d) Is theirs better?** Yes, on collaboration and explanation. Juno is ahead on one axis: it has versions and Anthropic's Docs do not. Juno should keep that.

**(e) Principle to adopt.**
- A document is a place both parties write.
- The AI's rationale lives in anchored comments on the passage it explains.
- Every change carries its author (person or Juno).
- Clarifying questions come *before* drafting, and only when they block the work (consistent with `PRODUCT.md`: "ask only for blocking information").

**(f) Do not copy.**
- Shipping without version history.
- Multi-tenant org sharing semantics. Juno is individual-first.
- The Google Docs export target, unless a Google connector already exists.

---

### 2.4 Claude Slides (beta, 2026-09-16)

**(a) What it is** ([artifacts help](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them); [blog](https://claude.com/blog/cowork-is-now-claude); [Code docs](https://code.claude.com/docs/en/artifacts)).
- Claude "outlines, writes, and lays out every slide" from notes, a report or the conversation.
- You can "edit any slide directly, add your own images, and present without leaving Claude", or export to PowerPoint or PDF.
- It is available as `/slides <brief>` in Claude Code (v2.1.265+). Editing and presenting happen in a desktop browser.
- A doc can be converted into a deck.
- Templates are paid-plan beta, on by default for Pro, Max and Team, and off on Enterprise until an Owner enables them.

**(b) User problem.** Turning material you already have into a presentable deck, and presenting it without switching tools.

**(c) Juno today.**
- No deck kind on main. `.pptx` exists only as an export of a Markdown artifact (`docs/JUNO.md:2383`; `src/lib/office-export.ts`).
- The design editor has slide-like transitions in its model (`src/lib/design/types.ts:674`), but there is no present mode.
- "Deck (Present)" is planned (`04-MERGE-PLAN.md:212-226`).

**(d) Is theirs better?** Yes. It is a first-class object with direct editing and presenting. Juno's Markdown-to-PPTX export is a file conversion, not a deck.

**(e) Principle to adopt.**
- A deck is a document type with its own editor and a Present mode.
- It is generated from context the conversation already holds.
- Export is a derived file, validated before it is served. Juno's plan already says this (`04-MERGE-PLAN.md`, `exports` row).

**(f) Do not copy.** Templated, generic layouts. Juno's decks should consume the account's design system (see 2.5), not stock themes.

---

### 2.5 Claude Design (Anthropic Labs, 2026-04-17; in conversations from 2026-09-16)

**(a) What it is.**
- **At launch** ([news, 2026-04-17](https://www.anthropic.com/news/claude-design-anthropic-labs)):
  - A conversation paired with an editable canvas for designs, prototypes, slides and one-pagers, powered by Opus 4.7 at launch.
  - At onboarding Claude builds a **design system** from the codebase and design files.
  - Refinement happens through "inline comments, direct text editing, or custom adjustment sliders".
  - "Claude packages everything into a handoff bundle" for Claude Code.
- **Today** ([help](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)):
  - Available inside conversations, from the Artifacts tab, via `/design` in Claude Code (drafts artboards on one canvas; PNG or PDF per artboard ([Code docs](https://code.claude.com/docs/en/artifacts))), on mobile (view only), and standalone at claude.ai/design.
  - Claude "validates output against your system before displaying results".
  - Exports: .zip, PDF, PPTX and HTML, plus sending to Adobe AEM, Figma, Miro and Vercel, and handoff to Claude Code.
  - Stated limits: version history not yet implemented; multi-person editing "basic"; comments occasionally disappear.
- **Design Systems** is its own template type ([admin guide](https://support.claude.com/en/articles/16994751-artifacts-admin-guide-for-team-and-enterprise-plans)).

**(b) User problem.** Getting on-brand visual work (mockups, flows, one-pagers) from conversation, and carrying it into code without re-specifying it.

**(c) Juno today.**
- A full design editor with a node document model: pages, components, variables, interactions and comments (`src/lib/design/types.ts:26-34, 739-786`).
- Designs open at the unified artifact URL `/a/{id}` (`src/app/(app)/design/[artifactId]/page.tsx:1-29`).
- A "Design system" kind with `tweaks`, `inspect` and handoff capabilities is planned (`04-MERGE-PLAN.md:212-226`).
- UNVERIFIED: whether Juno generates a design system from a codebase today. I found no route for it on main.

**(d) Is theirs better?**
- On *system-first generation* and *handoff*: yes. The design system is a reusable object that every generator (Design, Slides, artifacts) consumes and validates against.
- On the *editor model*, Juno's node/variable/component model looks at least as deep. Anthropic's own help lists version history as missing, and Juno has versions.

**(e) Principle to adopt.**
- One design-system object per account (or per project), built from what the user already has.
- Every visual generator reads from it and checks its output against it before showing it.
- "Handoff" is a packaged, inspectable bundle for Juno Code, not a screenshot.

**(f) Do not copy.**
- A separate standalone Design product URL alongside the in-conversation one. Juno already chose one address, `/a/{id}`.
- "Custom adjustment sliders" as generated chrome, unless they bind to real variables. Juno's `tweaks` rule is the correct constraint.

---

### 2.6 Claude Code: CLI and desktop

**(a) What it is** ([desktop docs](https://code.claude.com/docs/en/desktop.md); [permission modes](https://code.claude.com/docs/en/permission-modes.md); [remote control](https://code.claude.com/docs/en/remote-control.md)).
- **Starting a session.** In the desktop Code tab, a session is set up with four choices in the prompt area: **Environment** (Local / Cloud / SSH / WSL), **Project folder**, **Model** and **Permission mode**.
- **Permission modes:** Manual, Accept edits, Plan, Auto (a classifier checks actions) and Bypass. Since v2.1.283, auto mode is the starting mode for interactive CLI sessions.
- **Panes:** chat, diff, browser, terminal, file, plan, tasks and subagent, plus the iOS Simulator on macOS. Panes can be dragged into any layout.
- **Diff review:**
  - A `+12 -1` indicator opens the diff view.
  - Click a line to comment, then submit all comments with Cmd+Enter.
  - **Review code** asks Claude to flag only "high-signal issues".
- **Pull requests:** a CI status bar with **Auto-fix** and **Auto-merge** toggles.
- **Side chats** (Cmd+; or `/btw`) use the session's context but are not added back to it and are not saved.
- **Task chips:** "When it notices something worth fixing that's out of scope… it offers the work as a task chip".
- **Moving sessions:** **Continue in** sends a local session to the cloud. The desktop pushes the branch, summarizes the conversation and creates a cloud session.
- **Cross-session messaging** has safety behaviors: archiving always asks, unwatched sessions cannot send, and each message is quoted and attributed to the session that sent it.
- **Remote Control** ties a local session to claude.ai and the mobile app:
  - Push notifications have two switches: "Push when Claude decides" and "Push when actions required".
  - Notifications are skipped while you are at the machine (`CLAUDE_CLIENT_PRESENCE_FILE`).
  - **Trusted Devices** requires device verification and a recent authentication.

**(b) User problem.** Supervising an agent that edits real code: seeing what changed, commenting precisely, keeping CI green, and moving between desk, cloud and phone.

**(c) Juno today.**
- Juno Code is a Swift local agent plus cloud runs through GitHub Actions and a TypeScript runner (`docs/JUNO.md:1374-1600`).
- **`/code` is a composer, not a list.** It has environment and repository chips, permission mode, model and effort, and a Needs-you fold (`docs/JUNO.md:1378-1392`).
- Phone ↔ Mac remote sessions (`docs/JUNO.md:1462`) and auto-fix from GitHub signals (`docs/JUNO.md:1593`).
- Prefill links never auto-submit, because a Code send spends the usage window (`docs/JUNO.md:1413-1416`).
- UNVERIFIED: Mac diff-comment batching and a code-review action. I did not inspect the Swift code in this pass.

**(d) Is theirs better?**
- On *review ergonomics* (batch line comments that go back to the agent, a scoped "Review code") and *mobility* (Continue in cloud; push notifications tuned by presence): yes.
- On *safety of links and budgets*, Juno is more careful.
- Anthropic's pane system is powerful but heavy.

**(e) Principle to adopt.**
- Review is a conversation with the diff: comments anchored to lines, batched, and sent as one instruction.
- Where a session runs is chosen at start and can move later (local → cloud).
- Notifications respect presence and split "needs you" from "FYI".
- Out-of-scope findings become one-tap suggested tasks, not interruptions.

**(f) Do not copy.**
- Five permission modes, including Bypass.
- A free-form drag-anything pane layout on Mac. The owner wants native, calm structure.
- Emoji or ASCII-art branding.

---

### 2.7 Claude Code on the web (cloud sessions)

**(a) What it is** ([docs](https://code.claude.com/docs/en/claude-code-on-the-web.md)).
- **Starting and moving sessions.**
  - Sessions run in Anthropic-managed VMs (or self-hosted environments) and can be started from the browser, mobile, desktop, `claude --cloud`, or routines.
  - `claude --teleport` pulls a session and its branch into the terminal.
  - `claude -p "…" --cloud <id>` queues a follow-up from any machine.
  - A queued message can be taken back with ✕.
- **Environments** set network access (Trusted allowlist, Custom or Full), variables and setup scripts.
- **Credentials.** GitHub credentials "never enter a session's VM"; a proxy attaches them. API credentials stay outside the sandbox on Pro and Max.
- **Auto-fix PRs.**
  - Clear fixes are pushed.
  - "Ambiguous requests… Claude asks you before acting".
  - Replies are posted under the user's GitHub account but "labeled as coming from Claude Code".
- **Sharing.** Private/Team (Team and Enterprise) or Private/Public (Pro and Max).
- **Expiry.** The environment can expire while waiting for a connector approval.

**(b) User problem.** Long coding work that shouldn't depend on a laptop staying awake, and that you can steer from anywhere.

**(c) Juno today.**
- Cloud runs go through `workflow_dispatch` on GitHub Actions with OIDC-verified single-use runner context. Only two non-secret inputs reach the public log (`docs/JUNO.md:1480-1500`).
- Up to 3 live runs; 10 dispatches per minute (`docs/JUNO.md:1846`).
- Auto-fix exists (`docs/JUNO.md:1593`).

**(d) Is theirs better?**
- On *latency and session continuity*: yes. A VM session you converse with persists and can be teleported; a GitHub Actions job is per-run and cold.
- On *credential isolation*: comparable. Juno's OIDC single-use claim is a strong design.

**(e) Principle to adopt.**
- A cloud session is a conversation you can return to, not a batch job.
- A queued message can be taken back.
- The agent's public actions (PR comments) are always labeled as agent-authored, even under the user's identity.

**(f) Do not copy.**
- A "Public" visibility for coding sessions that may contain private-repo code, with repository access verification off by default on Pro and Max.

---

### 2.8 Parallel Code agents and sessions

**(a) What it is** ([agents](https://code.claude.com/docs/en/agents.md); [agent view](https://code.claude.com/docs/en/agent-view.md); [what's new, week 28, 2026-07-06 to 10](https://code.claude.com/docs/en/whats-new/2026-w28.md); [dynamic workflows blog, 2026-06-02](https://claude.dev/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code/)).

There are five mechanisms:
1. **Subagents.** A side task runs in its own context and returns a summary.
2. **Agent view** (`claude agents`, research preview). One screen of background sessions:
   - Grouped as Pinned / Ready for review / Needs input / Working / Completed.
   - Space opens a peek panel where you can reply; Enter attaches to the session.
   - A dispatch input accepts `@repo`, `#PR`, `/skill` and `!shell` prefixes.
   - Every background session edits in its own worktree.
   - The terminal tab title shows counts such as "2 awaiting input".
   - Since July 2026, each row shows "a colored state word and a classifier-written headline instead of raw tool call text".
3. **Agent teams.** Experimental: a lead, a shared task list and messaging between agents.
4. **Dynamic workflows.** Claude writes an orchestration script that fans out subagents and cross-checks their results. It targets "agentic laziness", "self-preferential bias" and "goal drift" with adversarial verifiers. A workflows panel shows agent counts, tokens and durations.
5. **Projects** (§2.2).

**(b) User problem.** Handing off several independent jobs, seeing at a glance which ones need you, and not having them overwrite each other.

**(c) Juno today.**
- `delegate` runs one child agent at a time inside a Work run. It goes through the same tier lattice, approval ladder and budget guard (`docs/JUNO.md:1790-1797`).
- Up to 3 live runs per user (`docs/JUNO.md:1846`).
- Needs-you triage in the sidebar (`src/components/app/app-sidebar.tsx:1672`).
- Stall and repetition detectors (`docs/JUNO.md:1881-1884`).
- Structural validation before success (`docs/JUNO.md:1875`).

**(d) Is theirs better?**
- On *breadth and verification* (adversarial cross-checking is a real idea): yes.
- On *product coherence*: no. Five overlapping mechanisms, each with its own vocabulary and commands, is exactly the sprawl the owner wants to avoid.
- Juno's single Work contract with one budget guard is the better foundation.

**(e) Principle to adopt.**
- One way to run many things: tasks.
- One place to see them, grouped by what they need from you, with a one-line headline written for a human.
- Verification by an independent pass before a task claims success. This extends `structuralValidation` with an optional rubric check done by a separate reader, never by the author.
- Edits run in isolation by default.

**(f) Do not copy.**
- Five named mechanisms.
- Animated `✽` and colored `✻` state glyphs. These are decorative status signals of exactly the kind the owner bans.
- Colored PR labels.
- Token and agent-count metrics as the main progress surface.

---

### 2.9 Artifacts: published and typed

**(a) What it is** ([Code artifacts docs](https://code.claude.com/docs/en/artifacts); [artifacts help](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them); [admin guide](https://support.claude.com/en/articles/16994751-artifacts-admin-guide-for-team-and-enterprise-plans)).

- **What an artifact is.**
  - Anything Claude makes "that you'd put in front of someone".
  - On paid plans, every artifact is saved in the **Artifacts tab**, independent of the conversation that made it: "the conversation as where you create, and the Artifacts tab as where your outputs live".
  - **Templates** (typed artifacts): Slides, Docs, Design and Design Systems.
- **Artifacts from Claude Code.**
  - A live single-page site at `claude.ai/code/artifact/<id>`, private until shared.
  - "Each publish becomes a version", and the Share control picks which version viewers see ("Always share latest version").
  - Editors republish through their own session.
- **Comments.**
  - Comments with **Send to Claude** or `@claude` activate a thread.
  - Claude can auto-reply or auto-edit, depending on the permission mode.
  - Auto-replies are rate-limited to 60 per hour per artifact.
  - Viewers see replies "attributed to Claude, via you".
- **Runtime capabilities, declared at publish time.**
  - Connector calls run "through the viewing account's own connection", after "claude.ai asks each viewer for permission before the page's first connector call". Actions with side effects also run as the viewer.
  - AI calls inside artifacts count "against individual users' plan limits, not the creator's".
  - File downloads.
  - Per-page storage (20 MB).
- **Security.**
  - A strict CSP: only five CDNs and Google Fonts.
  - Pages load from a sandboxed `*.claudeusercontent.com` origin.
  - Pages someone else wrote are read "the way it reads a web page", as a summary that "reports instructions written into the page instead of relaying them".
- **Admin controls.** Retention policies, audit-log events and a compliance API. Artifacts that use connectors or AI calls "cannot use public link sharing".
- **Authorship.** "Claude picks the artifact's title and an emoji."

**(b) User problem.** Output that must be seen, shared, updated and discussed, not scrolled past in chat. Live data without a backend. Feedback that gets back to the agent.

**(c) Juno today.**
- **Canvas** (`docs/JUNO.md:500-538`): versioned, a diff, an always-writable Code tab, an opaque-origin sandbox iframe with a separate cookieless origin, and a CSP that doubles as an egress policy.
- **Library.** A cross-conversation `/api/artifacts` library (`docs/JUNO.md:2381`).
- **Public shares** are *snapshot pointers* that render only content from `snapshotAt` (`docs/JUNO.md:2393-2399`). There are three takedown paths.
- **Kinds on main:** `HTML | REACT | CODE | MARKDOWN | SVG | MERMAID | DESIGN` (`src/lib/message-content.ts:13`).
- **The merge plan** already maps "Capabilities: Claude's model, Juno's names", including `comments`, `ask`, `data` and `connectors` (viewer-scoped, "never on public links"), plus a published version pin (`04-MERGE-PLAN.md:212-226, 283`).

**(d) Is theirs better?**
- On *lifecycle* (a live page, a version pin, comments into the agent, viewer-identity connectors): yes. It turns an artifact into a small, safe, shareable app.
- On *sandbox rigor*, Juno is comparable. Its opaque-origin frame and separate origin are the same idea.
- Juno's snapshot-only share is safer for chat transcripts but wrong for artifacts people keep working on.

**(e) Principles to adopt.**
- **Where outputs live:** outputs belong to the account, not the chat. The Artifacts home is where they live.
- **Publishing:**
  - Publishing is a version pin, and the owner chooses "latest" or a specific sealed version.
  - Runtime capabilities are declared per artifact at publish time.
  - Anything that touches the viewer's data runs as the viewer, after the viewer consents, and never on anonymous public links.
- **Comments:** a comment addressed to Juno is an instruction to the owner's session, with rate limits and permission-mode gating.
- **Trust:** a page someone else authored is data, never instructions.

**(f) Do not copy.**
- Emoji titles and tab icons chosen by the model.
- A single-HTML-page-only constraint for typed kinds. Juno's registry of kinds is better.
- Five public CDNs as the only library route. Juno should ship vendored runtimes where it can.

---

### 2.10 Built-in browser

**(a) What it is** ([what's new, week 28, 2026-07-06 to 10](https://code.claude.com/docs/en/whats-new/2026-w28.md); [desktop docs §Browse external sites](https://code.claude.com/docs/en/desktop.md); [merge help](https://support.claude.com/en/articles/16761823)).
- **The pane.** A tabbed **Browser pane** in the desktop app (Cmd+Shift+B). Claude uses it both to verify its own dev server and to browse external sites.
- **A separate profile.** It uses "a clean browser profile, separate from your personal browser, with none of your saved logins or history". The Chrome extension is the tool for acting in logged-in sessions.
- **Checks on external pages:**
  - "Safety classifiers review Claude's write actions on external pages… in every permission mode".
  - Outside Auto and Bypass, a domain allowlist check applies before navigation.
  - The first action on a site raises **Allow once / Always allow / Deny**. Each site needs its own approval, including subdomains.
  - Localhost and project files need no approval.
  - "Claude won't purchase items, create accounts, or bypass CAPTCHAs without your input."
- **Admin controls.** Admins can disable Claude's tools on external pages, or all external navigation.
- **In the merged app,** Claude can "use built-in or Chrome browsers" while Desktop is open.

**(b) User problem.** Letting the agent see and act on the web while the person can watch, take over, and bound where it goes.

**(c) Juno today.**
- Work's cloud `browser` tool is a real headless page with a DNS-pinned fetcher, closed WebSockets and WebRTC, and an allowlisted environment.
- It has a risk ladder: read = safe; click/type = edit; GET submit = command; any other submit = **irreversible** ("asks under every mode"); a card page raises `work.browser.purchase` (`docs/JUNO.md:1771-1790`; `src/lib/work/browser.ts`).
- Agents have an optional per-agent Docker desktop with noVNC Watch/Takeover/Hand-back (`docs/JUNO.md:2056`, route table ~2130). The task context says this is not production-ready.
- There is no visible browser pane for a Work run.

**(d) Is theirs better?**
- On *visibility and per-site consent*: yes. The person sees the page and approves per site.
- On *network isolation and a structural risk ladder*: Juno is at least as strong. "Submit is irreversible" is enforced structurally, while Anthropic relies on a classifier.

**(e) Principle to adopt.**
- The agent's browser is a visible surface the person can watch and take over.
- Consent is per site (once or always), and revocable.
- Consequential actions (submit, purchase, account creation) always ask, whatever the mode.
- Separate "the agent's clean browser" from "my signed-in browser" in name and in UI.

**(f) Do not copy.** A persistent per-agent desktop VM as the default way to browse. Anthropic's shape is a pane or ephemeral sandbox per task (see 2.16).

---

### 2.11 Connectors and the MCP directory

**(a) What it is** ([getting started](https://claude.com/docs/connectors/getting-started); [extend overview](https://claude.com/docs/extend/overview)).
- **Finding and connecting:**
  - **Customize > Connectors** holds the directory. Every listing carries a **Verified** or **Community** label.
  - A connector is connected once per account and is available on web, desktop, mobile, Claude Code and Cowork.
- **Per-conversation control:** each connector has a toggle in the composer's **+ > Connectors** menu.
- **Approving tool calls:**
  - The first time a tool is used, Claude asks "Allow once" or "Always allow".
  - The connector page sets **Tool permissions** per tool or group: **Always allow / Needs approval / Blocked**.
- **Kinds of connector:**
  - Remote servers.
  - Local "desktop extensions" packaged as `.mcpb`, which run on the computer in the desktop app.
  - **MCP Apps** that "display interactive content in the conversation" on the web.
- **Custom connectors** are added by URL.
- **Maintenance:** a "Reconnect" state appears when access lapses.

**(b) User problem.** Giving the assistant access to your tools with clear, per-tool control, once, everywhere.

**(c) Juno today.**
- Native connectors: GitHub, Figma, Notion, and Apple Calendar/Mail/Music via Juno's own MCP routes. Composio covers a managed catalog, and a native connector wins over a Composio duplicate (`docs/JUNO.md:1305-1350`).
- Custom user MCP servers are on main (`src/app/api/mcp/servers/route.ts:15-26`, limit 50).
- Connectors can be auto-enabled when a prompt mentions the app (`docs/JUNO.md:1343`), and `@App` mentions work in the composer (`src/components/chat/composer.tsx:338-366`).
- Chat action policies range from `always_ask` to `block` (`src/lib/action-approval.ts:32-38`).
- Work tasks pin their connectors at dispatch (`docs/JUNO.md:1918-1930`).

**(d) Is theirs better?**
- Per-tool tri-state permissions on the connector's own page, and verification labels, are clearer than Juno's account-level policy ladder.
- MCP Apps (interactive UI from a connector) is a capability Juno lacks.
- Juno's `@App` mention in the composer is a nicer inline affordance than a toggle list.

**(e) Principle to adopt.**
- A connector has one page with its tools and a three-state permission per tool.
- A conversation can include or exclude a connector inline (by `@mention` or toggle).
- Trust labels say who built the connector and who reviewed it.
- Connected once, available on every Juno surface.

**(f) Do not copy.**
- Organization "Request" flows. Juno is individual-first.
- The `.mcpb` local-extension format, unless Juno Code on Mac needs it.
- A separate connector list per product.

---

### 2.12 Skills and plugins (marketplaces, packaging)

**(a) What it is.**
- **Skills** ([docs](https://claude.com/docs/skills/overview)):
  - Folders with a `SKILL.md`, loaded by progressive disclosure: name and description first, then the instructions, then extra files only when needed.
  - They require code execution.
  - Sources: built-in Anthropic (Office and PDF), partner, org-provisioned and custom.
  - "Skills follow the Agent Skills specification, an open standard" (agentskills.io).
  - The `/` menu lists skills with the plugin each came from.
- **Plugins** ([claude.com docs](https://claude.com/docs/plugins/overview); [Code docs](https://code.claude.com/docs/en/plugins/overview.md)):
  - A package of skills, connectors, commands and agents. Claude Code plugins also carry hooks and LSP servers.
  - Installed from **Customize > Plugins** via Discover, Add marketplace (a Git repo with `.claude-plugin/marketplace.json`) or Upload (.zip/.plugin), then synced to the account and loaded in chat, Cowork and Claude Code.
  - Bundled connectors show Connected / Not connected / Not added.
  - Org controls: "Installed by default" and "Required".
  - Usage metrics: Adoption (30 days), Activity, You.
  - "Create with Claude."
  - Directory plugins get "automated validation and a security scan, and a person reviews a new listing". Marketplace-URL and uploaded plugins are not reviewed.
  - Official marketplace listings show a **Context cost** estimate.
- **Marketplace tiers:** Official, Community and third-party ([marketplaces](https://code.claude.com/docs/en/plugins/anthropic-marketplaces.md)).
- **Release notes:** the plugin submission portal launched 2026-09-25; skill and plugin security scanning for Enterprise launched 2026-08-06 ([release notes](https://support.claude.com/en/articles/12138966-release-notes)).

**(b) User problem.** Teaching the assistant *how* you do things, and installing a whole working setup (method plus access) in one step.

**(c) Juno today.**
- SKILL.md import from a file or a whole GitHub repository, with the repo as the unit, "the shape both ecosystems converged on".
- Imports deliberately do not fetch `scripts/`, and say so in the preview (`src/lib/skills/github.ts:1-26`).
- Skills carry versioned resource files (`docs/JUNO.md:1937`).
- **A skill cannot widen a run.** `resolveSkillPermissions` intersects what the skill asks for with what the run already has (`docs/JUNO.md:1931`; `src/lib/chat/skills.ts:315`).
- A finished Work run offers to be saved as a skill (`docs/JUNO.md:1732-1733`).
- No plugin packaging.

**(d) Is theirs better?**
- On *packaging and one home*: yes. One install brings method and access together, and one page (Customize) holds all three nouns.
- On *safety*, Juno is better. Anthropic plugins "run as you", with hooks that execute local commands. Juno's permission intersection is a strong, differentiating principle.
- Anthropic's three-tier marketplace plus a directory is ecosystem machinery Juno does not need.

**(e) Principle to adopt.**
- Three nouns, one home: *Apps* (access), *Skills* (method), and optionally *Bundles* (both, installed together).
- Bundles are importable from the open format, so Juno reads Anthropic plugins and marketplaces, but they can never widen permissions.
- Show each skill's usage and context cost honestly.
- "Save this run as a skill" stays Juno's best on-ramp.

**(f) Do not copy.**
- A marketplace or directory with review operations.
- Hooks that execute local commands from third-party packages.
- Org "Required" plugins.

---

### 2.13 Managed Agents, the Agent SDK and the Claude Agent platform

**(a) What it is.**
- **Managed Agents** is in public beta ([overview](https://platform.claude.com/docs/en/managed-agents/overview); [blog](https://claude.com/blog/claude-managed-agents)). Press puts the public beta at 2026-04-08 ([InfoWorld via search result] [press], UNVERIFIED).
  - **Four concepts.**
    - **Agent:** the model, prompt, tools, MCP and skills.
    - **Environment:** a cloud or self-hosted sandbox.
    - **Session:** a long-running agent instance.
    - **Events:** exchanged over SSE, with "event history… persisted server-side and can be fetched in full".
  - **Steering.** You steer with user events, or interrupt the session.
  - **Features:**
    - Memory stores.
    - **Dreams** (research preview): reorganize a memory store using past sessions and output a *new* store; "the input store is never modified, so you can review the output and discard it" ([docs](https://platform.claude.com/docs/en/managed-agents/dreams)).
    - **Outcomes** (self-evaluating toward success criteria, research preview).
    - Multi-agent coordination.
    - Scheduled deployments.
  - **Pricing:** token rates plus $0.08 per session-hour.
  - Not eligible for ZDR or HIPAA.
- **Agent SDK** ([docs](https://code.claude.com/docs/en/agent-sdk/overview.md)):
  - Claude Code's loop, tools, hooks, subagents, MCP, permissions, sessions, skills and plugins, in Python and TypeScript.
  - Third parties may not offer claude.ai login or rate limits.
  - Branding: "Claude Agent" is allowed; "Claude Code" is not.

**(b) User problem** (for developers). Running long, stateful, tool-using agents without building the harness, the sandbox or the event store.

**(c) Juno today.** Juno's internal Work contract has the same shape:
- `WorkSession` / `WorkRun` / `WorkEvent`: an append-only, `seq`-ordered log with per-kind visibility.
- SSE `snapshot`, `events` and `done` frames with a resume cursor.
- Steering by `user_message` between turns, and control by `pause | resume | cancel` (`docs/JUNO.md:1760-1860`).
- The contract is mirrored to native clients via `contracts/work/juno-work-v1.json`.
- Memory consolidation (the "dreamer") runs in the background (`docs/JUNO.md:1245-1256`).
- Juno is an end-user product and does not offer an agent platform.

**(d) Is theirs better?**
- As a platform, it is the reference architecture. Juno converged on the same primitives independently, which is reassuring.
- **Dreams** is better than Juno's in-place dreamer in one respect: the consolidation output is reviewable and discardable as a unit. Juno's dreamer supersedes without deleting, and edits have inverses (`docs/JUNO.md:1162-1175`), so it is partially reversible, but it is not reviewable as a batch.

**(e) Principle to adopt.**
- Keep Work's event-sourced contract as Juno's one runtime.
- Make memory consolidation produce a proposed change set the person can see ("Juno tidied 14 memories: merged 5, retired 3"), accept, or undo as a batch.
- If Juno ever uses Anthropic's hosted harness, it is an *executor* behind the Work contract, never a second product vocabulary.

**(f) Do not copy.**
- Exposing agent, environment and session as user-facing nouns.
- Per-session-hour pricing.

---

### 2.14 Memory

**(a) What it is** ([blog, 2026-08-25](https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it); [help](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context); [release notes, 2026-07-10 and 2026-08-25](https://support.claude.com/en/articles/12138966-release-notes); [SiliconANGLE, 2026-08-25] [press]).
- **What is stored:**
  - Memory is "individual, categorized entries", saved *during* chat rather than summarized afterward.
  - "Remember this" saves something on request.
  - Everything is listed under **Settings > Memory > Topics**, where each entry can be edited or deleted.
- **Scope:**
  - Each project has its own memory space and summary.
  - Memory spans chat and cloud Cowork; local Cowork sessions don't access it.
- **Defaults by plan:** memory is on for Free, Pro and Max, and off for Team and Enterprise until an Owner enables it.
- **What is never, or not by default, stored:**
  - Sensitive topics (health, race, ethnicity, religion, politics, gender identity) are excluded unless the user switches on **Include sensitive topics**.
  - Never stored: government IDs, criminal history, immigration status and financial account numbers.
- **In the conversation:**
  - A **memory indicator** appears above the message box when something is saved (mobile, latest versions only).
  - **Incognito** chats are excluded from memory.
  - **Chat search** (RAG over past chats, paid plans) can be switched off.
- **Import and export** of memory is supported ([help](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude); I did not open this page, so the details are UNVERIFIED).

**(b) User problem.** Not having to re-explain yourself, while staying in control of what is kept, especially sensitive things.

**(c) Juno today.** Juno is at parity or ahead on mechanics:
- `MemoryEntry` with nine categories, confidence, `observedAt`, supersession (never deletion), TTLs and suppression through one guarded write path (`docs/JUNO.md:1136-1200`).
- Project-isolated memory and summaries (`docs/JUNO.md:1181-1190`).
- A sensitive-topics opt-in (`src/lib/memory.ts:762`).
- Inline `<juno:memory>` extraction plus background distillation, and a background "dreamer" (`docs/JUNO.md:1153, 1245`).
- Private mode never touches memory (`docs/JUNO.md:767-770`).
- **Gap:** conversation search is title-only, because message bodies are encrypted at rest (`docs/JUNO.md:2365`). Claude can "search and reference chats".

**(d) Is theirs better?**
- On *mechanics*, no. Juno's lifecycle (contradiction resolution by observation time, supersede-not-delete) is more careful.
- On *felt control*, somewhat:
  - A Topics list you can edit in place.
  - A visible "saved" moment in the conversation.
  - A clear never-stored list.
- On *recall of past chats*, yes, though it conflicts with Juno's encryption-at-rest stance.

**(e) Principle to adopt.**
- Memory is visible when it happens (a quiet line or chip at the save point, with Undo), and editable where it lives, in plain language by topic.
- Publish a short "never kept" list in the product.
- Explore encrypted-search options before conceding chat search. Record this as an open decision, not a copy target.

**(f) Do not copy.** Mobile-only save indicators. Show them on every surface, or not at all.

---

### 2.15 Research

**(a) What it is** ([help](https://support.claude.com/en/articles/11088861-use-research-on-claude); [merge help](https://support.claude.com/en/articles/16761823); [when to use](https://support.claude.com/en/articles/11095361-when-should-i-use-web-search-extended-thinking-and-research), which I did not open).
- Agentic multi-search that "build[s] on each other".
- It covers the web plus connected sources (Gmail, Calendar, Google Docs).
- Output has citations and takes "minutes", aimed at 5+ tool calls over 1–3 minutes.
- After the merge it is started with `/deep-research` or **+**. The older article still describes a "blue indicator" toggle, which I treat as stale (UNVERIFIED which one current users see).
- Plans: paid only.

**(b) User problem.** A cited, synthesized answer to a question that needs many sources.

**(c) Juno today.** Juno's version is stronger on control and depth:
- A durable plan, parallel investigation rounds, a lead review, synthesis and citation validation.
- Tiers from `quick` (5 min) to `max` (60 min), and a budget ceiling.
- An editable plan in the transcript, and plan approval commits before searching starts (`docs/JUNO.md:750-766`).
- Research routes cover `clarify`, `plan`, `steer` and `control` (`src/app/api/research/[id]/`).

**(d) Is theirs better?** No. It is simpler to start and more tightly integrated with personal connectors. Juno's plan-then-run with citation validation is a better product for serious research.

**(e) Principle to adopt.**
- Keep Research's editable plan.
- Make it reachable the same way as any other command (`/research`) instead of as a sticky mode.
- Let the chat model propose research the way it proposes a task.

**(f) Do not copy.** A persistent mode indicator (the "blue indicator").

---

### 2.16 Adjacent: routines, Claude Tag and Dispatch (these bear directly on Juno's Automations and Agents)

**(a) What they are.**
- **Routines** ([docs](https://code.claude.com/docs/en/routines.md)):
  - A saved prompt, repositories, an environment and connectors.
  - Triggers: schedule (minimum 1 hour; one-off runs auto-disable), API (`/fire` with a bearer token) and GitHub events with filters.
  - No permission picker: "runs… without stopping for approval".
  - All connectors are included by default ("remove any the routine doesn't need").
  - Fire `text` arrives "wrapped in a `<routine-fire-payload>` block that labels it as untrusted data".
  - The run list warns that green "does not mean the task in your prompt succeeded".
  - Pushes go only to `claude/`-prefixed branches unless checks pass.
- **Claude Tag** ([overview](https://claude.com/docs/claude-tag/overview); [how it works](https://claude.com/docs/claude-tag/concepts/how-it-works); launched 2026-06-23 per [release notes](https://support.claude.com/en/articles/12138966-release-notes); public beta; Team and Enterprise):
  - `@Claude` in Slack, with one identity per organization.
  - Admins attach an **Access bundle** of service-account connections per scope (organization, workspace or channel).
  - Each thread gets a session in an ephemeral sandbox that is released after a few minutes idle and rebuilt when someone replies. Files only in the sandbox don't survive.
  - Progress is a **checklist edited in place**.
  - Anyone in the thread can steer. The working indicator has **Stop**, and "Claude… posts a line naming who stopped it".
  - Memory is kept per channel, plus workspace notes from public channels. Ask "`@Claude what do you remember about this channel?`" and anyone can correct it.
  - Cross-posts carry an attribution line ("Sent by Claude, approved by @jordan").
- **Dispatch** ([help](https://support.claude.com/en/articles/13947068)):
  - A single persistent phone↔desktop thread that routes tasks to Cowork or Code.
  - Push notifications when "Claude needs your go-ahead".
  - Limited beta, "isn't available to new users", single thread only.

**(b) User problem.**
- Recurring or triggered work that runs unattended.
- Team work handed to an agent that everyone can see and steer.
- Delegating from the phone to a desktop.

**(c) Juno today.**
- **Automations** are one surface (`WorkSchedule`). It has clocks and events, DST-correct zones, a missed-run policy, a run history that "records the fires that did **not** happen", and Code routines where every fire opens its own PR (`docs/JUNO.md:2400-2453`).
- The API trigger mirrors Anthropic's but is **stricter**: fire text is refused unless `acceptsText` is on (`docs/JUNO.md:2454-2466`).
- **Agents:**
  - Persistent named teammates with a thread, goals, routines, encrypted notes, notify levels and autonomy, all "derived on read" (`docs/JUNO.md:2050-2061`; `src/lib/agents/domain.ts:229-290`).
  - Each has a state sentence that always names the task ("Needs your approval on …").
  - Reflection raises ideas but "never starts work" (`docs/JUNO.md:2104-2110`).
- **Juno has no multi-person or channel surface.**

**(d) Is theirs better?**
- **Routines:** no. Juno's honesty about missed fires and its stricter fire-text handling are better. Anthropic's "all connectors included by default, no approvals" is looser.
- **Claude Tag:**
  - Its *model* (identity plus access per place, memory per place, work per thread, ephemeral compute) is cleaner than Juno's persona-with-a-computer.
  - Its *steering* ("anyone in the thread can steer"; Stop names who stopped it) and *progress* (one checklist edited in place) are excellent.
  - Juno's per-agent state sentence is as good as Tag's checklist for a glance, and better than agent view's glyphs.
- **Dispatch:** no. A single thread is a dead end, and Juno's per-conversation model is better.

**(e) Principle to adopt.**
- Persistence attaches to a place: a thread or project that holds access, memory, routines and history.
- A named agent is a *view* of that place, with a voice and a face, not a separate runtime.
- Compute is ephemeral per task, and deliverables are pushed somewhere durable as the task goes.
- Memory is inspectable by asking in the place itself ("what do you remember here?").
- A Stop or an approval always records who did it.

**(f) Do not copy.**
- Routines that skip approvals by default.
- Including all connectors by default.
- Channel-scoped service accounts (Juno is personal).
- Slack as a primary surface.
- The single-thread Dispatch.

---

## 3. Interaction and visual patterns worth noting (principles, not pixels)

Owner-rule filter: anything below that would become a status pill, a pulsing dot, a gradient, a glow or a faked material is flagged **(reject)**.

**Composer**
- **One composer; the model decides answer vs work.** Autonomy (Manual/Auto) and execution location (Local/Cloud) sit next to send as plain choices, not modes ([desktop](https://code.claude.com/docs/en/desktop.md); [merge help](https://support.claude.com/en/articles/16761823)). Juno principle: the composer's secondary row carries only choices that change what happens (model, effort, autonomy, where it runs), each stated in words.
- **A single + menu** holds attachments, connector toggles, skills, plugins and "Work locally". The **/** menu lists skills and commands with their source plugin ([plugins](https://claude.com/docs/plugins/overview)). Juno already has "/" and "@" palettes (`src/components/chat/composer.tsx:281-366, 1545`). Principle: "/" for things Juno can *do*, "@" for things Juno can *reach*; no third trigger.
- **A queued message can be taken back** (✕ returns the text to the box) ([cloud](https://code.claude.com/docs/en/claude-code-on-the-web.md)). Juno principle: a steer is editable until the agent has read it. Juno's honest steering sentence already exists (`docs/JUNO.md:1891-1899`).
- **Side questions that don't derail the session** (`/btw`, not saved). Worth considering for long Work runs.

**Inline tokens and mentions**
- **Tagging a message changes where it runs.** "Work locally" tags the message **Local**. Dispatch prefixes (`@repo`, `#1234`, `/skill`, `! cmd`) and filters (`a:`, `s:`) are used in agent view ([agent view](https://code.claude.com/docs/en/agent-view.md)). Principle: a token in the draft may change *where* or *with what* a request runs, and it must render as a readable word (`@GitHub`, `Local`), never an icon-only chip.
- **Mentions in comments address the agent** (`@Claude` in Docs; `@claude` or **Send to Claude** on artifacts). Principle: talking to Juno *on an object* is a first-class way to give it work, rate-limited and permission-gated.

**Approvals**
- **Cards live where the action is:** in the thread, on the page, or on the folder, with **Allow once / Always allow / Deny**. The scope of "always" is visible: this tool, this site, or the rest of this thread ([projects](https://code.claude.com/docs/en/claude-projects.md); [desktop](https://code.claude.com/docs/en/desktop.md)). Juno has the stronger backend: digests, expiry, policy pinning, and an irreversible action that can never be made standing (`src/app/api/work/protocol.ts:629-697`). Adopt the *placement* and the *visible scope*.
- **Conversational boundaries are enforceable.** "Don't push" becomes a block signal until the person lifts it, and conversational approvals must name the specific action ([permission modes](https://code.claude.com/docs/en/permission-modes.md)). Principle: what the person says constrains Juno, and Juno's own judgment never lifts a boundary.
- **Repeated blocks fall back to asking** (3 in a row or 20 total). Principle: an agent that keeps hitting walls stops and asks, rather than looping. This complements Juno's stall detector (`docs/JUNO.md:1881`).
- **Attribution lines** ("Sent by Claude, approved by @jordan"; "Auto-edited Artifact … in response to a comment thread"). Principle: every autonomous side effect names the approval it rode on.
- **Background notifications say that no human input has occurred** ([week 28](https://code.claude.com/docs/en/whats-new/2026-w28.md)). This is an injection defense. Juno's untrusted envelope is the same idea; keep applying it to every automated input.

**Progress presentation**
- **One human line per task.** A classifier-written headline replaces raw tool text in agent view. A checklist is edited in place in Claude Tag. Thread cards show title and state under the message that started them. Juno principle: the plan (`docs/JUNO.md:1858-1884`) is the checklist, and each task also gets a one-sentence headline written for a reader, like Juno's agent state sentence (`src/lib/agents/domain.ts:257-290`).
- **Group by what the person must do next,** not by system state: Ready for review / Waiting on you / Working / Done ([projects](https://code.claude.com/docs/en/claude-projects.md)). Juno's Needs-you fold, with the count in the heading and no trailing badge (`src/components/app/app-sidebar.tsx:1672-1690`), is the right, owner-compliant form.
- **Honest terminal states.** "Green… does not mean the task… succeeded" ([routines](https://code.claude.com/docs/en/routines.md)). Juno's `structuralValidation` and the `unreported` step state are already better. Keep them.
- **(reject)** Animated `✽` and colored `✻` state glyphs, colored PR labels, a dot on the Overview button while something waits, and a "Public Beta" pill. Juno says the state in words.

**Agent presence**
- **Anthropic presents one identity with no persona.** "Claude", marked with an APP label in Slack, is present through places (a channel, a thread, a project) and through a working indicator with **Stop**. Presence is where it works and what it is doing, not a face ([Claude Tag](https://claude.com/docs/claude-tag/concepts/how-it-works)).
- **Juno's divergence is deliberate** (named teammates with faces, `docs/JUNO.md:2037-2110`), and it can stay a differentiator if:
  - the face stays a quiet, derived signal: never looping when idle, reduced-motion respected, and the state always said in words beside it (`docs/JUNO.md:2096-2103`);
  - the agent's substance is the place it holds (access, memory, routines, history).
- **Presence-aware notifications:**
  - Push is skipped while the person is at the machine.
  - Push is split into "Claude decides" and "actions required" ([remote control](https://code.claude.com/docs/en/remote-control.md)).
  - Juno's `Agent.notify` (`needs_you | results | all`) is the same idea. Extend presence awareness across Mac, iPhone and web.

---

## 4. Sources

All first-party pages were read live on 2026-09-30. "Undated" means a living document with no publication date; the version or date markers it carries are noted.

**Anthropic announcements and blogs**
1. Claude Cowork and chat are now one Claude. claude.com, **2026-09-16**. https://claude.com/blog/cowork-is-now-claude
2. Introducing Claude Design by Anthropic Labs. anthropic.com, **2026-04-17**. https://www.anthropic.com/news/claude-design-anthropic-labs
3. Claude's memory works everywhere, and you decide what's in it. claude.com, **2026-08-25**. https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it
4. Claude Managed Agents: get to production 10x faster. claude.com, undated (public beta 2026-04-08 per press, UNVERIFIED). https://claude.com/blog/claude-managed-agents
5. A harness for every task: dynamic workflows in Claude Code. claude.dev, **2026-06-02**. https://claude.dev/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code/

**Claude Help Center (support.claude.com)**

6. Release notes, entries June–September 2026 (dated per entry: 2026-06-23 Claude Tag; 2026-07-07 Cowork on web and mobile; 2026-07-10 memory redesign; 2026-08-06 skill and plugin security scanning; 2026-08-25 memory across chat and Cowork; 2026-09-16 merge; 2026-09-25 plugin submission portal). https://support.claude.com/en/articles/12138966-release-notes
7. Claude Cowork and chat are one Claude. Undated, post-2026-09-16. https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude
8. Get started with Claude Docs. Undated. https://support.claude.com/en/articles/16923645-get-started-with-claude-docs
9. What are artifacts and how do I use them? Undated. https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
10. Artifacts admin guide for Team and Enterprise plans. Undated. https://support.claude.com/en/articles/16994751-artifacts-admin-guide-for-team-and-enterprise-plans
11. Get started with Claude Design. Undated. https://support.claude.com/en/articles/14604416-get-started-with-claude-design
12. What are projects? Undated. https://support.claude.com/en/articles/9517075-what-are-projects
13. Use Claude's chat search and memory. Undated. https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
14. Use research on Claude. Undated; likely stale relative to the merge. https://support.claude.com/en/articles/11088861-use-research-on-claude
15. Get started with Claude Cowork. Undated; carries the merge note. https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
16. Dispatch. Undated; "limited beta… isn't available to new users". https://support.claude.com/en/articles/13947068

**Claude docs (claude.com/docs)**

17. Connectors, skills, and plugins (extend overview). https://claude.com/docs/extend/overview
18. Get started with connectors. https://claude.com/docs/connectors/getting-started
19. Skills overview. https://claude.com/docs/skills/overview
20. Plugins (claude.ai and Cowork). https://claude.com/docs/plugins/overview
21. Work with Claude Tag (overview). https://claude.com/docs/claude-tag/overview
22. How Claude Tag works. https://claude.com/docs/claude-tag/concepts/how-it-works

**Claude Code docs (code.claude.com)**

23. Share session output as artifacts (versions to v2.1.265). https://code.claude.com/docs/en/artifacts
24. Run agents in parallel. https://code.claude.com/docs/en/agents.md
25. Let Claude coordinate ongoing work with Projects (versions to v2.1.280). https://code.claude.com/docs/en/claude-projects.md
26. Manage multiple agents with agent view. https://code.claude.com/docs/en/agent-view.md
27. Desktop application. https://code.claude.com/docs/en/desktop.md
28. Use Claude Code in the cloud. https://code.claude.com/docs/en/claude-code-on-the-web.md
29. Automate work with routines (research preview). https://code.claude.com/docs/en/routines.md
30. Choose a permission mode (to v2.1.283). https://code.claude.com/docs/en/permission-modes.md
31. Continue local sessions with Remote Control. https://code.claude.com/docs/en/remote-control.md
32. Plugins overview. https://code.claude.com/docs/en/plugins/overview.md
33. Anthropic's marketplaces. https://code.claude.com/docs/en/plugins/anthropic-marketplaces.md
34. Agent SDK overview. https://code.claude.com/docs/en/agent-sdk/overview.md
35. Week 28, July 6–10, 2026: built-in browser on Desktop and agent-view headlines. https://code.claude.com/docs/en/whats-new/2026-w28.md
36. Documentation index. https://code.claude.com/docs/llms.txt

**Claude Platform docs (platform.claude.com)**

37. Claude Managed Agents overview (beta header `managed-agents-2026-04-01`). https://platform.claude.com/docs/en/managed-agents/overview
38. Dreams (research preview, header `dreaming-2026-04-21`). https://platform.claude.com/docs/en/managed-agents/dreams

**Press, used only to fill gaps and labeled [press] in the text**

39. 9to5Mac, "Anthropic merging Claude Cowork with chat", **2026-09-16**. https://9to5mac.com/2026/09/16/anthropic-merging-claude-cowork-with-chat/
40. TestingCatalog, "Claude merges Cowork and chat into one experience", ~2026-09-16. https://www.testingcatalog.com/claude-merges-cowork-and-chat-into-one-experience/
41. DigitalApplied, "Claude Chat and Cowork Are Now One App", **2026-09-16**. https://www.digitalapplied.com/blog/claude-chat-cowork-merge-docs-slides-what-teams-set
42. SiliconANGLE, "Anthropic updates Claude's memory…", **2026-08-25**. https://siliconangle.com/2026/08/25/anthropic-updates-claudes-memory-to-enhance-customization-and-protect-sensitive-topics/
43. InfoWorld, "Anthropic rolls out Claude Managed Agents", date per search result only, not opened (UNVERIFIED). https://www.infoworld.com/article/4156852/anthropic-rolls-out-claude-managed-agents.html

**Juno files cited** (refoundation worktree @ `1feb392c`): `docs/JUNO.md`, `PRODUCT.md`, `docs/design/artifacts-design/04-MERGE-PLAN.md`, `src/lib/chat/task-tool.ts`, `src/lib/chat/system-prompt.ts`, `src/components/chat/use-conversation-work.ts`, `src/components/chat/composer.tsx`, `src/components/app/app-sidebar.tsx`, `src/lib/work/domain.ts`, `src/lib/action-approval.ts`, `src/app/api/work/protocol.ts`, `src/lib/agents/domain.ts`, `src/lib/message-content.ts`, `src/lib/design/types.ts`, `src/app/(app)/design/[artifactId]/page.tsx`, `src/lib/skills/github.ts`, `src/lib/chat/skills.ts`, `src/app/api/mcp/servers/route.ts`, `src/lib/memory.ts`.
