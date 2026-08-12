# Juno Desktop — Architecture

This document describes **what exists**, not a target state. Anything not yet
built is in [STATUS.md](STATUS.md) under its real status.

---

## Process model

```text
┌─────────────────────────────────────────────────────────────────┐
│ Electron Main                                                    │
│  · window lifecycle, native menu, deep links                     │
│  · juno:// protocol handler (renderer assets)                    │
│  · Keychain (safeStorage), auth, token refresh                   │
│  · ALL network I/O — sync client, chat/Work/Code streams         │
│  · SQLite (node:sqlite), durable outbox                          │
│  · PTY supervision (node-pty)                                    │
│  · process supervision + shutdown                                │
└───────────┬──────────────────────────────┬──────────────────────┘
            │ ipcMain.handle               │ utilityProcess
            │ (validated, sender-checked)  │ MessagePort
┌───────────┴────────────┐    ┌────────────┴─────────────────────┐
│ Preload (sandboxed)    │    │ Agent Host (utilityProcess)       │
│  · window.juno only    │    │  · @juno/agent-core as a LIBRARY  │
│  · invoke + on         │    │  · sessions, tools, permissions   │
│  · no Node, no zod     │    │  · subagents + git worktrees      │
└───────────┬────────────┘    │  · provider adapters (ACP)        │
            │                 └───────────────────────────────────┘
┌───────────┴────────────┐
│ Renderer (React 19)    │
│  · presentation only   │
│  · NO Node types       │
│  · CSP connect-src self│
└────────────────────────┘
```

### Why the renderer cannot reach anything

Three independent mechanisms, so that no single mistake removes the boundary:

1. **Runtime** — `contextIsolation: true`, `sandbox: true`, `nodeIntegration:
   false`, applied from one frozen `SECURE_WEB_PREFERENCES` object
   (`src/main/security.ts`) rather than per window.
2. **Compile time** — `tsconfig.web.json` deliberately omits `@types/node`. A
   renderer file that imports `node:child_process` is a *type error*, so it
   never reaches a reviewer who might wave it through.
3. **Network** — CSP `connect-src 'self'`. The renderer cannot originate a
   request at all.

The third is not only a security choice. The Juno backend has **no CORS**, and
`src/middleware.ts:144` returns 403 for any mutating `/api/` request whose
`Origin` doesn't match the host — while a request with *no* `Origin` passes.
A renderer `fetch` would fail on both counts. So all network I/O has to happen
in main regardless, and that is also what keeps bearer tokens out of the
renderer. One mechanism satisfies two requirements.

---

## The IPC boundary

One table (`src/shared/ipc.ts`) declares every channel with a Zod schema for its
request and its response. Main, preload and renderer all derive from it.

Three checks run before any handler sees a message (`src/main/ipc-router.ts`):

1. **Channel is in the contract.** `ipcMain.handle` is called only from the
   router, iterating the table — a handler that isn't in the table is
   unreachable.
2. **Sender is trusted.** Identity is checked against a `WeakSet` of the actual
   `WebContents` objects (not ids, which are reused), *and* the sender frame's
   URL must still be internal. A trusted window navigated elsewhere, or a
   subframe, is not the renderer speaking for us.
   > t3code, our architectural reference, validates schemas in both directions
   > but does **not** validate `senderFrame`. Juno does.
3. **Payload parses.** The renderer is treated as untrusted input even though we
   wrote it, because a renderer compromise is the scenario the boundary exists
   for.

Responses are validated on the way out too. That catches *our* bugs: a handler
returning the wrong shape fails loudly in main instead of producing a confusing
`undefined` in a React component.

### Preload is deliberately tiny

`window.juno` exposes exactly two functions, `invoke` and `on`. No
`ipcRenderer`, no `send`/`sendSync`, no objects, nothing from Node. The Electron
event object is dropped rather than forwarded, because it carries a `sender`
handle.

The channel *names* live in `src/shared/channels.ts`, which has **no
dependencies at all**, so the sandboxed preload bundle doesn't pull Zod in. A
`satisfies Record<InvokeChannel, …>` constraint in `ipc.ts` makes the split
safe: a name without a schema is a compile error.

---

## The agent host

See [ADR-0002](adr/0002-agent-host.md) for the decision and its alternatives.

`runner/agent-core` is an existing 12,787-line TypeScript package that already
implements sessions, provider adapters, a tool registry, a permission engine,
subagents with git-worktree isolation, checkpoints and session resume. Its
`AgentEvent` union is already the shared vocabulary of the cloud runner, the
session relay and the Swift clients.

The desktop app **imports it as a library** in a `utilityProcess`. The Swift
client couldn't (Swift can't host Node) and so reimplemented it; Electron is
Node, so it doesn't have to.

