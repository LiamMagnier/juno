# OpenAI (ChatGPT, Work, Codex, dots, plugins): research for the Juno Refoundation

Phase 0 competitor research. Written 2026-09-30, the day after OpenAI DevDay 2026 (2026-09-29).
Everything about OpenAI comes from live sources read on 2026-09-30: 54 primary pages (3 on openai.com, 18 on help.openai.com, 33 on learn.chatgpt.com), plus one press article and two OpenAI community threads, which are labelled where cited. Help-center "Updated: N days ago" stamps are converted to absolute dates. learn.chatgpt.com pages carry no date and are cited as "undated, accessed 2026-09-30". Juno claims cite `path:line` in the `rework/refoundation` worktree (same tree as `main` @ `1feb392c`).

Terminology note. OpenAI renamed most of its product surface between July and September 2026:
- "Apps" and "connectors" are now **plugins**. A plugin bundles skills, apps (MCP), app templates and UI extensions.
- The App Directory is now the **Plugin Directory**.
- **Library** is being replaced by **Space**, which holds Pages.
- The Codex app merged into the **ChatGPT desktop app**, which has three modes: Chat, Work and Codex.
- **Agent mode** and **Operator** were removed. **Pulse** was sunset in favour of scheduled tasks.
- **"dots"** are OpenAI's new always-on personal agents (launched 2026-09-29).

---

## 1. Summary: the lessons that matter most for Juno

1. **OpenAI split one assistant into three modes (Chat, Work, Codex), and users feel the seam.** The modes use different model families, different meters and different histories. A community post (2026-09-05) says moving from Chat to Work felt like "being transferred to another assistant". Juno already avoids this: the chat model starts Work itself through `start_task`, and the run renders in the same thread (`src/lib/chat/system-prompt.ts:57-72`). Keep that as a core principle and do not add a mode toggle.
2. **dots are close to what Juno Agents are trying to be,** and OpenAI shipped the parts Juno has not finished. A dot is a named character with a face you customise, a standing goal, memory, schedules, proactive background research, its own cloud computer and browser, and the same identity in ChatGPT, Slack, Teams, voice calls and (soon) SMS. Juno's Agent model already has a named face, brief, goals, ideas, notes, routines, notify level and approval mode (`prisma/schema.prisma:3809-3849`). The gaps are a production computer (`src/lib/computer/provider.ts:17-28` returns only docker, fake or null) and reach outside the app.
3. **OpenAI launched one agent per person, not a team.** "Today, you can start with your primary dot… Over time, we envision teams of dots." Juno's team-of-agents framing is more ambitious. Its UX has to earn that extra complexity.
4. **The plugin is the right unit of reuse: skills, connected apps and UI in one installable package,** invoked with `@name` or chosen automatically from its description. Custom GPTs are being retired into plugins (2026-09-11). Juno has skills (`src/lib/skills/*`), connectors, Composio and user MCP (`src/lib/user-mcp.ts`) as separate things. It needs one "installed capability" object.
5. **Approvals are now a layered system with a reviewer.** The layers are sandbox, then approval policy, then an automatic reviewer agent, then the person. The key idea is that auto-review is "a reviewer swap, not a permission grant". OpenAI adds natural-language **Custom rules** with four outcomes: do it, do it when I say so, ask first, or hand it to me. Juno's policy classes and digest-bound receipts (`src/lib/action-approval.ts:22-45, 351-380`) are stronger on integrity. They lack a reviewer tier and natural-language rules.
6. **Each kind of stop is named separately.** Dots separate Pause (current main task), Stop (one delegated task) and Cancel (a schedule), and say that stopping does not undo anything already done. The Codex approval prompt has a fourth option, **"Tell Codex what to do"**, alongside Approve, Always approve and Deny.
7. **"Proactive" is made safe by construction, not by a setting.** A dot's background research runs with read-only tools that "can't send messages, change app content, or control your browser or computer". Juno agents reflect proactively (`src/lib/agents/reflect.ts`). They should get the same tool-level restriction, and the UI should say so plainly.
8. **Attention is sorted by priority: needs input first, then blocked, then ready, then running.** Desktop "Activity view", the Scheduled "inbox with unread indicator" and the floating "pet" all use that order. The ordering is the lesson. The pet's four-state status indicator breaks the owner's no-status-pill rule and should not be copied.
9. **Publishing is separated from sharing.** Sites are live-deployed apps with versions, per-visitor connected data, schedules and custom domains, and "every deployment URL is a production URL". Juno shares are frozen snapshots (`src/lib/share.ts:11-22`). If Juno ever publishes artifacts, it should be a separate, explicit, versioned action, not an upgrade to share links.
10. **Juno should not copy OpenAI's churn and metering.** OpenAI has three agent products (dots, workspace agents, specialist dots) and removed Agent mode without notice (help article, community thread 2026-08-08). Voice minutes, Work/Codex 5-hour windows, deep-research counters and "credits" are all metered separately. Juno's single honest usage meter and its stable nouns are a real advantage.

---

## 2. Capability by capability

Each capability below answers six questions: (a) what it is today, (b) the user problem it solves, (c) what Juno has, (d) whether OpenAI's version is better, (e) the principle Juno should adopt, and (f) what Juno should not copy.

### 2.1 ChatGPT home, composer and model picker

