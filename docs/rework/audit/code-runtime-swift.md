# Juno Code local runtime (Swift): revalidation audit

Date: 2026-09-30. Branch `rework/refoundation` (= `main` @ `1feb392c`). Read-only pass.
Scope: `native/Packages/JunoCode/Sources` and `Tests`, compared with the 2026-09-22 audit
(`docs/native/code-rework/01-AUDIT-RUNTIME.md`, taken at `c9cae856`) and the rework record
(`docs/native/code-rework/00-README.md`).

Unless a path starts with `native/`, `src/` or `runner/`, it is relative to
`native/Packages/JunoCode/Sources/`. Line numbers are for `1feb392c`.

I did not build or run tests: the task forbade heavy commands while the baseline gate ran.
Pass/fail status is therefore **UNVERIFIED in this pass**. The last recorded green run was
1,069 XCTest cases plus Swift Testing, at `d0997af2` (`code-rework/handoff:docs/native/code-rework/04-HANDOFF.md`).
The test tree now holds 115 files, 30,625 lines and about 1,150 `func test…`/`@Test` declarations.

---

## 0. Verdict in one paragraph

The rework closed most of what the previous audit called fatal:

- orphaned `tool_use` (B1)
- delegation escalation (S1)
- no prompt caching
- dropped thinking signatures
- OpenAI parallel calls (B14)
- lossy compaction (B2)
- no permission rules
- the device queue (B15, S2)
- proxy billing and the 240 s abort (B16, B17)

The runtime is now a credible single-agent loop with good safety primitives. What remains is mostly the second tier that separates it from Claude Code and Codex:

- **Cache and thinking prefix stability is undermined by Juno itself.** Goal state, skills and the date live in `system`. The orchestrator is rebuilt whenever the goal changes. Images are rewritten to text after every turn.
- **Retry policy is naive.** There is one retry after a fixed 500 ms, no backoff, no `retry-after`, and no reactive compaction on context overflow.
- **Crash-time ambiguity.** A tool batch is not persisted before it runs.
- **Malformed tool JSON is silently coerced to `{}`.**
- **Command output over 2 MB kills the process.**
- **The tool surface is thin:**
  - no background or durable shell
  - no multi-edit or multi-file patch
  - no image, PDF or line-numbered read
  - no context in grep
  - no todo, AskUserQuestion or plan-approval handoff
  - only one goal per session
- **Instructions:** there is no nested `AGENTS.md`.
- **Skills** are injected unfenced into `system`, with no trust gate.
- **Usage** is not persisted and not cache-aware, and sub-agents are not counted.

There are also now **three** agent loops:
- Swift `AgentOrchestrator`
- Swift `DesktopWorkRunHost` for Mac-hosted Work
- TypeScript `runner/agent-core` for cloud

Each loop has a different subset of these fixes.

---

## 1. Map: components and data flow

### 1.1 Layers (package `native/Packages/JunoCode`)

| Layer | Key files | Role |
|---|---|---|
| `JunoCodeCore` | `PermissionModel.swift`, `PermissionRules.swift` (602), `CodeSettings.swift` (464), `CommandClassifier.swift` (887), `ToolConflictEffect.swift`, `OutputLimiter.swift`, `SessionEvents.swift`, `TurnCheckpoints.swift` | Pure policy, settings layering, event model, limits |
| `JunoCodeLocal` | `FileOperationService.swift`, `CommandExecutionService.swift`, `CommandSandboxProfile.swift`, `CodeSettingsStore.swift`, `WorkspaceIndexService.swift`, `WorktreeManager.swift`, `TurnCheckpointStore.swift`, `Terminal/NativeTerminalSession.swift`, `Extensibility/*` (hooks, skills) | Disk, processes, seatbelt, index, worktrees, PTY, hooks |
| `JunoCodeRuntime` | `AgentOrchestrator.swift` (1,646), `ConversationIntegrity.swift`, `ConversationCompactor.swift`, `CompactionSummarizer.swift`, `ConversationRewind.swift`, `ToolScheduler.swift`, `ToolRegistry.swift`, `PermissionCoordinator.swift`, `CodeSessionStore.swift` (966), `Tools/*`, `MCP/*`, `ModelClient.swift` | The agent loop, history invariants, context management, tool dispatch, approvals, persistence |
| `JunoCodeBridge` | `BackendCodeModelClient.swift` (1,658), `CodeThinkingWire.swift`, `RemoteCommandAdapter.swift`, `CodeRelay*` | Provider adapters (Anthropic Messages / OpenAI Chat / OpenAI Responses) via `/api/agent/*`, and the relay protocol |
| `JunoCodeUI` | `Models/SessionController.swift` (3,999), `Models/WorkspaceContext.swift`, `Models/WorkbenchModel.swift`, `Models/WorkbenchRemoteBridge.swift`, `Studio/*` | View model, orchestrator assembly, system prompt, Studio UI |

### 1.2 Prompt to model to tools

1. `StudioComposer` calls `SessionController.send()` (`JunoCodeUI/Models/SessionController.swift:1266`). A remote prompt enters through `deliverRemotePrompt` instead (`:1484`, via `WorkbenchRemoteBridge.swift:413-423`).
2. `currentOrchestrator` (`SessionController.swift:699-758`) builds a `TurnContract`:
   - behavior, model, effort, vision, computer use
   - **`goalUpdatedAt`** (`:709`)
   - hook, extension and settings fingerprints

   If the contract changed, it builds a new `AgentOrchestrator` (`:763-923`). The system prompt is:
   - `WorkspaceContext.systemPrompt` (`WorkspaceContext.swift:284-421`)
   - plus `goalSystemPrompt` (`SessionController.swift:1047-1094`)
   - plus `extensionsSystemPrompt`, with the custom agent and **every enabled skill body** (`:3576-3590`)
3. `AgentOrchestrator.submit` (`AgentOrchestrator.swift:313-385`) runs `SessionStart`/`UserPromptSubmit` hooks, appends the user message, persists `conversation.json`, opens a turn checkpoint, and starts `runLoop` in an unstructured `Task`.
4. `runLoop` (`:679-1271`), per iteration:
   1. Check the iteration cap (`:694`; default 200 from `CodeSettings.swift:260`).
   2. Apply steers (`:717`).
   3. Compact if needed (`:719`, `:1345-1385`).
   4. `ConversationIntegrity.repaired` (`:763`).
   5. Stream (`:800-844`): text, thinking blocks with signature, redacted thinking, tool calls in stream order, usage.
   6. Errors (`:846-965`): plan limit ends the run; fallback only if opted in; one retry after 500 ms.
   7. Redact images (`:977`).
   8. `maxTokens`, a missing stop reason or an empty tool request fail the run (`:1005-1070`).
   9. Record `toolProposed` (`:1072-1090`). A pending steer discards the proposal (`:1096-1100`).
   10. `ToolScheduler.execute` runs the waves (`ToolScheduler.swift:107-148`). Each call goes hook, then `authorizeInvocation`, then execute, then post-hook (`:152-378`).
   11. Results are bounded to 128 KB (`AgentOrchestrator.swift:53`, `:1286-1297`). Skipped calls get "Not executed" (`:1225-1230`).
   12. Save (`:1231`).
