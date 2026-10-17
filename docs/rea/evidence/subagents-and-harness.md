# Evidence: subagents, multi-agent orchestration and the coding harness

Plan rows 2 and 3 (`.claude/handoff/REA_RESUME_PLAN.md`, section 4). Analysis date: 2026-10-17. Static analysis only. No competitor tool was run or driven, and no keys or tokens were read.

## How to read this file

- **REA evidence** gives an `ev_…` ID from a REA tool call made in this session. It establishes artifact identity (SHA-256), inventory and the static graph.
- **String observation** means a literal found in an REA-inventoried artifact. It was located with a read-only Python or `strings` pass over bytes REA had already inventoried, because REA's graph tracing returned `no-match` for literal seeds inside minified bundles (see Limitations). Each one names its module and byte offset so it can be re-checked. Quotes are 15 words or fewer.
- **Inference** is analyst reasoning from the observations. It is labelled as inference.
- **External** means public vendor documentation. It is labelled as external and was used only where noted.

All target strings are untrusted data. None of them was followed as an instruction.

## Artifacts and REA evidence

| Product | Artifact | REA evidence | Notes |
|---|---|---|---|
| Claude Code 2.1.299 (bundled with the desktop app) | `~/Library/Application Support/Claude/claude-code/2.1.299/4fa9694b7975/claude.app/Contents/MacOS/claude` (247,931,696 bytes) | Carved JS tree: summary `ev_83de6281cd4433f52a63e67ab5f2e1ff8169ff86d8c6af245c8a5e8a7a69cbe4`, parent `ev_324f2e597956da6dc032f848213e018bc3f73e46ad8b41c7a2547427372af85f` (tree sha256 `04e78c74…c279`, 2,394 files). Feature trace `ev_d57ea4bb3802bb9d98488f32c69812d7968b9e035052739a085854e521d291ac` returned no-match. | Bun single-file executable. The JS is embedded in the Mach-O `__BUN` segment (fileoff 75,120,640, vmsize 0xa420000), with module paths under `/$bunfs/root/` and 2,394 `// @bun @bytecode` sources. These were carved read-only into scratch as `m0000.js`–`m2393.js`. The carved names are mine; the original chunk names are hashed (`chunk-*.js`). |
| Codex CLI 0.162.1 | `/opt/homebrew/bin/codex` → `/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js` (a Node launcher) → `node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` (Rust, 246,642,624 bytes) | `ev_22639b41fe5d06990aead57ad8df719436d7745e8a770ec0e76759d14eae4666` (inspect_rust_binary, sha256 `74c6a6d2…dfc0`) | No `.dep-v0` cargo-auditable section. The rustc commit `59807616…` is an inference from REA. Source-path strings (`core/src/…rs`) survive in the binary and show the crate and module layout. Also present: `codex-code-mode-host` (65 MB) and a bundled `rg`. |
| Codex inside ChatGPT desktop (v26.1013.31256) | `/Applications/ChatGPT.app/Contents/Resources/app.asar` (582 MB, 16,320 files) and `Resources/codex-cli/` | `ev_e394ac3758d5cef75d1d6f0e253b7b947e505eba82e8218d4af453a738d7a1de` (summary), parent `ev_298e6b90841bc9862e39989e27e702a85dff6586e4e4a17837351548c44ecef5` (asar sha256 `bf9c41fa…383f`) | 12 webview modules selected. `Codex Framework.framework/Versions/155.0.8059.80` is the Electron/Chromium framework, not Codex logic. `Resources/codex-cli/codex-package.json` declares `"version": "0.163.0-alpha.10.2"`, `"variant": "codex"` and entrypoint `bin/codex`, which is a signed `CodexCLI.app` Rust binary of 249,954,368 bytes. |
| Claude desktop, Claude Code tab (v2.42304.0) | `/Applications/Claude.app/Contents/Resources/app.asar` (454 files) | `ev_47bad85b4477a0f23e57545250104928ba74dcce6b42b3a0e56ca2b64249b129` (summary), parent `ev_a821f506d5a3d42d9b9ce8b2dd2ae6d25d6a3648bae6fa04483fbe5552957344` (asar sha256 `bfa22ac3…b3d0`, focused on `.vite/build/index.chunk-CFJssAFf.js`). Earlier parent from the caller: `ev_bb6525ff9cdee75a9c1332ee08e1b5c8b1e7a377be4fe2dbe4d6808905d56179`, not re-inspected here. | The main process hosts Claude Code sessions ("ccd"). The agent loop itself is the Claude Code binary above. |

