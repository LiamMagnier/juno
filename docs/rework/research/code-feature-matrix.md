# Coding-agent feature matrix, September 2026, and what Juno Code still lacks

Date: 2026-09-30. Research for the Juno Refoundation (`rework/refoundation` @ `1feb392c`).
Read-only against the code; this file is the only output.

**Scope.** What a best-in-class coding agent product offers today, row by row, across Claude Code (CLI, Desktop Code tab, web), OpenAI Codex (ChatGPT desktop app Codex mode, CLI), Cursor (IDE, Agents Window, CLI, cloud agents), Grok Build (SpaceXAI CLI), and Devin Desktop (ex-Windsurf) where it adds something. The last column is Juno Code on the Mac today.

**Sources and dating.**
- **[F]** = primary source fetched for this file on 2026-09-30. URLs are in §7.
- **[R22]** = primary source already fetched and cited on 2026-09-22 in `docs/native/code-rework/research/{claude_code,codex,cursor,others}.md`. I did not re-fetch it. Its URL is in that file, and the main ones are repeated in §7.
- **[RX]** = primary source cited on 2026-09-30 in `docs/rework/research/xai-grok.md` (docs.x.ai).
- **UNVERIFIED** = I could not confirm it from a primary source.
- "Not listed" means the vendor's own command or feature list for that surface does not include it. It is not proof of absence.

**The Juno column** comes from the 2026-09-30 audits (`docs/rework/audit/code-runtime-swift.md`, `code-runtime-cloud-remote.md`) plus greps of `native/Packages/JunoCode/Sources`. It uses these words:
- **Have**: present in the code.
- **Partial**: present with a material gap, which the cell names.
- **In flight**: being built now by the separate loop and tools workflow. This file does not re-specify these items:
  - cache prefix, retries, crash-safe batches, malformed JSON, output spill, usage ledger
  - durable shells, multi_edit and multi-file apply_patch, image and PDF reads, grep context
  - todo_write, ask_user, exit_plan, nested AGENTS.md, skill trust
- **Missing**: not found in the code.

---

## 0. Digest

1. **The loop the owner wants has a name everywhere else: a goal with an independent judge.**
   - **Claude Code** `/goal`: after every turn, a small fast model checks a completion condition the user wrote. If the condition is not met, Claude starts another turn by itself. The loop ends when the condition holds, when the judge rules it impossible, after several turns with no tool use, or on an error only a human can fix. It is built on a prompt-based Stop hook [F].
   - **Codex** `/goal`: a persistent objective with pause, resume, edit and clear controls above the composer [F].
   - **Cursor** `/goal`: rolling out, and pairs with a self-paced `/loop` [F].
   - **Juno**: allows one goal per session, ever (audit B10). No judge checks it, and updating it needs approval. Juno already has the pieces underneath: a 200-step loop, Stop hooks and `run_tests`.
2. **"Think about what it has done" is verification, and the leaders make verification automatic.**
   - Claude Desktop auto-verifies after every edit in its Browser pane: screenshots, DOM checks, clicks. It is on by default [F].
   - A language-server plugin feeds type errors back after each edit [F].
   - As of 2026-09-30, a project `verify` skill runs before every commit [F].
   - Cursor's cloud agents prove their work with screenshots and video attached to the pull request [F].
   - Juno has none of these.
3. **Computer use has moved past "screenshot and click".**
   - Claude and Codex both ask **per app**: allow for this session, always allow, or deny [F].
   - Claude caps apps by category: browsers view-only, terminals and IDEs click-only [F].
   - Claude hides every other app, keeps its own window out of screenshots, and aborts on a global Esc that the app swallows [F].
   - Both route tasks to the most precise tool first (connector, then shell, then browser, then simulator), with screen control last [F].
   - Codex can keep working on a **locked** Mac [F].
   - Cursor gives each cloud agent a whole VM desktop that the user can take over [F].
   - Juno already has a good safety envelope: consent per session, one session at a time, rate limits, a kill switch and a journal. What it lacks:
     - per-app grants
     - app hiding
     - Esc abort
     - routing
     - accessibility-tree targeting
     - an iOS Simulator pane
4. **Preview is a pane with a feedback channel.**
   - Claude runs dev servers from `.claude/launch.json`. It can pick an element and send it to the chat, and it asks before touching external sites [F].
   - Codex's built-in browser has an Annotate mode for leaving comments on elements, plus a full DevTools connection (CDP) in Developer mode [F].
   - Cursor's browser tool reads console output and network traffic, and its Design Mode sends selected elements to the agent [F].
   - Juno has a separate preview window and a `preview_browser` tool, but no auto-verify, no element pick and no console feed.
5. **Background runs and dashboards are standard; Juno is the outlier.**
   - Parallel sessions in worktrees, background agents, and one dashboard grouped by what needs you. Claude calls it agent view, Grok the Agent Dashboard, Cursor the Agents Window, Codex the Activity view.
   - Cloud handoff both ways (Claude `--cloud`/`--teleport`, Codex Handoff, Cursor local↔cloud).
   - A pull-request CI loop that polls checks and auto-fixes (Claude Desktop, Cursor Bugbot Autofix).
   - Juno has worktrees and sub-agents. It has no background session list, no live handoff, no CI polling on the Mac, no fork, no export and no archive.
