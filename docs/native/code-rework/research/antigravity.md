# Google Antigravity — competitor audit notes (as of 2026-09-22)

Scope: agent loop/runtime, settings, UI/UX, motion/visual design. Primary sources are antigravity.google (docs, blog, changelog), Google codelab, and the Google Developers Blog. Dates are given for every claim. "Unverified" means I could not confirm it in a primary source.

Local copies for the synthesis step, all in the scratchpad `ag/` folder:
- `ag/txt/*.txt`: text of every page in antigravity.google's sitemap, fetched 2026-09-22. The changelog is `ag/txt/changelog.txt`.
- `ag/wbmd/*.md` and `ag/wbmd2/*.md`: the original docs markdown for Nov 2025 and Mar 2026, taken from the Wayback Machine.
- `ag/small/*.png|jpg`: screenshots, downscaled.
- `ag/img1/cl_*.png`: screenshots from the original codelab (Nov 2025).

---

## 0. Product timeline (important context)

- **2025-11-18: Antigravity 1.11.2, the first launch.** This was a VS Code fork with two windows: the **Editor** and the **Agent Manager** ("Mission Control", labeled "Preview"). It also shipped the Chrome browser subagent, Artifacts and Knowledge. Models were Gemini 3 Pro, Claude Sonnet 4.5 and GPT-OSS.
  - Sources: https://antigravity.google/blog/introducing-google-antigravity (Nov 18, 2025); https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/ (Nov 20, 2025); changelog.
