# Juno Code: backend and runtime audit

Date: 2026-09-22. Read-only audit of `main` @ c9cae856.
Paths are relative to `native/Packages/JunoCode/Sources/` unless they start with `native/`, `src/` or `runner/`.

## Verdict

The Swift runtime is well-engineered at the *safety-primitive* level: approval digests, fail-closed permission revocation, fingerprinted writes, per-file checkpoints, a kernel sandbox profile, and interruption repair. It builds cleanly and has about 780 passing tests. Four things hold it back from being a production coding agent:

- **The agent core is thin.** The system prompt is short. There is no prompt caching. Thinking blocks are not replayed. Compaction is lossy and mechanical. There is a hard 40-iteration cap. `read_file` cannot page. There is no todo/plan tool, no web fetch, and no background shell.
- **Two real correctness bugs can permanently break a session's conversation:** orphaned `tool_use` blocks after steering or goal completion.
- **Three permission escalations:**
  - Write-capable sub-agents in non-git folders.
  - The queued remote path can grant full access.
  - The agent can read anything on disk and has network access in every mode.
- **No durable permission rules, no user-level config, and no notifications.** There are two separate agent runtimes: the Swift local runtime and `runner/agent-core` in TypeScript for the cloud.

## 0. Build and test status

- `swift build --package-path native/Packages/JunoCode`: **compiles, 0 warnings, ~34 s** on a clean build (Swift 6 language mode).
- `swift test --package-path native/Packages/JunoCode --parallel`: **all pass**. That is 707 XCTest cases plus 69 Swift Testing cases, in ~21 s.
- Test targets: `JunoCodeCoreTests`, `JunoCodeLocalTests`, `JunoCodeRuntimeTests`, `JunoCodeUITests`, `JunoCodeBridgeTests`, `JunoSimulatorTests`. `AgentOrchestratorTests` alone is 1,106 lines. The bridge has end-to-end tests over a scripted transport.
- Coverage gaps: no test drives a live provider. No test covers a steer between tool waves (see bug B1). No test covers a thinking-enabled multi-turn tool loop against the real Anthropic shape. No test checks MCP tool-name length. The 707 tests are strong on policy and state machines and weak on "does a real model session work end to end".

## 1. End-to-end agent loop

**Path of a prompt:**

1. `Composer` calls `SessionController.send()` (`JunoCodeUI/Models/SessionController.swift:976`).
2. The `@file` context is expanded into a model-only prompt (`:1182-1231`, 16 KB per file, 64 KB total).
3. A `turnConfiguration` event is appended (`:1040`).
4. `currentOrchestrator(live)` builds or reuses an `AgentOrchestrator` keyed on a `TurnContract` (`:275-302`, `:565-604`). The contract covers behavior, model, effort, vision, computer use, `goalUpdatedAt`, hook policy, custom agent and extensions. A change to any of these rebuilds the orchestrator, but never while one is running.
5. `AgentOrchestrator.submit` (`JunoCodeRuntime/AgentOrchestrator.swift:194`) appends the user message and persists `conversation.json`. It then spawns an unstructured `Task` running `runLoop()` (`:371-841`).

**`runLoop`, per iteration:**

1. Check the iteration cap. **Default 40** (`:43`); exceeding it ends the run as `failed` (`:386`).
2. Apply pending steer instructions (`:409`).
3. Compact if needed (`:411`).
4. Build a `ModelTurnRequest` with the **whole tool list and system prompt on every turn** (`:424-437`).
5. Stream from `AgentModelClient.streamTurn`. Text deltas go to a live-text observer throttled to 20 Hz (`:182`). Reasoning deltas are collected into one summary. Tool calls are collected. `usage` *replaces* `contextTokens` (`:463-474`).
6. On error: typed classification (`:486-523`). If the error looks like overload or quota, one fallback to a different model is tried (`:525-545`). Otherwise there is one retry after 500 ms (`:552-565`). There is no backoff and `retry-after` is not honored.
7. Persist a `reasoningSummary` and an `assistantMessage` (`:595-614`).
8. `maxTokens` ends the run as `failed` with "Continue to resume" (`:616-635`).
9. Tool calls are recorded as `toolProposed` (`:679-697`). A steer arriving before execution discards the proposal (`:703-707`).
10. `ToolScheduler.execute` partitions calls into conflict-free waves (`JunoCodeRuntime/ToolScheduler.swift:46-97`) and runs reads in parallel. Each call goes through lifecycle hooks, then `authorizeInvocation`, then execution (`:147-335`).
11. Results are appended as `toolResult` (bounded to 512 KB each, `:781-798`). The conversation is saved and the loop continues.

**Approvals.** `PermissionCoordinator.authorize` suspends on a `CheckedContinuation` (`JunoCodeRuntime/PermissionCoordinator.swift:106`). The UI resolves it through `approve`/`deny` (`SessionController.swift:1350-1368`). The digest and expiry are re-verified after approval (`ToolRegistry.swift:126-130`). The TTL is 15 min (`PermissionCoordinator.swift:17`). Lowering the mode revokes everything pending (`:43-56`).

**System prompt.** `WorkspaceContext.systemPrompt()` (`JunoCodeUI/Models/WorkspaceContext.swift:213-283`) is about 25 lines: one behavior line, one role line, the `read_file`/`base_sha256` contract and preview instructions. Then comes a "REPOSITORY CONTEXT" block, then `goalSystemPrompt` (`SessionController.swift:834-881`), then `extensionsSystemPrompt` (enabled skills and the custom agent, `:2719-2734`). Projectless sessions get a separate prompt (`:803-814`).

The system prompt is missing:
- Environment facts: OS, date, cwd, branch.
- Git status snapshot.
- Tool-usage guidance.
- Git and commit etiquette.
- Output and style guidance.
- Safety guidance for destructive git operations.

**Project instructions.** Only **root-level** `CLAUDE.md`, `AGENTS.md`, `JUNO.md`, `.cursorrules` and `CONTRIBUTING.md` are read (`WorkspaceContext.swift:197-209`, 24 KB each, 256 KB total). There are no nested or directory-scoped `AGENTS.md` files, no user-global instruction file (`~/.claude/CLAUDE.md` or `~/.juno/…`), no `CLAUDE.local.md`, and no `@import`. Instructions are framed as "untrusted, lower priority" data (`:247-251`), which will make models under-weight legitimate team conventions. They are read once per orchestrator build, not per turn.

