# Juno Code macOS — Integration Handoff

Updated: 2026-07-22 (Europe/Paris)
Branch: `agent/juno-code-macos` (base `9bceb7e`, 15 commits, tip `bd09427`)
Author track: Juno Code rebuild (parallel to the Codex track; zero overlap by construction).

## What this branch delivers

A standalone, fully native Juno Code environment for macOS, built from zero in
the new architecture. Nothing from the legacy `juno-app` monolith was ported.

- **`native/Packages/JunoCode`** — a new Swift 6 package, 166 tests green with
  `-warnings-as-errors`, five products:
  - `JunoCodeCore` — session/event/permission models shared by Local, Cloud and
    Remote presentations; validated workspace-relative paths; canonical
    JSONValue with digest encoding; shell-aware command classifier (forbidden /
    critical / execute tiers); secret redactor; UTF-8-safe output limits; pure
    Myers diff engine with hunks and gutters; exact text patches that fail
    closed on ambiguity; service protocols (files, index, commands, git,
    tests, checkpoints, computer-use driver).
  - `JunoCodeLocal` — bookmark-backed `WorkspaceAccess` with canonical
    containment and symlink-escape rejection on every resolution; atomic
    `FileOperationService` with fingerprint conflict detection and per-mutation
    checkpoints; disk-backed `CheckpointStore` with divergence-checked undo;
    `CommandExecutionService` (scrubbed minimal env, streamed bounded output,
    timeout, process-group SIGTERM→SIGKILL, redaction); `WorkspaceIndexService`
    (glob/grep/gitignore, cancellation, caps); `GitService` (non-destructive
    operations only, strict quoting); `TestRunnerService` + parsers for
    XCTest/Swift Testing/Jest/pytest/cargo; `ComputerUseCoordinator` (consent +
    TCC gated, rate-limited, journaled, kill switch; system driver fails closed
    until ScreenCaptureKit/CGEvent lands).
  - `JunoCodeRuntime` — 16-tool `ToolRegistry` with JSON-schema validation and
    per-input risk assessment; `PermissionCoordinator` actor whose approvals
    truly suspend the tool on a continuation, bind a SHA-256 action digest with
    expiry, and fail closed on deny-all/expiry; `AgentOrchestrator` (streamed
    model turns over the injectable `AgentModelClient` protocol, iteration cap,
    one transient retry, stop that denies pending approvals, denial feedback to
    the model); `CodeSessionStore` (JSONL transcript, exact conversation
    persistence for resume, interrupted sessions restore as failed).
  - `JunoCodeUI` — the three-zone SwiftUI workbench (sidebar / agent canvas /
    inspector with Changes, Diff, Terminal, Tests, Git, Files, Context,
    Computer tabs), graphite/terracotta theme, keyboard shortcuts, VoiceOver
    labels; `WorkspaceDirectory` persisting bookmark grants; MainActor
    observable models bridging the actor runtime.
  - `JunoCodeBridge` — the only seam to `JunoNativeKit`: adapters to
    `CodeExecutionLocation`, `CodePermissionMode`, `WorkspaceRelativePath`,
    `CodeApprovalRequest` and `CodeTaskConfiguration`.
- **`native/macOS/JunoCode`** — a standalone XcodeGen app project (Debug/
  Stable/Next via new `native/Config/JunoCode-*.xcconfig` files) whose
  composition root wires the workbench. Local vertical slice works end to end:
  pick workspace → create session → prompt → read → patch (approval suspends,
  approve/deny both resume) → diff → run test → stop/finish, with checkpoints
  and undo.

## Verification record

- `swift test` on `native/Packages/JunoCode` with `-warnings-as-errors`:
  **166/166** (Core 68, Local 56, Runtime 30, UI 7, Bridge 5).
- `xcodebuild` JunoCode app: Debug **green**, Stable **green**, unit test green
  (`CODE_SIGNING_ALLOWED=NO`, unsigned).
- JunoMac Debug build re-verified **green** (untouched).
- `npm run native:contract:check`: **canonical digest matches** (contract
  untouched).
