# Juno Code on Mac: agent autonomy audit

Date: 2026-09-30. Branch `rework/refoundation` (`3e3040e6`, code identical to `main` @ `1feb392c`). Read-only pass; nothing built or run.

Scope: how a local Juno Code session loops, when it stops, whether anything checks that the work is done, and what the reader sees. The owner's ask: "a real agent that can autonomously loop: think about what it has done, build, loop, like Codex and Claude Code."

Paths are relative to `native/Packages/JunoCode/Sources/` unless they start with `native/`, `runner/` or `docs/`. Line numbers are for `1feb392c`.

**Not re-specified here (in progress in a separate workflow):**
- cache-stable prefix (goal and skills moved out of `system`)
- retries with backoff and `retry-after`
- crash-safe tool batches
- malformed tool JSON
- output spill
- usage ledger
- durable and background shells
- `multi_edit` and multi-file `apply_patch`
- image and PDF reads
- grep context
- `todo_write`, `ask_user`, `exit_plan`
- nested `AGENTS.md`
- skill trust

This audit specifies what autonomy still needs on top of those, and names where it depends on them.

---

## 0. Verdict

Juno Code's loop is a correct single-turn tool loop: stream, run tools, repeat until the model says `end_turn`. It is not yet an autonomous agent. Four things are missing:

1. **Nothing decides "done" except the model.** On `end_turn` the run completes (`AgentOrchestrator.swift:1102-1132`). The only mechanism that can send the model back to work is a reader-authored Stop *command* hook (`:1114-1122`), and few readers write one. Juno does not check any of these before it stops:
   - an unfinished goal
   - a failing test
   - an edit made after the last passing test
   - a diff nobody reviewed
2. **Verification is gated and easy to game.**
   - Only `run_tests` produces verification evidence (`:1181-1190`), and `run_tests` asks for approval on every call, even in Full Access (`Tools/CommandAndTestTools.swift:235`).
   - `swift test` run through `run_command` is silent in Full Access and still counts for nothing.
   - Evidence is never invalidated: one passing run before the edits satisfies a goal for ever (`JunoCodeCore/SessionModels.swift:565-574`).
3. **Every non-happy stop is a dead end.** These all end the run as **failed** with "Continue to resume", and Retry re-sends the whole prompt as a new user message (`JunoCodeUI/Models/SessionController.swift:1604-1617`):
   - the 200-step cap
   - hitting `max_tokens`
   - a stream ending with no stop reason
   - an app quit

   There is no continue-in-place, no wrap-up turn and no budget.
4. **The reader is not kept in the loop while away.**
   - A pending approval expires after 15 minutes and becomes a denial (`JunoCodeRuntime/PermissionCoordinator.swift:17`, `:170-174`).
   - A blocked or paused goal ends the run as `cancelled`, which sends no notification (`AgentOrchestrator.swift:1244-1247`; `JunoCodeUI/Studio/StudioRunMonitor.swift:56`; `StudioPrimitives.swift:29`).
   - Notifications carry only the session title.
   - Quitting mid-run has no guard.

The building blocks for the fix already exist:
- stop-hook continuation with a cap (`:171`, `:1576-1603`)
- the goal state machine (`JunoCodeCore/SessionModels.swift:425-575`)
- `VerificationEngine` (`JunoCodeRuntime/VerificationEngine.swift`)
- a seatbelt sandbox for commands
- steer and queue
- the run monitor
- the cloud Work runner's validator (`runner/agent-core/src/work/judge.ts`, `work/session.ts:755-785`)

The missing piece is a **deterministic completion gate** in the loop, plus a **verification ledger** tied to the workspace revision. §5 specifies both.

---

## 1. How a local run loops today

Entry: `SessionController.send()` (`JunoCodeUI/Models/SessionController.swift:1266`), then `currentOrchestrator` (`:699-758`), then `AgentOrchestrator.submit` (`AgentOrchestrator.swift:313-385`), then `runLoop` (`:679-1271`).

### 1.1 Stop conditions

