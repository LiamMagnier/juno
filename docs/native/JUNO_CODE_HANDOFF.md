# Juno Code macOS — Integration Handoff

Updated: 2026-08-06 (Europe/Paris)
Branch: `agent/juno-code-macos`, rebased on `agent/juno-native` (which includes
Codex commit `6e20050`, the real Juno chat transport).
Author track: Juno Code rebuild (parallel to the Codex track; zero overlap by construction).

## Final integration status

The model transport is now wired to the real backend. `BackendCodeModelClient`
(in `JunoCodeBridge`) implements `AgentModelClient` over the existing
refresh-aware bearer transport (`NativeAuthRuntime` /
`NativeAuthenticatedByteStreaming`) and the existing authenticated agent proxy
`/api/agent/anthropic/v1/messages` — **no new authentication and no new backend
route**. Juno Code is composed into the main `JunoMac` app behind the existing
`.code` navigation section (`JunoMacCodeView`), building the workbench for the
signed-in account and loading the live model manifest from `/api/v1/models`.
The standalone `JunoCode` app is retained for isolated testing.

The full local vertical slice is validated end to end against the real model
client (over replayed real Anthropic SSE, since interactive browser sign-in
cannot run headless): instruction → model turns → `read_file` → `apply_patch`
(real on-disk mutation) → `run_command` (streamed output) → completion, plus
approval genuinely suspending a model-driven tool call, and network
drop/persistent-failure ending the session cleanly with no false success and no
partial mutation.

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
    TCC gated, rate-limited, journaled, kill switch, and the ScreenCaptureKit/
    CGEvent system driver).
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
  - `JunoCodeBridge` — the seam to `JunoNativeKit`: `BackendCodeModelClient`
    (the real model transport over the authenticated agent proxy), plus
    adapters to `CodeExecutionLocation`, `CodePermissionMode`,
    `WorkspaceRelativePath`, `CodeApprovalRequest` and `CodeTaskConfiguration`.
- **`native/macOS/JunoMac`** — Juno Code is composed into the main app behind
  the `.code` section (`JunoMacCodeView`), wired to the real backend model
  client for the signed-in account.
- **`native/macOS/JunoCode`** — a standalone XcodeGen app project (Debug/
  Stable/Next via new `native/Config/JunoCode-*.xcconfig` files) retained for
  isolated testing; its composition root uses `UnconfiguredModelClient`.

## Verification record

- `swift test` on `native/Packages/JunoCode` with `-warnings-as-errors`:
  **179/179** (Core 68, Local 56, Runtime 30, UI 7, Bridge 18 incl. real
  model-client + end-to-end integration).
- `xcodebuild` **JunoMac** Debug **green**, Stable **green**; JunoMac unit test
  bundle **green** (2/2). The JunoMac UITests runner cannot bootstrap in this
  headless, unsigned session (pre-existing environment limitation, unrelated to
  Code — the Code UI lives behind the browser sign-in gate).
- `xcodebuild` standalone JunoCode app: Debug **green**.
- JunoNativeKit package: **84** non-auth tests re-run green (includes Codex's
  new chat suite); the auth suite is skipped headless because
  `KeychainAuthTokenStoreTests` needs the interactive user keychain
  (pre-existing constraint, none of its files changed).
- `git diff agent/juno-native..HEAD` touches **nothing** under
  `native/Packages/JunoNativeKit`, `native/iOS`, `src`, `prisma`, or
  `contracts`.

## Current production limitations

- **Signed distribution**: Developer ID signing, notarization, App Store
  provisioning, and the clean/tagged release run still require the owner's
  Apple and GitHub credentials. Unsigned Debug/Stable builds are verification
  artifacts, not shippable downloads.
- **Visual QA**: source-level and preview-harness checks are green, but an
  exhaustive signed-app matrix across window sizes, light/dark appearances,
  VoiceOver, and real TCC prompts still needs to be run on a machine that can
  launch the authenticated UI.
- **Mobile Remote presentation**: the shared Cloud/Remote transport and the
  macOS host/control surfaces are implemented; a dedicated iPhone/iPad Remote
  browser remains a later UI surface.
- The local transcript is agent-first rather than a full IDE editor. Review,
  file editing, diff hunks, terminal, Git, tests, preview and Quick Look cover
  the workflow without embedding a second IDE.

## Integration points (status)

1. **Authenticated model turns** — DONE. `BackendCodeModelClient`
   (`JunoCodeBridge`) implements `AgentModelClient` over the bearer transport
   and the `/api/agent/anthropic/v1/messages` proxy, injected in
   `JunoMacCodeView`.
2. **Model manifest** — DONE. `JunoMacCodeView` loads `/api/v1/models` via
   `NativeChatAPIClient` and populates the composer (Claude models; static
   fallback offline).
3. **Provider routing** — DONE for the current catalog: Anthropic Messages,
   OpenAI Chat Completions, OpenAI Responses/Codex-style models, and the
   configured OpenAI-compatible providers route through the authenticated
   backend proxy. Unsupported catalog entries are filtered rather than offered
   as a control-calling model.
4. **Session sync (optional, later)** — `CodeSessionStore` events are
   append-only with strict sequences and Codable payloads
   (`SessionEventPayload`), designed to map onto the change-feed/entities
   model; `JunoCodeBridge` maps configurations onto `CodeTaskConfiguration`.
5. **Cloud/Remote Code (optional, later)** — needs the backend routes below.

### Backend needs (documented only; no backend change in this branch)

Cloud/Remote Code needs contract routes for: creating a Code session, ordered
resumable session events, idempotent commands (prompt/approve/deny/stop), and
Remote Host addressing by opaque workspace ID. The local event model in
`JunoCodeCore.SessionEventPayload` was shaped so those payloads can be mapped
1:1 when the routes land.

## Merge guidance

This branch is rebased on `agent/juno-native`; the Juno Code integration commits
sit on top and touch only Code files plus the additive `JunoMac` wiring
(`JunoMacApp`, `JunoMacRootView`, new `JunoMacCodeView`, `project.yml`). No
JunoNativeKit, backend, iOS, prisma, or contract file is modified. Open the PR
against `agent/juno-native`; it should merge cleanly.

## Running Juno Code macOS

Inside the main app (real model transport):

```bash
xcodegen generate --spec native/macOS/JunoMac/project.yml
xcodebuild -project native/macOS/JunoMac/JunoMac.xcodeproj \
  -scheme JunoMac -configuration Debug -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO build
```

Launch, sign in to Juno, open the **Code** section (⌘8): Open Workspace… →
New Code Session → prompt. Model turns run through the authenticated backend
agent proxy.

Package suite and the standalone test app:

```bash
swift test --package-path native/Packages/JunoCode
xcodebuild -project native/macOS/JunoCode/JunoCode.xcodeproj \
  -scheme JunoCode -configuration Debug -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO build
```
