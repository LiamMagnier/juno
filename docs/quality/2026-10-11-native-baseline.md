# Alevr native quality: 11 October 2026

Inspected and fetched `origin/main`: `58cd3739d283088491fc67be710fb8f1c92e267f`.
It is identical to the historical audit reference. The initial inspected native run was
https://github.com/LiamMagnier/juno/actions/runs/38153024427 (failed).
The owner's newer checkout and uncommitted computer-use changes were preserved;
this branch was built in an isolated worktree from the fetched commit.

## Implemented

- Remove ambiguous Swift closure shadowing, optional overloads and raw-buffer inference.
- Correct actor isolation in shared UI tests, and split the voice-outline arithmetic.
- Make the lock-heartbeat test synchronize its clock and wait for a real renewal,
  instead of assuming a 120 ms scheduler delay is sufficient.
- Fix additional strict Swift 6.4 diagnostics uncovered by compiling all tests.
- Restore Dynamic Type, named motion/spacing, opaque approval content and usable targets.
- Recognize NativeTrayMenu's system-drawn entries in the target checker; regression
  tests prove ordinary buttons outside that menu still fail the gate.
- Rebuild the embedded design editor from current sources.
- Align numeric token assertions with the committed CSS/Tailwind values (graphite
  primary, 32–44 pt page titles, compact radii). No baselines were raised. Preserve
  the token identity and numeric checks. Replace terminal and preview color drift
  with shared or system surfaces; derive segmented thumb radius from its inset.
- Read voice interruptions through the supported interruption-reason key, preserving
  decoding of Apple's retired suspension reason without using a deprecated key.
- Build the local execution bundle in the macOS CI job before Stable builds:
  a fresh runner previously had none of the dependencies its prebuild needed.
- Stop the repository-parent search at the filesystem root. Foundation's URL
  parent operation appended repeated `..` after reaching `/`, hanging plain-folder
  hunk acceptance and growing the test process beyond 30 GB. The existing
  plain-folder integration test and a root regression now pass.
- Check concentric minimum radii through rendered pixel assertions, including a
  square control, instead of assuming an unhosted SDK path resolves its layout.
  Hosted CI exposed this test-only assumption; the intended corner check remains.

## Evidence established locally

Host: Xcode 27.0 (27A266a), Swift 6.4, Node 24.20.0. CI uses its hosted Xcode,
so a local pass does not establish a CI pass on that toolchain.

- Strict Mac Debug build: passed (warnings as errors, signing disabled).
- Strict Mac Stable build: passed (warnings as errors, signing disabled).
- Strict generic iOS simulator build: passed (warnings as errors, signing disabled).
- Mac unit tests: 463 passed, 84 skipped, zero failures (547 discovered).
- iOS simulator unit tests: 188 passed, 11 skipped, zero failures (199 discovered).
- JunoNativeKit, JunoWork, JunoScreenControl package suites: passed, warnings as errors.
- JunoCode package: passed, warnings as errors, including plain-folder hunk acceptance.
- Rendered concentric token regression suite: 27 passed, zero failures.
- Mac folder/pairing and iOS remote/pairing snapshot suites passed; iOS ran 27 tests.
  Visual inspection included the Mac folder composer and small iPhone accessibility
  composer. Its cramped diff-summary labels were subsequently repaired and
  visually rechecked as described below; overall accessibility acceptance is pending.
- Nine native design gates: passed. Existing debt remains (type 3, glass 14,
  targets 160, spacing 16 in the first corrected measurement).
- TypeScript and web suite: passed; 6,833 passed, 123 skipped, zero failed.
- Secret/dependency security gate: passed with the repository's existing documented exceptions.
- Disposable local Postgres migration replay: passed; no schema difference detected.

Hosted run 38157784416 passed contract, design and web-parity gates, but initially
failed the unhosted concentric-path assertion; the rendered regression corrects it.
Full hosted native acceptance remains pending. A compiler pass is not a
physical-device workflow or accessibility pass.
Snapshot fixtures are illustrative; they never establish real task completion.

## Subsequent strict and hosted corrections

Hosted run 38161281671 passed NativeKit, Work, ScreenControl, design, contract and
web-parity checks, but failed Code at `testStopDuringABackoffEndsTheRunPromptly`
with `freed pointer was not the last allocation`. It also failed Mac compilation
at the large conversation view's inline voice-alert binding. These failures remain
recorded; no real failure is retried or counted as passing.

The Code failure's signature and public async default closure match the reported
[Swift context-layout issue](https://github.com/swiftlang/swift/issues/92017).
This is a diagnosis from the signature and call site, not a recovered crash stack.
The default sleep closure now lives in the runtime module and uses ContinuousClock.
Eighteen strict retry tests passed locally, including a second client file that
exercises the real sleep deadline and cancellation. Hosted confirmation is pending.
The voice-alert binding is a separately typed property; strict Mac Debug passed.

The first exact-source development candidate failed strict iOS test compilation
at a deprecated UIWindow initializer. The test now uses the host's window scene.
Main-actor test helpers use isolated classes and async XCTest setup/teardown.
The strict iOS unit suite passed: 188 passed, 11 skipped, zero failures; UI test
targets also compiled. This is simulator evidence, not physical UI automation.
Both hosted app test commands now explicitly enforce warnings as errors.

The iPhone diff summary uses a second line when large text cannot fit one row.
The existing composer snapshot test passed and produced eight images at SE,
standard and Pro Max sizes in light/dark, including SE accessibility text. Visual
inspection confirms the file count, additions/deletions and Review label fit.
Nine design gates still pass without raised baselines.

Logs: `/tmp/alevr-quality-evidence/swift-retry-fix.log`,
`macos-compat-fix.log`, `ios-strict-test-fix.log`, `ios-layout-fixed.log`,
`native-design-latest.log`; images in `ios-layout-fixed/`.

The next hosted run (38162706883) passed the orchestrator backoff cancellation
regression, then exposed the same async-default issue in ModelTurnCollector.
That sleep default now also lives inside the runtime module. The Mac's large
conversation modifier chain is split into three typed view properties because
the older compiler still timed out after the binding extraction; strict local
Mac Debug compilation passed. A separate terminal test exposed first-prompt
delivery before the open response had supplied its id. Standalone terminals now
retain bounded opening events, matching the hub's existing handling, and the
test forces events before the response. None of these failures was bypassed.

## Unresolved mission requirements

At the inspected main baseline, restricted folder execution fell back to an
unrestricted executor and Chat results used an in-process registry. Separate
stacked PRs 84 and 85 implement containment and durable result receipts; this native
PR does not include those changes. No production changes or releases have been made.

Three consecutive release candidates, 27/30 independently verified tasks, real
remote iPhone-to-Mac operation, physical-device voice/accessibility, actual provider
cost comparisons, competitor runs and independent beta feedback are **not established**.
Alevr cannot be recommended overall on this evidence.