| # | Condition | Where | Status written | What the reader can do |
|---|---|---|---|---|
| 1 | Iteration cap. Default **200** (`JunoCodeCore/CodeSettings.swift:260`), range 10–1000 (`:270`); set from `settings.maxTurns` (`SessionController.swift:975`) | `AgentOrchestrator.swift:694-703` | `.failed`, "Stopped after 200 iterations." No wrap-up turn, so the model never summarises where it got to | Retry, which re-sends the prompt |
| 2 | Stop pressed | `:704-713`, `:553-577` | `.cancelled` | — |
| 3 | `stop_reason = max_tokens`. The output cap is 128K (`JunoCodeBridge/BackendCodeModelClient.swift:180`) | `:1005-1024` | `.failed`, "Continue to resume" | Must type |
| 4 | Stream ended with no stop reason | `:1029-1048` | `.failed` | Retry |
| 5 | `tool_use` with no valid call | `:1051-1070` | `.failed` | Retry |
| 6 | Model error after one 500 ms retry (being replaced by the retry work) | `:846-965` | `.failed` | Retry |
| 7 | **`end_turn`**: queued instructions first (`:1106`), then Stop hooks (`:1114-1122`, at most 8 continuations, `:171`), otherwise complete | `:1102-1132` | `.completed`, summary = last assistant text | — |
| 8 | Goal lifecycle left `active` during a tool batch | `:1217-1266` | `completed` becomes `.completed`; **`paused` and `blocked` become `.cancelled`** | Nothing; no notification (§1.7) |
| 9 | A hook returned `"continue": false` | `:1232-1243` | `.completed` | — |
| 10 | Approval expired (15 min) | `PermissionCoordinator.swift:17,170-174`; sweep `SessionController.swift:2008-2017` | The tool call is **denied**; the run goes on without it | — |

There is **no time, token or cost budget** per run: `grep budget` finds nothing in `AgentOrchestrator.swift`, and `usageTotals` (`:135`) is observed but never checked.

### 1.2 Does anything check the task is complete?

**No gate runs by default.**

- **The goal is not a gate.** A model that ends its turn with 3 of 5 goal steps pending completes normally at `:1123-1131`. The goal only *ends* a run early, when it leaves `active` (`:1217`).
- **`VerificationEngine.evaluateTaskOutcome`** (`VerificationEngine.swift:53-93`):
  - It is computed only for display: `SessionProjection.swift:341-350`, which passes `goal: nil`.
  - Studio never renders the result (`grep verificationOutcome` in `Studio/` returns nothing).
- **Evidence** (`VerificationEngine.swift:16-46`):
  - It is written only from `run_tests` side effects (`AgentOrchestrator.swift:1181-1190`).
  - It is written only into a goal: `try? store.updateGoal` silently does nothing when there is no goal.
  - It carries no workspace revision.
  - `validateCompletion` (`SessionModels.swift:565-574`) only checks that evidence is non-empty. A pass recorded before the edits, or followed by a failing run, still completes the goal.
- **Stop hooks** could act as a gate, but:
  - only `command` hooks run (`JunoCodeLocal/Extensibility/HookConfigurationParser.swift:248-260`)
  - with no hooks configured the adapter is nil (`SessionController.swift:926-928`), so `stopHookFeedback` returns immediately (`AgentOrchestrator.swift:1577`)

### 1.3 What the model is told

The system prompt (`JunoCodeUI/Models/WorkspaceContext.swift:380-421`) says:
- "Carry the task through to a verified implementation" (`:302-303`)
- "After meaningful changes, run the project's own tests or build and fix what you broke. Say plainly if you could not verify something." (`:402-403`)
- "When you finish, summarise what changed…" (`:417-418`)

It does **not**:
- tell the model to keep going until the task is resolved
- describe the explore → plan → implement → verify → review → fix loop
- tell it to review its own diff (`git_diff` exists; `ToolRegistry.swift:47-49`)
- say what to do when tests keep failing
- say when to stop and ask
- tell it to use the preview for UI work beyond the tool mechanics (`:368-378`)

Codex's shipped prompt, by contrast, says the agent "must keep going until the query or task is completely resolved, before ending your turn" and "persevere even when function calls fail" (§6).

The goal block (`SessionController.swift:1047-1094`):
- With no goal, it tells the model to "create an explicit goal with update_goal before changing files".
- After a goal completes, it says the goal is "complete and immutable" (`:1077-1079`), and `createGoal` throws `goalAlreadyExists` (`JunoCodeRuntime/CodeSessionStore.swift:253-254`). This is B10. The second multi-step task in a session is told to do something it cannot do.
- It is a snapshot taken when the orchestrator was built. The orchestrator is never swapped mid-run (`SessionController.swift:722-726`), so within a run the system prompt shows stale goal state. The prefix work in progress moves this to a per-turn block; the gate in §5 depends on that.

### 1.4 How goals (`update_goal`) interact

