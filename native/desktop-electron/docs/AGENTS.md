# Agents

How Juno Desktop runs coding agents: the process boundary, the event
vocabulary, what exists today, and what does not.

This describes the implementation. [STATUS.md](STATUS.md) is the authority on
what has actually been exercised.

---

## The agent runtime is not written here

`runner/agent-core` is Juno's agent runtime — provider adapters, a tool
registry, a permission engine with deterministic sensitive-command patterns,
subagents with git-worktree isolation, checkpoints, session persistence and
resume, container sandboxing, and an egress policy. It already runs Juno's cloud
Code sessions.

The desktop app **embeds it as a library**. See
[ADR-0002](adr/0002-agent-host.md) for why, and for the alternatives rejected.

The consequence worth internalising: **new shared agent capability belongs in
`runner/agent-core`, not here.** MCP, skills and hooks are all currently absent;
when they arrive they should arrive there, so the cloud runner gets them at the
same time and the event vocabulary stays single-sourced.

---

## The process boundary

```text
main  ──postMessage/MessagePort──▶  agent host (utilityProcess)
                                     └─ @juno/agent-core
```

`src/main/agent-host-supervisor.ts` owns the child. `src/agent-host/` is the
child itself.

There is no localhost port and no shared secret. The Swift client needed both,
because Swift cannot host Node and had to reach agent-core's WebSocket sidecar
(`startSidecarServer`). Electron is Node, so that whole transport — and the
local attack surface it implies — is simply absent.

The host is nonetheless treated as a **trust boundary**, not as trusted code.
It reads and writes the workspace, spawns shells, and drives providers, so every
message crossing the boundary is Zod-validated in both directions
(`src/agent-host/host-protocol.ts`), and its environment is scrubbed at fork
rather than inherited.

### Lifecycle

- **Lazy.** The host is forked on first use. A user who never opens Code never
  pays for a second process.
- **Ready is negotiated, not assumed.** The supervisor waits for the host's
  `ready` frame. Treating a successful `fork()` as success would report
  "running" for a process that died during module load.
- **Bounded restart.** After repeated crashes the host stays down with a visible
  `crashed` status rather than restarting forever. A crash loop that hides
  itself is worse than an outage that admits it.
- **Shutdown is awaited.** `shutdown` is sent, the exit is awaited, and the
  process is killed after a grace period. Nothing is left orphaned.

---

## One event vocabulary

`AgentEvent` in `runner/agent-core/src/types.ts` is the canonical union. The
cloud runner, the session relay and the Swift clients already speak it — the
Swift `SubagentStatus` enum copies its raw values character-for-character and
says so in a comment.

The desktop app does not define a second one. `src/shared/agent-protocol.ts`
declares Zod validators for it and asserts **at compile time** that they are
exactly identical to agent-core's types. Add an event upstream without adding it
here and `npm run typecheck` fails on the assertion line.

Two caveats recorded in that file and worth repeating:

1. The assertion does **not** distinguish `?: T` from `?: T | undefined`. Zod's
   `.optional()` infers the latter; agent-core declares the former. The protocol
   uses *absence* of `agentId` to mean "the root agent", so that distinction is
   pinned by runtime tests instead.
2. If the agent-core import ever resolves to `any` — an unbuilt package, a
   broken path — every assertion passes **vacuously**. That happened once during
   development. `npm run contract:check` now fails closed on exactly that case.

---

## Permission modes

The runtime modes are agent-core's: `plan`, `ask`, `auto-edit`, `full`. The UI
presents **Ask / Plan / Code**, mapped in `src/renderer/products/code/lib/modes.ts`.

The mapping is not cosmetic, and one detail is easy to get wrong: in **Plan**,
non-safe tools are *denied outright*, not queued for approval — a stronger
promise than "you will be asked". In **Ask**, the agent *can* write, after
approval. The UI therefore says "confirms every change" rather than "cannot
mutate", because a mode indicator that contradicts the next approval dialog
stops being believed.

Approvals suspend the tool call rather than racing it, and a decision is applied
**at most once per `callId`** — the resolver is removed from the pending map in
the same synchronous step it is taken, so a replayed approval after a reconnect
finds nothing to apply. That property matters more than it sounds: without it, a
reconnect could run a destructive command twice.

---

## Subagents

agent-core's `SubagentManager` provides them, and the desktop surfaces them:
role, status, current activity, usage, isolation, and whether their changes were
`applied`.

The isolation is real. A writing subagent runs in its own **git worktree**, and
containment for edit tools is structural rather than advisory — an edit outside
the child's worktree is denied by the tool layer, not by a prompt. Where the
workspace is not a git repository, parallel writing agents are refused with an
explanation rather than silently downgraded.

Note that **worktrees are not a protocol concept in any agent** — not in ACP,
not in any vendor's CLI. Every agent accepts a `cwd`. So Juno creates the
worktree and points the agent at it, which is portable across every provider.

---

## Providers

`src/providers/` is ACP-first: one JSON-RPC-over-stdio client covering the
agents that implement the Agent Client Protocol, plus Juno's own
backend-proxied provider (server-side keys, no local CLI). See
[PROVIDERS.md](PROVIDERS.md) and [ADR-0004](adr/0004-provider-layer.md).

Capabilities are **negotiated at `initialize`**, not hardcoded per vendor, and
the capability type distinguishes *host-provided* from *unavailable* — because
telling a user their agent "can't do worktrees" when Juno does worktrees for it
is a different and more useful statement than "unsupported".

**No provider is enabled by default.** That is a licensing decision, not a
technical one, and it is recorded in [STATUS.md](STATUS.md) as an open blocker.

---

## What does not exist yet

Stated plainly, because a document that lists only what works is a brochure.

| | |
|---|---|
| MCP | Not implemented. Belongs in agent-core. Note the pre-existing hazard recorded in STATUS.md: in the Swift client, `.mcp.json` is repository-controlled and server spawn bypasses the permission coordinator entirely. Do not reproduce that here. |
| Skills | Not implemented. |
| Hooks | Not implemented. |
| Agent teams | Not implemented. Subagents exist; peer agents with shared objectives and conflict detection do not. |
| Parallel Code sessions | The host supports multiple sessions; the UI does not yet present them, and worktree-per-session is not wired. |
| Computer Use | Not implemented. See [COMPUTER_USE.md](COMPUTER_USE.md) — it is off by default and, more importantly, it is not defended by the rest of this architecture. |
| A completed agent turn | The host forks, negotiates and routes events. A full turn needs a configured provider, which is blocked on the licensing decision. |
