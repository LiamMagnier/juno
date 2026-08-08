# Juno Native — session report

Date: 2026-08-08 · Europe/Paris

## Outcome

The first production vertical slice is complete: a shared native projection of
Web-equivalent recency/attention semantics, plus native attention rails in the
macOS `JunoDesktop` and iOS/iPadOS `JunoMobile` shells. Selecting an item
resolves the original feature model and opens its native Work, Code, Chat, or
Projects destination. No duplicate activity store, route table, or networking
client was introduced.

This session intentionally starts with the requested “Design System 2.0 + shell
foundation” direction by extending the existing native design system rather
than replacing it. Existing native tokens, materials, typography, Dynamic Type,
reduced-motion behavior, and chat/composer ownership were audited and reused.

## Audited

### Web

- Semantic color, typography, radius/material, and motion sources:
  `src/app/globals.css`, `tailwind.config.ts`, `src/app/layout.tsx`.
- Cross-product activity rules and server merge:
  `src/lib/work/recents.ts`, `src/app/api/recents/route.ts`.
- Chat/composer behavior: `src/components/chat/chat-view.tsx`,
  `src/components/chat/message-list.tsx`, and
  `src/components/chat/composer.tsx`.
- Navigation and source ownership: `src/components/app/app-shell.tsx` and
  `src/components/app/app-sidebar.tsx`.

### Native

- Shared design system: `native/Packages/JunoNativeKit/Sources/JunoDesignSystem`.
- Shared product models/contracts: `JunoCore`, `JunoChatKit`, `JunoWorkKit`,
  and `JunoCodeKit`.
- macOS shell: `native/macOS/JunoDesktop/App`.
- iOS/iPadOS shell: `native/iOS/JunoMobile/App`.
- Canonical Code workbench: `native/Packages/JunoCode/Sources/JunoCodeUI`.

## Existing strengths

- Semantic native tokens already cover coral accent, warm canvas/ink, spacing,
  radii, typography, platform materials, and a motion ladder.
- Glass is already constrained to floating chrome; the transcript/reading
  canvas remains opaque.
- The macOS shell uses native `NavigationSplitView` selection and native
  sidebar behavior. The iOS shell has a compact drawer and an iPad split view.
- Chat, Work, and Code models are already server-backed and lifecycle-owned by
  their shells. The new projection is derived from those models and does not
  create a stale second source of truth.

## Differences found

- Web has one merge vocabulary for chat/work/code/projects; native navigation
  was still split into product-local lists.
- Web explicitly distinguishes attention from running, completed, failed, and
  cancelled. Native shells did not expose a shared attention entry point.
- Research and Artifacts are not yet represented by the shared native recent
  projection.
- The native Code workbench still needs real-data hardening: selected-file-first
  lazy diffs, virtualized large output, structured diagnostics, all active
  tool/approval states, and visible retry/error states.
- Existing docs described an earlier skeleton and did not match the mature
  native code already present in this checkout.

## Implemented

- `JunoRecentActivity.swift`: shared `JunoRecentKind`, filter vocabulary,
  stable pinned/time merge, attention/running/failure rules, bounded per-source
  limits, and filter counts.
- `NativeConversationRecentActivity.swift`, `WorkRecentActivity.swift`, and
  `CodeRecentActivity.swift`: adapters from authoritative models to the shared
  display projection.
- `JunoRecentActivityRow.swift`: compact native row with concrete status copy,
  VoiceOver-combined labels, and caution/error treatment without adding another
  card surface.
- `DesktopChatWorkspace.swift`: macOS “Attention Required” section with native
  Work/Code/Chat/Projects deep links.
- `JunoMobileRootView.swift`: the same attention section in both compact and
  iPad sidebar paths, with destination-aware deep links and drawer dismissal.
- `JunoRecentActivityTests.swift`: stable ordering, attention/running
  disjointness, terminal filtering, bounded source pages, and failed-Code
  attention coverage.

## Verification

The production package checks completed as follows:

- `JunoRecentActivityTests`: 5/5 passed with strict concurrency and warnings as
  errors.
- The full `JunoNativeKit` suite excluding the existing `JunoAuthTests` target:
  passed with exit code 0. The `JunoAuthTests` target was separately attempted,
  but its XCTest process remained idle in an expectation wait for several
  minutes, so it was terminated rather than reported as passing.
- `JunoDesktop` Debug unsigned build: passed after correcting the sidebar
  binding deep-link handler.
- `JunoMobile` generic iOS Simulator unsigned build: passed.
- `git diff --check`: passed.

The exact build/test commands were:

```text
swift test --package-path native/Packages/JunoNativeKit \
  -Xswiftc -warnings-as-errors \
  -Xswiftc -strict-concurrency=complete
xcodebuild -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj \
  -scheme JunoDesktop -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project native/iOS/JunoMobile/JunoMobile.xcodeproj \
  -scheme JunoMobile -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

Unsigned builds prove compilation only; they do not prove Keychain entitlements,
live authentication, production streaming, or device sync. Visual screenshots
and VoiceOver traversal were not available in this session, so those remain
explicit follow-up gates.

## Parity and remaining gaps

The new attention projection is parity-complete for the currently modeled
`chat/work/code/project` sources. It is not a claim that the full native product
mission is complete. Remaining gates include:

- unify a full Recents surface (not only the attention rail) across native
  shells, including Research and Artifacts;
- complete native Chat/Composer functional parity tests for streaming,
  attachments, reconnect, scroll anchoring, and model/effort preferences;
- harden the canonical Code workbench for large diffs/output, diagnostics,
  concurrent activity/approvals, and explicit retries;
- run signed authentication, offline/conflict/convergence, accessibility,
  Dynamic Type/extreme text, Reduce Motion/Transparency, dark/light, and visual
  screenshot matrices on real macOS/iPhone/iPad targets;
- reconcile the historical matrix rows and add native CI/archive/signing gates.

The next vertical slice should be the Code workbench reliability pass, starting
with selected-file-first lazy diff loading and a structured diagnostics model.