**(a) What it is today**
- **Home.** The desktop app opens on a global ChatGPT or Codex switcher. Inside ChatGPT, a **Chat | Work** toggle sits above the composer. The web home asks "What should we work on?" with Choose project, Plugins and Work locally controls ([ChatGPT on the web](https://learn.chatgpt.com/docs/web), undated; [release notes 2026-07-16](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)).
- **Home suggestions** "based on their conversation history and connected tools" for eligible paid users (release notes 2026-08-14). This is effectively what replaced Pulse on the home screen.
- **Model picker, simplified on 2026-06-10.** Chat offers Instant, Medium, High, Extra High, Pro Standard and Pro Extended. The picker sits in the composer on web and at the top of the conversation on mobile. On 2026-04-28 model selection moved into the composer, with effort inside the picker.
- **Auto-switching removed.** On 2026-09-14 OpenAI retired automatic switching from Instant to Thinking for Plus and Pro, and removed the "Higher intelligence" setting.
- **Work and Codex models.** Work and Codex have their own models (GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna) that "are not available in regular ChatGPT conversations". Their picker offers **Default, which "combines models and reasoning levels along one slider"**, or a specific model with its own effort levels ([ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex), updated 2026-09-29).
- **Composer details.**
  - Long-press Send picks a model for one message (iOS 2026-06-08, Android 2026-06-18).
  - Pastes over 10k characters become attachments, with "Show in text field" to undo (2026-06-22, 2026-08-04).
  - Pasted formatting is kept (2026-08-07).
  - "Add from library" (2026-08-07).
  - The placeholder reads "Do anything. @ to use plugins", with `@` for plugins and files, `$` for skills and `/` for commands ([Pets](https://learn.chatgpt.com/docs/pets); [get started with Work](https://learn.chatgpt.com/docs/get-started-with-work), undated).

**(b) Problem solved.** People want one place to start any job, fast answers by default, and control over depth when it matters.

**(c) What Juno has.**
- Juno has no mode toggle. The chat model decides whether to hand work off: "You decide; the user has no switch for this" (`src/lib/chat/system-prompt.ts:58`).
- The picker is split into two stages for bundle size (`src/lib/model-picker.ts:1-19`).
- There is a reasoning slider (`src/components/chat/reasoning-slider.tsx`).
- `@` rows toggle capabilities such as `@search` and `@research`. An unavailable row stays visible with its reason, e.g. "not on this model" (`src/components/chat/composer.tsx:1725-1760`).

**(d) Is theirs better?**
- **Mixed.** OpenAI's single "Default" slider is a good simplification for non-experts.
- Their Chat vs Work split and separate model families are worse. OpenAI itself has walked back one piece of automation: it retired auto-switching to Thinking (2026-09-14), so Chat depth is now an explicit user choice again.
- The community complaint (2026-09-05, [thread](https://community.openai.com/t/work-breaks-assistant-continuity-and-work-usage-limits-make-long-professional-sessions-impractical/1395071)) asks for "One assistant. One conversation. One continuous project." That is Juno's current design.

**(e) Principles to adopt.**
- Keep a single conversation. Let depth be a visible, reversible setting.
- Offer one "Default" position that bundles model and effort for people who do not care, and put the full catalogue behind it.
- Make one-message overrides cheap, for example long-press Send.
- Turn huge pastes into attachments automatically, with a one-click way back.

**(f) What not to copy.**
- A Chat/Work/Codex tri-mode with separate histories and models.
- Model names that change per surface.
- Mobile placing the picker somewhere different from web.

### 2.2 Memory

**(a) What it is today.** ([Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt), updated about 2026-09-19; release notes.)
- **Improved memory (2026-06-04).** ChatGPT "keeps track of the details it determines are most important", doubles capacity, and lets users revert to legacy saved memories.
- **Memory summary (2026-06-12).** Users edit it by typing a correction or highlighting text. "Delete and turn off memory" is available.
- **Memory sources under each answer (2026-05-05).** Users can open, correct, delete or mark a source "not relevant". "Don't mention this again" suppresses without deleting.
- **Project-only memory**, switchable after a project is created (2026-08-14).
- **Temporary chat** can opt into personalisation at start, and can be saved later (2026-08-27).
- **Computer History (macOS, off by default).** It records interaction events, not screenshots, and feeds memory (2026-08-13).
- **Dots keep their own notes, separate from ChatGPT memory, and users cannot inspect them.** "You currently cannot view, delete or directly modify individual dot memories" ([dots privacy FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs), updated 2026-09-30).

**(b) Problem solved.** People want to stop repeating themselves without losing control of what is remembered.

**(c) What Juno has.**
- Entries carry provenance, confidence, last-used, verification and supersession (`src/lib/memory-view.ts:14-32`).
- Each reply shows a "Remembered about you" receipt in the thought panel, with **Open source chat, Forget this, Manage all** (`src/components/chat/thought-process-model.tsx:382,518`; `src/components/chat/thought-process-panel.tsx:1611-1660`).
- Suppression entries are enforced on every write path (`src/lib/memory-suppression.ts:1-20`).
- Natural-language memory edits exist (`/api/memory/edit/apply`, referenced in the same file).
- Agent notes are listed and deletable one at a time (`src/components/agents/agent-panel.tsx:262-271`).

**(d) Is theirs better?** On substance, **no**. Juno is at parity or ahead: its agent notes are inspectable where dots' memories are not, and its suppression is enforced across writers. OpenAI is ahead in two places:
- "Not relevant / don't mention again" sits in the per-answer source list, as a softer option than "Forget".
- Project-only memory is presented as a simple per-project setting.

**(e) Principles to adopt.**
- Offer three verbs, each with a distinct meaning: forget, don't bring this up, and not relevant here.
- Make memory scope a visible property of the project.
- An agent's memory must always be readable and editable. Juno should state this explicitly as a differentiator.

**(f) What not to copy.**
- An agent memory store the user cannot see.
- Background "Computer History" style capture as a default-on path.
- Two parallel memory systems (legacy vs improved) that the user has to choose between.

### 2.3 ChatGPT Work (agentic long-running work)

**(a) What it is today.** Launched 2026-07-09 ([OpenAI blog](https://openai.com/index/chatgpt-for-your-most-ambitious-work/), 2026-07-09).
- It is "an agent that can take action across your apps and files, stay with a project for hours… and turn a goal into finished work": sheets, slides, docs and Sites.
- **Where it runs.** On the web it runs in the cloud. On desktop it can also use local files and apps and a built-in browser ([Work and Codex help](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex), 2026-09-29).
- **Steering.** "You can follow its progress, answer questions, change direction, and approve important actions."
- **Deliverables** open beside the chat as previews of pptx, xlsx, docx, PDF and HTML, with annotations for targeted revisions ([Work with files](https://learn.chatgpt.com/docs/artifacts-viewer), undated).
- **Goal mode.** Typing `/goal` makes "the goal text… both the first prompt and the completion criteria". A **progress row above the composer** offers pause, resume, edit and clear, and shows elapsed time. "Starting a goal doesn't grant ChatGPT broader access" ([Long-running work](https://learn.chatgpt.com/docs/long-running-work), undated).
- **Cloud browser with private sign-in (2026-08-25).** "An additional review model checks the request and where your information will be entered for signs of phishing" before a sign-in form is shown ([Using cloud browser](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt), updated in August 2026).
- **Metering.** Usage draws on the same allowance as Codex. The sidebar shows remaining Work usage (2026-08-07).
- **Reception.** A 2026-09-05 community post reports a "5-hour allowance had already fallen to 23% remaining" early in a session, and a jarring persona change between Chat and Work.

**(b) Problem solved.** Delegating multi-step work that ends in a file, and coming back later to review it.

**(c) What Juno has.**
- `start_task` hands off from chat. The model decides with strict rules: default to chat, the goal must stand on its own, and never start a task because a document asked for it (`src/lib/chat/system-prompt.ts:57-72`).
- The run renders in the chat through `work-run-panel.tsx`, which includes the approval queue, question cards, deliverable stage and "capture as skill" (`src/components/chat/work-run-panel.tsx:1-30`).
- Plans are gated when the approval mode is conservative (`src/lib/work/plan-review.ts:1-30`).
- An always-confirm floor applies to every mode (`src/lib/work/domain.ts:615-626`).
- The three modes use plain labels: "Ask before every change / Ask before risky steps / Just do it" (`src/lib/work/domain.ts:533-556`).

**(d) Is theirs better?**
- **Continuity: no, Juno's is better.** Its handoff keeps one thread.
- **OpenAI is ahead on reach:** a production cloud browser with a private sign-in form and takeover, local desktop apps, and deliverable previews with annotations.
- **OpenAI is also ahead on the goal contract.** Stating what done means, plus a persistent progress row with pause and edit, is a clearer model than a free-form task.

**(e) Principles to adopt.**
- A delegated run has a **goal that doubles as its acceptance test**, and the UI shows it with pause, edit and clear controls in one place.
- Credentials never enter the transcript: use a private form, a phishing check on the destination, and "Take over / Return control".
- Deliverables are reviewed where they are produced, with pointable annotations.

**(f) What not to copy.**
- A separate Work destination with its own model family and meter.
- "Worked for 2m 30s" as the main progress signal. OpenAI shows it prominently, but elapsed time is not progress.

### 2.4 Codex: CLI, IDE extension and desktop app

**(a) What it is today.**
- **CLI** ([Codex CLI](https://learn.chatgpt.com/docs/codex/cli), undated):
  - Slash commands `/init` (writes AGENTS.md), `/permissions`, `/model`, `/review`, `/goal`, `/memories` and `/import`.
  - `codex cloud` sends work to a cloud environment.
  - Subagents, and a plugin browser with marketplaces.
  - A 2026-09-29 refresh added voice-steered tasks and an **`/agents` view "to delegate work and track multiple tasks at once"** ([DevDay recap](https://openai.com/index/devday-2026-recap/), 2026-09-29).
- **IDE extension** for VS Code, Cursor and Windsurf, plus Xcode and JetBrains integrations. It uses open files and selections as context and offers "Continue in: Work locally / Cloud" ([IDE](https://learn.chatgpt.com/docs/codex/ide), undated).
- **Desktop app** ([Code review](https://learn.chatgpt.com/docs/code-review), undated; [Remote](https://learn.chatgpt.com/docs/remote), undated):
  - Codex is now a view inside the ChatGPT desktop app, with an integrated terminal, worktrees, and a built-in browser with **annotation mode** for pointing at UI.
  - Computer Use with **locked use** on macOS.
  - **Appshots**: press both Command keys to attach the front window.
  - A Code Review plugin with a PR inbox, stacks and "Mark as viewed", plus customisable review instructions.
  - **Remote**: phone pairing by QR code, with approvals on the phone offering **Approve / Always approve / Tell Codex what to do / Deny**.
- **Permission modes** ([Permissions](https://learn.chatgpt.com/docs/permission-modes), undated): Ask for approval, **Approve for me (auto-review)**, Full access, or Custom. "Changing who reviews a request doesn't expand the sandbox."
- **Import from other agents.** `/import` in the CLI, and Settings > Import in the app, bring over settings, AGENTS.md, skills, plugins, MCP config, hooks, subagents and 30 days of chats from **Claude Code, Claude Cowork and Cursor**, with optional ongoing sync ([Import](https://learn.chatgpt.com/docs/import), undated).

**(b) Problem solved.** A coding agent that works where the developer already is and can be supervised from anywhere.

**(c) What Juno has.**
- Juno Code runs as a local Swift agent on Mac, with cloud runs on GitHub Actions (`src/lib/cloud-code.ts:4-15`).
- Per-session cloud environments carry network, variables and permission mode (`src/lib/code-environments.ts:1-12`).
- Phone remote control goes through `src/lib/code-remote.ts`.
- There are worktrees, diff review and approvals.

**(d) Is theirs better?** On breadth, yes: CLI, IDE, desktop, cloud, review inbox and security scanning. The ideas worth taking are:
- the auto-review tier;
- "Tell Codex what to do" as a first-class answer to an approval;
- annotation-mode feedback on rendered UI;
- import from competitors' agents. OpenAI imports from Claude Code and Cursor. Juno imports only chat history, per the landing copy.

**(e) Principles to adopt.**
- Every approval prompt offers a **redirect**, not just yes or no.
- Import the user's existing agent setup (skills, MCP servers, instructions), not just their chats.
- Visual feedback on a rendered page should be a pointer, not a paragraph.

**(f) What not to copy.**
- Codex history kept separate from Chat history.
- Four surfaces with different feature subsets. The "Codex CLI doesn't render Visualizations" style caveat appears on almost every learn.chatgpt.com page.

### 2.5 Codex Cloud (parallel cloud tasks, environments, PRs)

**(a) What it is today.** Re-launched 2026-09-29 ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes); [Using Codex Cloud](https://help.openai.com/en/articles/20001545-using-codex-cloud), updated 2026-09-30; [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments), undated).
- **Guided setup.** "Codex inspects your repositories, installs dependencies and tools, and tests the workflow… Review… and select Publish."
- **What an environment holds:** an install script, a **Start skill** (how to bring services up), network allowlists, network secrets, environment variables and OIDC.
- **Isolation.** Each task gets an isolated workspace from the published environment. Saved VM state can be recovered for 7 days.
- **Surfaces.** Tasks can be started and continued from desktop, web or mobile, and can be shared with an Enterprise team.
- **Results.** "Commit or open a pull request when you're ready."
- **Automatic PR reviews** run in the cloud. Codex Security Cloud scans repositories on a schedule.

**(b) Problem solved.** Running many coding tasks in parallel without a laptop, from a setup the whole team trusts.

**(c) What Juno has.**
- Cloud runs are dispatched to GitHub Actions using a workflow on `LiamMagnier/juno` (`src/lib/cloud-code.ts:11-15`).
- `CodeEnvironment` rows make network, variables, setup and permission mode per-session choices (`src/lib/code-environments.ts:1-12`).
- UNVERIFIED: I did not check whether Juno has a "setup agent that tests and publishes an environment" step.

**(d) Is theirs better?** Yes, on setup UX. **Having the agent prepare the environment, test it, and ask the person to publish it** removes the hardest part of cloud coding, which is writing the setup script.

**(e) Principles to adopt.**
- An environment is a **reviewed, published artifact** made by the agent and approved by the person.
- Publishing an environment affects only new tasks. Existing tasks keep their own state.

**(f) What not to copy.**
- The "Legacy" vs new Cloud split, where some features still require the old one.

### 2.6 dots (always-on personal agents)

**(a) What it is today.** Launched 2026-09-29 ([Introducing dots](https://openai.com/index/introducing-dots/), 2026-09-29; [Getting started](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot), updated 2026-09-30; [Meet dots](https://learn.chatgpt.com/docs/dots), [Controls](https://learn.chatgpt.com/docs/dots/controls), [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory), [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps), all undated).

- **Identity.**
  - A dot runs on GPT-6 Astra and has "their own cloud computer, learn from feedback over time, and can work towards your goals 24/7".
  - The user names it and chooses its "shape, color, eyes, glasses, and accessories", or picks a pet. Its handle is `@yourname-agentname`.
  - TechCrunch calls the look a "bubbly, cartoonish persona" ([TechCrunch](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/), 2026-09-29, press).
  - One dot is included with Pro and Business Premium. "Over time, we envision teams of dots."
- **Channels.**
  - The same dot is reachable in ChatGPT, Slack and Teams, by **voice call** (a phone button in its conversation), and by SMS (limited US beta).
  - "Messages stay in their respective channels, while your dot can use relevant context across them. Before sharing information from a private conversation with other people, your dot checks that you've allowed it."
- **How it works.**
  - It "can decide when to pause and wake up to continue work; you don't need a fixed schedule".
  - It uses background agents in parallel, and can start visible cloud threads plus Work or Codex tasks on a connected computer.
  - The profile shows **In progress, Scheduled and Completed**. Desktop has an **Activity** view.
- **Proactive research.**
  - It runs "using the apps you've already connected with tools that are restricted to be read-only, which means that they can't send messages, change app content, or control your browser or computer."
  - "We don't train directly on proactive research or your dot's notes to itself."
- **Computers.**
  - It has its own cloud computer and browser. The user can open it at any time. "Opening the computer doesn't give you control. Select Take over… then Return control."
  - One personal computer can be connected, off by default and revocable.
  - The sign-in flow uses a private form and optional Save to Passwords, and "Reusing a saved login… requires your confirmation."
- **Controls.**
  - Built-in rules, plus **Custom rules** with four behaviours: *Take action without asking / Take action when you say so / Ask before taking action / Hand off to you*. Password changes and money transfers always go to the person ([privacy FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs), 2026-09-30).
  - **Auto-review** checks actions against instructions and rules.
  - "Asking your dot to draft replies doesn't give it permission to send them."
- **Stopping and deleting.**
  - "Pause stops your dot's current main task. It doesn't stop every delegated task or cancel future scheduled runs."
  - Deleting a dot erases its context, but "doesn't undo changes already made in connected apps".
- **Metering.** "Conversations with your dot don't count toward your ChatGPT usage limits"; the tasks it starts do.
- **Related OpenAI agent products:**
  - **Workspace agents** (Business and Enterprise): created in a builder, shareable, able to run on a schedule, in Slack or through an API trigger, with **Connector Action Constraints** such as "only send to recipients at a specific domain" ([Workspace agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business), updated about 2026-09-25).
  - **Specialist dots**: an enterprise pilot in which each dot gets "its own identity, credentials".

**(b) Problem solved.** A persistent delegate that holds a responsibility over weeks, not a single prompt, and is reachable wherever the person already talks.

**(c) What Juno has.**
- Agents have name, role, a face made of `{shape, tone, eyes, mark}`, a style, a standing brief (`instructions`), model and effort, an approval mode that can only narrow, connector ids, a project, one thread, active or paused status, a proactive flag and a notify level of needs_you, results or all (`prisma/schema.prisma:3809-3849`).
- They also have goals with a check-in cadence, ideas (proposed work to start or dismiss) and notes whose source is user, agent or reflection (`prisma/schema.prisma:3870-3940`).
- There is a derived state sentence and a `needsYou` count (`src/lib/agents/types.ts:69-77`).
- The agent computer can only be docker or fake, and fake is disabled in production (`src/lib/computer/provider.ts:17-28`).
- Voice calls in an agent thread take on the agent's persona but "a call has no tools… nothing gets started from it" (`src/lib/voice-persona.ts:1-18`).

**(d) Is theirs better?**
- **Juno is equal or better on the data model:** multiple agents, inspectable and deletable notes, explicit goals with cadence, ideas as a reviewable queue, and approval modes that only narrow.
- **OpenAI is better on four things:**
  1. A real computer with takeover.
  2. Reach through Slack, Teams, voice calls and SMS with one identity and privacy boundaries between channels.
  3. Natural-language custom rules.
  4. Explicitly read-only proactive research, which matters for trust.
- OpenAI also self-schedules ("decides when to wake up"). Juno has routines and reflection sweeps (`src/lib/agents/reflect-sweep.ts`).

**(e) Principles to adopt.**
1. **Proactive work is read-only by tool construction.** Its output is a suggestion (Juno's Idea), and acting on it needs the normal approval.
2. **One identity across channels, with an explicit disclosure rule.** Context can inform any channel, but private context is never revealed to a new audience without permission.
3. **Name the stops separately:** pause the agent, stop one task, cancel a routine, delete the agent. Say that none of them undo past actions.
4. **Rules are sentences with one of four outcomes,** compiled into Juno's existing policy classes. They are never a grid of toggles.
5. **Approval to draft is not approval to send.** Scope comes from the instruction and is shown back to the user.
6. **Viewing the computer and taking it over are separate actions.**

**(f) What not to copy.**
- The cartoon mascot direction: pets, glasses, accessories, a "bubbly" persona. Juno's faces should stay calm and legible.
- Unviewable agent memory.
- Three different agent products for one idea.
- Free chat with the agent while its tasks are metered, which blurs what things cost.

### 2.7 Plugins (skills + apps + actions + UI) and the Apps SDK

**(a) What it is today.** ([Plugins in ChatGPT](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex), updated 2026-09-29; [Plugin architecture](https://learn.chatgpt.com/plugins/concepts/plugins), [Extensions](https://learn.chatgpt.com/plugins/build/extensions), [UI guidelines](https://learn.chatgpt.com/plugins/concepts/ui-guidelines), [Migrate custom GPTs](https://learn.chatgpt.com/docs/migrate-custom-gpts), all undated.)
- **What a plugin contains:** "Skills that provide instructions… Connected apps… App templates… Extensions".
- **Invocation.** "ChatGPT automatically uses your installed plugins when they're relevant… You can also select a plugin directly with an @ mention."
- **One shared directory** across ChatGPT and Codex, with an OpenAI Verified badge. Workspace admins set install policies (Available or Installed) and can **sync a marketplace from GitHub**.
- **Plugin Creator** builds plugins through conversation: `@plugin-creator`.
- **Plugin shapes.** OpenAI's own decision table covers skills only, MCP only, skills plus MCP, and MCP plus UI. "Start with the smallest shape." UI follows the open **MCP Apps** standard, with OpenAI extensions for sidebar apps, conversation panels, file viewers and editors, composer mentions, rich forms and settings. Composer mentions work only in the desktop app.
- **UI guidelines** list display modes (inline card, carousel, fullscreen with the system composer overlaid, picture-in-picture). The rules include:
  - at most two actions per card;
  - no nested scrolling;
  - no deep navigation inside a card;
  - "Don't replicate ChatGPT features in a card";
  - "Avoid custom gradients or patterns";
  - brand colour on accents only.
- **Custom GPT retirement (announced 2026-09-11).** GPT instructions and files become a **skill**. Custom actions "do not transfer", so users must rebuild them as an app or MCP server.
- **MCP events (2026-09-29)** let plugins trigger automations.
- **Sign in with ChatGPT and allowance sharing** with partner apps.

**(b) Problem solved.** Reusable know-how (skills) and reach (apps) are useless apart. People want "a Project Updates plugin that gathers progress from Slack and Linear and drafts a weekly update", which needs both.

**(c) What Juno has.**
- Skills with SKILL.md parsing, including `allowed-tools` treated "as a REQUEST" (`src/lib/skills/skill-md.ts:11,68,147`).
- GitHub-sourced skill libraries with update checks and trust tracking (`src/lib/skills/sources.ts:1-15`).
- Native connectors, Composio, and user MCP servers as a "third shape" (`src/lib/user-mcp.ts:6-20`).
- Capturing a skill from a completed Work run (`src/components/chat/work-run-panel.tsx:19`).
- Juno does not bundle skills and connectors into one installable unit. User MCP servers do exist in this tree (`src/lib/user-mcp.ts`), and the baseline shows `/api/mcp/servers*` routes (`docs/rework/PROGRESS.md`, baseline table).

**(d) Is theirs better?** **Yes, on packaging.** One noun covers "a thing I install that knows how to do X with Y", and `@name` works for all of it. Juno's skill provenance and trust model looks at least as careful. Juno's `@` currently toggles capabilities rather than invoking packages (`src/components/chat/composer.tsx:1725-1760`).

**(e) Principles to adopt.**
1. **One installable unit** of instructions, connections and optional UI, with one `@` handle and automatic selection by description.
2. **Choose the smallest shape** that does the job: skills alone when instructions are enough.
3. Third-party UI is **native-first and restrained**: system colours, two actions, no gradients. This matches the owner's anti-slop rules.
4. Admin or marketplace **sync from Git** as the distribution path, which Juno already half has for skills.

**(f) What not to copy.**
- Letting installs start auth flows silently.
- Desktop-only plugin capabilities that quietly fail on web, which is OpenAI's "Desktop only" label problem.
- Verified badges as a status ornament.

### 2.8 Library, Space and Pages

**(a) What it is today.**
- **Library (from 2026-03-23)** automatically saves every uploaded and generated file. It has storage quotas (Free 500 MB, Plus 20 GB, Pro 100 GB), "Add from library", `@` file mentions, and folder-level "work across these files" ([Using Library](https://help.openai.com/en/articles/20001052-using-library-to-manage-files-in-chatgpt), updated about 2026-09-19).
- **Connected sources.** Drive, Box, Dropbox and SharePoint appear as browsable sources that "remain connected to their original source" and can be opened beside the chat (2026-08-13, 2026-09-10). Sharing with Viewer and Editor roles arrived 2026-09-09.
- **Space and Pages (2026-09-29).** Space "replaces Library for accounts with access". Projects remain separate. Pages are collaborative documents built "for human and agent collaboration":
  - `@ChatGPT` or `@dot` inline or in a comment;
  - slash commands Generate, Visualize and Image;
  - subpages that inherit access;
  - "Each collaborator works with their own ChatGPT", so private chats and memory are not shared.
  - "Keep updated" is not yet available ([Space](https://help.openai.com/en/articles/20001549-getting-started-with-space-in-chatgpt), updated 2026-09-30; [Work with agents](https://learn.chatgpt.com/docs/space/agents), undated).

**(b) Problem solved.** Files and documents outlive the chat that made them, and teams need a shared place where AI edits are visible.

**(c) What Juno has.**
- A Library page and quota logic (`src/lib/library.ts`; `src/app/(app)/library/page.tsx`).
- Projects.
- Artifacts with one address per object, `/a/{id}`, that survives type changes (`src/lib/artifact-links.ts:1-18`), versioning, and a Design editor.
- Collaboration modules exist (`src/lib/collaboration`, `src/lib/project-collaboration.ts`). I did not check their depth: UNVERIFIED.

**(d) Is theirs better?** The Library-to-Space churn is itself a warning: three containers (Projects, Library, Space) now overlap. The idea worth taking is **connected files that stay in place**: browse them, mention them and open them beside the chat without copying.

**(e) Principles to adopt.**
- **Files belong to the object, not the chat.** Deleting a chat never deletes a saved file. This is OpenAI's rule and it is correct.
- Connected storage should be browsed and referenced where it lives.
- In shared documents, **each collaborator's AI uses its own memory**, and what is written onto the page becomes visible to everyone. Say so at the moment of writing.

**(f) What not to copy.**
- Projects, Library and Space as three overlapping containers.
- Renaming a core surface less than a year after launching it.

### 2.9 Sites (publishing)

**(a) What it is today.** Public beta from 2026-07-09 ([Creating and using ChatGPT Sites](https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites), updated 2026-09-29).
- **Creation.** Users build interactive sites or light apps from Work or Codex with `@Sites`, then preview privately.
- **Deploys.** "When you deploy, ChatGPT generates a Site URL. Every deployment URL is a production URL. To review changes without updating the live Site, save a version first."
- **Audiences:** owner, named people, workspace, external named viewers (2026-09-03), or public.
- **Custom domains**, a URL change with redirects (2026-08-20), and editing from the published site ("Edit site", 2026-09-29).
- **Scheduled refresh** through Automations.
- **Connected data.** Business and Enterprise sites can read **each visitor's own connected apps, read-only**.
- **Plugins.** Sites can host MCP servers for plugins (2026-09-29).
- **Deletion** requires typing the slug.

**(b) Problem solved.** Turning an analysis into something other people use, such as a dashboard or tracker, without a deployment toolchain.

**(c) What Juno has.** Share links are **snapshots**: "`snapshotAt` freezes at creation… new messages and artifact edits stay private". Revocation leaves a tombstone. The token is 24 random bytes (`src/lib/share.ts:11-22`). Artifacts render live beside the chat. There is no hosted publishing.

**(d) Is theirs better?** They solve a different problem. Juno's snapshot sharing is the safer default for "show someone this". Sites cover "run this for people", which Juno does not do.

**(e) Principles to adopt.** If Juno adds publishing, it should work like this:
- **publishing is a distinct verb from sharing**;
- versions are explicit ("save a version, then publish");
- the audience is chosen before publishing;
- per-visitor data access is read-only and uses the visitor's own credentials;
- deletion takes deliberate friction.

**(f) What not to copy.**
- A hosting platform inside an assistant before the core is solid. Sites brings policy, abuse, payments and domain obligations with it; OpenAI's help page spends paragraphs on PHI, payments and takedowns.

### 2.10 Deep Research

**(a) What it is today.** ([Deep research in ChatGPT](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt), updated about 2026-09-21; release notes 2026-02-10.)
- **Starting points:** `/Deepresearch`, the `+` menu, or the sidebar.
- **Plan first.** "ChatGPT creates a proposed research plan… review and modify it before the research begins."
- **Sources.** Users can restrict research to named sites, or prioritise them while still searching the web. Connected apps are used through **read actions only**.
- **During the run:** follow progress and interrupt to change focus or sources.
- **The report** opens fullscreen with a table of contents, a "sources used" list and **activity history**, and exports to **Markdown, Word and PDF**.
- **Legacy deep research mode** was removed on 2026-03-26.

**(b) Problem solved.** A documented, checkable answer to a hard question.

**(c) What Juno has.**
- A plan-confirmation gate: "Drafted a plan and stopped, because the next step costs real money" (`src/lib/research/domain.ts:79-88`).
- An in-chat run panel (`src/components/chat/research-run-panel.tsx`).
- A report reader, source rail, evidence panel and citation audit (`src/components/research/*`, `src/components/chat/citation-audit-panel.tsx`).
- UNVERIFIED: I did not find domain restriction or prioritisation in `src/lib/research/plan-format.ts`, or Word export in `report-dialog.tsx`; line 87 mentions only print-to-PDF.

**(d) Is theirs better?** **No, roughly at parity.** Juno's citation audit is a real differentiator. OpenAI is ahead on source scoping (restrict or prioritise domains) and on export formats.

**(e) Principles to adopt.**
- Source scope belongs in the plan the user approves.
- Research uses read-only access to connected apps, by construction.
- The report carries its own activity history.

**(f) What not to copy.**
- A separate per-feature usage counter ("remaining tasks").

### 2.11 Tasks, automations and Pulse

**(a) What it is today.** ([Scheduled tasks](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt), updated 2026-09-29; [Scheduled tasks docs](https://learn.chatgpt.com/docs/automations), undated; release notes.)
- **Pulse is gone.** On 2026-06-17 Pulse was "sunset as proactive updates move into scheduled tasks". A **Scheduled** page lists every task and when it runs next. **Monitoring tasks "notify users only when there is something worth reporting."**
- **Event-triggered tasks (2026-08-25).** They respond to Gmail, Slack or GitHub events and show **Trigger, Condition and Prompt** for review. "Actions that require approval pause until you review them."
- **MCP events (2026-09-29)** extend triggers to plugins.
- **Two kinds of task.** A **standalone task** starts a new chat on each run. A **task inside a chat** returns to that chat with its context.
- **Unattended safety.** Tasks run "with your default sandbox settings. Start with the narrowest access".
- **The Scheduled view "acts as your inbox"** with an unread indicator.
- **Sharing a task** gives a snapshot of its instructions and schedule, never data, memory or credentials.
- **Team Tasks** (Business and Enterprise) run through a team service account.

**(b) Problem solved.** Recurring and event-driven work that should only interrupt the person when something changed.

**(c) What Juno has.**
- Trigger kinds: `once, hourly, daily, weekdays, weekly, monthly, yearly, cron, email_filter, calendar_window, topic_monitor, connector_event, folder_change, manual, api` (`src/lib/work/domain.ts:1259-1279`).
- Deduplication of triggers is treated as the core problem (`src/lib/work/triggers.ts:1-20`).
- Missed-run policies (`src/lib/work/domain.ts:1286`).
- Unattended runs never wait at a plan gate (`src/lib/work/plan-review.ts:25-30`).
- An Automations UI (`src/app/(app)/automations`).

**(d) Is theirs better?** **No. Juno's trigger model is broader** (calendar windows, folder changes, API, missed-run policy). OpenAI is better on two small UX ideas: "task inside a chat vs standalone", and **"notify only when something is worth reporting"** as the default for monitors.

**(e) Principles to adopt.**
- Every automation shows **Trigger, Condition and Prompt** as three plain fields.
- Monitors are quiet by default.
- The user chooses where results land: this chat, or a new one each time.
- Sharing an automation shares its recipe, not its data.

**(f) What not to copy.**
- A proactive feed like Pulse as a separate destination. OpenAI killed it after about 9 months.

### 2.12 Voice (Live, Advanced, Standard)

**(a) What it is today.**
- **GPT-Live-1 (2026-07-08)** is full-duplex and runs inside a chat with streamed text, web search, memory and widgets.
- **Plugins in Voice (2026-09-23).** Voice can use plugins. **Voice in Work** creates documents and uses the browser, and "When you end a Voice call in Work, an unfinished task can continue in text."
- **Desktop Voice** can "start tasks, check progress… coordinate multiple agents through one conversation" and switch between tasks by voice ("Let me talk to the task reviewing the tests").
- **"Spoken approval is not supported"**: approvals happen on screen.
- **Screen context** is an appshot of the front window (macOS).
- **Background conversations** can appear in Live Activities and the Dynamic Island (2026-08-31).
- **Limits** are per plan, in hours per rolling 24 hours ([ChatGPT Voice](https://help.openai.com/en/articles/20001274-chatgpt-voice), updated about 2026-09-25; [Voice docs](https://learn.chatgpt.com/docs/features/voice), undated).
- **Dots** can be called from their conversation.

**(b) Problem solved.** Steering work hands-free, not just chatting by voice.

**(c) What Juno has.**
- Dictation and realtime speech-to-speech in the composer.
- Voice persona in agent threads.
- Voice calls deliberately have **no tools**: "nothing gets started from it" (`src/lib/voice-persona.ts:16-18`).

**(d) Is theirs better?** **Yes.** Voice as a way to control delegated work (start, check, redirect) is the biggest gap. OpenAI's safety rule is the right one to copy: speak to steer, but approve on screen.

**(e) Principles to adopt.**
- Voice can **start, check and redirect** runs through the same approval path as text.
- **Approvals are never spoken.**
- Ending a call does not end the work.
- An agent call is the agent.

**(f) What not to copy.**
- Three voice engines exposed as a user-facing setting (Live, Advanced, Standard).
- Hour-based voice meters separate from the main plan meter.

### 2.13 Computer use, Operator, Agent mode and the cloud browser

**(a) What it is today.**
- **Operator** was folded into ChatGPT agent on 2025-07-17 ([agent release notes](https://help.openai.com/en/articles/11794368-chatgpt-agent-release-notes)).
- **Agent mode no longer exists.** "ChatGPT agent is no longer available. Use ChatGPT Work" ([ChatGPT agent](https://help.openai.com/en/articles/11752874-chatgpt-agent), updated about 2026-09-14).
- **It was removed without notice** in early August 2026. A community complaint was posted 2026-08-08, and OpenAI Support replied on 2026-09-07 pointing to Work's cloud browser ([thread](https://community.openai.com/t/agent-mode-was-removed-with-no-real-replacement/1389601)).
- **Atlas** was retired on 2026-08-09.
- **Today's replacements:**
  - **Cloud browser** in Work. Site access has three settings: Always ask, Auto approve (a reviewer checks the URL), Always allow. It is separate from confirmation of consequential actions. A private sign-in form is checked for phishing, and users can take over ([Using cloud browser](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt), August 2026).
  - **Desktop built-in browser** with annotation and **WebMCP site tools** (2026-08-31).
  - **Computer Use** as a plugin (macOS and Windows) with per-app "Allow / Always allow" and locked use ([Computer use](https://learn.chatgpt.com/docs/computer-use), undated).

**(b) Problem solved.** Doing things on sites and apps that have no API.

**(c) What Juno has.** A remote-browser and computer abstraction (`src/lib/computer/remote-browser.ts`, `live-view.ts`) that is not production-ready (see §2.6 and `src/lib/computer/provider.ts:17-28`).

**(d) Is theirs better?** Yes, in maturity. The design lesson is in the permission split:
1. **May I visit this site?**
2. **May I do this consequential thing?**
3. **Credentials never pass through the model.**

**(e) Principles to adopt.**
- Prefer a structured integration over pixels: "Prefer a connected app or plugin when it supports the task directly."
- Site access and action approval are separate questions.
- Takeover and return are explicit steps.

**(f) What not to copy.**
- Removing a capability without a deprecation path. Juno's agent computer should ship behind a flag until it is ready, not appear and then disappear.

### 2.14 Connectors (apps) and permissions

**(a) What it is today.** ([Managing app permissions](https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt), updated about 2026-09-18.)
- **Account-wide defaults:** *Always ask / Allow read actions / Allow low-risk actions / Allow all actions*. "Allow all" is only per-app or per-account, never a global default.
- **Approval card options:** Deny, Allow once, **Allow low-risk actions** (this action plus future low-risk ones on the same account), and Always allow (personal accounts only).
- **Multiple accounts per plugin** (2026-08-28, 2026-09-17).
- **A permission change is not a disconnect.**
- **Health defaults.** The Health plugin defaulted to "Allow low-risk" because "more than 70% of Health users already choose" it (2026-09-14). That is a notable default-setting-by-behaviour decision.

**(b) Problem solved.** Using real accounts without approving every read.

**(c) What Juno has.**
- Five risk classes (`read_only, reversible_write, external_write, destructive_or_sensitive, unknown`).
- Five policies (`always_ask … block`), with the default `ask_for_any_change`.
- A 15-minute approval TTL (`src/lib/action-approval.ts:22-45`).
- Decisions of `allow_once | allow_scope | deny`.
- SHA-256 digests bind the approved policy and arguments: "What exact bytes did that person approve?" (`src/lib/action-approval.ts:1-16, 351-380`).
- Connector annotations are "evidence, never authority" (`src/lib/action-approval.ts:12-16`).

**(d) Is theirs better?** **No. Juno's model is more rigorous.** It binds approvals to digests and treats annotations with scepticism. OpenAI's vocabulary is simpler, and its per-account setting (personal vs work Gmail) is a real need Juno should check.

**(e) Principles to adopt.**
- Keep Juno's integrity model, and present it with OpenAI-grade vocabulary: four plain defaults.
- "Allow this and similar low-risk ones" is a scoped standing grant.
- Permissions are per connected account.

**(f) What not to copy.**
- Setting a sensitive-data default from the fact that most users already relaxed it.

---

## 3. Interaction and visual patterns (principles, not pixels)

### Composer
- **Keep the controls around the composer small.** OpenAI's desktop places the mode (Chat or Work) above, the model and effort inside, and the permission mode just below. The goal progress row sits above when a goal is active. Everything that changes what happens on Send is next to Send. Juno should keep that proximity, without the mode toggle.
- **Use three sigils with fixed meanings:** `@` brings something in (a plugin, file, app, `@Browser`, `@Computer`, `@dot`), `$` picks a skill, `/` runs a command (`/goal`, `/plan`, `/memories`, `/pet`). Juno uses `@` for capability toggles and `/` for navigation (`src/components/chat/composer.tsx:1704-1760`). Separating "bring in" from "turn on" is worth doing.
- **Offer overrides that apply once and do not stick:** long-press Send for a one-message model, and paste-to-attachment with an undo.

### Inline tokens and mentions
- **A mention is a request to an actor.** "Mentioning ChatGPT or a dot asks that agent to act… A comment to another person leaves feedback for them. Check the recipient before sending" ([Space agents](https://learn.chatgpt.com/docs/space/agents)). If Juno lets agents live in documents, the mention target must be unambiguous.
- **Third parties can supply mention sources** (Figma files in the composer, through the Composer mentions extension). For Juno, connected apps should feed the `@` picker with their objects, not just their names.

### Approvals
- **Layered model:** the sandbox sets what is possible, the policy sets when to ask, a reviewer (auto-review) can answer instead of the person, and the person is asked last. Auto-review has a denial circuit breaker: 3 consecutive denials, or 10 in the last 50, and the turn stops ([Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)). A denied action cannot be retried "via workaround".
- **The answers offered should include a redirect:** Approve / Always approve / **Tell it what to do** / Deny ([Remote](https://learn.chatgpt.com/docs/remote)).
- **Keep categories separate:** site access, consequential action, credential entry and app-level Computer Use approvals are different prompts.
- **Keep a floor that no setting lowers.** OpenAI routes password changes and money transfers to the person. Juno's `ALWAYS_CONFIRM_ACTIONS` is the same idea (`src/lib/work/domain.ts:615-626`).
- **Approve on screen, never by voice.**

### Progress presentation
- **Sort attention by priority:** needs input, then blocked, then ready, then running (Pets, Activity view, the Scheduled inbox). Present it as a list sorted by that order with plain sentences. Do not use coloured state badges.
- **Show the goal as the acceptance criteria,** with pause, edit and clear controls in one place (Goal mode). Elapsed time is secondary.
- **Show deliverables as the result:** file previews beside the chat with pointable annotations. The file is the progress.
- **Scheduled works as an inbox.** Runs with findings appear there, and quiet runs do not.

### Agent presence
- **Identity:** a customisable face and a handle, the same across every channel, with a profile holding In progress, Scheduled, Completed, Computers and Custom rules. The face is identity, not a status light.
- **The computer view says who is in control.** "Alfred has control" plus **Take over**. Control is a stated fact, not an animation.
- **One agent, several contact methods, one memory,** with an explicit rule that private context is not disclosed across audiences.
- **Do not copy:** the floating pet with four status states, the cartoon accessories, or "Snake while images generate" (release notes 2026-09-08). These are ornamental or status-light patterns the owner rules forbid.

### An observation on Juno from this pass (outside scope, for the Phase 0 audit)
- `src/components/chat/work-run-panel.tsx:139` renders `WorkStatusPill`, a pill shape with a `StatusMark` and a status label (`src/components/work/work-vocabulary.tsx:244-266`), inside the chat's Work panel. That looks like the kind of status pill the owner rules prohibit. The audit should confirm.
- `src/components/agents/agent-presence.tsx:9-18` describes a halo that is "breathing while it works, a slow turning light while it thinks". This is borderline against "no decorative pulsing status dots" and worth a deliberate design decision.

---

## 4. Sources

Read 2026-09-30. "Updated" dates come from each help-center page's own stamp.

**openai.com**
1. Introducing dots. 2026-09-29. https://openai.com/index/introducing-dots/
2. DevDay 2026 Recap. 2026-09-29. https://openai.com/index/devday-2026-recap/
3. ChatGPT is now a partner for your most ambitious work (ChatGPT Work launch). 2026-07-09. https://openai.com/index/chatgpt-for-your-most-ambitious-work/

**help.openai.com**

4. ChatGPT Release Notes. Updated 2026-09-29; entries read from 2026-02-10 to 2026-09-29, plus earlier entries on Pulse, app directory and agent. https://help.openai.com/en/articles/6825453-chatgpt-release-notes
5. ChatGPT Work and Codex. Updated 2026-09-29. https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex
6. Getting started with your dot. Updated 2026-09-30. https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
7. Dots privacy, security, and safety FAQs. Updated 2026-09-30. https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs
8. Plugins in ChatGPT (and Codex). Updated 2026-09-29. https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex
9. Getting started with Space in ChatGPT. Updated 2026-09-30. https://help.openai.com/en/articles/20001549-getting-started-with-space-in-chatgpt
10. Creating and using ChatGPT Sites. Updated 2026-09-29. https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites
11. Using Codex Cloud. Updated 2026-09-30. https://help.openai.com/en/articles/20001545-using-codex-cloud
12. Deep research in ChatGPT. Updated about 2026-09-21. https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt
13. ChatGPT agent (now "no longer available"). Updated about 2026-09-14. https://help.openai.com/en/articles/11752874-chatgpt-agent
14. ChatGPT agent release notes (Operator integration, 2025-07-17). https://help.openai.com/en/articles/11794368-chatgpt-agent-release-notes
15. ChatGPT Workspace Agents for Enterprise and Business. Updated about 2026-09-25. https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business
16. Memory in ChatGPT. Updated about 2026-09-19. https://help.openai.com/en/articles/8590148-memory-in-chatgpt
17. Managing app permissions in ChatGPT. Updated about 2026-09-18. https://help.openai.com/en/articles/20001495-managing-app-permissions-in-chatgpt
18. ChatGPT Voice. Updated about 2026-09-25. https://help.openai.com/en/articles/20001274-chatgpt-voice
19. Scheduled tasks in ChatGPT. Updated 2026-09-29. https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
20. Using Library to manage files in ChatGPT. Updated about 2026-09-19. https://help.openai.com/en/articles/20001052-using-library-to-manage-files-in-chatgpt
21. Using cloud browser in ChatGPT. Updated August 2026. https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt

**learn.chatgpt.com (OpenAI's ChatGPT and Codex docs; developers.openai.com/codex redirects here; pages undated)**

22. Meet dots: https://learn.chatgpt.com/docs/dots
23. Dots, Controls: https://learn.chatgpt.com/docs/dots/controls
24. Dots, Tasks and memory: https://learn.chatgpt.com/docs/dots/tasks-and-memory
25. Dots, Computers and apps: https://learn.chatgpt.com/docs/dots/computers-and-apps
26. Get started with Work: https://learn.chatgpt.com/docs/get-started-with-work
27. Long-running work (Goal mode): https://learn.chatgpt.com/docs/long-running-work
28. Permissions (permission modes): https://learn.chatgpt.com/docs/permission-modes
29. Auto-review: https://learn.chatgpt.com/docs/sandboxing/auto-review
30. Agent approvals and security: https://learn.chatgpt.com/docs/agent-approvals-security
31. Notifications: https://learn.chatgpt.com/docs/notifications
32. Pets: https://learn.chatgpt.com/docs/pets
33. Scheduled tasks: https://learn.chatgpt.com/docs/automations
34. Model selection: https://learn.chatgpt.com/docs/model-selection
35. Memories (Codex local memories): https://learn.chatgpt.com/docs/customization/memories
36. Computer use: https://learn.chatgpt.com/docs/computer-use
37. Browser: https://learn.chatgpt.com/docs/browser
38. Voice: https://learn.chatgpt.com/docs/features/voice
39. Plugin architecture: https://learn.chatgpt.com/plugins/concepts/plugins
40. Plugin extensions: https://learn.chatgpt.com/plugins/build/extensions
41. Plugin UI guidelines: https://learn.chatgpt.com/plugins/concepts/ui-guidelines
42. Migrate custom GPTs to plugins: https://learn.chatgpt.com/docs/migrate-custom-gpts
43. Space, Work with agents: https://learn.chatgpt.com/docs/space/agents
44. Import from another agent: https://learn.chatgpt.com/docs/import
45. Codex CLI: https://learn.chatgpt.com/docs/codex/cli
46. Codex IDE extension: https://learn.chatgpt.com/docs/codex/ide
47. ChatGPT desktop app: https://learn.chatgpt.com/docs/app
48. ChatGPT on the web: https://learn.chatgpt.com/docs/web
49. Remote: https://learn.chatgpt.com/docs/remote
50. Codex Cloud: https://learn.chatgpt.com/docs/cloud
51. Cloud environments: https://learn.chatgpt.com/docs/environments/cloud-environments
52. Code review: https://learn.chatgpt.com/docs/code-review
53. Visualizations: https://learn.chatgpt.com/docs/visualizations
54. Work with files (artifacts viewer): https://learn.chatgpt.com/docs/artifacts-viewer

**Press and community (secondary, labelled where used)**

55. TechCrunch, "OpenAI launches Dots, its bubbly agentic avatar", Lucas Ropek. 2026-09-29. Press. Read through a summarising fetch, so the "bubbly, cartoonish persona" wording is that tool's paraphrase: UNVERIFIED verbatim. https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/
56. OpenAI Developer Community, "Work breaks assistant continuity…". 2026-09-05. User post, not official. https://community.openai.com/t/work-breaks-assistant-continuity-and-work-usage-limits-make-long-professional-sessions-impractical/1395071
57. OpenAI Developer Community, "Agent Mode was removed with no real replacement". 2026-08-08, with an OpenAI Support reply on 2026-09-07. User post plus official reply. https://community.openai.com/t/agent-mode-was-removed-with-no-real-replacement/1389601

**Not verified.**
- Third-party blog claims seen only in search snippets (e.g. usecarly.com, aiproductivitycoach.com on the removal of Agent mode) were not opened and are not relied on.
- OpenAI's "dots safety blog" and "system card" are referenced in source 1, but I did not open them.