**Git status.** Not injected into context. The model must call `git_status`.

**Streaming.** Yes. The bridge parses SSE for Anthropic Messages, OpenAI Chat and OpenAI Responses (`JunoCodeBridge/BackendCodeModelClient.swift:1004-1089` for Anthropic).

**Compaction.** `ConversationCompactor` (`JunoCodeRuntime/ConversationCompactor.swift`) is deliberately *structural*, with no LLM summary (`:16-25`). It keeps the first user message and the last 6 user-led turns. Everything between is flattened into "- Role: text" lines, **head-truncated to 12,000 characters**. That keeps the *oldest* material and drops the most recent (`:164-168`). It triggers at 80% of the manifest context window, based on the last reported `input_tokens`, or on a byte proxy (`AgentOrchestrator.swift:876-910`). `/compact` calls `compactNow` (`:919`). **Bug:** each compaction appends a new summary to the anchor message, which already holds the previous summary (`ConversationCompactor.swift:100-118`), so the anchor grows by up to 12 K characters per compaction without bound.

**Token accounting.** Only the last turn's input and output tokens, held in memory and not persisted (`AgentOrchestrator.swift:95-99`, `SessionController.swift:404-406`). There is no per-session cumulative usage, no cost figure, and no per-sub-agent totals beyond a final tally.

**Prompt caching.** **None.** `AnthropicRequestBuilder.body` sends `system` as a plain string with no `cache_control` on tools, system or messages (`BackendCodeModelClient.swift:570-592`). The backend proxy is a pure pass-through (`src/app/api/agent/[...path]/route.ts:160-216`). `src/lib/anthropic.ts:179-232` *does* implement caching, but only for Chat. On top of that, the system prompt changes whenever the goal changes (`TurnContract.goalUpdatedAt`) and when skills are toggled. Every agent turn therefore re-bills the full system prompt, tools and history at full input price. This is probably the single largest cost and latency item.

**Thinking.** Effort is mapped per model family (`JunoCodeBridge/CodeThinkingWire.swift:126-180`, adaptive plus `output_config.effort`, or `budget_tokens`). The stream parser turns `thinking_delta` into a `reasoningSummary` (`BackendCodeModelClient.swift:1036-1040`). It **never captures `signature_delta` and never replays thinking blocks**: `ModelMessage` has no thinking case (`JunoCodeRuntime/ModelClient.swift:30-50`). Anthropic's guidance is to pass thinking blocks back unchanged in a same-model tool loop. Dropping them loses the model's reasoning continuity between tool calls and invalidates the message cache from that point on the models that preserve thinking.

## 2. Tool inventory

| Tool | File | Risk tier / policy | Notes |
|---|---|---|---|
| `read_file` | `Tools/FileTools.swift:37` | read | UTF-8 only, ≤1 MB, then capped to 512 KB by the orchestrator. **No `offset`/`limit`, no line numbers.** A truncated file cannot be paged at all. |
| `list_directory` | `Tools/SearchTools.swift:4` | read | |
| `glob` | `SearchTools.swift:46` | read | limit ≤500 |
| `grep` | `SearchTools.swift:86` | read | Swift walker, not ripgrep. Root `.gitignore` only. **No context lines, no files-only mode, no multiline.** 50 K-entry walk cap (`JunoCodeLocal/WorkspaceIndexService.swift:14-15`). |
| `find_files` | `SearchTools.swift:136` | read | Substring match on file names. |
| `create_file` | `FileTools.swift:135` | write | Checkpointed. |
| `write_file` | `FileTools.swift:174` | write | Requires `base_sha256` to overwrite. Checkpointed. |
| `apply_patch` | `FileTools.swift:232` | write | Single exact-string replace, optional `replace_all`. **Not a multi-hunk patch and not multi-edit.** |
| `delete_file` | `FileTools.swift:290` | critical | Checkpointed. |
| `move_file` | `FileTools.swift:328` | write | |
| `run_command` | `Tools/CommandAndTestTools.swift:4` | classifier-derived (read to destructive) | One-shot `zsh -c` in a sandbox. 120 s default, 600 s max. `&` and dev servers are refused (`:169-189`). **No background shell, no stdin, no persistent shell state.** Output is **head-truncated**, so build errors at the tail are lost (`JunoCodeCore/OutputLimiter.swift:36-50`). |
| `run_tests` | `CommandAndTestTools.swift:192` | critical + `alwaysRequiresApproval` | Asks on every run in every mode, including Full Access. |
| `git_status`, `git_diff`, `git_log` | `Tools/GitTools.swift` | read | `git_diff` output is unbounded except by the 512 KB cap. |
| `git_commit` | `GitTools.swift:127` | critical | Its description says it "always require[s] confirmation" (`:136`), but `.critical` is allowed silently in Full Access (`JunoCodeCore/PermissionModel.swift:156`). This is the same class of bug they already fixed for `run_tests`. |
| `web_search` | `Tools/WebSearchTool.swift` | read | Through the backend. |
| `update_goal` | `Tools/UpdateGoalTool.swift` | write | One durable goal per session. **A second goal can never be created** (`JunoCodeRuntime/CodeSessionStore.swift:197-199`). In Ask-before-changes mode every step update needs approval. |
| `delegate_task` | `Tools/DelegateTaskTool.swift:20` | **read** | Up to 4 sub-agents per call, 3 concurrent, 10-minute budget, 18 iterations each. Can request `workspace_write` (see S1). |
| `computer_screenshot`, `computer_click`, `computer_type`, `computer_press_key`, `computer_scroll` | `Tools/ComputerUseTools.swift` | per-tool | Only when the model has vision and the user has activated Computer Use for this session. |
| `inspect_active_editor` | `Tools/EditorBufferTools.swift` | read | Accessibility read of the frontmost editor. |
| `open_preview`, `inspect_preview`, `preview_browser` | `JunoCodeUI/Views/Preview/CodePreviewInspectionTool.swift:121,186,324` | | UI-bound. Code behavior only. |
| `mcp__<server>__<tool>` | `JunoCodeRuntime/MCP/MCPCodeTool.swift` | critical + `alwaysRequiresApproval` | Text results only; images are dropped. |

