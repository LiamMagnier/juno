# Agent host

The process that runs Juno's coding agent.

`@juno/agent-core` is a complete TypeScript agent runtime: the turn loop,
provider adapters, the tool set, the permission engine, checkpoint/undo, session
persistence and subagent orchestration. This directory does not reimplement any
of it. It **hosts** it — in a separate OS process, behind a validated message
contract — and adds the three things that only matter once the agent's callbacks
have a process boundary in the middle of them.

```
┌───────────────────┐   IPC (contextBridge)   ┌──────────────────┐
│     renderer      │ ──────────────────────► │       main       │
│  (sandboxed, no   │ ◄────────────────────── │  credentials,    │
│   Node, no fs)    │      src/shared/ipc.ts  │  windows, DB     │
└───────────────────┘                         └────────┬─────────┘
                                                       │  utilityProcess
                                        postMessage /  │  MessagePort
                                     src/agent-host/host-protocol.ts
                                                       │
                                              ┌────────▼─────────┐
                                              │    agent host    │
                                              │  AgentSession ×N │
                                              │  tools, bash,    │
                                              │  subagents       │
                                              └──────────────────┘
```

| File | Owns |
| --- | --- |
| `host-protocol.ts` | The wire contract, both directions, in Zod. No I/O. |
| `session-manager.ts`| The live `AgentSession` set, approvals, bounding, teardown. No transport. |
| `index.ts` | The `utilityProcess` entry: the port, the counters, signals, shutdown. |

The split is not decorative. `session-manager.ts` imports no Electron and no
transport, so it can be driven by a fake `send` in a unit test; `index.ts` is
small enough that "every inbound frame is parsed before it is acted on" is a
claim you can verify by reading one function (`handleFrame`).

---

## Why `utilityProcess` and not a WebSocket

agent-core ships a localhost WebSocket sidecar (`startSidecarServer`, in
`runner/agent-core/src/server.ts`) and the Swift Mac client used it. That was not
a design preference — it was a workaround for a hard constraint: a Swift app
cannot embed Node, so the only way to reach a Node agent runtime was to launch it
as a separate program and talk to it over a socket.

Electron *is* Node. The constraint is gone, and with it the reasons to keep
paying for it:

- **No listening port.** The sidecar bound `127.0.0.1:<port>`. Every process on
  the machine can connect to a loopback port — every other app, every browser
  tab via a DNS-rebinding or a `ws://localhost` fetch, every script the user
  ran once. The thing on the far end of that port can read the user's source
  code, write to it, and run shell commands. A `MessagePort` handed to a child
  by its own parent is reachable by exactly two processes and is not addressable
  from anywhere else on the system.
- **No shared secret.** `SidecarOptions.token` existed because a port is
  reachable, so it needed an authentication story: mint a token, get it to the
  client, compare it in constant time, and find somewhere to keep it that is not
  a command line (visible in `ps`), an environment variable (inherited by every
  child, including agent-authored shell commands) or a file. None of that exists
  here. The capability *is* the port handle.
- **No serialisation of the whole world.** Frames are structured-cloned rather
  than JSON round-tripped through a socket.
- **A real lifecycle.** `utilityProcess` is a child of the app: it dies when
  Electron dies, `kill()` reaches it, and its exit is observable. A sidecar bound
  to a port is a process the app hopes is still there, and its port is a
  rendezvous point that a *stale* sidecar from a previous run can still be
  squatting on.
- **One credential holder.** Provider keys stay in main; the host never receives
  one over the port (see *Compromises*).

The message vocabulary is deliberately still the sidecar's — `start`, `resume`,
`prompt`, `approval`, `set_mode`, `undo`, `diff`, `list_sessions`, `abort` —
because the relay, the cloud runner and the Swift clients already speak it, and
a second vocabulary would be a second thing to keep in sync. What changed is the
framing, and only where the transport forced it.

---

## The contract

Everything is in `host-protocol.ts`. Both directions are discriminated unions
parsed with Zod at the receiving end. The host parses because a frame from main
is still a frame from another process; main parses because
`THREAT_MODEL.md` treats a compromised agent host as in scope, and the host is
the process that runs agent-authored shell commands.

### Main → host

| Command | Carries | Reply |
| --- | --- | --- |
| `configure` | `backend` (proxy credentials) or `null` | `ack` |
| `start` | `cwd`, `provider?`, `model?`, `mode?` | `session_started` |
| `resume` | `sessionId`, `mode?` | `session_started` |
| `prompt` | `sessionId`, `text` | `ack` (accepted, **not** finished) |
| `approval` | `sessionId`, **`callId`**, `decision` | `approval_settled` |
| `set_mode` | `sessionId`, `mode` | `ack` |
| `undo` | `sessionId` | `undo_result` |
| `diff` | `sessionId`, `sinceTurn?` | `diff_result` |
| `list_sessions` | — | `sessions` |
| `abort` | `sessionId` | `ack` |
| `close_session` | `sessionId` | `ack`, then `session_closed` |
| `heartbeat` | — | `heartbeat` |
| `shutdown` | `graceMs?` | `shutdown_complete`, then exit |

