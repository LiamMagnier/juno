# ADR-0002 — The agent host embeds `@juno/agent-core` in a `utilityProcess`

**Status:** Accepted · 2026-08-12

## Context

The brief (§6) asks for a "Local Agent Host" owning provider adapters, PTY,
filesystem, Git, worktrees, MCP, skills and an execution engine.

Auditing the repository first — as §2 requires — turned up
**`runner/agent-core`**: a 12,787-line TypeScript package that already
implements most of that list, in production, today. It has provider adapters, a
tool registry, a permission engine with deterministic sensitive-command
patterns, subagents with **git worktree isolation**, checkpoints, session
persistence and resume, container sandboxing, and an egress policy.

Its `AgentEvent` union is already the shared vocabulary of the cloud runner, the
session relay, and the Swift clients — the Swift `SubagentStatus` enum copies
its raw values character-for-character and says so in a comment.

The Swift macOS client could not embed it (Swift cannot host Node), so the Swift
track reimplemented it in Swift and agent-core grew a `bundle:mac` script and a
**localhost WebSocket sidecar** (`startSidecarServer`) to bridge the gap.

## Decision

The agent host **imports `@juno/agent-core` directly as a library** and runs in
an Electron **`utilityProcess`**, communicating with the main process over
`postMessage` / `MessagePort`.

No WebSocket. No localhost port. No shared secret.

## Rationale

Electron is Node. The reason the sidecar existed does not apply.

Not embedding it would mean maintaining a *third* implementation of Juno's agent
runtime (TypeScript for cloud, Swift for macOS, and a new one here) — precisely
the parallel implementation §2 forbids.

Choosing `utilityProcess` over the alternatives:

- **vs. in-process (main).** A crashing or wedged agent must not take the window
  with it, and agent work is CPU-heavy enough to jank the UI thread.
- **vs. localhost WebSocket** (t3code's choice). t3code needs it because the
  same backend serves web, desktop and React Native shells. Juno Desktop has one
  shell. A listening port is reachable by every other process on the machine and
  forces a shared-secret handshake to compensate; `MessagePort` is reachable
  only by the two processes holding it.
- **vs. `worker_threads`.** node-pty is explicitly not thread-safe.
- **vs. `child_process.spawn`.** Viable, and it is what t3code uses. Rejected
  because `utilityProcess` gives Electron-managed lifecycle, integrated crash
  reporting, and a structured-clone message channel without hand-rolling
  framing. The known cost is that `utilityProcess` restricts `stdin`, which
  rules out the fd-3 secret-passing pattern — Juno does not need it, because
  credentials never reach the agent host as a startup argument.

## Consequences

**Good**

- One agent runtime, already tested, already speaking the protocol the backend
  and the web surfaces understand. Remote control and web parity get much
  cheaper because the event vocabulary is already shared.
- Worktree isolation, subagent roles and the permission engine arrive complete.
- No port, no token, no local attack surface from the transport.

**Bad**

- The desktop app is coupled to `runner/agent-core`'s API. Mitigated by
  consuming it through a narrow interface in `src/agent-host/` and by
  `src/shared/agent-protocol.ts`, which fails to compile if the contract drifts.
- `agent-core`'s tools call `fs` and `child_process` directly, so the agent host
  is a genuinely privileged process. It is treated as a trust boundary: every
  message crossing it is Zod-validated in both directions.
- The `RunAsNode: false` fuse must be verified against `utilityProcess` in a
  *packaged* build, not assumed.

**Open**

- MCP, skills and hooks are not yet in `agent-core`. When added, they belong
  there — shared with the cloud runner — not in the desktop app.
