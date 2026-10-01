# Juno Refoundation — progress

Branch `rework/refoundation`, worktree `../juno-refoundation`, started from
`main` @ `1feb392c` (Release Juno for Mac 1.9.3, build 94) on 2026-09-30.

This file is the running record: what each phase did, how it was verified, and
what it left open. `PRODUCT_REFOUNDATION.md` is the product decision;
`DECISIONS.md` is the log of individual decisions and their reasons.

## Baseline (main @ 1feb392c, before any refoundation edit)

Run with `.claude/local-tools/refoundation/gate.sh` (3 machine-wide slots) in
the fresh worktree after `npm ci`, `npm ci --prefix runner/agent-core`, the
agent-core build and `npm run i18n:extract`.

| Gate | Result | Notes |
|---|---|---|
| `npm run typecheck` | pass | |
| `npm run lint` | pass | |
| `npm test` | pass | 4,165 tests: 4,124 pass, 0 fail, the rest skipped (DB-gated) |
| `capabilities:check`, `work:contract:check`, `shell:contract:check` | pass | |
| `design:contract:check` | pass | |
| `design:tokens:check` | **FAIL (pre-existing)** | `globals.css` changed on main without regenerating `tokens.generated.ts` and `JunoGeneratedTokens.swift` |
| `native:parity:check` | **FAIL (pre-existing)** | 7 routes unclassified in `contracts/parity/features.json` (`/api/agents/[id]/starter`, `/api/agents/hire-draft`, `/api/mcp/servers*` ×4, `/api/skills/import/file`) and `/api/agents/[id]/duplicate` marked planned though Swift calls it |
| `native:sync:check` | **FAIL (pre-existing)** | fails because of the two gates above; its other 11 gates pass |
| `native:wire:check`, `native:contract:check`, `native:design:check`, `native:register:check` | pass | |
| `security:check` | **FAIL (pre-existing)** | 116/116 security tests and the secret scan pass; the dependency advisory step flags `brace-expansion`, `fast-uri`, `image-size`, `ip-address`, `nodemailer`, `pptxgenjs` |
| `models:capabilities:audit`, `work:sandbox:check` | pass | |
| `code:runtime:check`, `code:remote:check`, `code:preview:check` | pass | |
| `npm test --prefix runner/agent-core` | pass | |
| `npx prisma validate` | env-only failure | needs `DATABASE_URL` and `DIRECT_URL`; re-run with placeholder URLs |
| `npm run build` | _pending_ | |

## Phases

| # | Phase | State | Commits | Verification |
|---|---|---|---|---|
| 0 | Baseline, competitor research, current-state audit and screenshots | in progress | | |
| 1 | Product architecture and information architecture | | | |
| 2 | Design-system directions and the final decision | | | |
| 3 | Shared web primitives, shell, sidebar, composer, chat | | | |
| 4 | Native design-system adaptation and shell parity | | | |
| 5 | Connectors and Skills | | | |
| 6 | Crew | | | |
| 7 | Work, Research, Voice | | | |
| 8 | Artifacts lifecycle | | | |
| 9 | Juno Code runtime correctness and architecture | merged into `rework/refoundation` | lane merges `76e1accb` `90681ce7` `954fc35c` `84114901`; trunk merge `4c3e59f1` | see Phase 9 below |
| 10 | Juno Code on Mac | | | |
| 11 | Code on web and iOS: remote and cloud parity | | | |
| 12 | Accessibility, motion, responsive polish | | | |
| 13 | Security hardening | | | |
| 14 | Production release and CI hardening | | | |
| 15 | Visual QA and acceptance | | | |

## Phase 9 — Juno Code runtime correctness and architecture

Four lanes, each built and then reviewed on its own branch from
`rework/refoundation` @ `3e3040e6`, merged with `--no-ff` in this order onto
`rf/code-integration` (worktree `../juno-rf-code-integration`, started from
`rework/refoundation` @ `39fd9881`). Product decision: §11 of
`PRODUCT_REFOUNDATION.md` and D-014 (converge the protocol, not the engine).

### What landed, per lane

**`rf/code-runtime` — the Swift loop** (18 commits, `a06f008c`…`b3f75574`;
merge `76e1accb`, clean).