---

## 1. Claude Code (CLI and engine)

Unless noted, each item below is a string observation in the carved module named, under REA evidence `ev_324f2e59…`.

### Subagent spawning: the Agent tool (`m0610.js`)
- The input schema has `description`, `prompt`, `subagent_type` and `model`. `model` is an enum of sonnet, opus, haiku and fable. There are also `effort` and `run_in_background`, at offset ~11,200–12,400.
- `run_in_background` reads "Agents run in the background by default; you will be notified" (offset ~12,106).
- An extended schema adds:
  - `name`, which must not be a reserved name. The reserved list includes "main", "team-lead", "user" and "system".
  - `team_name`, marked "Deprecated; ignored. The session has a single implicit team."
  - `isolation: ["worktree","remote"]`, described as "creates a temporary git worktree so the agent works on an isolated copy" (offset ~13,500).
  - `cwd`, which is mutually exclusive with worktree isolation.
- Fork semantics: `subagent_type: "fork"` "always inherit[s] the parent model" and "runs at your own effort". So a fork is a continuation of the parent's context, not a fresh context.
- Effort steering: `effort` accepts "lower"/"higher", meaning one step from the effort the agent would otherwise run at.
- Precondition errors: `AgentPreconditionError`, `RemoteAgentPreconditionError` and `AgentTypeError`. A cloud agent is refused under `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG`, and the error says to set isolation to "worktree".
- Auto-backgrounding: `CLAUDE_AUTO_BACKGROUND_TASKS` sets a 120,000 ms threshold (`$o()`).

### Agent definitions (frontmatter schema, `m0443.js` ~716,900 and ~2,361,900)
- Fields:
  - `name`, `description`, `model` (`inherit` is allowed), `tools`, `disallowedTools`, `effort`, `permissionMode`
  - `mcpServers` and `hooks` ("Hooks registered while this agent runs")
  - `maxTurns`, `autoCompactWindow`, `skills`, `initialPrompt`
  - `memory` (user, project or local), `background`
  - `omitClaudeMd`, which runs "without the user, project and local CLAUDE.md"
  - `isolation`, `observer`, `observerMessage`, `observeSubagents`
  - `experimental.cacheTtl` ("5m"/"1h")
- Observer agents (`m0122.js` ~221,546): an observer is "auto-spawned as a background observer". It "receives read-only activity digests and reports via the ObserverReport tool", and it "never participates in the task".
- Shared-checkout guard (`m0443.js` ~1,221,648): a background agent whose parent "hasn't isolated yet" has its writes blocked, with the advice to re-spawn with `isolation: "worktree"`.

### Result hand-back and live status (`m0122.js`)
- A hand-back flag is present when "the message is a subagent's final report … delivered through the SubagentHandback tool". It is "Stamped by the harness, never from tool input" (~230,580).
- `task_started` is a system event with `task_id`, `subagent_type` and `is_backgrounded` (~383,803).
- Messages carry `parent_tool_use_id`-style subagent attribution, "unchanged when the subagent is resumed" (~245,696).
- The `task-notification` delivery kind has subkinds `scheduled-trigger`, `peer-send-message`, `projects-relay` and `session-inbox` (~232,690).

### Teams and agent-to-agent messaging
- `SendMessage` routes to named agents. A reserved name "routes it to the main conversation" (`m0610.js`).
- `TeamCreate` and `TeamDelete` appear in a tool-name set in `m0443.js` ~1,365,995. Combined with the "single implicit team" deprecation note, this suggests (inference) that agent teams have folded into named background agents plus SendMessage.

### Permission modes (`m0122.js` ~190,457, `m0264.js` ~4,585)
- The modes are `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk` and `auto`.
- In `auto`, the tool "Use[s] a model classifier to approve/deny permission prompts."
- A child's `mode` input is "Deprecated; ignored. Subagents inherit the parent session's permission mode", unless the definition frontmatter overrides it (`m0610.js`).

### Plan mode (`m0443.js` ~4,769,968)
- The injected reminder begins "Plan mode is active … you MUST NOT make any edits". It asks for a plan that includes a verification section.
- `ExitPlanMode` occurs in 7 modules, including `m0122.js` and `m0443.js`.

### Hooks (`m0068.js` ~10,629; `m0122.js` ~191,007)
- There are 33 events: PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded and MessageDisplay.
- Plugin engine hook points include `agent.spawn` and `agent.offer` (`m0105.js` ~3,498). A plugin can set `cwd` on a spawn, which is then validated (`m0610.js` `subagent_cwd_refused`).