- `update_goal` is risk `.write` (`Tools/UpdateGoalTool.swift:66`). In Ask-before-changes, **every step transition is an approval prompt**.
- It is exclusive in scheduling (`JunoCodeCore/ToolConflictEffect.swift`, `update_goal` case).
- `/goal` is only a prompt template (`JunoCodeUI/Models/SlashCommands.swift:279-290`). It sets no condition, starts no loop and adds no evaluator.
- Completion requires all steps done plus non-empty evidence (`SessionModels.swift:565-574`), with the weaknesses in §1.2.
- The inline Plan card is placed once, at the first goal event, and updates in place (`Studio/StudioThreadItems.swift:156-159`; `StudioThreadRows.swift:470-500`). On a long run it scrolls out of view.

### 1.5 Auto-continue

- The only auto-continue is Stop-hook `block`, with a cap of 8.
- Queued follow-ups drain at `end_turn` (`:1106`); that is reader-typed work, not continuation.
- There is no resume-in-place API. `submit` always appends a user prompt.
- `retryLastTurn` puts the last prompt back in the composer and calls `send()` (`SessionController.swift:1604-1617`). The history gains a duplicate user turn, and the reader's draft is overwritten.

### 1.6 Sub-agents

`delegate_task` (`JunoCodeRuntime/Tools/DelegateTaskTool.swift`):
- **Synchronous.** It blocks the parent's turn.
- **18 iterations per child** (`:465`).
- A **10-minute budget per call** (`:64`).
- 3 run concurrently and 4 per call (`:69-70`).
- Read-only by default. A write-capable child works in a worktree, with Apply or Discard.
- Children get the inspection-only registry, so a read-only child cannot run tests (`ToolRegistry.swift:11-14`).
- A write child's `run_tests` still asks, relayed to the parent.
- **The model uses it only on its own initiative.** Nothing runs a reviewer child after implementation, and nothing backgrounds children.
- By contrast, the cloud runner already has `delegate_tasks`, `await_subagents`, `inspect_subagent` and `cancel_subagent` (`runner/agent-core/src/subagents.ts`, per `code-runtime-cloud-remote.md` §tools).

### 1.7 When tests fail

- `run_tests` returns `isError` with the tail of the output (`CommandAndTestTools.swift:284-310`).
- The loop sets `testsPassed = false` (`AgentOrchestrator.swift:1182`) and nothing else.
- The model may end its turn straight away. The run then records `.completed`, and the end divider says "tests failed" (`Studio/StudioThreadRows.swift:772-775`).
- There is no fix-and-rerun loop, no "the last check failed" nudge, and no distinction between "done" and "gave up".

### 1.8 What the reader sees

**During a run:**
- the streaming reply
- a Thinking disclosure
- one activity line with the run signature and a live elapsed timer (`Studio/StudioThreadView.swift:236-276`)
- collapsed tool stretches
- the inline Plan card
- approvals inline

It does not show:
- a step or turn count
- run spend
- a persistent progress row
- which check the agent is working toward

**At the end:** the "Worked for 2m 14s" divider, plus "· tests failed" only on failure, plus the changes card with Review (`StudioThreadRows.swift:737-783`). It does not say whether the result was *verified*, why the run stopped (done, step limit or blocked), or what remains.

**Notifications** (`StudioRunMonitor.swift:45-88`):

| When | Title | Body |
|---|---|---|
| Needs approval | "Juno needs your approval" | session title |
| Completed | "Finished" | session title |
| Failed | "Stopped with an error" | session title |

- By default they fire only when the app is inactive (`:70`).
- They have no action buttons. The body does not carry the command, the summary or the verification result.
- `.cancelled` maps to idle (`StudioPrimitives.swift:19-31`), so **a blocked or paused goal sends no notification**.
- iPhone learns of approvals through `BGAppRefresh` polling, not push (`native/iOS/JunoMobile/App/JunoMobileCodeNotifications.swift:1-12`).

**Window closed or app in the background:**
- Controllers belong to `WorkbenchModel` (`JunoCodeUI/Models/WorkbenchModel.swift:243`), and the monitor is fed by the workbench, not by a window (`StudioRunMonitor.swift:10-15`). A run therefore continues with the window closed while the app lives. That the app outlives its last window rests on the monitor's comment; this pass did not run it.
- Idle sleep is held off while anything works (`:117-128`).
- **Quit:** there is no `applicationShouldTerminate`. `applicationWillTerminate` only installs a staged update (`native/macOS/JunoDesktop/App/JunoDesktopApp.swift:261-265`). The run dies.
- On next launch the session is marked "Interrupted by app termination" (`CodeSessionStore.swift:773`), with no Resume.
- Sign-out stops every run (`WorkbenchModel.swift:779-790`).