- Stable cache prefix: goal, skills, date and branch leave the system prompt
  for a `<session_state>` block sent only when a section changes; the system
  prompt is built once per session and reused byte for byte; images stay until
  compaction under a 20-image / 12 MB cap; a fourth breakpoint marks the last
  request's tail; the compaction summary continues the cached request
  (`a06f008c`).
- Typed retry policy ported from the cloud runner: backoff with jitter,
  `retry-after`, fallback only after backoff and only when the reader opted in,
  refused requests (400/404/422) never retried, a stalled stream retried once
  (`c2aed791` `f28afee4` `68ce3975` `b627778c`; proxy `c1923284` `a9a6b320`).
- A tool batch is saved before it runs and a restored session is told what
  ran (`c6c38635`); malformed arguments are answered with the parse error and
  exact scalars coerced once, up front, so risk and scheduling see what runs
  (`f3e7f0f1` `74cebb51` `b3f75574`).
- Long `run_command` / `run_tests` output spills to the session folder and is
  paged back through `juno://command-output/` instead of being killed at 2 MB
  (`76ce5d95` `c507d0b1`).
- Replaceable goals (a completed goal no longer freezes later batches,
  `0cbef417`), path-keyed skill ids, ordered approvals, safe MCP names, moves
  checked at both ends (`7d9f406a`); a cache-aware usage ledger per session
  (`0ffe8083`); Mac-hosted Work turns through integrity repair and the retry
  policy (`63d7b878` `b7d4aa0c`).

**`rf/code-tools` — the Swift tool surface** (18 commits,
`de5d053d`…`2fb6a2a9`; merge `90681ce7`, 9 files in conflict).

- `multi_edit` and an atomic multi-file `apply_patch` with the Codex envelope
  (`de5d053d`); numbered `read_file` with images, PDFs and honest binaries
  (`76580461`); `grep` with context, counts, multiline and every `.gitignore`
  (`b2e414bf` `0d8a2a98`).
- Background shells (`shell_start/output/write/kill`) under run_command's
  sandbox and approvals, and a per-session working directory that survives a
  relaunch (`5d433841` `bcbdcbd8` `e47669d3` `2fb6a2a9`); typing into an
  interpreter always asks and newlines split commands (`74d93363`).
- `todo_write`, `ask_user` and Plan → approve → Code (`fd7bd661` `afdcc4a8`
  `379b13cf`); nested AGENTS.md / CLAUDE.md / JUNO.md delivered with tool
  results, after the result's bounds (`b017fce8` `f489f9af` `379b13cf`).
- Skills trusted before they are offered, loaded on demand with `use_skill`,
  identified by path (`b0374d47`); every file of a patch envelope meets the
  Edit hooks (`df44c420`); relay events for checklists, questions and plans
  bounded in bytes (`c8b8fdfc` `f3b855c9`).

**`rf/agent-core` — the cloud engine** (12 commits, `a0766a4b`…`3c19b79e`;
merge `954fc35c`, 1 file in conflict).

- The Mac's permission rules read by agent-core, one shared fixture pinning
  both engines, a repository only able to narrow them; the cloud runner reads
  no reader's settings file (`a0766a4b` `65769b30`).
- Typed failures (plan limit, over-long prompt, tool throw) (`e1934f89`);
  prompt caching with four breakpoints and a byte-stable prefix (`5a72e709`
  `06435618`); signed thinking kept and replayed in the tool loop
  (`2ede9ddc`); compaction at 80% of the window, a Stop during it stopping the
  run (`d2654f46` `bf756965` `3c19b79e`); proxied calls attributed to their
  task (`0349cee9`); an OpenAI Responses adapter replaying sealed reasoning
  (`42ecdab5`).

**`rf/agent-protocol` — one protocol** (12 commits, `1866e184`…`363b94ee`;
merge `84114901`, 2 files in conflict).

- Device tasks carry model and effort to the Mac (`1866e184`); the canonical
  agent session protocol v1 (31 events, 8 commands, 23 enums), generated for
  agent-core, the web and a Swift target, with one fold in TypeScript and a
  line-for-line Swift port held to golden transcripts (`65106905` `5ebed5d2`).
- The cloud runner speaks the protocol with legacy twins (`ab49461b`
  `a95d2a45` `363b94ee` `0b1c121f`); one projection of a Mac session spelled
  for the relay and the device-task wire, posted in bodies the server accepts
  (`bbdd2061` `8a99ddf9` `d305efdb` `7c1c0600`); dead remote-session and
  sandbox paths deleted (`5115655c`).