### Shell sandbox (`m0443.js`)
- **macOS**: `/usr/bin/sandbox-exec -p <profile>` wraps commands (~1,096,378).
- **Linux**: bubblewrap with seccomp (`n.bwrap`, `n.seccomp.kind==="file"`, ~1,088,319). There is an availability probe that returns `no_bubblewrap` (~1,090,358), and the probe result is cached.
- The Bash tool input has `dangerouslyDisableSandbox` ("run commands without sandboxing") and `run_in_background` (~4,651,120).
- Network policy settings (`m0068.js` ~38,536): `allowedDomains` (wildcards), `deniedDomains` ("always blocked"), `strictAllowlist`, `allowManagedDomainsOnly`, and managed `allowUnsandboxedCommands: false`.

### Checkpoints and rewind
- The transcript carries `file-history-snapshot` and `file-history-delta` records (`m0332.js` ~17,694 and ~22,021). Snapshots hold `trackedFileBackups` keyed by path per message (`m0443.js` ~408,101).
- The rewind result schema has `canRewind`, `filesChanged`, `insertions`, `deletions` and `skippedLinks`. A rewind fails when "every differing file fails to restore" (`m0122.js` ~223,333).

### Compaction
- `compact_boundary` system records are present.
- Per-model `autoCompactWindow` is "100000 to 1000000" tokens, or "auto" (`m0068.js` ~285,156).
- Environment overrides: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (`m0041.js`, `m0068.js`).
- Each agent definition can override the window.

### Worktrees
- Worktree validation errors cover symlinked ref stores and non-registered worktrees, with the advice "Recreate the worktree with git worktree add" (`m0443.js` ~1,205,168).
- `EnterWorktree` is in 6 modules.
- `WorktreeCreate` and `WorktreeRemove` are hook events.

### Edit semantics
- `old_string` appears in 8 modules. A literal "must be unique" error was not located in this pass (unknown).
- External (public Claude Code docs): Edit is an exact string replacement that requires a prior Read.

## 2. Codex CLI 0.162.1 (Rust)

Each item below is a string observation in the `codex` binary under REA evidence `ev_22639b41…`. The module paths are embedded panic/debug paths, so they name real source files.

### Multi-agent modules
- `core/src/agent/control/{spawn,spawn_guard,completion,interrupt,resume,residency,watch,inspection,user_authorization,target,sender_context}.rs`
- `core/src/agent/{agent_resolver,child_config,role}.rs`
- `core/src/tools/handlers/multi_agents/{spawn,send_input,wait,resume_agent,close_agent}.rs`
- `core/src/agent_message_board.rs` and the crates `agent-message-board` and `agent-message-board-client`
- `core/src/context/subagent_notification.rs`

### spawn_agent tool text
- "Spawns an agent to work on the specified task."
- Agents get hierarchical canonical task names (`/root/task1/task_3`).
- A spawned agent "will have the same tools as you and the ability to spawn its own subagents". It can message other running agents, and "its final answer will be provided to you".

### Context inheritance and limits
- `fork_turns` controls inheritance: "Parent history to inherit. Defaults to `all`; use `none`". Only `all` and `none` are supported.
- Depth guard: "Agent depth limit reached. Solve the task yourself."
- Concurrency config keys: `agents`, `max_threads` and `max_concurrent_threads_per_session`. Default values were not recovered (unknown).

### Other tools
- `wait_agent` guidance: "Call wait_agent very sparingly." Other tools are `interrupt_agent` and `list_agents`, plus `send_input` (keywords include "follow up interrupt redirect queue").
- Best-of: `best-of.select: attempts=`.
- `cloud-tasks` crate: `env_detect.rs`. Cloud tasks with N attempts are inferred to live here.

### Edit semantics: apply_patch
- Crate `apply-patch` has `seek_sequence.rs`, `file_update.rs`, `invocation.rs` and `standalone_executable.rs`.
- Literal: "The first line of the patch must be '*** Begin Patch'".
- Inference: an envelope diff format with fuzzy context seeking (`seek_sequence`), running through a sandboxed runtime (`core/src/tools/runtimes/apply_patch.rs`).

### Shell
- Execution goes through `unified_exec/exec_command.rs` and `write_stdin.rs`, which give a persistent PTY session. Shell snapshots are taken (`shell_snapshot_sandbox.rs`).
- There is a `zsh_fork` runtime with `unix_escalation.rs` and a `shell-escalation` crate.

