# Competitor coding agents: research notes (as of 2026-09-22)

Context: input for a synthesis step on rebuilding a native macOS SwiftUI coding-agent app.
Method: primary sources (official docs, changelogs, official blogs) fetched 2026-09-22. Anything not confirmed from a primary source is marked **unverified**.

## Cross-cutting trends (the 2026 picture)

- **The "agent manager" is now the main screen, and the editor comes second.** Devin Desktop (ex-Windsurf) made the Agent Command Center the default surface. Zed shipped a Threads Sidebar for parallel agents. VS Code has an "Agents window". Amp removed its editor extensions and its TUI sidebar in favour of web and native apps. JetBrains Air is a standalone ADE. Warp pivoted to "Factories". Conductor, Superset, Sculptor, Cline Kanban and Vibe Kanban are all "many agents in worktrees" shells.
- **ACP (Agent Client Protocol) became the multi-vendor standard.** Zed, JetBrains (IntelliJ, Air), Devin Desktop and Junie CLI all speak ACP. Most tools host Claude Code, Codex and others as "harnesses".
- **Permissions converged on allow/ask/deny rule lists, matched per tool with patterns**, with deny taking precedence, plus a "yolo" or "autopilot" escape hatch. Several tools classify command risk (Factory, VS Code, Windsurf "Auto", Cline `requires_approval`).
- **Worktree per task is table stakes.** Differentiation has moved to setup/run/archive scripts, port allocation, secrets, archive-with-cleanup and cloud sandboxes.
- **Review is the bottleneck.** Tools now ship diff viewers with line comments sent back to the agent, AI-ordered diffs (Amp), "restack" into clean commits (Amp), and merge-readiness checks (Conductor).
- **Churn and consolidation:** Windsurf became Devin Desktop (2026-06-02). Roo Code shut down (2026-05-15). Vibe Kanban's company shut down (2026-04-10) and the project went community-maintained. Terragon shut down (2026-02-09). Crystal became Nimbalyst (Feb 2026). Copilot "coding agent" was renamed "cloud agent" (2026-04-01).

---

## 1. Windsurf / Cascade, now **Devin Desktop** (Cognition)