5. Approvals: `PermissionCoordinator.authorize` (`PermissionCoordinator.swift:95-177`) evaluates rules, then the mode ladder, then the hook, and suspends on a continuation. The UI resolves it through `approve`/`deny`/`approveAlways`/`deny(redirect:)` (`SessionController.swift:1903-1977`).
6. Provider wire: `BackendCodeModelClient.streamTurn` (`BackendCodeModelClient.swift:225-359`) posts to `/api/agent/<provider>/v1/messages`, `/chat/completions` or `/api/agent/openai/responses`. The server proxy (`src/app/api/agent/[...path]/route.ts`) bills from provider usage (`:49-67`, `:241-278`) with header, idle and ceiling deadlines (`src/lib/agent-proxy.ts:100-130`).
7. Persistence: `CodeSessionStore` keeps:
   - `sessions/<id>/session.json`
   - `events.jsonl`, append-only with torn-line repair (`CodeSessionStore.swift:418-427`)
   - `summary.json`, so launch reads records only (`:21-40`)
   - `conversation.json`

### 1.3 Other consumers of the same pieces

- **Mac-hosted Work runs** use `BackendCodeModelClient` with their **own loop**: `native/macOS/JunoDesktop/App/DesktopWorkRunHost.swift:243-300`, 845 lines. It has:
  - a 64-turn cap (`:66`)
  - no thinking replay
  - no retries (it fails on the first error)
  - no `ConversationIntegrity` and no compaction
- **Sub-agents**: `DelegateTaskTool` builds child `AgentOrchestrator`s (`Tools/DelegateTaskTool.swift:458-480`):
  - 18 iterations
  - a 10-minute call budget (`:64`)
  - 3 concurrent (`:69`)
- **Cloud tasks**: TypeScript `runner/agent-core`:
  - its own loop and 6 tools (`bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`)
  - no `cache_control` anywhere in `runner/agent-core/src`
  - no compaction
  - it **does** have `retry-after` and exponential backoff with jitter (`runner/agent-core/src/loop.ts:154`, `:362-369`; `providers/errors.ts:125-142`)

---

## 2. What is real vs placeholder, dead or gated

**Real and working** (read-verified; tests exist, not re-run):

- **Turn integrity invariant.**
  - `ConversationIntegrity.repaired` runs before every request (`AgentOrchestrator.swift:763`), on restore (`:591`) and on finish (`:1616`).
  - A steer between waves only *asks* to interrupt (`:1147-1157`).
  - Tool calls enter history only once they are committed (`:996`, `:1134-1137`).
  - Tests: `JunoCodeRuntimeTests/TurnIntegrityTests.swift` (steer mid-batch, goal pause mid-batch, stream-order thinking replay).
- **Anthropic prompt caching.**
  - Breakpoints on the last tool, the system prompt and the newest non-thinking block (`BackendCodeModelClient.swift:612-656`, `:709-728`).
  - Cached tokens are counted for the context meter (`:1336-1347`).
  - Test: `JunoCodeBridgeTests/RequestShapeTests.swift` (`testAnthropicCachesToolsSystemAndTheNewestBlock`).
- **Thinking capture and replay.**
  - Signed and redacted blocks (`BackendCodeModelClient.swift:1205-1252`, `:540-553`; `ModelClient.swift:47-49`).
  - `block_binding: drop_block` with beta `thinking-binding-controls-2026-08-01` (`BackendCodeModelClient.swift:660-703`).
  - The beta and field are confirmed by Anthropic's "Preserved thinking" docs (https://platform.claude.com/docs/en/build-with-claude/preserved-thinking, undated, accessed 2026-09-30). Those docs say the prefix check is enforced by default for accounts created on or after 2026-08-31.
- **Compaction.**
  - A model-written summary with seven fixed headings (`CompactionSummarizer.swift:152-164`).
  - An injection-escaped transcript (`:98-115`, `:208-263`).
  - A deterministic structural fallback (`ConversationCompactor.swift:421-494`).
  - Earlier summaries are folded in, not stacked (`:339-367`).
  - Step-boundary cuts, so a single long request can compact (`:199-209`).
  - The request in progress is quoted verbatim (`:81-87`, `:393-409`).
- **Permission rules.**
  - User, project and local settings files, with deny > ask > allow (`JunoCodeCore/PermissionRules.swift`).
  - Evaluated before the ladder (`PermissionCoordinator.swift:190-213`).
  - "Always allow" saves the shown rule (`SessionController.swift:1945`).
  - Hooks rank below the reader (`PermissionCoordinator.swift:234-251`).
- **Sub-agent containment.**
  - Write delegation is a `.write` action (`DelegateTaskTool.swift:172-177`).
  - The child's mode is capped at the parent's (`SessionController.swift:828-830`).
  - It is refused without git (`:855-863`).
  - Children inherit the parent's rules (`:869-871`).
- **Paged `read_file`** with fingerprint-safe windows (`Tools/FileTools.swift:73-194`, `:211-251`).
- **`web_fetch`** with a redirect guard (`Tools/WebFetchTool.swift`).
- **MCP names of 64 characters or fewer** (`MCP/MCPCodeTool.swift:24-32`).
- **Turn rewind** of code and/or conversation (`ConversationRewind.swift`, `JunoCodeLocal/TurnCheckpointStore.swift`, `SessionController.swift:2474-2539`).
- **Hooks** with the Claude Code event set and JSON on stdin (`JunoCodeLocal/Extensibility/HookTypes.swift:13-20`). `PreCompact` is absent.
- **Settings.** Turn limit 10–1000, compaction threshold 0.50–0.95, and fallback off by default (`JunoCodeCore/CodeSettings.swift:260-271`).

**Dead, placeholder or misleading** (still present):

- `CloudCodeSandboxClient.swift` (708 lines) and `LocalPythonSandboxClient.swift` (458 lines) are referenced only by `Tests/JunoCodeRuntimeTests/CloudCodeSandboxTests.swift`.
- `WorkbenchModel.remoteExecutionModel`, `loadRemote*` and `startRemoteSession` (`JunoCodeUI/Models/WorkbenchModel.swift:239-311`), plus `JunoCodeUI/Remote/RemoteExecutionModel.swift`, `NativeCodeTaskRemoteSessionProvider.swift` and `ExecutionLocation.swift`: no app composes `remoteSessionProvider` (grep of `native/macOS`, `native/iOS`).
- `WorkspaceContext.makeInteractiveTerminal` (`WorkspaceContext.swift:431`) has no callers.
- `ToolConflictEffect` names tools that do not exist: `fetch_url`, `git_checkout`, `git_branch`, `terminal_command`, `computer_action`, `screen_capture` (`JunoCodeCore/ToolConflictEffect.swift:68-97`). `ToolRuleSubjects` names `multi_edit`, which also does not exist (`ToolRuleSubjects.swift:26`).
- The `/boost` slash command claims "boosted reasoning effort" but only adds prompt text. `/teamwork-preview` describes features that don't exist (`JunoCodeUI/Models/SlashCommands.swift:314-327`).
- `forkSession` over the relay explicitly throws "unsupported" (`WorkbenchRemoteBridge.swift:447-452`). There is no local fork either.
- Now fixed and no longer dead: `AgentOrchestrator.executeToolCall` is the single dispatch path (`:1162-1172`, `:1553-1572`). `CodeRemoteEventBridge` and `CanonicalRelayCommandExecutor` are gone.