### Sandbox
- Sandbox modes: `read-only`, `workspace-write` and `danger-full-access`.
- Approval policies: `untrusted`, `on-request` and `never`, with `UnlessTrusted`/`OnRequest` variants.
- **macOS**: a Seatbelt profile built from fragments such as `(version 1)`, `(allow file-read*)` and `(allow network-outbound (remote unix-socket …))`. `/usr/bin/sandbox-exec` is present.
- **Linux**: `sandboxing/src/landlock.rs`, with flags `--use-legacy-landlock`, `--managed-network` and `--permission-profile`.
- Managed network proxy: crate `network-proxy` (117 paths) and `core/src/tools/network_approval.rs`. Proxy environment variables are injected (HTTP_PROXY, NPM_CONFIG_HTTP_PROXY, PIP_PROXY and others).
- The filesystem permission model has `FileSystemAccessMode` read/write/deny/none, `writable_roots`, `exclude_slash_tmp` and `glob_scan_max_depth`.

### Guardian auto-review
- 351 strings sit under `core/src/guardian/{review,review_session,decision,input_budget,request_budget,permissions,prompt}.rs` and `session/guardian_checkpoint.rs`.
- Config: `ApprovalsReviewer`, `auto_review` and `strict_auto_review`.
- Inference: a separate reviewer model session judges approval requests under its own token budget.

### Other harness features
- **Hooks**: events PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit, SubagentStart, SubagentStop and Stop. Blocking is supported: "Command blocked by PreToolUse hook". MCP-based hook executors live in `hook_mcp_executor.rs`.
- **Compaction**: `compact.rs`, `compact_remote_history.rs`, `compact_token_budget.rs`, `compact_model_fallback.rs`, the `auto_compact_token_limit` config, and a `new_context_window` tool handler.
- **Plan**: `tools/handlers/plan.rs` and `prompts/src/update_plan_instructions.rs`, with "Plan mode" as a collaboration mode.
- **Persistence**: `rollout`, `thread-store` and `state` crates. `thread-store/src/local/rollout_migration/rollback.rs` handles rollback. App-server RPC strings include `thread/resume`, `thread/fork`, `thread/compacted` and `turn/interrupt`.
- **Worktrees**: `exec/src/worktree.rs`, with "Remove it manually with `git worktree remove` when safe".
- **MCP and skills**: `rmcp`/`rmcp-client`, `codex-mcp`, `core/src/mcp_tool_call.rs`, `mcp_tool_approval_templates.rs`, `skills` (86 paths) and `mcp_skill_dependencies.rs`.
- **Code mode**: `core/src/tools/code_mode/*` plus the external `codex-code-mode-host` binary ("enable `features.code_mode_host`"). Inference: the model writes scripts that call tools, which is comparable to Alevr's `workflow`.

## 3. Codex inside ChatGPT desktop

REA evidence `ev_298e6b90…` / `ev_e394ac37…`. The items below are string observations in the selected webview modules.

- **Architecture (observed)**: ChatGPT ships the full Codex Rust binary (`Resources/codex-cli/CodexCLI.app`, variant `codex`, 0.163.0-alpha.10.2). Inference: the Electron webview drives it over the app-server protocol, so the agent semantics match the CLI in section 2.
- **Subagent panel** (`chatgpt-subagents-panel-ad8b93c61a12.js`, `local-conversation-subagents-panel-tab-70cb3c70c0c0.js`): right-side panel strings include "Active · {count}", "Done · {count}", "Working", "Waiting", "Back to subagents", "Delegated task" and "Final response". Each row shows `{model} · {reasoning}`. There is also "This subagent is no longer available on the current branch". Inference: subagents are tied to conversation branches.
- **Final response lazy load**: `chatgpt-subagent-final-response-query-2004103d500a.js` handles "Loading the final response…".
- **Thread handoff** (`agent-activity-item-864ff5810ac7.js`): "Handing off to {destination}", where the destination is `local` or `worktree`, with failed, warning and completed states. Inference: a thread can move between the local checkout and a worktree.
- **Local environments** (`local-environment-editor-ed8841753d86.js`): per-project setup and cleanup scripts, including a cleanup that "Runs at the project root before worktree cleanup". Per-platform action buttons (Run, Test, Debug, Tool) appear in the header.
- **Hooks UI** (`hooks-settings-9419f1b4269a.js`): per-source trust review ("Trust all", "# need review") with the warning "Hooks run outside of the sandbox and may be unsafe". It also notes "Another config layer overrides these hook settings".
- **Auto-review** (`automatic-approval-review-details-c5a263461c7e.js`): "Requires explicit authorization because this action is considered high risk".
- **Inventory only** (not parsed): `checkpoint-*.js`, `code-diff-*.js`, `create-pull-request-modal-content-*.js`, `cloud-environment-editor-*.js`, `hook-stats-dialog-*.js`, `duplicate-agent-*.js` and `agents-md-editor-*.js`.
- **Naming collision**: ChatGPT ships `orbit-character` WASM assets. Alevr's "Orbit" brand should be checked for a trademark or UX overlap. This is a product note, not a technical finding.