6. **Keep Juno's stricter lines.**
   - No classifier replaces a deterministic approval.
   - A goal never raises the permission mode. Claude's `/goal` keeps the mode too [F].
   - A push or merge from auto-fix still asks.
   - No status dots: the dashboard groups runs by words.

---

## 1. The autonomy loop (the owner's core ask)

How the leaders keep an agent working, checking itself, and working again without a human prompt per step.

| Mechanism | Claude Code | Codex | Cursor | Grok Build | Juno today |
|---|---|---|---|---|---|
| Inner loop: gather, act, verify | Documented as three phases that "blend together… repeating until task complete" [F] | Same pattern; model tools `exec_command`, `apply_patch`, `update_plan` [R22] | "No limit on the number of tool calls" [R22] | Same pattern [RX] | Have: `AgentOrchestrator.runLoop`, 200-step cap (`CodeSettings.swift:260`) |
| Goal with a separate judge | `/goal <condition>`: a small fast model judges after each turn; ≤4,000 chars; replaces the previous goal; `◎ /goal active` timer; verdicts in the transcript; restored on resume; stops after several turns with no tool use; cleared on unrecoverable errors; pauses on usage limits. It does not change the permission mode [F] | `/goal`: persistent objective; progress row above the composer with pause/resume/edit/clear; `/plan` first is recommended; steerable while running [F] | `/goal <objective>` (rolling out); CLI Ctrl+C pauses; pairs with Custom Modes and `/loop` [F] | Not listed in the command table [F] | Partial: `update_goal` is one per session (B10), approval-gated, lives in `system`, and has no judge |
| Stop hook that forces another turn | Stop and SubagentStop `decision:"block"` + reason keeps Claude going; command, prompt or agent hooks [R22]; `/goal` is a session-scoped prompt Stop hook [F] | Stop hook event [R22] (continue semantics UNVERIFIED) | `stop` hook `followup_message`, default `loop_limit` 5 [R22] | Stop fires but "PreToolUse is the only blocking event" [F] | Partial: `.stop` is a blocking event (`HookTypes.swift:59-64`). Whether a block restarts the loop is UNVERIFIED |
| Timed or self-paced re-run | `/loop` with cron tools; `ScheduleWakeup` 1 min–1 h [F][R22] | Thread automations ("heartbeat"), Scheduled [R22] | `/loop` built-in skill; the agent picks its wake time if no interval is given [F] | `/loop` ≥60 s, 7-day expiry, ≤50 active [RX] | Missing |
| Wake on external events | Monitor tool streams output lines; **channels** push CI, chat and webhook events into a running session [F] | Automations from app events [F] | Automations: Slack, GitHub, PagerDuty, webhooks; Projects "Subscriptions" [R22][F] | Monitors: each printed line becomes a notification [RX] | Missing (durable shells are in flight; a monitor-to-wake step is not) |
| Automatic self-verification | Browser `autoVerify` on by default: screenshots, DOM checks, clicks, form fills after edits [F]; LSP diagnostics after each edit [F]; `verify` skill run before commit (2.1.286, 2026-09-30) [F] | Prompting guidance: "after each change, run the same UI flow again" with Computer Use [F] | Cloud agents verify in their VM and attach screenshots, video and logs to the PR [F]; Debug Mode instruments, reproduces and fixes [R22] | Workflows with a "verification" step [F] | Missing: `run_tests` exists but nothing runs by itself |
| CI loop on the PR | Desktop CI bar: polls `gh`, Auto-fix failing checks, Auto-merge (squash), notifies [F]; `/autofix-pr` [R22] | PR status badges, PR Chat, `@codex review` [R22] | Bugbot Autofix; `/autopilot` babysits PRs; Rollouts watches deploy health (2026-09-23) [R22][F] | Not listed | Missing on Mac (web has checks and auto-fix; no Swift caller, cloud audit P3) |
| Fan-out and pick the best | `Workflow` tool: dynamic workflows, `ultracode` [R22] | Subagents (`spawn_agent` …) [R22] | Up to 8 parallel agents; `/best-of-n` with a judge recommending a winner [R22] | `/create-workflow`, `/workflow`, `/deep-research` [F] | Partial: `delegate_task` runs 3 at a time, 18 steps, 10 min |
| Fewer prompts during a long run | Auto mode classifier (server-side by default in some setups since 2.1.283) [F] | `approvals_reviewer = auto_review` [R22] | Auto-review run mode is the default [R22] | Auto mode classifier [F] | Deliberately not copied (03-AUDIT §4). The sandbox plus rules do this job |
| Survive restarts | Resume restores an active goal [F]; background sessions via a supervisor [R22] | Background-server auto-start (CLI 0.157.0, 2026-09-25) [F] | "Continue Interrupted Agents" setting [R22] | Sessions on disk [RX] | In flight (crash-safe batches). Resuming a goal is missing |
| Budget stops | `--max-turns`, `--max-budget-usd` [R22] | Token budget feature (gated) [R22] | UNVERIFIED | UNVERIFIED | Have: turn cap. Partial: spend, since the usage ledger is in flight |

---

## 2. Feature matrix

### 2.1 Sessions