### What the integration itself changed

The conflicts were resolved by keeping both lanes' behaviour; the new code is
in the merge commits.

- `90681ce7`: skills are listed (name and description, trusted and switched
  on) in the `<session_state>` skills section rather than the system prompt,
  and `use_skill` is registered in every project session with a provider that
  reads the reader's switches and trust at call time (`SessionSkillProvider`),
  so trusting or switching a skill never changes the system prompt or the tool
  list. run_command keeps the session folder and `cwd` and streams through the
  spill capture; read_file keeps images/PDFs/numbering and still reads
  `juno://command-output/`. New test: a skill trusted mid-session loads through
  the existing tool with the prefix byte-identical.
- `954fc35c`: `shell_start` added to the shared Bash family in the Swift
  table, the fixture and agent-core's copy.
- `84114901`: the Mac's `todo_write` / `ask_user` / `exit_plan` entries map
  onto `plan.updated`, `question.asked/answered` and `plan.proposed/resolved`;
  the relay keeps the typed `canonical_session_event` for them with the
  protocol beside it, and a checklist no longer blanks the phone's goal line;
  the device-task status lines rf/code-tools had added to the deleted
  `DesktopCodeHost` mapping now come from `CodeTaskWireProjection`.
  agent-core's projector turns `context_compacted` into `item.compaction`,
  and `protocolUsage` reports uncached input (agent-core's `inputTokens` now
  includes the cached prefix, which the protocol reader adds back). Status
  file updated to match.

### Verification (on `84114901`, through `gate.sh`)

