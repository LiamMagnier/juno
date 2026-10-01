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

### Lane C: computer use and Simulator tools (`rf/code-screen`, §3, §5.14, §6.3)

Screen control now goes through one app-wide service shared by Juno Code and
Juno Work, with per-app per-session grants, the always-confirm floor, a
consumed Esc and scaled, mapped frames. Nothing in a test captures the screen
or posts an event; the calibration test renders an offscreen window to a
bitmap. Commits: `6a806f73` (package), `8069869a` (Code), `ba419930` (Work),
`41fc6cc1` (Mac presence), plus this entry.

| Item | Status | Where / notes |
|---|---|---|
| §3.2 one service, one lock | done | `native/Packages/JunoScreenControl` (`ScreenControlService.shared`, `ScreenControlLock`); `ComputerUseCoordinator` is an adapter that keeps the consent rules; Work's `EmergencyStop(sharedScreen: .app)` takes the lock for its visual and accessibility tiers and shares the stop |
| §3.3 grants, tiers, refused list, floor, lapse | done | `AppGrants`, `AppCategories`, `ConsequentialActionFloor` (English, French, German, Spanish; Return after typing in messaging apps; finance; credential-like text); frontmost-app and hit-test checks before every action; secure fields and Juno windows refused; lapse at stop, deactivate, Plan/Ask, model change, 30 idle minutes. Always allow is never offered (D-021); `ScreenInputRule` keeps the bundle × action-class scope for later |
| §3.3 approval card bound to the frame | done | the tool asks `PermissionCoordinator` itself after the hit test: exact text, marked crop, app, element; digest includes the frame hash; the target's neighbourhood is re-compared before input ("The screen changed; take a new screenshot") |
| §3.4 vocabulary | done | `computer` with the 17 toolset actions; `computer_batch`, `computer_apps`, `computer_ax`, `computer_menu`, `computer_display`; batch stops at the first failure with Anthropic's exact text, also across separate toolset calls of one turn (`ScreenTurnTracker`); hold_key and wait capped at 30 s; settled after-frame and header on every action |
| §3.4 provider wire | done (OpenAI partial) | `JunoCodeBridge/ComputerToolWire.swift`: Opus 5.5, Sonnet 5.5 and Opus 5 get `{"type":"computer_toolset_20260801"}` (no name, no size, all members on, so no `configs`), member calls mapped back to `computer`, `toolset_name` echoed on results; `computer_20251124` never sent. OpenAI uses the function tool with `detail: "original"` on Responses and `high` inside the no-resize box on Chat; OpenAI's native `computer_call` items are not used. Routes without a verified coordinate convention (Gemini, Qwen, others) get no computer tools |
| §3.5 capture, scaling, map-back, zoom | done | `CaptureScaler` (1568 px / 1.15 MP; 2576 px / 4784 tokens with the ⌈w/28⌉×⌈h/28⌉ rule; OpenAI boxes), vImage resampling, PNG for text-heavy frames; window capture via `desktopIndependentWindow`, takeover via `excludingApplications`; `FrameGeometry` maps in global space |
| §3.5 retention (CU-05) | partial | closed by `ImageRetention` as the spec says; screen sessions keep the runtime's default batched budget (20 images / 6 MB) rather than 3 per 25 steps — that is orchestrator configuration (Lane A), and on Opus 5.5 client pruning drops thinking anyway. The proxy forwards `context_management` and `anthropic-beta` untouched (read in `src/app/api/agent/[...path]/route.ts`, `src/lib/agent-proxy.ts`), so server-side clearing can be turned on without web changes |
| §3.6 input | done | Accessibility first in background mode (AXPress, AXShowMenu, AXSelectedText insert, AXValue only with `mode: replace`), events to the pid in background and global only in takeover, layout-aware chords (`KeyboardLayoutMapper`), 16-unit chunks with read-back, key path for mappable characters, move before click, horizontal scroll |
| §3.7 activation, presence, stop | done (two gaps) | tools declared whenever screen control is on for a vision model (CU-15); grant sheet in the approval card; takeover needs its own card; session row (thumbnail, "Juno is using Safari", Take over, Stop); Mac caption under the menu bar, takeover edge glow, menu bar "Stop Juno using apps", start and stop notifications; consumed global Esc (`EmergencyStopTap`); Stop ends the turn; reader input pauses takeover. Gaps: no outline glow around the target window in background mode (the spec's fallback, caption alone), and takeover does not hide other apps |
| §3.8 prompt-injection rules | done | untrusted line on every frame, tree and buffer; app lists DATA ONLY; floor by rule; browsers view-only; secure fields refused, credential text always asks; descriptions carry the ladder and say to stop and tell the reader |
| §3.9 CU-11 | skipped | needs the manual probe below on a signed build holding both grants; denying WindowServer lookups in the sandbox profile would break AppKit and XCTest runs the verify loop depends on, and the disclaim fix belongs in `CommandExecutionService`'s spawn path |
| §3.9 CU-12 | done | `inspect_active_editor` only via the screen provider (never Ask, Plan or sub-agents), needs the editor granted, refuses documents outside the workspace |
| §5.14 Simulator tools | done (evidence revision partial) | `simulator` tool over `SimulatorAgentService` (simctl only, D-024): consent once per device per session, `open_url` follows the mode, screenshots scaled and recorded as `UIVerificationRecord(surface: .ios)`. The record's `workspaceRevision` comes from `ScreenToolServices.workspaceRevision`, which reads 0 until Lane A/B's ledger is wired in. Taps go through `computer` on Simulator.app under a grant. `DesktopSimulatorDock` unchanged |
| Settings › Screen control | done | grants, the CU-20 re-add notice, Apps (lower or deny only, user defaults, never a project file) |

Bug list: CU-01, 02, 03, 04, 06, 07, 08, 09, 10, 12, 13, 14, 15, 16, 17, 18,
19, 21, 22, 24 fixed; CU-05 partial (above); CU-11 skipped (above); CU-20
partial (the re-add guidance; stable signing is the release lane's); CU-23
was already fixed on the trunk (`ToolConflictEffect` names only real tools).

Shared files touched, additively: `SessionController` (contract counts
"turned on", the provider gets `screen.toolServices`, `screen.bind`, the
session title for the lock sentence, CU-21, grants lapse on a model change),
`WorkspaceContext` (adapter init; the computer tools left the shared
registry), `CodeToolProvider` (`screen` field), `PermissionCoordinator` (no
suggested rule for screen tools), `StudioApprovalPrompt` (the screen detail
and copy), `StudioThreadItems` (one step row per call),
`BackendCodeModelClient` (wire calls), `StudioSnapshotTests` (screen
snapshots moved to `StudioScreenSnapshotTests`), the Mac app's
`JunoDesktopApp`, `DesktopMenuBarExtra`, `DesktopCodeWorkspace` (menu label
"Let Juno Use Apps"), `DesktopCodeHost`, `DesktopWorkExecutorAdapter`,
`Info.plist`, entitlements comment, regenerated `project.pbxproj`;
`scripts/native-test.sh`, `.github/workflows/native.yml` and
`scripts/check-code-runtime-wiring.mjs` know the new package and wiring.

For Lane A: the §1.7 workflow text should carry the ladder (structured tools,
Preview, Simulator, then app-scoped screen control); every screen tool's
description already does. For Lane B: wire the ledger's revision into
`ScreenToolServices.workspaceRevision` so iOS evidence counts after edits.

Tests (all with fakes; counts are new or rewritten tests):
- `JunoScreenControlTests` 79: `CaptureScalerTests` 12, `CalibrationTests` 1
  (1512×982, 1728×1117, 3008×1692 at backing scale 2, three budgets, a display
  at a negative origin, every marker within 2 pt), `KeyboardLayoutMapperTests`
  6 (French `cmd+a` → the key that types a, never ⌘Q; Dvorak; unmappable is a
  named error), `KeyChordTests` 5, `InputDriverTests` 8 (200 characters with
  emoji and accents in ordered chunks of ≤ 16 units), `AppGrantPolicyTests` 11,
  `ScreenControlLockTests` 5, `ScreenControlServiceTests` 28 (Terminal never
  typed into, Juno refused and excluded from captures, secure fields,
  prompts in front, the frame binding, Esc ends the turn, a stop mid-action
  sends nothing, takeover pause), `EmergencyStopTapTests` 3.
- JunoCode: `ComputerUseToolsTests` 23 (floor asks in Full access and past an
  allow rule, no Always allow, one card in Ask, read-only refuses, digest bound
  to the frame, batch rule, Stop ends the run, provider declares tools before
  any grant, unverified routes get none, editor gate), `ComputerToolWireTests`
  10, `SimulatorToolsTests` 7, `ComputerUseCoordinatorTests` 9,
  `ComputerUsePermissionProbeTests` +2 (CU-20), `StudioScreenControlTests` +6,
  `InspectEditorBufferToolTests` updated, old `ComputerUseKeyChordTests`
  (US-ANSI) removed.
- JunoWork: `SharedScreenControlTests` 5.
- Snapshots (`JUNO_SNAPSHOT_DIR`, reviewed by eye, light and dark; words only,
  no dots or pills): `testRenderScreenControlRow`, `testRenderScreenGrantSheet`,
  `testRenderScreenApprovalCard` (literal text, marked crop, floor sentence),
  `testRenderScreenStepRows`, `testRenderScreenControlSettings`.

Manual probes (not CI):
1. CU-11: with Juno holding Screen Recording and Accessibility and screen
   control off, in a Full-access session run `screencapture -x
   /tmp/juno-cu11.png` and an Apple Events keystroke through `run_command`.
   Pass: both fail. If they succeed, spawn agent commands with TCC
   responsibility disclaimed in `CommandExecutionService`.
2. Live click test: grant TextEdit, open a document, `computer` left_click on
   a known control and `key cmd+a` on the French layout: selects all, never
   quits.
3. Esc from another app while Juno drives TextEdit: screen control stops in
   under 100 ms and the run ends with "You stopped screen control."

Gates on the branch (through `gate.sh`):

| Command | Result |
|---|---|
| `npm run native:test JunoScreenControl` | pass: 79 XCTests, 0 failures |
| `npm run native:test JunoCode` | pass: 1,350 XCTests (16 skipped) + 78 Swift Testing, 0 failures |
| `npm run native:test JunoWork` | pass: 303 XCTests, 0 failures |
| `xcodebuild -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj -scheme JunoDesktop -configuration Debug -destination 'platform=macOS' -derivedDataPath /private/tmp/juno-rf-dd-code-screen CODE_SIGNING_ALLOWED=NO build` | BUILD SUCCEEDED |
| `node scripts/check-code-runtime-wiring.mjs` (`code:runtime:check`) | pass |
| `xcodegen generate` for JunoDesktop | the only `project.pbxproj` change is `DesktopScreenPresence.swift` |

Risks: the production drivers (ScreenCaptureKit window capture,
Accessibility presses and text, `postToPid` input, the CGEvent tap) are
compiled and wired but untested against the real screen by design; the three
manual probes above are the first real run. Background-mode pointer events
go to the target process, which some apps ignore for windows behind others;
Accessibility presses come first for that reason. A Simulator screenshot's
evidence counts only until the next edit once the ledger revision is wired.

#### Lane C review (adversarial pass, 2026-10-01)

Each DONE claim was traced end to end. These defects were real and are fixed
on `rf/code-screen` (commits after `79e03867`):

- **Esc and Stop did not end the action in flight.** A long `type`, a key
  with `repeat`, a 30-second `hold_key` or `wait` and a drag ran to the end
  after Esc; only the next checkpoint saw the stop. The input driver now
  checks between chunks, repeats, drag steps and 100 ms slices of a held key
  (and releases the key or button), waits sleep in 250 ms slices, and a
  button left down by `left_mouse_down` is released on stop.
- **Floor gaps.** A typed line break is the Return key and now asks in
  messaging apps and on a consequential default button; `hold_key` Return,
  Space on a focused button and ⌘⌫ ask; a key inside a sentence reads as a
  credential. The floor read the hit-tested element only, so a "Send"
  button whose words sit in a child static text (SwiftUI, web) passed: the
  driver now reports the pressable ancestor's words, an element id brings its
  snapshot words, and elements with no frame or outside the window are
  refused. In takeover, keys are judged in the app that has the keyboard.
- **Approved actions were not re-proved for keys.** After the card's wait, a
  focused field that turned secure, or a Return whose default button became
  "Delete", now refuses; in takeover, Juno or a system prompt now in front or
  under the point refuses; `performMenu` must match the card's app and path.
- **Clipboard grant bypass.** Edit › Paste/Copy through `computer_menu`, or a
  click on those items, now need the clipboard grant like ⌘V/⌘C.
- **Unbounded memory.** Frames bound to denied approvals stayed until the
  session ended (each up to ~16 MB decoded); they are discarded on denial
  and capped at four. Open grant proposals are capped at sixteen. The
  service's `discard` had to be `async` to be the protocol witness rather
  than the empty default.
- **Work and Esc.** The Esc tap and the caption ran only for Code sessions;
  they now follow the lock holder, so a Work task stops on Esc too.
- **Settings narrowing ignored after relaunch.** The service started with no
  preferences and only Settings edits pushed them; the coordinator now loads
  them at every start, and a deny or lowered tier applies to live grants.
- **Grant sheet race.** Unticking an app and pressing Allow quickly could
  grant the unticked app; choices are now sent in order from the main actor
  and Allow waits for them.
- **Stop while a card waits.** The card stayed and, answered later, read as a
  declined step; pending screen cards are now answered no when this
  session's screen control ends, and that denial ends the turn.
- **Phones allowing screen actions.** A phone could allow a screen card it
  cannot see; screen cards are now allowed only at the Mac (declining from a
  phone still works).
- **iOS evidence.** A model-written `bundle_id` made any device screenshot a
  check of that app; the record now names an app only if this session
  launched it on that device.
- **System Settings.** "Change permissions" is on the floor, but System
  Settings had full control with a warning only; every press, keystroke,
  drag and menu choice there now always asks.
- **Takeover.** Reader input paused the agent, and every tool then failed at
  once, so the model could call again and again: tools now wait for Resume
  (Stop cancels; 15 minutes ends the turn). Clicking Approve no longer counts
  as taking the Mac back, the approved app is brought back to the front
  before its keys (never sent into Juno), and clicks work with Juno in
  front. Display frames now leave out password managers, security prompts,
  denied apps and finance apps not allowed.
- Smaller: the turn tracker is fed through one ordered stream;
  `computer_batch` follows the cross-call failure rule; the Esc tap's box is
  released on main and its shared flag is locked.

Still partial, unchanged: CU-05 retention budget (Lane A), CU-11 (manual
probe), background-window outline glow and hiding other apps in takeover,
OpenAI's native computer tool, the evidence revision (Lane B).

Gates after the review (through `gate.sh`): `npm run native:test
JunoScreenControl` 108 XCTests pass (79 before; 29 new); `npm run
native:test JunoCode` 1,360 XCTests (15 skipped) + 78 Swift Testing pass;
`npm run native:test JunoWork` 303 pass; the JunoDesktop Debug `xcodebuild`
succeeds; `node scripts/check-code-runtime-wiring.mjs` passes; the screen
snapshots (`StudioScreenSnapshotTests`, `JUNO_SNAPSHOT_DIR`) render.

### Lane E: review, ship, sessions and away (`rf/code-ship`, §6.5)

Branched from the trunk at `e1fde2fa` (the seams merge). Five commits,
`047d9e6e`..`ae36c3d4`, not pushed.

| Spec item | State | Notes |
|---|---|---|
| §1.11 approvals park | DONE | `PermissionCoordinator.sweepExpired` reports and keeps; an approval given later is valid from the decision, digest-bound. Lane A owns the file: the change is the sweep, the post-decision check and an injected clock |
| §1.11 notifications | DONE | `code.done`, `code.needs-approval` (Allow once, Decline), `code.question` (Reply), `code.needs-you` (+ Keep going variant), `code.ci` (Fix it), `code.failed` (Retry). Nothing for the session in view; approvals and questions speak with Juno in front; reminders at 15, 60, 240 min |
| §1.11 menu bar | DONE | "2 working, 1 waiting for you" and Stop Screen Control (stops `computerUse` on every controller until Lane C's service owns it) |
| §1.12 quit guard, Resume | DONE | `applicationShouldTerminate` with Keep Working default; staged update deferred; Resume (row, Runs list, notification) calls `resume(note: .afterQuit(unknownOutcomes:))`; resume-on-launch setting, off (D-025) |
| §5.1 Runs list | DONE | `RunIndex` + `RunTracker` in `WorkbenchModel`, `StudioRunsList`, embedded at the top of the Code sidebar |
| §5.3 PR, CI, auto-fix | PARTIAL | Watch, CI bar, Fix it, Auto-fix (3 per PR), `git_push`/`ci_status`/`ci_logs`, `ci.status` events. Fix it records `goalSet` (origin ci) and resumes with a runtime note; binding the plan to Lane A's goal runtime waits for `GoalModel` |
| §5.6 rewind and fork | PARTIAL | Goal and run journal restored with the conversation (file snapshots per turn), todos with the transcript, shell-change warning, Fork from here / into a worktree, relay fork. Not done: (d) "Summarize from here" |
| §5.7 worktree sessions | DONE | Creation choice existed; `.juno/worktree.json` include and approved-bytes setup, header, Bring changes back per step, removal at archive, Fork into Its Own Worktree from the session menu |
| §5.10 diff review | DONE, one deviation | Click a line to comment (Return adds, ⌘Return sends all), queue saved with the session, sent as `path:line` blocks with the quoted line without touching the draft; Keep (stage the exact hunk) and Revert per hunk, file, all; the four scopes; findings inline with Fix this and Dismiss. The queue rides as a text block on the message rather than a `CodeAttachment.reviewComments` case, which is Lane F's file |
| §5.17 export, archive, search | PARTIAL | Markdown and redacted protocol JSON export, manual archive (with worktree removal), search over titles, PR links and transcripts. Not done: archiving automatically when the PR merges or closes |

Tests (66 new in the package, 5 in the Mac app):
`ApprovalParkingTests` 4, `ShipToolsTests` 8, `CIWatchServiceTests` 5,
`RunIndexTests` 9, `StudioRunMonitorTests` 10, `InterruptedRunTests` 3,
`QuitGuardTests` 4, `SessionForkTests` 5, `RewindGoalStateTests` 3,
`ReviewCommentQueueTests` 6, `WorktreeSessionTests` 3, `ShipSnapshotTests` 6
(rendered with `JUNO_SNAPSHOT_DIR`, reviewed light and dark: Runs list, CI
bar in four states, line comments, inline findings, interrupted row,
Fork from here); `native/macOS/JunoDesktop/Tests/QuitAndLifecycleTests` 5
(compiled by `build-for-testing`, not run: the desktop test host launches
the app). One seam expectation changed: the CI row now puts check names in
code voice. `PermissionCoordinatorTests.testExpirySweep…` now asserts
parking.

Gates (through `gate.sh`): `npm run native:test JunoCode` passed, 1,388
XCTests (19 skipped, 6 of them the snapshots) and 78 Swift Testing, 0
failures; JunoDesktop Debug `xcodebuild … build` succeeded and
`build-for-testing` succeeded (DerivedData `/private/tmp/juno-rf-dd-code-ship`);
`code:runtime:check`, `code:preview:check`, `code:remote:check` pass;
`native:design:check` passes (targets 197 → 192, glass 24 → 19; baselines
not re-recorded).

For integration: `SessionController.reviewComments` / `submitReviewComments`
are superseded by the review queue and unused; the phone still reads an
approval's `expiresAt` as a deadline; `RunTracker` derives a run's ending
from its status until Lane A records `run.outcome`.

#### Lane E adversarial review (2026-10-01)

Six fix commits on `rf/code-ship`, `bf8d6bc3`..`2387b10e`, not pushed.

| Finding | Severity | Fix |
|---|---|---|
| Keep (stage one hunk) built the blob from the command executor's output, which is redacted, capped at 2 MB and decoded per chunk: a `TOKEN_TTL = 3600` line elsewhere in the file was staged as `[redacted]`; large files staged truncated | High (silent corruption of what gets committed) | Both sides read byte-faithfully (disk, and `git checkout-index --prefix` for the index), strict UTF-8, `hash-object --path`; conflicts, symlinks, submodules refused. Also fixed: a CRLF file lost its last line ending (`hasSuffix("\n")` is false for `"\r\n"`) |
| A Runs row's Allow once read whatever approval was pending at click time, not the one the row showed | High (digest binding) | `WorkbenchModel.answer(_:shown:)` answers with the row's own approval and digest |
| Notification Allow once/Decline accepted any approval id + digest, including from a remote push or a banner from an earlier launch; stale Keep going / Retry started runs | Medium | Only approvals this monitor announced in this launch and still waiting; pushes only open; Keep going / Retry only while the row offers them |
| Fix it put the CI log inside the `<juno_runtime>` fence (the model's "Juno said" channel); check names unsanitised | Medium (prompt injection) | Logs read with `ci_logs` (tool output); names cleaned to one short line |
| CI watch polled forever with no checks, a failing `gh`, or a stuck check, and restarted at every launch | Medium | Stops, in words, after 10 empty polls, 10 failed reads, or 300 polls |
| Worktree setup (approved by its bytes) drawn as Markdown; Bring back showed `commit -am` but ran `add -A` + `commit -m` | Medium (approval shows something else) | Setup drawn verbatim (snapshot `worktree-setup`); each step shows its exact command |
| Fork into a worktree from a worktree session started at the project's HEAD | Medium | Starts from the source checkout's commit |
| Archived sessions were reachable from nowhere | Medium | Sidebar "Archived (n)", search reaches them, Unarchive |
| Quit guard's modal cancelled logout/restart; ⌥⌘⎋ (Force Quit) on Stop Screen Control; resume-on-launch resumed every interrupted session ever; `RunTracker.proposed` grew without bound | Low | Power-off quits without asking; shortcut removed; 24 h window; per-session map |

Completed from PARTIAL: §5.17 archive after the pull request merges or
closes (a sweep 15 s after launch, then every 30 min, at most 20 sessions;
working, open or dirty-worktree sessions stay). Still PARTIAL: §5.3 Fix it
is not bound to Lane A's goal runtime (it records `goalSet` and resumes
with a note); §5.6 (d) "Summarize from here" needs a suffix fold in
`ConversationCompactor`/`AgentOrchestrator` (Lane A's files).

Tests added: `ReviewCommentQueueTests.testKeepStagesTheFileAsItIsOnDisk…`,
`StudioRunMonitorTests.testOnlyABannerThisMonitorPostedCanAnswerAnApproval`,
`CIWatchServiceTests.testACheckNameCannotWriteIntoJunosWords` and
`testTheWatchNeverPollsForever`, `SessionForkTests.testAForkOfAWorktreeSession…`,
`WorktreeSessionTests.testASessionWhosePullRequestMergedOrClosed…` and
`testOnlyAGitHubPullRequestLinkIsLookedUp`, `QuitGuardTests.testARestartOrShutdownIsNotAskedAbout`,
`ShipSnapshotTests.testRenderWorktreeSetupLine`, the desktop
`QuitAndLifecycleTests.aRestartWithRunsWorkingQuitsWithoutAsking`; extended
`RunIndexTests` (row binding, stale Keep going / Retry) and the existing
Keep, bring-back and notification-answer tests.

### Lane F: commands, hooks, MCP, agents and composer inputs (`rf/code-extend`, §6.6)

Built on the trunk at `e1fde2fa` (runtime integration and seams), in
`../juno-rf-code-extend`. Shared files were touched only where a seam did not
reach, each change additive and named below.

| Spec item | Status | What landed |
|---|---|---|
| §5.4 slash verbs with real handlers | DONE, four on default routes | `SlashCommands.swift` (sources: project, yours, Claude Code; verbs; aliases), `SlashCommandHandlers.swift` (pure parser + handlers over `SlashCommandHost`), `CommandCenterModel.swift` (library, sheets, confirmation, `/btw`, `/loop`s, routes), `SessionController+Commands.swift` (the host). All 20 verbs: `/goal /verify /review /context /cost (/usage) /compact /rewind /resume /model /init /memory /permissions /agents /mcp /hooks /tasks /fork /loop /export /btw`. `/boost` and `/teamwork-preview` are gone. `/goal`, `/verify`, `/review`, `/fork` run today's behaviour through `SlashCommandRoutes`, which Lanes A, B and E replace without touching the registry: `/goal` sets the goal with no approval card (the reader typed it), asks "Replace the current goal?" over an open one, clears with `clear/stop/off/cancel` (new `CodeSessionStore.clearGoal`, a `goal.status cleared` event); `/verify` runs the detected checks through `run_tests` and its approvals; `/review` sends a turn that delegates to the built-in `reviewer` agent; `/fork` copies the conversation and transcript into a new session. `/loop` without an interval runs at a 10-minute pace until Lane A's `schedule_wakeup` exists. |
| §5.5 context and cost readout | DONE | `/context` sheet (`ContextBreakdown`: per-part estimates scaled by Hamilton's method so the parts sum exactly to the provider-reported total; suggestions in words), `/cost` sheet (`CostBreakdown`: by model with the cache split, the session's own turns apart from sub-agents). The meter shows "$1.12" beside the ring and opens `/context`. Judge and reviewer rows appear when Lanes A and B record that spend. |
| §5.8 user-global MCP, commands, agents, skills | DONE | `~/.juno/mcp.json`, `~/.juno/{commands,agents,skills}`; read-only import of `~/.claude/{commands,agents,skills}` and `~/.claude.json` `mcpServers`, each off until turned on (`~/.juno/imports.json`, `UserExtensionPolicyStore`). Project over yours over Claude Code's, the losers listed. Yours need no workspace trust; project items keep theirs. `ExtensionScope` (Core), `UserExtensions.swift`, `MCPConfigurationLoader.loadAll`, `MCPServerPolicyStore.startupAuthorizer`. |
| §5.9 full hooks protocol | DONE, two events partly wired | 27 events (Claude Code's 25 adopted plus `GoalSet`, `GoalVerdict`); handler types `command`, `http` (POST the stdin JSON, 2xx body read like stdout, no redirects, ephemeral session; a project's may only post to loopback), `prompt` (one tool-less model turn answering `{ok, reason}`; can only block). `mcp_tool` and `agent` are diagnosed. Stdin carries the documented fields per event (`agent_id`/`agent_type`, `last_assistant_message`, `error`, `trigger`, `tool_calls`…); stdout handles `continue`, `stopReason`, `suppressOutput`, `systemMessage`, `decision`, `hookSpecificOutput` (`permissionDecision` with `defer` as ask, `updatedInput`, `additionalContext`, PermissionRequest `decision.behavior`). Exit 2 blocks only where the event can be blocked. Timeouts 600 s command and http, 30 s prompt, 30 s `UserPromptSubmit`. Wired: the seams' PreCompact, PostCompact, PostToolBatch, PostToolUseFailure; StopFailure; PermissionRequest (a block declines, an allow approves nothing) and PermissionDenied; SubagentStart and agent-typed SubagentStop; TaskCreated/TaskCompleted (may refuse a `todo_write`); InstructionsLoaded; FileChanged (Juno's own write tools); PreModelSwitch (may keep the model)/PostModelSwitch; WorktreeCreate/Remove (the reader's isolated worktrees, and since the review a write-capable sub-agent's worktree); GoalSet (`/goal`). Partly: ConfigChange fires for changes made in `/permissions` and `/agents`, not for files edited outside Juno, and it cannot block a change that takes a permission away; GoalVerdict has its adapter call ready for Lane A's judge. |
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

#### Lane F adversarial review (2026-10-01)

Every DONE claim was traced end to end; the safety invariants above hold
and their tests fail without the code they cover. Defects found and fixed on
`rf/code-extend`, each with a test:

- **Background sub-agents were unbounded.** A model could keep calling
  `delegate_task` with `background: true` and start children without end
  (each a model loop with spend, a write one a worktree on disk). Now at most
  4 run at once and 16 per session, reserved all-or-none on the registry
  actor before anything starts (`SubagentTargetTests`
  `testBackgroundChildrenAreBoundedAtOnceAndPerSession`,
  `testReservationsAreAllOrNothing`).
- **A project file could replace the built-in reviewer or verifier.**
  `.juno/agents` is not a policy path, so the agent could write
  `.juno/agents/reviewer.md` unasked in Auto-edit and grade its own work in
  `/review`. A built-in's name is now the built-in's unless the reader's own
  `~/.juno/agents` takes it; the project file shows in `/agents` as not used
  (`UserGlobalConfigTests.aProjectAgentCannotReplaceABuiltInButYoursCan`).
- **A ConfigChange hook could hold permissions open.** It could block the
  reader removing an allow rule or adding a deny rule in `/permissions`. A
  change that takes a permission away now always goes through
  (`ConfigChangeNarrowingTests`).
- **The App Intent could exceed a read-only remote ceiling.** Plan stored
  Ask-before-changes; a goal switches to Code, which runs under the stored
  mode. The stored mode is capped for every behaviour and screen control is
  off (`CodeTaskIntentTests.theStoredConfigurationIsCappedAndWithoutScreenControl`).
- **Paste and drop read whole files into memory**, on the main thread for
  ⌘V, before checking they were pictures; and a copied non-picture file
  attached its Finder icon. Only pictures and PDFs up to 64 MB are read, at
  most 4 files, and a copied file never becomes its icon
  (`ComposerPasteTests` +2).
- An agent's `tools:` list dropped the registry's nested-`AGENTS.md` context
  (`ToolRegistry.restricted(to:)`, `testAnAgentsToolListKeepsTheNestedInstructions`).
- Smaller: prompt-hook spend now reaches the usage ledger (`/cost`); an HTTP
  hook's session is cancelled once its answer is read; `@diff` includes
  staged changes; `~/.claude.json` is read up to 16 MB (it passes 1 MB on a
  busy Mac and dropped every import); a write sub-agent's worktree fires
  `WorktreeCreate`.

Gates after the review (through `gate.sh`): `npm run native:test JunoCode`
passed, 1,373 XCTests (21 skipped, the snapshot tests without
`JUNO_SNAPSHOT_DIR`) and 111 Swift Testing, 0 failures (+5 and +3 over the
lane); the Mac app `xcodebuild … -derivedDataPath /private/tmp/juno-rf-dd-extend
CODE_SIGNING_ALLOWED=NO build` succeeded with no warnings in the touched
files.

Open, for other lanes: the command sandbox does not deny writes to
`~/.juno`, `~/.claude` and `~/.claude.json` (only the reader's own
`writablePaths` could reach them, but `~/.juno/mcp.json` now starts servers
without asking) — Lane B owns the profile; background children outlive the
parent's turn until Lane A's stop check waits on `hasRunning`.