---

## 2. Against the loop a real agent runs

The research expectation: explore → plan (todo) → implement → verify (build, test, run the app) → reflect and review the diff → fix → repeat until done → report.

| Stage | Juno today | Claude Code (docs, 2026-09-30) | Codex (docs, 2026-09-30) |
|---|---|---|---|
| Explore | ✓ read, grep, glob, git, web; read-only sub-agents | ✓ | ✓ |
| Plan and todo | `update_goal`, approval-gated in Ask, one per session (B10); `todo_write` in progress | Task tools (not default on the newest models, per prior research) plus plan mode | `update_plan`, `/plan` |
| Implement | ✓ | ✓ | ✓ |
| Verify | `run_tests` pinned to ask every time; evidence only from it; no app-run verification except the web preview tools; no auto-verify | `/verify` and `/run` skills; Desktop **auto-verify on by default** after edits (screenshots, DOM, clicks) | Sandboxed commands run "automatically"; prompt section "Validating your work" |
| Reflect and review the diff | Not prompted, not gated | `/code-review` and `/simplify` (reader-invoked) | `/review` (reader-invoked) |
| Fix and repeat | Only if the model chooses | `/goal`: after **every** turn a small model judges the condition; "not yet met", so Claude starts another turn | Goals: continue at safe boundaries; completion requires "concrete evidence" |
| Stop guard | Stop command hooks only | Goal clears on met or impossible; stops when there is "no tool use for several turns"; background work defers evaluation | "If a turn produces no tool calls, the next automatic continuation is suppressed"; a token budget |
| Report | A final message; the divider has no verdict | A goal status with turns, time, spend and the evaluator's reason | Summary; budget reached ≠ complete |
| Away | Local notification (title only); approvals expire into denials | OS notification when a session finishes and isn't in view; Dispatch push for approvals | `/goal pause/resume/clear`; prevent-sleep setting (prior research) |

---

## 3. Gaps, ranked, with the files to change

Owner rules apply throughout:
- **No status pills or decorative dots.** Verdicts are words.
- **Native Liquid Glass** for any new chrome.
- **Nothing consequential without deterministic approval.**

Anything a model judges (a goal evaluator) may only decide *whether to keep working*. It never approves an action.

### P0: turn the loop into an agent

**G1. Completion gate at `end_turn` (new).**
- Today `end_turn` completes unless a command hook blocks it (`AgentOrchestrator.swift:1102-1132`).
- Add `JunoCodeRuntime/CompletionGate.swift`: a pure, deterministic `evaluate(RunLedger) -> .finish(Verdict) | .continue(Reason)`. It is called after queued instructions and before Stop hooks.
- It reuses the stop-feedback mechanism: a runtime-authored user-role turn prefixed like `AgentHookContext.stopFeedback` (`JunoCodeRuntime/AgentLifecycleHooks.swift:230`), so compaction never quotes it as the reader.
- Bounds:
  - a per-run cap (`autonomy.maxAutoContinues`, default 3)
  - **each reason fires at most once per workspace revision**
  - **no-progress stop**: a continued turn with no tool call ends the run
- Specified in §5.1.
- Files:
  - `JunoCodeRuntime/AgentOrchestrator.swift:679-690` (ledger)
  - `:1102-1132` (the gate call)
  - `:1176-1191` (feed the ledger)
- Tests: new `Tests/JunoCodeRuntimeTests/CompletionGateTests.swift`, plus scripted-client cases in `AgentOrchestratorTests`.

**G2. A verification ledger tied to the workspace revision.**

Today:
- evidence is written only into a goal
- it never goes stale
- only `run_tests` produces it
- failures are not recorded

Change:
- Keep a `workspaceRevision` counter, incremented on every `.fileChanged` side effect (`AgentOrchestrator.swift:1177-1180`), including command-detected changes (`CommandAndTestTools.swift:140-172`).
- Record **every** verification, pass or fail, with its command and revision, whether or not a goal exists.
- Count a `run_command` as verification when either:
  - it exactly matches a project `verify.commands` entry, or
  - the classifier grades it a workspace build, test or check: the `swift build/test`, `cargo build/test/check/clippy`, `go build/test/vet` branches in `JunoCodeCore/CommandClassifier.swift:445-499`, extended to `npm test`, `pnpm test`, `tsc --noEmit`, `xcodebuild test` and `pytest`.