### Host → main

`ready`, `session_started`, `event`, `approval_settled`, `ack`, `diff_result`,
`undo_result`, `sessions`, `session_closed`, `command_error`, `protocol_error`,
`heartbeat`, `shutdown_complete`, `log`.

### Three additions the socket protocol did not have

**`seq`** — a monotonically increasing counter per direction. A `MessagePort`
delivers in order, so this is not a reordering fix; it is a replay guard. A frame
whose `seq` does not advance is dropped with a `protocol_error{code:"stale_seq"}`.
The counter and the process share a lifetime — main mints a fresh counter for
each host it forks — so a non-advancing `seq` is never a legitimate restart.
Outbound, `seq` is stamped by the single function that writes to the port and is
not something a caller can supply, which is what makes "monotonic" a property of
the code rather than a rule contributors must remember.

**`requestId`** — correlates a command with its reply. The sidecar matched a
`diff` reply to a `diff` request by being the next `diff`-shaped frame to arrive,
which is only true while exactly one request is ever in flight.

**`sessionId`** — on every frame that concerns a session. The sidecar held one
session per connection and needed no addressing; the host multiplexes, so a frame
without a session id is a frame that can be applied to the wrong session.
`start` is the sole exception: the id is minted by `SessionStore.create` inside
agent-core and is not knowable until the session exists, so `start` carries a
`requestId` and the host answers with the new id.

**Approval requests travel inside the ordinary event stream**, as agent-core's
`approval_requested` event, not on a channel of their own. The surface has to
render the prompt in the position agent-core emitted it; a side channel would let
the prompt overtake the `tool_started`-adjacent events that explain what it is
asking about.

---

## Approvals: the round trip, and why a replay cannot fire twice

agent-core asks for permission by calling `AgentCallbacks.requestApproval(request)`
and `await`ing the promise it returns. Inside `AgentSession.executeToolCall`, the
tool does not run until that promise resolves, and it does not run at all if the
promise resolves `deny`. So the host's entire job is: turn one promise into one
round trip, and make sure the promise is settled exactly once, by a real user
decision or by `deny`.

```
agent-core                 session-manager                 main / renderer
    │                            │                               │
    │ requestApproval(req) ──────►                               │
    │   (awaits)             pending.set(callId, resolve)        │
    │                            │                               │
    │ emit approval_requested ───► event ──────────────────────► │  user sees a card
    │                            │                               │
    │                            ◄──── approval{callId,decision} │  user decides
    │                       pending.delete(callId)  ← atomic     │
    │ ◄──────── resolve(decision)                                │
    │                            ├──── approval_settled ───────► │
    │ tool runs, or not          │      {outcome: applied}       │
```

**The guarantee is structural, not bookkeeping.** A decision can only be applied
by taking the resolver *out* of `pending`, and the entry is deleted in the same
synchronous step it is taken (`settleApproval`). A replayed frame — a reconnect,
a retried IPC call, a duplicated message — finds nothing to take and can
therefore do nothing. There is no window: JavaScript is single-threaded and the
take-and-delete is one uninterrupted step.

The `decided` map is *not* the lock. It exists so the reply can tell main which
of three things happened:

| `outcome` | Meaning |
| --- | --- |
| `applied` | The decision settled a waiting call. |
| `duplicate_ignored` | That call was already decided; the earlier decision stands and is echoed back. |
| `unknown_call` | No such waiting call, and no memory of one. Nothing happened. |

`decided` is a bounded FIFO (512 per session). Losing an old entry cannot make a
replay *apply* — it only downgrades the report from `duplicate_ignored` to
`unknown_call`. Both are inert.

**Fail closed, everywhere.** The host has exactly one way to produce `allow`: a
validated inbound `approval` frame naming that exact `callId`. Every other path
out of a wait resolves `deny`:

- the session was aborted (Stop) — and, until the next `prompt`, *new* requests
  are denied on arrival rather than parked;
- the session was closed;
- the host is shutting down;
- the optional approval timeout expired (off by default: a user may reasonably
  take minutes, and an auto-deny on a slow reader is its own bug);
- a second request arrived for a `callId` that is already waiting. The newcomer
  is denied rather than allowed to overwrite the resolver, because overwriting
  strands the first promise — and the first promise is the one a user may be
  looking at.