Compared with Claude Code and Codex:

- **Missing:**
  - Paged Read.
  - MultiEdit, or a real `apply_patch` in Codex's multi-file patch format.
  - Bash with background processes and `BashOutput`/`KillShell`.
  - WebFetch.
  - TodoWrite / `update_plan`: `update_goal` is heavyweight, single-use and approval-gated.
  - NotebookEdit.
  - AskUserQuestion.
  - An ExitPlanMode handoff: Plan mode is only a read-only behavior with no "approve plan, then implement" transition.
  - `view_image` for workspace images.
  - Custom agents as delegate targets: custom agents only replace the system prompt of the *main* session.
- **Half-wired or dead:**
  - `ToolConflictEffect` names tools that don't exist: `fetch_url`, `git_checkout`, `git_branch`, `terminal_command`, `computer_action`, `screen_capture` (`JunoCodeCore/ToolConflictEffect.swift:62-100`). Meanwhile `list_directory`, `find_files`, `create_file` and `move_file` fall through to `.exclusive`, so they are serialized for no reason.
  - The MCP tool name can reach 199 characters (`MCPCodeTool.swift:17-19`, `:66-73` use `prefix(96)` per segment). Anthropic's limit is 64 (`^[a-zA-Z0-9_-]{1,64}$`), so long server or tool names will fail the whole turn with a 400.
  - `parseToolInput` silently turns malformed or truncated tool JSON into `{}` (`BackendCodeModelClient.swift:1071-1080`).

## 3. Permission model

**Modes** (`JunoCodeCore/PermissionModel.swift:4-13`): `readOnly`, `askBeforeChanges`, `workspaceWrite`, `fullAccess`. Behaviors (`ask`, `survey`, `plan`, `code`) sit on top. Every non-Code behavior forces `readOnly` and swaps in the inspection-only registry (`ToolRegistry.swift:11-14`, `SessionController.swift:624-626`).

**Risk ladder** (`PermissionModel.swift:127-159`):
- `destructive` always asks (outside the grant, history rewrite, etc.).
- `critical` (network or arbitrary code inside the grant) is allowed only in Full Access.
- `ApprovalPolicy.alwaysRequiresApproval` pins a tool to asking (`:82-91`).

This part is well designed.

**Suspension.** True suspension on a continuation, with digest binding, a 15-minute expiry that fails closed, and `denyAll` on stop. `sweepExpired` is only triggered by the approval card's countdown (`JunoCodeUI/Views/ApprovalCard.swift:132`), so a background session's expired approval is not swept until someone views it.

**Allowlists and rule persistence: none.**
- The only "remember" gesture is `approveAllowingFurtherEdits`, which raises the *session mode* to `workspaceWrite` (`SessionController.swift:1377-1380`).
- There are no per-command, per-path or per-tool allow/deny rules.
- There is no "always allow `npm test` in this project".
- Nothing persists across sessions.
- Every MCP call and every test run asks, forever.

**Sandboxing.** `sandbox-exec` profile (`JunoCodeLocal/CommandSandboxProfile.swift`):
- `(deny default)`, then `(allow file-read*)` **everywhere**. Writes are allowed only to the workspace, `/private/var/folders`, `/private/var/tmp` and a few `/dev` nodes (`:28-36`).
- **Network is always on** for the agent executor (`WorkspaceContext.swift:79-83`) and the terminal.
- The environment is minimal: PATH, HOME, TMPDIR only (`JunoCodeLocal/CommandExecutionService.swift:182-199`). There is no `SSH_AUTH_SOCK` and no user environment variables. The shell is a non-login `zsh -c`, so nvm, pyenv and asdf shims from `.zshrc` are missing unless `ToolchainEnvironment` guesses them.

**Consequences:**
- Package managers that write to `~/.npm`, `~/Library/Caches`, `~/.cargo` or `~/.gradle` will get EPERM or degrade. This needs live verification.
- A prompt-injected repository in Full Access can read `~/.ssh` or `~/.aws` through an interpreter (e.g. `python -c ...`) and send it out. Only the string-level `CommandClassifier` stands in the way; it flags `~`/`$HOME` words (`JunoCodeCore/CommandClassifier.swift:495`), but not paths computed inside scripts.
- The app itself is not App-Sandboxed (`native/macOS/JunoDesktop/Resources/JunoDesktop.entitlements`).

**Network policy.** Binary and fixed: outbound and inbound are allowed for agent commands. There is no domain allowlist and no setting.

## 4. Sessions

- **Persistence.** `CodeSessionStore` stores `sessions/<id>/session.json`, `events.jsonl` (append-only) and `conversation.json` (`CodeSessionStore.swift:11-17`) under `~/Library/Application Support/JunoCode/accounts/<sha256(accountID)>/sessions-store` (`JunoCodeUI/Models/WorkbenchModel.swift:130-151`).
  - Startup repair marks active sessions `failed: Interrupted by app termination` (`CodeSessionStore.swift:390-437`).
  - **Scaling issue:** `loadIfNeeded` decodes *every event of every session* at launch (`:372-383`), and `events(for:)` re-reads and decodes the whole JSONL file on every call (`:318-326`). Callers include attach, diff stats, sub-agent views and `DelegateTaskTool`.
- **Resume.** Implicit. Sending a new prompt reloads `conversation.json` (`AgentOrchestrator.swift:300-321`). Pending steer/queue instructions are rebuilt from events. There is no "continue" that resumes a partially streamed turn.
- **Rename, favorite, delete.** Present (`WorkbenchModel.swift:666-724`). Delete also removes child sessions and checkpoints.
- **Fork.** Absent. It is explicitly unsupported remotely (`WorkbenchRemoteBridge.swift:194-199`).
- **Archive, export, transcript search.** Absent. Search matches title and project name only (`WorkbenchModel.swift:746-756`).
- **Checkpoints and rewind.**
  - Per-file pre-image checkpoints for structured file tools only (`JunoCodeLocal/CheckpointStore.swift`). There is revert per file, per hunk and to a checkpoint (`SessionController.swift:1503-1842`).
  - There is **no conversation rewind** (no "edit message N and branch") and no turn-level snapshot. The code says so at `SessionController.swift:340-342`; `docs/native/CODE_AGENTS.md` claims "per-turn checkpoints".
  - `run_command` edits are not checkpointed. They are only reported, and to do so the tool walks the whole workspace twice per command (`CommandAndTestTools.swift:90-126`).
  - Review accept/reject state (`reviewStates`) is held in memory and lost on relaunch.
