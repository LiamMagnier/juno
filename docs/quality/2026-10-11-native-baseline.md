# Alevr native quality: 11 October 2026

Inspected and fetched `origin/main`: `58cd3739d283088491fc67be710fb8f1c92e267f`.
It is identical to the historical audit reference. The latest native run is
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

## Evidence established locally

Host: Xcode 27.0 (27A266a), Swift 6.4, Node 24.20.0. CI uses its hosted Xcode,
so a local pass does not establish a CI pass on that toolchain.

- Strict Mac Debug build: passed (warnings as errors, signing disabled).
- Strict generic iOS simulator build: passed (warnings as errors, signing disabled).
- Mac unit tests: 463 passed, 84 skipped, zero failures (547 discovered).
- JunoNativeKit, JunoWork, JunoScreenControl package suites: passed, warnings as errors.
- Nine native design gates: passed. Existing debt remains (type 3, glass 14,
  targets 160, spacing 16 in the first corrected measurement).
- TypeScript and web suite: passed; 6,833 passed, 123 skipped, zero failed.
- Secret/dependency security gate: passed with the repository's existing documented exceptions.
- Disposable local Postgres migration replay: passed; no schema difference detected.

Stable Mac, JunoCode, iOS app tests and hosted CI are tracked separately while their
runs finish. A compiler pass is not a physical-device workflow or accessibility pass.
Snapshot fixtures are illustrative; they never establish real task completion.

## Unresolved mission requirements

Restricted folder execution still needs fail-closed containment: the baseline's
contained factory falls back to an unrestricted executor. Its broad read policy
also needs a dedicated Chat boundary. The Chat result bridge still uses an
in-process registry. No production changes or releases have been made.

Three consecutive release candidates, 27/30 independently verified tasks, real
remote iPhone-to-Mac operation, physical-device voice/accessibility, actual provider
cost comparisons, competitor runs and independent beta feedback are **not established**.
Alevr cannot be recommended overall on this evidence.