| Row | Claude Code | Codex | Cursor | Grok Build | Juno today |
|---|---|---|---|---|---|
| Resume | `-c`, `-r`, `/resume` picker, `--from-pr` [F] | `codex resume`, `/resume` [R22] | `--resume`, `--continue` [R22] | `/resume`, `/sessions` [F] | Have (`CodeSessionStore`) |
| Fork | `/branch`, `--fork-session`; `/subtask` forks shared-cache subagents [F][R22] | `/fork` into a new local chat or worktree [F]; CLI `f` shortcut keeps drafts (0.157.0) [F] | "Fork Chat" [R22] | `/fork` to a peer agent, optionally in a worktree [F][RX] | Missing (none locally; the relay throws "unsupported") |
| Rewind / checkpoints | `/rewind` or Esc Esc: restore code, conversation, or both; summarize from here; last 100 checkpoints [R22] | No `/undo`; fork from an earlier message; revert from the review pane [R22] | Automatic checkpoints, local and outside git; restore reverts files only [F] | `/rewind` restores files and truncates the conversation [F][RX] | Have: turn rewind of code and/or conversation |
| Archive | Desktop archive; auto-archive after PR merge or close [F] | ⌘⇧A; Archived chats in Settings [R22] | ⌘⇧E archive agent [R22] | `/sessions` close [F] | Missing |
| Search | Picker search; paste a PR URL to find its session [F] | Search chats; ⌘F in chat [R22] | ⌘K conversation search (local index) [R22] | `/find` in scrollback [F] | UNVERIFIED (not found) |
| Export / share | Export transcripts [F]; Artifacts [F] | CLI `/export`; `/share` read-only snapshots [R22] | Shared read-only, forkable transcripts [R22] | `/export`, `/share` [F] | Missing |
| Rename | `/rename`, click the title [R22] | ⌘⌥R [R22] | UNVERIFIED | `/rename` [F] | Have (`WorkbenchModel.renameSession`) |
| Side question | `/btw`, desktop side chat ⌘; [R22] | `/side` [F] | `/side`, `/btw` [R22] | `/btw` [F] | Missing |

### 2.2 Parallelism

| Row | Claude Code | Codex | Cursor | Grok Build | Juno today |
|---|---|---|---|---|---|
| Parallel sessions | Desktop sessions and split panes; `claude agents` agent view [F][R22] | Threads per project; multi-window [R22] | Agents Window, tiled panes [R22] | Multiple sessions + Agent Dashboard [F][RX] | Have (several sessions in Studio) |
| Worktree per session | `--worktree`, Desktop worktree toggle, `.worktreeinclude` [F] | Local / Worktree / Cloud picker; Handoff between Local and Worktree [F] | `/worktree`, native worktrees; `.cursor/worktrees.json` setup [R22] | Per session or per subagent [RX] | Have (landing "isolated worktree"; `WorktreeManager`) |
| Background agents + dashboard | `--bg`; agent view grouped Ready / Needs input / Working / Completed [R22] | Background subagents; Activity view ⌘⌥U [R22] | Async subagents `/multitask`; "Needs Attention" group [R22] | Agent Dashboard: Needs input / Working / Idle / Completed / Failed, inline replies [RX] | Missing (sub-agents are foreground children only) |
| Cloud handoff | `--cloud`, `--teleport`, Desktop "Continue in" [F] | `/cloud`, `/local`, host handoff [F][R22] | Local↔cloud, `&` prefix, `/in-cloud` [R22] | Grok Bot delegates to Cursor Cloud Agents [RX]; not from the CLI (UNVERIFIED) | Partial: a Mac can start a cloud run with a prompt only (cloud audit P3); no live handoff, no pull-back |
| Remote from phone | Remote Control, Dispatch [F] | Codex Remote [F] | iOS Remote Control [R22] | UNVERIFIED | Have (relay; iPhone/iPad) |

### 2.3 Agent

