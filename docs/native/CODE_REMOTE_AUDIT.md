# Juno Code Remote / Cloud — Backend Audit (Phase 11)

Branch: `agent/juno-code-remote-backend` (stacked on `agent/juno-native-claude-continuation`).
Scope: strictly Juno Code Remote/Cloud. This is not a general repository audit.

## Headline finding — the control plane already exists and already accepts native bearer

GAP-021 previously read "no backend routes exist for Juno Code Cloud/Remote
sessions." That was accurate only about the **native OpenAPI contract**
(`contracts/openapi/juno-native-v1.yaml`), not the backend. The web backend
already ships a complete Juno Code control plane, event journal, command/
approval flow, device registration, workspace sharing, and a cloud runner:

- Routes under `src/app/api/code/`:
  - `POST/GET /api/code/devices` — register a host, list hosts (with online).
  - `GET/POST /api/code/workspaces`, `PATCH/DELETE /api/code/workspaces/{id}` — shared workspaces keyed by an opaque `key`.
  - `POST/GET /api/code/tasks` — create/list a **session** (a `CodeTask`).
  - `GET /api/code/tasks/{id}` — session state.
  - `GET /api/code/tasks/{id}/events` — the append-only event journal, cursorable by `seq`.
  - `POST /api/code/tasks/{id}/claim` — a device claims a queued task.
  - `POST /api/code/tasks/{id}/respond` — an approval / command response.
  - `POST /api/code/tasks/{id}/cancel` — stop.
  - `POST /api/code/tasks/{id}/runner-context` — one-time cloud runner handoff.
  - `GET /api/code/queue` — a device polls for tasks addressed to it.
  - `GET /api/code/github/{repos,pulls}` — cloud repo pickers.

- Auth: every owner-facing route uses `requireUser()` →
  `getCurrentUser()` (`src/lib/session.ts`), which **already authenticates a
  native bearer** via `authenticateNativeBearer` before falling back to the
  Auth.js cookie. A dedicated Cloud Code task bearer (`Bearer cct_…`) is routed
  to task-token auth first and never falls through to native-bearer auth. So a
  native app that presents its device bearer is already a first-class caller of
  the entire `/api/code/*` surface.

Conclusion: **no new backend service, and no new control-plane routes, are
needed for the native Remote experience.** The native clients, macOS host
coordinator, Cloud/Remote dispatch, and unified JunoMac live task monitor are
now implemented. Remaining work is release validation and any future expansion
of the event vocabulary, not a missing execution path.

## Data model (reused as-is)

| Role | Model | Notes |
|------|-------|-------|
| Host / Remote device | `CodeDevice` | `(userId, name)` unique; `workspaces` JSON; `lastSeenAt` = heartbeat; `platform`. |
| Shared workspace | `CodeWorkspace` | opaque `key` identity (partial unique `(userId, key)`); `path` is device-local metadata. |
| Session | `CodeTask` | `deviceId` null ⇒ cloud; `status` (queued/running/awaiting_approval/…); `lastSeq` = event cursor; `conversationId`; `target` device\|cloud; cloud repo fields; `runnerClaimedAt` = one-time handoff spent. |
| Event journal | `CodeTaskEvent` | `(taskId, seq)` unique, append-only; `kind`; `payload` JSON; `createdAt`. |

These satisfy the Phase 11 invariants (owner, host device, opaque workspace,
session, status, event cursor, idempotent handoff, timestamps, cancellation,
terminal error, retention via cascade). Local absolute paths live only in
`CodeTask.workspacePath` / `CodeWorkspace.path`; the native mobile client must
address by `workspaceKey`/`id`, never by raw path (see below).

## Response shapes (from `src/lib/code-remote.ts`)

- `serializeDevice`: `{ id, name, platform, workspaces, lastSeenAt, online? }`
- `serializeTask`: `{ id, deviceId, workspacePath, workspaceName, workspaceKey, title, prompt, status, lastSeq, conversationId, target, repoOwner, repoName, baseRef, prUrl, createdAt, updatedAt }`
- `serializeTaskEvent`: `{ seq, kind, payload, createdAt }`

Note: `serializeTask` still includes `workspacePath` for the authenticated
owner-facing macOS task surface. Native UI display avoids using it as a label
fallback; a future mobile contract should continue to expose only
`workspaceName` + `workspaceKey` and never raw host paths. This is a privacy
hardening item, not a blocker for the current macOS owner-scoped monitor.

## Reframed GAP-021

- Backend control plane: **exists**, bearer-capable, owner-scoped, idempotent,
  cursorable, with claim/respond/cancel and a cloud runner.
- Current native state:
  1. The `/api/code/*` surface is published in the native contract and typed
     clients.
  2. The macOS Remote Host coordinator registers, heartbeats, claims, executes
     through the existing runtime, acknowledges, backs off, and stops on
     sign-out or revocation.
  3. Cloud/Remote dispatch and the JunoMac live task monitor are wired; the
     monitor follows the event cursor across stream reconnects and exposes
     approvals, cancellation, and PR links.
  4. A path-free mobile projection remains the preferred future API shape.

## Native integration plan (this branch, atomic units)

1. Publish the existing `/api/code/*` control plane in `juno-native-v1.yaml`
   (path-free task projection), regenerate the Swift contract, bump the version.
2. `JunoCodeBridge` transport: **done** — typed Swift clients for devices,
   tasks, events, approvals, cancellation and Cloud/Remote dispatch.
3. macOS Remote Host coordinator: **done** — registration, heartbeat, explicit
   opt-in claiming, existing-runtime execution, ordered acknowledgements,
   backoff, and sign-out/revocation stop.
4. Mobile Remote controller + screens: the shared control-plane primitives are
   ready; a dedicated mobile presentation remains a follow-up surface. The
   current owner-scoped macOS monitor never exposes host credentials and avoids
   displaying raw workspace paths.
5. Cloud: the runner is GitHub-Actions based (`target: "cloud"`, isolated by
   design). Reuse it; do not run agent commands in the Next.js process.

## Threat model (summary — full model to follow)

- Bearer compromise → device-scoped tokens, rotation/revocation via the existing
  device-session store; task bearers (`cct_`) are one-time and never accepted as
  native bearers.
- Command replay / double execution → `clientCommandId`/idempotency + `(taskId,
  seq)` monotonic journal; terminal-status guards refuse late commands.
- Cross-account access → every route owner-scopes on `getCurrentUser()`.
- Path traversal / symlink escape / out-of-workspace → enforced by the existing
  `JunoCodeLocal` runtime; the Remote Host grants a remote command **no more**
  privilege than a local one, and never exposes absolute paths to mobile.
- Forged host / ghost host → heartbeat + online window; a session only executes
  on a device that claimed it.

## Explicitly out of scope / preserved

- No production deploy, no VM change, no `prisma migrate deploy`, no merge.
- The `20260721120000_backfill_entity_revisions` migration's `NULL::timestamp`
  handling must be preserved; do not reintroduce the broken variant.
- Local macOS Juno Code keeps working exactly as today.