- JunoNativeKit package: 61 non-auth tests re-run green; the auth suite was
  skipped in this headless session because `KeychainAuthTokenStoreTests`
  requires the interactive user keychain (pre-existing constraint, none of its
  files changed).
- `git diff 9bceb7e..HEAD` touches **nothing** under
  `native/Packages/JunoNativeKit`, `native/macOS/JunoMac`, `native/iOS`,
  `src`, `prisma`, or `contracts`.

## Not implemented yet (by design)

- **Model transport**: `AgentModelClient` is a protocol; the app composes
  `UnconfiguredModelClient`, which fails with a "sign in to Juno" message.
  No mock path exists.
- **Cloud/Remote sessions**: the event model and bridge are ready; no backend
  routes exist yet in `contracts/openapi/juno-native-v1.yaml` for Code
  sessions (see "Backend needs" below). The new-session sheet shows both modes
  disabled.
- **Computer Use driver**: the ScreenCaptureKit/CGEvent driver intentionally
  fails closed; the coordinator envelope and its tests are done.
- Markdown rendering in the transcript is plain-text-first; no editor pane
  (Juno Code is agent-first, not an editor).
- App icon assets, localization catalogs (FR), signing/notarization.

## Integration points for the Codex track

1. **Authenticated model turns** (the one required raccord): implement
   `JunoCodeRuntime.AgentModelClient` with the refresh-aware bearer transport
   (`JunoAuth`/`JunoSync` composition) and inject it in
   `native/macOS/JunoCode/App/JunoCodeApp.swift` (replace
   `UnconfiguredModelClient`). The protocol is 1 method:
   `streamTurn(ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error>`
   with `textDelta` / `reasoningSummary` / `toolCallRequested` / `turnCompleted`.
2. **Model manifest**: replace the placeholder `availableModels` array in the
   same file with the bootstrap model manifest.
3. **Session sync (optional, later)**: `CodeSessionStore` events are
   append-only with strict sequences and Codable payloads
   (`SessionEventPayload`), designed to map onto the change-feed/entities
   model; `JunoCodeBridge` maps configurations onto `CodeTaskConfiguration`.
4. **Shell embedding (optional)**: `WorkbenchView(model:)` is a plain SwiftUI
   view; JunoMac could host it in a "Code" section with the same injection,
   or keep the standalone app.

### Backend needs (documented only; no backend change in this branch)

Cloud/Remote Code needs contract routes for: creating a Code session, ordered
resumable session events, idempotent commands (prompt/approve/deny/stop), and
Remote Host addressing by opaque workspace ID. The local event model in
`JunoCodeCore.SessionEventPayload` was shaped so those payloads can be mapped
1:1 when the routes land.

## Merge guidance

- Files unique to this branch: everything under `native/Packages/JunoCode/`,
  `native/macOS/JunoCode/`, `native/Config/JunoCode-*.xcconfig`, and this
  document. No file edited by both tracks is touched, so merging into
  `agent/juno-native` should be conflict-free.
- Only plausible conflict: if the Codex track also adds *new entries* next to
  these paths (e.g. another doc referencing the same directories) — trivial
  union merges.
- Strategy: merge (or cherry-pick in commit order `6db47de..bd09427`; every
  commit builds and tests green independently per layer). Do not rebase across
  the Codex track's package edits; none are needed.

## Running Juno Code macOS

```bash
cd native/Packages/JunoCode && swift test        # package suite
xcodegen generate --spec native/macOS/JunoCode/project.yml   # only if project.yml changes
xcodebuild -project native/macOS/JunoCode/JunoCode.xcodeproj \
  -scheme JunoCode -configuration Debug -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO build
open <derived-data>/Build/Products/Debug/Juno\ Code.app
```

In the app: Open Workspace… (⇧⌘O) → New Code Session (⌘N) → prompt (⌘⏎).
Until the model transport is composed, runs fail with the explicit
"No model transport is configured" error; every workspace/inspector feature
(files, grep, git, tests, terminal, diff/checkpoint review) is fully live.
