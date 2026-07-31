# Juno for macOS — Architecture V2

Date: 2026-07-26  
Status: greenfield implementation

This document describes only the new application created from the current
repository state. Historical or deleted macOS implementations are not inputs.

## Target

- Product: Juno
- Target and Swift module: `JunoDesktop`
- Location: `native/macOS/JunoDesktop`
- Minimum deployment: macOS 26
  (raised from 15 on 2026-07-26. Liquid Glass ships in macOS 26, so at a floor of
  15 every `glassEffect` call in the design system resolved to a material
  fallback — the app claimed Liquid Glass and shipped none of it. The `JunoCode`
  package floor was raised to match so the Code workbench gets it too.)
- UI: SwiftUI, with AppKit bridges only for capabilities SwiftUI does not expose
- Project generation: XcodeGen from a checked-in `project.yml`

`JunoDesktop` is a thin native application and presentation layer. Domain,
transport, storage, synchronization, and agent runtime behavior live in current
shared packages.

## Composition

```text
JunoDesktopApp
  └─ JunoDesktopConfiguration
      ├─ NativeAuthModel
      ├─ NativeSyncModel + encrypted SQLite + durable outbox
      ├─ NativeConversationModel + Chat feature models
      ├─ Projects / Library / Artifacts / Memory / Search
      ├─ Connections / Tasks
      ├─ Local Code WorkbenchModel
      ├─ Cloud and device NativeCodeModel
      └─ CodeRemoteBrowserModel
```

The composition root owns process-lifetime dependencies. Account-bound models
start only after a validated `NativeAuthenticatedSession` arrives. Sign-out
stops every monitor, stream, task, and microphone/capture session before local
credentials disappear.

## Navigation and scenes

- One primary `WindowGroup` opens in Chat.
- Chat and Code are first-class product modes, restored with `SceneStorage`.
- Each product owns one `NavigationSplitView` shell with a resizable navigation
  column (`.junoSidebarColumn()`, 208–380pt) and a real window `.toolbar`.

  **This reverses an earlier decision, because that decision rested on a
  misdiagnosis.** The previous revision of this document stated that
  `NavigationSplitView` and `.inspector` were "deliberately absent … because
  mixing those two split-view owners caused an `NSGenericException` constraint
  loop on macOS 27", and the shell was a hand-rolled `HStack` with a fixed-width
  column and a 1pt `Rectangle` divider. The cost of that was the entire native
  layer: no sidebar collapse, no column resizing, no vibrancy (the column painted
  an opaque fill, the exact failure `JunoSurfaces.swift` documents), no unified
  titlebar, and selection drawn by hand instead of by `List(selection:)`.

  The constraint loop was caused by a **self-sizing popover** and by
  `ToolbarItem`s that appeared and disappeared with state — both of which rebuild
  the AppKit toolbar or split-view geometry underneath a live window. With
  popovers carrying an explicit `.frame` and every toolbar item present-and-
  `.disabled()` rather than conditional, `NavigationSplitView` is stable: verified
  on macOS 27.0 (build 26A5388g) through repeated sidebar toggles with the
  full-width model selector held open over the live split view, with no crash and
  no crash report, and with the accessibility tree confirming a real AppKit
  `splitter group`.

  The two rules that replaced the workaround are therefore load-bearing and must
  not be relaxed:
  1. Every anchored popover declares an explicit `.frame`.
  2. Toolbar items are always present and disable rather than vanish.
- Chat owns its conversation/destination rail and transcript. Code owns a
  274-point studio rail with exactly three primary destinations: Start, Runs,
  and Continue.
- Code's Start launchpad places execution target, workspace/repository/device,
  model, reasoning, role, behavior, and permission controls beside the prompt
  they configure. They are not global toolbar state.
- Ask, Plan, and Code are runtime behaviors rather than cosmetic labels. Ask
  and Plan construct an inspection-only tool registry and enforce read-only
  permissions; Code receives the mutation and delegation tools.
- Local Code work uses the shared `WorkbenchView` without its standalone
  sidebar. Its transcript and optional 320-point inspector are explicit stable
  panes inside the studio, so the desktop app never renders duplicate rails.
- Search, Settings, Library, Projects, Artifacts, Connections, and Tasks remain
  authenticated product destinations. Code review data remains in the Code
  inspector instead of an unrelated window.

## Feature boundaries