**Gated:**
- Computer-use tools need vision plus in-session activation (`SessionController.swift:788-790`).
- Plan and Ask get the inspection-only registry (`ToolRegistry.swift:11-14`, `SessionController.swift:785-787`). That registry has no `web_fetch`, so Plan cannot read docs.
- MCP needs per-server consent (`WorkspaceContext.swift:119-132`).
- Hooks need per-repository trust.

---

## 3. Revalidation status tables

Status legend: **FIXED**, **PARTIAL**, **OPEN**, **N/A**.

### 3.1 Bugs B1–B17

| ID | Prior finding | Status | Evidence (current code) |
|---|---|---|---|
| B1 | Orphaned `tool_use` bricks the session | **FIXED** | `ConversationIntegrity.swift:24-75`; `AgentOrchestrator.swift:591,763,996,1134-1137,1147-1157,1225-1231,1616`; `TurnIntegrityTests.swift`. Residual: crash-time ambiguity (§3.5a) |
| B2 | Compaction anchor grows; keeps the wrong end | **FIXED** | `ConversationCompactor.swift:339-367` (carry, don't stack), `:467-477` (drop oldest non-user notes first); model summary `CompactionSummarizer.swift` |
| B3 | Fallback: wrong thinking params, fires on the user's own budget | **PARTIAL** | (a) FIXED: the proxy's `QUOTA_EXCEEDED` becomes `planLimitReached` (`BackendCodeModelClient.swift:315-322`), which ends the run (`AgentOrchestrator.swift:853-867`); fallback is opt-in (`SessionController.swift:918`, default false `CodeSettings.swift:263`). (b) OPEN: the primary's `reasoningEffort` goes to the fallback model (`AgentOrchestrator.swift:777-778`, `:923`). (d) OPEN: the switch lives only in `activeModelID` (`:84`), not in `session.configuration`. (c) catalog snapshot: UNVERIFIED |
| B4 | Thinking blocks and signatures dropped | **PARTIAL** | Anthropic FIXED (above). OpenAI Responses OPEN: `store:false` with no `include:["reasoning.encrypted_content"]` (`BackendCodeModelClient.swift:986-993`); reasoning items ignored by the decoder (`:1597-1608`) and the builder (`:950-951`) |
| B5 | MCP names over 64 characters | **FIXED** | `MCPCodeTool.swift:24-32`. Residual bug: `safeName` keeps any `Character.isLetter` (e.g. `é`, CJK) (`:80-88`), so a name can still break `^[a-zA-Z0-9_-]{1,64}$` and 400 every turn |
| B6 | `run_command` output head-truncated | **PARTIAL** | Head and tail kept (`CommandAndTestTools.swift:132`, `AgentOrchestrator.swift:1293-1296`). But the executor **kills the process group** once output passes 2 MB (`JunoCodeLocal/CommandExecutionService.swift:186-191`, `OutputLimiter.swift:17`), so the real tail is lost and long builds are terminated. There is no spill-to-file |
| B7 | Remote bridge overwrites the composer | **FIXED** | `WorkbenchRemoteBridge.swift:413-423` goes to `deliverRemotePrompt` (`SessionController.swift:1484`). Residual: local `retryLastTurn` still writes `composerText` and resends (`SessionController.swift:1604-1617`) |
| B8 | Remote commit reports success on failure | **FIXED** | `WorkbenchRemoteBridge.swift:555-564` |
| B9 | Hook approval text broken | **FIXED** | `WorkspaceAgentHooks.swift:416` (`summary: invocation.hook.command`) |
| B10 | One goal per session, ever | **OPEN** | `CodeSessionStore.swift:253-254` throws `goalAlreadyExists`. The system prompt then says "complete and immutable" (`SessionController.swift:1077-1079`) while still telling the agent to create goals (`:1049-1056`) |
| B11 | Edited disabled skill re-enables itself | **OPEN** | The skill ID hashes `instructions` (`JunoCodeLocal/Extensibility/SkillActivation.swift:30-32`). The disabled set is keyed by ID (`CodeDefaults.swift:172-177`) |
| B12 | Approval events written from unordered `Task {}` | **OPEN** | `AgentOrchestrator.swift:620-672` (one `Task` per update) |
| B13 | Partial last JSONL line corrupts the next append | **FIXED** | `CodeSessionStore.swift:418-427` |
| B14 | OpenAI Chat parallel tool calls invalid | **FIXED** | `BackendCodeModelClient.swift:745-764`; `RequestShapeTests.testOpenAIChatGroupsParallelCallsIntoOneAssistantMessage` |
| B15 | Device queue never decodes | **FIXED** | `native/Packages/JunoNativeKit/Sources/JunoCodeKit/NativeCodeAgentClient.swift:73-83` (`decodeIfPresent`) |
| B16 | Proxy 240 s hard abort | **FIXED** (server) | `src/lib/agent-proxy.ts:100-130` (headers 120 s, idle 240 s, ceiling 60 min). Residual: the client is now *stricter* (idle 90 s, overall 15 min; `BackendCodeModelClient.swift:192-196`) |
| B17 | Code usage never recorded as spend | **FIXED** (server) | `src/app/api/agent/[...path]/route.ts:49-67,241-278` (`recordSpend`). The client ledger is still weak (§3.5k) |

### 3.2 Security S1–S5

| ID | Finding | Status | Evidence |
|---|---|---|---|
| S1 | Delegation bypasses the mode | **FIXED** | `DelegateTaskTool.swift:172-177`; `SessionController.swift:826-871` |
| S2 | Queued remote tasks can be Full Access | **FIXED** | `native/macOS/JunoDesktop/App/DesktopCodeHost.swift:56-60` (capped at `remoteCeiling`) |
| S3 | Global reads and always-on network | **PARTIAL** | Network can be switched off per settings (`CommandExecutionService.swift:63-75`), though the default is on (`WorkspaceContext.swift:101-106`). **Reads are still global**: `(allow file-read*)` (`JunoCodeLocal/CommandSandboxProfile.swift:226`), with no credential deny-list (`~/.ssh`, `~/.aws`, Keychains). There is no command domain allowlist; `web_fetch` has domain rules |
| S4 | Repository SKILL.md in the system prompt with no trust gate | **OPEN, and worse than described** | Full bodies are appended **after and outside** the `<repository_context>` fence, at system authority (`SessionController.swift:3584-3588`). Skills are enabled by default (`CodeDefaults.swift:172-174`). The `trust` field exists (`SkillActivation.swift:15-36`) but is unused on this path |
| S5 | `git_commit` silent in Full Access | **FIXED** | `Tools/GitTools.swift:150-155` (`.alwaysRequiresApproval`) |

### 3.3 Tool gaps (prior §2)

| Gap | Status | Evidence / note |
|---|---|---|
| Paged Read | **FIXED** (partial on quality) | `FileTools.swift:73-194`. There are no per-line numbers (Claude Code's Read returns line numbers: https://code.claude.com/docs/en/tools-reference, undated, accessed 2026-09-30). There is a hard 1 MB read ceiling (`OutputLimiter.swift:15`); lines past it "cannot be paged" (`FileTools.swift:176-177`) |
| MultiEdit / multi-hunk, multi-file patch | **OPEN** | `apply_patch` is a single exact replace (`FileTools.swift:420-476`, `TextPatch.swift`) |
| Background shell, output, kill | **OPEN** | `&` and dev servers refused (`CommandAndTestTools.swift:28-31`, `:173-193`). No stdin (`CommandExecutionService.swift:161-166`), no persistent cwd or env. Claude Code has background Bash, `Monitor`, `TaskOutput`/`TaskStop` and cwd carry-over (same docs page) |
| WebFetch | **FIXED** | `Tools/WebFetchTool.swift` |
| TodoWrite / `update_plan` | **OPEN** | Only `update_goal`: approval-gated (`.write`, `UpdateGoalTool.swift:66`), exclusive (`ToolConflictEffect.swift:80-83`), single-use (B10) |
| NotebookEdit | **OPEN** | not present |
| AskUserQuestion | **OPEN** | not present (grep of `Sources`) |
| ExitPlanMode handoff | **OPEN** | `JunoCodeUI/Studio/StudioMode.swift` has a Plan rung but no "approve plan, then implement" transition |
| `view_image` / image read | **OPEN** | Non-UTF-8 files fail with `notUTF8Text` (`FileOperationService.swift:290-292`) |
| Custom agents as delegate targets | **OPEN** | The delegate schema offers only `model_id`, `mode` and role (`DelegateTaskTool.swift:102-170`). Custom agents only replace the main prompt (`SessionController.swift:3578-3583`) |
| Dead conflict names; needless exclusivity | **OPEN** | `ToolConflictEffect.swift:68-100`. `list_directory`, `find_files`, `create_file`, `move_file`, `inspect_active_editor`, preview and MCP tools all fall to `.exclusive` |
| MCP name length | **FIXED** (non-ASCII residual) | see B5 |
| Malformed tool JSON coerced to `{}` | **OPEN** | `BackendCodeModelClient.swift:1273-1282` and `:1651-1658` |
| grep quality | **OPEN** | Swift walker; `pattern`, `is_regex`, `case_sensitive`, `include`, `limit` only (`SearchTools.swift:86-135`); root `.gitignore` only (`WorkspaceIndexService.swift:213`). `.juno` is not excluded (`:9-12`), yet worktrees live in `.juno/worktrees` (`WorktreeManager.swift:248`) |
| MCP images, resources, prompts, user-global servers | **OPEN** | Text only (`MCPCodeTool.swift:67-77`); workspace files only (`MCP/MCPServerConfiguration.swift:133`) |

### 3.4 The 15 prioritized items (prior audit)

| # | Item | Status | Evidence / what is left |
|---|---|---|---|
| 1 | Orphaned `tool_use` | **FIXED** | B1 |
| 2 | Delegation escalation | **FIXED** | S1 |
| 3 | Prompt caching | **PARTIAL** | Breakpoints and the cache-aware meter are done. Left: **the prefix is not stable** (§3.5d); a single rolling breakpoint; the compaction side call doesn't reuse the cache; no cache split in usage |
| 4 | Thinking continuity | **PARTIAL** | Anthropic done. Responses encrypted reasoning OPEN. Image rewrite and orchestrator rebuilds invalidate blocks (§3.5c) |
| 5 | OpenAI Chat parallel calls | **FIXED** | B14 |
| 6 | Device queue and relay | **FIXED** (B15, S2 verified) | Relay upload per `00-README.md` §4, not re-verified here. Known gap: pending relay commands never expire (`04-HANDOFF.md`) |
| 7 | Command sandbox | **PARTIAL** | S3. Download caches redirected (`00-README.md` §5). Gradle, Maven and CocoaPods caches still shared (`04-HANDOFF.md`) |
| 8 | Persistent permission rules | **FIXED** | `PermissionRules.swift`; `PermissionCoordinator.swift:47-56,190-213`; `SessionController.swift:1945` |
| 9 | Context engineering | **PARTIAL** | LLM compaction, paged read and head+tail are done. Result cap is 128 KB (`AgentOrchestrator.swift:53`), but there is **no spill-to-file**, output is killed at 2 MB, and there is **no reactive compaction** on "prompt too long" (no handler in `JunoCodeRuntime` or `JunoCodeBridge`) |
| 10 | System prompt and instructions | **PARTIAL** | The real prompt has an environment block (`WorkspaceContext.swift:284-421`). User instructions come from `~/.juno/JUNO.md` or `AGENTS.md` (`JunoCodeLocal/CodeSettingsStore.swift:104-107`) and rank above repository files (`WorkspaceContext.swift:339-366`). Left OPEN: nested `AGENTS.md`, a git dirty-state snapshot, git-safety guidance |
| 11 | Model fallback | **PARTIAL** | Opt-in, 402 split. Left: no backoff or `retry-after`, effort not recomputed, switch not persisted (B3) |
| 12 | Tool surface parity | **PARTIAL** | `web_fetch`, MCP names and `git_commit` done. Everything else in §3.3 is OPEN |
| 13 | Usage and billing | **PARTIAL** | Server billing and deadlines FIXED. Client ledger OPEN (§3.5k) |
| 14 | Store scaling and rewind | **PARTIAL** | Summaries and lazy launch (`CodeSessionStore.swift:21-40`) and rewind are FIXED. Left: `events(for:)` still decodes the whole file (`:451`); no fork; `reviewStates` still in memory (`SessionController.swift:586`) |
| 15 | Extensibility trust and parity | **PARTIAL** | Hooks JSON and events FIXED (no `PreCompact`; only `command` hooks run, per `04-HANDOFF.md`). Notifications FIXED (`native/macOS/JunoDesktop/App/DesktopNeedsYouSignals.swift`). Skills trust and progressive loading OPEN (S4, B11). User-global MCP OPEN. Custom agents as delegates OPEN |
| – | Quick fixes (B7, B8, B12, dead code) | **PARTIAL** | B7 and B8 fixed. B12 open. Dead code listed in §2 |

### 3.5 Required technical review list

**(a) Orphaned `tool_use` / steering / cancellation / recovery / reconnect / ambiguous execution**

- Orphans: FIXED (B1).
- Steering during tool waves:
  - FIXED for correctness. A steer stops later waves at a wave boundary, and every call is answered before the steer is appended (`ToolScheduler.swift:115-117`; `AgentOrchestrator.swift:1147-1157`, `:1268-1270`).
  - Limitation: a steer cannot pre-empt an in-flight wave. A `run_command` (up to 600 s, `CommandAndTestTools.swift:5-6`) or a pending approval blocks it until that finishes; only Stop pre-empts.
- Cancellation: FIXED.
  - Stop cancels the run and calls `denyAll` (`AgentOrchestrator.swift:553-577`).
  - Pre-tool hooks honor cancellation (`ToolScheduler.swift:180-199`).
  - The process group gets SIGTERM, then SIGKILL (`CommandExecutionService.swift:230-236`, `:333-344`).
  - Children stop through a cancellation handler (`DelegateTaskTool.swift:526-540`).
  - The partially streamed answer is discarded (`AgentOrchestrator.swift:801`, `:971`), so the reader loses text they already saw.
- Recovery: PARTIAL.
  - On launch, running sessions are marked "Interrupted by app termination" (`CodeSessionStore.swift:773-793`).
  - The history is repaired on load (`AgentOrchestrator.swift:589-593`).
  - Rewind exists.
- **Ambiguous execution: OPEN.**
  - The committed tool batch is appended at `:1136-1137` but only saved **after** execution (`:1231`).
  - If the app dies mid-batch, `conversation.json` lacks the whole turn, while files, commits or installs may already have happened.
  - On resume the model does not know, and may repeat a `git_commit` or a migration.
  - Even when calls are persisted, repair would label them "Not executed" (`ConversationIntegrity.swift:16-17`, `:67-70`), which is false for a call that started.
- Reconnect: PARTIAL.
  - A dropped or idle stream throws (`BackendCodeModelClient.swift:415-434`).
  - The turn retries **once after a fixed 500 ms** (`AgentOrchestrator.swift:758`, `:934-946`).
  - There is no stream resume, no backoff, and no `retry-after`.
  - `rateLimited` carries no delay (`ModelClient.swift:219`). By contrast, the TypeScript runner does backoff and `retry-after` (`runner/agent-core/src/providers/errors.ts:125-142`).
- Malformed streamed tool JSON: OPEN.
  - It becomes `{}` (`BackendCodeModelClient.swift:1255`, `:1273-1282`, `:1542-1549`, `:1607`).
  - `SchemaValidator` then reports "Missing required field", which misdiagnoses a truncated or invalid JSON payload (`SchemaValidator.swift:18-20`).
  - Tools with no required fields (`git_status`, `git_diff`) run with `{}`.
  - Stop reasons `refusal`, `pause_turn` and `model_context_window_exceeded` all map to `endTurn` (`:1284-1290`).

**(b) Thinking: capture, signatures, replay**

- Capture, signatures, redacted blocks and stream-order replay are FIXED (see §2).
- Stability problems (OPEN):
  1. After every successful turn, `conversation.map(\.persistenceSafe)` rewrites image-bearing messages to text (`AgentOrchestrator.swift:977`). Anthropic's rules say that editing an earlier message invalidates every later thinking block, and that "the edits that invalidate thinking are the edits that restart the cache" (Preserved thinking docs, cited above). In vision and computer-use sessions, `drop_block` therefore silently drops reasoning, and the cache restarts from the first image on every step.
  2. Any `TurnContract` change rebuilds `system` (next item). All replayed thinking is then dropped.
  3. OpenAI Responses reasoning is not replayed (B4).
  4. The Work loop drops thinking entirely (`DesktopWorkRunHost.swift:284-289`).
  5. UNVERIFIED: a steer that discards `tool_use` leaves an assistant turn ending in a `thinking` block (`AgentOrchestrator.swift:996`, `:1096-1100`). It is only tested against a scripted client (`AgentOrchestratorTests.testSteeringBeforeToolExecutionDiscardsStaleWriteAndReachesNextRequest`).

**(c) Prompt caching: breakpoints and stability**

- Breakpoints are right in shape (see §2).
- Instability sources:
  - Goal state is inside `system` (`SessionController.swift:776-778`, `:1047-1094`), and `goalUpdatedAt` is in the contract (`:709`). The first prompt after any `update_goal` rebuilds tools and system, so the whole conversation is a cache miss.
  - Enabled skill bodies are in `system` (`:3576-3590`).
  - The date and branch are in `system` (`WorkspaceContext.swift:321-331`); these are only rebuilt with the contract.
  - Settings, extension and hook fingerprints are in the contract (`SessionController.swift:710-713`).
  - Images are rewritten to text (see (b)).
- A single rolling breakpoint: Anthropic's lookback is 20 blocks. A turn with 10 or more parallel calls (20+ `tool_use`/`tool_result` blocks) can miss the previous write. Prompt caching docs: https://platform.claude.com/docs/en/build-with-claude/prompt-caching (undated, accessed 2026-09-30; the 20-block rule comes from the search summary of that page).
- The compaction side call uses its own system prompt and no tools (`CompactionSummarizer.swift:98-115`, `:172-186`), so it pays full price for up to 240 K characters.
- **Correction to the prior audit's `bindingTolerant` rationale.** The comment at `BackendCodeModelClient.swift:667-679` treats these rewrites as unavoidable. Most of them are self-inflicted and avoidable.

**(d) Compaction quality**

Good:
- structured summary (decisions, files, errors, open tasks, current work)
- deterministic structural fallback
- summary accumulation fixed
- tool-output injection escaped
- hooks labelled apart from the user

Gaps:
- No repo-state re-injection after a fold. Nothing adds branch, dirty files, files changed this session (the runtime already tracks `filesChanged`, `AgentOrchestrator.swift:681`) or recently read files.
- The goal and todo state survive only because they sit in `system`.
- No `PreCompact` hook.
- The trigger is proactive only; there is no retry-with-compaction on overflow.
- The model summary is not deterministic by nature. The structural path is.

**(e) File tools**

| Capability | Status |
|---|---|
| Paged read | FIXED |
| Search with context | OPEN |
| Binary / image / PDF read | OPEN |
| Multi-edit | OPEN |
| Multi-hunk, multi-file patch | OPEN |
| Atomic conflict protection | FIXED per file |

Notes on conflict protection:
- `write_file` requires `base_sha256` to overwrite (`FileOperationService.swift:83-93`).
- Writes are atomic (`:307`).
- `apply_patch`'s base is optional; exact-match gives an implicit guard.
- There is no cross-file transaction.
- The check-then-write is not a single CAS. The TOCTOU window is small; noted only.

**(f) Terminal**

- OPEN on every sub-item: durable sessions, persistent cwd/env, background, output retrieval, kill, tail, stdin.
- Timeout exists: 120 s default, 600 s max (`CommandAndTestTools.swift:5-6`, `:90-93`).
- The PTY terminal exists for the reader only (`JunoCodeLocal/Terminal/NativeTerminalSession.swift`). Dev servers go through `open_preview`/`DevServerService`, so the building blocks exist.
- The environment is minimal and non-login (`CommandExecutionService.swift:299-316`). Settings env vars are merged in (`:148-151`).

**(g) Plan/todo, Plan to Code, AskUserQuestion**

- All OPEN.
- Plan mode is read-only by construction, but its answer never becomes an approvable artifact.
- The "create a goal before changing files" nudge (`SessionController.swift:1049-1056`) plus B10 means the second multi-step task in a session is told to create a goal it cannot create.

**(h) Nested `AGENTS.md` and instruction precedence**

- Precedence FIXED: reader, then settings, then repository, with a fence (`WorkspaceContext.swift:334-366`).
- Discovery is root-only. It covers `JUNO.md`, `.juno/JUNO.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.cursorrules` and `CONTRIBUTING.md` (`:251-268`).
- Files are read once per orchestrator build.
- There are no nested or directory-scoped files and no `AGENTS.override.md`. Codex concatenates global, then root, then down to cwd, with closer files overriding (https://developers.openai.com/codex/guides/agents-md, undated, accessed 2026-09-30).

**(i) Durable permission rules**

- FIXED (see item 8).
- Residual 1: `move_file` rules check only the destination (`ToolRuleSubjects.swift:22-25`). `Edit(secrets/**)` deny can be sidestepped by moving a file out of that folder.
- Residual 2: `grep` has no `path` subject, so `Read(...)` denies don't apply to content search (`:26-28`). Gitignored files are skipped, which mitigates `.env`.

**(j) Tool semantics**

- Dead conflict names: OPEN.
- MCP name length: FIXED, with the non-ASCII residual.
- Coercion of malformed input: OPEN.
  - `SchemaValidator` is strict (`SchemaValidator.swift:35-52`): `"5"` for an integer, `"true"` for a boolean or a stringified object all fail. Some models do send those.
  - It also rejects MCP schemas with no top-level `type` (`:9-11`).

**(k) Cost and usage accounting**

- Per-call usage is summed in memory (`ModelClient.swift:169-183`, `AgentOrchestrator.swift:263-267`) into `SessionController.sessionUsage` (`:513`, `:745-748`).
- It is **not persisted**, so it is lost on relaunch.
- It has **no cache split**: `.usage` carries only input and output, and input includes cache reads (`BackendCodeModelClient.swift:1341-1347`). The "spent" figure in `StudioContextMeter` (`StudioSessionView.swift:165`) therefore overstates input about 10x on cached sessions.
- There is no cost figure.
- **Sub-agents are not counted.** `UsageTally` keeps the *last* input and output, not sums (`DelegateTaskTool.swift:487-489`, `:731-741`), and child spend never reaches the parent's `sessionUsage`.
- The server bills correctly; the client cannot show it.

**(l) Test coverage**

| Area | Coverage | Evidence / gap |
|---|---|---|
| Long loops | PARTIAL | `testIterationLimitStopsRunawayLoops` is scripted. No 100+ step soak asserting integrity, cache-prefix stability and compaction together |
| Reasoning | PARTIAL | `testThinkingBlocksAreReplayedInStreamOrder`, `testAnthropicReplaysThinkingFirstInTheAssistantTurn`, binding-beta tests. None for image rewrite plus thinking, steer-discard plus thinking, or Responses reasoning |
| Compaction | COVERED | `CompactionBoundaryTests`, `ModelCompactionTests`, `CompactionSummarizerTests`, `ConversationCompactorTests` |
| Steer | COVERED | `TurnIntegrityTests`, steer-supersedes tests, hooks × steer tests |
| Retries | PARTIAL | `testModelFailureRetriesOnceThenFails`, `testTransientFailureRecovers`. No backoff because the feature is absent |
| Rate limits | GAP | Classification only (`BackendCodeModelClientTests.swift:717`) |
| Tool failure | PARTIAL | Denial and hook-block tests. No malformed or truncated tool JSON test |
| Cancellation | COVERED | `testStopCancelsPromptlyEvenWithHungModel`, `testStopDuringPendingApprovalDeniesAndCancels`, process-group kill tests |
| Reconnect | PARTIAL | Dropped, idle and clean-end-without-completion tests. No resume |
| Permissions | COVERED | `PermissionRulesTests`, `PermissionRuleAuthorizationTests`, `PermissionCoordinatorTests`, `SubagentContainmentTests`, `PolicyFileProtectionTests` |
| Nested instructions | GAP | Feature absent |
| Crash mid-tool | GAP | — |
| Recorded provider streams | GAP | All SSE fixtures are inline and synthetic |

---

## 4. Problems: product, visual, correctness, parity

**Correctness (ranked)**

1. Self-inflicted cache and thinking invalidation (§3.5b, §3.5c). This is the largest remaining cost and latency item, and it silently degrades reasoning quality on Opus 5.5 and Fable 5.1.
2. Crash-time ambiguous execution (§3.5a).
3. Retry policy: 429 and 529 handled with one 500 ms retry, or a cross-lab switch if opted in; no reactive compaction.
4. The command kill at 2 MB (B6).
5. `{}` coercion of malformed tool JSON.
6. B10 goal lock-in together with the prompt nudge.
7. Skills unfenced at system authority (S4). This is a prompt-injection path from any cloned repository's `.claude/skills`.
8. The MCP non-ASCII name 400.
9. The `move_file` rule subject.
10. B12 approval ordering; B11.

**Product and UX coherence**

- `maxTokens`, the iteration cap and a missing stop reason all end the run as **failed**, with "Continue to resume" (`AgentOrchestrator.swift:1016-1022`); the reader must type. Claude Code continues on its own in these cases (UNVERIFIED for the current version).
- Retry duplicates the prompt in history and clobbers the draft (`SessionController.swift:1604-1617`), even though rewind exists.
- Plan mode produces prose with no approve step.
- There is no question tool, so the agent either guesses or ends its turn.
- The reader sees spend without a cache split, and no sub-agent spend.
- There is no fork.

**Visual (within this area)**

- `StudioScreenControl.swift:213-221` draws 7 pt red and coral dots for "active" and "needs permission" screen-control states. That is a status dot, which the owner's no-status-dot rule forbids.
- `StudioLanding.swift:182-184`: the empty composer "breathes" (`beam: .pulse`) until typing. That is decorative pulsing, not state. Flag it for the design owner.
- The Studio's "coral = working/needs you" semantics (`StudioTheme.swift:16`) sit on the default `JunoAccent.coral` (`native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoColors.swift:244-247`). Whether that coral reads as Claude's brand terracotta is UNVERIFIED (hex not checked); it needs a design check.
- `/boost` and `/teamwork-preview` copy promises features that don't exist (`SlashCommands.swift:314-327`).

**Parity across Web, Mac, iPhone and iPad**

- The local runtime is **Mac-only**. iPhone and iPad drive Mac sessions over the relay (`WorkbenchRemoteBridge.swift`, `JunoCodeBridge/RemoteCommandAdapter.swift`); fork is unsupported there (`:447-452`).
- Web and cloud tasks run TypeScript `runner/agent-core`: 6 tools, no prompt caching and no compaction. It does have backoff and `retry-after`, and the thinking-binding port (`runner/agent-core/src/providers/anthropic.ts:95-125`).
- Mac-hosted Work runs use a third loop (`DesktopWorkRunHost.swift`): no integrity repair, no retries, no compaction, a 64-turn cap.
- Every fix therefore lands in at most one of the three loops.

---

## 5. Unmerged branches and parallel work

Checked with `git branch -a`, `git log main..<b>` and `git diff --name-only main...<b>` against `native/Packages/JunoCode/`, `runner/agent-core`, `src/app/api/agent` and `JunoCodeKit`.

| Branch | Ahead | Touches this area? | Recommendation |
|---|---|---|---|
| `rework/review-fixes` (2026-09-22) | 22 | Yes (36 JunoCode files) | **All 22 subjects are already on `main`** after a rebase: `ee1908e8` (drop stale thinking), `fed35c5d` (sub-agent rules), `48461094` (read_file bytes), `a302f209`, and the others. Patch-ids differ. Do not merge; delete |
| `code-rework/handoff` (2026-09-23) | 2 | Docs only: `docs/native/code-rework/04-HANDOFF.md`, `tools/gh-shim.sh` | Fold `04-HANDOFF.md` into `docs/native/code-rework/`, since it is the only record of the known gaps: http/prompt/agent/mcp_tool hooks not run, no PreCompact, relay pending commands never expire, proxy character-floor billing, shared Gradle/Maven/CocoaPods caches, shell changes not in rewind. Drop the gh shim |
| `origin/agent/code-live-steering-2026-08-28` | 4 | Yes | Superseded by `AgentOrchestrator.steer/queue` (`:398-482`). Do not merge |
| `origin/agent/juno-code-macos-production(-v2)-2026-08-27` | 19 / 8 | UI (goal strip, run overview inspector) | Superseded by `JunoCodeUI/Studio`. Do not merge |
| `agents/{runtime,features,rework,rework-native,redesign,redesign-native}`, `connectors/custom-mcp`, `skills/import-anywhere`, `wip/*`, `worktree-agent-ac27a72b…` | 0–4 | No JunoCode, agent-core or agent-proxy files. `agents/rework-native` and `wip/p5-B-paused` touch `JunoWorkKit` only | Not in scope. `connectors/custom-mcp` may be the vehicle for user-global MCP later |

The `rework/{store,compaction,checkpoints,hooks,screen,relay,proxy,feed,security-fixes,integration}` branches named in the handoff no longer exist locally. Their work is on `main`.

---

## 6. Prioritized fix list (by leverage)

**P0: correctness and cost**

1. **Stable cached prefix, and thinking that survives.**
   - Move goal state, the skills index, date and branch out of `system` into a trailing per-turn `<session_state>` block on the newest user turn.
   - Drop `goalUpdatedAt` from `TurnContract`.
   - Rewrite images to text only at compaction, or keep the last N images, instead of after every turn.
   - Add a 4th, "previous tail", breakpoint.
   - Run the compaction summary as a continuation of the cached prefix (same tools and system, plus a final user instruction).
   - Files:
     - `JunoCodeUI/Models/SessionController.swift:701-714,770-779,1047-1094,3576-3590`
     - `JunoCodeUI/Models/WorkspaceContext.swift:284-421`
     - `JunoCodeRuntime/AgentOrchestrator.swift:977,1616`
     - `JunoCodeBridge/BackendCodeModelClient.swift:612-656,709-728`
     - `JunoCodeRuntime/CompactionSummarizer.swift:121-187`
2. **Retry and overflow policy.**
   - `rateLimited(retryAfter:)` and `overloaded` typed errors.
   - Exponential backoff with jitter, 4–5 attempts, `retry-after` honored. Port from `runner/agent-core/src/loop.ts:154,362-369` and `providers/errors.ts:125-142`.
   - Fallback only after backoff is exhausted.
   - On `model_context_window_exceeded` or "prompt is too long": force compaction, then retry once.
   - Map `refusal` and `pause_turn`.
   - Files: `JunoCodeRuntime/ModelClient.swift:185-227`; `JunoCodeBridge/BackendCodeModelClient.swift:309-331,1284-1290`; `JunoCodeRuntime/AgentOrchestrator.swift:758-965`.
3. **Ambiguous-execution durability.**
   - Save `conversation.json` after `:1137` and before execution.
   - On restore, a call with `toolStarted` and no `toolCompleted` gets the result "Outcome unknown: Juno quit while this ran; check the workspace before re-running", not "Not executed".
   - Files: `JunoCodeRuntime/AgentOrchestrator.swift:586-612,1134-1142`; `JunoCodeRuntime/ConversationIntegrity.swift:16-17,67-70`; `JunoCodeRuntime/CodeSessionStore.swift:764-800`.
4. **Malformed tool input.**
   - Emit a `toolCallMalformed(id, name, raw, error)` event.
   - Answer it with an `is_error` result that names the JSON error and the byte offset.
   - Add lenient scalar coercion (`"5"`, `"true"`, stringified object or array) in `SchemaValidator`.
   - Files: `JunoCodeBridge/BackendCodeModelClient.swift:1255,1273-1282,1542-1549,1607,1651-1658`; `JunoCodeRuntime/SchemaValidator.swift`; `JunoCodeRuntime/ModelClient.swift:193-214`.
5. **Command output.**
   - Stream to a per-call spill file and stop killing at 2 MB; use a separate hard ceiling.
   - Inline about 30 K characters of head and tail, plus the path, which `read_file` can page.
   - Files: `JunoCodeLocal/CommandExecutionService.swift:168-192,349-380`; `JunoCodeRuntime/Tools/CommandAndTestTools.swift:95-137`; `JunoCodeCore/OutputLimiter.swift:17`; `JunoCodeRuntime/AgentOrchestrator.swift:1286-1297`.

**P1: tool surface (the gap to Claude Code and Codex)**

6. **Shell sessions:**
   - tools: `shell` with `background: true` returning an id, `shell_output(id, tail, filter)`, `shell_kill(id)`, `shell_write(id, stdin)`
   - cwd persistence inside the workspace
   - rule subject `Bash(...)`
   - Build on `JunoCodeLocal/Terminal/NativeTerminalSession.swift`, `InteractiveTerminalSession.swift` and `DevServerService.swift`. Then retire the `&` refusal (`CommandAndTestTools.swift:173-193`).
   - Touch `ToolRegistry.swift:25-63`, `JunoCodeCore/ToolConflictEffect.swift` and `ToolRuleSubjects.swift`.
7. **Edits:**
   - `multi_edit(path, edits[])`, atomic.
   - Codex-envelope `apply_patch` across files, all-or-nothing, with per-file fingerprints and one checkpoint group.
   - Rename today's tool to `edit_file`.
   - Files: `Tools/FileTools.swift:420-476`, `JunoCodeCore/TextPatch.swift`, `JunoCodeLocal/FileOperationService.swift:114-153`, `JunoCodeLocal/TurnCapturingFileOperations.swift`, `CheckpointStore.swift`.
8. **Reads:**
   - numbered lines
   - images through `toolResultWithImages` (vision-gated)
   - PDF page ranges
   - no 1 MB wall; index lines by streaming
   - Files: `Tools/FileTools.swift:115-194`, `JunoCodeLocal/FileOperationService.swift:26-38,269-294`, `JunoCodeCore/OutputLimiter.swift:15`.
9. **Search:**
   - ripgrep when available; `context`, `output_mode`, `multiline`, nested `.gitignore`
   - exclude `.juno/`
   - Files: `Tools/SearchTools.swift:86-135`, `JunoCodeLocal/WorkspaceIndexService.swift:9-15,164-218`.
10. **Planning and questions:**
    - `todo_write`: session state, no approval, rendered in the thread, and it replaces the goal nudge.
    - `ask_user`: suspends like `PermissionCoordinator`; relayable to the phone.
    - `exit_plan(plan)` in Plan mode, leading to a card with "Implement (Ask / Auto-edit)" that flips the behavior.
    - Allow replacing a goal (B10).
    - New `Tools/TodoTool.swift`, `AskUserTool.swift` and `ExitPlanTool.swift`.
    - Touch `JunoCodeCore/SessionEvents.swift`, `JunoCodeRuntime/CodeSessionStore.swift:237-270`, `SessionController.swift:1047-1094`, `Studio/StudioMode.swift`, `Studio/StudioThreadRows.swift`.

**P2: context, trust, accounting, hygiene**

11. **Instructions and repo state:**
    - Lazy nested `AGENTS.md`/`CLAUDE.md` loading when a tool touches a directory, with the closest file winning. Append it to the tool result.
    - `AGENTS.override.md`.
    - A git snapshot (branch, ahead/behind, up to 50 dirty files) in the first-turn context block and re-injected after compaction.
    - Files: `WorkspaceContext.swift:251-268,440-489`; a new `JunoCodeLocal/InstructionLoader.swift`; `ConversationCompactor.swift` / `CompactionSummarizer.swift` (post-fold state block).
12. **Skills:**
    - Use the hook-style trust store.
    - Put names and descriptions in context and load bodies on demand (a `skill` tool).
    - Fence bodies as repository data.
    - Derive the ID from the path (B11).
    - Files: `SessionController.swift:3576-3590`, `JunoCodeLocal/Extensibility/SkillActivation.swift:15-36`, `CodeDefaults.swift:143-177`, `HookPolicyStore.swift` pattern.
13. **Usage ledger:**
    - Add `cacheRead` and `cacheWrite` to `.usage` and `ModelUsageTotals`.
    - Persist per session.
    - Sum children through `observeCallUsage`.
    - Price from the manifest.
    - Files: `ModelClient.swift:142-214`; `BackendCodeModelClient.swift:1323-1347,1474-1479,1615-1619`; `DelegateTaskTool.swift:487-489,731-741`; `SessionController.swift:513,745-748`; `CodeSessionStore.swift`.
14. **Fallback and Responses:**
    - Recompute effort per model, and persist the switch.
    - Request and replay `reasoning.encrypted_content`.
    - Files: `AgentOrchestrator.swift:907-927`; `CatalogFallbackResolver.swift:35-65`; `BackendCodeModelClient.swift:909-1017,1569-1641`; `ModelClient.swift:30-60`; `ConversationIntegrity.swift:113-121`.
15. **Hygiene:**
    - Fix `ToolConflictEffect` names and exclusivity (`JunoCodeCore/ToolConflictEffect.swift:60-102`).
    - ASCII-only MCP names (`MCPCodeTool.swift:80-88`).
    - Make `move_file` check both paths (`ToolRuleSubjects.swift:22-25`).
    - Serialize the approval observer with one `AsyncStream` consumer (`AgentOrchestrator.swift:620-672`).
    - Retry through rewind instead of the composer (`SessionController.swift:1604-1617`).
    - Delete `CloudCodeSandboxClient`, `LocalPythonSandboxClient` and `JunoCodeUI/Remote/*` plus the `WorkbenchModel` remote path (`:239-311`), `makeInteractiveTerminal`, `/boost` and `/teamwork-preview`.
    - Align client timeouts with the proxy (`BackendCodeModelClient.swift:192-196`).
    - Add `web_fetch` to the inspection set (`ToolRegistry.swift:11-14`).
16. **Converge the loops.**
    - Run Mac Work (`native/macOS/JunoDesktop/App/DesktopWorkRunHost.swift`) on `AgentOrchestrator`, or on an extracted `TurnEngine`.
    - Decide whether cloud runs the Swift engine headless or the TypeScript runner gets caching and compaction. Today the TypeScript runner has neither (`runner/agent-core/src/providers/anthropic.ts`, `loop.ts`).
17. **Tests to add:**
    - recorded real Anthropic, Chat and Responses SSE fixtures replayed through a multi-turn tool loop
    - a cache-prefix-stability assertion (the byte-identical prefix across N turns, with goal and image events)
    - 429 with `retry-after`
    - malformed or truncated tool JSON
    - crash mid-batch, then restore
    - a steer that discards tool calls after a thinking block
    - nested instructions
    - a 150-step soak with compaction
    - Location: `Tests/JunoCodeRuntimeTests/`, `Tests/JunoCodeBridgeTests/`.

---

### Sources (competitor and provider claims)

All accessed 2026-09-30. The pages are undated.

- Anthropic, "Preserved thinking": https://platform.claude.com/docs/en/build-with-claude/preserved-thinking. Covers the `thinking-binding-controls-2026-08-01` beta, `drop_block`, enforcement for accounts created on or after 2026-08-31, and that edits to earlier messages invalidate later thinking blocks and restart the cache.
- Anthropic, "Prompt caching": https://platform.claude.com/docs/en/build-with-claude/prompt-caching. The 20-block lookback, taken from the search summary; not independently re-read.
- Claude Code, "Tools reference": https://code.claude.com/docs/en/tools-reference. Covers `AskUserQuestion`, `ExitPlanMode`/`EnterPlanMode`, `Monitor`, `TaskOutput`/`TaskStop`, Task* and TodoWrite, Read with line numbers, images and PDF pages, Bash cwd carry-over, and output spill past about 30 K characters.
- OpenAI Codex, "Custom instructions with AGENTS.md": https://developers.openai.com/codex/guides/agents-md. Covers the global, root and down-to-cwd concatenation, closer files overriding, and `AGENTS.override.md`.