| Gate | Result | Notes |
|---|---|---|
| `npm run native:test JunoCode` | pass | 1,278 XCTests (12 skipped), 78 Swift Testing, 0 failures (lanes' baseline 1,073 / 77) |
| `npm run native:test JunoNativeKit` | 3 failures, pre-existing | 1,673 XCTests, 58 Swift Testing. `PreviewWorldTests` (fixture email) and two `JunoTokenConsumptionTests` (unread `JunoGeneratedRadius.stage`, hand-typed colours in `JunoMobileIncognito/Premium.swift`); no lane touched these files |
| `npm run native:test JunoWork` | pass | 298 XCTests |
| `xcodebuild … -scheme JunoDesktop -configuration Debug CODE_SIGNING_ALLOWED=NO build` | pass | DerivedData `/private/tmp/juno-rf-dd-integ`. The strict warnings-as-errors build was not re-run here; the swift-loop lane reported it stopping on pre-existing macOS 26 deprecations in files no lane touched |
| `npm test --prefix runner/agent-core` | pass | 236 tests |
| `npm run typecheck` | 4 errors, environment | all in artifact files: the shared `node_modules` Prisma client was regenerated for `rework/refoundation` @ `a10b8237` (nullable `Artifact.conversationId`), which this branch predates |
| `npm test` | 1 failure, environment | 4,335 tests: 4,284 pass, 50 skipped. `imapflow no longer pulls nodemailer`: the shared install has imapflow 1.4.3, the lockfile 1.7.8 |
| `npm run lint` | pass | 0 errors, 7 warnings in `src/app/dev/design/*` |
| `npm run agent:protocol:check`, `code:task-wire:check` | pass | |
| `npm run native:sync:check` | 14 of 15 | `design:tokens:check` and `native:parity:check` now pass; `native:parity:label` wants a PR label for `src/app/api/chat/route.ts`, changed by the base (`20c902ed`), not by this phase |
| `code:remote:check`, `code:runtime:check`, `work:sandbox:check` | pass | |

### Merged into the trunk (`4c3e59f1`, through `gate.sh`)

`rf/code-integration` @ `c22d4016` merged with `--no-ff` into
`rework/refoundation` @ `6ac9b383` (after artifacts-core, chat-context and the
design round 3 commits). One conflict, `src/lib/serializers.ts`: both sides
added an import beside `readToolDetail`; both kept, so an activity row carries
the integration's `toolStatus` and the trunk's `contextReceipt`, each only when
set. `package.json` auto-merged (the trunk's `artifacts:maintenance`, the
integration's `agent:protocol` and `code:task-wire` scripts). No generated
contract needed regenerating: chat wire, parity ledger, agent protocol and
task-wire checks all passed on the merge as committed. `2adf8e75` then fixed
the three JunoNativeKit failures that predate the refoundation.

| Gate | Result | Notes |
|---|---|---|
| `npm run native:test JunoCode` | pass | 1,278 XCTests (12 skipped), 78 Swift Testing, 0 failures |
| `npm run native:test JunoWork` | pass | 298 XCTests |
| `npm run native:test JunoNativeKit` | pass | 1,673 XCTests, 58 Swift Testing, 0 failures with `2adf8e75`, which fixes the three pre-existing failures |
| `xcodebuild … -scheme JunoDesktop -configuration Debug CODE_SIGNING_ALLOWED=NO build` | pass | DerivedData `/private/tmp/juno-rf-dd-trunk` |
| `npm test --prefix runner/agent-core` | pass | 236 tests, after `npm run build --prefix runner/agent-core` (the test script runs `dist/`, which was stale: 176 tests) |
| `npm run typecheck` | pass | 0 errors; the environment errors above went away with the trunk's Prisma client |
| `npm test` | pass | 4,485 tests: 4,418 pass, 67 skipped, 0 failures (also re-run after the agent-core build) |
| `npm run lint` | pass | 0 errors, 8 warnings, all in `src/app/dev/design/*` |
| `agent:protocol:check`, `code:task-wire:check`, `native:wire:check`, `native:parity:check`, `native:contract:check` | pass | |
| `npm run native:sync:check` | 14 of 15 | `native:parity:label` flags `src/app/api/chat/route.ts`, `src/lib/chat/request.ts` and `app-sidebar.tsx` against `origin/main`, all changed by earlier trunk work; on the merge's own diff (`--base 6ac9b383`) no watched file changed |
| `code:remote:check`, `code:runtime:check`, `code:preview:check`, `work:sandbox:check` | pass | |

### Still open

- No host accepts protocol commands yet (slice 2): a question or plan on the
  Mac can be seen from the phone and the web but only answered on the Mac;
  `turn.failed` and the Mac's `usage.updated` are still planned.
- On the Mac both the goal's steps and the `todo_write` checklist are
  `plan.updated`; a protocol reader shows whichever snapshot came last.
- agent-core: the proxy does not store the run id yet, and the OpenAI
  Responses adapter is unreachable until `isWorkCapableModel` and the catalog
  let Responses-only models through (a product decision).
- The strict (warnings-as-errors) JunoDesktop build (as the swift-loop lane
  reported it) is a pre-existing failure outside Phase 9. The three
  JunoNativeKit tests above are fixed on the trunk (`2adf8e75`).

## Phase 10 — Juno Code autonomous agent (`docs/rework/CODE_AGENT_SPEC.md`)

### Step 0: the seams commit (`rf/code-agent-seams`, §6.0)

The shared types and hook points every lane builds on, merged before the
lanes start. Behaviour is unchanged: nothing records the new events yet, the
default stop check finishes every run as before, and every lane model and
tool provider starts empty.

| Seam | Where | Owner after this |
|---|---|---|
| `RunEndReason`, `GateReason`, `TurnOrigin`, `RuntimeNote` (fenced `<juno_runtime>`), `Budget`, `BudgetUsage` | `JunoCodeCore/RunOutcome.swift` | Lane A |
| `VerificationRecord`, `UIVerificationRecord`, `ReviewRecord`, `CheckKind`, `VerificationLedgerReading` / `Writing`, `VerificationSnapshot` | `JunoCodeCore/VerificationRecords.swift` | Lane B |
| 12 `SessionEventPayload` cases (`runContinued`, `runOutcome`, `verificationRecorded`, `uiVerificationRecorded`, `reviewCompleted`, `goalSet`, `goalEdited`, `goalVerdict`, `goalStatus`, `checkInDue`, `ciStatus`, `budgetReached`), projected to protocol v1.1 | `SessionEvents.swift`, `AgentProtocolProjection.swift` | Lane A |
| `CompletionGating` (default `ReportOnlyCompletionGate`), `resume(note:origin:)`, PreCompact / PostCompact / PostToolBatch / PostToolUseFailure | `CompletionGating.swift`, `AgentOrchestrator.swift`, `AgentLifecycleHooks.swift`, `ToolScheduler.swift` | Lane A (gate, resume), Lane F (hooks) |
| `goal`, `verification`, `screen`, `previewLease`, `reviewQueue`, `commands` on `SessionController` | one file per lane in `JunoCodeUI/Models/` | each lane |
| Thread items `.continued`, `.goalVerdict`, `.verification`, `.uiCheck`, `.reviewFindings`, `.screenStep`, `.ciStatus`, `.runReport` with placeholder rows | `StudioThreadItems.swift`; rows in `StudioLoopRows`, `StudioVerificationRows`, `StudioRunReport`, `Views/Preview/PreviewCheckRow`, `StudioScreenStepRows`, `StudioCIBar` | each lane |
| `CodeToolProvider` and one empty provider per lane | `CodeToolProvider.swift`, `JunoCodeUI/Models/CodeToolProviders.swift` | each lane |
| Protocol v1.1 (12 events, 7 commands, new enum values) | `contracts/agent/*`, regenerated outputs, `autonomous-loop` fixture | Lane A |

Deviation from §6.0: the review queue is `SessionController.reviewQueue`,
because `review` already holds the document-review model.

Gates on the branch (through `gate.sh`): `native:test JunoCode` 1,322
XCTests (13 skipped) + 78 Swift Testing, 0 failures (44 new tests, among
them: a continued turn cannot write in a read-only session, and Stop during
the stop check sends no continuation);
`native:test JunoNativeKit` 1,673 + 58, 0 failures; JunoDesktop Debug
`xcodebuild` succeeded; `typecheck` 0 errors; agent-core 236/236;
`agent:protocol:check`, `code:task-wire:check`, `code:runtime:check`,
`code:preview:check`, `code:remote:check`, `native:contract:check`,
`native:parity:check`, `check-approval-dispatch` pass. `npm test`: 4,485
tests, 4,416 pass, 67 skipped, 2 fail, both outside this change and failing
on the trunk too since 2026-10-01: `google:gemini-omni-flash-preview` passed
its `retiresOn: 2026-09-30` and left the catalog
(`tests/model-catalog-fidelity.test.ts`, `tests/video-gen.test.ts`).

### Lane F: commands, hooks, MCP, agents and composer inputs (`rf/code-extend`, §6.6)

Built on the trunk at `e1fde2fa` (runtime integration and seams), in
`../juno-rf-code-extend`. Shared files were touched only where a seam did not
reach, each change additive and named below.

| Spec item | Status | What landed |
|---|---|---|
| §5.4 slash verbs with real handlers | DONE, four on default routes | `SlashCommands.swift` (sources: project, yours, Claude Code; verbs; aliases), `SlashCommandHandlers.swift` (pure parser + handlers over `SlashCommandHost`), `CommandCenterModel.swift` (library, sheets, confirmation, `/btw`, `/loop`s, routes), `SessionController+Commands.swift` (the host). All 20 verbs: `/goal /verify /review /context /cost (/usage) /compact /rewind /resume /model /init /memory /permissions /agents /mcp /hooks /tasks /fork /loop /export /btw`. `/boost` and `/teamwork-preview` are gone. `/goal`, `/verify`, `/review`, `/fork` run today's behaviour through `SlashCommandRoutes`, which Lanes A, B and E replace without touching the registry: `/goal` sets the goal with no approval card (the reader typed it), asks "Replace the current goal?" over an open one, clears with `clear/stop/off/cancel` (new `CodeSessionStore.clearGoal`, a `goal.status cleared` event); `/verify` runs the detected checks through `run_tests` and its approvals; `/review` sends a turn that delegates to the built-in `reviewer` agent; `/fork` copies the conversation and transcript into a new session. `/loop` without an interval runs at a 10-minute pace until Lane A's `schedule_wakeup` exists. |
| §5.5 context and cost readout | DONE | `/context` sheet (`ContextBreakdown`: per-part estimates scaled by Hamilton's method so the parts sum exactly to the provider-reported total; suggestions in words), `/cost` sheet (`CostBreakdown`: by model with the cache split, the session's own turns apart from sub-agents). The meter shows "$1.12" beside the ring and opens `/context`. Judge and reviewer rows appear when Lanes A and B record that spend. |
| §5.8 user-global MCP, commands, agents, skills | DONE | `~/.juno/mcp.json`, `~/.juno/{commands,agents,skills}`; read-only import of `~/.claude/{commands,agents,skills}` and `~/.claude.json` `mcpServers`, each off until turned on (`~/.juno/imports.json`, `UserExtensionPolicyStore`). Project over yours over Claude Code's, the losers listed. Yours need no workspace trust; project items keep theirs. `ExtensionScope` (Core), `UserExtensions.swift`, `MCPConfigurationLoader.loadAll`, `MCPServerPolicyStore.startupAuthorizer`. |
| §5.9 full hooks protocol | DONE, three events partly wired | 27 events (Claude Code's 25 adopted plus `GoalSet`, `GoalVerdict`); handler types `command`, `http` (POST the stdin JSON, 2xx body read like stdout, no redirects, ephemeral session; a project's may only post to loopback), `prompt` (one tool-less model turn answering `{ok, reason}`; can only block). `mcp_tool` and `agent` are diagnosed. Stdin carries the documented fields per event (`agent_id`/`agent_type`, `last_assistant_message`, `error`, `trigger`, `tool_calls`…); stdout handles `continue`, `stopReason`, `suppressOutput`, `systemMessage`, `decision`, `hookSpecificOutput` (`permissionDecision` with `defer` as ask, `updatedInput`, `additionalContext`, PermissionRequest `decision.behavior`). Exit 2 blocks only where the event can be blocked. Timeouts 600 s command and http, 30 s prompt, 30 s `UserPromptSubmit`. Wired: the seams' PreCompact, PostCompact, PostToolBatch, PostToolUseFailure; StopFailure; PermissionRequest (a block declines, an allow approves nothing) and PermissionDenied; SubagentStart and agent-typed SubagentStop; TaskCreated/TaskCompleted (may refuse a `todo_write`); InstructionsLoaded; FileChanged (Juno's own write tools); PreModelSwitch (may keep the model)/PostModelSwitch; WorktreeCreate/Remove (the reader's isolated worktrees); GoalSet (`/goal`). Partly: ConfigChange fires for changes made in `/permissions` and `/agents`, not for files edited outside Juno; GoalVerdict has its adapter call ready for Lane A's judge; sub-agent worktrees do not fire WorktreeCreate. |
| §5.2 custom agents as targets, background delegation | DONE (with Lane B's runtime files touched additively) | Agent front matter `name, description, model, tools, mode, isolation, maxSteps` from `.juno/agents`, `.claude/agents`, `~/.juno/agents`, imported `~/.claude/agents`. `delegate_task` takes `agent` and `background`; built-ins `explorer`, `reviewer`, `verifier` (`SubagentDefinitions.swift`, prompts only: the reviewer's JSON protocol is Lane B's). An agent narrows mode, tools and steps and never widens them; write children get `min(stepLimit/4, 60)` steps. Background children (`BackgroundSubagentRegistry`, 30-minute budget each) are followed by `await_subagents`, `inspect_subagent`, `cancel_subagent` through `ExtensionToolProvider`; Stop cancels them. `hasRunning` is there for Lane A's stop check. |
| §5.11 image paste and drag | DONE, surfaces pending | ⌘V and drop of images, PDFs (first four pages as PNGs) and Finder files; the macOS screenshot thumbnail drags in as a file. A model that cannot see now says "This model cannot see images; switch to one that can." instead of the paste vanishing. "Send to chat" from Preview and screen-control thumbnails is `SessionController.attach(_:)`, ready for Lanes C and D to call. |
| §5.12 @ mentions | PARTIAL | `MentionResolver.swift` (from `FileContextToken.swift`) and `StudioMentionPicker.swift`: `@diff` and running `@shell:<id>` above files and folders; folders list two levels deep, at most 200 entries, plus their `AGENTS.md`; `@preview:/route` asks a `PreviewMentionProviding` (Lane D plugs the Preview in; without one the block says the Preview was not open); unknown mentions stay text. Not done: tinted inline rendering in the composer (a `TextField` cannot style ranges; left for the composer redesign). |
| §5.18 App Intent | DONE; CLI SKIPPED (D-025) | `JunoCodeIntents.swift` "Start a Juno Code task" (task, project, goal, mode) and an App Shortcut; `CodeTaskIntentRequest` caps the mode at the reader's remote ceiling, since an automation runs with no one watching; the session is ordinary and every approval waits in the app. `.junoCodeOpenSession` notifications from `/resume` and `/fork` reach the window through `DesktopWorkbenchRegistry`. |

Safety invariants, each with a test: a hook's `updatedInput` is validated
against the schema and authorized from scratch at no lower a risk, without
the hook's own `allow` (`HookInvariantTests`); a hook `allow` cannot silence
screen input, a destructive action or `git_commit`, nor turn read-only into
an action; a PermissionRequest hook may decline, never approve; a prompt hook
can only block; a project's HTTP hook cannot post off this Mac; imported
Claude Code items start off; a slash verb runs under the session's mode
(`/verify` asks like any command); an App Intent never gets more than the
remote ceiling; Stop ends loops and background children.

Shared files touched (additive): `AgentOrchestrator.swift` (PermissionRequest
and PermissionDenied calls beside the Notification one), `ToolScheduler.swift`
and `ToolRegistry.swift` (`updatedInput`, `minimumRisk`),
`CodeSessionStore.swift` (`clearGoal`), `CodeToolProvider.swift`
(`backgroundSubagents`), `DelegateTaskTool.swift` (agents, background,
SubagentStart), `SessionController.swift` (hook adapter gets the prompt
evaluator and instruction files; `signalHooks`; model and worktree signals;
agent targets and the background registry for `delegate_task`; Stop calls
`commands.stopEverything()`; mention context after file context; the
non-vision message; `currentSystemPrompt`; `transientError` settable in the
module), `WorkspaceContext.swift` (MCP from every scope; skills with user
folders), `StudioSessionView.swift` (commands through the command centre,
the sheet host, the loop line, the meter's `/context`), and on the Mac
`DesktopWorkbenchRegistry.swift` (one line) and the regenerated
`JunoDesktop.xcodeproj` (four lines for `JunoCodeIntents.swift`).

Tests added (76): XCTest `HookHandlerProtocolTests` (12, including an
in-process `NWListener` HTTP hook and scripted prompt hooks),
`HookInvariantTests` (6), `SubagentTargetTests` (8),
`WorkspaceAgentHookEventsTests` (9, including a prompt Stop hook through a
scripted model), `ComposerPasteTests` (3), `StudioCommandSnapshotTests` (8,
offscreen, skipped without `JUNO_SNAPSHOT_DIR`); Swift Testing
`SlashCommandRegistryTests` (13), `UserGlobalConfigTests` (5),
`MentionResolverTests` (5), `ContextBreakdownTests` (4), `CodeTaskIntentTests`
(3). Updated: `HookExtensibilityTests` (600 s default, PreCompact is an event,
agent-typed SubagentStop), `SlashCommandTests` (verbs, landing library).
Snapshots reviewed by eye in light and dark: slash menu (scrolls past eight
rows now), `/context`, `/cost`, `/permissions`, `/agents`, `/btw`, the `@`
picker, the hooks list with every handler kind, the loop line. Words only, no
pills or dots.

Gates on the branch (through `gate.sh`):

| Gate | Result | Notes |
|---|---|---|
| `npm run native:test JunoCode` | pass | 1,368 XCTests (21 skipped: the 13 earlier snapshot skips and the 8 new ones without `JUNO_SNAPSHOT_DIR`) and 108 Swift Testing, 0 failures; seams baseline 1,322 + 78 |
| `JUNO_SNAPSHOT_DIR=… JUNO_SWIFT_FILTER='StudioCommandSnapshotTests'` | pass | 19 PNGs, read and reviewed |
| `xcodebuild -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj -scheme JunoDesktop -configuration Debug -destination 'platform=macOS' -derivedDataPath /private/tmp/juno-rf-dd-code-extend CODE_SIGNING_ALLOWED=NO build` | BUILD SUCCEEDED | App Intents metadata extracted; no warnings in the new files |
| `npm run typecheck`, `npm test` | not run | no TypeScript or web file changed in this lane |

Left for other lanes, through the seams above: the goal sheet and start card
replace `/goal`'s default route (A); the verify recipe and the reviewer pass
replace `/verify` and `/review` (B); session forks at a turn and into a
worktree replace `/fork` (E); the Preview answers `@preview:` and calls
`attach(_:)` for "Send to chat" (D); screen-control thumbnails do the same (C);
the stop check reads `BackgroundSubagentRegistry.hasRunning` (A); the judge
calls `WorkspaceAgentHooks.goalVerdict` (A).