- `Application`: lifecycle, composition, commands, restoration.
- `Authentication`: browser presentation and sign-in gate.
- `Navigation`: product mode, sidebar destination, selection routing.
- `Chat`: conversation list, transcript, composer, model/reasoning, sources.
- `Projects`, `Library`, `Artifacts`, `Search`, `Connections`, `Tasks`,
  `Settings`: desktop presentation over shared models.
- `Code`: local workbench plus cloud/device/remote session browsers.
- `Diagnostics`: non-secret build, contract, sync, auth, storage, and runtime
  health.
- `Design`: desktop-only reusable controls over `JunoDesignSystem`.

Views stay small. Stateful operations live in `@Observable` models, actors, and
shared services. AppKit objects are isolated behind narrow adapters.

## Code transport and editing

- The account catalog keeps canonical identifiers such as
  `anthropic:claude-sonnet-5`. `CodeModelProviderResolver` removes the provider
  prefix only at the backend boundary and chooses Anthropic Messages, OpenAI
  Chat Completions, or OpenAI Responses for the selected provider/model.
- Streaming adapters normalize text, reasoning summaries, tool calls, usage,
  and completion into the shared local agent event model. Provider-specific
  SSE fragments do not leak into the workbench.
- The local model selector is capability-filtered. A model is not offered for a
  local run unless the bridge has a real wire protocol for it.
- Files opened manually are workspace-contained, UTF-8, and bounded to 2 MB.
  Explicit saves are Code-only and use the existing atomic file operation
  service with a captured fingerprint, a persistent checkpoint, and a
  concurrent-modification failure instead of silent overwrite.
- Unified and side-by-side diff layouts are two projections of the same
  immutable review snapshot. They never invent an accepted state.
- Per-hunk Keep uses a deterministic content-derived review identifier.
  Per-hunk Revert validates that the currently loaded lines still match the
  rendered hunk, then uses the file service's fingerprint check, atomic write,
  and checkpoint. Remaining old-to-current diff statistics are recomputed
  instead of accumulating the inverse mutation as extra changed lines.
- Git publication is intentionally absent from the agent-facing
  `GitServicing` protocol. The reader-owned inspector resolves a `GitPushPlan`,
  shows the exact local and remote refs, re-resolves it after confirmation, and
  runs only a non-force push. A changed branch/upstream invalidates the plan.
- Pull-request and CI status are read-only projections loaded with `gh pr view`
  and `gh pr checks`. They use the scrubbed command environment and existing
  CLI/Keychain authentication; no GitHub credential is copied into Juno.

## Security boundaries

- Access/refresh credentials and the database key remain in Keychain.
- Account records remain encrypted in the existing SQLite repository.
- Bearer authentication is authoritative; web cookies are not native
  credentials.
- Workspaces enter through user-selected security-scoped bookmarks.
- Local tools remain rooted to a validated workspace and pass through the
  existing permission coordinator.
- Remote Host is off by default and visible while active.
- Computer Use requires explicit consent plus Screen Recording and
  Accessibility permission; emergency stop is always reachable.
- Web previews use a nonpersistent `WKWebsiteDataStore` and navigate only after
  explicit reader input. Computer Use permission badges and capture state are
  sourced from the coordinator snapshot rather than UI-local booleans.
- HTML/SVG artifacts use the existing ephemeral WKWebView sandbox policy.
- No provider, connector, storage, Stripe, or signing secret enters the binary.

## Design

- Warm paper and warm charcoal semantic canvases come from
  `JunoDesignSystem`.
- Coral is emphasis/state, not furniture.
- System typography serves dense controls; Newsreader is restricted to
  expressive display roles; monospaced text is used for code and technical
  metadata.
- Reading, code, terminal, diff, and file surfaces are opaque.
- Native toolbar/sidebar/inspector/sheet/popover appearance is accepted from the
  platform. Custom glass is limited to the composer and small transient control
  clusters.
- Chat uses the iPhone composer's compact vertical hierarchy. Its fixed-size
  native model selector follows the website's provider/catalog/detail
  structure and renders the same provider image assets as the website/iPhone
  catalog.
- Reduce Motion, Reduce Transparency, Increase Contrast, keyboard navigation,
  and VoiceOver are first-class states.

## Crash boundaries

- Desktop split panes use one layout owner and fixed explicit geometry; no
  AppKit split-view bridge is nested inside another.
- Speech authorization crosses the TCC callback through a `nonisolated`
  continuation helper. The callback is invoked on a TCC worker queue and must
  not inherit the `@MainActor` executor assertion from `JunoSpeechService`.