## 4. Claude desktop: Claude Code tab

REA evidence `ev_a821f506…` / `ev_47bad85b…`. The items below are string observations in `.vite/build/index.chunk-CFJssAFf.js`.

- **Backends**: session `backend.kind` is `local` or `ssh` (~20,836 and ~55,402). Code sessions can run over SSH.
- **Worktree pool**: start timing records `worktreeCreated`, `worktreePoolEnabled`, `worktreeReused` and `worktreeLazy` (~22,967). Worktrees live under `.claude/worktrees/`. Edits to the shared checkout are "rejected" while isolation is required (~132,847).
- **Sibling sessions**: the `start_session` / `hand_off_to_session` tool surface accepts `use_worktree`, `model`, `effort`, `permission_mode`, `target`, `host`, `wake_when_done` and `proposal_id` (~274,246).
  - The parent wakes after its children settle (`maybeWakeParentAfterSideSessions`, `liveSideSessionsOf`, ~968,309).
  - Starts are gated by a verdict, either a card or the classifier (`desktop_ccd_side_session_start_gated`, ~212,625).
- **Rewind**: the desktop calls the CLI's rewind and tracks `rewindFilesRestoredFor`, plus a partial flag when `skippedLinks>0` (~929,231).
- **Permission broker**: `ToolPermissionBroker setMode` maps prompt suggestions to `setPermissionMode` (~250,519). The mode source is one of picker, tool_prompt, agent_tool or renderer (~810,720).
- **Remote control and attention**: the wake reason can be `remote_control`, `cron` or `loop_wakeup` (~20,653). Inference: there is a remote-control (phone or web) attach mode.
- **Version marker**: `"claude-code/0.3.299"` in `index.chunk-BlEfqh4Z.js` ~587,611.

## Inferences (cross-product)

1. Both leaders now treat a subagent as a **background-first, addressable peer**: it has a name or canonical path, can receive messages, and notifies on completion. Neither treats it as a blocking function call.
2. Context inheritance is always **two-valued**: Codex has `fork_turns` all/none, and Claude Code has `fork` versus a typed fresh agent. Neither offers summarised or partial inheritance.
3. **Isolation is per spawn and git-based**: a worktree, or remote/cloud. Claude adds a guard that refuses writes to the shared checkout once background isolation is expected.
4. **Recursion**: Codex allows recursion behind a depth guard. Claude Code's nesting limits were not recovered.
5. **Supervision**: Claude has observer agents that get read-only digests. Codex has the Guardian reviewer session for approvals.
6. **Sandbox parity**: both use Seatbelt on macOS. On Linux, Claude uses bubblewrap with seccomp and Codex uses Landlock. Both add a domain-allowlist proxy.

## Unknowns

- Default values for Codex `max_threads` and depth, and Claude Code's maximum parallel or nested agent counts.
- Claude Code's exact Edit uniqueness wording, and whether bytecode-only modules hide more logic. Sources were present alongside the bytecode, but completeness is unproven.
- ChatGPT checkpoint semantics: whether they are git-based or file snapshots. The `checkpoint-*.js` modules were not parsed.
- How the iOS ChatGPT and Claude apps show running agents. No iOS binaries are on this Mac.

## Limitations

- The Claude Code JS was carved by marker (`// @bun @bytecode` up to NUL), so module boundaries are approximate. REA parsed 5 of 2,394 modules. One module, `m0159.js`, exceeded the semantic budget, and only its static facts were kept.
- REA `trace_application_feature` on literal seeds returned `no-match` (`ev_d57ea4bb…`). Feature facts therefore rest on string observations, not traced call paths.
- No Hopper or native decompilation was run on the 246–250 MB Rust binaries (memory policy). Behaviour is inferred from strings and module paths only.
- ChatGPT and Claude asar integrity metadata contradicted the bytes of several `.node` binaries, which are recorded as untrusted. The JS modules used here were not affected.
- Nothing was executed. The runtime behaviour, defaults and feature-flag gating of every observation are unverified.