- **Retry.** `retryLastTurn` resends the last prompt as a new user message (`SessionController.swift:1074-1087`). It does not rewind, so history holds the prompt twice.
- **Worktrees.** Real (`JunoCodeLocal/WorktreeManager.swift`, 770 lines). A session can be rooted in one (`WorkbenchModel.swift:447-484`), and write sub-agents use them. They live at `.juno/worktrees` *inside the repo* (`WorktreeManager.swift:92`, `:168`). `.juno` is **not** in the index exclusions (`WorkspaceIndexService.swift:9-12`), so the parent's grep and glob will traverse worktree copies unless `.gitignore` lists `.juno`.
- **Parallel and background sessions.**
  - Controllers are cached per session and never evicted (`WorkbenchModel.swift:232`, `:551-632`). Orchestrators run in their own tasks, so sessions keep running when the UI switches.
  - `detach()` stops observation and **revokes Computer Use** (`SessionController.swift:963-972`).
  - **There are no notifications of any kind:** no UserNotifications use anywhere in Code or Desktop.
  - Each controller observes *every* store event from every session (`:945-948`), which costs N MainActor hops per event.
  - Each `fileChanged` event triggers a full projection rebuild over all events (`:2917-2932`, `:2985-3007`), which is O(n²) over a long session.

## 5. Extensibility

- **MCP.**
  - Config comes only from workspace `.mcp.json` and `.juno/mcp.json` (`JunoCodeRuntime/MCP/MCPServerConfiguration.swift:133`), over stdio or HTTP/SSE.
  - Per-workspace consent is stored privately (`JunoCodeUI/Models/MCPServerPolicyStore.swift`).
  - Tools only: no resources, prompts, OAuth or user-global servers. There is no UI to add servers.
  - Servers start lazily when a Code orchestrator is built (`WorkspaceContext.swift:136-142`).
  - The `CodeDefaults.disabledMCPServers` toggle is a dead write path: it is read but never written from the UI.
- **Hooks.**
  - Parsed from `.claude/settings.json` and `.juno/hooks.json` in Claude format, with matchers (`JunoCodeLocal/Extensibility/HookConfigurationParser.swift`).
  - Only 4 events: `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop` (`HookTypes.swift:10-14`, `:43-45`). There is no `UserPromptSubmit`, `Notification`, `PreCompact` or `SubagentStop`.
  - **No JSON stdin payload and no JSON decision output**, so real Claude Code hooks that read `tool_input` will not work.
  - Trust is an explicit private allowlist. Execution is sandboxed.
  - **Bug:** the approval text is broken, `"Run (invocation.hook.source.rawValue) hook (invocation.hook.id)"` with the backslashes missing (`JunoCodeUI/Models/WorkspaceAgentHooks.swift:134`).
- **Skills.**
  - Discovered from `.claude/skills` and `.juno/skills`.
  - **Every enabled skill's full SKILL.md is injected into the system prompt on every turn** (`SessionController.swift:2728-2732`). There is no progressive disclosure, even though `SkillActivation.swift` documents explicit activation.
  - Skills are enabled by default with no trust gate. That is inconsistent with hooks and MCP, and it is a prompt-injection vector.
  - The skill ID hashes the file's content (`JunoCodeLocal/Extensibility/SkillActivation.swift:30-32`), so editing a disabled skill silently re-enables it.
  - Skills are *also* exposed as slash prompts (`JunoCodeUI/Models/SlashCommands.swift:428-432`).
- **Custom agents.** `.claude/agents` and `.juno/agents` (`CustomAgentDiscovery.swift`). They only replace or augment the main system prompt (`SessionController.swift:2721-2727`). They cannot be delegate targets and cannot restrict tools or set a model.
- **Slash commands.**
  - 11 built-ins (`SlashCommands.swift:198-321`) plus workspace `.claude/commands` and `.juno/commands`. There are no user-global commands.
  - `/compact` is the only real action. `Action.review` is defined and handled but no command uses it (`:53`).
  - `/boost` *claims* to boost reasoning effort but only inserts prompt text; the effort is unchanged.
  - `/teamwork-preview` describes "multi-agent worktrees and staging" features that don't exist.
  - There is no `/clear`, `/model`, `/init`, `/memory`, `/permissions`, `/resume`, `/rewind` or `/context`.
  - `docs/native/CODE_SLASH_COMMANDS.md` lists 6 built-ins.
- **Memory.** None: no auto-memory, no `#`-to-memory, no user instruction file.

## 6. Models

- **Catalog.** From the account's `/api/v1/models` manifest (`WorkbenchModel.availableModels`, `CodeModelCatalog.swift`). The thinking ladder comes from the manifest; an empty ladder means no thinking parameter is sent (`WorkbenchModel.swift:40-64`).
- **Routing.** Through `BackendCodeModelClient`, as Anthropic Messages, OpenAI Chat or Responses via `/api/agent/<provider>/…`. There is a 120 req/min per-user limit and a plan budget (`src/app/api/agent/[...path]/route.ts:71-104`).
- **Persistence.** Per-session `AgentConfiguration.modelID` and `reasoningEffort`. Defaults live in `CodeDefaults` (UserDefaults) and are read only by the New-task screen.
- **Fallback.** `CatalogFallbackResolver` switches **silently and automatically to a model from a different provider** on overload or quota (`JunoCodeUI/Models/CatalogFallbackResolver.swift:35-65`). This contradicts the comment at `SessionController.swift:264-266`, which says it fails rather than switches. Problems:
  - (a) Backend 402 `QUOTA_EXCEEDED` is the *user's plan* budget, and it maps to `quotaExhausted` (`BackendCodeModelClient.swift:307-310`), which triggers a cross-provider fallback that hits the same budget.
  - (b) The original `reasoningEffort` is still sent to the fallback model (`AgentOrchestrator.swift:436`), bypassing the `takesThinkingParameter` check and risking the 400 the code elsewhere works hard to avoid.
  - (c) The resolver snapshots the catalog when the controller is created (`WorkbenchModel.swift:626`).
  - (d) The switch lasts only for that orchestrator and is not reflected in `session.configuration`.
