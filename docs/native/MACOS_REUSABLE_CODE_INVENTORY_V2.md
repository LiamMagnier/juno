# Juno for macOS — Reusable Code Inventory V2

Date: 2026-07-26  
Branch: `main`  
Starting commit: `3f7d0f4`  
Live checkout: `/Users/liammagnier/Desktop/workspace/juno`

This inventory was produced from the repository state after the previous macOS
applications were deleted. Deleted macOS sources, deleted tests, Git history,
and historical Mac implementation details were not inspected or used.

## Safely reusable shared code

The following code is platform-neutral, current, covered by package tests, and
must remain the only implementation of its responsibility.

| Area | Current source | Reuse decision |
| --- | --- | --- |
| API origin, request validation, HTTP/SSE transports, generated contract | `JunoCore`, `JunoAPI` | Reuse directly. Do not create a desktop HTTP stack. |
| PKCE device authorization, rotating bearer credentials, Keychain token storage | `JunoAuth` | Reuse directly. Add only a macOS `ASWebAuthenticationSession` presentation adapter. |
| Encrypted account-scoped SQLite and database-key Keychain storage | `JunoStorage`, `NativeLocalAccountStoreFactory` | Reuse directly. Use one desktop database under Application Support. |
| Bootstrap, entity inventory/hydration, cursor feed, SSE wakeups, outbox | `JunoSync` | Reuse directly. One coordinator per signed-in account. |
| Conversations, messages, model catalog, streaming, cancellation, retry, private chat | `JunoChatKit` | Reuse model and transport layers. Build new desktop presentation. |
| Projects, uploads, Library, artifacts, memory, settings, search | `JunoChatKit` | Reuse stores/models. Signed URLs remain ephemeral. |
| Connections and scheduled tasks | `NativeConnectorModel`, `NativeScheduledTaskModel` | Reuse live server-backed models. Build macOS-native lists, sheets, and browser handoff. |
| Brand mark, semantic palette, spacing, radii, typography, Markdown | `JunoDesignSystem` | Reuse as the only token system. Bundle current assets/fonts in the new target. |
| Local agent domain, permission engine, tools, persistence, typed events | `JunoCodeCore`, `JunoCodeLocal`, `JunoCodeRuntime` | Reuse directly. |
| Local Code workbench and inspector | `JunoCodeUI` | Integrate as a package view and extend only through public composition seams. |
| Backend model proxy bridge | `JunoCodeBridge.BackendCodeModelClient` | Reuse. Provider credentials remain server-side. |
| Cloud/device tasks and remote relay contracts | `JunoCodeKit` | Reuse typed clients and models. |
| Realtime voice protocol and controller | `JunoVoiceKit` | Reuse protocol/controller; desktop capture and audio presentation remain macOS work. |

## iOS-specific code that requires extraction or a new adapter

The iPhone views are product-behavior references, not desktop layouts.

- `JunoMobileApp` proves the current dependency graph and account lifecycle.
  The new desktop composition will assemble the same shared services without
  importing or embedding the iPhone app.
- `JunoMobileWebAuthenticationClient` proves the current AuthenticationServices
  callback behavior. A fresh AppKit presentation-context adapter is required.
- Attachment picking, dictation, camera, photo-library access, share sheets, and
  Quick Look presentation require desktop-specific adapters around shared
  attachment/library models.
- Connections currently open the website flow from the iPhone. macOS needs an
  explicit browser handoff and must refresh server state on return.
- Voice capture and playback use iOS presentation and audio-session behavior.
  macOS needs an AVFoundation/Core Audio adapter and visible permission state.
- Mobile navigation, drawers, sheets, tab overflow, compact composer layout,
  and UIKit bridges must not be reused as desktop views.

## Juno Code infrastructure that can be integrated

- `WorkbenchModel` owns registered workspaces, security-scoped bookmarks,
  sessions, selection, and controller creation.