- **1.x releases in the IDE line** (https://antigravity.google/changelog, IDE tab):
  - 1.11.17, Dec 8 2025: "Secure mode" added.
  - 1.12.4, Dec 17 2025: Gemini 3 Flash.
  - 1.14.2, Jan 13 2026: Agent Skills, plus settings to turn off conversation history and knowledge.
  - 1.15.6, Jan 23 2026: macOS terminal sandbox.
  - 1.16.5, Feb 3 2026: "Secure Mode" renamed to "strict mode".
  - 1.18.3, Feb 19 2026: Gemini 3.1 Pro, a Models/quota settings screen, artifact download.
  - 1.20.5, Mar 9 2026: AGENTS.md read in addition to GEMINI.md; the Auto-continue setting deprecated (now always on).
  - 1.21.6, Mar 25 2026: Linux sandbox; "Simplified, condensed chat UI"; **Follow-along mode and Playground deprecated in the Manager**.
  - 1.22.2, Apr 7 2026: new unified Agent Permissions system.
- **2026-05-19: Antigravity 2.0 at Google I/O.** It is a standalone desktop app for agents with **no IDE**. It replaces the Agent Manager and introduced Projects (multi-folder), native git worktrees, dynamic subagents, async tasks, JSON hooks, Scheduled Tasks, live voice transcription, and the slash commands /goal, /grill-me, /schedule and /browser. The same launch added the **Antigravity CLI (`agy`)**, the **SDK** (Python) and an API. The IDE lives on as a separate "Antigravity IDE", and the Agent Manager is to be removed from it.
  - Sources: https://antigravity.google/blog/introducing-google-antigravity-2 ; https://antigravity.google/blog/google-io-2026-feature-deep-dive ; https://antigravity.google/blog/google-io-2026 ; TechCrunch https://techcrunch.com/2026/05/19/google-launches-antigravity-2-0-with-an-updated-desktop-app-and-cli-tool-at-io-2026/
- **2.x releases after launch** (changelog, "Antigravity 2.0" tab):
  - 2.1.4, Jun 11: /btw side questions, PDF attachments, quota screen redesign.
  - 2.2.1, Jun 25: built-in Antigravity Guide skill, Conversation Width setting.
  - 2.3.0, Jul 13: queued messages; default theme now follows the system instead of dark.
  - 2.4.3, Jul 28: preview tabs, quote selection with ⌘L, the "Agent" settings screen renamed "General".
  - 2.5.0, Jul 31: enterprise sign-in, per-model reasoning effort (Low/Medium/High), permissions remembered for the whole conversation.
  - 2.6.0, Aug 7.
  - 2.7.1, Aug 11: sidebar grouping options, side-by-side image diffs.
  - 2.9.1, Aug 20: **Remote Control**; toast stack moved to the bottom right.
  - 2.10.0, Aug 24: **embedded terminal and git VCS panel**, commenting on images.
  - 2.11.0, Aug 26: **Generative UI** (HTML artifacts inline, KaTeX, Chart.js, Plotly); terminal splits; Darcula theme.
  - 2.12.0, Sep 2: quoting; /boost.
  - 2.13.0, Sep 9: Documents section; Hide Whitespace Changes; minimizable side questions.
  - 2.14.0, Sep 15: command palette animations; Vesper theme update.
  - 2.15.0, Sep 18: custom agent controls; PgUp/PgDn/Home/End/Esc navigation.
  - 2.15.1, Sep 19: Windows sandbox.
- **Models, current as of Sep 2026** (https://antigravity.google/docs/models/): Gemini 3.8, 3.7 and 3.6 Flash; Gemini 3.1 Pro; Claude Sonnet 4.6 (Thinking) and Claude Opus 4.6 (Thinking); GPT-OSS 120B. Claude and GPT are not offered to Enterprise. Gemini 3.8 Flash is the default model ("powering all local agents", docs/home). The generative image tool uses Nano Banana 2.
- **Original model list, Nov 2025** (archived docs/models): Gemini 3 Pro (high) and (low), Claude Sonnet 4.5, Claude Sonnet 4.5 (thinking), GPT-OSS. Background models: Gemini 2.5 Pro UI Checkpoint for the browser subagent, Gemini 2.5 Flash for checkpointing and context summarization, Gemini 2.5 Flash Lite for semantic codebase search, and Nano Banana for images.
- **Plans** (https://antigravity.google/docs/plans/, current):
  - Baseline quota for everyone. Pro and Ultra refresh every 5 hours; the free tier refreshes weekly. Ultra adds third-party models.
  - A $100/month Ultra plan was announced at I/O 2026.
  - The "AI Credit Overages" setting is Never or Always.

---

## A. Agent loop & runtime

### A1. Tools (names as documented)

**Tool names the 2.0/CLI/IDE harness exposes to hooks**, from https://antigravity.google/docs/hooks/ (fetched 2026-09-22):
- **Files:**
  - `view_file` (AbsolutePath, StartLine/EndLine, IsSkillFile; 2.11 added PDF page ranges and MediaResolution)
  - `write_to_file` (TargetFile, Overwrite, CodeContent, Description, IsArtifact, ArtifactMetadata)
  - `replace_file_content` (single contiguous block: TargetContent → ReplacementContent, StartLine/EndLine, AllowMultiple, TargetLintErrorIds)
  - `multi_replace_file_content` (ReplacementChunks)
  - `list_dir`
  - `find_by_name` (glob)
- **Search/research:** `grep_search`, `search_web`, `read_url_content`. The CLI also has `code_search` and a `/codesearch` command using embedded ripgrep.
- **System:**
  - `run_command` (CommandLine, Cwd, **WaitMsBeforeAsync**, RunPersistent, RequestedTerminalID). A long-running command becomes async and moves to the background.
  - `manage_task` (list, kill, status, send_input on background tasks)
  - `schedule` (DurationSeconds, CronExpression, MaxIterations, Prompt)
  - `list_permissions`
  - `ask_permission` (Action, Target, Reason)
- **Agents:**
  - `invoke_subagent` (array of {Prompt, Role, TypeName, Workspace})
  - `define_subagent` (name, description, system_prompt, enable_mcp_tools, enable_write_tools, enable_subagent_tools)
  - `send_message` (Recipient, Message)
  - `manage_subagents` (list, kill, kill_all)
- **Interaction:** `ask_question` (multiple-choice questions, with is_multi_select), `generate_image`.
- **Browser:** tools matched by `browser_.*`. `click_browser_pixel` is visible in a 1.x screenshot, which also shows "Retrieved Browser Pages", "Read Browser Page in Browser" and "Opened URL in Antigravity Browser".

**SDK built-in tool enum**, from https://antigravity.google/docs/sdk/tools/: list_directory, search_directory, find_file, view_file, create_file, edit_file, run_command, ask_question, start_subagent, generate_image, search_web, read_url_content, finish. It also offers `BuiltinTools.read_only()` groups and custom Python function tools.

### A2. How edits are applied and reviewed

**Edits in 1.x and 2.0 (GUI)**
- Edits go straight to disk through file tools. Review happens afterwards in the **Review Changes** pane, not through a pre-apply approval per hunk.
- Each file edit renders as a step row like "Created color.ts +5 -0 … Open diff" or "Edited Card.tsx +6 -3 … Open diff". Seen in the task-group screenshot at https://antigravity.google/docs/tools/ (the Task Groups page).
- **Review Changes** (IDE): once the agent writes code, a button appears in the agent panel's bottom toolbar. It opens a scrollable pane with every diff in the conversation, and you can comment on any line of a diff like a doc (https://antigravity.google/docs/ide/review-changes-editor/). 1.x also had a Source Control tab (stage, unstage, commit) (archived docs/review-changes-manager, Nov 2025).
- **2.0 Review pane / VCS panel** (2.10.0, Aug 24 2026; blog https://antigravity.google/blog/vcs-and-terminal, Aug 24 2026):
  - A dropdown selects the view:
    - **Agent Edits**: "Files modified by the agent in this conversation".
    - **Uncommitted**: "Staged index changes and working tree changes".
    - **Branch**: "All changes since origin/main".
  - Other controls:
    - Per-file stage, unstage and discard.
    - A **Commit** split button that can auto-generate the commit message.
    - Push.
    - "View Split Diff" vs unified.
    - Collapse All.
    - Search in diffs, plus Hide Whitespace Changes (2.13).
  - A "For Turn" filter chip exists (VSC blog hero image).
  - The turn summary card in the chat reads "13 files changed +1430 −92 ›" with a **Review** button (layout image https://antigravity.google/assets/image/blog/agy2-layout.jpg).
- **Reverting / checkpoints:**
  - 1.x user message bubbles have a revert (↶) icon at the right, used to revert to that point. Visible in the codelab and doc screenshots.
  - The changelog mentions "reverting changes" (1.18.3, Feb 19 2026), "rewinding a long conversation" (2.9.1), "internal checkpoints" that git hooks could break (2.14.0), and "queued messages sending automatically after reverting a step" (2.5.0).
  - The CLI has `/rewind` (alias `/undo`) and `/fork` (alias `/branch`) (https://antigravity.google/docs/cli/best-practices/).
  - The exact GUI label for revert in 2.0 is unverified.

**Edits in the CLI**
- `default` mode (request-review) shows an inline diff before writing, with y/n/f (f opens a full diff) and Ctrl+G to open $EDITOR. Typing a new prompt rejects the edit and redirects.
- `accept-edits` auto-approves file writes.
- `plan` mode prepends /plan.
- Shift+Tab cycles through the modes.
- Source: https://antigravity.google/docs/cli/modes/

### A3. Terminal execution, sandbox, permissions

**1.x (Nov 2025)**, from archived https://antigravity.google/docs/agent-modes-settings and codelab https://codelabs.developers.google.com/getting-started-google-antigravity (archived 2025-11-24):
- **Terminal Command Auto Execution:**
  - **Off**: never auto-execute, except commands on the Allow list.
  - **Auto**: the agent decides.
  - **Turbo**: always auto-execute, except commands on the Deny list.
- Allow and Deny lists live in the Settings "Agent" tab. On Unix, an entry matches when its space-separated tokens are a prefix of the command's tokens; PowerShell matches any contiguous subsequence.
- A change only applies to new messages.
- **By Mar 2026 the options were reduced** to Request Review and Always Proceed (archived docs, 2026-03-10).
- The codelab screenshot of the policy footer shows "Ran background terminal command · Open Terminal ↗ · Exit code 1 … Auto ⌃". The current policy is shown as a dropdown on each step.

**Agent Non-Workspace File Access** (toggle):
- Default access is limited to the workspace plus the app data folder.
- The app data folder was `~/.antigravity/` in 1.x. It is now `~/.gemini/antigravity/` for 2.0, `~/.gemini/antigravity-ide/` for the IDE and `~/.gemini/antigravity-cli/` for the CLI. It holds Artifacts, Knowledge Items and the conversation "brain".

**Strict mode** (named "Secure mode" on Dec 8 2025, renamed Feb 3 2026; https://antigravity.google/docs/settings/ IDE tab):
- The browser URL allow/deny list applies to external markdown images and the Read URL tool.
- Terminal auto-exec is forced to Request Review and the allowlist is ignored.
- **Browser JavaScript execution** is forced to Request Review.
- Artifact review is forced to Request Review.
- The agent respects .gitignore and is isolated to the workspace.
- The sandbox is forced on with network denied.

**Sandbox:**
- macOS uses Seatbelt `sandbox-exec` (SBPL) and Linux uses kernel namespaces. The IDE docs mention nsjail for Linux.
- It needs no VMs.
- The IDE had two toggles, "Enable Terminal Sandbox" and "Sandbox Allow Network".
- 2.0 derives the sandbox from permissions:
  - Project folders are mounted read-write.
  - `read_file` grants become read-only mounts.
  - `write_file` grants become read-write mounts.
  - `read_url` domains form the network allowlist.
  - `~/.ssh` and `.env` are blocked.
- Sandboxed commands show a **shield badge** in the command header (2.13.0).
- Source: https://antigravity.google/docs/sandbox/

**2.0 unified permissions** (https://antigravity.google/docs/permissions/, fetched 2026-09-22):
- Three lists, Deny, Ask and Allow, evaluated with priority **Deny > Ask > Allow**.
- Actions:
  - `read_file(path|*)`
  - `write_file` (write implies read; denying read also denies write)
  - `read_url(domain)`, which covers the `read_url_content` tool, browser page loads and the sandbox network
  - `execute_url(domain)` for clicking and typing in the browser
  - `command(prefix | regex:… | *)`
  - `mcp(server/tool | server/* | *)`
  - `unsandboxed(...)` on Windows and the CLI
- Compound shell constructs such as `$(…)`, backticks, brace expansion and redirections need an exact match.
- **Presets** for macOS/Linux, set under Settings → General → Permission Settings, with a per-project override under Settings → Projects:
  - **Default**: sandbox on; commands run without prompts inside the sandbox and ask outside it; workspace and temp access; MCP and web ask.
  - **Request Review**: sandbox off; every command asks; workspace-only access.
  - **Turbo**: no sandbox; everything allowed; full filesystem.
- Projects default to "Inherit General". This was renamed "Inherit Global" on Sep 15 2026.
- **Windows presets:**
  - Default = Require Review + Always Ask.
  - Full machine = Require Review + Allow.
  - Turbo mode = Always Proceed + Allow.
  - Turning on "Enable Sandbox Mode (Preview)" switches the preset to "Custom".
  - Terminal Command Auto Execution offers Request Review, Proceed in Sandbox and Always Proceed.
  - Outside-of-folder file access offers Always Allow, Always Ask and Always Deny.
- **Prompt UX:**
  - "an interactive card appears". You can edit the target to widen the scope, for example from file to folder, but not for commands.
  - Grants can accumulate into project permissions.
  - Approvals are remembered for the conversation (2.5.0).
  - Denied steps stay visible with a "Rejected" label (2.13.0).
  - Steps that need input show the tool's icon (2.6.0).
- CLI prompt text: "Do you want to proceed? 1. Yes 2. Yes, and always allow in this conversation for commands that start with 'npm test' 3. Yes, and always allow … (Persist to settings.json) 4. No". The sandbox-bypass prompt reads "🔓 Allow sandbox bypass for command execution? ⚠️ Confirm the command is safe to run outside of the sandbox with full network and disk access." (docs/sandbox)

### A4. Review policy / artifact review

**1.x Artifact Review Policy:**
- **Always Proceed**: never asks.
- **Agent Decides**: the agent chooses.
- **Request Review**: always asks, and the agent "will always terminate after notifying".
- In chat, a "Proceeded with 📄 Implementation Plan" card with a green check appears, with subtext "Auto-proceeded by the agent under your review policy." or "Manually proceeded under your review policy." and a policy dropdown at the right ("Agent Decides ⌃", "Always Proceed ⌃", "Request Review ⌃"). Seen in doc screenshots.
- By Mar 2026 the options were only Request Review and Always Proceed (archived).
- In 2.0 the policy is still in the Settings "Agent"/General tab (https://antigravity.google/docs/artifact-review/).
- CLI `artifactReviewPolicy`: asks-for-review, agent-decides, always-proceed.

**Browser JavaScript Execution Policy:**
- Strict mode forces "Request Review" (primary source).
- The full option list, Always Proceed / Request Review / Disabled, comes only from a secondary source (https://petronellatech.com/blog/google-antigravity-ide-setup-guide-2026/) and is **partially unverified**.

**Onboarding presets (1.x)**
- Screen title: "How do you want to use the Antigravity Agent?"
- Options:
  - **Agent-driven development**
  - **Agent-assisted development**, with a RECOMMENDED badge
  - **Review-driven development**
  - **Custom configuration**
- A right-hand panel shows the resulting "Terminal execution policy" (e.g. Auto) and "Review policy" (e.g. Agent Decides) dropdowns, a checkbox "Use the default allowlist for the browser", and a caption such as "The agent will occasionally request for review."
- Source: codelab screenshot cf89c9d16394914c.png (archived Nov 24 2025).
- The exact mapping of each preset to policies is **unverified** beyond the Agent-assisted case (Auto + Agent Decides).

### A5. Planning mode vs Fast mode; task lists and plans

**Planning vs Fast (1.x):** picked from a dropdown in the composer.
- **Planning** "organizes its work in task groups, produces Artifacts … thoroughly research[es]".
- **Fast** "execute[s] tasks directly" for small tasks.
- The dropdown sits next to the model picker, as in "⌄ Planning ⌄ Gemini 3 Pro (High)".
- The 2.0 docs page artifact-review still describes Planning/Fast, but the 2.0 composer screenshots show only "+" and a model picker. In 2.0, planning is invoked with **`/plan`** (and `/grill-me`), and Flash models carry a "Fast" badge in the model menu. The Planning/Fast toggle **appears removed in 2.0 (inferred; unverified)**.

**Task Groups** (planning mode; https://antigravity.google/docs/tools/). Each group is a card with:
- A title (e.g. "Implementing Card Color Randomization").
- A one-line summary.
- "Files Edited" pills with file-type icons.
- "Progress Updates", a numbered list of subtasks with "Expand all / Collapse all". Details are hidden by default and toggle open to show steps.
- A special footer section for **pending steps**, e.g. "🔔 1 Step Requires Input" with the command shown and "Run command?" [Reject] [Accept].

**Task List artifact** (task.md):
- A live markdown checklist grouped by phase (Planning / Implementation / Verification) with nested items.
- States: done (checked, dimmed), in progress (filled blue dot), todo (empty box). "typically you do not need to directly interact with this artifact."

**Implementation Plan artifact:**
- Sections include "User Review Required" with purple "IMPORTANT" callouts, "Proposed Changes" grouped by component with "[NEW] server.js" / [MODIFY] file headers, and "Open Questions".
- The plan has "Proceed" buttons both in the conversation card and in the artifact header.
- Comments can be added. A "Review" toggle opens a "Submit comments" panel with a message box, a Submit button and "Review N comments" listing the quoted text and your comment.
- Source: https://antigravity.google/docs/implementation-plan/

**Walkthrough artifact:** a summary at completion, which for browser tasks includes screenshots and recordings (https://antigravity.google/docs/walkthrough/).

### A6. Subagents, background agents, parallelism

**1.x:**
- Only the browser subagent existed.
- Parallelism came from multiple conversations across workspaces, managed in the Agent Manager.
- There were no worktrees; the Nov 2025 FAQ answers "Does Google Antigravity currently support worktrees? Not at the moment."
- The agent kept the computer awake while running.

**2.0 subagents** (https://antigravity.google/docs/subagents/):
- Spawned with `invoke_subagent`. Workspace modes:
  - `inherit`
  - `branch` (a new git worktree)
  - `share`
- Subagents start with a clean context.
- Built-in types:
  - `research`
  - `browser` (only through /browser)
  - `self` (a clone)
- Custom agents are `.md` files with YAML frontmatter in `.agents/agents/` or `~/.gemini/config/agents/`. Fields:
  - name, description, tools
  - mainAgent, subagent
  - model (inherit, flash or pro)
  - commandExecutionPolicy (off, auto, eager or sandbox)
  - mcpServers, skills/plugins
  - rules (2.11)
  - inheritCustomizations (2.9.1)
  - a switch to turn off the default prompts and tools (2.15.0)
- States:
  - Running, stoppable with "Stop Subagent".
  - Idle, which wakes on a message.
  - Killed, which also cleans up its worktrees.
- Nesting depth is capped at 10.
- Agents message each other by ID.
- Permission requests bubble up to the main UI.
- An Overview pane shows nested subagents (2.1.4).
- In 2.0 each subagent renders as a card with a spinner, a title like "Database and Config Researcher" and the subtitle "Invoked research subagent". Clicking the card opens its conversation (https://antigravity.google/assets/image/product/subagents.png).
- Custom agents are selectable as the main agent from a dropdown in the composer (blog https://antigravity.google/blog/introducing-custom-agents, Aug 12 2026).

**Async tasks:**
- Long commands move to the background (`WaitMsBeforeAsync`, `manage_task`), and a "Running Items panel" lists them (2.2.1).
- Subagents can also run as background tasks (I/O deep dive, May 19 2026).

**Multi-agent commands:**
- **`/boost`**: Orchestrator → DeepCoder/DeepInvestigator → workers; paid; 2.12.0, Sep 2 2026.
- **`/teamwork-preview`**: multi-day agent teams led by a "Sentinel" scoping interview; paid.

**Worktrees:**
- The composer's environment selector offers "Local" or "New Worktree", plus a branch picker ("main ⌄") (https://antigravity.google/assets/image/blog/new-worktree.png).
- The app provisions the worktree in the background, and the sidebar can show worktree names.

### A7. Context, rules, workflows, skills, memory

**Rules:**
- Markdown files, limited to 12,000 characters each.
- Global rules live in `~/.gemini/GEMINI.md`; workspace rules in `.agents/rules/`, with `.agent/rules` still supported.
- AGENTS.md is also read (1.20.5, Mar 9 2026).
- Activation modes: **Manual** (@mention), **Always On**, **Model Decision** (from a description) and **Glob**.
- Rule files can include other files with `@file`.
- In the IDE they are managed from "…" → Customizations → Rules, with "+ Global" and "+ Workspace" buttons.
- Source: https://antigravity.google/docs/rules-workflows/

**Workflows:**
- Stored in `.agents/workflows/*.md` and `~/.gemini/config/workflows/`, invoked as `/workflow-name`, and able to call other workflows.
- The agent can generate workflows from the conversation history.
- **Deprecated in favor of Skills; retired Nov 1 2026.** `/migrate-workflows` converts them.
- Source: https://antigravity.google/docs/migration/workflows-to-skills/

**Skills:**
- The open Agent Skills standard (`SKILL.md` plus scripts/, references/, examples/), adopted Jan 13 2026 (1.14.2).
- Loaded with progressive disclosure: only name and description until the skill is needed.
- Each skill becomes a slash command `/<skill-name>`.
- Paths: `.agents/skills/` and `~/.gemini/config/skills/`.

**Plugins:** a `plugin.json` bundling skills, agents, rules, mcp_config.json and hooks.json (https://antigravity.google/docs/plugins/).

**Hooks** (`hooks.json`; https://antigravity.google/docs/hooks/):
- Events: PreToolUse, PostToolUse, PreInvocation, PostInvocation, Stop.
- Hooks receive JSON on stdin and return JSON on stdout.
- PreToolUse returns a decision: allow, deny, ask, force_ask or deny_unless_prior_grant.
- Hooks can inject steps, and a Stop hook can force the agent to continue.

**Sidecars:** managed background processes (`sidecar.json`, a `schedule` builtin, and the `agentapi new-conversation/send-message` CLI) (https://antigravity.google/docs/sidecars/).

**Knowledge Items (1.x memory):**
- "persistent memory system that automatically captures and organizes important insights" from conversations.
- Each item has a title, a summary and a set of artifacts.
- Summaries of all items are available to the agent, which "study[s]" the relevant ones.
- Viewable from the "Knowledge" entry at the bottom left of the Agent Manager.
- 1.14.2 added settings to turn off conversation history and knowledge.
- Source: archived https://antigravity.google/docs/knowledge (Nov 2025).
- In 2.0 the Knowledge UI is **not documented**; its status is unverified. `/learn` instead distills session corrections into Rules or Skills (https://antigravity.google/docs/slash-commands/).

**Context:**
- The model choice sticks for the rest of a turn.
- 1.x used Gemini 2.5 Flash for checkpointing and context summarization.
- The CLI has a `/context` view (changelog).
- Transient errors are retried with backoff for about 12 minutes (2.14.0).

### A8. Feedback while the agent runs; interrupt; queue

- Comments on artifacts "will be automatically incorporated into the agent's execution without requiring you to stop the agent's process" (launch blog, Nov 18 2025).
- **Queued messages** (2.3.0, Jul 13 2026): a card above the input with Send now, Edit and Delete, and a setting for how queued messages execute.
- **/btw side questions** (2.1.4): an ephemeral agent that shares the conversation's context. It can be minimized to a composer button with a count (2.13.0) and has back/forward history (2.12.0).
- **Stop:**
  - The Stop button appears per running subagent on hover (2.6.0).
  - Stopping a subagent stops everything it spawned.
  - Retry on an error card resumes the task without adding a "Continue" message (2.9.1).
  - Interactive question prompts have Cancel (Ctrl+C on macOS).
  - The CLI uses Esc.
- **Quote:** select text in a response, then ⌘L or ⌘I to quote it into the chat (2.12.0 / 2.13.0).
- **/goal** runs without pausing for input.

### A9. MCP

- **1.x:** an "MCP Store" reached from "…" at the top of the agent panel. Install servers from the store, or use "Manage MCP Servers" → "View raw config" to edit `mcp_config.json`. The Nov 2025 list included Airweave, Atlassian, Figma, GitHub, Linear, MongoDB, Neon, Netlify, Notion, Prisma, Redis, Stripe, Supabase and others.
- **2.0:** Settings → Customizations → **Installed MCP Servers**, with "Add MCP" (a searchable store), "Add", a trash icon, an enable toggle and refresh.
- **OAuth:** an Authenticate button opens the browser; you then paste a code. Tokens are stored in `~/.gemini/antigravity/mcp_oauth_tokens.json`.
- **Config fields:** command/args/env/cwd or serverUrl/headers, authProviderType "google_credentials", oauth, disabled, disabledTools.
- MCP tool steps render with structured headers, expandable arguments and result previews (2.10.0).
- Source: https://antigravity.google/docs/mcp/

### A10. Browser subagent

**1.x:**
- A separate model, Gemini 2.5 Pro UI Checkpoint (Gemini 3 Flash from Dec 17 2025), drives a separate Chrome profile through the "Antigravity Browser Extension" (Chrome Web Store).
- Its tools click, scroll, type, read console logs, capture DOM/screenshot/markdown and record video.
- While the agent is in control, the page gets a **blue border overlay** and a small panel describing actions, and user input to that page is blocked. The agent can act on unfocused tabs.
- **Setup prompt:** a "Preview" chip, "Antigravity would like to use the browser." with [Setup] and [Deny].
- **URL permission:** "Agent needs permission to act on www.google.com", with Configure, Deny and a split button [Always Allow ⌃].
- The browser step card is headed "Preview · <task>" with [Expand]. It shows a "Goal" block and step rows, and ends with "● Playback available [View]".
- The **Browser Subagent View** is a side panel that streams steps. Click actions include a button that shows the screenshot at that moment, with a red dot marking the click.
- Recording artifacts loop the actions.
- The denylist uses Google's server-side BadUrlsChecker and fails closed. The allowlist is a local file, initially containing only localhost.
- Sources: archived docs/browser-subagent, docs/chrome-extension, docs/browser-subagent-view; https://antigravity.google/docs/ide/allowlist-denylist/

**2.0:**
- The browser is used only through `/browser`, because "agents were still not capable enough to determine exactly when to be using the browser".
- It integrates Chrome DevTools MCP and records webm video (https://antigravity.google/docs/features/).

### A11. Conversations, resume, remote

**Resume and sharing:**
- 2.0 has Conversation History (grouping, sort and filter, "Only Unread", "Last Prompt" sort), pin, archive, rename, Share and Move to Group.
- ⌘K opens a conversation picker.
- The CLI offers `agy --conversation=<id>` and `/fork <project_id>`.

**Remote Control** (2.9.1, Aug 20 2026; https://antigravity.google/docs/remote-control/):
- Turn it on with Settings → App → Enable Remote Control, plus an optional Nickname.
- Any browser can then drive the local sessions, including approvals and plan review, and receives push notifications. It can be installed as a PWA on mobile.

**Scheduled Tasks:**
- The "New Scheduled Task" modal has Name (with an auto ID), Project, Schedule ("Daily" around "9:00 AM"), Prompt, the note "All tasks run as Flash.", and Cancel / Add Scheduled Task.
- Runs appear in the sidebar under a scheduled-tasks filter.

---

## B. Settings (every setting found, grouped as Antigravity groups them)

### B1. Antigravity 2.0 desktop (current, Sep 2026)

Source: https://antigravity.google/docs/settings/ plus the changelog.

**Opening Settings:** ⌘, ; "Settings" at the bottom left of the sidebar; or the gear next to a project. Settings opens the active project's settings when a project is open or has overrides.

Settings is a modal dialog that can also open in its own tab (2.14.0).

**General** (called "Agent" until Jul 28 2026):
- **Permission Settings** preset: Default, Request Review or Turbo on macOS/Linux.
- **Global Permissions**: allow, ask and deny rule lists.
- Artifact Review Policy: Request Review (recommended) or Always Proceed (docs/artifact-review).
- Windows only:
  - Agent Settings
  - Security Preset: Default, Full machine, Turbo mode or Custom
  - Terminal Command Auto Execution: Request/Require Review, Proceed in Sandbox or Always Proceed
  - Outside-of-folder file access: Always Allow, Always Ask or Always Deny
  - Enable Sandbox Mode (Preview)
- Queued-message execution behavior (2.3.0; exact label unverified).
- Terminal section (label seen in 2.8.0).
- "Shows which projects override a setting" with jump links (2.12.0).

**Projects** (per project):
- Folders (Add Folder; Local vs Worktree target).
- Permission preset override, defaulting to Inherit Global (formerly "Inherit General" / "Use Global").
- Sandbox Mode: Inherit General, Enabled or Disabled.
- Project-level permissions, which accumulate from grants.
- Customizations view (skills per folder).
- Delete Project (2.7.1).

**Customizations:**
- Installed MCP Servers (Add MCP, toggle, trash, refresh, Authenticate).
- Skills
- Rules (+ Global / + Workspace)
- Plugins (bundled Google plugins: Install)
- Custom agents
- Hooks (view and toggle)
- Sections are collapsible and show counts (2.9.1).

**Models:** quota "used vs remaining" per model group (Gemini vs Claude/GPT: Weekly and Five Hour limits); "AI Credit Overages" Never or Always (docs/plans).

**Appearance:**
- Theme: follows the system by default (2.3.0). Named presets include Vesper (dark) and Darcula (2.11.0). Custom color themes accept hex values. The full list of 2.0 themes is unverified.
- Conversation Width: Default, Narrow or Wide (2.2.1).
- "Panel layouts".

**Browser integration:** "configure how the agent interacts with web surfaces". Individual fields are unverified for 2.0.

**App:** Enable Remote Control, Nickname (host name).

**Account:** sign-in and license, "Manage", **Enable Telemetry**.

**Shortcuts:** view and customize keyboard shortcuts.

**Feedback:** feedback form, with diagnostics attachable.

**Standalone conversations** have their own terminal execution, file access and permissions settings.

### B2. Antigravity IDE / 1.x (Nov 2025 to Apr 2026)

Settings tabs: "Agent, Browser, Editor, and more", reached through ⌘, the Agent Manager gear, or Settings > Open Antigravity User Settings (archived docs/settings).

**Agent:**
- Artifact Review Policy
- Terminal Command Auto Execution + Allow list + Deny list
- Agent Non-Workspace File Access
- Strict Mode (formerly Secure Mode)
- Enable Terminal Sandbox; Sandbox Allow Network
- Auto-continue (deprecated Mar 9 2026)
- "Agent Auto-Fix Lints" and "Enable Agent Web Tools" (secondary sources only, unverified: https://www.aifire.co/p/google-antigravity-review-a-beginner-s-guide-to-the-ai-ide, Nov 28 2025)
- Turn off conversation history / knowledge (Jan 13 2026)
- Terminal integration on/off (Feb 19 2026)

**Browser:**
- Browser Tools on/off
- Chrome binary path
- Browser profile location
- Allowlist file (editable), with "Use the default allowlist for the browser" at onboarding
- JavaScript Execution Policy (Request Review confirmed; other options unverified)

**Tab** (editor completion): toggles for Autocomplete, Tab-to-Jump, Supercomplete and Tab-to-Import; Tab Speed (Slow, Default or Fast); Highlight Inserted Text; Clipboard Context; Allow Gitignored Files (https://antigravity.google/docs/ide/tab/).

**Models:** quota screen (Feb 19 2026).

**Account:** Enable Telemetry.

**Editor:** standard VS Code settings; extensions from Open VSX.

### B3. CLI (settings.json and /config)

- toolPermission: request-review, proceed-in-sandbox, strict or always-proceed
- artifactReviewPolicy
- enableTerminalSandbox
- allowNonWorkspaceAccess
- altScreenMode
- colorScheme
- runningLightSpeed
- verbosity
- editor
- editorMode (vim)
- notifications
- useG1Credits
- enableTelemetry
- showTips
- showFeedbackSurvey
- agentMode
- keybindings.json

---

## C. UI/UX

### C1. 1.x: Editor and Agent Manager (two windows)

**Onboarding** (codelab, Nov 2025): a 7-dot pager with Back and Next (Next has a ↵ glyph). Screens in order:
1. "Welcome to Antigravity / Let's get you set up."
2. Choose setup flow: import from VS Code or Cursor, or start fresh.
3. Editor theme.
4. "How do you want to use the Antigravity Agent?" (the 4 presets).
5. Configure your Editor.
6. Sign in to Google, which creates a new Chrome profile.
7. Terms of Use / telemetry opt-in.

After onboarding, the user picks a workspace in the Agent Manager.

**Agent Manager** (screenshots: codelab 22f6dcf7…, and https://antigravity.google/assets/image/docs/agent-manager-open-editor.png):
- **Left sidebar:**
  - "Agent Manager [Preview]" title
  - **Inbox** (with badge count and a sidebar-collapse icon)
  - **+ Start conversation**
  - **Workspaces / Folders**: expandable per folder, with ⋮ (Hide Editor / Focus Editor / Close Folder) and +; "+ Open Workspace"
  - **Playground** (ⓘ, +)
  - Bottom group: **Knowledge**, **Browser**, **Settings**, **Provide Feedback**
- Title bar: "Open Editor" and a gear at the top right.
- **Empty state:** "Start new conversation in ⌄ demo" with "View Inbox" at the right. Composer placeholder "Ask anything, @ for context", with "+", "⌄ Planning", "⌄ Gemini 3 Pro (High)" and a round send-arrow button. Below it, "<> Open editor" and "Use Playground".
- **Inbox:** title "Inbox", a "Pending" toggle, "+ Start conversation", and a search field "Search for conversations (⌘K)". Rows show title, relative time ("6 mins ago"), workspace name and status ("Idle") at the right. The inbox surfaces conversations awaiting approvals.
- **Conversation view:**
  - The header shows a breadcrumb "workspace / Conversation title" (with a spinner while running). Header icons: + (new pane), folder, Chrome, terminal, <> (open editor), 👁 ("Following" follow-along toggle), [Review Changes], and a side-panel toggle.
  - A collapsed icon rail on the left.
  - The user message is a rounded dark-gray bubble with a revert ↶ icon.
  - Agent steps: "› Thought for 13s" (collapsible) and task-group cards. Assistant prose ends with an artifact card (📄 Walkthrough [Open], description) and "Good 👍 / Bad 👎" feedback.
- **Panes:** files, artifacts and knowledge open in per-conversation panes that are resizable, splittable and drag-and-drop. ⌘P is the quick picker; ⌘-click opens in a new pane (archived docs/panes).
- **Changes Sidebar** (right): "Artifacts ⓘ" (Implementation Plan, Task, Walkthrough) and "Files Changed" (name plus dimmed path, with a blue dot for unseen changes).
- **Terminal:** ⌘J opens a bottom pane.
- Files can be commented on.

**Editor window** (https://antigravity.google/docs/ide/agent-side-panel/ images):
- A VS Code layout with the Agent side panel on the right. The panel header shows the conversation title plus +, history ⟲, … (Customizations, MCP Servers) and ×.
- Artifacts open as editor tabs (Task, Implementation Plan, Walkthrough, Review Changes).
- A bottom toolbar above the input tracks file changes, terminals and artifacts, and holds the "Review Changes" button.
- Composer placeholder "Ask anything (⌘L), @ to mention, / for workflows", with "+", "^ Planning", "^ Gemini 3 Pro Preview" and a send button.
- Title bar: "Open Agent Manager".
- Also: Command (⌘I inline), Tab / Supercomplete / Tab-to-Jump / Tab-to-Import.

**Shortcuts (1.x):**
- **⌘E** toggles Editor ↔ Manager
- ⌘L focuses the agent input
- ⌘I inline Command
- ⌘P quick picker
- ⌘J terminal pane (Manager)
- ⌘K conversation search
- ⌘, Settings

### C2. 2.0 desktop (single window, three columns)

Screenshots: https://antigravity.google/assets/image/docs/AGY2.0-Home.png ; https://antigravity.google/assets/image/blog/agy2-layout.jpg ; standalone-convo.png ; new-worktree.png ; subagents.png ; artifacts.png.

**Title bar:** traffic lights, a sidebar toggle, ← → navigation. No other chrome.

**Left sidebar:**
- "+ New Conversation" (a highlighted row)
- "Conversation History"
- "Scheduled Tasks"
- **Projects** header with filter/display-options and new-project icons. Each project is a folder row with nested conversations showing relative time ("now", "3d").
- **Conversations** section for standalone chats
- Pinned section
- Settings (gear) at the bottom
- Display options: group by project, status or recency; sort by Last Prompt / worktree; subtitle with folder and branch icons; show worktree names; up to 30 ungrouped conversations; a pending-step badge on rows; hover actions (pin, archive).

**Empty/home state:**
- A centered composer with a **project picker above** it ("📁 Project One ⌄", "No Project" when standalone, or "New Conversation ⌄").
- The input "Ask anything, @ to mention, / for actions".
- A row with **+** (attach/add context), the **model picker** ("Gemini 3.5 Flash ⌄") and a round **mic** button at the right.
- Beneath, an attached tray holds the environment selector "💻 Local ⌄" / "New Worktree ⌄" and a branch picker ("main ⌄").
- The first-run flow sends a prompt, then chooses Local or New Worktree Mode in "the setup modal" (docs/getting-started).

**Center conversation:**
- A breadcrumb "project / Conversation title".
- Steps are grouped and collapsible: "Explored 2 folders ›", "Exploring 2 files ⌄" with rows such as "Analyzed README.md #L1-178", subagent cards with spinners, and a faded "Working…".
- Code blocks have a language header ("bash") with @ (mention/quote) and copy icons.
- Artifact cards: 📖 Walkthrough plus a description.
- The turn footer shows "N files changed +x −y ›" [Review], then copy / 👍 / 👎.
- The composer is pinned at the bottom.
- Messages fade at the bottom edge (2.15.0).
- A scroll-to-bottom button; ⌘F find in conversation.
- Generative UI HTML widgets render inline (2.11.0). Mermaid diagrams, LaTeX and YAML frontmatter cards also render.

**Right side pane (auxiliary pane):**
- Tabs such as **Overview · Review · Walkthrough · Implementation Plan · Task**, and file tabs.
- Preview tabs are temporary until double-clicked (2.4.3).
- The pane's toolbar has icons for overview/document, folder (files), review (diff) and terminal, plus a split button.
- The artifact view header reads "Artifact", with ⋮ and an outline icon (a heading outline).
- The pane's width is remembered, and it can be maximized.
- Sections: **Documents** (external Drive links, PDFs, Office docs; 2.13.0) above **Artifacts**, and a collapsible **Scratch Files** section.
- Terminals live here (Ctrl/⌘`), with splits (⌘\).
- VCS Review (see A2).
- The file viewer has breadcrumbs, "Reveal in Finder", and a virtualized code/data viewer with line numbers.

**Commenting:**
- Select text in any artifact, file or diff, then use the comment button or the popover (text box, [Cancel] [Add Comment]).
- Drag-select a region of an image to comment on it (2.10.0).
- Comment count pills show a hover preview.
- Pending comments appear as attachment badges in the composer and are sent with the next message. Unsent drafts persist.
- Voice dictation also works in comments.

**Approvals:**
- An interactive card inline in the conversation describes the specific action, with the tool icon and an editable scope. The sidebar row shows a pending badge.
- Notifications use a chime for action-required and a softer completion sound (2.13.0). Toasts appear at the bottom right and stack.
- Remote Control sends push notifications.
- The Retry card resumes the task.

**Model picker:**
- A menu (about 250px in the docs mock) with rows "Gemini 3.8 Flash Medium [Fast]" and a flyout for Low/Medium/High. Gemini 3.1 Pro offers Low/High. Claude and GPT rows follow.
- A "View Usage" row opens a flyout with "Weekly Limit Remaining" and "Five Hour Limit Remaining" as percentages with ring gauges, for Gemini models and for "Claude and GPT models".
- Source: the docs mock at https://antigravity.google/docs/models/

**@ menu:**
- Categories filter as you type. File search is typo-tolerant. Folders, files and rules are selectable.
- Mentions render as pills with tooltips showing the full path.

**/ menu:** built-in commands with icons (/goal, /grill-me, /plan, /schedule, /browser, /btw, /boost, /teamwork-preview, /learn, /migrate-workflows), plus skills.

**Voice:** the mic button or Ctrl+M transcribes live with smart cleanup. You can send while still dictating (2.12.0).

**Command palette:** opens over a dimmed backdrop with enter and exit animations (2.14.0). Pin, rename and archive a conversation; Collapse/Expand All Folders; Download Diagnostics.

**2.0 keyboard shortcuts:**
- ⌘K conversation picker
- ⌘P file search
- ⌘L focus input / quote selection
- ⌘I add selection to chat
- ⌘N new conversation (on the home screen it toggles between the last project and standalone)
- ⌥↑/↓ previous/next conversation
- ⌘, settings
- ⌘` terminal
- ⌘\ split terminal
- Ctrl+M dictation
- ⌘F find
- PgUp/PgDn/Home/End scroll the conversation
- Esc leaves the prompt box
- Double-clicking a single-select option submits it

**IDE hand-off:** an "Open IDE" / "Install IDE" button (2.0.6, May 22 2026).

---

## D. Motion & visual design

**Brand:**
- Logo: an arched rainbow-gradient "A" (Google 4-color gradient).
- 2.0 app icon: the logo on a white/light-gray squircle. The IDE icon is the logo on a black grid.
- Marketing uses a particle field of blue dashes (auth pages) and soft rainbow-edge gradient glows around UI crops (product images).

**Palette:**
- 2.0 light: a very light neutral gray canvas (about #ECECEC, estimated from the screenshot), a slightly lighter composer, and mid-gray secondary text. The sidebar is the same gray with subtle separation.
- 2.0 dark: near-black (about #111–#1b1b1b) surfaces with slightly lighter cards.
- Accent is Google blue: primary buttons #1a73e8-ish in light mode and #8ab4f8 selected text in dark mode (docs mock CSS). Blue filled buttons are used for Proceed, Accept, Always Allow, Add Comment, Submit, Commit and Add Scheduled Task. Secondary buttons are gray fills (Open, Expand, Cancel).
- Plan callouts use a **purple** left rule with an "IMPORTANT" label. Diff +/− counts are green and red. The done check is green.
- A 2026 refinement (2.15.0) removed "heavy blue fill" on selected rows.

**Typography:**
- The docs mock uses Google Sans Text / Google Sans (the docs site uses Google Sans Flex and Google Symbols icons).
- App screenshots look like the Google Sans family at about 13–14px UI text with medium-weight headers. This is inferred; the app font is **unverified**.
- Monospace appears in code blocks and in the scheduled-time field.
- Bold weight was lightened in 2.15.0.

**Density:**
- 2.0 is sparse, "less is more". It has hardly any chrome: no activity bar, no status bar, borderless panes and thin 1px dividers.
- Cards are rounded at about 8–12px.
- Menus use 6px row radius and 8px menu radius with soft shadows (docs mock).
- Chat input density was aligned to the surrounding UI (2.2.1).
- Hit targets were enlarged for touch/stylus users (2.2.1), related to Remote Control on mobile.

**Motion:**
- Flyouts fade in and slide 4px over 120ms ease-out (docs mock CSS).
- The command palette has a dimmed backdrop with enter/exit animation, and dialogs share it.
- The conversation fades out at the bottom.
- Sidebar and side panels open and collapse smoothly (2.9.1).
- Toasts stack and expand on hover. The default duration is 8s (2.13.0); 2.4.3 notes had it at 5s.
- Spinners on running items; "Working…" in dimmed text.
- The browser agent shows a blue glow border and a blue dot cursor in recordings.
- The CLI has a "running light" progress animation with speed fast, medium, slow or off.

**Dark mode:** 1.x defaulted to dark. 2.0 follows the system from 2.3.0 (Jul 13 2026). Theme presets include Vesper (lilac and pink accents) and Darcula.

**User reception:**
- Forum thread "Antigravity 2.0 UI" (May 22 2026): quota and usage are "buried so deep in submenus", and people miss the extension ecosystem (https://discuss.ai.google.dev/t/antigravity-2-0-ui/147183).
- Positive: "cleaner look … less is more" (https://danicat.dev/posts/the-hitchhikers-guide-to-antigravity-2-0/, May 21 2026).
- In 2.0 you cannot edit files directly; all changes go through prompts or annotations (same source).

---

## E. Takeaways for a native macOS SwiftUI agent app (my synthesis)

- **Layout:** three columns (sidebar with Projects and conversations, conversation, and a tabbed auxiliary pane for artifacts, review, terminal and files). The empty state is a centered composer with the project picker above it and an environment/worktree tray below it.
- **Grouping steps:** group tool calls into collapsible summaries ("Explored 2 folders", task groups with Files Edited and Progress Updates). Put pending approvals in a distinct footer card with a tool icon and Accept/Reject. Keep rejected steps visible.
- **Artifacts are first-class documents:** Task checklist, Implementation Plan with IMPORTANT callouts, and Walkthrough with media. Support comments on text, diffs and image regions. Offer Proceed / Review ▾ with a comment count in both the header and the chat card, and keep a "Proceeded with … under your review policy" receipt showing the policy.
- **Permission model:** presets plus Deny>Ask>Allow rules with editable scope and "always allow" persistence per conversation or project. Mark sandboxed commands with a shield badge.
- **Composer:** + menu, model picker with effort flyout and usage, mic, @ and / menus, queued messages with Send now, minimizable side questions (/btw), quote-selection with ⌘L.
- **Notifications:** a chime for action-required, a softer completion sound, a bottom-right toast stack, and a pending badge on sidebar rows.

---

## F. Unverified / gaps

- The full list of JavaScript Execution Policy options (Always Proceed / Request Review / Disabled is secondary-source only).
- The exact preset-to-policy mapping for Agent-driven and Review-driven in 1.x onboarding.
- "Agent Auto-Fix Lints" and "Enable Agent Web Tools" (secondary sources only).
- Whether Knowledge Items exist in 2.0 UI.
- Whether a Planning/Fast toggle exists in the 2.0 composer; screenshots show none.
- The exact 2.0 revert/rewind GUI control.
- The app typeface.
- The 2.0 theme list beyond Vesper and Darcula.
- The contents of the 2.0 "Browser integration" settings.
- The app technology stack (likely Electron/web, but unverified).

## Sources (all fetched 2026-09-22)

- Docs (current): https://antigravity.google/docs/home/ , /getting-started/ , /overview/ , /features/ , /projects/ , /permissions/ , /agent-settings/ , /artifact-review/ , /settings/ , /sandbox/ , /subagents/ , /hooks/ , /sidecars/ , /skills/ , /plugins/ , /rules-workflows/ , /ide/workflows/ , /migration/workflows-to-skills/ , /mcp/ , /models/ , /plans/ , /slash-commands/ , /remote-control/ , /artifacts/ , /implementation-plan/ , /walkthrough/ , /screenshots/ , /tools/ (Task Groups) , /agent/ , /ide/overview/ , /ide/agent-side-panel/ , /ide/review-changes-editor/ , /ide/browser/ , /ide/browser-recordings/ , /ide/allowlist-denylist/ , /ide/separate-chrome-profile/ , /ide/tab/ , /cli/modes/ , /cli/best-practices/ , /cli/conversations/ , /sdk/tools/
- Changelog: https://antigravity.google/changelog (2.0 entries May 19–Sep 19 2026; IDE entries Nov 18 2025–Aug 13 2026)
- Blog: https://antigravity.google/blog/introducing-google-antigravity (Nov 18 2025); /introducing-google-antigravity-2 (May 19 2026); /google-io-2026-feature-deep-dive (May 19 2026); /google-io-2026 (May 19 2026); /introducing-custom-agents (Aug 12 2026); /remote-control-for-antigravity (Aug 21 2026); /vcs-and-terminal (Aug 24 2026)
- Archived original docs (Wayback, Nov 20 2025 and Mar 10 2026): https://antigravity.google/assets/docs/{agent/agent-modes-settings, agent/models, agent/task-groups, agent/browser-subagent, artifacts/*, agent-manager/*, browser/*, settings/settings, faq/faq, plans/plans}.md
- Codelab (archived Nov 24 2025): https://codelabs.developers.google.com/getting-started-google-antigravity (the current version has been rewritten for 2.0)
- Google Developers Blog (Nov 20 2025): https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/
- TechCrunch (May 19 2026): https://techcrunch.com/2026/05/19/google-launches-antigravity-2-0-with-an-updated-desktop-app-and-cli-tool-at-io-2026/
- Secondary: https://danicat.dev/posts/the-hitchhikers-guide-to-antigravity-2-0/ (May 21 2026); https://discuss.ai.google.dev/t/antigravity-2-0-ui/147183 (May 22 2026); https://www.aifire.co/p/google-antigravity-review-a-beginner-s-guide-to-the-ai-ide (Nov 28 2025); https://petronellatech.com/blog/google-antigravity-ide-setup-guide-2026/