- **`max_tokens`** defaults to 128 K (`BackendCodeModelClient.swift:180`).

## 7. Git integration

- **Agent tools:** status, diff, log and commit. The commit stages the given paths, or *all* changed files when omitted (`GitTools.swift:165-171`). The agent has no branch, push or PR tools, by design.
- **User actions** (`SessionController.swift`):
  - Branch creation (`:1848`). Its doc comment says "there is no worktree support", which is stale.
  - Worktree create and remove (`:1879-1912`).
  - Commit, which **stages every changed and untracked path** (`:2619-2644`).
  - Confirmed push plan (`:2648-2708`).
  - PR via `gh pr create` (`:2835-2859`) and PR status.
- **Missing:** co-author trailer or author settings, auto-commit per turn, commit-message generation built into the UI, conflict handling, stash, and diff against a base branch for review.
- **Git environment:** it uses the minimal environment with no `SSH_AUTH_SOCK`, so SSH-remote pushes probably fail. This needs live verification.

## 8. Cloud, device and remote execution

A sub-investigation traced this area. I re-verified the starred items myself.

- **Local model path: real.** `BackendCodeModelClient` sends:
  - Anthropic models to `/api/agent/<provider>/v1/messages` (`:246`).
  - Other labs to `/chat/completions` (`:263`).
  - Codex/pro models to `/api/agent/openai/responses` (`:280`).
  
  The proxy (`src/app/api/agent/[...path]/route.ts`) is a verbatim pass-through with the server key swapped in. It enforces auth, a 120/min limit, the plan budget and rolling windows (402). It has a **hard 240 s abort** (`:20`), so a single long thinking turn over 4 minutes is cut regardless of the client's 15-minute timeout.
- **Billing gap.** The proxy never records spend. `/api/agent/usage` has no native caller, and the cloud runner never passes a reporter (`scripts/cloud-code-runner.mjs:959-982`). Code spend is budget-*checked* but never *charged*.
- **\*OpenAI Chat parallel tool calls produce invalid requests.** Each `.toolCall` becomes its own assistant message (`BackendCodeModelClient.swift:645-677`). Two parallel calls therefore serialize as `assistant{c1}, assistant{c2}, tool{c1}, tool{c2}`, which OpenAI-compatible APIs reject. The Responses path sends `store:false` without `include:["reasoning.encrypted_content"]` (`:824`), so reasoning is lost between tool turns. Chat providers all get `max_tokens` 128 K uncapped (`:716-718`).
- **Cloud tasks: real.** The flow is `NativeCodeModel.startTask` (JunoCodeKit `NativeCodeModel.swift:300-334`), then `POST /api/code/tasks` with `target:"cloud"`, then a GitHub Actions `workflow_dispatch` (`src/lib/cloud-code.ts`). That runs `.github/workflows/code-runner.yml` and `scripts/cloud-code-runner.mjs`, which runs the **TypeScript** `runner/agent-core` in a Docker sandbox with no network, calls models via the proxy with a `cct_` token, and opens a PR. Progress streams over SSE. **Gap:** native task creation sends no model, effort or permission (`NativeCodeTaskStore.swift:1259-1300`).
- **\*Device task queue: broken in production.**
  - `DesktopQueuedCodeHost` long-polls `/api/code/queue` and decodes `NativeCodeAgentTask`. That type has synthesized `Codable` and *requires* `agentRuntime`, `permissionMode`, `computerUse` and `subagentsEnabled` (`native/Packages/JunoNativeKit/Sources/JunoCodeKit/NativeCodeAgentClient.swift:37-60`).
  - `serializeTask` (`src/lib/code-remote.ts:285-323`) never emits three of those, and `permissionMode` is null for device tasks. Decoding always fails, the host retries every 2 s forever, and tasks stay `queued`.
  - The unit test passes only because its fixture includes the missing fields.
  - This also means S2 (full access through the queue) is latent rather than exploitable today. It becomes live the moment decoding is fixed.
- **Session relay (phone controls Mac sessions): commands flow, state never comes back.**
  - The Mac claims and acknowledges commands (`CodeRemoteHost.swift:124-192`) but never uploads events or its session list. `postEvents` is only called by a dead `CodeRemoteEventBridge`, and nothing calls the snapshot PUT. The phone's transcript is permanently empty.
  - Phone `createSession` sends `workspaceKey` and `prompt`; the Mac requires `workspaceId` and `initialMessage` (`RemoteCommandAdapter.swift:193,206`).
  - `patchSession` is rewritten server-side to `apply_patch`.
  - Accept, reject, undo and delete-change have no relay mapping (`CodeRelayProtocolAdapter.swift:62-76`).
  - A claimed but unacknowledged command is stuck forever.
  - The transport is HTTP long-poll (25 s) plus an SSE route that polls the database every second.
- **Local vs cloud: two separate worlds.** Local sessions are `CodeSession`s run by Swift `AgentOrchestrator`. Cloud and device tasks are server `CodeTask`s run by the TypeScript runner or, in theory, by the Mac queue host. `WorkbenchModel`'s remote path (`remoteExecutionModel`, `startRemoteSession`) is never composed (`JunoDesktopRootView.swift:235-247`) and has no callers.
  - There are two task clients (`NativeCodeTaskClient`, `NativeCodeAgentClient`). The latter's create methods are uncalled and would 400.
  - There are four SSE parsers.
  - There are two unrelated `CodeExecutionLocation` types.