**Abort must deny before it aborts.** `AgentSession.abort()` signals an
`AbortController` that the provider stream and the subagent manager observe. A
turn parked on `await requestApproval(...)` is observing nothing, so aborting
around it leaves the loop suspended forever on a promise nobody will settle. The
sidecar has the same shape and only escapes it because closing the socket denies
everything on the way out. Here, `SessionManager.abort` denies first, then calls
through.

---

## Shutdown and the orphan-process contract

Every termination path — `shutdown` command, SIGTERM (which is what
`utilityProcess.kill()` sends), SIGINT, SIGHUP, a lost port, an uncaught
exception — converges on one `shutdown()` that runs at most once.

1. **Refuse and deny.** New work is rejected with `shutting_down`; every waiting
   approval in every session is denied. Denying first is what lets a turn parked
   on an approval reach its abort check instead of sitting on a promise while the
   grace clock runs.
2. **Abort every session,** which is also how agent-core cancels subagents
   (`AgentSession.abort` calls `SubagentManager.cancelAll`).
3. **Wait, bounded** (`graceMs`, default 5s) for in-flight turns to unwind, so
   agent-core's own `onMessagesChanged` writes their transcripts.
4. **Mark interrupted.** Any child agent still running gets
   `SubagentManager.markAllInterrupted()`, so its stored state says *the process
   quit while this agent ran* rather than *running*.
5. **Reap.** See below.
6. **Report** `shutdown_complete{cancelledSessions, deniedApprovals,
   reapedProcessGroups, forced}`, flush the port, exit.

`forced: true` means the grace period expired with turns still running — main
should treat that as a signal worth logging, not a normal outcome.

### The reaper, and the honest limits of it

agent-core's `bashTool` spawns with `detached: true`, deliberately: it wants its
own timeout to be able to kill a whole process tree via the negative pid. The
side effect is that those children are process-group leaders that **do not die
when the host dies**. And `ToolContext` carries no `AbortSignal`, so a command
already running cannot be interrupted through agent-core's API at all —
`AgentSession.abort()` stops the model stream and the subagents, never the shell.

So after the grace period, `reapDetachedChildren()` takes one `ps -A -o
pid=,ppid=,pgid=` snapshot and `SIGKILL`s the process group of every direct child
where `pgid === pid` — a group led by the child itself, which is exactly what
`detached: true` produces.

The `pgid === pid` condition is a safety interlock, not an optimisation.
Signalling a group we *share* would signal us, and on macOS that group can
contain the whole Electron app. A child spawned without `detached` is therefore
left alone.

What this does not reach, stated plainly:

- Grandchildren that were re-parented after their own leader exited. No pid-based
  method can find those; they are not our descendants any more.
- Anything on Windows (the function returns 0 there).
- Anything at all if the host is `SIGKILL`ed rather than `SIGTERM`ed — no
  handler runs. **Main must send `shutdown` or SIGTERM and wait for
  `shutdown_complete` (or the grace period) before escalating to `kill()`.**

`process.on('disconnect')` is wired as a belt-and-braces path but should not be
relied on: `utilityProcess` communicates over a `MessagePort`, not the
`child_process` IPC channel that raises that event.

---

## Bounding

Everything that crosses the boundary is copied into another heap, so nothing
unbounded is allowed to cross.

- **Assistant deltas are coalesced** into ~33ms windows (or 8 KiB, whichever
  comes first) rather than forwarded per token. A turn produces thousands of
  them, each otherwise costing a structured clone and an IPC hop. Merged deltas
  are still `assistant_delta` events with concatenated text, so a renderer that
  appends sees no difference. Any non-delta event flushes the buffer first, which
  is what keeps the merge from reordering text against the tool events
  interleaved with it.
- **Per-turn streamed text is capped** (4 MB). Past it deltas are dropped, once,
  with a `log` line. Reported as host diagnostics rather than a synthetic `error`
  event, because the turn is not in error and inventing an event would put a lie
  in the persisted event log.
- **Tool inputs are clamped.** agent-core truncates `tool_finished.output` at
  2000 chars already, but not `tool_started.input` — which for a `write_file`
  call is the entire file being written. Strings inside it are clamped to 8 KiB.
  `approval_requested` gets a far larger allowance (64 KiB) with an explicit
  `…[truncated]` marker, because that payload is what a human is being asked to
  authorise and a silently truncated preview of a destructive action is worse
  than a large message.
- The same clamping walk rebuilds the value out of plain objects, arrays,
  strings, finite numbers and booleans, which doubles as a structured-clone
  guard: `input` is `unknown`, and `postMessage` throws on values the clone
  algorithm cannot copy.
- **Diffs** are capped at 2 MB with a `truncated` flag.
- **Live sessions** are capped (8). Each one can hold child processes; unbounded
  sessions is unbounded everything.
