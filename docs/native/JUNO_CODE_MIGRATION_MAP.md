# Juno Code migration map

Status: active implementation map. This is based on the source tree as it
exists, not on the historical audit material in `docs/native/archive/`.

## What exists today

| Layer | Source of truth / responsibility | Keep | Migration boundary |
|---|---|---|---|
| Core domain | `native/Packages/JunoCode/Sources/JunoCodeCore` | Session IDs, append-only events, permissions, diffs, worktree models, checkpoints | Make its session/event models the typed cross-client vocabulary. |
| Local capabilities | `JunoCodeLocal` | Sandboxed commands, filesystem grants, Git, worktrees, tests, dev servers, terminal, previews, computer use | Place behind a long-lived host; do not move into a view or remote client. |
| Agent orchestration | `JunoCodeRuntime` | Orchestrator, tools, approvals, persistence, subagent control | Host owns its lifecycle and exposes it through the versioned protocol. |
| Backend bridge | `JunoCodeBridge` | Model/web-search clients and remote-command policy adapter | Adapt protocol commands into the existing runtime; never create a second tool loop. |
| Native relay client | `JunoNativeKit/Sources/JunoCodeKit` | Authenticated backend client, ordered event outbox, SSE reading | Replace string kinds incrementally with adapters to the Core protocol. |
| Server relay | `src/app/api/code`, `src/lib/code-remote-sessions.ts`, Prisma models | Device ownership, idempotent commands, session cache, event persistence/SSE | Negotiate protocol versions and preserve the Core envelope's IDs and sequence rules. |
| TypeScript runtime | `runner/agent-core` | Provider adapters, agent loop, sandbox tools, session persistence, subagents | Reuse through a signed host process; do not duplicate it in SwiftUI. |
| Electron host | `native/desktop-electron/src/agent-host` | Typed Zod IPC, multiplexing, request correlation, approval replay handling, shutdown/reaping | Reuse its host protocol/lifecycle concepts, not Electron as the flagship desktop UI. |
| macOS GUI | `native/macOS/JunoDesktop` | Composition root and Code/Remote presentation | Become a `JunoCodeHosting` client; preserve its current local capability ownership during extraction. |
| iOS GUI | `native/iOS/JunoMobile` | Remote orchestration presentation | Remain relay-only: no local filesystem, shell, or credential authority. |

## Confirmed boundary problems

1. `SessionLocation` is a three-case UI/persistence selector, while
   `JunoCodeUI/Remote/ExecutionLocation.swift` carries a second, richer target
   model. The new Core `ExecutionTarget` is the routing model; UI-specific
   locations should adapt to it and must not carry filesystem paths.
2. `SessionEvent` is typed and durable in Core, but the remote relay transports
   separate string kinds plus JSON payloads. The new envelope retains the Core
   payload and adds an explicit protocol version, producer event ID, and
   one-based resumable sequence.
3. The server append planner handles normal replay and gaps, but has a
   different vocabulary from Core and no typed protocol-negotiation object.
   Keep it as the relay adapter until a contract version is rolled out.
4. `runner/agent-core` already has the most complete headless agent loop.
   The Electron utility-process host improves on its older localhost WebSocket
   sidecar with validated IPC, request IDs, approval idempotency and bounded
   shutdown. That is the implementation to extract into a host abstraction;
   neither SwiftUI nor Electron rendering should own the runtime.
5. The macOS remote host currently executes through a workbench/controller
   bridge. This preserves existing approval policy but ties host lifecycle to
   GUI composition. Extract it behind `JunoCodeHosting` before introducing a
   daemon/XPC service.

## Staged migration

1. **Protocol foundation (current):** Core owns `ExecutionTarget`, versioned
   event/command envelopes, cursors, deterministic replay planning, and the
   `JunoCodeHosting` interface. Existing stores and HTTP routes are unchanged.
2. **Adapters:** add an adapter from `SessionEvent`/`CodeSessionStore` to the
   Core envelope and an adapter between the relay's current DTOs and protocol
   commands. Map only equivalent event kinds; unknown kinds stay visible as
   compatibility errors rather than being silently dropped.
3. **Host extraction:** move local orchestration out of `DesktopCodeHost` into
   a process-lifecycle owner. Start in-process behind `JunoCodeHosting`; then
   use a signed XPC/capability transport when the helper packaging and
   adversarial IPC tests are ready. No unauthenticated listener.
4. **Relay v1:** register target capabilities and protocol version, carry
   command idempotency keys and envelope event IDs, and use the event cursor
   for resume. Backend push wakes clients for high-value state; SSE remains a
   reconnection stream, not continuous foreground polling.
5. **Clients and CLI:** macOS, iOS remote, web remote and a CLI submit the same
   command envelopes and fold the same events. The CLI must be a host client,
   never a duplicate agent loop.
6. **Cutover:** only remove old relay/GUI paths after an adapter passes the
   existing sandbox, workspace, approval, worktree, session-restoration and
   remote end-to-end tests at feature parity.

## Non-negotiable ownership

- The host is authoritative for workspace grants, paths, local credentials,
  process lifecycle, approvals and cancellation.
- Relay and clients carry opaque identifiers, bounded summaries and capability
  metadata only; they never authorize a local mutation.
- Event sequences establish order; event IDs and command idempotency keys make
  retries inert. A gap, major-version mismatch, expired command, or unknown
  approval fails closed.
- Subagents remain child runs/sessions. Their lifecycle enters the same parent
  event stream rather than a sidebar-owned state model.
