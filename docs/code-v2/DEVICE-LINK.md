# Alevr Code v2: device link (hosted web → the user's Mac → env server)

The env server (`runner/env-server`) listens only on 127.0.0.1, behind a token that is minted for each launch. The hosted web at alevr.com/code cannot reach it directly. The device link is how the hosted web drives sessions on the user's Mac, including bring-your-own-subscription sessions, which can only run there. The relay carries **alevr-code-v2 wire messages and nothing else**.

```
browser ──POST /api/code/v2/link/<deviceId>       {kind:"rpc"|"poll"}──┐
                                                                         ▼
                                                     EnvLinkHub (backend memory)
                                                                         ▲
Mac app ──POST /api/code/v2/link/<deviceId>/host  {kind:"pull"|"push"}──┘
   │  dedicated WebSocket, Bearer <launch token>
   ▼
alevr-env (127.0.0.1)
```

Implementation:

- Hub: `src/lib/code-v2/env-link-hub.ts` (pure, unit-tested)
- Routes: `src/app/api/code/v2/link/[deviceId]/route.ts` (browser) and `.../host/route.ts` (Mac)
- Browser client: `DeviceLinkTransport` in `src/lib/code-v2/env-client.ts` (web lane)
- Tests: `tests/code-v2-env-link.test.ts`. They include an end-to-end run through a real env server and a forwarder that behaves exactly as the Mac must (see "Mac side").

Both routes authenticate as the signed-in Alevr user (`requireUser`: the web session cookie, or the Mac's native bearer) and require a `CodeDevice` row that this user owns. It is the same pairing that the v1 device command channel (`/api/code/devices/*`) uses.

## Browser side (already implemented by the web lane)

`POST /api/code/v2/link/<deviceId>`

| Body | Reply |
|---|---|
| `{kind:"rpc", command: ClientCommand}` | `{responses:[ServerResponse]}` with the caller's `command.id`. Or `{offline:true, message}` when the Mac has not pulled in the last 40 s. |
| `{kind:"poll", cursors:{[sessionId]: lastAppliedSequence}, globalCursor}` | `{events: ServerEventEnvelope[]}` holding every event after each cursor (or from the newest snapshot after it). It waits up to 20 s when there are none. `{offline:true}` when the Mac is offline. |

- RPCs wait up to 30 s for the Mac. After that the reply is a `not_ready` response saying "Your Mac did not answer in time."
- Use a cursor of `-1` before the first snapshot. Events still go through `classifyEvent` on the client.
- The hub renumbers global-stream events (`provider.updated` and others). A `globalCursor` from before a backend restart gets everything the hub still holds.

### What the web may NOT relay

`terminal.*`, because it is a shell on the user's Mac, and `env.configure`, because it carries secrets and the Mac supplies its own. The hub refuses them with `unsupported`. The allow-list is `LINK_RELAYED_COMMANDS`: session open/list/close, turn start/steer/queue/interrupt, approval.respond, checkpoint diff/rollback, provider list/probe/setup. The **Mac must enforce the same list** (defence in depth). `provider.setup` only returns the command to type, and the web shows it with "run this on your Mac".

## Mac side: the hook for the Mac lane

The `DesktopCodeHostModel` (`native/macOS/JunoDesktop/App/DesktopCodeHost.swift`) already pairs the Mac (`POST /api/code/devices`) and long-polls v1 commands. Add a **v2 relay loop** next to it. It runs only while all of these hold:

1. The user is signed in and the device is paired (the same gates as v1 hosting).
2. The env server sidecar is running (`EnvServerSidecar`) and the Mac holds its launch token.
3. The user turned on **"Use this Mac from Alevr on the web"** in Settings › Code. It is off by default, and the copy should say that the web can start and approve agent turns on this Mac.

The loop:

```text
open a dedicated EnvServerConnection (WebSocket, Bearer <launch token>), separate from the UI's own
loop:
  reply = POST /api/code/v2/link/<deviceId>/host {kind:"pull", protocol:"alevr-code-v2", appVersion, waitMs:25000}
          (the request itself is the heartbeat; keep a 30 s client timeout; on 404 the pairing is gone → stop)
  for command in reply.commands (in order):
      if command.type not in LINK_RELAYED_COMMANDS → answer {type:"response", id, ok:false, error:{code:"unsupported", …}}
      else send it unchanged on the relay WebSocket (keep its id: the hub maps it back)
on every message from the relay WebSocket (responses AND events, in arrival order):
  append to an outbox; flush it within ~50 ms:
      POST …/host {kind:"push", responses:[…], events:[…]}   (≤1000 items per push; split larger batches)
on relay WebSocket close: reconnect with backoff; nothing else to do (see "Replays")
```

Rules:

- **Order matters.** Push events and responses in the order the env server sent them. When the hub replays a session, it relies on the env server sending replayed events *before* the `session.open` response, and the env server does.
- **Forward everything** the relay connection receives. That connection only gets events for the sessions the web opened through it, plus the global stream.
- Back off (1, 2, 4… max 15 s) on network errors. A `409` on pull means the protocol does not match. Log it and stop until the app updates.
- Never forward the launch token, BYOK keys or the backend authorization. They exist only between the Mac app and its env server.

### Replays: why a backend restart loses nothing

The env server's append-only log on the Mac is the source of truth. The hub keeps a bounded ring of recent events for each session. When a browser polls with a cursor the ring cannot serve (after a backend restart, or a browser that slept), the hub queues a synthetic `session.open {sessionId, cwd:"/", afterSequence: cursor}` for the Mac. The env server replays exactly the missed events to the relay connection, the Mac pushes them, and the next poll returns them. The Mac does not need to know replays exist: it forwards the command like any other.

## Limits (`LINK_LIMITS`)

Mac online window 40 s · host pull wait 25 s · browser poll wait 20 s · RPC timeout 30 s · 200 queued commands per device · ring of 2,000 events per session and 500 global · 200 sessions per device · 1,000 items per push · 100 commands per pull · request bodies of 1 MB (browser) and 8 MB (Mac).

## Deployment note

The hub lives in the backend process's memory. Production runs `juno-backend` as a single Node process (`deploy/ecosystem.config.js`, fork mode), so one hub serves every request. If the backend ever runs more than one process, put a shared store behind `EnvLinkHub` (Postgres `LISTEN/NOTIFY` or a table with the same shape). The routes and the Mac protocol do not change.