| Row | Claude Code | Codex | Cursor | Grok Build | Juno today |
|---|---|---|---|---|---|
| Plan mode + approval | Plan mode; approve-and-switch options; Ctrl+G edits the plan [R22] | `/plan`; `request_user_input` [F][R22] | Plan Mode: Q&A UI, plan file, Build / Build in Parallel [R22] | Plan review with line comments; auto modes can't skip it [RX] | Have (Plan mode). In flight: exit_plan. Plan mode cannot use `web_fetch` (audit) |
| Todo | Task tools, off by default on newest models [R22] | `update_plan` [R22] | To-dos card [R22] | UNVERIFIED | In flight (todo_write) |
| Subagents / custom agents | Explore, Plan, general; `.claude/agents/*.md` with model, tools, isolation [R22] | `spawn_agent`…; TOML custom agents [R22] | Explore, Bash, Browser; `.cursor/agents` (also reads `.claude/agents`) [R22] | general-purpose, explore, plan; `.grok/agents`, personas [RX][F] | Have (`delegate_task`, custom agent prompt) |
| Skills | SKILL.md; `/skill`; bundled `/verify`, `/run`, `/loop` [R22] | `.agents/skills`, `$skill` [R22] | SKILL.md; skill as a mode (⌥Enter) [R22] | Reads Claude skills and marketplaces [RX] | Have (`.claude/skills`, `.juno/skills`). In flight: trust |
| Hooks | 32 events; command, http, prompt, agent types [R22] | Hooks GA 2026-05-14 [R22] | 18+ events, prompt hooks, `failClosed` [R22] | 13 events; reads Claude and Cursor hook files; project trust [F] | Have (Claude event set; no `PreCompact`) |
| MCP user/project | local, project `.mcp.json`, user scopes; tool search [R22]; `/mcp reconnect all` (2.1.284) [F] | `[mcp_servers]`, OAuth [R22] | One-click, OAuth, MCP Apps [R22] | `/mcps` [F] | Have (per-server consent) |
| Slash commands | ~110 commands + skills [R22] | App and CLI lists [F][R22] | Skills as commands [R22] | ~60 commands [F] | Have (`/boost` and `/teamwork-preview` promise things that don't exist) |
| Output styles / personality | Output styles (Default, Explanatory, Learning…) [R22] | `/personality` [F] | Custom Modes [R22] | `/personas` [F] | Missing |
| Memory | Auto memory, `MEMORY.md` index [R22] | Memories (opt-in), Computer History [F] | Removed in 2.1; Projects' shared context [R22] | `/remember`, `/memory`, `/dream` [F] | Missing in Code (UNVERIFIED) |
| Instruction files | CLAUDE.md tree, rules, native AGENTS.md (2.1.277) [R22] | AGENTS.md root→cwd, 32 KiB cap [R22] | `.cursor/rules`, nested AGENTS.md, CLAUDE.md [R22] | AGENTS.md, CLAUDE.md, `.grok/rules` [RX] | Have (JUNO.md, AGENTS.md, CLAUDE.md). In flight: nested |
| Effort / thinking | `/effort` low…max, separate Ultracode toggle (2.1.284) [F] | `/reasoning` [F] | Model parameters [R22] | `/effort` [F] | Have |
| Model switch mid-session | `/model` (warns about a cache miss) [R22] | `/model` [F] | Model chip [R22] | `/model` [F] | Have (rebuilds the orchestrator; cache miss) |

### 2.4 Tools

| Row | Claude Code | Codex | Cursor | Grok Build | Juno today |
|---|---|---|---|---|---|
| Read / edit / multi-edit / patch | Read (images, PDF, notebooks), Edit, Write [R22] | Multi-file `apply_patch` grammar [R22] | Search & Replace + Apply model [R22] | UNVERIFIED names | Have (read, write, create, apply_patch). In flight: multi_edit, multi-file patch |
| Shell foreground / background | Bash `run_in_background`, Ctrl+B, Monitor [R22] | PTY `exec_command` + `write_stdin`, background terminals [R22] | Shell + Await [R22] | Background tasks + monitors [RX] | Have: foreground. In flight: durable shells |
| Search | bfs/ugrep via Bash, Grep [R22] | Shell `rg` [R22] | Instant Grep (local index) [R22] | UNVERIFIED | Have. In flight: grep context |
| Web search / fetch | WebSearch, WebFetch [R22] | Hosted `web_search` cached/live [R22] | Web search/fetch [R22] | "web tools" [RX] | Have (`web_search`, `web_fetch`) |
| Notebooks | NotebookEdit [R22] | UNVERIFIED | UNVERIFIED | UNVERIFIED | Missing |
| Images / PDF in | Read images and PDFs; paste/drag [R22] | `view_image`, image inputs, Appshots [F] | Images, PDFs (2.4) [R22] | Image input on model [RX] | In flight |
| LSP / diagnostics | Code-intelligence plugins (incl. `swift-lsp`/sourcekit-lsp): diagnostics after every edit, go-to-definition [F] | UNVERIFIED | Editor diagnostics, lint auto-fix [R22] | Project LSP servers (trust-gated) [F] | Missing |
| Computer use | CLI built-in `computer-use` MCP + Desktop; see §3 [F] | Computer Use plugin; see §3 [F] | Cloud VM desktop; self-hosted `--computer-use` [F] | Not in Build docs [F]; Grok Bot uses "separate computers" [RX] | Partial; see §3 |
| Browser / preview | Browser pane, launch.json, auto-verify, Chrome extension; see §4 [F] | Built-in browser, Annotate, Developer mode CDP [F] | Browser tool (console, network), Design Mode [F][R22] | Not listed | Partial; see §4 |
| iOS Simulator | Desktop Simulator pane, one simulator per session, no screen control needed [F] | Via Computer Use [F] | UNVERIFIED | Not listed | Missing |

### 2.5 Review

| Row | Claude Code | Codex | Cursor | Grok Build | Juno today |
|---|---|---|---|---|---|
| Diff viewer | `+12 -1` chip → file list + diff [F] | Review pane scopes Unstaged / Staged / Commit / Branch / Last turn; multi-repo [F] | Review panel, split/unified [R22] | Not listed | Have (Changes side panel) |
| Line comments sent with the next message | Click a line, Enter, then ⌘Enter to submit all [F]; web: "at `src/auth.ts:47`" [R22] | Line-specific feedback in the review pane [F]; browser annotations [F] | Design Mode for UI [R22]; line comments UNVERIFIED | Plan line comments [RX] | Partial: per-**hunk** comments (`StudioSidePanel.swift:176`) |
| Accept / reject hunks | Accept/Reject per change in Manual mode; VS Code per-change [F][R22] | Stage / unstage / revert per hunk, file or all [F][R22] | Keep / Undo per hunk, Keep All [R22] | Not listed | UNVERIFIED (revert hooks exist; no per-hunk UI confirmed) |
| Code review mode | "Review code" in diff: high-signal only [F]; `/code-review`, ultrareview (cloud multi-agent) [F] | `/review` against base, uncommitted, commit or custom; findings don't touch the tree [F] | Agent Review Quick/Deep; `/review` Bugbot + Security [R22] | Via workflows [F] | Partial: a `review` slash command exists; no dedicated read-only reviewer with findings in the diff (UNVERIFIED) |
| PR creation | Create PR (full / draft) [R22] | Commit, push, create PR with AI description [R22] | Commit & Create PR [R22] | Not listed | Have (`CreatePullRequestSheet`) |
| CI status + auto-fix | CI bar, Auto-fix, Auto-merge [F] | PR badges [R22]; auto-fix UNVERIFIED | Bugbot Autofix, `/autopilot` [R22] | Not listed | Missing on Mac |

### 2.6 Permissions

| Row | Claude Code | Codex | Cursor | Grok Build | Juno today |
|---|---|---|---|---|---|
| Modes | Manual, Accept edits, Plan, Auto, Bypass [R22] | Ask for approval, Approve for me, Full access, Custom [R22] | Auto-review, Allowlist, Run Everything; Agent / Ask / Plan / Debug [R22] | Plan, Auto, Always-approve [RX] | Have (plan, askBeforeEdits, autoEdit, fullAccess) |
| Rules | allow / ask / deny, deny wins, per-segment [R22] | execpolicy `prefix_rule` [R22] | `permissions.json` allowlists [R22] | allow / deny, deny wins; dangerous patterns re-prompt even when always-allowed [RX] | Have (`PermissionRules.swift`) |
| Sandbox | Seatbelt / bubblewrap; protected paths [R22] | Seatbelt / bwrap / Windows [R22] | Seatbelt / Landlock, on by default [R22] | Seatbelt / Landlock, **off by default** [RX] | Have (`CommandSandboxProfile`) |
| Network | Proxy; first contact with each host prompts; allow/deny domains [R22] | Off by default; domain proxy rules [R22] | Blocked unless allowed [R22] | macOS network restriction is a no-op [RX] | UNVERIFIED (no per-host prompt found) |
| Per-command "always" | "Yes, and don't ask again for `npm run *`" [R22] | "don't ask again for commands that start with…" [R22] | Add to allowlist [R22] | Remembered grant [RX] | Have (saves the shown rule) |

### 2.7 UX

| Row | Claude Code | Codex | Cursor | Grok Build | Juno today |
|---|---|---|---|---|---|
| Notifications | OS notification; push via Remote Control [F][R22] | Turn done / needs you [F] | OS notification + sound, Live Activities [R22] | Notification hook [F] | Have |
| Status line / cost | `statusLine` script; `/usage` dollar amounts (2.1.284) [F] | `/status`, `/usage` [F][R22] | `/statusline` [R22] | Status Line [F] | Partial (the in-flight usage ledger feeds it) |
| Context meter | `/context` grid, usage ring [R22] | `/status`; opt-in donut [F][R22] | Context ring + breakdown tray [R22] | `/context` [F] | Have |
| Keyboard | Full map, rebindable [R22] | Rebindable, searchable [R22] | Full map [R22] | Keyboard shortcuts page [F] | Have |
| Command palette | `/` picker; Cmd+/ lists shortcuts [R22] | ⌘K / ⌘⇧P [R22] | ⌘K [R22] | `/help` [F] | Have (`CodeCommandPaletteView`) |
| @file | Fuzzy `@` [R22] | `@` files, skills, apps [R22] | `@` files, terminals, chats, commit [R22] | UNVERIFIED | UNVERIFIED |
| Drag-drop images | Images / PDFs [R22] | Shift-drag, paste [R22] | Paste / drag, gallery [R22] | UNVERIFIED | Have (`onDrop` in composer/session) |
| Voice | Voice dictation [F] | Dictation ⌃⇧D, voice ⌃⇧V [R22] | Hold Ctrl+M [R22] | Not listed | Have (UNVERIFIED for the Code surface specifically) |

### 2.8 Integrations and headless

| Row | Claude Code | Codex | Cursor | Grok Build | Juno today |
|---|---|---|---|---|---|
| GitHub | App, Code Review, `@claude` [F] | `@codex review`, GitLab [F][R22] | `@cursor`, Bugbot [F] | UNVERIFIED | Partial (`gh`-based PR sheet) |
| Linear / Jira | Via MCP | Codex in Linear [F] | Linear, Jira [F][R22] | Via MCP | Via MCP only |
| Slack | Claude Tag / Claude Code in Slack [F] | ChatGPT in Slack → Codex Cloud [F] | Slack [F] | UNVERIFIED | Missing |
| Headless exec | `claude -p`, stream-json, `--json-schema` [R22] | `codex exec --json`, read-only by default [F] | `agent -p` [R22] | `grok -p` [F] | Missing (no Mac CLI) |
| SDK / protocol | Agent SDK (Python, TS) [F] | Codex SDK; app-server JSON-RPC [F][R22] | `@cursor/sdk` TS + Python; ACP [F] | ACP [F] | Missing (cloud audit proposes `contracts/agent/`) |
| GitHub Action | Claude Code GitHub Actions [F] | Codex GitHub Action [F] | GitHub integration [F] | UNVERIFIED | Partial: the cloud runner uses Actions internally; not user-facing |

---

## 3. Computer use: exact comparison and the Juno fix list

| Property | Claude CLI | Claude Desktop | Codex (ChatGPT app) | Cursor | Juno |
|---|---|---|---|---|---|
| How it is switched on | Built-in `computer-use` MCP, off by default, enabled per project in `/mcp`; Pro/Max; macOS; not in `-p` | Settings > General toggle; macOS and Windows | Computer Use plugin + Settings > Computer use | Cloud VM always; self-hosted worker `--computer-use` | Explicit per-session activation + vision model |
| OS grants | Accessibility + Screen Recording, with links | Same, status shown in Settings | Same | macOS helper app | Same (`ComputerUsePermission`) |
| App scope | Asks per app per session; approve several at once | Allow for this session / Deny; **Denied apps** list | Per-app prompt with **Always allow**; list in Settings | Whole VM | **None**: acts on the whole main display |
| Category caps | Browsers and trading apps view-only; terminals and IDEs click-only; the rest full | Same | Cannot automate terminal apps or ChatGPT itself; cannot approve admin prompts | n/a | None |
| Warnings | Terminal = "shell access", Finder = "any file", System Settings | Same | "Sensitive or disruptive actions" re-ask | n/a | None |
| Isolation while working | Hides other apps; the terminal stays visible but is **excluded from screenshots**; restored after the turn | Hides unless running in the background; "Unhide apps when Claude finishes" | macOS background; Windows takes the foreground | Separate VM; human takeover | None |
| Stop | Notification "press Esc to stop"; global Esc aborts and the key press is consumed | Stop button | Stop / take over | Take over | Kill switch in the UI; no global key |
| One at a time | Lock file; held until the session exits | UNVERIFIED | UNVERIFIED | Per VM | Have |
| Screenshots | Downscaled to about 1372×887 | UNVERIFIED | Model choice: GPT-6 Astra for visual work | Artifacts, video | JPEG at display points; image rewritten after each turn (cache and thinking loss, audit §3.5) |
| Routing | MCP → Bash → Chrome → computer use | Connector → Bash → Chrome → **iOS Simulator pane** → computer use | "Prefer the built-in browser" for local web apps; plugin before screen | n/a | None (no routing guidance) |
| Locked Mac | No | No | **Locked use** via a macOS authorization plug-in; relocks on local input | n/a | No |

**Fix list for Juno** (order matters; every item keeps the existing coordinator as the safety boundary):
1. **Per-app grants.**
   - The model names an app, or `@AppName` in the prompt. The prompt offers *Allow for this session* or *Deny*.
   - Add a persistent *Always allow* list, a *Denied apps* list, and a fixed category cap:
     - browsers: view only
     - terminals, IDEs and Juno itself: click only, or refused
     - everything else: full
   - Clicks and keys aimed at a window of a non-granted app are refused **in the coordinator**, not left to the prompt. The frontmost-app check happens before injection.
2. **Isolation and stop.**
   - Hide non-granted apps during a turn and restore them after.
   - Exclude Juno's own windows from capture (ScreenCaptureKit `excludingWindows`).
   - Post a system notification "Juno is using your Mac · press Esc to stop".
   - A global Esc monitor aborts the action and consumes the key.
3. **Tool routing** in the system prompt and the tool descriptions:
   - MCP or connector, then shell, then the preview browser, then the simulator, then screen control.
4. **Precise targeting.**
   - Add an accessibility-tree read (`computer_find` returning element refs), click-by-ref and drag.
   - Support multiple displays.
   - Downscale to a fixed size with a scaling factor.
   - Add a zoom capture for small text.
5. **Keep screenshots stable in history** so cache and thinking survive (audit §3.5; coordinate with the in-flight cache-prefix work).
6. **iOS Simulator pane.**
   - `simctl` boot, install and launch, with screenshots and taps inside the simulator, one per session.
   - It needs no screen-control grant.
7. **Later.**
   - Background operation on non-frontmost windows.
   - Locked use. Weigh it against Juno's approval rules; likely *not* for Juno.

---

## 4. Preview: exact comparison and the Juno fix list

| Property | Claude Desktop | Codex | Cursor | Devin Desktop | Juno |
|---|---|---|---|---|---|
| Where | Browser **pane** among chat, diff, terminal, file and plan panes; tabbed; ⌘⇧B | Built-in browser in the side panel | Inline pane or separate window; layouts | Editor tab | Separate `CodePreviewWindow` |
| Server config | `.claude/launch.json`: multiple configs, `cwd`, `env`, `autoPort`, `program`; Claude writes the first one | Local environment actions / setup scripts [R22] | `.cursor/worktrees.json` setup; cloud Builds [R22] | UNVERIFIED | `DevServerService` discovery; no config file |
| Auto-verify | **On by default**: screenshot, DOM, click, form fill after edits; `"autoVerify": false` per project | Prompted, not automatic | Cloud agents verify before the PR | UNVERIFIED | Missing |
| Agent tools | Screenshots, DOM, click, fill | Screenshots, click, type; **Developer mode** full CDP (console, network, profiling) with approval | Navigate, click, type, scroll, screenshot, **console output, network traffic**; logs written to files the agent greps | Console errors to context | `preview_browser` snapshot / click / type / select / scroll / wait / assert_text, `inspect_preview` |
| Human → agent pointing | Select element ⌘⇧S [R22] | **Annotate** comments on elements + **Adjust** style values | **Design Mode**: click, multi-select, draw; sends xpath, component and styles | **Send element** as an @mention | Missing |
| External sites | Allow once / Always allow / Deny per site; classifier on writes; localhost free | Allowed and blocked sites in Settings > Browser | Allow and block lists | UNVERIFIED | UNVERIFIED |
| Session persistence | "Persist sessions" (cookies, storage) | Browsing history controls | Per workspace | UNVERIFIED | UNVERIFIED |
| Opens files | HTML, PDF, images, video from chat paths | Artifact viewer | Canvases | UNVERIFIED | Static server (`StaticPreviewServer`) |

**Fix list for Juno:**
1. Make Preview a **pane** in the session layout, beside Changes and Terminal, with pop-out. The window becomes the pop-out.
2. Add `.juno/launch.json`. Also read `.claude/launch.json` as-is, for compatibility.
   - Multiple servers, `autoPort`, per-project `autoVerify`.
   - Juno drafts the first config and shows it before it runs, because running a command is an approval.
3. **Auto-verify after edits.**
   - After a turn that touched web files, `preview_browser` snapshots, asserts and screenshots before the turn may end.
   - A failure feeds the next step instead of ending the turn. This is the "look at what it did" half of the loop.
4. Feed **console errors and failed network requests** to the agent as a tool, plus an automatic "new console errors since last edit" line.
5. **Element pick.** Click in the Preview, and the element (selector, text, box, computed styles, a crop) becomes a composer attachment. Allow several, each with a note, Codex Annotate style.
6. **External sites** use Allow once / Always / Deny per origin; localhost is free.

---

## 5. Still missing in Juno on top of the in-flight work (prioritised)

**P0: the autonomy loop the owner asked for**
1. **Goal loop with a judge.** Replaces the single `update_goal`; fixes B10.
   - `/goal <condition>` or a goal field on the composer.
   - After each turn, a cheap model judges met / not met / impossible from the transcript and writes a one-line reason into the thread.
   - Not met starts the next turn.
   - Stop conditions:
     - N turns with no tool call
     - a hard error the user must fix
     - the plan limit
     - a turn or time clause in the goal text
   - Pause, resume, edit and clear sit above the composer, in words.
   - The goal is restored on resume.
   - One goal at a time, but replaceable.
   - Never changes the permission mode.
   - Precedent: Claude `/goal` [F], Codex `/goal` [F], Cursor `/goal` [F].
2. **Verification by default.** Each has to pass before a turn may claim "done":
   - diagnostics after edits (sourcekit-lsp or `swift build` for Swift, `tsc` for TS)
   - Preview auto-verify (§4.3)
   - a project `verify` skill run before any commit
   - Precedent: Claude LSP plugins, `autoVerify`, verify-before-commit [F].
3. **Stop-hook continue plus a self-paced `/loop`.**
   - A Stop hook that returns block with a reason starts another turn, capped by a loop limit.
   - `/loop [interval] <prompt>`, where the agent picks its own interval if none is given.
   - Monitor-to-wake on top of the in-flight durable shells.
   - Precedent: Claude, Cursor `followup_message`/`loop_limit` [R22], Grok `/loop` [RX].
4. **A Runs view for background sessions.**
   - Start, detach and keep running.
   - One list grouped by *Needs you / Working / Ready for review / Done / Failed* **in words**, with inline answer and steer.
   - Precedent: Claude agent view, Grok Dashboard, Cursor Agents Window [R22][RX].
5. **The PR CI loop on the Mac.**
   - After a PR, poll checks with `gh`, show the result in the thread, and offer *Fix failing checks*.
   - The fix runs as a goal. The push asks every time, following the owner's deterministic-approval rule.
   - Precedent: Claude Desktop CI bar [F], Cursor Bugbot Autofix [R22].

**P0: computer use and preview.** These are §3 items 1–4 and §4 items 1–5.

**P1**
- Fork a session (`/branch`), export, archive (plus auto-archive after the PR merges), and session search that accepts a PR URL.
- Side question (`/btw`).
- **Line-level** review comments (not hunk-level).
- Review scopes: Unstaged / Staged / Branch / Last turn.
- Per-hunk stage and revert.
- A read-only reviewer that posts findings into the diff.
- iOS Simulator pane (§3.6).
- Per-host network prompts in the sandbox.
- Cloud handoff both ways from the Mac.
- `juno exec` headless mode, and an ACP or app-server protocol for the engine. This lines up with the cloud audit's `contracts/agent/`.

**P2**
- Output styles.
- Code memory.
- Notebooks.
- Fan-out workflows with best-of-n judging.
- Slack.
- Channels, meaning external events pushed into a session.

**Do not copy**
- Classifier auto-approval replacing deterministic approvals.
- Sandbox off by default (Grok).
- Auto-merge without a human.
- Colored status dots in the Runs view.
- Locked-Mac unlock (Codex).

---

## 6. Dates that matter (for re-checking later)

- **Claude Code**
  - 2.1.286 on 2026-09-30: verify-before-commit.
  - 2.1.284 on 2026-09-28: Sonnet 5.5, `/usage` dollar amounts, Ultracode toggle.
  - 2.1.283 on 2026-09-25: server-side auto-mode classifier by default in some setups.
  - Source: [F] changelog.
- **Codex**
  - CLI 0.159.0–0.159.2 and GPT-6.1 Sol on 2026-09-29.
  - CLI 0.157.0 on 2026-09-25: fork shortcut and background-server auto-start.
  - Source: [F] changelog.
- **Cursor**
  - 2026-09-23: Rollouts and Security Review.
  - 2026-09-10: Projects.
  - Source: [F] changelog.
- **Grok Build**: the CLI shipped on 2026-05-25 and was open-sourced on 2026-07-15 [RX]. Its docs pages are undated [F].

---

## 7. Sources

Fetched 2026-09-30 [F]:
- Claude Code changelog: https://code.claude.com/docs/en/changelog
- Claude Code docs index: https://code.claude.com/docs/llms.txt
- Computer use (CLI): https://code.claude.com/docs/en/computer-use.md
- Desktop (preview, diff, CI bar, computer use, launch.json): https://code.claude.com/docs/en/desktop.md
- Goal: https://code.claude.com/docs/en/goal.md
- How Claude Code works: https://code.claude.com/docs/en/how-claude-code-works.md
- Sessions: https://code.claude.com/docs/en/sessions.md
- Code intelligence plugins: https://code.claude.com/docs/en/plugins/code-intelligence.md
- Other Claude pages checked: code-review, scheduled-tasks, agent-view, checkpointing, github-actions, routines, channels, chrome (same base URL + `.md`)
- Codex changelog: https://learn.chatgpt.com/docs/changelog
- Codex docs index: https://learn.chatgpt.com/llms.txt
- Codex Computer Use: https://learn.chatgpt.com/docs/computer-use.md
- Codex Browser: https://learn.chatgpt.com/docs/browser.md
- Codex slash commands: https://learn.chatgpt.com/docs/reference/slash-commands.md
- Codex code review: https://learn.chatgpt.com/docs/code-review.md
- Codex worktrees: https://learn.chatgpt.com/docs/environments/git-worktrees.md
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode.md
- Other Codex pages checked: codex-sdk, github-action, third-party/linear, remote, notifications, image-inputs (same base URL + `.md`)
- Cursor changelog: https://cursor.com/changelog
- Cursor docs index: https://cursor.com/llms.txt
- Cursor agent overview (checkpoints, `/goal`): https://cursor.com/docs/agent/overview.md
- Cursor cloud agent capabilities: https://cursor.com/docs/cloud-agent/capabilities.md
- Cursor browser tool: https://cursor.com/docs/agent/tools/browser.md
- Cursor self-hosted computer use: https://cursor.com/docs/cloud-agent/self-hosted/computer-use.md
- Grok Build overview: https://docs.x.ai/build/overview.md
- Grok Build modes and commands: https://docs.x.ai/build/modes-and-commands.md
- Grok Build hooks: https://docs.x.ai/build/features/hooks.md
- Grok Build sessions: https://docs.x.ai/build/features/sessions.md
- xAI docs index: https://docs.x.ai/llms.txt

Cited from the 2026-09-22 research files [R22] (primary URLs listed inside each file):
- `docs/native/code-rework/research/claude_code.md`: code.claude.com/docs/en/{tools-reference, permission-modes, permissions, sandboxing, sub-agents, hooks, skills, statusline, headless, commands}
- `docs/native/code-rework/research/codex.md`: learn.chatgpt.com/docs/{hooks, agent-configuration/*, sandboxing, permission-modes, reference/settings}, the openai/codex repo @ d93909a
- `docs/native/code-rework/research/cursor.md`: cursor.com/docs/{agent/*, hooks, subagents, reference/permissions}, cursor.com/blog/{cursor-3, agent-autonomy-auto-review, design-mode}
- `docs/native/code-rework/research/others.md`: docs.devin.ai/desktop/{previews, devin-local, changelog}

Cited from `docs/rework/research/xai-grok.md` [RX]:
- docs.x.ai/build/features/{plan-mode, permissions, sandbox, subagents, worktrees, background-tasks, dashboard}
- x.ai/news/grok-build-cli (2026-05-25)
- x.ai/news/grok-build-open-source (2026-07-15)

Juno evidence:
- `docs/rework/audit/code-runtime-swift.md` and `docs/rework/audit/code-runtime-cloud-remote.md` (2026-09-30)
- `native/Packages/JunoCode/Sources/JunoCodeCore/ComputerUse.swift`
- `JunoCodeLocal/ComputerUseCoordinator.swift`
- `JunoCodeRuntime/Tools/ComputerUseTools.swift`
- `JunoCodeUI/Views/Preview/CodePreviewInspectionTool.swift`
- `JunoCodeUI/Studio/StudioSidePanel.swift`
- `JunoCodeLocal/Extensibility/HookTypes.swift`
- `JunoCodeUI/Models/WorkbenchModel.swift`
