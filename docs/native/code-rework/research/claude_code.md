# Claude Code (Anthropic) — competitor audit notes

Research date: 2026-09-22. Primary sources: code.claude.com/docs/en/* raw markdown (fetched 2026-09-22 via `https://code.claude.com/docs/en/<page>.md`; index at https://code.claude.com/docs/llms.txt, 197 pages), changelog at https://code.claude.com/docs/en/changelog (generated from https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md). Latest version at time of research: **v2.1.280, September 22, 2026** ("Added Claude Opus 5.5 (`claude-opus-5-5`), now the default Opus model — 1M context"). Docs pages are undated; version gates quoted in docs (e.g. "requires v2.1.2xx") are the best dating signal. Where I could not verify, marked "unverified".

Surfaces: CLI (terminal TUI), Claude Desktop app "Code" tab (macOS universal, Windows x64/ARM64, Linux beta), Claude Code on the web / cloud sessions (claude.ai/code + mobile), VS Code extension, JetBrains plugin (runs CLI in IDE terminal), Slack/Claude Tag, Agent SDK.

---------------------------------------------------------------------
## A. AGENT LOOP & RUNTIME
---------------------------------------------------------------------

### A1. Built-in tools (current list) — https://code.claude.com/docs/en/tools-reference
Exact names (used in permission rules, subagent `tools`, hook matchers):
- `Agent` — spawn subagent (separate context window; parent sees only final result). With agent teams, a call with `name` launches a teammate. (Formerly called `Task`.)
- `Artifact` — publish HTML/Markdown file as private interactive page on claude.ai (Pro/Max/Team/Ent).
- `AskUserQuestion` — multiple-choice questions; stays open until answered (optional `askUserQuestionTimeout` 60s/5m/10m with 20s countdown).
- `Bash` — shell; separate process per command; cwd carries over within project/additional dirs; env vars do NOT persist; shell aliases/functions captured from ~/.zshrc etc. at session start. Default timeout 2 min (`BASH_DEFAULT_TIMEOUT_MS`), max 10 min (`BASH_MAX_TIMEOUT_MS`). Output inline up to ~30,000 chars (valid) / ~10,000 (failure, head+tail excerpt); beyond → saved file path + 2,000-char preview. `run_in_background: true` for dev servers; commands hitting timeout are auto-moved to background ("Command did not complete within its 120s timeout and was moved to the background").
- `CronCreate` / `CronDelete` / `CronList` — session-scoped scheduled prompts (/loop).
- `Edit` — exact string replacement (`old_string` → `new_string`, optional `replace_all`); no regex/fuzzy. Checks: read-before-edit (newer models can edit unread files if reading wouldn't need a prompt, v2.1.208+), exact match, uniqueness. `cat/head/tail/sed -n/grep/rg` on a single file via Bash also counts as a read.
- `EndConversation` — ends session on sustained abuse (v2.1.213+).
- `EnterPlanMode` / `ExitPlanMode` — enter plan mode; present plan for approval.
- `EnterWorktree` / `ExitWorktree` — create/switch into isolated git worktree.
- `Glob` / `Grep` — **absent by default on macOS/Linux/WSL**: Claude uses `find`/`grep` through Bash, which run embedded `bfs` and `ugrep`. Return if you name them in `--tools/--allowedTools`, if Bash is denied, or a subagent lists them without Bash. Glob: sorted by mtime, capped 100 files, ignores .gitignore by default. Grep: ripgrep, modes `files_with_matches` (default) / `content` / `count`, `glob`/`type`/`multiline` params, respects .gitignore.
- `ListAgents` — list agents Claude can message (subagents, teammates, other local sessions, cloud sessions via Remote Control).
- `ListMcpResourcesTool` / `ReadMcpResourceTool`.
- `LSP` — code intelligence (definitions, references, type errors after each edit) — inactive until a code-intelligence plugin is installed.
- `Monitor` — background command whose each output line streams back to Claude (tail logs, poll CI, WebSocket source).
- `NotebookEdit` — Jupyter cells.
- `PowerShell` — native PowerShell (Windows; opt-in).
- `PushNotification` — desktop notification + phone push when Remote Control connected.
- `Read` — absolute paths, line-numbered; images (resized; >500KB re-encoded JPEG), PDFs (>10 pages read by `pages` range, max 20/time), notebooks; `PARTIAL view` notice when over token limit; no directories.
- `RemoteTrigger` — create/run Routines on claude.ai (backs `/schedule`).
- `ReportFindings` — structured code-review findings (v2.1.196+).
- `ScheduleWakeup` — self-paced `/loop` rescheduling (1 min–1 h).
- `SendFeedback` — drafts feedback report locally for user review (v2.1.238+).
- `SendMessage` — message teammate / resumed subagent / another Claude Code session (cross-session v2.1.224+).
- `SendUserFile` — send files to user's device (`display: render|attach`).
- `ShareOnboardingGuide` — upload ONBOARDING.md from `/team-onboarding`.
- `Skill` — execute a skill in main conversation.
- `SubagentHandback` — auto-mode only; delivers subagent final report.
- `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` — task checklist (replaced `TodoWrite`). **Only default on Claude 3.x, Opus 4–4.7, Sonnet 4–4.6, Haiku 4.5** (v2.1.268+); newer models get no checklist tools unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` ("On newer models, Claude keeps track of multi-step work without a written checklist").
- `TaskOutput` (deprecated → Read the output file), `TaskStop` (stop background task / teammate / named background agent; transcript label "Stop Task").
- `TodoWrite` — legacy checklist; disabled by default; `CLAUDE_CODE_ENABLE_TASKS=0` re-enables it.
- `ToolSearch` — load deferred tools (MCP tool search).
- `WaitForMcpServers` — wait for MCP servers still connecting.
- `WebFetch` — URL + prompt; HTML→Markdown; a small fast model answers the prompt against page (Claude gets the answer, not raw page).
- `WebSearch`.
- `Workflow` — run a "dynamic workflow" script orchestrating many subagents in background.
- `Write` — create/overwrite whole file (read-before-overwrite rules same as Edit for newer models, v2.1.228+).
- Legacy `MultiEdit` is mentioned only as "the legacy `MultiEdit` tool" (permissions doc) — no longer in tool list.
- Advisor tool is an API server tool (no permission name). https://code.claude.com/docs/en/advisor

Rule format for tools (tools-reference): `Bash(npm run *)` (Bash, Monitor), `PowerShell(Get-ChildItem *)`, `Read(~/secrets/**)` (Read, Grep, Glob, LSP), `Edit(/src/**)` (Edit, Write, NotebookEdit), `Skill(deploy *)`, `Agent(Explore)`, `WebFetch(domain:example.com)`, `WebSearch` (no specifier). `Edit(...)` allow also grants read. `Read(...)` deny also blocks Edit/Write on that path (v2.1.208/v2.1.228).

### A2. How edits are applied
- str_replace style (Edit), full-file Write. File snapshots before each edit for rewind (`fileCheckpointingEnabled`, default true).
- In Manual mode each edit shows a diff permission prompt; in acceptEdits/auto edits apply and are reviewable after (`/diff`, desktop diff view `+12 -1` indicator). https://code.claude.com/docs/en/desktop-quickstart
- LSP tool reports type errors after each edit (if plugin installed).

### A3. Permission modes — https://code.claude.com/docs/en/permission-modes
| Mode (config value) | UI label | Runs without asking |
|---|---|---|
| `default` | **Manual** (label + `manual` alias since v2.1.200) | Reads only |
| `acceptEdits` | Accept edits / VS Code "Edit automatically" | Reads, file edits, common FS cmds (`mkdir touch rm rmdir mv cp sed`) in working dirs |
| `plan` | Plan | Reads (+ classifier-approved commands when auto mode available, `useAutoModeDuringPlan` default on) |
| `auto` | Auto | Everything, with background classifier ("a separate classifier model reviews actions before they run") |
| `dontAsk` | (CLI only) | Reads + pre-approved; anything that would prompt is denied (CI) |
| `bypassPermissions` | Bypass permissions | Everything (`--dangerously-skip-permissions`) except "actions no mode auto-approves" |
- **Auto is the built-in starting mode on Pro/Max/Team** (v2.1.228+ macOS/Linux; v2.1.233+ Windows). Default on Enterprise/API key/`-p`/SDK/Bedrock/Vertex/Foundry is `default`.
- Auto mode requirements: Opus 4.6+/Sonnet 4.6+/Fable models on Anthropic API. Admin kill: `permissions.disableAutoMode: "disable"`. Classifier blocks by default e.g. `curl | bash`, sending sensitive data externally; trusts working dir + git remotes present at session start. Server-side classifier review for Enterprise/API/3P (v2.1.278+).
- Status bar labels (CLI): gray `⏸ manual mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on`, `⏵⏵ auto mode on`, `⏵⏵ don't ask on`, bypass variant.
- **Shift+Tab** cycles: from auto → default → acceptEdits → plan → (bypassPermissions if enabled) → (auto if available) → default. `dontAsk` never in cycle.
- Bash prompt option "Yes, and switch to auto mode" (v2.1.247+).
- Plan approval options: "Yes, and use auto mode" (or "Yes, auto-accept edits" / "Yes, and switch to BYPASS PERMISSIONS…"), "Yes, manually approve edits", "No, keep planning"; optional first option "approve + clear context" (`showClearContextOnPlanAccept`). `Ctrl+G` opens plan in $EDITOR. Accepting plan auto-titles session. `/plan` prefix enters plan mode for one prompt.
- Protected paths never auto-approved (except bypass): `.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`, `.claude` (except `.claude/worktrees`), plus shell rc files, `.npmrc`, `.mcp.json`, `.claude.json`, etc.
- Critical paths: `rm`/`rmdir` targeting `/`, `~` etc. never approved by allow rules or hooks.
- Bypass refuses to run as root/sudo; first-run warning dialog; blocked by `permissions.disableBypassPermissionsMode: "disable"`.
- Desktop: mode selector next to send button (Manual / Accept edits / Plan / Auto / Bypass permissions); bypass needs "Allow bypass permissions mode" toggle (Settings → Claude Code) on Pro/Max. Mode pick remembered **per folder** (except Plan = session only). Older desktop labels were "Ask permissions, Auto accept edits, Plan mode". https://code.claude.com/docs/en/desktop
- VS Code: mode indicator at bottom of prompt box; labels Manual / Edit automatically / Plan / Auto / Bypass permissions; `claudeCode.initialPermissionMode`; "Allow dangerously skip permissions" toggle.
- Cloud sessions: Accept edits (=default, edits pre-approved), Plan, Auto; no bypass. Remote Control: Manual, Accept edits, Plan.

### A4. Permission rules — https://code.claude.com/docs/en/permissions
- Format `Tool` or `Tool(specifier)`. Evaluation order **deny → ask → allow**, first match wins; specificity doesn't matter; any-scope deny beats any-scope allow. Bare-name deny (e.g. `Bash`) removes the tool from Claude's context entirely.
- Bash wildcards: `Bash(npm run *)`, `Bash(git log * main)`, `Bash(* --version)`; `Bash(ls *)` ≠ `Bash(ls*)` (space matters); `:*` suffix = trailing wildcard (`Bash(ls:*)`). Compound commands (`&&`, `|`) matched per subcommand; built-in read-only command set runs without prompt.
- Parameter rules (deny/ask only): `Agent(model:opus)`, `Agent(isolation:worktree)`, `Bash(run_in_background:true)`.
- Tool-name globs: deny `"*"`, `"mcp__*"`; allow only `mcp__server__*`.
- Read/Edit: gitignore syntax; `//abs/path`, `~/home/path`, `/relative-to-settings-source`, `./relative-to-cwd`. Example `Read(./.env)`, `Read(./secrets/**)`, `Edit(/src/**/*.ts)`.
- WebFetch: `WebFetch(domain:example.com)`, `WebFetch(domain:*.example.com)` (v2.1.172+ wildcards).
- MCP: `mcp__puppeteer`, `mcp__puppeteer__*`, `mcp__puppeteer__puppeteer_navigate`.
- Agents: `Agent(Explore)`, `Agent(Plan)`, `Agent(my-agent)`, `Agent(fork)`.
- `Cd(~/code/**)` rules restrict `/cd`.
- Prompt answers: "Yes" / "Yes, and don't ask again for …" (saves to `.claude/settings.local.json` at repo root; Bash & WebFetch permanent per repo; file edits "until session end") / "No". **Tab** on Yes/No adds a comment ("No" + comment = tell Claude what to do differently and it continues; "No" without comment stops the turn).
- `/permissions` dialog lists rules + source file, editable mid-turn (v2.1.234+); "Auto mode" tab shows classifier rules.
- Working dirs: `--add-dir`, `/add-dir`, `permissions.additionalDirectories`; `/cd <path>` moves session primary dir (loads new CLAUDE.md, settings, MCP, trust prompt). `permissions.blockReadsOutsideWorkingDirectories`.
- Workspace trust dialog gates project allow rules/hooks/additionalDirectories.
- PreToolUse hooks run before prompt; can't override deny/ask rules; exit 2 blocks before rules.

### A5. Sandboxing — https://code.claude.com/docs/en/sandboxing
- Bash sandbox: built into Claude Code on macOS (Seatbelt, nothing to install), Linux/WSL2 (bubblewrap + socat; optional seccomp filter). Native Windows unsupported. Released v2.0.24 (Oct 20, 2025) "Sandbox: Releasing a sandbox mode for the BashTool on Linux & Mac" (changelog).
- `/sandbox` panel tabs: **Mode** (auto-allow vs regular permissions), **Overrides** (`allowUnsandboxedCommands` escape hatch), **Config** (resolved settings), **Dependencies** (Linux). Choice saved to `.claude/settings.local.json`.
- Auto-allow mode: sandboxed commands run without prompting; deny rules, critical-path rm, and content-scoped ask rules (e.g. `Bash(git push *)`) still apply. Commands that can't be sandboxed fall back to normal permission flow; prompt titled "Bash command (unsandboxed)". Claude may retry with `dangerouslyDisableSandbox` (unsandboxed retry escape hatch) — disabled by `allowUnsandboxedCommands: false`.
- Filesystem: default write = cwd + added dirs + session temp ($TMPDIR set to it); default read = whole machine except denied dirs (docs warn this includes ~/.aws, ~/.ssh — use `sandbox.credentials` or `denyRead`). `sandbox.filesystem.allowWrite/denyWrite/denyRead/allowRead` (narrower rule wins). Protected (unwritable even inside sandbox): `.claude` settings/skills/agents/commands/hooks, `.mcp.json`, shell rc files, `.git/hooks`, `.git/config`, `~/.claude`.
- Network: proxy outside sandbox; **no domains pre-allowed by default**; first connection to new host prompts (Yes = session, "Yes, and don't ask again" saves `WebFetch(domain:...)` rule). `sandbox.network.allowedDomains`, `deniedDomains`, `strictAllowlist`, `allowManagedDomainsOnly`, `allowUnixSockets`, `allowLocalBinding`, `httpProxyPort`, `socksProxyPort`, experimental `tlsTerminate` (v2.1.199+). In auto mode, Claude names needed hosts per command for classifier review.
- Credentials: `sandbox.credentials.files/envVars/awsPairs/sigv4` masking/re-signing.
- Standalone `@anthropic-ai/sandbox-runtime` (github.com/anthropic-experimental/sandbox-runtime, Apache-2).
- Blog: "Beyond permission prompts: making Claude Code more secure and autonomous" https://claude.com/blog/beyond-permission-prompts-making-claude-code-more-secure-and-autonomous (page shows Oct 8, 2025; engineering version https://www.anthropic.com/engineering/claude-code-sandboxing, widely reported Oct 20, 2025) — "sandboxing safely reduces permission prompts by 84%" internally. Cloud git creds stay outside sandbox behind a proxy with scoped credentials.
- Auto mode engineering post (Mar 25, 2026): https://www.anthropic.com/engineering/claude-code-auto-mode — two layers: server-side prompt-injection probe on tool outputs + transcript classifier (stage 1 fast single-token filter, stage 2 CoT on flagged). Classifier sees user messages + tool calls only (assistant text and tool results stripped). Stats on n=10,000 real traffic: full pipeline 0.4% FPR, 17% FNR on overeager actions. UX: block returns as tool result telling Claude to find safer path ("deny-and-continue"); escalates to human after 3 consecutive / 20 total denials. Spinner turns red when a permission check stalls (changelog v2.1.126, May 1, 2026).

### A6. Plan mode & task tracking
- Plan mode: read + explore, writes a plan (plan file persisted; re-injected after compaction; `plansDirectory` setting); approval dialog as above; VS Code opens plan as full Markdown doc with inline comments; Ctrl+G edit plan in $EDITOR. `opusplan` model alias = Opus in plan mode, Sonnet for execution. Built-in "Plan" subagent does research during plan mode.
- Task list: `TaskCreate/Get/List/Update` (TodoWrite legacy). Ctrl+T toggles checklist (shows up to 5). Persists across compaction; `CLAUDE_CODE_TASK_LIST_ID` shares a list across sessions in `~/.claude/tasks/`. Not provided by default on newest models (Opus 5.x / Sonnet 5 / Fable) as of v2.1.268 — https://code.claude.com/docs/en/tools-reference#task-tool-availability.

### A7. Subagents — https://code.claude.com/docs/en/sub-agents
- Built-ins: **Explore** (read-only, inherits main model capped at Opus; thoroughness quick/medium/very thorough), **Plan** (read-only research in plan mode), **general-purpose** (all tools), plus `claude` (catch-all), `statusline-setup` (Sonnet), `claude-code-guide` (Haiku). Explore/Plan skip CLAUDE.md + git status for speed.
- Locations & priority: managed > `--agents` JSON flag > `.claude/agents/` (walks up to repo root; closest wins) > `~/.claude/agents/` > plugin `agents/`. Hot-reloaded (watcher).
- File = Markdown with YAML frontmatter; body is the subagent's system prompt (it does NOT receive the Claude Code system prompt).
- Frontmatter fields: `name` (req), `description` (req), `tools`, `disallowedTools`, `model` (`sonnet|opus|haiku|fable|<full id>|inherit`), `permissionMode`, `maxTurns`, `skills` (preload), `mcpServers`, `hooks`, `memory` (`user|project|local` persistent memory), `background`, `omitClaudeMd`, `effort`, `isolation: worktree`, `color` (`red blue green yellow purple orange pink cyan`), `initialPrompt`, `experimental.cacheTtl`.
- Foreground vs background: **fork mode is on by default in interactive sessions (v2.1.232+)** → subagents run in background; background subagents surface permission prompts in main session naming the subagent (v2.1.186+). Ctrl+B backgrounds running task. Concurrent limit 20 (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).
- Forks: `/subtask <task>` (v2.1.212+; formerly `/fork`) — inherits full conversation, shares prompt cache; appears in a panel below prompt (↑/↓ rows, Enter opens transcript to send follow-ups, x stops). Result arrives as message.
- Agent teams (CLI only, experimental `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`), teammates in split panes (tmux/iTerm2) — https://code.claude.com/docs/en/agent-teams.
- Dynamic workflows (`Workflow` tool, `/workflows`, bundled `/deep-research`) — scripts fanning out many subagents in background — https://code.claude.com/docs/en/workflows.
- `/agents` UI to create/manage; `Agent(name)` permission rules; subagent transcripts via `/tasks`.

### A8. Background tasks / shells / sessions
- Bash `run_in_background`; **Ctrl+B** moves a running Bash call (or all running foreground tasks, unified since v2.1.0, Jan 7 2026) to background; tmux users press twice. Output to file, Claude reads it with Read (TaskOutput tool removed). `/tasks` lists/stops shells, subagents, workflows; `t` teleports to cloud sessions. Timed-out commands auto-background. Monitor tool streams lines.
- **Background sessions / Agent view** (research preview): `claude agents` full-screen table grouped Pinned / Ready for review / Needs input / Working / Completed; state icon colors: Working animated, Needs input yellow, Idle dimmed, Completed green, Failed red, Stopped grey; shape `✻`/animated `✽` = process alive, `∙` = exited, `✢` = /loop sleeping. Row summaries from Haiku-class model (updated ≤ every 15 s from own output; model rewrite every few min). Peek & reply, attach (←/detach), `claude --bg`, `/background` or `←` sends current session to background; supervisor process keeps them alive; `claude attach/logs/stop/respawn/rm <id>`; prompt footer shows `← 2 agents` waiting count. https://code.claude.com/docs/en/agent-view
- Cross-session messaging (`SendMessage`, `ListAgents`, v2.1.224+) — https://code.claude.com/docs/en/cross-session-messaging.

### A9. Context & compaction — https://code.claude.com/docs/en/context-window
- Auto-compact on by default (`autoCompactEnabled`); window configurable `autoCompactWindow` 100k–1M tokens, `/autocompact 500k`, `--autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Clears old tool outputs first, then summarizes. `/compact [focus instructions]`; "Compact Instructions" section in CLAUDE.md steers it. Thrash protection stops after a few attempts.
- After compaction: system prompt/output style kept; root CLAUDE.md + unscoped rules + auto memory + plan re-injected from disk; fresh git status; up to 5 most-recently-modified files re-read (>5k tokens → "Referenced file"); skill bodies re-injected (5k/skill, 25k total); background tasks keep running; SessionStart hooks with `compact` source rerun.
- `/context` colored grid of usage by category. MCP tools deferred via ToolSearch by default. 1M context on Fable, Sonnet 5, Opus 4.6+ (Opus 5.5 1M, released v2.1.280 Sep 22 2026).
- `/rewind` → "Summarize from here" / "Summarize up to here" (partial compaction).
- Resume from summary dialog when resuming >1h-idle session >100k tokens (Pro/Max).

### A10. CLAUDE.md / memory — https://code.claude.com/docs/en/memory
- Load order (broad→specific, concatenated, not overriding): Managed policy (`/Library/Application Support/ClaudeCode/CLAUDE.md` macOS; `/etc/claude-code/CLAUDE.md` Linux/WSL; `C:\Program Files\ClaudeCode\CLAUDE.md`) → user `~/.claude/CLAUDE.md` → project `./CLAUDE.md` or `./.claude/CLAUDE.md` (every ancestor dir from root down to cwd) → `./CLAUDE.local.md` (appended after CLAUDE.md in each dir). Subdirectory CLAUDE.md load lazily when Claude reads files there. HTML block comments stripped. Files up to 4 MiB loaded.
- Imports `@path/to/file` (relative to the importing file; max depth 4 hops; ignored inside code spans); external imports trigger an approval dialog once.
- `.claude/rules/*.md` (recursive), optional `paths:` frontmatter for path-scoped rules; `~/.claude/rules/` user rules; `claudeMdExcludes`.
- **AGENTS.md** read natively when no CLAUDE.md/CLAUDE.local.md present (v2.1.277+, Sep 18 2026); "Project instructions" setting `claude-md-and-agents-md` etc.
- **Auto memory** (added v2.1.59, Feb 26 2026): Claude writes notes in `~/.claude/projects/<project>/memory/` — `MEMORY.md` index (first 200 lines/25KB loaded each session) + topic files with frontmatter `type: user|feedback|project|reference`, `modified` timestamp. UI shows "Saved 2 memories"/"Recalled 2 memories". Toggle via `/memory`, `autoMemoryEnabled`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`; `autoMemoryDirectory`. Shared across worktrees of a repo; machine-local.
- `/memory` lists memory files (incl. not-yet-existing), toggle auto memory, open folder; opens in $EDITOR. `/init` generates CLAUDE.md.
- **`#` shortcut**: introduced v0.2.54 (Apr 2, 2025, "Quickly add to Memory by starting your message with '#'"), **removed v2.0.70 (Dec 15, 2025)** ("Removed # shortcut for quick memory entry (tell Claude to edit your CLAUDE.md instead)"). Theme still has `memoryBackgroundColor` token for "#" memory entries (legacy).

### A11. Checkpoints / rewind — https://code.claude.com/docs/en/checkpointing
- Checkpoint = state captured before each user prompt that starts a turn; file snapshots kept for last 100 checkpoints; persisted with the conversation (rewind works after resume); cleaned after ~30 days.
- Open with `/rewind` or **Esc Esc** on empty input (with text, double-Esc clears input instead, saved to history). Menu lists each prompt; actions: **Restore code and conversation**, **Restore conversation**, **Restore code**, **Summarize from here**, **Summarize up to here**, **Never mind** (optional "add context" instructions on summarize rows). After restoring conversation, original prompt goes back in input for edit/resend. Entry for pre-`/clear` session.
- Limitations: Bash-made file changes not tracked; subagent edits generally not restored; external changes not tracked; mid-turn queued messages not checkpointed; symlinks skipped.
- Launched with Claude Code 2.0 (v2.0.0, Sep 29, 2025): https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously ("tapping Esc twice or using the /rewind command"). VS Code: Esc-twice rewind picker (v2.1.83, Mar 25 2026), "Fork conversation from here".
- Toggle in `/config` "Rewind code (checkpoints)" (`fileCheckpointingEnabled`).

### A12. Worktrees & parallel sessions — https://code.claude.com/docs/en/worktrees
- `claude --worktree <name>` / `-w` (v2.1.49, Feb 19 2026): creates `.claude/worktrees/<name>/` on branch `worktree-<name>`; auto-name like `bright-running-fox`; `--tmux` opens tmux/iTerm2 panes. `.worktreeinclude` copies gitignored files (.env). `EnterWorktree`/`ExitWorktree` tools; subagent `isolation: worktree` (auto-cleaned if no changes). Settings `worktree.baseRef`, `worktree.symlinkDirectories`, `worktree.sparsePaths`, `worktree.bgIsolation`. WorktreeCreate/WorktreeRemove hooks for non-git VCS.
- Desktop: "worktree" option next to branch name per session; stored `<project-root>/.claude/worktrees/` (configurable "Worktree location" + branch prefix in Settings → Claude Code); archive icon removes; "Auto-archive after PR merge or close".

### A13. Sessions: resume / continue / fork / name — https://code.claude.com/docs/en/sessions
- `claude --continue`/`-c` (most recent in cwd), `--resume`/`-r` [id|name|path.jsonl] (picker), `--from-pr <n>`, `/resume`, `claude -n <name>`, `/rename`, `/branch [name]` (copy conversation & switch), `--fork-session` with -c/-r. Picker keys: ↑↓, →← expand groups, Enter, Space preview, Ctrl+R rename, `/` search (paste PR URL), Ctrl+A all projects, Ctrl+W all worktrees, Ctrl+B current branch.
- Auto-generated session titles via Haiku-class model; plan acceptance retitles; default display name `my-app-3f`.
- Transcripts JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`; `cleanupPeriodDays` default 30.

### A14. Cloud handoff — https://code.claude.com/docs/en/claude-code-on-the-web
- Cloud sessions (research preview; Pro/Max/Team/Ent premium seats) run on Anthropic-managed VMs; environments control network (Trusted default, custom allowlist), env vars, setup scripts.
- `claude --cloud "task"` (old `--remote` deprecated alias) creates a new cloud session from current repo's GitHub remote/branch; live setup checklist; `--cloud -p <session>` queues message into existing session. CLI handoff is one-way ("you can't push an existing terminal session to the cloud"); `claude --teleport [id]`, `/teleport` (`/tp`), `/tasks` → `t`, "Open in > Terminal" on web pull a cloud session + branch locally.
- Historical: `&` prefix to "Send background tasks to Claude Code on the web" added v2.0.45 (Nov 18, 2025) — not in current docs (status unverified/likely superseded by `--cloud`).
- Desktop: "Continue in" menu → Claude Code on the Web (pushes branch, summarizes conversation, new cloud session; needs clean tree) or Your IDE. `/desktop` moves a CLI session into Desktop. Remote Control (`/remote-control`, `claude remote-control`) steers local sessions from phone/web.
- Auto-fix PRs (Claude GitHub App): watches CI + review comments, pushes fixes, replies labeled as Claude Code; `/autofix-pr`.
- Projects (cloud coordinator conversation of many sessions) — https://code.claude.com/docs/en/claude-projects; Routines (scheduled/API/GitHub-triggered cloud runs) — https://code.claude.com/docs/en/routines.

### A15. Steering while running / queue / interrupt — https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works
- Enter while Claude works → message queued, listed above input (gray until Claude starts on it). If Claude is mid tool calls, queued message is injected as soon as those calls finish **within the same turn** (steering). Commands/shell commands queued until turn ends. **Ctrl+Enter** (or Ctrl+X Ctrl+S) = interrupt and send queued now (v2.1.275, Sep 17 2026). **Up** from first line pulls queued messages back into the input for editing. `/model`, `/effort`, `/fast` execute immediately.
- **Esc** interrupts (cancels running tool call; queued messages then sent). Ctrl+C interrupt/clear input; Ctrl+X Ctrl+K stops all background subagents. Up after interrupt restores prompt and rewinds (v2.1.x).
- Desktop: stop button interrupts; typing + Enter sends correction without stopping ("Claude reads the correction as soon as the current action completes"). Web: queued messages removable via ✕.
- `/btw` side question (no tools, doesn't enter history; `f` forks into background subagent); Desktop side chat Cmd+;.
- Queue feature dates back to v0.2.75 (Apr 21, 2025) "Hit Enter to queue up additional messages while Claude is working".

### A16. Hooks — https://code.claude.com/docs/en/hooks (32 events, verified from raw headings)
Events: `SessionStart` (matchers startup|resume|clear|compact|fork), `Setup` (init|maintenance), `InstructionsLoaded`, `UserPromptSubmit`, `UserPromptExpansion`, `MessageDisplay`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionDenied`, `Notification` (permission_prompt, idle_prompt, auth_success, elicitation_dialog, elicitation_url_dialog, elicitation_complete, elicitation_response, agent_needs_input, agent_completed, quota_auto_resume_fired/stale/disabled), `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `SessionEnd`, `Elicitation`, `ElicitationResult`.
- Handler types: `command`, `http`, `mcp_tool`, `prompt` (single LLM call), `agent` (subagent w/ tools). Fields: `matcher` (exact/`|` list or regex), `if` (permission-rule syntax filter, e.g. `Bash(rm *)`), `timeout` (600 s default command; 30 s prompt; 60 s agent), `statusMessage`, `async`, `asyncRewake`, `once` (skills), `shell` bash|powershell.
- Input JSON on stdin: session_id, prompt_id, transcript_path, cwd, permission_mode, effort, hook_event_name, (+ tool_name, tool_input, tool_use_id…). Exit 0 = success (stdout JSON parsed); exit 2 = block (stderr to Claude); others = non-blocking error.
- Output: PreToolUse `hookSpecificOutput.permissionDecision` allow|deny|ask|defer + reason + `updatedInput` + `additionalContext`; PermissionRequest `decision.behavior` allow|deny (+updatedInput); PostToolUse `updatedToolOutput`; Stop/SubagentStop `decision: "block"` + reason keeps Claude going; SessionStart `additionalContext`, `initialUserMessage`, `watchPaths`, `sessionTitle`, `reloadSkills`; MessageDisplay `displayContent`; universal `continue`, `stopReason`, `suppressOutput`, `systemMessage`.
- Config locations: user/project/local settings, managed, plugin `hooks/hooks.json`, skill & subagent frontmatter. `/hooks` browser (read-only in CLI; VS Code can add/edit, v2.1.269). Env: `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_EFFORT`, `CLAUDE_CODE_REMOTE`. `disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls`. Hooks released v1.0.38 (Jun 30, 2025).

### A17. Skills — https://code.claude.com/docs/en/skills
- `SKILL.md` in `.claude/skills/<name>/`, `~/.claude/skills/`, plugin `skills/`; custom commands merged into skills (`.claude/commands/*.md` still works). Follows Agent Skills open standard (agentskills.io). Added v2.0.20 (Oct 16, 2025).
- Frontmatter: `name`, `description`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility`.
- Substitutions: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`. Dynamic context: `` !`cmd` `` runs before sending.
- Bundled skills: `/doctor`, `/code-review`, `/batch`, `/debug`, `/loop`, `/claude-api`, `/run`, `/verify`, `/run-skill-generator`, `/simplify`, `/security-review`, `/fewer-permission-prompts` etc. `Skill(name *)` rules; `skillOverrides`; synced claude.ai skills.

### A18. Plugins & marketplaces — https://code.claude.com/docs/en/plugins, /discover-plugins, /plugin-marketplaces
- Plugin dir: `.claude-plugin/plugin.json` manifest + root-level `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `monitors/monitors.json`, `bin/` (added to Bash PATH), `settings.json`. Namespaced skills `/plugin-name:skill`.
- `/plugin` UI (Discover/Installed/Marketplaces tabs); `/plugin install github@claude-plugins-official`; official marketplace `claude-plugins-official` auto-added; `/plugin marketplace add owner/repo`; community `anthropics/claude-plugins-community`. Scopes user/project/local. `claude plugin eval` (v2.1.269). Plugins released v2.0.12 (Oct 9, 2025).
- Desktop: + → Plugins → Add plugin (browser) / Manage plugins.

### A19. MCP — https://code.claude.com/docs/en/mcp
- Transports: HTTP, SSE, stdio, WebSocket; `claude mcp add ...`, `claude mcp add-json`, `claude mcp add-from-claude-desktop`, `claude mcp login`. Scopes: local (default, in `~/.claude.json` per project), project (`.mcp.json`, approval prompt), user. `/mcp` panel (auth, status ⚠). Tool search defers MCP tools (default since v2.1.7, Jan 14 2026). claude.ai connectors auto-available. Elicitation support. `enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `allowedMcpServers`, `deniedMcpServers`, `managedMcpServers`.

### A20. Output styles — https://code.claude.com/docs/en/output-styles
- Built-ins: **Default**, **Proactive**, **Concise**, **Explanatory** ("Insights"), **Learning** (adds `TODO(human)` markers). Custom Markdown files in `~/.claude/output-styles`, `.claude/output-styles`, managed; frontmatter `name`, `description`, `keep-coding-instructions`. Switch via `/output-style <name>` or `/config` → Output style; saved to `.claude/settings.local.json` (`outputStyle`). Released v1.0.81 (Aug 14, 2025).

### A21. Status line — https://code.claude.com/docs/en/statusline
- `statusLine: {type:"command", command, padding, refreshInterval, hideVimModeIndicator}`; `/statusline` has a subagent generate one. Script gets JSON on stdin: model.id/display_name, cwd/workspace.{current_dir,project_dir,added_dirs,git_worktree,repo}, cost.{total_cost_usd,total_duration_ms,total_api_duration_ms,total_lines_added/removed}, context_window.{total_input_tokens,context_window_size,used_percentage,remaining_percentage,current_usage}, fast_mode, effort.level, thinking.enabled, rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}, prompt_cache.{warm,ttl,expires_at,...}, session_id, session_name, version, output_style.name, vim.mode, agent.name, pr.{number,url,review_state}, worktree.*. Re-runs on new assistant message, /compact, mode change, vim toggle, timer; 300 ms debounce; ANSI colors, multi-line, OSC 8 links; `COLUMNS`/`LINES` env. `subagentStatusLine`. Released v1.0.71 (Aug 7, 2025).

### A22. Headless / SDK — https://code.claude.com/docs/en/headless, /agent-sdk/overview
- `claude -p "..."` with `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--include-partial-messages`, `--include-hook-events`, `--json-schema` (structured output), `--max-turns`, `--max-budget-usd`, `--allowedTools`, `--permission-mode dontAsk`, `--permission-prompt-tool`, `--bare` (skip auto-discovery), `--no-session-persistence`, `--append-system-prompt(-file)`, `--system-prompt(-file)`. Agent SDK (Python & TypeScript) = same loop/tools/context mgmt; supports hooks, subagents, custom tools, sessions, file checkpointing, todo tracking.

### A23. Models / effort / thinking — https://code.claude.com/docs/en/model-config
- Aliases: `default`, `best`, `fable`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`. On Anthropic API (Sep 2026): `opus` → Opus 5.5 (v2.1.280), `sonnet` → Sonnet 5; `fable` → Fable 5.1.
- Effort levels `low|medium|high|xhigh|max` (model-dependent); Opus 5.5 defaults `medium`; `/effort` slider (Enter = save as default per model, `s` = this session only); `ultracode` = xhigh + dynamic workflows. `ultrathink` keyword rendered in rainbow gradient. Thinking on by default (Option+T toggles; `alwaysThinkingEnabled:false` to disable where supported); thinking collapsed, Ctrl+O shows gray italic. Fast mode `/fast` (Option+O). Advisor tool `/advisor`.
- Model picker Option+P / `/model`; model switch warns about prompt-cache miss.

---------------------------------------------------------------------
## B. SETTINGS
---------------------------------------------------------------------
Sources: https://code.claude.com/docs/en/settings (hierarchy), https://code.claude.com/docs/en/settings-reference (231 keys in the "Settings index"), https://code.claude.com/docs/en/env-vars (366 env vars), https://code.claude.com/docs/en/managed-settings.

### B1. Settings files & precedence
- Files: **User** `~/.claude/settings.json`; **Shared project** `.claude/settings.json` (commit); **Project local** `.claude/settings.local.json` (auto-added to global git excludes when Claude Code writes it); **Managed** (`managed-settings.json` on disk, MDM/Group Policy, or server-managed settings from claude.ai admin console). Plus `~/.claude.json` (global config: auth, MCP servers, per-project trust, "global config keys" like `autoConnectIde`, `copyOnSelect`, `diffTool`). `CLAUDE_CONFIG_DIR` relocates ~/.claude.
- Precedence high→low: **Managed > Command line (`--settings`, flags) > Project local > Shared project > User**. Env vars aren't a level; per-pair rules (e.g. `ANTHROPIC_MODEL` beats `model`). A few security keys honor a stricter lower-level value over managed.
- List keys (e.g. `permissions.allow`, sandbox filesystem arrays) **merge** across files; exceptions `fallbackModel`, `modelPicker`, `availableModels`, `modelSettings`.
- Permission deny at any level can't be re-allowed elsewhere.
- Cloud sessions read only the repo's `.claude/settings.json` (single-repo sessions) + server-managed settings; not user/local.
- Edits to settings files apply live for many keys ("When edits take effect"); `/status`/`claude doctor` show resolved settings & errors.
- Example keys written automatically: `/config` writes user settings; "Yes, don't ask again" writes local settings; `/sandbox` mode writes local.

### B2. /config UI (terminal only; Desktop's /config opens Settings → Claude Code; web opens claude.ai settings)
`/config` has a **Config** tab (plus Status/Usage-type tabs per `/status`). Rows documented in settings-reference ("Appears in /config as"): **Theme**, **Editor mode** (normal/vim), **Verbose output**, **Auto-compact**, **Rewind code (checkpoints)**, **Local notifications** (preferredNotifChannel), **Push when Claude decides**, **Push when actions required**, **Reduce motion**, **Show tips**, **Show turn duration**, **Terminal progress bar**, **Auto-scroll**, **Copy on select**, **Diff tool**, **Respect .gitignore in file picker**, **Question auto-continue timeout**, **Continue automatically at usage limit**, **Dialog expiry**, **Use auto mode during plan**, **Switch models when a message is flagged**, **Enable Remote Control for all sessions**, **Auto-connect to IDE (external terminal)**, **Auto-install IDE extension**, **Show last response in external editor**, **Claude-drafted feedback**, **Dynamic workflows**, **Dynamic workflow size**, **Ultracode keyword trigger**, **Prompt suggestions**, **Session recap**, **Artifacts**, **Output style**, **Auto-update channel** (latest/stable), (Model via `/model`). `/config key=value` sets directly (e.g. `/config verbose=true`). Mouse-clickable in fullscreen (v2.1.271).
Other TUI settings commands: `/theme` (picker + custom theme editor with live preview; Ctrl+T toggles syntax highlighting), `/model`, `/effort`, `/fast`, `/output-style`, `/statusline`, `/permissions`, `/sandbox`, `/hooks`, `/memory`, `/keybindings` (`~/.claude/keybindings.json`, rebindable actions e.g. `chat:sendNow`, `transcript:exit`, `confirm:yes`), `/terminal-setup`, `/tui fullscreen|default`, `/focus`, `/vim`, `/voice`, `/color` (session color), `/scroll-speed`, `/privacy-settings`.

### B3. FULL settings.json key list (from Settings index, grouped by docs topic; [scope]; generated 2026-09-22)

#### Model and responses
- `advisorModel` [Any file] — Pick which model answers when Claude asks the advisor tool
- `alwaysThinkingEnabled` [Any file] — Turn extended thinking off for every session
- `availableModels` [Any file] — Restrict which models people can pick
- `effortLevel` [Any file] — Set a default effort level for models without a saved level of their own
- `enforceAvailableModels` [Any file] — Keep the `/model` Default choice inside your `availableModels` allowlist
- `fallbackModel` [Any file] — Name backup models for when the primary is overloaded
- `fastMode` [Any file] — Turn fast mode on for sessions where it's available
- `fastModePerSessionOptIn` [Any file] — Require people to turn fast mode on each session
- `language` [Any file] — Have Claude respond in a language other than English
- `maxEffortLevel` [Any file] — Cap the effort level for every model or per model, on every provider
- `model` [Any file] — Change the model Claude Code starts with
- `modelOverrides` [Any file] — Map model IDs to your provider's IDs, such as Bedrock ARNs
- `modelPicker` [User or managed] — Choose which models the `/model` picker lists, in your own order and with your own labels
- `modelPricing` [Managed] — Report spend at your organization's contracted rates instead of list price
- `modelSettings` [Any file] — Keep a saved effort level per model, or cap one model's effort
- `outputStyle` [Any file] — Change Claude's role, tone, and output format with an output style
- `promptCacheTtl` [Any file] — Choose the prompt cache lifetime for the main conversation
- `showThinkingSummaries` [Any file] — See summaries of Claude's thinking instead of a collapsed stub
- `subagentPromptCacheTtl` [Any file] — Choose the prompt cache lifetime for subagents and other requests outside the main conversation
- `switchModelsOnFlag` [Any file] — Switch models automatically or pause when a safety classifier flags a request
- `ultracode` [Any file] — Have Claude plan a workflow for each substantive task without being asked

#### Agents, sessions, and worktrees
- `agent` [Any file] — Start every session as a named subagent with its prompt, tools, and model
- `crossSessionInbound` [Any file] — Choose whether Claude Code delivers messages from your other sessions, shows a notice without delivering them, or refuses them
- `disableAgentView` [Any file] — Turn off background agents and agent view
- `isolatePeerMachines` [Any file] — Ask you before Claude messages one of your sessions on another machine
- `processWrapper` [User or managed] — Run Claude Code's background processes through a corporate launcher on macOS and Linux
- `teammateMode` [Any file] — Choose how agent team teammates display
- `worktree` [Any file] — Configure how Claude Code creates git worktrees
- `worktree.baseRef` [Any file] — Branch new worktrees from the remote default branch or your local HEAD
- `worktree.bgIsolation` [Any file] — Let background sessions edit the working copy without a worktree
- `worktree.sparsePaths` [Any file] — Check out only the directories you need in each worktree
- `worktree.symlinkDirectories` [Any file] — Symlink large directories into each worktree instead of duplicating them

#### Remote, desktop, and notifications
- `agentPushNotifEnabled` [Any file] — Let Claude send a push notification to your phone when it decides to
- `awaySummaryEnabled` [Any file] — Turn off the session recap shown when you come back to the terminal
- `disableArtifact` [Any file] — Deprecated; use `enableArtifact` to turn the Artifact tool off
- `disableDeepLinkRegistration` [Any file] — Stop Claude Code from registering the `claude-cli://` handler
- `disableDesktopLocalSessions` [Managed] — Turn off Desktop Code sessions that run on the device, leaving SSH to other hosts and cloud
- `disableRemoteControl` [Any file] — Turn off Remote Control everywhere it can start
- `enableArtifact` [Any file] — Turn the Artifact tool off with a `false` in any file; no file can turn it back on
- `inputNeededNotifEnabled` [Any file] — Get a push notification when Claude is waiting on you
- `preferredNotifChannel` [Any file] — Choose a terminal bell or desktop notification for task completion
- `remote.defaultEnvironmentId` [Any file] — Pick the default cloud environment for `claude --cloud`; a self-hosted `ccpool_` ID is read only from user and managed settings and `--settings`
- `remoteControlAtStartup` [Any file] — Connect Remote Control automatically when a session starts
- `sshConfigs` [User or managed] — Add SSH connections to the Desktop environment dropdown
- `sshHostAllowlist` [Managed] — Limit which hosts Desktop SSH sessions can reach

#### MCP
- `allowAllClaudeAiMcps` [Managed] — Load the claude.ai connectors Claude Code fetches itself alongside a deployed `managed-mcp.json`
- `allowManagedMcpServersOnly` [Managed] — Make the managed MCP allowlist the only one that applies
- `allowedMcpServers` [Any file] — Allowlist which MCP servers users can add
- `deniedMcpServers` [Any file] — Block specific MCP servers by URL, command, or name
- `disableClaudeAiConnectors` [Any file] — Turn off claude.ai connectors so Claude Code doesn't fetch them
- `disabledMcpjsonServers` [Any file] — Reject specific servers from a project's `.mcp.json`
- `enableAllProjectMcpServers` [Any file] — Approve every server in project `.mcp.json` files without a prompt
- `enabledMcpjsonServers` [Any file] — Approve specific servers from a project's `.mcp.json`
- `managedMcpServers` [Managed] — Provide remote MCP servers to every user alongside the ones they add

#### Plugins and skills
- `allowedChannelPlugins` [Managed] — Replace the default allowlist of channel plugins that can push messages
- `blockedMarketplaces` [Managed] — Block plugin marketplace sources for your organization
- `channelsEnabled` [Managed] — Allow channels for your organization
- `disableBundledSkills` [Any file] — Turn off the skills and workflows included with Claude Code
- `disableCommandPluginSources` [Managed] — Block plugins that install by running a marketplace-declared command
- `disableSkillShellExecution` [Any file] — Stop skills and custom commands from running inline shell
- `enabledPlugins` [Any file] — Turn individual plugins on or off per scope
- `extraKnownMarketplaces` [Any file] — Register marketplaces for a repository or an organization
- `pluginConfigs` [User or managed] — Store the answers you gave a plugin's configuration dialog
- `pluginSuggestionMarketplaces` [Managed] — Choose which marketplaces can surface plugin install suggestions in `/plugin`
- `pluginTrustMessage` [Managed] — Add your own text to the plugin trust warning
- `skillOverrides` [Any file] — Hide or collapse a skill without editing its SKILL.md
- `strictKnownMarketplaces` [Managed] — Allowlist the marketplace sources users can add and install from
- `strictPluginOnlyCustomization` [Managed] — Block skills, agents, hooks, and MCP servers from user and project sources
- `strictPluginOnlyCustomization.agents` [Managed] — Lock agents to plugin and managed sources
- `strictPluginOnlyCustomization.hooks` [Managed] — Lock hooks to plugin and managed sources
- `strictPluginOnlyCustomization.mcp` [Managed] — Lock MCP servers to plugin and managed sources
- `strictPluginOnlyCustomization.skills` [Managed] — Lock skills to plugin and managed sources
- `syncClaudeAiPlugins` [User, local, or managed] — Stop loading the plugins enabled on your claude.ai account and stop downloading new ones
- `syncClaudeAiSkills` [User, local, or managed] — Stop loading the skills enabled on your claude.ai account and stop downloading new ones

#### Hooks and automation
- `allowManagedHooksOnly` [Managed] — Run only the hooks your organization deploys
- `allowedHttpHookUrls` [Any file] — Limit which URLs HTTP hooks can target
- `disableAllHooks` [Any file] — Turn off hooks, a custom status line, and a custom `@` file suggestion command at once
- `disableWorkflows` [Any file] — Turn dynamic workflows off for everyone; use `enableWorkflows` for yourself
- `enableWorkflows` [Any file] — Turn dynamic workflows on or off against your plan's default
- `hooks` [Any file] — Run your own commands as hooks at points in Claude Code's lifecycle
- `httpHookAllowedEnvVars` [Any file] — Limit which env vars HTTP hooks can put in headers
- `workflowKeywordTriggerEnabled` [Any file] — Let the word `ultracode` in a prompt start a workflow; set `false` to type it without starting one
- `workflowSizeGuideline` [Any file] — Set the agent count Claude aims for in dynamic workflows

#### Permission settings
- `allowManagedPermissionRulesOnly` [Managed] — Make managed settings the only settings source of permission rules
- `autoMode` [User or managed] — Add your own allow and deny rules to the auto mode classifier
- `autoMode.classifyAllShell` [User or managed] — Send every shell command through the auto mode classifier, even ones a narrow allow rule matches
- `disableAutoMode` [Any file] — Remove auto mode from the permission mode cycle
- `permissions` [Any file] — Set allow, ask, and deny rules and the starting permission mode
- `permissions.additionalDirectories` [Any file] — Give Claude file access to directories outside the current one
- `permissions.allow` [Any file] — Approve listed tool uses without a prompt
- `permissions.ask` [Any file] — Always prompt before listed tool uses
- `permissions.blockReadsOutsideWorkingDirectories` [Any file] — Make the file tools refuse reads outside the working directories in every permission mode
- `permissions.defaultMode` [Any file] — Set the permission mode new sessions start in
- `permissions.deny` [Any file] — Block listed tool uses, including reads of files that hold secrets
- `permissions.disableBypassPermissionsMode` [Any file] — Prevent anyone from entering bypassPermissions mode
- `skipAutoPermissionPrompt` [User or managed] — Skip the one-time notice Claude Code shows when you first enter auto mode yourself rather than through the built-in default
- `skipDangerousModePermissionPrompt` [User, local, or managed] — Skip the confirmation dialog before bypassPermissions mode
- `useAutoModeDuringPlan` [User, local, or managed] — Let the auto mode classifier review shell commands in plan mode; set `false` to get prompts instead

#### Authentication and providers
- `apiKeyHelper` [Any file] — Generate the API credential with your own command
- `awsAuthRefresh` [Any file] — Refresh expired Bedrock credentials in `.aws` with your own command
- `awsCredentialExport` [Any file] — Supply Bedrock credentials as JSON from your own command
- `forceLoginGatewayUrl` [Managed] — Set the gateway URL the login screen connects to
- `forceLoginMethod` [Any file] — Restrict login to claude.ai, Claude Console, or a cloud gateway
- `forceLoginOrgUUID` [Any file] — Pin claude.ai logins to your organization; only a managed source enforces it
- `gatewayInternalNetworks` [Managed] — Let `/login` reach a cloud gateway on public IPv4 space your organization uses internally
- `gcpAuthRefresh` [Any file] — Refresh Google Cloud credentials with your own command
- `otelHeadersHelper` [Any file] — Generate rotating OpenTelemetry headers with your own command

#### Interface and terminal
- `askUserQuestionTimeout` [User or managed] — Let an unanswered question auto-continue after idle time
- `autoContinueAtUsageLimit` [User or managed] — Wait in the open session and continue the task automatically after a claude.ai usage limit resets
- `autoScrollEnabled` [Any file] — Follow new output to the bottom in fullscreen rendering
- `axScreenReader` [Any file] — Render screen-reader friendly output
- `bashEditDiffEnabled` [User or managed] — Record the files that changed while a Bash command ran in every permission mode
- `companyAnnouncements` [Any file] — Show your organization's announcements at startup
- `defaultShell` [Any file] — Choose whether Bash or PowerShell runs the shell commands you type with the `!` prefix
- `dialogExpiry` [User or managed] — Set how long Claude Code waits for Remote Control or an SDK host to answer a forwarded dialog before it cancels the dialog
- `editorMode` [Any file] — Use vim key bindings in the input prompt
- `emojiCompletionEnabled` [Any file] — Turn off `:shortcode:` emoji suggestions and replacement in the prompt input
- `fileSuggestion` [Any file] — Supply `@` file autocomplete from your own command
- `footerLinksRegexes` [User or managed] — Make issue or review IDs in output into clickable links below the input box
- `keybindingFlavor` [Any file] — Deprecated and has no effect; the word-editing shortcuts always follow readline conventions
- `prefersReducedMotion` [Any file] — Reduce or turn off spinner, shimmer, and flash animations
- `promptSuggestionEnabled` [Any file] — Hide the grayed-out prompt suggestions in the input box
- `respectGitignore` [Any file] — Keep gitignored files out of the `@` file picker
- `respondToBashCommands` [Any file] — Stop Claude from responding after a `!` shell command runs
- `showClearContextOnPlanAccept` [Any file] — Show a "clear context" option on the plan accept screen
- `showTurnDuration` [Any file] — Hide the "Cooked for" duration after each response
- `spellcheck` [User or managed] — Underline misspelled words in the prompt input with a spell checker you install
- `spinnerTipsEnabled` [Any file] — Hide tips in the spinner while Claude works
- `spinnerTipsOverride` [Any file] — Add your own tips to the spinner rotation, or replace the built-in tips
- `spinnerVerbs` [Any file] — Add or replace the verbs shown while a turn runs
- `statusLine` [Any file] — Run your own command to render a status line below the prompt
- `subagentStatusLine` [Any file] — Rewrite rows in the subagent task display with your own command
- `syntaxHighlightingDisabled` [Any file] — Turn off syntax highlighting in diffs and code blocks
- `terminalProgressBarEnabled` [Any file] — Hide the terminal progress bar in terminals that support it
- `terminalTitleFromRename` [Any file] — Stop `/rename` and `--name` from changing the terminal tab title
- `theme` [Any file] — Pick the interface color theme, built-in or custom
- `timeFormat` [Any file] — Show the times in the interface on a 12-hour or 24-hour clock, in UTC, or with a strftime pattern
- `timeZone` [Any file] — Show the times in the interface in a time zone other than your system's
- `tui` [Any file] — Choose the fullscreen or classic terminal renderer
- `verbose` [Any file] — Show full tool output instead of truncated summaries; `viewMode` takes precedence when both are set
- `viewMode` [Any file] — Start every session in default, verbose, or focus view
- `vimInsertModeRemaps` [User or managed] — Map a two-key INSERT-mode sequence such as `jj` to Escape
- `voice` [Any file] — Turn on voice dictation and pick hold or tap mode
- `voiceEnabled` [Any file] — Turn on voice dictation with the older single-key form
- `wheelScrollAccelerationEnabled` [Any file] — Turn off mouse-wheel acceleration in fullscreen rendering

#### Git and attribution
- `attribution` [Any file] — Customize the attribution Claude Code adds to commits and pull requests
- `attribution.commit` [Any file] — Change or hide the trailer Claude Code adds to commits
- `attribution.pr` [Any file] — Change or hide the attribution line in pull request descriptions
- `attribution.sessionUrl` [Any file] — Omit the claude.ai session link from cloud and Remote Control commits
- `includeCoAuthoredBy` [Any file] — Deprecated; use `attribution` to hide or change commit and PR attribution
- `includeGitInstructions` [Any file] — Remove the built-in commit and PR instructions from Claude's context
- `prUrlTemplate` [Any file] — Point PR links at an internal code-review tool instead of github.com

#### Memory and context
- `autoCompactEnabled` [Any file] — Turn automatic compaction off or on
- `autoCompactWindow` [Any file] — Set how full the context gets before Claude Code compacts
- `autoMemoryDirectory` [Any file] — Store auto memory in a directory you choose
- `autoMemoryEnabled` [Any file] — Turn auto memory off or on
- `bashOutputMaxChars` [Any file] — Set how much of a successful command's output Claude receives inline
- `claudeMd` [Managed] — Inject organization-wide CLAUDE.md instructions from managed settings
- `claudeMdExcludes` [Any file] — Skip specific CLAUDE.md files when memory loads
- `env` [Any file] — Set environment variables for every session and its subprocesses
- `fileCheckpointingEnabled` [Any file] — Turn off or on the file snapshots that `/rewind` restores
- `plansDirectory` [Any file] — Choose where plan mode writes plan files
- `skillListingBudgetFraction` [Any file] — Reserve more or less context for the skill listing
- `skillListingMaxDescChars` [Any file] — Cap each skill's description length in the skill listing
- `taskOutputMaxChars` [Any file] — Removed in v2.1.277, together with the `TaskOutput` tool it sized

#### Global config settings
- `autoConnectIde` [Global config] — Connect to a running VS Code or JetBrains IDE automatically from an external terminal
- `autoInstallIdeExtension` [Global config] — Turn off automatic install of the IDE extension from a VS Code terminal
- `copyOnSelect` [Global config] — Turn off automatic copying of text you select with the mouse in fullscreen rendering and agent view
- `diffTool` [Global config] — Choose whether Claude's proposed file changes open in the VS Code or JetBrains diff viewer or stay in the terminal
- `externalEditorContext` [Global config] — Show Claude's last response as comments when you press Ctrl+G to edit
- `permissionExplainerEnabled` [Global config] — Removed in v2.1.257, together with the `Ctrl+E` command explanation on shell permission prompts
- `teammateDefaultModel` [Global config] — Removed in v2.1.234; see Specify teammates and models for how Claude Code picks a teammate's model

#### Updates and versioning
- `autoUpdatesChannel` [Any file] — Follow the stable release channel instead of latest
- `minimumVersion` [Any file] — Keep auto-updates from installing anything below a version
- `requiredMaximumVersion` [Managed] — Refuse to start on a version newer than your organization allows
- `requiredMinimumVersion` [Managed] — Refuse to start on a version older than your organization requires

#### Tools
- `browserExternalPageTools` [Managed] — Keep Claude's tools off external pages in the desktop Browser pane
- `disableBrowserExternalNavigation` [Managed] — Limit the desktop Browser pane to localhost for people and Claude
- `disableMobileSimulatorTools` [Managed] — Block Claude's tools in the desktop iOS Simulator pane

#### Privacy and telemetry
- `cleanupPeriodDays` [Any file] — Choose how many days Claude Code keeps transcripts before deleting them
- `desktopSessionCleanupPeriodDays` [User or managed] — Set an age limit in days for Claude Desktop and Cowork transcripts
- `feedbackDrafts` [User or managed] — Control whether Claude queues feedback drafts for you to review
- `feedbackSurveyRate` [Any file] — Change how often the session quality survey appears
- `skipWebFetchPreflight` [Any file] — Skip the WebFetch hostname check when Anthropic is unreachable

#### Enterprise and managed settings
- `disableSideloadFlags` [Managed] — Reject the CLI flags that sideload plugins, subagents, and MCP servers
- `forceRemoteSettingsRefresh` [Managed] — Block startup until server-managed settings are freshly fetched
- `managedSourcesBehavior` [Managed] — Compose every managed source you deploy instead of using the highest-priority one alone
- `parentSettingsBehavior` [Managed] — Apply or drop restrictions an SDK or IDE host passes when you deploy managed settings
- `policyHelper` [Managed] — Run an executable that computes managed settings at startup
- `policyHelper.path` [Managed] — Name the helper executable Claude Code runs
- `policyHelper.refreshIntervalMs` [Managed] — Re-run the helper in the background on an interval
- `policyHelper.timeoutMs` [Managed] — Set how long Claude Code waits for the helper
- `wslInheritsWindowsSettings` [Managed] — Have WSL read managed settings from the Windows policy chain

#### Sandbox settings
- `sandbox` [Any file] — Isolate Bash commands from your filesystem and network on macOS, Linux, and WSL2
- `sandbox.allowAppleEvents` [User or managed] — Let sandboxed commands send Apple Events on macOS
- `sandbox.allowUnsandboxedCommands` [Any file] — Let Claude retry a blocked command outside the sandbox, or forbid it
- `sandbox.autoAllowBashIfSandboxed` [Any file] — Run sandboxed commands without a permission prompt
- `sandbox.bwrapPath` [Managed] — Point the sandbox at a bubblewrap binary outside `PATH`
- `sandbox.credentials` [Any file] — Hide or mask credential files and variables inside the sandbox
- `sandbox.credentials.allowPlaintextInject` [User or managed] — Let masked credentials reach plain HTTP services on trusted test networks
- `sandbox.credentials.awsPairs` [User or managed] — Link custom-named AWS key variables into one credential for re-signing
- `sandbox.credentials.envVars` [Any file] — Unset or mask an environment variable inside the sandbox
- `sandbox.credentials.files` [Any file] — Block or mask reads of a credential file inside the sandbox
- `sandbox.credentials.sigv4` [User or managed] — Choose whether streaming, presigned, or SigV4A AWS requests fail or pass through
- `sandbox.enableWeakerNestedSandbox` [Any file] — Run the Linux sandbox inside an unprivileged container
- `sandbox.enableWeakerNetworkIsolation` [Any file] — Let `gh`, `gcloud`, and `terraform` verify TLS behind a MITM proxy inside the sandbox on macOS
- `sandbox.enabled` [Any file] — Turn on Bash sandboxing on macOS, Linux, and WSL2
- `sandbox.excludedCommands` [Any file] — Name commands Claude Code can run outside the sandbox
- `sandbox.failIfUnavailable` [Any file] — Refuse to start when the sandbox can't, instead of running unsandboxed
- `sandbox.filesystem` [Any file] — Control which paths sandboxed commands can read and write
- `sandbox.filesystem.allowManagedReadPathsOnly` [Managed] — Stop developers from re-opening read paths your organization blocked
- `sandbox.filesystem.allowRead` [Any file] — Re-open reading inside a region `denyRead` blocks
- `sandbox.filesystem.allowWrite` [Any file] — Add paths sandboxed commands can write to
- `sandbox.filesystem.denyRead` [Any file] — Block sandboxed commands from reading specific paths
- `sandbox.filesystem.denyWrite` [Any file] — Block sandboxed commands from writing to specific paths
- `sandbox.filesystem.disabled` [User or managed] — Turn off filesystem isolation while keeping network isolation
- `sandbox.ignoreViolations` [Any file] — Silence violation reports for paths a command is expected to probe
- `sandbox.network` [Any file] — Control which hosts, ports, and sockets sandboxed commands reach
- `sandbox.network.allowAllUnixSockets` [Any file] — Let sandboxed commands connect to every Unix socket
- `sandbox.network.allowLocalBinding` [Any file] — Let sandboxed commands bind to localhost ports on macOS
- `sandbox.network.allowMachLookup` [Any file] — Let macOS sandboxed tools like the iOS Simulator or Playwright reach their XPC services
- `sandbox.network.allowManagedDomainsOnly` [Managed] — Lock the network allowlist to managed settings
- `sandbox.network.allowUnixSockets` [Any file] — List Unix socket paths sandboxed commands can use on macOS
- `sandbox.network.allowedDomains` [Any file] — Pre-allow domains so sandboxed commands don't prompt for them
- `sandbox.network.deniedDomains` [Any file] — Block domains for sandboxed commands, even inside an allowed wildcard
- `sandbox.network.httpProxyPort` [Any file] — Route sandbox HTTP traffic through your own proxy
- `sandbox.network.socksProxyPort` [Any file] — Route sandbox SOCKS traffic through your own proxy
- `sandbox.network.strictAllowlist` [User or managed] — Deny hosts outside the allowlist instead of prompting
- `sandbox.network.tlsTerminate` [User or managed] — Have the sandbox proxy terminate TLS so it can read HTTPS requests
- `sandbox.ripgrep` [User or managed] — Use your own ripgrep binary inside the sandbox
- `sandbox.socatPath` [Managed] — Point the sandbox proxy at a `socat` binary outside `PATH`

TOTAL KEYS: 231

Sub-keys documented separately (settings-reference headings): `autoMode.classifyAllShell`; sandbox.* = `enabled`, `failIfUnavailable`, `autoAllowBashIfSandboxed`, `excludedCommands`, `allowUnsandboxedCommands`, `filesystem.{allowWrite,denyWrite,denyRead,allowRead,allowManagedReadPathsOnly,disabled}`, `ignoreViolations`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `ripgrep`, `bwrapPath`, `socatPath`, `credentials.{files,envVars,allowPlaintextInject,awsPairs,sigv4}`, `network.{allowUnixSockets,allowAllUnixSockets,allowLocalBinding,allowMachLookup,allowedDomains,deniedDomains,strictAllowlist,allowManagedDomainsOnly,httpProxyPort,socksProxyPort,tlsTerminate}`; `attribution.{commit,pr,sessionUrl}` (replaces deprecated `includeCoAuthoredBy` since v2.0.62); `strictPluginOnlyCustomization.{skills,agents,hooks,mcp}`; `worktree.{baseRef,symlinkDirectories,sparsePaths,bgIsolation}`; `policyHelper.{path,timeoutMs,refreshIntervalMs}`; `remote.defaultEnvironmentId`; statusLine object `{type:"command",command,padding,refreshInterval,hideVimModeIndicator}`.

Notable values:
- `theme`: `auto`, `dark` (default), `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi`, `custom:<slug>` / `custom:<plugin>:<slug>` (files in `~/.claude/themes/*.json` with `name`, `base`, `overrides`).
- `spinnerVerbs`: `{mode: "append"|"replace", verbs: [...]}`; `spinnerTipsEnabled`; `spinnerTipsOverride {tips, tipsFile, label, excludeDefault}`.
- `viewMode`: `default` | `verbose` | `focus` (focus = only last prompt, one-line tool summary with edit diffstats, final response; needs fullscreen).
- `tui`: `default` | `fullscreen`.
- `editorMode`: `normal` | `vim`.
- `preferredNotifChannel`: `auto`, `terminal_bell`, `iterm2`, `iterm2_with_bell`, `kitty`, `ghostty`, `notifications_disabled`.
- `showTurnDuration` (default true) → "Cooked for 1m 6s · done 6:05 PM".
- `prefersReducedMotion` → reduces spinner, shimmer, flash effects.
- `cleanupPeriodDays` default 30. `autoCompactEnabled` default true. `fileCheckpointingEnabled` default true. `autoMemoryEnabled` default true.
- `effortLevel` `low|medium|high|xhigh`; `alwaysThinkingEnabled: false` to disable thinking (no effect on always-thinking models Opus 5.5/Fable).
- `permissions.defaultMode`: `default|manual|acceptEdits|plan|auto|dontAsk|bypassPermissions` (`auto` & `bypassPermissions` ignored from project/local files).
- `disableAutoMode: "disable"`, `permissions.disableBypassPermissionsMode: "disable"`.

### B4. Representative environment variables (https://code.claude.com/docs/en/env-vars — 366 total)
Auth/provider: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `AWS_BEARER_TOKEN_BEDROCK`, `CLAUDE_CODE_OAUTH_TOKEN`, `API_TIMEOUT_MS`.
Bash/tools: `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, `BASH_MAX_OUTPUT_LENGTH`, `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR`, `CLAUDE_ENV_FILE`, `CLAUDE_CODE_TOOL_MEMORY_LIMIT`, `CLAUDE_CODE_GLOB_NO_IGNORE`, `CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`, `CLAUDE_CODE_WEBFETCH_DEADLINE_MS`, `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`.
Features: `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`, `CLAUDE_CODE_DISABLE_THINKING`, `MAX_THINKING_TOKENS`, `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_ENABLE_TODO_TOOLS`, `CLAUDE_CODE_ENABLE_TASKS`, `CLAUDE_CODE_FORK_SUBAGENT`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `DISABLE_AUTO_COMPACT`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_TASK_LIST_ID`, `CLAUDE_CODE_NEW_INIT`.
UI: `CLAUDE_CODE_NO_FLICKER` (fullscreen), `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`, `CLAUDE_CODE_FORCE_SYNC_OUTPUT`, `CLAUDE_CODE_DISABLE_MOUSE`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, `CLAUDE_CODE_HIDE_CWD`, `CLAUDE_CODE_ACCESSIBILITY`/`CLAUDE_AX_SCREEN_READER`, `CLAUDE_CODE_DISABLE_AGENT_VIEW`.
Privacy/ops: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_ENABLE_TELEMETRY` (OTel), `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`, `CLAUDE_CODE_SKIP_PROMPT_HISTORY`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, `CLAUDE_CODE_REMOTE` (set in cloud).

### B5. Claude Desktop Code-tab settings (https://code.claude.com/docs/en/desktop)
- Session start controls in prompt area: **Environment** dropdown (Local / Cloud / SSH connection / WSL; gear icon on Local opens local environment editor for encrypted env vars applying to sessions + preview servers; "Add cloud environment"; "+ Add SSH connection" dialog: Name, SSH Host, SSH Port, Identity File), **Project folder** ("Select folder"; cloud can add multiple repos with +, each with branch selector), **branch + worktree option**, **Model** dropdown next to send, **Permission mode** selector next to send (Manual / Accept edits / Plan / Auto / Bypass permissions), **Transcript view** dropdown (Normal / Thinking / Verbose), effort menu (Cmd+Shift+E), usage ring.
- Settings → Claude Code: "Allow bypass permissions mode" (Pro/Max), "Worktree location" + branch prefix, "Auto-archive after PR merge or close", Browser toggles (clear saved session data / turn Browser off), approved sites revocation.
- Settings → General (Desktop app): **Computer use** toggle (macOS/Windows, Pro/Max; needs Accessibility + Screen Recording), **Denied apps**, **Unhide apps when Claude finishes**; scheduled-task settings under Desktop app → General.
- Settings → Connectors (manage/disconnect).
- `.claude/launch.json` preview server config (`version`, `configurations[{name, runtimeExecutable, runtimeArgs, port, program, url, ...}]`, `autoVerify` default true).
- Mode choice remembered per folder (Plan = per session). Reads same settings files as CLI; `defaultMode` applies to new local sessions.
- Enterprise: admin console toggles (Code in the desktop, Code in the web, Remote Control, Disable Bypass permissions mode); managed keys `disableAutoMode`, `autoMode`, `browserExternalPageTools`, `disableBrowserExternalNavigation`, `disableMobileSimulatorTools`, `sshConfigs`, `sshHostAllowlist`, `disableDesktopLocalSessions`, `managedMcpServers`; MDM domain `com.anthropic.claudefordesktop`; Windows registry `SOFTWARE\Policies\Claude`.
- VS Code extension settings: `claudeCode.initialPermissionMode`, `preferredLocation` (sidebar/panel), "Allow dangerously skip permissions", `attachOpenFile`, `lockEditorGroups`, `continueAfterReload`, `enableNewConversationShortcut`, `enableReopenClosedSessionShortcut`, `respectGitIgnore`, `claudeProcessWrapper`, Hide Onboarding. https://code.claude.com/docs/en/vs-code#extension-settings

---------------------------------------------------------------------
## C. UI / UX
---------------------------------------------------------------------

### C1. Claude Desktop — Code tab (primary) — https://code.claude.com/docs/en/desktop , https://code.claude.com/docs/en/desktop-quickstart
Dates: Claude Code arrived in the desktop app with the Opus 4.5 launch (Nov 24, 2025: "Claude Code is now available in the desktop app, letting you run multiple local and remote sessions in parallel" — https://www.anthropic.com/news/claude-opus-4-5). **Redesign April 14, 2026** — "Redesigning Claude Code on desktop for parallel agents" https://claude.com/blog/claude-code-desktop-redesign (sidebar, drag-and-drop panes, integrated terminal & file editor, rebuilt diff viewer, expanded preview, side chat ⌘;, view modes, usage button, SSH on Mac, plugin parity). Pane pop-out windows added Week 37 (Sep 7–11, 2026) https://code.claude.com/docs/en/whats-new/2026-w37. Pane layout/terminal/editor require Desktop v1.2581.0+.
- App shell: three top-center tabs **Chat / Cowork / Code**. Code tab = sessions; each session has own history + project folder.
- **Sidebar**: "+ New session" (Cmd+N), session list with filters (status, project, environment) and group-by-project; Cmd-click opens a session in a second split pane; hover → archive icon; badges (e.g. **Dispatch** badge for sessions spawned from phone); **Projects** entry (cloud coordinator), **Routines** page (local scheduled tasks + cloud routines), **Customize** (connectors, skills, plugins). Rename via clicking title in session toolbar. OS notification when a session you aren't viewing finishes.
- **Empty/new-session state**: prompt area where you configure Environment (Local/Cloud/SSH/WSL), Project folder ("Select folder"), branch + **worktree** toggle, Model dropdown, Permission-mode selector, then type the task and Enter. Quickstart suggests starter prompts: "Find a TODO comment and fix it", "Add tests for the main function", "Create a CLAUDE.md with instructions for this codebase".
- **Prompt box**: Enter sends; stop button interrupts; typing + Enter while running sends a steering correction; **+** button → file attachments, Slash commands, Connectors, Plugins; `@filename` mention with autocomplete (local/SSH only); drag-and-drop images/PDFs; model dropdown, mode selector, **Transcript view** dropdown, effort menu, **usage ring** (context % + plan usage) next to model picker. `/` opens command/skill picker; chosen skill appears highlighted in input.
- **Panes** (drag by header to arrange, drag edges to resize, Views menu to open, pop out to window): chat, **diff**, **browser** (preview), **terminal**, **file** editor, **plan**, **tasks**, **subagent**, **iOS Simulator** (macOS, public beta; auto-opens when Claude builds/runs app; separate simulator per session; Desktop v1.24012.0+, Xcode 26.x). Cmd+\ closes focused pane.
- **Diff view**: after edits, a diff-stat chip like `+12 -1` appears; click → file list left, diff right; click any line to add a comment, Enter to add, Cmd+Enter submits all comments → Claude revises and a new diff appears. **Review code** button (top-right) → Claude leaves inline review comments (high-signal only: compile errors, logic errors, security, obvious bugs). In Manual mode: diff + Accept/Reject buttons per change before files are touched.
- **CI status bar** after PR: Auto-fix and Auto-merge (squash) toggles, polls via `gh`; desktop notification when CI finishes.
- **Browser pane**: tabbed browser; dev server auto-started from `.claude/launch.json`; auto-verify (screenshots, DOM, clicks) after edits; server dropdown (start/stop, Persist sessions, Edit configuration); Cmd+Shift+S select element; external-site permission card **Allow once / Always allow / Deny**.
- **Terminal pane** (Ctrl+`), shares session env; multiple tabs; local only. **File pane**: spot edits + Save/Discard, conflict warning. Right-click any path → Attach as context / Open in (VS Code, Cursor, Zed) / Show in Finder / Copy path.
- **View modes** (Ctrl+O cycles; dropdown next to send): **Normal** (tool calls collapsed into summaries + full text), **Thinking** (+ thinking), **Verbose** (every tool call, file read, step). Summary mode existed in the redesign but was removed (pre-1.46388.1).
- **Side chat**: Cmd+; or `/btw` — reads main thread, adds nothing back; not saved to disk.
- **Tasks pane**: subagents, background shells, workflows; click to view output or stop.
- **Cross-session**: Claude can list/read/message/rename/archive other desktop sessions (archive always asks, even in Auto/Bypass); messages shown as a card labeled with sender session title. Claude proposes out-of-scope work as a **task chip** → click to start new session in its own worktree.
- **Continue in** menu (VS Code icon, bottom-right of session toolbar): Claude Code on the Web / Your IDE. `/resume` in Desktop picks up CLI sessions; `/desktop` in CLI moves a session into Desktop.
- **Computer use** (Pro/Max, research preview): app-approval prompt "Allow for this session / Deny"; tiers View only (browsers, trading), Click only (terminals, IDEs), Full control; Claude hides other windows while working.
- **Keyboard shortcuts** (Cmd+/ shows all): Cmd+N new session, Cmd+W close session, Ctrl+Tab / Ctrl+Shift+Tab and Cmd+Shift+] / [ next/prev session, Esc stop, Cmd+Shift+D diff pane, Cmd+Shift+B browser, Cmd+Shift+S select element, Ctrl+` terminal, Cmd+\ close pane, Cmd+; side chat, Ctrl+O cycle view modes, Cmd+Shift+M permission-mode menu, Cmd+Shift+I model menu, Cmd+Shift+E effort menu, 1–9 select item in open menu. CLI shortcuts like Shift+Tab don't apply.
- Not in Desktop: `dontAsk`, agent teams, inline completions, terminal-dialog commands (`/permissions` replies "isn't available in this environment"; `/config` opens Settings).

### C2. CLI TUI — https://code.claude.com/docs/en/interactive-mode , /fullscreen , /terminal-config
- Layout (classic renderer): startup logo block (Clawd mascot, version, model, cwd; quiet notices under logo; `CLAUDE_CODE_HIDE_CWD`), scrolling transcript in main screen, spinner line + tip, bordered prompt input, footer (mode indicator e.g. `⏵⏵ auto mode on`, hints like "esc to interrupt", PR badge, `← 2 agents`, IDE indicator), optional status line below prompt, subagent/fork panel below prompt, task list (Ctrl+T, up to 5 items). Fullscreen renderer (`/tui fullscreen`, `CLAUDE_CODE_NO_FLICKER=1`; added v2.1.89 Apr 1 2026): alt-screen, input fixed at bottom, virtualized scrollback, mouse support (click to position cursor, click menu options/tool results to expand, drag select + copy-on-select, wheel scroll), `Jump to bottom` button with "3 new messages", dim sticky header of the last prompt scrolled out of view, `/diff` side panel (≥110 cols; auto-opens ≥144 cols once editing starts).
- **Tool-call rendering** (collapsed by default): read/search calls are grouped into one summary line that is present-tense while running ("Reading…", "Searching for") and past tense when done ("Read N files", "Searched for N patterns") (v2.1.20–21, Jan 27–28 2026), shows the current file/pattern beneath while active (v2.1.45), "Listed N directories" for ls/tree/du (v2.1.89), MCP reads collapse to "Queried `{server}`" (v2.1.81); collapsed tool summary line has a live elapsed-time counter (v2.1.210, Jul 14 2026). Long outputs show `… +N lines (ctrl+o to expand)` (GitHub issues #12589, #26954). Edits render as `Update(path)` / `Write(path)` with inline colored diff (word-level highlights; dimmed diff after rejection) — the ⏺ bullet / ⎿ result gutter glyphs are observed in the product (per GitHub issues e.g. https://github.com/anthropics/claude-code/issues/12589), not specified in docs. Thinking collapsed; Ctrl+O shows it as gray italic.
- **Ctrl+O** = transcript viewer (verbose); in fullscreen supports `/` search, n/N, j/k, g/G, {/} prompt jumps, `[` dump to native scrollback, `v` open in $EDITOR, q/Esc exit. `/focus` view = last prompt + one-line tool summary with edit diffstats + final response. `viewMode` setting.
- **Approval prompts**: bordered dialog (color token `permission`), numbered options selectable by arrow/number/click. Bash: "Yes" / "Yes, and don't ask again for `<cmd prefix>` …" (saves rule to `.claude/settings.local.json`) / "Yes, and switch to auto mode" (when available) / "No, and tell Claude what to do differently" (esc). WebFetch documented options: **Yes** / **Yes, and don't ask again for `<domain>`** / **No, and tell Claude what to do differently** (https://code.claude.com/docs/en/tools-reference#webfetch-tool-behavior). File edits: yes-once / allow for rest of session (Shift+Tab) / no. Tab on Yes/No opens a comment field. Unsandboxed Bash prompts titled "Bash command (unsandboxed)". Background-subagent prompts name the subagent. Plan approval dialog described in A3. Exact labels for the Edit prompt: unverified.
- **Composer controls**: `/` commands & skills (menu with fuzzy match; mid-prompt `/` list), `@` file mentions (fuzzy; also other live sessions), `!` shell mode (border turns `bashBorder` color; output added to context and Claude responds unless `respondToBashCommands:false`), `:` emoji shortcodes, `?` shortcut help, Shift+Tab mode cycle, Option+P model, Option+T thinking toggle, Option+O fast mode, Ctrl+G/Ctrl+X Ctrl+E external editor, Ctrl+V paste image, Ctrl+S stash prompt, Ctrl+R reverse history search, Up/Down history, prompt suggestions (grey ghost text; Tab/→ accepts), pasted text >800 chars collapses to `[Pasted text #N]`, vim mode (NORMAL/INSERT/VISUAL), voice dictation (hold Space). `ultrathink` keyword rainbow-highlighted. No `#` memory prefix anymore (removed Dec 15 2025).
- **Status indicators**: animated spinner glyph + rotating verb ("Accomplishing", "Architecting", "Baking", "Pondering"… ~185–191 built-ins; `spinnerVerbs` to append/replace) with elapsed time, token count, effort label ("with low effort", added to logo & spinner) and "esc to interrupt" hint; one-line spinner tip below ("Use /config to change your default permission mode…"). Thinking status text: "thinking" → "still thinking"/"almost done thinking"; "deep in thought" after 45 s; "picking the thought back up" when recovering (v2.1.271, Sep 14 2026). Hooks running show in spinner with elapsed time. After turn: "Cooked for 1m 6s · done 6:05 PM" (past-tense verb, `showTurnDuration`). Session recap line after ≥3 min away. Terminal tab title shows busy spinner glyph; OSC progress bar (`terminalProgressBarEnabled`).
- **Notifications**: `preferredNotifChannel` (iTerm2/Kitty/Ghostty desktop notifications, terminal bell); Notification hooks; `PushNotification` tool + Remote Control phone pushes.
- **Full keyboard shortcut list (interactive-mode doc)**: Ctrl+C interrupt/clear; Ctrl+X Ctrl+K stop all background subagents; Ctrl+D exit; Ctrl+G or Ctrl+X Ctrl+E external editor; Ctrl+L redraw; Ctrl+O transcript; Ctrl+R reverse search; Ctrl+V / Cmd+V (iTerm2) / Alt+V paste image; Ctrl+B background tasks; Ctrl+T task checklist; Ctrl+S stash/restore prompt; Ctrl+Z suspend; ←/→ dialog tabs; Tab accept autocomplete / comment on permission answer; ↑/↓ or Ctrl+P/N history; Esc interrupt/close dialog; Esc Esc clear draft or rewind; Ctrl+Enter or Ctrl+X Ctrl+S send queued now; Shift+Tab (Alt+M on some Windows) cycle modes; Option/Alt+P model; Option/Alt+T thinking; Option/Alt+O fast mode. Text editing: Ctrl+A/E/K/U/W/Y, Alt+Y, Alt+B/F/D, Ctrl+_ undo. Multiline: `\`+Enter, Option+Enter, Shift+Enter (native in iTerm2, WezTerm, Ghostty, Kitty, Warp, Apple Terminal, Windows Terminal), Ctrl+J. Quick prefixes `/ ! @ : ?`. Transcript viewer: `? { } Ctrl+E [ v q`. Voice: hold/tap Space. Fully rebindable via `~/.claude/keybindings.json` (`/keybindings`).
- Onboarding: first run → theme picker, login, workspace trust dialog (lists allow rules/hooks/MCP the folder would activate), `/terminal-setup` (Shift+Enter), first-time auto-mode notice at top of session; bypass-mode warning dialog. `/init` to create CLAUDE.md; `/powerup` = "Discover Claude Code features through quick interactive lessons with animated demos"; `/insights` HTML usage report; `/doctor` checkup.
- Agent view (`claude agents`) full-screen dashboard — see A8.

### C3. VS Code extension — https://code.claude.com/docs/en/vs-code (native extension launched in beta with Claude Code 2.0, Sep 29, 2025)
- Entry points: Spark icon in Editor Toolbar (top-right, when a file is open), Activity Bar Spark icon → sessions list, Command Palette "Claude Code: …", Status bar "✻ Claude Code". Panel can live in secondary sidebar (right), primary sidebar, or editor tab; multiple conversations via Open in New Tab (Cmd+Shift+Esc)/New Window; tab Spark icon dot: **blue = permission request pending, orange = finished while hidden**. Session groups in Activity Bar list (v2.1.229+). Sign-in screen → "Learn Claude Code" onboarding checklist ("Show me").
- Prompt box: mode indicator at bottom (Manual / Edit automatically / Plan / Auto / Bypass permissions), model name button (+ Effort row), `/` command menu with **Customize** section (MCP servers, commands, Output styles, Hooks, Permissions, Memory, Instructions, plugins; terminal-icon items open integrated terminal) and **Settings** section (Remote Control toggle, Focus view, Sign out, Report a problem), context indicator, **prompt-cache clock** (minutes left, turns red when expired), **agent map** ("2 agents" count with status dot → tree of subagents with status/elapsed/tokens; stop; background tasks listed), extended-thinking toggle (thinking as collapsed blocks; Ctrl+O expand all), Shift+Enter newline, @-mentions with fuzzy match (`@auth`, `@src/components/`), selection auto-shared (footer shows lines selected; Option+K inserts `@app.ts#5-10`), attach open file, paste images, Shift-drag files.
- Diffs: in Manual mode, side-by-side native VS Code diff of proposed change with accept/reject; per-change **Accept this change / Reject this change** buttons (≤100 changes); user can edit proposed content before accepting (Claude is told). Plan mode opens plan as Markdown doc with inline comments.
- Focus view (Ctrl+Option+F) hides tool calls/results/thinking behind expandable rows; to-do list and subagent live progress rows stay visible.
- Rewind: Esc-twice or `/rewind` picker (v2.1.83), "Fork conversation from here". `/btw` opens side panel. Copy response button. Resume past conversations / cloud sessions from Claude.ai.
- Shortcuts: Cmd+Esc focus toggle editor↔Claude, Cmd+Shift+Esc new tab, Cmd+N new conversation (opt-in), Cmd+Shift+T reopen closed session, Option+K insert @-mention, Ctrl+Option+F Focus view.
- Built-in IDE MCP server shares open file/selection/diagnostics. Terminal mode option runs CLI in panel.

### C4. Claude Code on the web (claude.ai/code) & mobile — https://code.claude.com/docs/en/claude-code-on-the-web , /web-quickstart
- Launched Oct 20, 2025 (changelog v2.0.24 "Claude Code Web: Support for Web -> CLI teleport"; Simon Willison https://simonwillison.net/2025/Oct/20/claude-code-for-web/).
- Sidebar of sessions; repo + branch + environment pickers; mode dropdown (Accept edits / Plan / Auto); setup checklist while VM provisions; diff chip `+42 -18` → diff view (file list left, changes right, **Compare against** branch), click line to comment (comments bundle with next message as "at `src/auth.ts:47`, …"), **Create PR** (full, draft, or GitHub compose), CI status bar with Auto-fix; share, archive, delete; "Open in > Terminal" copies teleport command; queued messages removable with ✕/Esc/Up. URL query params prefill prompt/repos/environment.

---------------------------------------------------------------------
## D. MOTION & VISUAL DESIGN
---------------------------------------------------------------------
- **Brand color "Claude orange"**: theme token `claude` = "Primary brand accent, used for the spinner and assistant label" (https://code.claude.com/docs/en/terminal-config#create-a-custom-theme). Value in dark theme reported as `rgb(215,119,87)` / #D77757 by source-analysis site https://www.markdown.engineering/learn-claude-code/41-theme-styling (secondary, unverified by Anthropic). Anthropic's own docs diagram uses `#D97757` as the highlight accent with fill `rgba(217,119,87,0.14)`, text #1A1918, sub #5E5D59, faint #8A8880, surface #F5F4EF (settings precedence SVG component in https://code.claude.com/docs/en/settings raw source) — i.e. warm near-black text on warm off-white with terracotta accent.
- **Themes**: `dark` (default), `light`, `dark-daltonized`, `light-daltonized` (colorblind-friendly), `dark-ansi`, `light-ansi` (terminal's 16-color palette only), `auto` (follows terminal background), custom JSON themes in `~/.claude/themes/` (hot reload) or from plugins, with `/theme` live-preview editor. Syntax highlighting toggle (Ctrl+T in `/theme`; `syntaxHighlightingDisabled`).
- **Color tokens** (overridable): text & accent `claude`, `text`, `inverseText`, `inactive`, `subtle`, `suggestion`, `permission`, `remember`; status `success`, `error`, `warning` (also auto-mode indicator), `merged`; input/mode `promptBorder`, `planMode`, `autoAccept`, `bashBorder`, `ide`, `fastMode`, `effortUltra`; diff `diffAdded`, `diffRemoved`, `diffAddedDimmed`, `diffRemovedDimmed`, `diffAddedWord`, `diffRemovedWord`; fullscreen `userMessageBackground`, `userMessageBackgroundHover`, `bashMessageBackgroundColor`, `memoryBackgroundColor`, `selectionBg`; usage meter `rate_limit_fill`, `rate_limit_empty`; labels `briefLabelYou`, `briefLabelClaude`; **shimmer pairs** (`claudeShimmer`, `warningShimmer`, `permissionShimmer`, `promptBorderShimmer`, `inactiveShimmer`, `fastModeShimmer` = "the lighter color used in the spinner's animated gradient"); 8 subagent colors `<red|blue|green|yellow|purple|orange|pink|cyan>_FOR_SUBAGENTS_ONLY`; `ultrathink` keyword **seven-color rainbow gradient** with `rainbow_<color>_shimmer` tokens.
- **Spinner**: animated glyph (star-like `✻`/`✽`/`✢`/`∙` family seen in agent view state icons; exact frame sequence unverified — community reverse-engineering at https://medium.com/@kyletmartinez/reverse-engineering-claudes-ascii-spinner-animation-eec2804626e0, 403 when fetched) + shimmering verb text (gradient from base token to its `*Shimmer` variant). Verb list: ~185 in v2.1.42 per https://codingcocoon.com/posts/claude-code-all-spinner-verbs/ (Feb 18, 2026) — e.g. Accomplishing, Architecting, Baking, Bootstrapping, Clauding, Cogitating, Combobulating, Flibbertigibbeting, Percolating, Pondering, Synthesizing, Tinkering. Past-tense completion "Cooked/Worked for 5s". Behavior changes: spinner "warms to amber after 10 seconds" of thinking (v2.1.141, May 13 2026); turns **red when a permission check stalls** in auto mode (v2.1.126, May 1 2026); "deep in thought" after 45 s (v2.1.271); thinking spinner color count capped to avoid VS Code terminal glitches; Ghostty pulse glyph-size fix ("activity spinner's pulse"). Reduced motion (`prefersReducedMotion`) removes spinner/shimmer/flash; screen-reader mode renders spinners as static text (https://code.claude.com/docs/en/accessibility).
- **Mode color coding**: plan mode `planMode` accent (teal/blue family by default – unverified), accept-edits `autoAccept`, auto mode uses `warning` color, bash mode `bashBorder` (pink in default dark theme – unverified), fast mode `fastMode`, ultracode tag on input border `effortUltra`.
- **Agent view state colors**: Working animated, Needs input yellow, Idle dimmed, Completed green, Failed red, Stopped grey; row names tinted by `/color`.
- **Density**: terminal = monospace, single-line collapsed tool rows, diffstats inline; Desktop view modes (Normal/Thinking/Verbose) and VS Code Focus view control density; CLI `/focus` for minimal density.
- **Desktop visual**: Claude desktop app styling (warm neutral palette, serif display type in Claude apps generally) — no dedicated Anthropic design write-up for the Code tab found (unverified). Screenshots/videos in docs: agent-view-light/dark.png, whats-new videos (desktop-pop-out-panes.mp4).
- Design-adjacent writeups: "Redesigning Claude Code on desktop for parallel agents" (Apr 14 2026) https://claude.com/blog/claude-code-desktop-redesign; "Enabling Claude Code to work more autonomously" (Sep 29 2025) https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously (new terminal UI v2.0: "improved status visibility and searchable prompt history (Ctrl+r)").

---------------------------------------------------------------------
## E. KEY DATES (changelog https://code.claude.com/docs/en/changelog unless noted)
---------------------------------------------------------------------
- Apr 2, 2025 v0.2.54: `#` memory shortcut. Apr 21, 2025 v0.2.75: Enter to queue messages.
- Jun 24, 2025 v1.0.33: plan mode improvements (plan mode pre-existing). Jun 30, 2025 v1.0.38: hooks released. Jul 24, 2025 v1.0.60: custom subagents (`/agents`). Aug 7, 2025 v1.0.71: status line. Aug 14, 2025 v1.0.81: output styles.
- Sep 29, 2025 v2.0.0: Claude Code 2.0 — checkpoints `/rewind`, native VS Code extension (beta), new terminal UI, Agent SDK rename (https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously).
- Oct 9, 2025 v2.0.12: plugins + marketplaces. Oct 16, 2025 v2.0.20: Skills. Oct 20, 2025 v2.0.24: Bash sandbox + Claude Code on the web + teleport. Nov 18, 2025 v2.0.45: `&` to send tasks to web. Nov 24, 2025: Claude Code in desktop app (Opus 4.5 post). Dec 15, 2025 v2.0.70: `#` shortcut removed. (`attribution` replaced `includeCoAuthoredBy` at v2.0.62.)
- Jan 7, 2026 v2.1.0: unified Ctrl+B backgrounding. Jan 14, 2026 v2.1.7: MCP tool search default. Feb 19, 2026 v2.1.49: `--worktree`. Feb 20, 2026 v2.1.50: `claude agents`. Feb 26, 2026 v2.1.59: auto memory. Mar 25, 2026: auto mode engineering post. Apr 1, 2026 v2.1.89: fullscreen (NO_FLICKER). Apr 14, 2026: Desktop redesign. Apr 15, 2026 v2.1.110: `/focus` separate from Ctrl+O.
- v2.1.186: background subagent prompts surface in main session. v2.1.200: "Manual" label. v2.1.212: `/subtask`. v2.1.228 (mac/Linux): auto mode default on Pro/Max/Team. v2.1.232: fork mode default. v2.1.268: task tools off by default on newest models. Sep 7–11, 2026: Desktop pane pop-out. Sep 17, 2026 v2.1.275: Ctrl+Enter send-now. Sep 18, 2026 v2.1.277: native AGENTS.md. Sep 22, 2026 v2.1.280: Opus 5.5 default Opus.

## F. OTHER NOTES
- Costs: avg ~$13/dev/active day, $150–250/dev/month enterprise; `/usage` shows session cost, plan usage limits and activity stats (`/cost` and `/stats` are aliases) — https://code.claude.com/docs/en/costs.
- Full slash-command list (commands reference): /add-dir /advisor /agents /artifacts /auto-mode-setup /autocompact /autofix-pr /background /batch /branch /btw /bug /cd /chrome /claude-api /clear /code-review /color /compact /config /context /copy /cost /dataviz /debug /deep-research /design /design-login /design-sync /desktop /diff /doctor /effort /exit /export /fast /feedback /fewer-permission-prompts /focus /fork /goal /heapdump /help /hooks /ide /import /init /insights /install-github-app /install-slack-app /keybindings /list-agents /login /logout /loop /mcp /memory /mobile /model /output-style /passes /permissions /plan /plugin /powerup /pr-comments /privacy-settings /radio /rate-limit-options /recap /release-notes /reload-plugins /reload-skills /remote-control /remote-env /rename /resume /review /rewind /run /run-skill-generator /sandbox /schedule /scroll-speed /security-review /setup-bedrock /setup-vertex /simplify /skill-doctor /skills /stats /status /statusline /stickers /stop /subtask /tasks /team-onboarding /teleport /terminal-setup /theme /tui /ultraplan /ultrareview /update-config /upgrade /usage /usage-credits /verify /vim /voice /web-setup /workflow-authoring /workflows — https://code.claude.com/docs/en/commands
- CLI subcommands: claude, claude "q", -p, -c, -r, update, install, auth login/logout/status, agents, attach, auto-mode defaults/reset, daemon status/stop, doctor, import, logs, mcp, plugin, project purge, remote-control, respawn, rm, self-hosted-runner, setup-token, stop, ultrareview, gateway. Notable flags: --add-dir --agent --agents --allowedTools --disallowedTools --tools --bare --bg --exec --chrome --cloud (--remote) --teleport --continue --resume --fork-session --from-pr --name --effort --model --fallback-model --permission-mode --dangerously-skip-permissions --allow-dangerously-skip-permissions --restricted --safe-mode --settings --setting-sources --mcp-config --strict-mcp-config --plugin-dir --output-format --input-format --include-partial-messages --json-schema --max-turns --max-budget-usd --worktree --tmux --verbose --debug --system-prompt(-file) --append-system-prompt(-file) — https://code.claude.com/docs/en/cli-reference
- `/en/iam` serves the **Authentication** page (same content as /en/authentication): login via claude.ai (Pro/Max/Team/Ent), Console, Bedrock/Agent Platform/Foundry env vars, or Claude apps gateway SSO; `forceLoginMethod`, `forceLoginOrgUUID` restrict login; `claude setup-token` for CI.