- `validateCompletion` must require a **passing** check at the **current** revision.
- Files:
  - `JunoCodeRuntime/VerificationEngine.swift:16-93`
  - `JunoCodeCore/SessionModels.swift:425-575` (`GoalVerificationEvidence` gains `passed` and `workspaceRevision`)
  - `JunoCodeRuntime/Tools/CommandAndTestTools.swift:95-137,296-310` (a new `.verificationRan` side effect)
  - `JunoCodeCore/SessionEvents.swift` (a `verificationRecorded` event)
  - `JunoCodeUI/Models/SessionProjection.swift:339-350` (pass the real goal; read the ledger)

**G3. Continue in place, and stop well.**

Add `AgentOrchestrator.resume(note:)`. It re-enters `runLoop` on the persisted conversation with a runtime note and **no new user message**.

Use it for:
- **Step limit.** At `maximumIterations − 1`, run one tools-disabled wrap-up turn ("summarise progress, what remains, the next step"), then end with reason `stepLimit`, not `.failed`. Continue grants another block of steps.
- **`max_tokens` and a missing stop reason.** Resume automatically once. For a truncated `tool_use`, drop the partial call and add the note "your last tool call was cut off; resend it smaller".
- **Retry.** Replace `retryLastTurn`'s composer resend with `resume`.

Files:
- `AgentOrchestrator.swift:313-385,694-703,1005-1070,1605-1633`
- `SessionController.swift:1604-1617`
- `Studio/StudioThreadView.swift:161`
- `JunoCodeCore/SessionEvents.swift` (`RunCompletedEvent.endReason`: `done | stepLimit | budget | blocked | needsYou | stopped | error`)

This composes with the retry and backoff work in progress: that work handles transport failure, this handles model-side stops.

**G4. System prompt: state the loop.** Add a "How to finish" block to `WorkspaceContext.swift:386-408` (Code behavior only):

```
Work loop: understand → plan (track steps with the plan tool for anything
multi-step) → change → verify → review your diff → fix → repeat.
- Keep going until the request is fully done and verified. Do not stop at
  analysis, a partial fix, or a failing check.
- Verify with the project's own checks (the verify commands below if given);
  for UI, open the preview and look. A check run before your last edit does
  not count.
- Before finishing, read your own diff with git_diff and fix what you would
  flag in review.
- If a check still fails after reasonable attempts, or you need a decision,
  stop and say exactly what is blocked; never claim success you did not see.
- Final message: what changed (path:line), how it was verified (command and
  result), what is not verified or left undone.
```

- List the project's `verify.commands` in the per-turn state block from the in-progress prefix work, not in `system`.
- Fix the goal nudge (`SessionController.swift:1049-1056`). It must not demand a goal the session cannot create (B10). Once `todo_write` lands, point it there.

**G5. Say how the run ended, in words.**
- Extend the worked divider (`Studio/StudioThreadRows.swift:763-782`): "Worked for 4m 12s · Checked with `swift test`" / "· Not checked" / "· Checks failing" / "· Stopped at the step limit" / "· Blocked: needs your decision". Text only, with no pill and no dot.
- Render the ledger verdict in place of the unused `verificationOutcome` (`SessionProjection.swift:139`).
- Show each gate continuation as a quiet caption through `StudioDividerCaption`, for example "Kept going: 2 plan steps were open".
- Files: `Studio/StudioThreadRows.swift`, `Studio/StudioThreadItems.swift` (new `.continued` item), `JunoCodeUI/Models/SessionProjection.swift`.

**G6. Blocked and paused goals are "needs you", not "cancelled".**
- `AgentOrchestrator.swift:1244-1247` maps them to `.cancelled`. `StudioStatus` maps that to idle (`StudioPrimitives.swift:29`), and the monitor stays silent (`StudioRunMonitor.swift:54-60`).
- End them with `endReason: blocked` and a status the monitor treats as needs-you.
- Notify with the blocker text.

### P1: make unattended runs possible under deterministic approval

**G7. Checks run without a prompt, because the reader approved them once.**

Today:
- `run_tests` asks every time, in every mode (`CommandAndTestTools.swift:230-235`).
- Auto-edit asks for every `.execute`, `swift test` included (`JunoCodeCore/PermissionModel.swift:170-171`).
- A 30-step fix loop therefore needs 30 clicks.