It is consumed as a **built package** (`file:../../runner/agent-core`), not via
a path alias into its source. Aliasing the source pulled agent-core's `.ts`
files into this project, broke `rootDir`, and — more seriously — applied *this*
workspace's stricter compiler options to code written under a laxer config. A
shared package must be type-checked by its own tsconfig.

### Contract drift is a compile error

`src/shared/agent-protocol.ts` declares Zod validators for the agent protocol
and then asserts, at the type level, that each validator is **exactly**
identical to the agent-core type it mirrors:

```ts
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

assertExactly<Exactly<z.infer<typeof AgentEventSchema>, AgentEvent>>();
```

Add an event to agent-core without adding it here and `npm run typecheck` fails
on the assertion line. This was verified by injecting a deliberate drift
(`turnIndex: z.number()` → `z.string()`) and confirming the compiler rejects it,
then confirming the restored file compiles clean — an assertion nobody has seen
fail is an assertion nobody knows works.

Validators exist at all — despite the types already being TypeScript — because
the agent host is a **separate OS process**. Types are erased at runtime; a
compromised or simply buggy host is in scope in the threat model.

---

## Data flow

### Sync (main process)

The realtime stream is a **wakeup, not a data channel** — verified against the
implementation, not assumed. The server polls max-cursor every ~2s, emits
`{"cursor":"N"}`, holds ~55s, then ends.

```text
authenticate (PKCE via system browser, juno://auth/callback)
  → bootstrap
  → persist authoritative cursor
  → subscribe /api/v1/changes/stream   (wakeup only)
  → on wakeup: GET /changes → GET /entities (≤100 ids/batch)
  → apply transactionally → advance cursor
  → drain outbox
```

Constraints that shaped this, all verified:

- **No domain model carries a `revision`**, and `updatedAt` is missing on 46 of
  85 models. Revisions and tombstones live in the `EntityRevision` side table,
  so a watermark sync is impossible — the cursor feed is the only correct
  mechanism.
- A cursor below the **30-day compaction floor returns 410** and requires
  re-bootstrap. That is a normal path after a long offline period, not an error.
- **Only 22 of 85 entity types are in the feed.** Work, Knowledge, Research,
  Import and the Code *remote session* family are absent and need their own
  polling. This is capability-gated in the UI rather than faked — the Work
  surface shows explicit freshness rather than implying live sync.
- Access tokens are **HS256 JWTs with a 10-minute TTL**; refresh is a rotating
  family with reuse detection. A concurrent second refresh returns **`503
  refresh_conflict`**, not 401 — it must be retried with credentials kept, or
  the user is signed out spuriously.

### Outbox

Every local mutation is written to the outbox **in the same transaction** as the
local state change. A crash between the two would otherwise either lose the
mutation or double-apply it.

Server receipts are keyed by `(account, deviceSession, mutationId)` — so the
same idempotency key replayed from a *different device session executes again*.
The outbox therefore cannot rely on the key alone across re-authentication.

---

## Renderer

React 19, Tailwind 3.4, framer-motion 12 — versions matched to the web app on
purpose ([ADR-0003](adr/0003-design-tokens.md)), because the web app's
`tailwind.config.ts` *is* the semantic token mapping and its motion vocabulary
is expressed against framer-motion 12.

Design tokens are **generated** from `src/app/globals.css` by extending the
repository's existing generator, so `npm run tokens:check` fails on drift. The
tokens are not retyped by hand.

Two identity rules that are easy to get wrong:

- **On dark, elevation comes from a lightness ladder, not shadow** (`0%` < card
  `6.5%` < muted `9.5%` < popover `13%`, plus a 1px inset sheen). Dark mode is
  true black.
- **Glass is for transient chrome only** — composer, menus, popovers, command
  palette. Reading surfaces, code, diff and terminal are opaque.

Reduced motion is **tiered, not a kill switch**: transforms collapse while
state-carrying animation survives. macOS "Reduce Transparency" has no media
query, so main reads it and sets an attribute on `<html>`.

---

## Testing

- **Unit** (Vitest, node env) — protocol validators, security helpers, IPC
  contract exhaustiveness, pure reducers. 259 tests currently passing.
- **Integration** — SQLite migrations, PTY lifecycle, agent-host round trips.
- **E2E** (Playwright `_electron`) — against a **dev build**, because
  `EnableNodeCliInspectArguments: false` — correct hardening — is exactly what
  makes the packaged app undrivable by Playwright. This trade-off is documented
  where the fuse is configured so nobody later "fixes" the fuse to make E2E run.

The repository's house idiom is `node:test` via `tsx --test`. Vitest is a
deliberate deviation for this workspace, justified in [TESTING.md](TESTING.md):
the renderer genuinely needs Vite's transform pipeline.
