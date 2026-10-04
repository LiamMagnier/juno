# Native Deep Research rework

2026-10-04 · macOS and iOS implementation lane.

## Implemented

The macOS transcript now contains an editorial research cover: actual question/report title in the same Newsreader face as the homepage, the real runtime phase beside the Continuum mark, elapsed working time, a found/read/cited ledger, questions and reported evidence status behind a disclosure, and a clear entry to the existing research controls. The panel preserves the server-controlled tabs while giving every view a shared title/evidence cover. Pause, Resume and Finish now retain their existing API and capability checks; Stop is visible in the control row beneath the evidence ledger and uses the existing cancellation confirmation. Controls no longer compete with the title/status in narrow panel headers. Important warnings remain visible outside the folded activity trail.

Plan and clarification gates use the same editorial hierarchy. Finished receipts and the report reader now show a report cover and citation-check limitations. A missing citation audit is explicitly unavailable. Citation audit `isClean` now requires nonzero claims, all fully supported and no partial, contradicted, unsupported or unchecked claims; partial checks cannot display the clean shield. Source numbering and export retain the existing positional read-source contract.

The iOS research component beside the composer replaces the linear stage rail with the last actual phase, real query when searching, and an expandable evidence ledger with the observed searches and read sources. Source links are usable 44-point targets. Ready-state depth describes the next run; active work has the existing generation Stop action. Unknown found/cited counts are omitted. Historical activity is identified as last activity once generation stops. Degradation and reported warnings remain visible.

`JunoResearchPresence` in the shared design system projects the exact four optical paths and high-resolution master from `src/components/brand/continuum-geometry.ts`. `node scripts/generate-native-research-presence.mjs --check` verifies the projection; the same command without `--check` regenerates it. It does one stationary tone pass on a real phase/event change, delays the first pass 200 ms, coalesces changes within 1.6 seconds, uses shared `JunoMotion.base` and stops on cancellation/disappearance. No clock-driven loop, spinning mark or decorative progress. Reduce Motion stays entirely still. Neutral semantic native tokens handle appearance; accent is confined to active presence.

## Deliberate capability boundaries

- macOS profile-1 research streamed as a chat turn has no background-run pause/resume API; the panel continues to omit those controls. The chat's existing Stop remains the interruption action.
- iOS does not expose background-run plan editing, pause/resume, steering or a worker-management API. No inactive controls were invented. The component is an evidence workspace for the existing streamed research turn.
- Native currently decodes supplied phases, objectives, findings, sources, audit and flat event steps. Structured web worker/convergence events and new native guidance submission need corresponding model/client APIs before being presented as controls.
- The application-wide native logo/identity migration is outside this lane. Research uses the shared Continuum geometry; existing other-run signatures are unchanged.

## Verification

- SwiftPM targeted research checks: **24 passed**, zero failures (13 XCTest projection/report checks + 11 Swift Testing run/clock/audit checks). Includes a regression that partial or unchecked audits cannot claim clean support.
- `node scripts/check-native-motion.mjs`: **passed**, zero new violations.
- `git diff --check`: **passed** at the current native implementation checkpoint.
- macOS Debug app build: **passed**, unsigned compile gate. Latest macOS test action rebuilt the final implementation.
- iOS Simulator Debug app build: **passed**, unsigned compile gate, after the final geometry corrections.
- macOS targeted research/report tests plus render fixtures: **9 passed**, zero failures (5 document/export/citation tests + 4 fixture render tests).
- Ten macOS fixture captures in light/dark were generated and visually inspected: live research cover, narrow 380-point control panel, recap, clarification gate and report reader. Directory: `/tmp/juno-native-research-snapshots`. The live fixture pass caught malformed generated path arrays and narrow-header wrapping; both were corrected and the final render rerun passed.
- Continuum projection check: **passed** for all four optical masters and high-resolution master.
- Authenticated native run controls and iOS runtime layout have not been exercised against the real server. Offscreen macOS fixture rendering is visual evidence for those views, not live API acceptance. These unsigned builds are not signed-release acceptance.

## Changed files

- `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoResearchPresence.swift`
- `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeResearchRun.swift`
- `native/Packages/JunoNativeKit/Tests/JunoChatKitTests/NativeResearchRunStageBTests.swift`
- `native/macOS/JunoDesktop/App/ResearchViews.swift`
- `native/macOS/JunoDesktop/App/ResearchRecapCard.swift`
- `native/macOS/JunoDesktop/App/ResearchReportWindow.swift`
- `native/iOS/JunoMobile/App/JunoMobileResearchProgress.swift`
- `native/iOS/JunoMobile/App/JunoMobileComposer.swift`
- `native/macOS/JunoDesktop/Tests/Snapshots/ResearchStageBSnapshotTests.swift`
- `scripts/generate-native-research-presence.mjs`

Build logs: `/tmp/juno-native-research-macos.log`, `/tmp/juno-native-research-ios-final.log`; test logs: `/tmp/juno-native-research-tests.log`, `/tmp/juno-native-research-desktop-tests-final.log`.