- Prompt text, paths, identifiers and the backend catalogue all have schema-level
  ceilings (`LIMITS`), so an oversized frame is rejected before anything is
  allocated for it.

---

## Secrets

**agent-core has no redaction helper.** This was checked rather than assumed:
grepping the package for `redact`/`scrub`/`sanitize` finds only *avoidance* —
`bash.ts` builds a `MINIMAL_ENV` instead of handing `process.env` to
agent-authored commands, `session.ts` replaces screenshot bytes with a marker
before persisting, `agent.ts` truncates tool output in events. All good, none of
it reusable as a redactor.

So `host-protocol.ts` provides a local `redactSecrets()` and everything the host
emits as text goes through it: `log` lines, `command_error` and `protocol_error`
messages, and Zod's own validation output (which quotes received values on enum
and literal mismatches — and one of the fields being validated is a session
cookie). It matches credential *shapes* — known key prefixes, `Authorization` /
`Cookie` header values, `KEY=`/`TOKEN=`/`SECRET=` assignments, JWTs — and
nothing else, deliberately: a redactor that mangles ordinary prose gets turned
off.

Beyond that, the host **never logs a payload**. Log lines name a command's
`type`, never its contents. Stack traces are dropped from messages that leave
the process (they name absolute paths under the user's home); they stay on the
host's stderr for a developer build.

---

## Build and wiring

Owned elsewhere, recorded here because it is load-bearing:

- `electron.vite.config.ts` builds `src/agent-host/index.ts` as a second `main`
  entry, emitted with a stable name to `out/main/agent-host.js`. Main forks it
  with `utilityProcess.fork()`.
- TypeScript consumes agent-core through its **emitted declarations**
  (`runner/agent-core/dist/*.d.ts`, via the `file:` dependency), so
  `runner/agent-core` must be built before `npm run typecheck`. Vite's alias
  points at agent-core's `.ts` source for bundling. Both routes are the same
  package; only the build order differs.
- The host must be forked with whatever provider environment main wants it to
  have (see below). It reads no configuration of its own beyond `JUNO_HOME`,
  which agent-core uses to locate `~/.juno/sessions`.

---

## Compromises forced by agent-core's API

Recorded rather than papered over. None of these are worked around by editing
`runner/agent-core` — it is shared production code with three other consumers.

1. **`createProviderFromSpec` is not exported.** It exists
   (`providers/registry.ts`) and would let main inject an API key it holds in the
   Keychain, per session, without the key ever touching disk or an environment.
   `src/index.ts` does not re-export it, so it is not reachable through
   `@juno/agent-core`. The host therefore resolves BYOK providers with
   `createProvider(id)`, which reads `ANTHROPIC_API_KEY` &c. from the
   environment or `~/.juno/credentials.json`. **Consequence: main must pass
   provider keys in the host's `env` at fork time.** Backend-proxied providers
   avoid this entirely — `configure` carries the cookie over the port and
   `createProxyProvider` *is* exported — which is the better path where it is
   available. Exporting one symbol from agent-core would remove this note.
2. **No cancellation for a running tool.** `ToolContext` has `cwd`, `env` and
   `containerSandbox` — no `AbortSignal`. A shell command that has started runs
   to completion or to its own timeout, whatever the user pressed. This is why
   abort is not instantaneous and why shutdown needs a reaper.
3. **`detached: true` on every bash spawn** makes those children survive the
   host. The reaper is best effort and cannot reach re-parented grandchildren.
4. **`AgentSession` has no `dispose()`/`close()`.** Closing a session means
   aborting it and dropping the reference; there is no way to tell the object its
   life is over, and no hook to release whatever it holds.
5. **`AgentSession.resume(id, opts)` requires a `cwd` it then ignores** (the
   stored one wins). The host passes the stored value rather than the sidecar's
   `''`, so the argument is at least not a lie.
6. **`SessionStore.list()` is synchronous filesystem I/O** — it stats and parses
   every stored session's `meta.json` on the host's only thread. Fine at a few
   hundred sessions; it is a blocking call and it grows.
7. **Two objects, one directory.** `AgentSession.resume` on a session already
   live would give two objects an independent view of the same `messages.json`,
   and the loser's `saveMessages` would overwrite the winner's transcript.
   agent-core does not guard this, so `SessionManager.resume` is idempotent on a
   live session and returns the existing one.
8. **Turn errors arrive on two channels.** agent-core catches loop failures
   itself and emits an `error` event; failures *outside* the loop (a refused
   usage reservation, an unusable provider) reject `prompt()`. The host reports
   the latter as both an `error` event and a `command_error`, because neither
   channel alone is complete.