- **Dead code.** `CloudCodeSandboxClient` (708 lines) and `LocalPythonSandboxClient` (458 lines) have no production transport, no route and no registered tool; only tests use them. Also dead: `CodeRemoteEventBridge`, `CanonicalRelayCommandExecutor`, `NativeCodeTaskRemoteSessionProvider`, `RemoteExecutionModel` and `ExecutionLocation.swift`.
- **Docs.** `CODE_REMOTE_AUDIT.md:86-91` claims remote hosting is done and wired, which it is not. `JUNO_CODE_HANDOFF.md:130` still says "later".

## 9. Settings

Persisted settings, per the settings investigation:
- Four core defaults in `JunoCodeUI/Models/CodeDefaults.swift:69-76`: permission mode, model, effort and environment. **They reach only the local New-task screen**, read once per view instance.
- Disabled MCP, hooks and skills.
- Hook last-run.
- Remote-host allow.
- MCP consent and hook trust files.

Where the defaults don't reach:
- Cloud and Device tasks ignore model, effort and permission entirely (`native/macOS/JunoDesktop/App/DesktopCodeStudio.swift:2684-2691` calls `code.startTask(prompt:)`).
- Relay sessions use the first model and `.medium` effort.

Fixed or hardcoded, with no setting:
- Network (always on), sandbox, shell (`zsh`).
- Worktree location (`.juno/worktrees`) and branch naming (`juno/<base>-<stamp>`).
- Diff style (held in memory only).

Missing:
- Allow/deny rules, environment variables, MCP/hook/skill management and user-level config.
- Global instructions.
- Notifications, keybindings.
- Git author, co-author and auto-commit.
- Sandbox and network toggles.
- Telemetry, font sizes.
- Iteration limit, compaction threshold, sub-agent toggle.

## 10. Bugs, dead code, and claims that don't hold

**Correctness**

- **B1. Orphaned `tool_use` breaks the session permanently.**
  - `AgentOrchestrator` appends *all* tool calls to the conversation (`:727-733`) before execution.
  - Execution can stop early in two ways. (1) A steer between waves: `ToolScheduler.execute` runs `shouldInterrupt` before each wave (`ToolScheduler.swift:110-113`), and that calls `applyPendingInstructions`, which *appends the steer user text and saves the conversation* before any tool result exists (`AgentOrchestrator.swift:747`, `:845-871`). (2) A goal lifecycle change, which `break`s out of the result loop (`:799-808`).
  - Either way, calls that never ran get no `tool_result`, and on a steer a text block sits ahead of the tool results.
  - Both the Anthropic and OpenAI APIs reject this with a 400 on the next request. One retry fails, the run fails, and because the broken history is persisted, **every future turn in that session fails**.
  - Realistic trigger: the model issues `[read_file, run_command]` (two waves) and the user steers while the read runs; or it calls `update_goal(completed)` alongside another tool.
  - Fix: synthesize `tool_result` blocks with `is_error: true` ("not executed: interrupted by user") for every unexecuted call, and insert steer text only *after* the tool results. Add a validator that repairs history before every request.
- **B2. Compaction anchor grows without bound, and the summary keeps the wrong end** (see §1).
- **B3. Fallback sends the wrong thinking parameters and fires on the user's own budget** (§6).
- **B4. Thinking blocks and signatures are dropped** (§1).
- **B5. MCP tool names can exceed 64 characters**, failing every turn when such a server is enabled (§2).
- **B6. `run_command` output is head-truncated**, so tails and error summaries are lost (§2).
- **B7. The remote bridge overwrites the local composer.** `WorkbenchRemoteBridge.sendMessage`, `steerMessage` and `queueMessage` set `controller.composerText` and call `send()` (`:143-169`). That destroys the local draft and **sends any locally pending attachments and `@file` references with the remote message**.
- **B8. Remote commit reports success on failure.** `performGitAction("commit")` ignores the result of `controller.commit` (`WorkbenchRemoteBridge.swift:271`).
- **B9. Hook approval text is broken** (`WorkspaceAgentHooks.swift:134`).
- **B10. Only one goal per session, ever** (`CodeSessionStore.swift:197-199`). The system prompt then tells the agent the goal is "complete and immutable" for the rest of the session.
- **B11. A disabled skill re-enables itself when edited** (`SkillActivation.swift:30-32`).
- **B12. Approval events are written from unordered `Task {}`s** in the observer (`AgentOrchestrator.swift:328-365`), so a fast approval can persist `approvalResolved` before `approvalRequested`.
- **B13. A partial last JSONL line corrupts the next append.** There is no newline check (`CodeSessionStore.swift:302-306`).
- **B14. OpenAI Chat parallel tool calls produce an invalid message sequence** (§8).
- **B15. The device queue never decodes a real server task** (§8).
- **B16. The proxy's 240 s hard abort** will cut long adaptive-thinking turns (§8).
- **B17. Code usage is never recorded as spend** (§8).

**Security**

- **S1. Delegation bypasses the permission mode.** `delegate_task` is risk `.read` (`DelegateTaskTool.swift:152`), so it needs no approval. In a **non-git folder** the "write" sub-agent gets the parent's full registry, rooted at the *parent checkout*, in `workspaceWrite` (`SessionController.swift:690-704`). A session in Ask-before-changes can therefore have the model edit the user's folder without a single prompt, using up to three concurrent writers. This contradicts the tool's own description (`DelegateTaskTool.swift:86-87`).
- **S2. Queued remote tasks can grant full access.** `.full` maps to `.fullAccess` (`native/macOS/JunoDesktop/App/DesktopCodeHost.swift:43-49`). The relay path caps at `askBeforeChanges` (`JunoCodeBridge/RemoteCommandAdapter.swift:427-453`), and Settings promises the cap (`DesktopSettingsWindow.swift:431-433`).
- **S3. Global reads plus always-on network in the command sandbox** (§3).
- **S4. Repository SKILL.md files enter the system prompt without a trust gate** (§5).
- **S5. `git_commit` is silent in Full Access** despite its description (§2).

**Dead or stale code**