Deterministic options (no classifier):
- **(a) Project checks.** Add a `verify.commands` settings key. Project-file entries take effect only through the existing approve-the-bytes flow (`JunoCodeLocal/CodeSettingsStore.swift`; `docs/native/code-rework/00-README.md` §5). A call that exactly matches a listed command follows the ladder instead of the pin.
- **(b) The first prompt saves the rule.** The `run_tests` approval card offers "Always allow and use as this project's check". It writes `Bash(<cmd>)` (allow rules already pass pins: `PermissionCoordinator.swift:208-210`) plus `verify.commands` to `settings.local.json`.
- **(c) Auto-edit plus sandbox.** A `.execute`-graded command that runs inside the seatbelt profile with network off runs without asking. This is Codex's default: "Codex can read files, make edits, and run commands in the working directory automatically".
  - Precondition: close S3's global reads (`JunoCodeLocal/CommandSandboxProfile.swift:226`; deny `~/.ssh`, `~/.aws`, the Keychains).
  - Keep `.critical`, which covers network and package scripts, asking.

Files:
- `JunoCodeCore/CodeSettings.swift:250-271`
- `JunoCodeCore/PermissionModel.swift:126-176`
- `JunoCodeRuntime/PermissionCoordinator.swift:95-213`
- `Tools/CommandAndTestTools.swift:196-235`
- the approval card in `Studio/`

**G8. Approvals wait; they do not decay into denials.**
- An expired approval today reads to the model as "declined" (`PermissionCoordinator.swift:170-174`).
- Make expiry park the run instead: status needs-you, the call kept pending, notifications repeated with a back-off (for example at 15, 60 and 240 minutes).
- Add notification actions **Allow once** and **Decline**. Both are exact, reader-made, digest-bound decisions (`UNNotificationCategory`, resolved through `SessionController.approve/deny`, `:1903-1977`). "Always allow" stays in the app.
- The notification body carries the exact command.
- Files:
  - `PermissionCoordinator.swift:17,280-295`
  - `SessionController.swift:2008-2017`
  - `Studio/StudioRunMonitor.swift:45-113`
  - `native/iOS/JunoMobile/App/JunoMobileCodeNotifications.swift` (APNs push per `code-runtime-cloud-remote.md` §457)

**G9. Quit guard and Resume after relaunch.**
- Add `applicationShouldTerminate` in `native/macOS/JunoDesktop/App/JunoDesktopApp.swift:115-265`: "2 runs are working. Quit and stop them?" with **Keep working** as the default.
- Defer the staged-update install (`:262-264`) while runs are active.
- On launch, give interrupted sessions a **Resume** that calls `resume(note:)`, using the ambiguous-execution result from the crash-safe batch work in progress (`CodeSessionStore.swift:773-800`).

**G10. Run budget.**
- Add `autonomy.runBudget { minutes, tokens }` settings, checked each iteration against `usageTotals` (`AgentOrchestrator.swift:135`) and elapsed time.
- On hit: a wrap-up turn, then `endReason: budget`. Codex's rule: "Reaching a budget limit is not the same as completing the objective."
- Depends on the usage ledger, in progress.

**G11. A persistent progress row.**
- A Liquid Glass row above the composer while a run or goal is active: the plan ("3 of 5 · Wire the relay"), elapsed time, steps used of the limit, spend once the ledger lands, and the gate's current reason ("Checking: swift test").
- Pause and Stop. No dots.
- Replaces relying on the inline Plan card that scrolls away (`StudioThreadItems.swift:156-159`).
- Files: `Studio/StudioComposer.swift`, `Studio/StudioThreadView.swift:236-276`, `JunoCodeUI/Models/SessionController.swift` (expose the ledger and step count).

**G12. Sub-agents fit for loops.**
- A write child's cap of 18 (`DelegateTaskTool.swift:465`) is too small to implement and verify. Use `min(parent maxTurns / 4, 60)` for `workspace_write`, and scale the budget (`:64`).
- Add background delegation: `background: true` returns ids, with `await_subagents` and `cancel_subagent`, porting `runner/agent-core/src/subagents.ts`.
- The gate defers while children or background shells run, as Claude Code's `/goal` does.
- Child spend feeds the parent through the usage ledger, in progress.

### P2: judgment on top of determinism

**G13. `/goal <condition>` as a real loop.**
- Setting a goal is the reader's own act, so no approval is needed.
- After each gated finish, an evaluator on the small model returns `met | not_met(reason) | impossible(reason)`. `not_met` becomes a continuation, capped by G1's bounds and G10's budget.
- The goal persists across relaunch.
- Add `/goal`, `/goal pause|resume|clear` (Codex) and a status line in G11.
- Step-state changes become `.read` risk (session state, not the workspace), so they stop prompting in Ask mode.
- Lift B10 by allowing a new goal once one is terminal.
- Files:
  - `JunoCodeUI/Models/SlashCommands.swift:279-290`
  - `Tools/UpdateGoalTool.swift:66`
  - `CodeSessionStore.swift:237-270`
  - `CompletionGate.swift`
  - a new `JunoCodeRuntime/GoalEvaluator.swift`

  It is the same design as Claude Code's, which is "a wrapper around a session-scoped prompt-based Stop hook".