- `WorkbenchView` already provides a native `NavigationSplitView`, session
  sidebar, transcript, native inspector, files, changes, diffs, terminal, tests,
  Git, preview, context, Computer Use, approvals, and keyboard actions.
- `BackendCodeModelClient` sends authenticated model traffic through the
  existing `/api/agent` proxy.
- `NativeCodeModel` provides cloud and device task creation, repository/device
  selection, ordered events, approvals, cancellation, and PR URLs.
- `NativeCodeRemoteClient` provides idempotent commands, cursor-resumable
  events, host polling, and acknowledgements.
- `CodeRemoteHost` provides an explicit opt-in host loop. It intentionally
  requires an executor adapter to the local runtime.

## Missing macOS-specific infrastructure

1. A completely new application target, module, resources, tests, schemes, and
   configurations.
2. Desktop lifecycle and dependency composition that rebuilds account-bound
   services on sign-in and tears them down on sign-out.
3. A fresh desktop navigation model with Chat and Code product modes,
   restoration, commands, multiple windows, inspectors, focus, and drag/drop.
4. macOS Chat presentation: sidebar, transcript, composer, thought/source
   disclosure, attachment import, Quick Look, artifact canvas, and native
   accessibility behavior.
5. macOS product screens for Projects, Library, Artifacts, Search, Connections,
   Tasks, Settings, diagnostics, and device management.
6. A macOS local-Code composition that binds the authenticated account/model
   transport to `WorkbenchModel`.
7. An explicit Remote Host adapter that maps relay commands onto existing local
   session capabilities without bypassing permission checks.
8. Worktree creation/ownership UI and a conflict-safe worktree service.
9. Desktop voice capture/playback and ScreenCaptureKit consent/indicator UI.
10. New unit, integration, navigation, UI, accessibility, preview, and visual
    capture tests.

## Backend or contract gaps proven from the live tree

- The current contract publishes native auth/sync/chat plus Library, artifacts,
  memory, Code devices/workspaces/tasks and task detail. Several existing
  general routes are bearer-capable but are not all described in OpenAPI.
- Cloud/device Code task creation and approval/cancel routes exist and already
  have a shared client. No second task service is needed.
- Remote-session command and event routes exist and already have a shared
  client, but the host-side session-summary/detail publication path is not yet
  represented by a complete public Swift host adapter.
- There is no current shared service that creates and owns isolated Git
  worktrees for desktop sessions.
- There is no native Compare coordinator. Compare can be implemented client-side
  by running independent private chat streams, matching the website.
- Media generation, saved prompts, share management, connected-device
  revocation UI, and several account/profile operations do not yet have complete
  shared native clients.
- Connector OAuth/credential setup still depends on a website browser flow; the
  native model currently supports catalog reads and disconnects.

Backend changes will be added only when one of these gaps blocks a real desktop
operation and no existing route can satisfy it.

## Code that must not be reused

- Any deleted macOS application, target, resource, test, component name, project
  file, or documentation that describes its implementation.
- iPhone SwiftUI views forced into desktop columns.
- Preview fixtures as production data or a mock service presented as real.
- A second backend client, sync engine, model catalog, token store, local
  database, or design-token system.
- Web glass/blur recipes on reading, code, terminal, diff, or file surfaces.
- Raw device-local paths in remote/mobile projections.
- Provider credentials or OAuth secrets in the app.

## Baseline verification

- `npm run native:contract:check`: passed; generated Swift matches OpenAPI
  digest `9723b452be44aa1f596a7544928f79abe6501b2de9c67b24896656c3fc36a745`.
- `JunoNativeKit`: built and tests completed from an isolated scratch path.
  Existing actor-isolation warnings in `JunoBrandTests` are recorded and are not
  attributed to the new app.
- `JunoCode`: builds, but the full test command currently exits 1 because
  `ComputerUseCoordinatorTests.testSystemDriverFailsClosedWithoutImplementation`
  expects `.unavailable` while the live `SystemComputerUseDriver` is now
  implemented. This is a pre-existing baseline mismatch in the current dirty
  checkout and must be reconciled before the final gate.

