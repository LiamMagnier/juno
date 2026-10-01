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

### Lane A: loop, stop check and goal (`rf/code-loop`, §6.1; steps 1 and 2 of §6.8)

Branched from the trunk at the seams merge (`e1fde2fa`). Three code commits
and this entry; nothing pushed.

| Spec item | State | Where |
|---|---|---|
| §1.2 run ledger, filled from side effects, stamped by revision, saved as the run journal | Done | `JunoCodeRuntime/RunLedger.swift` (`RunLedger`, `RunLedgerRecorder`, `RunJournal`) |
| §1.3 one end reason per run, report and divider words | Done | `RunEndWords`, `LedgerRunReportBuilder` (stands in for Lane B's builder through `RunReportBuilding`), `RunCompletedEvent.endReason/endDetail` |
| §1.4 stop check, rules 1–12 in order, once per revision | Done | `JunoCodeRuntime/CompletionGate.swift`; `runCheck`/`runReview` call Lane B's runners through `GateCheckRunning`/`GateReviewRunning` when they exist |
| §1.5 continuation templates, fenced notes, captions | Done | `RuntimeContinuation.swift`, `StudioLoopRows.swift` |
| §1.6 soft step limit, output-limit resume, run and goal budgets, Keep going, Retry by resume | Done | `AgentOrchestrator` (`limitReached`, `endOfTurn`, `announceWrapUp`), `SessionController+Autonomy` |
| §1.6 settings layered through the files | Done | `JunoCodeCore/AutonomySettings.swift`, `CodeSettings.autonomy`; an unapproved project file can only lower bounds; Settings → Agent → Autonomy |
| §1.7 workflow text and `<verify>`, `<autonomy>`, `<goal>` sections | Done | `WorkspaceContext.codeWorkflow`, `SessionController.autonomySections`; goal and verify re-sent whole after compaction |
| §1.11 approvals park instead of expiring into a denial | Done | `PermissionCoordinator.sweepExpired` now parks, reminders at 15/60/240 min, a late yes still binds the digest; notifications are Lane E's |
| §1.12 run journal and `resume(note: .afterQuit)` | Done | `sessions/<id>/run.json`, `SessionController.resumeInterruptedRun()`; an active goal comes back paused; the quit guard and Resume row are Lane E's |
| §1.13 protocol | Done in the seams commit | the turn's stop reason now maps from the end reason |
| §2.1–§2.2 `GoalRun`, state machine, one current goal, replaceable, history, migration | Done | `JunoCodeCore/GoalModels.swift`, `CodeSessionStore` (`goal.json`) |
| §2.3 `/goal`, start card, criteria drafting, task grants, propose_goal | Done; plan and CI origins are Lane F/E entry points into the same `GoalModelHost.startGoal` | `GoalModel`, `StudioGoalStartCard`, `ModelCriteriaDrafter`, `PermissionCoordinator.setTaskGrants` |
| §2.4 gate then judge, outcomes, judge errors, stall guard, budgets | Done | `GoalRuntime.swift`, `CompletionJudge.swift` (`haiku` route, D-020) |
| §2.5 `<goal>` section and goal tools | Done | `Tools/GoalTools.swift` (`.read`, cannot complete a goal) |
| §2.6 errors pause the goal, Stop pauses it | Done | `GoalRuntime.runEnded` |
| §2.7 waiting on background work and check-ins | Partial | the gate's `wait`, `CheckInSchedule` (tested with an injected clock) and the `checkin` note exist; nothing feeds `backgroundWork` yet, because durable shells cannot yet tell a server from an awaited job and background sub-agents are Lane B's §5.2 |
| §2.8 progress row, sheet, verdict rows, commands | Done | `StudioGoalRow`, `StudioGoalSheet`, `StudioGoalVerdictRow`; `/goal` is a session verb (`CodeSlashCommand.Action.goal`) |
| §5.16 `/loop` | Skipped | step 4 of §6.8 |
| §6.7 cross-lane acceptance | Skeleton, passing | `Tests/JunoCodeUITests/AutonomousAgentScenarioTests.swift`: all four scenarios, 1 and 2 with stand-ins for `run_checks` and the Preview recorder |

Deviations and seams for the other lanes:

- The recipe the gate reads is `GateRecipe` (in `CompletionGate.swift`), not
  Lane B's `VerifyRecipe`. Until `.juno/verify.json` lands, Code sessions use
  the test commands `TestRunnerService` suggests, none of them run without
  the model asking. Lane B maps its recipe onto `GateRecipe` and sets
  `runsWithoutPrompt` with `PermissionCoordinator.allowsWithoutPrompt`.
- Recorders reach the ledger through `CodeToolProviderContext.runLedger`
  (`VerificationLedgerWriting`) or by returning `.verificationRecorded`,
  `.uiVerificationRecorded` or `.reviewCompleted` side effects; the ledger
  stamps the revision either way.
- `UpdateGoalTool` (the step goal) stays in the tree for the sessions and
  tests that still read `SessionGoal`, but Code sessions no longer offer it.
- The diff-read rule applies only in a Git repository (`git_diff` cannot
  run elsewhere).
- A run report row shows in the thread only when it has checks, gaps or
  notes; the divider after it already says how the run ended.
- `/goal` needs a session, so the landing screen does not offer it.

Tests added: `CompletionGateTests` 35, `AutonomousLoopTests` 9,
`GoalRuntimeTests` 14, `PermissionCoordinatorTaskGrantTests` 6,
`AutonomySettingsTests` 12, `GoalModelTests` 7, `AutonomousAgentScenarioTests` 4,
`LoopSnapshotTests` 5 (rendered only with `JUNO_SNAPSHOT_DIR`), plus one each
in `CodeToolProviderTests` and `AutonomousLoopSurfaceTests`. Updated for the
new behaviour: the iteration-limit, max-tokens and missing-stop-reason tests
(soft now), the expiry test (parks now), the seam continuation test, the
cache-prefix test (new goal tools) and two slash-command tests.

Snapshots reviewed by eye, light and dark: goal row in five states, start
card, goal sheet, continuation captions and verdict rows, and one end
divider per `RunEndReason`. Words only; no pills, badges or dots.

Gates on the branch (through `gate.sh`, on `f6fb1a8a`):

| Gate | Result |
|---|---|
| `npm run native:test JunoCode` (warnings as errors) | pass: 1,362 XCTests (17 skipped: snapshots), 78 Swift Testing, 0 failures (seams baseline 1,322 + 78) |
| `xcodebuild … -scheme JunoDesktop -configuration Debug CODE_SIGNING_ALLOWED=NO build` | BUILD SUCCEEDED (DerivedData `/private/tmp/juno-rf-dd-code-loop`) |
| `agent:protocol:check`, `code:runtime:check`, `code:preview:check`, `check-approval-dispatch` | pass |
| `npm run typecheck`, `npm test` | not run: the lane changes no TypeScript and no contract |

Open for later steps: `/loop` (§5.16, step 4); feeding background work
into the gate and scheduling check-in turns (§2.7) once shells and
background sub-agents can say what is awaited; the judge's cost and latency
on Juno's proxy are still unmeasured (UNVERIFIED in §2.4); the landing
screen's `/goal`.

#### Lane A adversarial review (2026-10-01)

Every Done claim above was traced end to end. Nine defects were fixed in two
commits on `rf/code-loop` (`5d31e57f`, `b1021f90`); each has a test that
fails without its fix.

| Defect | Fix |
|---|---|
| A task grant kept applying after the goal runtime ended its goal (met, impossible, out of budget, blocked by the agent, paused by Stop): only the reader's Pause and Clear cleared it | `PermissionCoordinator` confirms the stored goal is still in force at each call a grant would allow (`setTaskGrantCheck`, installed on attach; `GoalRun.grantsApply`) |
| Answering an approval re-activated a goal waiting on the reader for another reason (blocked, stalled) | `GoalRuntime.markWaitingOnApproval` only moves an active goal |
| Output, review findings and the judge's reason were set inside the `<juno_runtime>` fence the prompt says to act on | `RuntimeContinuation.quoted`; the prompt says quoted text in a note is data; the judge sees agent-cited evidence marked apart from Juno's records |
| An unapproved project file could raise the soft step limit (`agent.maxTurns`, or naming `autonomy.stepLimit` over the reader's lower turn limit) | both only narrow; raising `maxTurns` needs approval; a migrated goal gets the standard budget |
| The wrap-up turn sent no tools, which a history with tool calls is refused for (400), so every soft limit would have ended as an error | tools stay declared; the note turns them off and any call is dropped unrun |
| The run budget counted wall-clock time: a Retry after an hour or a Resume after a night wrapped up at once, and Keep going could not cover the gap | `RunLedger.workedSeconds`/`workingSince`: working time only, stopped at the journal's last step after a quit; a resumed orchestrator carries the run's spend |
| A goal active at a quit spent the hours Juno was closed | paused at the journal's last write |
| A run that ended without the goal deciding left the goal active with its clock running | the goal waits on the reader |
| Resuming a stalled goal stalled again on the first reply | a reader's Resume or Retry clears the tool-less turn count; a judge interrupted by Stop is not a failure |

Checked and found sound: the stop check never continues with an approval
pending, in Plan or Ask, or after Stop; every loop is bounded (once per
revision, `maxAutoContinues`, a 12 to 500 continuation backstop, the goal
budget, six runner passes per end of turn, one output-limit resume per step);
parked approvals stay digest-bound; evidence comes only from tool side
effects and the runtime's own runners; the goal tools are `.read` and
cannot complete a goal; grants exclude `critical`, `destructive`, pinned
tools, screen input and `git push`.

Still open: §2.7 has no source of awaited background work; when a goal is
met while a check still fails the run ends `doneChecked` on the judge's word
(the judge sees the failing check); a write through
`CodeToolProviderContext.runLedger` mid-batch is stamped before that batch's
edits (documented: return side effects instead).

Gates on `b1021f90` (through `gate.sh`): `npm run native:test JunoCode`
passed, 1,430 XCTests (18 skipped) and 78 Swift Testing tests, 0 failures;
the JunoDesktop Debug `xcodebuild` (`CODE_SIGNING_ALLOWED=NO`) succeeded;
`code:runtime:check` and `code:preview:check` pass. Tests added: 14
(`PermissionCoordinatorTaskGrantTests` +2, `GoalModelTests` +1,
`AutonomySettingsTests` +1, `CompletionGateTests` +2, `GoalRuntimeTests` +6,
`AutonomousLoopTests` +2); three updated for the wrap-up keeping its tools.
### Lane B: verification, self-review and report (`rf/code-verify`, §6.2)

Juno now knows how to check its own work and can prove it did: a per-project
verify recipe (discovered, shown to the reader, remembered by its bytes), a
`run_checks` tool, evidence the runtime mints from what commands actually did,
a read-only reviewer sub-agent with validated JSON findings, and a run report
whose "Checked" rows come only from that evidence. Commands the agent runs can
no longer read the reader's credentials (S3). The loop itself (the stop check
that calls these) is Lane A's; every runner it needs is here behind a small
API, listed under "For Lane A" below.

| Spec item | Status | Where |
|---|---|---|
| §1.8 recipe file `.juno/verify.json` (argv or shell `run`, `targeted` with `{files}`/`{tests}`, `paths`, `cwd`, `timeoutSeconds`, `ui[]`) | DONE | `JunoCodeCore/VerifyRecipe.swift` |
| §1.8 discovery, 14 ecosystems to depth 3 (Node by lockfile, make, Cargo, SwiftPM with `--package-path`, Xcode via injected `xcodebuild -list -json`, Go, Python with `uv`/`poetry`, Gradle, Maven, Deno, Bun, Ruby, Elixir, .NET), per-package `paths` | DONE | `JunoCodeLocal/VerifyRecipeDiscovery.swift` |
| §1.8 acceptance bound to the file's SHA-256, re-asked on any edit; "Run these without asking in this repository" writes exactly the listed `Bash(...)` rules to `.juno/settings.local.json` (approved as the reader's own edit, git-ignored), nothing to project files | DONE | `JunoCodeLocal/VerifyRecipeStore.swift` (approvals in `Application Support/JunoCode/verify-approvals/`, the existing approval-store convention, not `Juno/code/verify-approvals.json`) |
| §1.8 recipe card (Liquid Glass lifted surface, exact commands, separately ticked rules option, Not now) on first need | DONE | `Studio/StudioVerifyRecipeCard.swift`, `Models/VerificationModel.swift`; one line in `StudioSessionView` |
| §1.8 `run_checks` (targeted / full / kinds / ids; most specific package first; each command authorized separately as `run_command`; failing excerpt ≤ 4 KB; full log through the output spill) | DONE | `Tools/RunChecksTool.swift`, `CheckRunner.swift` |
| §1.8 `run_command` records evidence for an exact recipe check or a classifier-graded check; others record nothing; stamped with the revision after the command's own file changes | DONE | `Tools/CommandAndTestTools.swift`, `CheckRunner.swift` (`CheckEvidenceRecorder`) |
| §1.8 classifier check grading (`npm/pnpm/yarn/bun test`, `vitest run`, `jest`, `tsc --noEmit`, `xcodebuild test`, `pytest`, `go vet`, `cargo clippy`, …; only `&&` chains count; never changes the risk tier) | DONE | `JunoCodeCore/CommandCheckGrading.swift` (an extension in its own file, so the risk rules stay untouched) |
| §1.8 `run_tests` unpinned for an exactly accepted recipe check (rules and ladder like `run_command`; still asks under Ask; every other command stays pinned, Full access included) | DONE | `CodeTool.approvalPolicy(input:)` (default: the old property) in `Tooling.swift`, used by `ToolRegistry.authorizeInvocation` |
| §1.8 learned checks ("Add `pnpm vitest run` to this project's checks?") | SKIPPED | needs an action on the report row and a recipe edit flow; the evidence it would read is recorded |
| `VerificationLedger` (fold over the transcript: revision per `fileChanged` and rewind, evidence by id, `git_diff` reads, run boundary at the reader's message; live via the store observer, restored identically from disk) | DONE | `JunoCodeRuntime/VerificationLedger.swift`, registry `VerificationLedgers.shared`. `VerificationEngine.swift` stays (the goal-evidence path the orchestrator and projection still call) until Lane A's goal runtime replaces it |
| §1.9 diff-read continuation text, reviewer sub-agent through `delegate_task` (`agent: "reviewer"`, read-only, fresh context, parent's model), JSON validated by `SchemaValidator` (extra keys tolerated), P0/P1 and unmet criteria at ≥ 0.6 block, P2/P3 become report notes, 2 rounds per run, threshold > 40 lines or ≥ 3 files | DONE (runners) | `ReviewPass.swift`, `BuiltInAgents.swift`. The gate's `runReview` call is Lane A's |
| §1.10 run report (outcome sentence, divider words, "Checked" rows only from ledger records, "Not checked since the last edit", review notes in "Left") and its row | DONE (builder and row) | `RunReportBuilder.swift`, `Studio/StudioRunReport.swift`. Appending `runOutcome` at finish is Lane A's |
| `<verify>` session-state section | DONE (builder) | `VerifyStateSection` in `RunReportBuilder.swift`; adding it to the block is Lane A's (cache discovery when there is no file: `status()` walks the tree) |
| §5.2 runtime: built-in `explorer`, `reviewer`, `verifier`; `agent` and `prompt` fields; custom agents through `SubagentDefinitionResolving`; an agent narrows tools and mode, never widens (a custom agent cannot take a built-in's name); write children get `min(parent stepLimit / 4, 60)` steps; `background: true` returns ids; `await_subagents`, `inspect_subagent`, `cancel_subagent` (parent-scoped); background children stop with the parent | DONE | `Tools/DelegateTaskTool.swift`, `BuiltInAgents.swift`, `SubagentControlRegistry.swift` (`BackgroundSubagents`) |
| §5.2 wiring custom agent discovery into `delegate_task`; `verifier` getting `run_checks` and Preview reads | PARTIAL | `SessionController` must pass `agents:` (Lane F's `CustomAgentDiscovery`); the read-only child registry has no `run_checks`, so `verifier` reads only for now |
| §5.13 diagnostics after edits (accepted typecheck, allowed without a prompt, under 20 s last time; recorded; ≤ 2 KB block) | PARTIAL | `EditDiagnostics.swift` with tests; calling it after an edit batch is the loop's (Lane A) or the `PostToolBatch` hook point's (Lane F) |
| PV-11 (`&&` and `vitest`) | DONE | dev-server refusal read per command word (`vite build`, `vitest run`, `cd web && npm test` run; `cd web && npm run dev`, `vite`, `npm start` refused) |
| S3 credential read deny-list (D-019) | DONE | `CommandSandboxProfile.credentialPaths`: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, gcloud, Azure, kube, Docker auth, netrc and git credentials, keychains, browser profiles, publishing tokens, shell histories. `file-read-data` only (existence stays visible); off for the reader's own terminal; a workspace inside one stays readable |

**For Lane A (the loop) — the calls the gate makes:**
- Evidence: `await VerificationLedgers.shared.ledger(for: sessionID, store:)` is the
  `VerificationLedgerReading` the gate reads. Count revisions there, not separately.
- `runCheck(checkIDs:)`: `CheckRunner.plan(recipe:scope:.targeted, ids:, changedFiles: ledger.filesChangedThisRun, fileExists:)`,
  then `allowedWithoutPrompt(_:)` decides rule 6's run-it-yourself branch, and `runAndRecord(_:)` runs and records.
- `runReview`: `ReviewPass.needsReviewer(trigger:changedLines:changedFiles:goalClaimsCompletion:)`,
  `ReviewPass(delegate: <the session's DelegateTaskTool>, ledger:).run(_:sessionID:)`, then
  `ReviewPass.reviewFindingsContinuation(for:)` / `diffReadContinuation` as the note text.
- Rule 2 (`wait`): `BackgroundSubagents.shared.hasRunning(parentSessionID:)`.
- Finish: `RunReportBuilder.build(.init(endReason:modelReport:evidence: ledger.snapshotThisRun, …))`, appended as `.runOutcome`.
- Session state: `VerifyStateSection.make(status:evidence:)`.

**Risks.** Keychain reads are denied to agent commands, so an `xcodebuild`
that signs with a real identity inside the agent sandbox may not find it
(ad-hoc and `CODE_SIGNING_ALLOWED=NO` builds are unaffected; not probed
here). `git fetch`/`push` over SSH from an agent command fails by design;
the reader's terminal is unchanged. The ledger registry keeps one small
ledger per opened session for the app's life. `run_checks` adds no prompt
of its own (its commands each ask), a deliberate departure from the spec's
"risk `.execute`" so the reader sees each command once rather than twice.

Gates on the branch (through `gate.sh`): `npm run native:test JunoCode`
passes: 1,439 XCTests (1 skipped, 0 failures; 117 new) + 78 Swift Testing,
with `JUNO_SNAPSHOT_DIR` set so the snapshot tests ran too. JunoDesktop
Debug `xcodebuild … CODE_SIGNING_ALLOWED=NO build` succeeded (DerivedData
`/private/tmp/juno-rf-dd-code-verify`). `code:runtime:check`,
`code:preview:check` and `check-approval-dispatch` pass. `typecheck` and
`npm test` were not run: no web or TypeScript file changed. New tests:
`VerifyRecipeTests` (13), `CommandCheckGradingTests` (5),
`VerifyRecipeDiscoveryTests` (18), `VerifyRecipeStoreTests` (6),
`CommandSandboxCredentialTests` (6, real `sandbox-exec`),
`VerificationLedgerTests` (12), `RunChecksToolTests` (10),
`CommandAndTestToolsTests` (7), `ReviewPassTests` (8),
`DelegateTaskAgentsTests` (9), `RunReportBuilderTests` (9),
`EditDiagnosticsTests` (4), `VerificationModelTests` (6),
`VerificationSnapshotTests` (4: run report, recipe card ticked and not,
changed file, recorded checks, review findings; light and dark, reviewed by
eye). `CodeToolProviderTests` and `AutonomousLoopSurfaceTests` were updated
for the provider and rows that are no longer empty placeholders.

#### Lane B adversarial review (2026-10-01)

Every DONE claim above was traced end to end and holds; the review found
and fixed eleven defects, in five commits on the branch:

| Defect | Severity | Fix |
|---|---|---|
| "Run these without asking" wrote a `Bash(...)` rule for every recipe command, so a `git push --force`, `npm publish` or `curl \| sh` in a cloned repo's verify.json became a standing permission with one tick | P1, permission widening | Rules only for lines graded as a check with no destructive or refused part (`VerifyRecipe.permissionRules`) |
| `run_checks` and the stop check ran any accepted recipe command by the mode: under Full Access a `git push` in verify.json ran silently | P1, floor | Non-check recipe commands pinned to asking, every time (`CheckRunner.approvalPolicy(for:)`), never "allowed without prompt" |
| The card listed 8 checks and counted the rest, and cut commands in the middle, so the reader accepted commands they never saw | P1, consent | Every check listed in full; past 8 the list scrolls and says so |
| A `targeted` template could carry `; curl …`; ids, paths, routes and folder or scheme names could carry sentences and line breaks into the `<verify>` session state the model reads as Juno's | P1, injection | Templates must be one plain command; ids are names; text fields are one line; discovery skips odd names and keeps ids ≤ 64 |
| Background sub-agents kept their starting mode after the reader lowered the parent's (or left Code) | P1, stale authority | `SubagentControlRegistry.capModes`, called from `setPermissionMode` and `setBehavior`; lowers and revokes pending approvals, never raises |
| Unbounded background sub-agents (each a model run, a write child a worktree) and finished entries kept forever | P2, resource | At most 4 running per parent, reserved in one step; newest 32 finished kept |
| `git_diff` with a path filter, or an empty staged diff, marked the whole diff read | P2, fakeable evidence | Counts only when it could show the whole change (unfiltered, or paths covering every changed file since the last edit) |
| A record stamped above its place in the transcript (rewind race) would turn fresh later | P2, fakeable evidence | Fold clamps each record to its position's revision; a stale refold is retried |
| A reviewer that kept failing recorded no round, so the stop check could restart it forever | P2, loop | Attempts count against the 2 rounds, checked and counted atomically |
| Grading counted `cd /elsewhere && npm test`, `make test deploy`, `./gradlew build publish`, `mvn install deploy`; recipe checks that start servers ran until timeout | P2 | Workspace-relative `cd` only; every build-tool target must be a check; servers and `&` refused and never runnable unasked |
| Discovery ran `xcodebuild -list` with package resolution (network clones, package builds) before any acceptance; accepting found checks overwrote a verify.json that appeared meanwhile; the report divider could render a model command as a link; ledgers of deleted sessions were never released | P2/P3 | `-disableAutomaticPackageResolution`; `VerifyRecipeAcceptError.fileAppeared`; links stripped; release on `.sessionRemoved` |

Also: `ToolRegistry.restricted(to:)` keeps the context provider when an agent
narrows a child's tools; write children use the session's own step limit;
seven more credential stores (hosting CLIs, more shell and REPL histories)
join the S3 deny-list; check records name the folder they ran in.

**Still open for Lane A.** The gate must treat a `runCheck` that recorded
nothing (an approval declined, a hook's ask) as fired at that revision, or it
can re-issue it; `resume(note:)` must not append a `.userPrompt` event (the
ledger starts a run there); the always-confirm floor for commands is not in
`PermissionCoordinator` on this base, so `run_command git push` under Full
Access still runs (Lane B no longer adds any path to it). **For Lane F:**
check commands run through `PermissionCoordinator` but not `PreToolUse`
hooks for `run_command`. **Residual:** evidence can still be gamed by
changing what a check runs (a `"test": "true"` script, a binstub,
`--passWithNoTests`), which shows in the diff and to the reviewer; agent
commands can still reach `securityd` over Mach (keychain items with open
ACLs, or a system prompt for the rest): the file deny-list cannot cover it.

Gates after the review (through `gate.sh`): `npm run native:test JunoCode`
passes, 1,458 XCTests (17 skipped: the snapshot tests without
`JUNO_SNAPSHOT_DIR`; 0 failures; 19 new) + 78 Swift Testing; the lane
filter with `JUNO_SNAPSHOT_DIR` set passes and the PNGs (recipe card short,
long and changed, run report, rows, findings; light and dark) were read:
words only. JunoDesktop Debug `xcodebuild … CODE_SIGNING_ALLOWED=NO build`:
BUILD SUCCEEDED. `check-code-runtime-wiring`, `check-code-preview-wiring`,
`check-approval-dispatch` pass.
### Lane D: Preview and browser (`rf/code-preview`, §4, §5.15, §6.4)

Worktree `../juno-rf-code-preview`, branched from the trunk at `e1fde2fa`.
Nine commits, `d473d57c`…`f051bfa1`; nothing pushed. The Preview now belongs
to the session, not the view: a registry owns every dev server and sessions
lease them; one hardened page per preview is re-parented between the dock and
the window and kept in a host window when neither shows it; the agent drives
it with `preview_server` and `preview_browser`; UI edits are checked in the
running page before a Code run may end, and the runtime mints the evidence.

#### Offscreen-host spike (measured before the registry work, §6.4)

Harness: `swift test` (xctest process), a fixture page from
`StaticPreviewServer` with an rAF counter, a 16 ms `setInterval` counter and
capture-phase listeners recording `isTrusted`; synthesized `NSEvent`s
delivered to the `WKWebView` (never posted to the window server).

| Host window | `visibilityState` | rAF / s | timer ticks / s | `takeSnapshot` | NSEvent click → page events |
|---|---|---|---|---|---|
| never ordered | hidden | 0 | 1 | 800×600 | pointerdown, mousedown, pointerup, mouseup, click, all `isTrusted: true` |
| ordered at −20000,−20000 | hidden | 0 | 1–2 | 800×600 | same |
| 1-pt on screen, alpha 0.01, floating | hidden | 0 | 1 | 800×600 | same |
| 800×600 with 1 pt on screen | hidden | 0 | 1 | 800×600 | same |
| any of the above with `inactiveSchedulingPolicy = .none`, or as an accessory app | hidden | 0 | 1 | works | same |

Findings: WebKit hides and throttles an offscreen page (no rAF, timers at
1 Hz), while snapshots, script evaluation and trusted synthesized input keep
working. The HMR-socket analogue (the static server's SSE live-reload stream)
stays connected and delivers reloads (`StaticPreviewServerTests`). The xctest
process never sees an occlusion state of "visible", even for an on-screen
window, so the harness cannot show whether the 1-pt host un-throttles. Per
D-025 the fallback applies: the app calls `PreviewHost.configureForApp()`,
which sets `PreviewPage.backgroundHostMode = .onePoint`; tests keep
`.offscreen` and never put a window on screen. Settling is polled from Swift
(page timers are throttled), and the snapshot says when the page is hidden.
**Manual probe before release:** with a background session's preview, turn on
"Allow inspection scripts" and run `preview_browser eval document.visibilityState`
(expect `visible` with the 1-pt host).

#### Spec items

| Item | Status | Notes |
|---|---|---|
| §4.8 P0: PV-29/30/31 static server | DONE | dotfiles, `node_modules`, `.git`, `*.pem`, `*.key`, `.env*` → 404 on the asked and the symlink-resolved path; no `Access-Control-Allow-Origin`; foreign `Host` → 421; `SO_NOSIGPIPE`; `poll` writes, 64 KB streaming, single byte `Range`; SSE live reload via `WorkspaceChangeDetector` |
| §4.8 P0: PV-33 show the command | DONE | start card and `PreviewConfigApprovalCard`: argv (shell-quoted as run, control characters written out, `1d88f55b`), folder, env keys, port, network, source, warnings |
| §4.8 P0: PV-2, PV-3, PV-4, PV-38, PV-39 | DONE | honest `open_preview` alias; restart and stop tools; one page re-parented on appear; reload keeps the route; wiring check rewritten |
| §4.8 P0: PV-11 (`&&`, `vitest`) | SKIPPED | Lane B owns `CommandAndTestTools.swift` (§4.5, §6.2); not touched here |
| §4.1 registry, leases, idle stop, sharing, worktrees | DONE | `JunoCodeLocal/PreviewRegistry.swift`; a view never stops a server; a deleted session's leases end; 30 min idle with no lease and no view |
| §4.1 one page per preview, offscreen host + 1-pt fallback (D-025) | DONE | `PreviewPage`, `PreviewPageRegistry`, `PreviewHost.configureForApp()`; see the spike |
| §4.1 PGID ledger and orphan reaping | DONE | `PreviewServerLedger`: start-time check before any signal; reaped at the shared registry's first use; SIGTERM to this process's servers on quit |
| §4.1 `DevServerService.start` async | DONE | `start(_ launch:) async`; the old synchronous API stays for its tests |
| §4.1 durable shells as the process layer | PARTIAL | `preview_server attach shell_id` promotes a shell whose process group listens on the printed loopback port; servers Juno starts still run under `DevServerService`, not as `role: server` shells |
| §4.2 `.juno/launch.json` + read-only `.claude/launch.json` import | DONE | Claude's fields plus `network`, `ready`, `autoVerify`, `allowedExternalOrigins`; `${workspaceFolder}` and `${port}`; issues in words |
| §4.2 discovery writes the first file | DONE | Node (nested, root lockfile), Django, Flask, FastAPI, Rails, PHP/Laravel, Hugo, Go, static from the folder holding `index.html` (PV-16); "Save as .juno/launch.json" in the pane |
| §4.2 URL truth (PV-8, PV-9) | DONE | `ListeningSocketOwnership` (libproc); every printed URL is a candidate, only a port the group listens on counts; LAN rewritten to loopback only when the group listens there |
| §4.2 ports (PV-15) | DONE (review) | `autoPort: true` picks a free port and passes `PORT`; a fixed taken port fails naming its owner; with `autoPort` unset a taken port fails once and the pane asks "start web on a free port instead?", the answer kept on this Mac per configuration (`5d384733`) |
| §4.2 network ask (PV-7), ready, logs (PV-12) | DONE | blocked outbound host read from the log, asked once per configuration hash, stored on this Mac; `ready.path`/`timeoutSeconds`; 5,000-line ring buffer with cursors, level and search |
| §4.2 env secrets from the Keychain | DONE | `PreviewSecrets`: server secrets injected into that configuration's child only and scrubbed from its log; the pane's Secrets sheet shows names only |
| §4.3 `preview_server` | DONE | list, start, stop, restart, logs, attach |
| §4.3 `preview_browser` (~20 actions) | DONE | navigate, snapshot, find, text, click, hover, drag, type (with `secret`), key, select, scroll, scroll_to, wait_for, screenshot, zoom, resize (presets, dark mode), console, network (body by id), dialog, upload, eval, batch; legacy `wait`, `assert_text` |
| §4.3 effects per action, snapshot, real input, diagnostics | DONE | isolated world `juno-preview`, shadow roots and same-origin iframes, on-screen first, 300 refs, overlays; NSEvent input (JS only for `select`); console/fetch/XHR/WebSocket/resource diagnostics accepted only from preview-origin frames |
| §4.4 permissions table | DONE, one deviation, one gap | `eval` is `.destructive` (spec: `.critical`) so no saved tool-wide "Always allow" can silence page script that can reach any host. "Always for this preview, offered once per session" is not built; the standard Always-allow rule applies to non-floor input |
| Always-confirm floor in the Preview | DONE (beyond §4.4) | a seen send/delete/buy/sign-in control, accepting such a page question, or typing a credential is `.destructive`; clicks by coordinates, Enter and covering elements are checked when they run and refused unless approved so |
| §4.5 WebKit hardening | DONE | navigation policy, UI delegate (dialogs, same-origin popups in place, open panel only via `upload`), downloads cancelled, `file:`/`javascript:`/top-level `data:` refused, Keep sign-in per checkout with Clear site data |
| §4.6 autoVerify loop | DONE | trigger rules, settle and compile-error scan, `PreviewUIGate` (rule 8) with ≤ 3 rounds and the repeated-failure stop, evidence minted as the browser tool's `uiVerificationRecorded` side effect, `PreviewCheckRow` |
| §4.7 pane | DONE | one chrome (servers, back/forward, reload, address, device, appearance, log, Keep sign-in, Secrets, inspection scripts, annotate), state in words, no capsule or badges, agent glow + Stop (Esc), Simulator copy points to its pane. Visual redesign waits for the new design system |
| §5.15 annotate | PARTIAL | pick, note, cropped screenshot as an image attachment and the element details as composer text; not a structured `CodeAttachment` kind (Lane F owns that file) |
| `scripts/check-code-preview-wiring.mjs` | DONE | see commit `2afa69ec` |

#### Integration notes for the other lanes

- **Lane A**: `SessionController` now passes
  `completionGate: previewLease.completionGate(wrapping: ReportOnlyCompletionGate(), …)`
  for Code turns. Swap the base for `CompletionGate` and keep the wrapper, or
  call `PreviewSessionHub.shared.entry(…).verify.uiDecision(for:)` at rule 8.
  UI freshness is "at or after the last UI edit" (a later test-file edit does
  not stale UI evidence); the revision is one per `fileChanged`, counted by
  `PreviewVerifyState` from the store, until the run ledger lands.
- **Lane B**: UI records reach the transcript as the tool's side effect; when
  `VerificationLedger` lands it should absorb `uiVerificationRecorded`
  side effects (or the hub can call `recordUIVerification`).
- **Shared files touched, additively**: `CodeToolProvider.swift` (optional
  `shells`), `SessionController.swift` (three tool lines removed, `shells`
  passed, the gate wrapper), `WorkspaceContext.swift` (the preview sentence of
  the Code prompt), `CommandClassifier.swift` (the preview-server refusal names
  `preview_server` and exposes its marker), `DesktopCodeWorkspace.swift`,
  `DesktopCodePreviewDock.swift`.
- Test runs use throwaway ledger and settings files and never reap or signal
  the reader's processes.

#### Tests (new or rewritten)

`StaticPreviewServerTests` 12, `LaunchConfigurationTests` 12,
`PreviewServerLedgerTests` 5, `PreviewRegistryTests` 15,
`PreviewVerificationTests` 14 (runtime), `PreviewBrowserTests` 18 (offscreen
WebKit), `PreviewVerifyLoopTests` 4 (scripted model end to end),
`PreviewToolPermissionTests` 7, `PreviewSnapshotTests` 5 (rendered with
`JUNO_SNAPSHOT_DIR`, reviewed by eye: pane stopped and running, config card,
banners, check rows, annotate toolbar, light and dark; toolbar glyphs are
asset symbols SwiftPM does not compile, so they are blank in these PNGs only),
`CodePreviewHarnessTests` (preview-tool cases rewritten). The spike is kept as
`testTheOffscreenHostTakesSnapshotsAndTrustedInput`.

#### Gates (on `f051bfa1`, through `gate.sh`)

| Gate | Result |
|---|---|
| `npm run native:test JunoCode` | pass: 1,409 XCTests (18 skipped, snapshot tests among them), 78 Swift Testing, 0 failures (seams baseline 1,322 / 78) |
| `xcodebuild … -scheme JunoDesktop -configuration Debug CODE_SIGNING_ALLOWED=NO build` | BUILD SUCCEEDED (DerivedData `/private/tmp/juno-rf-dd-code-preview`) |
| `JUNO_SNAPSHOT_DIR=… JUNO_SWIFT_FILTER=PreviewSnapshotTests npm run native:test JunoCode` | 5 tests, 12 PNGs reviewed by eye |
| `node scripts/check-code-preview-wiring.mjs`, `check-code-runtime-wiring.mjs`, `check-tracked-secrets.mjs` | wiring checks pass; the secret scan failed on this head (corrected in review, `7928a2af`) |
| `npm run typecheck`, `npm test` | not run: no TypeScript changed in this lane |

#### Adversarial review (2026-10-01, `6a273ab9`…`2eaa4f1a`)

Every DONE row was checked end to end against the code. Defects found and
fixed on the lane branch, each with a test that fails without the fix:

| Area | Defect | Fix |
|---|---|---|
| Floor | A `drag` that presses and releases on Delete clicks it, unchecked | both ends checked like a click (refs, coordinates, covering element) |
| Floor | A line break in `type` text (`\n`, `\r`, `\r\n`, U+2028) or a raw `\r` key is Enter, unchecked | `guardEnter` for any activation character or key |
| Floor | The focusing click of `type` / `upload` lands on a covering element, unchecked | covering element checked |
| Floor | `execute` re-assessed the call from a process-wide ref-name map and "current dialog", so another session's snapshot (or page) could lift the backstop for an unapproved press | the floor approval is the assessment the reader answered, per call digest, taken once, bound to the element names and question the card showed; ref names per session, open questions per page |
| Escape from the page | WebKit re-sends a key the page ignores through `NSApp.sendEvent`; a test showed an agent's Meta+J firing the app's menu item (so Meta+Q, Meta+W, Meta+., Meta+Return buttons) | synthesized key events remembered and dropped by a local monitor when re-sent |
| Main thread | A synthesized native right click opens WebKit's context menu, whose tracking loop holds the main thread | right clicks dispatched in the page (button-2 pointer and mouse events, `contextmenu`) |
| Approvals | Start approvals leaked across sessions (`wasApprovedAnywhere`; shown bytes keyed by a digest every session shares); an unshown start ran | per session; no record of what was shown runs nothing |
| Approvals | An attach `url` in a repository file needed no approval and became a navigation target | asked about like any configuration; only approved ones are targets |
| Secrets | `upload` handed `.env`, keys and dotfiles to a page; a named secret could be typed into a visible field and read back | refused (asked or via symlink); secrets only into password fields |
| Loopback | `app.localhost` (resolver may use DNS) and `0127.0.0.1` (octal 87 to WebKit) counted as loopback | exact spellings only |
| Static server | `stop()` closed sockets still being written by handlers and live-reload writers (descriptor reuse); unbounded live-reload streams | shutdown, owners close, stream writes serialized; 16 streams |
| Registry | A start that lost a race to a stop left its process running with no entry or ledger line | the losing start stops what it launched |
| Ledger | A leaderless group was signalled on start times alone; a reused group number could be someone else's job | members must also work inside the server's folder |
| Verify loop | Desktop and phone failures in one round counted as "the same failure twice", so a fix was never re-checked | repeats counted across workspace revisions |
| Verify loop | Any passing screenshot covered an edited page | a pass must be of a changed page's route (components and styles: anywhere) |
| Verify loop | Discovered (unconfigured) configurations made every `.ts` edit in a Node backend a UI edit | roots are configured or running previews only |
| Pane | Esc worked only with SwiftUI focus and within 3 s of an action | also with the page focused, for a minute after the agent acted |
| Pane | A background page could open the reader's browser by script-clicking a link | only a link the reader can have clicked |
| Memory | A stopped server's hidden page lived on (unthrottled in the 1-pt host); crash loops reloaded forever; 5,000 log lines could reach hundreds of MB | page retired; reloads bounded; lines cut at 4,096 characters |
| Gates | `check-tracked-secrets.mjs` failed on the lane head (a token-shaped literal in a test), though reported as passing | literal assembled at run time |

Gates after the review (on `2eaa4f1a`, through `gate.sh`): `npm run
native:test JunoCode` pass, 1,437 XCTests (18 skipped) and 78 Swift Testing,
0 failures; the Preview suites are `StaticPreviewServerTests` 13,
`LaunchConfigurationTests` 13, `PreviewServerLedgerTests` 7,
`PreviewRegistryTests` 19, `PreviewVerificationTests` 18,
`PreviewBrowserTests` 26, `PreviewVerifyLoopTests` 5,
`PreviewToolPermissionTests` 14, `PreviewSnapshotTests` 5 (PNGs re-rendered
and reviewed, the port question added to the banners).
`xcodebuild … -scheme JunoDesktop -configuration Debug CODE_SIGNING_ALLOWED=NO
build`: BUILD SUCCEEDED. `check-code-preview-wiring.mjs`,
`check-code-runtime-wiring.mjs`, `check-tracked-secrets.mjs`: pass.

PARTIAL item completed in review: PV-15 (above). Still open: "Always for this
preview, offered once per session" (§4.4); durable shells as the process
layer (§4.1); a structured annotate attachment (Lane F's `CodeAttachment`);
PV-11 (Lane B).

#### Risks

- The 1-pt background host is unverified in a real app session (the
  harness never reports a visible occlusion state); manual probe above.
- Floor words are a list (English plus French); a control named otherwise
  ("Nuke it"), or a chat box whose Enter sends with no form, is input at
  `.execute`. Clicks by coordinates are resolved to their element and
  checked, never trusted.
- A server secret reaches code the agent can edit (`npm run dev` runs
  `package.json`, which the agent may change without re-approval), so it is
  not hidden from a determined agent; only from logs, files and the model's
  direct view.
- A session's lease holds its server for as long as the session exists;
  there is no archive event to end it.
- Preview evidence screenshots accumulate per session (D-022: kept with the
  session, deletable with it).
- Merge points with Lanes A and B listed above (`SessionController` gate
  wrapper, UI records as side effects, `CommandClassifier` copy).