- `AgentOrchestrator.executeToolCall` (`:957-972`) and `deniedReason` (`:1004-1012`) are never called.
- Stale tool names in `ToolConflictEffect`.
- `SlashCommand.Action.review` is unused.
- The `CodeDefaults.disabledMCPServers` write path is dead.
- `WorkbenchModel.remoteExecutionModel`, `loadRemote*` and `startRemoteSession` (`:228-309`) are never composed. The app uses `NativeCodeModel` instead.
- `WorkspaceContext.makeInteractiveTerminal` (`:292`) is unreferenced.
- `CodeDefaults.configuration(behavior:availableModels:)` is only called from tests.
- The stale "no worktree support" comment at `SessionController.swift:1844-1846`.
- The fallback comment at `:264-266` contradicts the code.
- Docs drift: `CODE_AGENTS.md` says "per-turn checkpoints" and "auto-edit"; `CODE_SLASH_COMMANDS.md` lists 6 commands; `JUNO_CODE_HANDOFF.md` says only the Anthropic proxy is used.

**Duplication**

- There are **two agent runtimes**: Swift `JunoCodeRuntime` for local, and TypeScript `runner/agent-core` for the cloud. They have separate tool sets (`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash` in TypeScript), separate permission and sub-agent logic, and separate provider code. The Swift code copies constants from `runner/agent-core/src/subagents.ts` (`DelegateTaskTool.swift:15-19`).
- Two provider adapters: `CodeThinkingWire` mirrors `src/lib/anthropic-thinking.ts`.
- Two cloud-task client paths: `NativeCodeModel` and `RemoteExecutionModel`.
- Two paths for the user's own commands: the console (one-shot `run_command`) and a PTY terminal.

**Docs contradictions**

- `CODE_AGENTS.md` presents a "local Node sidecar" for a Codex/Claude runtime choice as remaining work. No such thing is wired into `JunoCodeUI`.

## 11. Test coverage

Covered above in §0. The weakest spots:

- No provider-contract tests that replay real recorded Anthropic and OpenAI streams through a multi-turn tool loop with thinking.
- No property test that asserts the conversation passed to a request is structurally valid.
- No performance tests for long sessions (10 K events).
- No tests of the sandbox against real package managers.

## Top 15 backend and runtime problems, in priority order

1. **Orphaned `tool_use` permanently breaks sessions (B1).**
   - Fix: in `AgentOrchestrator`, always emit a `tool_result` for every proposed call, using `is_error` with "not executed: interrupted" for skipped ones.
   - Queue steer text so it lands *after* the tool results.
   - Add a `ConversationValidator.repair()` that runs before every request: it pairs each `tool_use` with a result and moves text after tool results.
   - Add a regression test that steers between two waves.
2. **Delegation escalates permissions (S1).**
   - Make `delegate_task` with `mode: workspace_write` assess as `.write`, or pin it to always require approval.
   - Refuse write mode when there is no worktree (non-git folder), instead of handing over the parent registry at `SessionController.swift:690-704`.
   - Cap the child's mode at the parent's mode.
3. **No prompt caching.**
   - Add `cache_control` breakpoints on the tools, the system prompt and a rolling message breakpoint in `AnthropicRequestBuilder`. Parse `cache_read_input_tokens` and `cache_creation_input_tokens`.
   - Make the system prompt stable: move goal state and skill toggles into a trailing per-turn block or system message instead of rewriting `system`.
   - This is the largest cost and latency win.
4. **Thinking continuity.**
   - Add `.assistantThinking(text, signature)` and redacted variants to `ModelMessage`. Capture `signature_delta` and replay blocks unchanged on the same model.
   - For the Responses API, request `reasoning.encrypted_content` and replay it.
5. **OpenAI Chat parallel tool calls (B14).** Group consecutive `.toolCall`s into one assistant message with a `tool_calls` array, and add a test that makes two calls in one turn.
6. **Device queue decode and relay round-trip (B15 and §8).**
   - Make `NativeCodeAgentTask` decode leniently, with defaults, or emit the fields server-side.
   - Before enabling it, cap queued permission at `askBeforeChanges` (S2).
   - Wire `postEvents` and the session snapshot, and fix the `createSession` field names.
