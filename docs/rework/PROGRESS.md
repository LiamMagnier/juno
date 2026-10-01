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