**G14. Self-review before finishing.**
- Gate reason `diffUnreviewed`: files changed and no `git_diff` since the last edit leads to one continuation, "review your diff".
- Opt-in `autonomy.reviewBeforeFinish: "subagent"` for larger runs (5 or more files): one read-only reviewer child (role `reviewer` exists, `DelegateTaskTool.swift:124,150`) reviews `git diff`. Its findings return once as a runtime turn.

**G15. Prompt-type Stop hooks.**
- Parse `type: "prompt"` (`HookConfigurationParser.swift:248-260`) so readers can write their own model-judged completion checks. Lower priority once G13 exists.

**G16. Verify the app, not only the tests.**
- Web: add an `autoVerify` project setting that makes the gate ask for a preview check after UI-file edits when a preview is configured. Tools exist; prompt at `WorkspaceContext.swift:368-378`.
- Native: the Simulator is UI-only (`JunoCodeUI/Views/Simulator/SimulatorPane*.swift`, `native/macOS/JunoDesktop/App/DesktopSimulatorDock.swift`; no agent tool), and computer use needs vision plus per-session activation (`SessionController.swift:788-790`).
- The details belong to the computer-use and preview audits. The gate only needs a `checkedVisually` ledger entry.

**Not autonomy, but it blocks convergence:** Mac Work runs have their own loop with a 64-turn cap and no gate (`native/macOS/JunoDesktop/App/DesktopWorkRunHost.swift:66`). The gate should live in the shared engine (`code-runtime-swift.md` §6 item 16).

---

## 4. Order of work

1. **G2** ledger, then **G1** gate, then **G4** prompt, then **G5** verdict line, then **G6**. One vertical slice: the loop keeps going until checked, and says so.
2. **G3** resume and step-limit wrap-up. Removes the "failed and type Continue" dead ends.
3. **G7** (a) and (b); then (c) after S3. **G8**, **G9**. Unattended runs become possible under deterministic approval.
4. **G10**, **G11**, **G12**: budgets, progress row, sub-agents. Needs the usage ledger and durable shells from the in-progress work.
5. **G13**, **G14**, **G15**, **G16**.

---

## 5. Specification

### 5.1 `CompletionGate`

```swift
struct RunLedger: Sendable {
  var workspaceRevision: Int            // += 1 per fileChanged side effect
  var filesChanged: Set<String>
  var lastVerification: Verification?    // command, passed, revision, at
  var lastDiffReviewRevision: Int?       // revision at the last git_diff call
  var planOpenItems: [String]            // from todo_write, else goal steps not completed or blocked
  var goal: SessionGoal?
  var backgroundWorkRunning: Bool        // shells or sub-agents (in-progress work)
  var continuations: [Reason: Int]       // revision at which each reason last fired
  var continuationsThisRun: Int
  var lastTurnHadToolCalls: Bool
  var knownVerifyCommands: [String]      // settings verify.commands ∪ commands already passed this session
}

enum Reason { case planOpen, unverified, checksFailing, diffUnreviewed, goalNotMet }
```

**Order** (the first match wins; a reason is skipped if it already fired at the current revision):

1. `backgroundWorkRunning` → `.finish(.waitingOnBackground)`. The loop wakes when the work reports (depends on durable shells).
2. `!lastTurnHadToolCalls && continuationsThisRun > 0` → `.finish(.noProgress)`.
3. `continuationsThisRun >= maxAutoContinues` → `.finish(.limit)`.
4. `planOpenItems` non-empty → `.continue(.planOpen)` naming the items. The agent must finish them or mark them blocked with a reason.
5. `filesChanged` non-empty, `lastVerification` is `nil` or older than the current revision, and a verify command is known → `.continue(.unverified)` naming the command. If no command is known → `.finish(.notChecked)`, with no loop.
6. `lastVerification?.passed == false` at the current revision → `.continue(.checksFailing)` once: "fix, or stop and explain why it cannot pass".
7. `reviewBeforeFinish != off`, files changed, and `lastDiffReviewRevision < workspaceRevision` → `.continue(.diffUnreviewed)`.
8. Goal evaluator (G13) → `.continue(.goalNotMet)` or finish.
9. Otherwise `.finish(verdict)`, where the verdict is `checked | notChecked | failing | blocked`.