**Current state**
- Windsurf was rebranded **Devin Desktop** on **2026-06-02** through an over-the-air update. Cognition calls it "a full IDE with an agent manager built in". Sources: https://devin.ai/blog/windsurf-is-now-devin-desktop and https://cognition.com/blog/introducing-devin-desktop (06.02.26, Scott Wu & Jeff Wang).
- The rebrand came after **Windsurf 2.0** (**2026-04-15**), which added the **Agent Command Center** (a Kanban of local and cloud agent sessions by status: in progress, blocked, ready for review), **Spaces** (sessions, PRs, files and shared context grouped together; new sessions inherit the space's context) and the Devin cloud agent inside the IDE. Source: https://devin.ai/blog/windsurf-2-0. The release date comes from secondary coverage and the post title; the post body was not fetched.
- **Devin Local** replaces Cascade as the local agent. It was rewritten in Rust, is "up to 30% more token efficient" and supports subagents. Legacy Cascade remains available until July 1 (per the devin.ai blog). Changelog: Devin Local v2.1.29 (Apr 29), Worktrees v3.5.17 (Jul 17), Plan Mode + Subagents + Editable Approvals + Codemaps in tabs v3.6.21 (Jul 29), Share Conversations and Permission Rules v3.7.16 (Aug 10), Agent Command Center workspace-aware v3.8.20 (Aug 21). Source: https://docs.devin.ai/desktop/changelog
- Docs moved from docs.windsurf.com (307 redirect) to **https://docs.devin.ai/desktop/**.
- **Native ACP support**: third-party agents (Codex, Claude Agent, OpenCode, in-house agents) run alongside Devin (https://devin.ai/blog/windsurf-is-now-devin-desktop).
- Models: **SWE-1.5** (Oct 2025), then **SWE-1.6**. Secondary sources describe SWE-1.6 as the current free in-house model at about 950 tok/s (**unverified** from a primary source). Devin Local is multi-model (Opus, GPT-5.5, SWE-1.6 per the changelog).

**Cascade (legacy) features** (https://docs.devin.ai/desktop/cascade/cascade)
- Modes: **Code** and **Chat**. A background "planning agent" refines the long-term plan while the main model acts, and Cascade auto-generates a Todo list.
- Checkpoints: a named snapshot plus "revert to here" on hover over a prompt. The docs warn that "Reverts are currently irreversible".
- Tool-call cap: 40 invocations per prompt by default (`devin.autoContinue`, where 0 means unlimited).
- Queued messages. Simultaneous Cascades through a dropdown, with worktrees recommended to avoid race conditions.

**Permissions**
- Legacy Cascade terminal **auto-execution levels**: **Disabled**, **Allowlist Only**, **Auto** (the model judges safety; premium models only), **Turbo** (everything auto-runs except the deny list). Allow and deny lists use `git *`-style prefix entries and can be edited straight from the terminal command cards. Admins can cap the maximum level, and team deny lists override allow lists. Source: https://docs.devin.ai/desktop/terminal
- **Devin Local** swaps levels for **deny / ask / allow rules** (deny wins), "session-wide grants" and editable commands in approval cards (click a command to edit it before approving). Rules compose across enterprise, mode, user, project and subagent levels. MCP tools ask by default. Sources: https://docs.devin.ai/desktop/devin-local and the changelog.

**Planning**: Devin Local has **Normal / Plan / Ask** modes. Plan mode does read-only research, keeps a persistent Markdown plan file and asks for approval. The keyword `megaplan` triggers a deeper plan with clarifying questions. Source: https://docs.devin.ai/desktop/devin-local

**Instructions and memory** (https://docs.devin.ai/desktop/cascade/memories)
- Rules live in `~/.codeium/windsurf/memories/global_rules.md` (6,000-character limit) and `.devin/rules/*.md` (preferred) or `.windsurf/rules/*.md` or legacy `.windsurfrules` (12,000 characters per file). There is also an enterprise system rules directory (`/Library/Application Support/Devin/rules/` on macOS).
- Rule activation modes: **always_on**, **model_decision** (only the description is in context; the full rule is pulled in when relevant), **glob**, **manual** (`@rule-name`).
- `AGENTS.md`: the root file is always on. Subdirectory files auto-glob to their folder.
- **Memories** are auto-generated during chats, or created on request ("create a memory of..."). They are stored per workspace in `~/.codeium/windsurf/memories/`, cost no credits and are not version-controlled. Devin Local does **not** support memories or workflows (migrate to skills).
- **Workflows**: `.devin/workflows/*.md`, invoked manually with `/name`, max 12,000 characters, and can call other workflows (https://docs.devin.ai/desktop/cascade/workflows). **Skills**: `.devin/skills/<name>/SKILL.md` with progressive disclosure, auto-invoked or `@skill` (https://docs.devin.ai/desktop/cascade/skills). A migration wizard converts workflows to skills.

**Distinctive UI**
- **Previews** open the running web app in an editor tab. **"Send element"** turns a clicked DOM element into an @mention, and console errors can be sent as context. This works for Devin Local, remote and ACP agents. Source: https://docs.devin.ai/desktop/previews
- **Codemaps** (published 2025-11-04) are AI-annotated, hierarchical maps of a code flow. They come in a text/list view with clickable jump-to-code links and a node-diagram view, can be generated with a Fast (SWE-1.5) or Smart (Sonnet 4.5) model, open with Cmd+Shift+C, and can be passed to the agent as `@{codemap}` context. Source: https://cognition.com/blog/codemaps
- **DeepWiki hover**: Cmd+Shift+Click on a symbol opens an explanation of it rather than just its type (https://docs.devin.ai/desktop/deepwiki).
- **Share conversation** uploads a sanitized transcript (system prompt and tool definitions dropped, secrets redacted, paths normalized) behind a team-visible link.

**Ideas worth stealing**
1. **Editable approval cards**: click a proposed command to edit it before approving. Add session-wide grants from the card itself.
2. **Send element / send console error from the preview into the composer as @mentions.** For a Mac app this could extend to a SwiftUI preview or simulator screenshot region.
3. **Codemaps as a shareable artifact that doubles as agent context** (`@codemap`), plus Spaces, which let new sessions inherit shared context.

---

## 2. Zed Agent Panel + **Agent Client Protocol (ACP)**

**Agent Panel** (https://zed.dev/docs/ai/agent-panel)
- **Threads Sidebar** (`cmd-alt-j`) groups threads by project. Threads can be archived and restored, `ctrl-tab` switches threads, and Thread History opens with `cmd-g`.
- **Follow the agent**: a crosshair icon tracks the agent's edits live. Hold `cmd` while submitting to auto-follow.
- **Review changes**: a multibuffer tab of all edited files where you **accept or reject each hunk or the whole set**. `agent.single_file_review` shows inline diffs.
- **Restore Checkpoint** button after each edit.
- Queued messages, with a **"Steer"** toggle that interrupts sooner (Zed Agent only).
- A token-usage display sits next to the profile selector. There is `agent.auto_compact`. Notifications are controlled by `agent.notify_when_agent_waiting` and `agent.play_sound_when_agent_done`.

**Parallel Agents** (shipped **2026-04-22**, https://zed.dev/blog/parallel-agents, https://zed.dev/docs/ai/parallel-agents)
- You can mix agents per thread (Zed Agent, Claude Agent, Codex, any ACP agent).
- **Worktree isolation is a per-thread choice**, made from a title-bar worktree picker. New worktrees start in **detached HEAD** so a branch is never shared.
- **Archiving a worktree thread saves its git state and removes the worktree from disk. Restoring the thread restores the worktree.**
- Multi-root projects let one thread read and write across repos.
- **Terminal Threads** (**2026-05-20**, https://zed.dev/blog/terminal-threads): a CLI agent (Claude, Amp, Pi) runs in a terminal that appears as a thread in the sidebar. Its title auto-updates from the running process, and it raises attention notifications. This is pitched as a way to use a Claude subscription rather than the API.

**Permissions** (https://zed.dev/docs/ai/tool-permissions, v0.224.0+, replacing `agent.always_allow_tool_actions`)
- `agent.tool_permissions.default` takes `"allow" | "deny" | "confirm"`. `agent.tool_permissions.tools.<tool>` holds regex lists `always_allow`, `always_deny` and `always_confirm`, plus `case_sensitive`.
- Tools: `terminal` (matched on the command string), `edit_file`/`write_file` (path), `delete_path`, `move_path`/`copy_path`, `create_directory`, `fetch` (URL), `search_web` (query), `skill` (path to SKILL.md), `mcp:<server>:<tool>`.
- Precedence: built-in security rules (hard-coded blocks on `rm -rf /`, `~`, `.` and `..` that cannot be overridden) > always_deny > always_confirm > always_allow > tool default > global default.
- **Chained shell commands are parsed and each sub-command is checked.**
- Prompt buttons: **Allow once / Deny once / Always for <tool> / Always for <pattern>** (the pattern option appears only when a safe pattern can be extracted).

**Profiles** (https://zed.dev/docs/ai/agent-profiles): built-in **Write**, **Ask** (read-only) and **Minimal** (no tools). Custom profiles are forked from these with a per-profile tool set and a `default_model`. They are managed with `agent: manage profiles`.

**Instructions** (https://zed.dev/docs/ai/instructions, 1.4.0 preview on **2026-05-20**, https://zed.dev/releases/preview/1.4.0)
- The **Rules Library was removed** and replaced by **Skills** (`@skill`) plus **Instructions**.
- The global `~/.config/zed/AGENTS.md` is included in every project.
- For project files, the **first match wins** in this order: `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`.

**External agents / ACP** (https://zed.dev/docs/ai/external-agents, https://agentclientprotocol.com)
- The **ACP Registry** (the preferred install path since about v0.221) lists Claude, Codex, OpenCode, Copilot, Cursor, Pi, Poolside, Gemini CLI and more. Custom agents go in `agent_servers: { name: { type: "custom", command, args, env } }`.
- External agents own their own model, auth and tools. Zed profiles and skills do **not** apply. Zed MCP servers *may* be forwarded. Native tool permissions depend on the agent.
- Protocol: JSON-RPC over stdio for local agents. Remote (HTTP/WebSocket) support is a work in progress. Markdown is the default text format, and MCP JSON types are reused.
- **Tool-call model** (https://agentclientprotocol.com/protocol/tool-calls):
  - `kind`: read, edit, delete, move, search, execute, think, fetch, switch_mode, other.
  - `status`: pending, in_progress, completed, failed.
  - Content: regular content, **diff** (`path`, `oldText`, `newText`) and **terminal** (`terminalId`, live output).
  - `locations` (`path`, `line`) drive follow-along.
  - `session/request_permission` returns `selected{optionId}` or `cancelled`. Option kinds are **allow_once, allow_always, reject_once, reject_always**.

**Ideas worth stealing**
1. **Speak ACP as a host.** Render ACP `kind`, `status`, diff and terminal content natively, and you get Claude Code, Codex, Gemini, Copilot, OpenCode and Junie for free.
2. **Archive a thread → snapshot the worktree's git state and delete it from disk; restore the thread → recreate the worktree.** This keeps disk usage bounded.
3. **A four-button permission prompt with "Always for <pattern>"**, built on a chained-command parser plus hard-coded catastrophic-command blocks.

---

## 3. GitHub Copilot (cloud agent, VS Code agent, Agent HQ)

**Agent HQ / mission control**
- Announced at Universe on **2025-10-28** (https://github.blog/news-insights/company-news/welcome-home-agents/): one command center across GitHub, VS Code, mobile and CLI, with third-party agents from Anthropic, OpenAI, Google (Jules), Cognition and xAI inside Copilot subscriptions.
- Mission control features (https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/, 2025-12-01):
  - A task panel that works across repos.
  - A custom agent picker.
  - Real-time session logs that show reasoning.
  - **Mid-run steering (pause, refine, restart)**.
  - A jump from each task to its PR.
- The same announcement introduced Plan Mode in VS Code, AGENTS.md-based custom agents, the GitHub MCP Registry, Copilot code review of agent output, and an Agent Control Plane for enterprise governance.

**Cloud agent** (renamed from "coding agent" on **2026-04-01**, https://github.blog/changelog/2026-04-01-research-plan-and-code-with-copilot-cloud-agent/)
- Assigning an issue gives you a branch, and optionally a PR, built in an ephemeral **GitHub Actions** environment (https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent).
- It can now work **on a branch without opening a PR**. A **Diff** button lets you review before you "Create PR".
- **Plan first**: the agent proposes an approach and writes code only after you approve.
- **Deep research** sessions are started from the Agents tab.
- Customization: `copilot-setup-steps.yml` (environment setup, 59-minute max), custom instructions, MCP, custom agents, hooks and skills.
- Limits: one repo per session and one PR per task.

**Custom agents** (https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- Files are `.github/agents/*.agent.md`, with org-level agents in `.github-private`.
- Frontmatter: `name`, `description` (required), `tools` (aliases `execute`, `read`, `edit`, `search`, `agent`, `web`, `todo`), `model`, `target` (`vscode` | `github-copilot`), `disable-model-invocation`, `user-invocable`, `mcp-servers` and `metadata`. `infer` is retired.
- The body is limited to 30,000 characters.

**VS Code agent** (docs dated about 2026-09-16)
- **Permission levels picker** (https://code.visualstudio.com/docs/agents/run/approvals), with the default set by `chat.permissions.default`:
  - **Manual permissions**: uses your approval settings.
  - **Allow all**.
  - **Autopilot**: auto-approves, retries on errors and *answers its own blocking questions* until the task is done.
- Approval scopes: once / session / workspace / always. Other controls: `chat.tools.eligibleForAutoApproval`, the "Chat: Reset Tool Confirmations" command, and `chat.tools.global.autoApprove`. `/yolo` and `/autoApprove` apply for the session.
- **Terminal rules**: `chat.tools.terminal.autoApprove` maps a command or `/regex/` to true or false. The object form can use `matchCommandLine: true`. Read-only commands are approved by default, while `rm`/`del` ask. `chat.tools.terminal.enableAutoApprove` and `chat.tools.terminal.blockDetectedFileWrites` (default `outsideWorkspace`) complete the set.
- **URL approvals** are split into **request approval** (whether to contact the URL) and **response approval** (whether to add the fetched content to context, as a defence against prompt injection) in `chat.tools.urls.autoApprove`.
- **Terminal sandboxing** is toggled from the same picker: `chat.agent.networkFilter` and allowed/denied domains.
- **Checkpoints** (https://code.visualstudio.com/docs/copilot/chat/chat-checkpoints):
  - Hover a request → **Restore Checkpoint** → **Redo**. Editing a previous request reverts everything from that point.
  - `chat.checkpoints.showFileChanges` shows per-request +/- stats.
  - Pending edits get **Keep / Undo** per file or per hunk. `chat.editing.autoAcceptDelay` accepts them automatically after a delay.
  - The docs spell out the caveat: terminal side effects are not reverted.
- **Plan agent** (https://code.visualstudio.com/docs/copilot/agents/planning, 2026-09-17): asks clarifying questions and produces a plan (summary, implementation steps, verification steps). **Start Implementation** hands off to an implementation agent with the context carried over. The plan is saved to `/memories/session/plan.md`. Settings: `chat.planAgent.defaultModel` and `github.copilot.chat.planAgent.additionalTools`.
- **Agent harnesses** (https://code.visualstudio.com/docs/agents/run/agent-harnesses, 2026-09-16): **Local, Copilot (Agent Host / SDK), Claude (Claude Agent SDK), Codex, Cloud**. Worktree sessions automatically use **Allow all**, because their changes are isolated. There is a dedicated **Agents window**.
- **Instructions** (https://code.visualstudio.com/docs/copilot/customization/custom-instructions):
  - `.github/copilot-instructions.md`, plus `.github/instructions/*.instructions.md` with `applyTo` globs (user-level files in `~/.copilot/instructions`).
  - `AGENTS.md` (`chat.useAgentsMdFile`, with nested files via `chat.useNestedAgentsMdFiles`) and `CLAUDE.md` (`chat.useClaudeMdFile`).
  - Commands: `/init` and `/create-instructions`. Org instructions are also supported.

**Ideas worth stealing**
1. **Separate URL "request" and "response" approvals.** This is a cheap, visible defence against prompt injection.
2. **Worktree ⇒ auto "Allow all".** Tie permission level to isolation level, which cuts prompts dramatically.
3. **Plan agent → "Start Implementation" button** that carries plan and context forward. Pair it with Restore Checkpoint + Redo and per-request file-change stats.

---

## 4. Amp (ampcode.com, now Amp Frontier Corporation, spun out 2025-12-02)

**Direction**: Amp has radically pruned features.
- Editor extensions were killed ("The Coding Agent Is Dead", **2026-02-19**, turned off Mar 5).
- Amp Tab was removed (2026-01-15), and so were TODOs (2026-01-12) and Fork (2026-01-13).
- Custom commands were replaced by skills (2026-01-29).
- The TUI sidebar was removed (**2026-08-27**).
- The rebuilt CLI shipped 2026-05-06, and the npm package moved to `@ampcode/cli`.
- Focus is now on **Orbs** (remote per-thread machines, "Agents in Orbs" **2026-06-30**), **Runners** (your own machines), **Puck** (a meta-agent), and native iOS/macOS apps (**2026-08-28**).
- Index of all posts: https://ampcode.com/news

**Modes, "The Dial"** (**2026-07-09**, https://ampcode.com/news/the-dial)
- **low / medium / high / ultra** replace smart, deep, rush and large. The dial asks "how hard is this task?" Reasoning effort is folded into the tier.
- **Every mode has an Oracle for second opinions.** In the top tiers the *other* frontier model reviews. Current wiring: ultra = Claude Fable 5 with GPT-5.6 Sol as oracle; high = GPT-5.6 Sol at xhigh with Fable as oracle; medium = GPT-5.6 Sol at medium; low = GLM-5.2 (open weights). The Fable 5.1 upgrade to ultra came on 2026-09-01.
- Switch with Ctrl+S in the CLI. The old modes can be installed as plugins (`@amp/smart-classic`, etc.).
- **Customize Your Dial** (2026-09-10, https://ampcode.com/news/build-your-own-dial): Settings → Mode Dial → **Tune Modes** sets the model and effort for the main agent, Oracle and subagents. **Build Dial** lets you drag 2–4 modes, including plugin agents, onto the dial. Admins can set a shared dial.

**Subagents**
- **Oracle** (a read-only "second opinion" subagent, originally o3 and later GPT-5.x; https://ampcode.com/news/oracle) is invoked by explicit prompts such as "use the oracle to review...".
- **Librarian** (2025-10-20, https://ampcode.com/news/librarian) searches public GitHub and your private repos. It became about 3x faster on 2026-06-18.
- **Agent-to-agent** (2026-07-17, https://ampcode.com/news/from-agent-to-agent): agents spawn agents (locally, in orbs, on other machines), message each other and exchange files.
- **Puck** (2026-07-20, https://ampcode.com/news/meet-puck) is a meta-agent that spawns, finds and archives threads, with voice control added 2026-08-18.

**Context management**
- **Handoff replaced compaction** (2025-10-23, https://ampcode.com/news/handoff). `/handoff <goal>` produces a *draft* first prompt plus a relevant-file list in a new thread, which you edit before sending. Since 2026-01-13 you can just ask: "Handoff and implement the plan".
- Threads can reference and read other threads (2025-10-29). **Thread Map** (2025-12-11) shows the graph of mention, handoff and fork links. The "200k Tokens Is Plenty" philosophy favours short threads.
- **Steer, don't queue** (2026-09-08): messages sent mid-turn are delivered at the next opportunity. Built-in Ship and Review actions still queue.

**Permissions**
- `amp.permissions` is an ordered list of `{tool, matches:{arg: glob|[globs]}, action: allow|reject|ask|delegate, to}`. The first match wins, then built-in defaults apply. **delegate** hands the decision to an external program on `$PATH`. Source: https://ampcode.com/news/tool-level-permissions
- MCP permissions were added separately. **"Proof of Human"**: passkey auth can be required for some operations (2026-05-27).

**Toolboxes** (https://ampcode.com/news/toolboxes): `AMP_TOOLBOX=dir`. Each executable is called with `TOOLBOX_ACTION=describe` and returns JSON `{name, description, args}`. With `execute`, it receives the args on stdin. Tools without writing an MCP server.

**Threads, sharing and visibility**
- Public discoverable threads were removed (**2026-06-02**, https://ampcode.com/news/end-of-public-threads). Remaining levels are private, **workspace**-shared and **Unlisted** (unguessable URL). The reason given: agents now read too many files for public sharing to be safe.
- Thread labels and search by keyword or by files touched.
- Multiplayer (2026-07-22), tagging teammates into threads (2026-08-19) and "Space to Talk" live team chat inside threads (2026-08-31).

**Review / diffs**
- **Diffs** (2026-06-16, https://ampcode.com/news/diffs): review and stage in-app on desktop and mobile, request changes on specific sections, and a duplicate-block-detecting diff algorithm.
- **Intelligently Ordered Diffs** (2026-09-01): files that explain the change come first, while tests, fixtures and generated code are muted. A blue dot means the order has been updated.
- **Restack** (2026-09-11): regroups the thread's changes into logical commits.
- The earlier VS Code Review panel (2025-10-25) offered a commit range, an AI summary, a "tour" with recommended file order, and staging with an auto commit message.

**Worktrees and runners** (2026-09-22, https://ampcode.com/news/one-runner-many-worktrees)
- The directory picker has **New Worktree**. The name becomes both branch and folder, created as a sibling directory (`~/code/amp-fix-x`).
- **"Archive and Remove Worktree"** archives the thread, runs `git worktree remove` and deletes the branch.
- Runners inject secrets and env vars (personal → project → workspace) when started with `--amp-env`.

**TUI design**: it keeps the TUI for "local, interactive threads in a single environment", has a command palette in place of slash commands (Ctrl-O, 2025-10-28), and leaves multiplexing to the terminal (https://ampcode.com/news/so-long-tui-sidebar).

**Pricing** (2026-09-13, https://ampcode.com/news/free-agent): free with your own compute and model subscriptions or keys. You pay for orbs.

**Ideas worth stealing**
1. **Handoff instead of compaction**: produce a *drafted, editable* first message plus a file list for a new thread, and show the thread graph.
2. **A difficulty dial (low→ultra) instead of model names, with a cross-vendor "oracle" reviewer per tier.** Users can remap models behind each notch.
3. **Review UX**: AI-ordered diffs with tests muted, duplicate-block-aware diffs, "Restack into logical commits", and "Archive and Remove Worktree" as a single action.

---

## 5. Factory (Droids)

**Autonomy** (https://docs.factory.ai/cli/user-guides/auto-run)
- **Auto Off**: read tools and allowlisted commands only.
- **Low**: file edits plus low-risk commands and MCP.
- **Medium**: adds reversible workspace changes (installs, git commit, mv, builds).
- **High**: adds high-risk actions such as git push, docker compose and migrations.
- **Ctrl+L** cycles levels and **Shift+Tab** toggles Normal/Spec. Every command gets a risk classification (low/medium/high) and is auto-run if at or below the current level.
- Three lists: `commandAllowlist` (treated as low-risk), `commandDenylist` (asks even at high; the user can override) and `commandBlocklist` (never runs and cannot be approved; added June 2026). Orgs can cap the maximum autonomy level.

**Spec mode** (https://docs.factory.ai/cli/user-guides/specification-mode)
- Planning is read-only. After the spec you choose: **approve and return to Normal**, **approve and proceed at Low/Medium/High**, or keep iterating.
- A separate spec model is set with `sessionDefaultSettings.specModeModel` and `specModeReasoningEffort`.
- Specs can be saved to `.factory/docs/YYYY-MM-DD-slug.md` ("Save spec as Markdown").

**droid exec** (https://docs.factory.ai/cli/droid-exec/overview)
- Headless and **read-only by default**. Flags: `--auto low|medium|high`, `--skip-permissions-unsafe`.
- Output formats: `text`, `json`, `stream-jsonrpc`. `--session-id` continues a session and `--fork` branches it.
- It fails fast when a task exceeds the granted autonomy.

**Worktrees** (via search of docs.factory.ai; page not fetched directly): the `worktreeDirectory` setting defaults to `~/.factory/worktrees/<8-char group>/<repo>/`. `--worktree <name>` creates or checks out a branch and fails if that branch is already checked out elsewhere.

**Instructions** (https://docs.factory.ai/cli/configuration/agents-md)
- Walks up to the git root looking in `.factory/`, `.agents/` and `.agent/`, plus the home-directory equivalents. Accepts `AGENTS.md` and `CLAUDE.md` variants.
- Precedence: user request > nested > root > personal.
- Budget: 80k characters at initial load and 40k for dynamic discovery.
- Custom droids, hooks and skills exist, but their docs were not fetched (**unverified detail**).

**Changelog highlights for 2026** (https://docs.factory.ai/changelog/cli-updates)
- `/rewind-conversation` restores both chat and files (June).
- Session archiving/restore and session forking from the sidebar (September).
- On-demand MCP tool loading, per-MCP-server timeout and risk configuration (May), and multi-select question responses (July).
- "Settings changes proposed in chat" (September).

**Factory Desktop app** (**2026-04-08**, https://factory.com/news/factory-desktop; factory.ai redirects to factory.com)
- A sidebar of parallel sessions.
- **Droid Computers**: managed cloud machines with checkpoint/restore, "BYO machine" (`droid computer register`), and local models via Ollama/vLLM.
- Computer use.
- The droid picks a presentation format (Mermaid, charts, tables).
- VS Code connection. Sessions sync across desktop, web and mobile.

**Missions** (https://factory.com/news/missions, https://docs.factory.ai/cli/features/missions)
- Started with `/missions`. Planning is a conversation first, followed by the **Mission Control** view.
- Work is split into milestones → features, and each feature gets a fresh worker session.
- **Every milestone ends with a validation phase.** Different models are assigned to different roles.
- "The orchestrator is an agent, and you can talk to it"; you can pause at any point.
- The page metadata says 2025-02-26, but the text references Opus 4.6 and GPT-5.3-Codex, so it is probably 2026 (**date ambiguous**).

**Ideas worth stealing**
1. **Autonomy expressed as risk tiers** (Off/Low/Medium/High), with per-command risk classification, plus a *non-approvable* blocklist separate from the denylist.
2. **Spec approval that doubles as an autonomy choice**: "Approve & run at Medium". Save the approved spec as a dated Markdown file in the repo.
3. **Headless mode that is read-only by default and fails fast** when a task exceeds its autonomy, with JSON-RPC streaming. This is good for an app's background or automation runs.

---

## 6. Warp (ADE → Oz → Warp Factories)

**Current state**
- Warp now brands itself "The Open Platform for Automating Development" (https://www.warp.dev/). It has three products: **Warp Factories**, the **Warp Terminal** (open source) and the **Warp Agent CLI**.
- Oz, the cloud agent platform, launched **2026-03-22** (https://www.warp.dev/newsroom/2026/3/22/...). It is multi-harness: Warp Agent, Claude Code and Codex.
- The ADE was open-sourced on **2026-04-28** (https://www.warp.dev/newsroom/2026/4/28/warp-open-sources-its-agentic-development-environment). OpenAI is the sponsor, and Oz agents triage issues and open PRs in the open. The AGPL license comes from secondary sources and is **unverified**.
- **Warp Factories** launched August 2026 (per search results; **date unverified** from a primary page). A `factory.yaml` defines agents, triggers, models and permissions. A "foreman" agent splits work into triage, spec, implementation and review subagents.
- The "Oz agent UI" was renamed **Warp Agent** on 2026.08.13 (https://docs.warp.dev/changelog/2026/).
- Warp 2.0 "ADE" dates to June 2025 (**from memory, unverified**).

**Profiles and permissions** (https://docs.warp.dev/agents/using-agents/agent-profiles-permissions)
- A profile sets the model, autonomy and tools. Per-action permissions cover **Apply code diffs, Read files, Create plans, Execute commands, Interact with running commands, Ask clarifying questions**.
- Each permission takes **Agent decides / Always ask / Always allow**, and some also offer **Never**.
- Command allowlist defaults: `ls`, `grep`, `find`. Denylist defaults: `rm`, `curl`, `wget`, `eval`. The denylist beats the allowlist and "Agent decides".
- MCP servers take allow, deny or agent-decides.
- **"Run until completion"** (⌘⇧I) grants full autonomy for the current task. It bypasses the denylist unless that is disabled.
- Execution profiles can be set from settings files (2026.07.31).

**Diffs and review** (https://docs.warp.dev/agents/local-agents/code-diffs/)
- Inline diff blocks, navigated with arrow keys (left/right switches file). **Enter = Accept, R = Refine** (tell the agent what to change and it regenerates the diff), **E = Edit** by hand.
- If "Apply code diffs" is set to Always allow, diffs skip review.
- A Code Review panel supports **inline review comments that go back to the agent**, including for third-party CLI agents.

**Planning** (https://docs.warp.dev/agents/capabilities/planning/)
- `/plan` produces a plan in a rich-text editor. **Every agent edit creates a new plan version** that you can compare or restore.
- You can execute the whole plan or selected sections. "View plan" tracks progress.
- Plans sync to the Warp Drive Plans folder and can be referenced with `@plans`.

**Agent management** (https://docs.warp.dev/agents/using-agents/managing-agents)
- The **Agent Management Panel** shows statuses: Working / Blocked (waiting on the user) / Failed / Success.
- Child-agent "pills" switch a pane between parent and child conversations.
- Vertical tabs carry metadata (agent, branch, directory, status). Tab Groups arrived 2026.07.03 and pinning 2026.07.23.

**Third-party CLI agents** (https://docs.warp.dev/agent-platform/cli-agents/overview)
- Auto-detects Claude Code, Codex, OpenCode, oh-my-pi and others.
- Adds a **rich input editor (Ctrl-G)** and in-app plus desktop notifications (Claude Code needs a Warp notification plugin, offered as a one-click install chip).
- Inline code-review comments go to the CLI agent, plus Remote Control.

**Rules** (https://docs.warp.dev/knowledge-and-collaboration/rules)
- Global Rules live in **Warp Drive → Personal → Rules**. Project Rules come from `AGENTS.md` (or `WARP.md`) at the root and in the current directory, with a best-effort pickup of subdirectories.
- Precedence: subdirectory > root > global.

**Ideas worth stealing**
1. **Per-action-type permission matrix** (diffs, reads, plans, commands, interacting with running commands, clarifying questions), each set to Agent decides / Ask / Allow / Never.
2. **Diff card keyboard triad: Accept (Enter) / Refine (R) / Edit (E)**, where Refine regenerates the diff from feedback.
3. **Versioned, editable plans** you can partially execute, plus wrapping *third-party* CLI agents with rich input, notifications and review comments. This is a good model for hosting Claude Code in a Mac app.

---

## 7. Cline / Roo Code

**Cline**
- **Plan / Act** (https://docs.cline.bot/features/plan-and-act): Plan cannot modify files, and history carries over between modes. The "Use different models for Plan and Act" setting keeps a sticky model per mode. `/deep-planning` does a systematic exploration, then a plan, then clarifying questions.
- **Auto-approve** (https://docs.cline.bot/features/auto-approve) has eight toggles: **Read project files, Read all files, Edit project files, Edit all files, Execute safe commands, Execute all commands, Use the browser, Use MCP servers**. The "all" variants extend the base toggle.
  - Whether a command is "safe" is decided by the model via a per-command `requires_approval` flag.
  - **YOLO mode** approves everything, including mode switches.
- **Checkpoints** (https://docs.cline.bot/features/checkpoints)
  - A **shadow git repo** separate from project history takes a commit after every tool use.
  - Restore options: **Restore Files / Restore Task Only / Restore Files & Task**. **Compare** opens a diff.
  - Caveat: storage and performance cost on large repos.
- **Rules** (https://docs.cline.bot/features/cline-rules)
  - `.clinerules/` or `.cline/rules/` folders for the project, and `~/Documents/Cline/Rules` for global rules.
  - A rules panel (scale icon) has a **per-rule on/off toggle**.
  - Conditional rules use `paths:` glob frontmatter and trigger on mentioned, open, visible or edited files.
  - Also reads `.cursorrules`, `.windsurfrules` and `AGENTS.md`.
- **Memory Bank** (https://docs.cline.bot/features/memory-bank) is *not* a built-in feature. It is a rules methodology with six files (`projectbrief.md`, `productContext.md`, `activeContext.md`, `systemPatterns.md`, `techContext.md`, `progress.md`), driven by the prompts "initialize memory bank" and "update memory bank".
- **Cost display**: the task header shows API cost and tokens in real time. **Subagents** (`use_subagents`, experimental, read-only, no nesting) show **per-subagent tool calls, tokens and cost**, rolled up into the task total (https://docs.cline.bot/features/subagents). Auto-compact is also available.
- **2026**:
  - **Cline CLI 2.0** (2026-02-13, https://cline.bot/blog/introducing-cline-cli-2-0).
  - **Cline Kanban** (2026-03-26, https://cline.bot/blog/announcing-kanban): each card is a live agent task with its own worktree and terminal. **Card dependencies auto-trigger downstream tasks.** It is agent-agnostic (Cline, Claude Code, Codex).
  - The **Cline SDK** is a layered runtime whose subagents have their own model, tools and prompts.

**Roo Code: shut down**
- The sunset was announced in April 2026 (2026-04-20/21 per secondary sources). The GitHub repo `RooCodeInc/Roo-Code` is **archived**, with the last push on **2026-05-15** (verified with `gh api`).
- The team moved to "Roomote", a Slack-first cloud agent (**unverified**, secondary sources). Cline is the recommended successor, and Kilo Code (a Roo fork) is still alive.
- Ideas that survive from Roo:
  - **Custom modes** (https://github.com/RooCodeInc/Roo-Code/blob/main/apps/docs/docs/features/custom-modes.mdx) live in `.roomodes` (project) or `custom_modes.yaml` (global). Fields: `slug`, `name`, `description`, `roleDefinition`, `whenToUse`, `customInstructions`, and `groups` (read/edit/browser/command/mcp, with `["edit", {fileRegex: "\\.(md|mdx)$"}]` restricting which files can be edited).
  - Mode-specific rules live in `.roo/rules-{slug}/`. Modes plus their rules export and import as YAML. **Sticky models** are remembered per mode.
  - **Orchestrator / Boomerang** (https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks): the orchestrator has no read or command tools. It uses `new_task` to spawn a subtask in a specialist mode with its own isolated context, and **only the `attempt_completion` summary** returns to the parent. Subtask creation and completion need approval by default. The UI shows the parent/child hierarchy.

**Ideas worth stealing**
1. **Three-way checkpoint restore** (files only / conversation only / both) plus Compare, backed by a shadow git repo so the user's history is never touched.
2. **Granular auto-approve toggles scoped inside vs. outside the project**, plus live **per-task and per-subagent cost/token** rollups.
3. **Modes as data** (role, whenToUse, tool groups, edit regex, sticky model), plus an orchestrator that passes down explicit context and gets back a summary only. Also Kanban cards whose dependencies auto-start the next task.

---

## 8. JetBrains Junie (and AI Assistant / Air)

**Junie**
- GA in **June 2026** (https://blog.jetbrains.com/junie/2026/06/junie-coding-agent-out-of-beta/).
- The IDE integration was rebuilt on **ACP** ("one engine, many surfaces": chat, tool window, CLI).
- Agentic **debugging** drives the IDE debugger itself (breakpoints, stack frames, expression evaluation).
- `/review` works in CLI, GitHub Actions and GitLab, with inline accept/reject.
- Remote Control. BYOK and local models (Ollama, LM Studio, LiteLLM).

**Plan mode** (https://junie.jetbrains.com/docs/junie-cli-plan-mode.html)
- Toggle with Shift+Tab (cycles Default → Plan → Debug), `/plan <prompt>` or `--plan`. It applies to the *next prompt only*.
- The output is a **design document with tabs** (product requirements, technical design, delivery stages, testing strategy), stored in `.junie/plans`.
- Actions after a plan: **Confirm and implement / View the entire plan (Ctrl+P) / Open <plan-file> / Save the plan and stop**.

**Permissions**
- **Brave mode** means no approvals. Without it, Junie asks before terminal commands, MCP tools and other sensitive actions.
- CLI: `~/.junie/allowlist.json` with `defaultBehavior`, `allowReadonlyCommands` and rule categories **fileEditing, executables, mcpTools, readOutsideProject, readSecretFile**. Each rule has a `prefix` or glob `pattern` and an `action` of allow or ask. Every part of a chained command must be allowed. Source: https://junie.jetbrains.com/docs/action-allowlist-junie-cli.html
- IDE Action Allowlist rule types: **Terminal (regex), RunTest, Build, Preview, MCP, Read outside project, Write outside project, Edit build scripts, Edit configuration or hidden files**. `ls`, `cd` and `pwd` are allowed by default, but combining them with `&&` asks. Source: https://junie.jetbrains.com/docs/action-allowlist.html
- Note that **build-script edits are treated as sensitive** because they can trigger a project import, which can execute code.

**Guidelines** (https://junie.jetbrains.com/docs/guidelines-and-memory.html)
- Search order: `.junie/AGENTS.md` → root `AGENTS.md` + `.junie/playbook.md` + `.junie/rules/*.md` → legacy `.junie/guidelines.md` or the `.junie/guidelines/` folder. The global file is `~/.junie/AGENTS.md`, and the project file wins where they conflict.
- On first open, Junie **offers to import other agents' instruction files**. It does the same for `.claude/agents/`, `.cursor/agents/` and `.codex/agents/`, which it imports into `.junie/agents/`.

**Parallel sessions** (https://junie.jetbrains.com/docs/junie-cli-worktrees.html)
- `/new [prompt]` keeps the current session live. `/history` lists live and saved sessions with the statuses **Working… / Awaiting input / Ready / "5m ago"**.
- Live sessions owned by another process appear dimmed so two UIs never drive the same session. Worktrees are recommended for isolation.
- **Subagents** (EAP) are auto-delegated only. Model policy is **SameModelOnly** or **Auto** (Auto may choose cheaper tiers). Source: https://junie.jetbrains.com/docs/junie-cli-subagents.html
- `junie --acp true` runs Junie as an ACP agent (https://junie.jetbrains.com/docs/junie-cli-acp.html).

**AI Assistant / ACP in IntelliJ** (2026-08, https://blog.jetbrains.com/idea/2026/08/how-to-use-ai-agents-in-intellij-idea-with-acp/)
- Bundled agents: Claude Agent, Codex and Junie. More come from the ACP Registry under Settings | Tools | AI Assistant | Agents.
- Custom agents are registered in `~/.jetbrains/acp.json`.

**JetBrains Air**
- A standalone ADE, public preview in **March 2026** (https://blog.jetbrains.com/air/2026/03/...), macOS first, with Windows following in June 2026.
- Runs tasks locally, in Docker or in worktrees. Supports Claude Agent, Codex, Gemini CLI, Junie and any ACP agent.
- Tasks can reference a line, commit, class or symbol. It includes a terminal, git client and preview, sends notifications when an agent needs attention, and added a multiproject view in August 2026.
- On **2026-09-22** (today) JetBrains announced the "Air" system: **Air in JetBrains IDEs**, **Air Teams** and **Air Governance** (formerly JetBrains Central). Source: https://blog.jetbrains.com/blog/2026/09/22/introducing-jetbrains-air/

**Ideas worth stealing**
1. **Tabbed plan document** (requirements / design / stages / testing) with four explicit exits. The "Save the plan and stop" exit is useful.
2. **Semantic permission categories** (readSecretFile, readOutsideProject, edit build scripts, edit hidden/config files) rather than just "commands vs. edits".
3. **First-run import of other agents' instruction and subagent files**, plus a session list that marks sessions owned by another process as read-only.

---

## 9. Conductor (conductor.build) and similar tools

**Conductor** (Mac app; docs at https://www.conductor.build/docs/)

**Model** (https://www.conductor.build/docs/concepts/workspaces-and-branches)
- Project (one repo) → **workspace** = one git worktree = one branch, under `~/conductor/workspaces/<repo>/<workspace>`.
- Each workspace has a secondary city-style directory name (e.g. `warsaw-v2`). The agent is told to **rename the branch on the first chat**.
- A gitignored `.context/` folder holds notes and handoffs.
- "Isolation is development isolation, not a security boundary."

**Creating workspaces**: ⌘⇧N, from a branch, PR, GitHub issue or **Linear issue** (https://www.conductor.build/docs/concepts/workflow).

**Harnesses**: Claude Code, Codex, Cursor and OpenCode, running in tabs within a workspace or across workspaces. A per-harness feature matrix covers Plan Mode, Fast Mode, reasoning level, Codex personalities and goals, checkpoints and skills (https://www.conductor.build/docs/concepts/agent-modes).

**Checkpoints** (https://www.conductor.build/docs/reference/checkpoints)
- Before each agent reply, Conductor captures the branch state in a **private git ref**.
- Hovering a message → revert icon deletes that turn and every later message and reverts the code.
- There is a caution when several chats share one workspace.

**Scripts** (https://www.conductor.build/docs/reference/scripts)
- Defined in `.conductor/settings.toml` (shared) or `.conductor/settings.local.toml`. The legacy `conductor.json` should no longer be used.
- `[scripts] setup / run / archive / run_mode ("concurrent")`, with multiple named run scripts (`[scripts.run.api]`, `available_in = ["local"]`).
- Environment variables: `CONDUCTOR_WORKSPACE_PATH`, `CONDUCTOR_ROOT_PATH`, and **`CONDUCTOR_PORT` (10 ports per workspace)**.
- **"Files to copy"** uses `.worktreeinclude`-style patterns for gitignored files such as `.env`.
- A "Configure with Conductor" prompt has the agent write the settings file itself.

**Testing** (https://www.conductor.build/docs/concepts/testing)
- The **Run** button runs the run script.
- **Spotlight testing** syncs the workspace's tracked changes back to the repo root and tests there, for apps that must run from the root.

**Diff Viewer** (⌘⇧D, https://www.conductor.build/docs/reference/diff-viewer)
- File list, unified view, and **filter by commit**. **Line comments are sent to the agent**, and GitHub review comments are imported.
- A suggested next action ("Create PR").

**Checks tab** (https://www.conductor.build/docs/reference/checks)
- Shows git status, PR metadata, CI, deployments, GitHub review threads and **Todos**.
- **Merge is blocked or discouraged while todos are unresolved or checks fail.** You then merge and archive the workspace.

**Changelog** (https://www.conductor.build/changelog)
- Code review v0.10.0 (2025-09-08). Codex v0.18.0 (2025-10-31). Checkpoints v0.19.0 (2025-11-05). Plan mode v0.21.0 (2025-11-10).
- Todos v0.28.4 (2025-12-30). Scripts editable in the UI v0.31.0 (2026-01-15). Big Terminal Mode v0.48.0 (2026-04-14).
- Multiplayer, API and background tasks v0.77.0 (2026-07-23). **Conductor Cloud** v0.78.0 (2026-07-30).

**Cloud** (https://www.conductor.build/docs/cloud)
- Vercel-hosted Linux sandboxes. One shared **Cloud Computer** image per organization, rebuilt with "Build computer".
- Workspaces and chats are shared org-wide with presence. Handoff through **"Reassign to"**.

**Security** (https://www.conductor.build/docs/reference/security-and-permissions): local agents run with user permissions. Tool approvals are optional. macOS TCC prompts name Conductor. `conductor://` deep links.

**Similar tools** (one line each)
- **Sculptor (Imbue)**: an open-source Mac/Linux desktop app for parallel Claude agents. It has now moved to **git worktrees** from its original containers. **Pairing Mode** syncs an agent's work into your local checkout or IDE. JS/TS plugins can swap the harness for Pi. Sources: https://imbue.com/product/sculptor, repo `imbue-ai/sculptor` active on 2026-09-22.
- **Crystal → Nimbalyst**: Crystal (Stravu, worktree-parallel Claude Code/Codex) became Nimbalyst in Feb 2026 (repo description in `stravu/crystal`). Nimbalyst was open-sourced in April 2026 (secondary sources, **unverified**).
- **Terragon Labs**: a cloud background-agent service that shut down on **2026-02-09** (docs.terragonlabs.com/docs/resources/shutdown; the certificate had expired, so the date comes from the search snippet).
- **Vibe Kanban (BloopAI)**: a Kanban of agent cards, each in its own worktree. Bloop shut down on **2026-04-10**. The project continues as open source and community-maintained, with cloud features removed (https://www.vibekanban.com/blog/shutdown). The repo is still active (about 28k stars).
- **Superset (superset.sh)**: an open-source "agentic IDE" that runs 100+ CLI agents (Claude Code, Codex, OpenCode, Cursor, Copilot, Gemini, etc.) in parallel worktrees with persistent terminals, review and open-in-editor. The repo is very active (about 14.5k stars).
- **Claude Squad (smtg-ai)**: a tmux-and-worktree TUI that manages Claude Code, Codex, OpenCode and Amp sessions (about 8.5k stars, active in August 2026).
- **Cline Kanban**: see §7.

**Ideas worth stealing**
1. **Workspace lifecycle in a committed config**: setup / run / archive scripts plus `CONDUCTOR_PORT` port blocks and "files to copy" for gitignored env files. The agent can write that config itself.
2. **A Checks tab as the merge gate**: CI, review threads, agent-maintained todos and git status in one place, with merge blocked until everything is green.
3. **Checkpoints stored as private git refs per turn** (invisible to branch history). Also create workspaces directly from a PR, issue or Linear ticket, and let the agent rename the branch after the first message.