7. **Command sandbox (S3).**
   - Replace `(allow file-read*)` with a deny-list for credentials (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/Library/Keychains`, browser profiles, `~/.netrc`) plus allowances for the toolchain.
   - Add writable toolchain caches (`~/.npm`, `~/Library/Caches`, `~/.cargo`, `~/.gradle`, `~/go`) as opt-ins.
   - Make network a per-session setting, with a domain allowlist in the default mode.
   - Pass through `SSH_AUTH_SOCK` and a user-configured set of environment variables.
8. **Persistent permission rules.** Add a `PermissionRule` store at user, project and session scope, with `allow` / `ask` / `deny` for tool, command-prefix and path glob; a rule is `allow Bash(npm test:*)`, for example. Evaluate the rules in `PermissionCoordinator.authorize` before the ladder, and offer "Always allow this command in this project" on the approval card.
9. **Context engineering.**
   - Replace the head-truncating structural compactor with LLM summarization: a cheap-model call with a strict prompt, or server compaction (`compact-2026-01-12`) on Anthropic. Fix the anchor growth (B2).
   - Add paged `read_file` (offset/limit, numbered lines).
   - Tail-preserving truncation for commands (head and tail).
   - Lower the tool-result cap from 512 KB to about 30–50 K tokens, with a pointer to the full output saved to a file.
10. **System prompt and instructions.**
    - Write a real system prompt: environment block (OS, date, cwd, branch, dirty files), tool guidance, git safety and output style.
    - Load user-global `~/.juno/AGENTS.md` and nested directory `AGENTS.md`/`CLAUDE.md` files lazily as files are touched.
    - Stop labelling team conventions as untrusted and low-priority. Keep only the "cannot grant permissions" clause.
11. **Model fallback (B3).**
    - Make fallback opt-in.
    - Never fall back on a 402 `QUOTA_EXCEEDED` from the proxy (add a distinct `planBudgetExceeded` error).
    - Recompute effort and thinking parameters for the fallback model.
    - Honor `retry-after` with exponential backoff across three or more attempts.
    - Persist the switch into the session.
12. **Tool surface parity.**
    - Add: multi-edit (or a Codex-style `apply_patch` over multiple files and hunks); background shell with read-output and kill; `web_fetch`; a lightweight plan/todo tool, replacing single-use `update_goal` or letting goals be recreated; `ask_user`; a Plan-mode "approve plan → switch to Code" transition; `view_image`.
    - Fix MCP names to at most 64 characters with hashing (B5).
    - Fix `git_commit` to always ask (S5).
    - Fix the stale `ToolConflictEffect` names.
13. **Usage and billing.**
    - Record Code spend. Have the proxy parse streamed usage, or have the client call `/api/agent/usage`.
    - Raise or stream-extend the 240 s proxy abort for agent turns.
    - Persist cumulative per-session tokens and cost, and show them.
14. **Session store scalability and rewind.**
    - Index events: keep an in-memory tail per session and stop re-decoding the full JSONL on every `events(for:)`. Avoid decoding all sessions at launch; keep a small `status` sidecar instead.
    - Make projection updates incremental rather than rebuilding on every `fileChanged`.
    - Add turn-level snapshots (git stash-style tree objects), conversation rewind and fork.
    - Persist review state.
15. **Extensibility trust and parity.**
    - Put skills behind the same trust gate as hooks and MCP, and load them progressively: names and descriptions in the prompt, the body on activation. Key skill IDs by path, not content (B11).
    - Give hooks JSON stdin and a JSON decision protocol, plus `UserPromptSubmit`, `Notification`, `PreCompact` and `SubagentStop`. Fix `WorkspaceAgentHooks.swift:134` (B9).
    - Support user-global MCP, commands and agents, custom agents as `delegate_task` targets, and add notifications (UserNotifications) for "approval needed" and "run finished" on background sessions.

Also quick to fix:
- B7 and B8 in `WorkbenchRemoteBridge`: use a dedicated `send(prompt:)` API instead of the composer draft, and propagate commit failure.
- B12: serialize the approval observer writes.
- Remove the dead code listed in §8 and §10.

## Target architecture for a production local agent

**Keep. These are good and well-tested:**
- `JunoCodeCore`: permission model, `CommandClassifier`, `DiffEngine`, `WorkspacePath`, `SecretRedactor`, session events.
- `JunoCodeLocal`: `FileOperationService` with fingerprinted atomic writes, `CheckpointStore`, `WorktreeManager`, `GitService`, the PTY terminal, `DevServerService`.
- `PermissionCoordinator`'s suspension, digest and expiry mechanics.
- `ToolScheduler`'s wave partitioning.
- `SubagentControlRegistry`.
- The append-only event log as the UI source of truth.
- The `AgentModelClient` protocol boundary.
- The MCP JSON-RPC client.

**Restructure:**

```
                  ┌───────────────── JunoCodeUI (views + SessionController as thin VM) ─────────────────┐
                  │ commands: send(prompt, attachments) · steer · approve(rule?) · rewind(turn) · fork   │
                  └──────────────▲──────────────────────────────────────────────┬────────────────────────┘
                                 │ SessionEvent stream (incremental projection) │ intents
┌────────────────────────────────┴──────────────────────────────────────────────▼────────────────────────┐
│ AgentHost (actor, one per app; owns all running sessions, survives UI switches, posts notifications)    │
│  ├─ SessionRuntime (per session): TurnEngine + ConversationLedger + ContextManager + PolicyEngine       │
│  │    TurnEngine: stream → tool calls → schedule → results; ALWAYS closes every tool_use; retry/backoff │
│  │    ConversationLedger: typed blocks (text, thinking+signature, tool_use, tool_result, image, compact)│
│  │        + validator/repair before every request; append-only; turn ids for rewind/fork              │
│  │    ContextManager: stable system prefix (cache), env/git snapshot msg, instruction loader            │
│  │        (user → project → nested dirs), skills index (progressive), compaction (LLM/server),          │
│  │        tool-output spill-to-file, token/cost ledger                                                  │
│  │    PolicyEngine: rules (user/project/session; tool/cmd-prefix/path) → mode ladder → approval;        │
│  │        subagent/remote ceilings = min(parent, requested)                                            │
│  ├─ ToolKit: fs(read paged, edit/multi-edit, patch), shell(fg/bg, output, kill), search(rg), git,      │
│  │    web(search/fetch), plan/todo, ask_user, delegate(custom agents), mcp(namespaced ≤64), preview     │
│  ├─ Sandbox: seatbelt profile builder w/ credential deny-list, toolchain caches, network modes         │
│  │    (off / allowlist / on), env passthrough allowlist; one profile for agent, hooks, terminal         │
│  └─ ExtensionHost: MCP (user+project, consent), hooks (JSON protocol, all events), skills, agents,    │
│       commands — one trust store                                                                        │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ProviderLayer: AnthropicAdapter (caching, thinking replay, compaction beta, eager tool streaming),      │
│   OpenAIResponsesAdapter (encrypted reasoning), OpenAIChatAdapter (grouped tool_calls), per-model caps  │
│   from manifest; typed errors (planBudget vs providerOverload vs rateLimit) → FallbackPolicy (opt-in)   │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ SessionStore v2: per-session JSONL + index sidecar (status, counts, last seq), lazy load, snapshots     │
│   (git tree objects per turn) for rewind; usage ledger synced to backend                                │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Rewrite:**
- `AgentOrchestrator`'s loop around a typed ledger and a closing invariant.
- `ConversationCompactor`.
- The system-prompt and instruction assembly in `WorkspaceContext`.
- The `BackendCodeModelClient` request builders: caching, thinking, grouped tool calls, per-model caps.
- The remote bridges: a single `RemoteSessionService` that publishes events and snapshots and accepts typed intents, with no composer hijacking.

**Converge:**
- Pick one agent core. Either (a) run the Swift `TurnEngine` in the cloud too, headless (the package is already UI-free below `JunoCodeUI`), or (b) make `runner/agent-core` the single core and run it locally as a signed sidecar, with Swift providing the sandbox, UI and tools over a local protocol.
- Today every feature (caching, thinking, sub-agents, permissions) is implemented twice. Option (a) fits this codebase better, given the Swift runtime's maturity and its test suite.
- Delete the dead parallel paths: `RemoteExecutionModel`, `NativeCodeTaskRemoteSessionProvider`, `CodeRemoteEventBridge`, the sandbox clients and the `NativeCodeAgentClient` create methods. Collapse to one task client and one SSE parser.