The continuation text is imperative and short, for example: `[Juno] Before finishing: 2 plan steps are open (…). Finish them or mark them blocked with the reason.` It is persisted as a `runContinued(reason, detail)` event plus a marked user-role turn.

### 5.2 Settings (`.juno/settings.json` layers; project values need the existing approval)

```json
{
  "verify": { "commands": ["swift test --package-path native/Packages/JunoCode"] },
  "autonomy": {
    "maxAutoContinues": 3,
    "reviewBeforeFinish": "diff",
    "runBudget": { "minutes": 60, "tokens": null },
    "autoVerifyPreview": true
  }
}
```

Surfaced in `Studio/Settings/StudioSettingsView.swift` (Agent page, next to the turn limit at `:720-722`).

### 5.3 Tests to add

- `CompletionGateTests`: every rule, once-per-revision, no-progress, cap.
- `AgentOrchestratorTests` (scripted client):
  - `end_turn` with open plan items leads to a continuation, then finishes
  - an edit after a passing check leads to an `unverified` continuation
  - a failing check leads to one continuation, then finishes as `failing`
  - at the step limit, the wrap-up turn has no tools and ends with `stepLimit`
  - `resume` adds no user message
- `VerificationEngineTests`: stale evidence cannot complete a goal; `run_command` that matches `verify.commands` records evidence.
- `StudioRunMonitorTests`: a blocked goal notifies.
- `PermissionCoordinatorTests`: expiry parks and does not deny.

---

## 6. Sources (competitor claims; all accessed 2026-09-30)

- **Claude Code, "Keep Claude working toward a goal"**: https://code.claude.com/docs/en/goal. The page is undated; the version gates in its text run v2.1.234–v2.1.269.
  - After each turn "a small fast model checks whether the condition holds".
  - Verdicts: met, not yet met, impossible.
  - Stops when there is "no tool use for several turns".
  - Background work defers evaluation.
  - Status shows turns, time, spend and the evaluator's reason.
  - It is a wrapper around a prompt-based Stop hook.
  - "auto mode removes per-tool prompts, and /goal removes per-turn prompts."
- **Claude Code, commands reference**: https://code.claude.com/docs/en/commands.
  - `/loop`, `/verify`, `/run`, `/code-review`, `/simplify`, `/background`, `/tasks`.
  - `/verify` "runs only when you invoke it. Before v2.1.215, Claude could also run /verify on its own."
- **Claude Code, Desktop**: https://code.claude.com/docs/en/desktop.
  - "Auto-verify is on by default": screenshots, errors, "confirms changes work before completing its response".
  - An OS notification when a session finishes and "you aren't currently viewing that session".
  - Dispatch push "when it finishes or needs your approval".
- **Claude Code, Configure auto mode**: https://code.claude.com/docs/en/auto-mode-config. Auto mode is a classifier; deny and ask rules are evaluated first. It is cited as the model-judged approach Juno should not copy for consequential actions.
- **OpenAI, "Using Goals in Codex" (cookbook)**: https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex (undated).
  - Complete "only after the objective is checked against … concrete evidence".
  - Continuation "only at safe boundaries".
  - "If a turn produces no tool calls, the next automatic continuation is suppressed".
  - "Reaching a budget limit is not the same as completing the objective".
  - `/goal pause|resume|clear`.
  - Goal mode reached GA on 2026-05-21, per the prior research file `docs/native/code-rework/research/codex.md` (changelog, researched 2026-09-22).
- **OpenAI Codex, agent approvals and security**: https://learn.chatgpt.com/docs/agent-approvals-security. In the default mode "Codex can read files, make edits, and run commands in the working directory automatically"; it asks for commands outside the workspace or needing network. `auto_review` routes approvals to a reviewer agent.
- **OpenAI Codex, shipped prompt `gpt_5_2_prompt.md`**: https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md (last commit 2026-06-23). It says "You must keep going until the query or task is completely resolved…" and has a "Validating your work" section. Whether GPT-6 Sol ships the same text is **UNVERIFIED**; no GPT-6 prompt file was found in the repository tree.
- **UNVERIFIED:**
  - whether Claude Code continues on its own after `max_tokens` in the current version
  - that Juno's app process outlives its last window: taken from the code comment at `StudioRunMonitor.swift:10-15`, not run
