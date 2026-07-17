# Juno cross-platform product audit

Audited: 2026-07-17

Repositories in scope:

- `juno`: web product, backend, database, and native API contract
- `juno-app`: SwiftUI app for macOS and iOS
- `juno-windows`: Tauri 2 / React / Rust desktop app

This is a baseline audit, not a claim that every listed gap has shipped. The
first implementation milestone is the shared Juno Quick composer described in
[`juno-quick-contract.md`](./juno-quick-contract.md).

## Executive finding

The three products already share a meaningful backend and product vocabulary.
They are not three prototypes: authentication, account models, saved chats,
projects, memory, attachments, streaming, cancellation, private chat, voice,
artifacts, sync, and native desktop capabilities have substantial real
implementations.

The main risk is contract and lifecycle fragmentation. Chat and streaming are
still legacy, handwritten protocols outside the versioned native OpenAPI file;
several client features own their own orchestration; initial sync cannot recover
a complete account from a compacted change feed; and neither desktop app had a
process-owned global composer. Adding another independent chat stack would make
that drift worse. Juno Quick therefore wraps the existing engines and account
stores while establishing a shared state and security contract.

## Existing foundations to preserve

### Backend and web

- Real bearer/cookie authentication, PKCE device authorization, rotating
  refresh tokens, device revocation, and account ownership checks.
- A mature `/api/chat` pipeline with model selection, project/memory context,
  clarification input, attachments, moderation, usage enforcement, SSE,
  cancellation, sources, artifacts, and persisted results.
- Native bootstrap, cursor change feed, entity hydration, and idempotent mutation
  envelopes under `/api/v1`.
- A single model catalog and pricing/capability metadata used by product UI.

### Apple

- SwiftData account mirror, mutation queue, sync service, real backend transport,
  `ChatEngine`, models/projects/memory/private chat, attachments, artifacts,
  voice/dictation, and native Liquid Glass design primitives.
- Release builds exclude the debug demo transport.
- The deployment target supports the native macOS 26 glass APIs required for
  the Quick surface.

### Windows

- Rust-owned PKCE/vault/refresh lifecycle, authenticated HTTP/SSE proxy,
  cancellation, real chat engine, IndexedDB account mirror, and mature main-app
  stores for conversations, models, projects, private chat, and artifacts.
- A Fluent token system with Mica, forced-colors, reduced-motion, and
  reduced-transparency fallbacks.
- Tauri capabilities provide a practical least-privilege boundary when each
  webview is assigned an explicit command set.

## Highest-risk gaps at baseline

### Shared/backend contract

1. The versioned OpenAPI contract covers auth, models, bootstrap, changes,
   entities, and mutations, but not chat generations, resumable stream events,
   clarification, attachments, artifacts, quota, voice, or cancellation.
2. A fresh client or a client behind the compaction floor has no complete
   snapshot endpoint, so bootstrap plus the change feed cannot reconstruct all
   account state.
3. First chat creation had no durable client request identity and no precise
   `quick_macos` / `quick_windows` origin.
4. Stream events have no durable event identifiers or resume cursor, and cancel
   state is process-local.
5. Clarification does not yet declare inspected context or persist structured
   answer provenance as a first-class entity.
6. Uploads buffer whole files and do not expose a complete create/status/cancel/
   delete lifecycle. Persistent uploads are not an honest private-mode contract.
7. Device-local workspace paths can appear in synced entity payloads and should
   be separated from portable workspace identity.
8. Raw provider reasoning is still represented as displayable chain-of-thought;
   the canonical protocol should expose only provider-sanctioned summaries and
   user-visible activity.

### Apple lifecycle and parity

1. No process-owned Quick panel, global shortcut, menu-bar lifecycle, launch at
   login, protected Quick draft, or closed-window handoff existed.
2. Main chat orchestration is view-owned. Quick must reuse `ChatEngine` without
   coupling its survival to a main `WindowGroup` instance.
3. The native client did not call the backend clarification preflight route.
4. A failed server conversation creation could be represented by a local UUID;
   UI must not present that as confirmed server persistence.
5. Attachment staging lacked progress/cancel affordances and some reads were
   whole-file operations.
6. The current test baseline has one unrelated raw-string fixture failure in
   `WorkspaceIdentityTests.taskDecodesOptionalWorkspaceKey`; it predates Quick
   and must not be hidden in release reporting.

### Windows lifecycle and parity

1. Only the main Tauri window existed; closing it terminated the process. There
   was no global shortcut, tray, autostart, overlay placement, focus restoration,
   or Quick settings lifecycle.
2. A second webview receives a separate JavaScript runtime. It must not start a
   second sync poller or pretend its Zustand modules are shared with the main
   window.
3. Default custom commands included privileged path upload, workspace, PTY, Git,
   and code operations. A Quick webview needs an independent capability plus
   native caller/path validation.
4. The existing arbitrary-path upload command must never be exposed to Quick;
   attachments require explicit grants or bounded byte upload.
5. Clarification, protected Quick drafts, dictation, and closed-window handoff
   were absent.
6. The installer pipeline passes, but binaries are unsigned, the updater is
   disabled, and install/upgrade/uninstall behavior still needs real-Windows
   smoke evidence.

## Canonical implementation sequence

1. Establish the shared Quick state, dismissal, account, draft, handoff, and
   security contract.
2. Add precise conversation origin and paired first-submission idempotency while
   keeping existing chat callers compatible.
3. Build the macOS surface as a key-capable `NSPanel` owned by process state and
   styled with native Liquid Glass.
4. Build the Windows surface as a dedicated lazy-loaded webview with Rust-owned
   shortcut/tray/autostart/focus behavior and an isolated Tauri capability.
5. Route both through the existing account, model, project, clarification,
   upload, chat-stream, cancellation, source, artifact, and handoff paths.
6. Promote the compatibility bridge into a versioned generation, clarification,
   attachment, quota, and snapshot contract; generate native models from it and
   enforce drift in CI.

## Release evidence still requiring real platforms

Automated builds and unit tests cannot establish all desktop behavior. Release
sign-off still requires physical macOS and Windows checks for:

- shortcut conflicts, keyboard layouts, key repeat, IME composition, and
  assistive technology;
- multi-display placement, mixed DPI, taskbar/Dock/Stage Manager, fullscreen
  apps and Spaces, focus stealing restrictions, and focus restoration;
- reduced motion/transparency, high contrast/forced colors, screen readers,
  keyboard-only navigation, and 200% text scaling;
- microphone/speech permissions, attachment grants, cancellation, large-file
  limits, sleep/wake, lock/unlock, offline recovery, and account switching;
- login launch, background lifecycle, explicit Quit, installer upgrade and
  uninstall cleanup, code signing/notarization, and updater policy.
