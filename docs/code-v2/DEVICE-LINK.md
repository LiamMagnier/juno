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

### The push stream (the phone's fast path)

`POST /api/code/v2/link/<deviceId>/stream {cursors, globalCursor}` answers `text/event-stream`: one `data: {"events":[...]}` frame per batch the moment the Mac pushes it, `: ping` every 15 s, `data: {"offline":true,...}` (then it ends) and `data: {"error":...}` when the pair is gone. The cursors advance inside the stream; the window is 55 s and the phone reopens at once (and whenever it follows another session, or after a gap so the replay is collected). The sign-in, device and pair are checked when it opens, and the pair again before events go out at most every 5 s, instead of two lookups per batch as with the poll. An older backend answers 404/405 and the phone falls back to `{kind:"poll"}` (`src/lib/code-v2/link-stream.ts`, `CodeLinkClient.stream`).

`session.setMode {sessionId, runtimeMode, interactionMode?}` (access lane) applies the composer's access picker to the thread at once, mid-turn included; switching to Full access answers the waiting approvals Full access would not have asked about.

### What the web may NOT relay

`env.configure`, because it carries secrets and the Mac supplies its own: the hub always refuses it with `unsupported`. `terminal.*` (a shell on the user's Mac) is relayed **only while the Mac's latest pull says `terminal: true`**, which it does only when the user turned on **Share this Mac's terminal** under Remote hosting (off by default; `LINK_TERMINAL_COMMANDS`). The allow-list is `LINK_RELAYED_COMMANDS`: session open/list/close, turn start/steer/queue/interrupt, approval.respond, checkpoint diff/rollback, provider list/probe/setup, plus the runtime lane's `checkpoint.applyPatch` (reject a hunk), `turn.schedule` / `turn.unschedule` (resume at reset), `provider.install` and `provider.auth` (Antigravity). The **Mac must enforce the same list** (defence in depth). `provider.setup` only returns the command to type, and the web shows it with "run this on your Mac".

Terminal output and `provider.updated` ride the global stream; the browser's `DeviceLinkTransport.followGlobal()` keeps polling it with no session open (a sign-in terminal from Connections has none). The Terminal tab is xterm.js: keystrokes are batched per frame into `terminal.write`, the fit addon sends `terminal.resize`.

## Mac side (implemented)

`EnvServerDeviceLinkChannel` (`native/Packages/JunoCode/Sources/JunoCodeLocal/EnvServer/EnvServerDeviceLink.swift`) drains the hub for this Mac, and `CodeV2DeviceLinkHost` wires it to the app's `EnvServerHub`. `DesktopCodeHostModel.syncEnvLink` starts it only while **Remote hosting** is on (off by default; the same switch that lets a phone drive this Mac), the user is signed in and the Mac is paired; turning Remote off stops it.

The loop, as built:

```text
loop:
  reply = POST /api/code/v2/link/<deviceId>/host {kind:"pull", protocol:"alevr-code-v2", appVersion, waitMs:25000, terminal, receipts:true}
          (the pull is the heartbeat; 404 = unpaired and 409 = other protocol both stop the loop; other errors back off 1, 2, 4… 15 s)
  for command in reply.commands: once per relay id (see "Receipts"), run it on its own task through EnvServerDeviceLink.run(command)
      - the same allow-list as the hub; terminal.* only when the user shared the terminal; env.configure never
      - session.open / terminal.open only inside a folder this Mac shares with Remote
      - turn/approval/checkpoint/close/setMode only for sessions the link opened, or any session whose own
        folder is shared (looked up once with session.list): a thread started on the Mac reaches the phone,
        approval included, before the phone opens it, and after the app restarts
      - a session already followed may be re-opened (the hub's replay open carries cwd "/")
      → its response goes to the outbox
every env-server event arrives through one ordered stream (EnvServerHub relay sink → AsyncStream → link.record):
  provider.updated, and events of those sessions (terminal output only when shared) → outbox
outbox: the first item after a quiet spell leaves at once; one push on the wire at a time, everything that
  arrives meanwhile rides the next (≥15 ms apart), in arrival order, ≤1000 items per POST …/host {kind:"push", responses, events}
```

The relay uses the app's shared env-server connection (`EnvServerHub`), so the launch token, BYOK keys and the backend authorization never leave the Mac.

### Receipts: a command delivered twice runs once

`EnvLinkReceipts` (`EnvServer/EnvLinkReceipts.swift`) keeps, per relay id (`link_<uuid>` / `replay_<uuid>`), whether the command is running or finished and the answer it gave, one small file each in `~/Library/Application Support/Juno/device-link-receipts` (newest 256, ten minutes; written before the command runs and again when it finishes). A repeat delivery is answered from it: nothing while the first still runs, the kept answer once it finished. A receipt a previous launch left running answers with an error instead (the app quit mid-command, so part of it may have happened); an answer over 128 KB is kept as an error saying it was too large to send again. Nothing is ever run a second time.

The pull says `receipts:true` only with that durable store. For such a pull, and only then, the Postgres store hands out again a lease older than 8 s that is still unanswered (`leaseRedeliverMs`), at most 3 deliveries in all (`maxDeliveries`, inside the 30 s RPC window), so a lost pull reply costs seconds instead of the RPC timeout. A pull without the flag (an older Mac) keeps the at-most-once lease. Whichever delivery's answer lands first acknowledges the row; the rest, and any after the RPC gave up, are dropped. A pull the Mac hung up on gives its delivery back. The in-memory hub hands each command out once and has nothing to redeliver.

### Replays: why a backend restart loses nothing

The env server's append-only log on the Mac is the source of truth. The hub keeps a bounded ring of recent events for each session. When a browser polls with a cursor the ring cannot serve (after a backend restart, or a browser that slept), the hub queues a synthetic `session.open {sessionId, cwd:"/", afterSequence: cursor}` for the Mac. The env server replays exactly the missed events to the relay connection, the Mac pushes them, and the next poll returns them. The Mac does not need to know replays exist: it forwards the command like any other.

## Limits (`LINK_LIMITS`)

Mac online window 40 s · host pull wait 25 s · browser poll wait 20 s · RPC timeout 30 s · 200 queued commands per device · ring of 2,000 events per session and 500 global · 200 sessions per device · 1,000 items per push · 100 commands per pull · request bodies of 1 MB (browser) and 8 MB (Mac).

## Deployment note

By default the hub lives in the backend process's memory. Production runs `juno-backend` as a single Node process (`deploy/ecosystem.config.js`, fork mode), so one hub serves every request.

For more than one backend process, set `ALEVR_LINK_STORE=postgres`. The routes then use `PgLinkHub` (`src/lib/code-v2/env-link-store-pg.ts`, chosen in `env-link-select.ts`) behind the same `LinkHub` / `LinkEndpoint` interface: commands in `CodeLinkCommand` (leased with `FOR UPDATE SKIP LOCKED`, so two processes never hand the same one to the Mac; a pull the Mac hung up on puts its leases back; an unanswered lease is handed out again only to a Mac whose pull says it keeps receipts, a bounded number of times, see "Receipts", and never to one that does not, since a second delivery could run an action twice), answers in `CodeLinkResponse` (stored only together with deleting their own leased command, so a late answer, a repeat or another account's id is dropped; read once), the event rings in `CodeLinkEvent` (deduplicated by a unique key, trimmed to the same limits), the replay floor in `CodeLinkSession` and the heartbeat and global numbering in `CodeLinkHost` (a global event is numbered and inserted in one transaction under the host row's lock, so a number never becomes visible before its event or after a later one, and a retried batch is deduplicated under the same lock). Waiting is a 250 ms poll of the tables plus an in-process wake; no LISTEN/NOTIFY is needed. Migrations: `prisma/migrations/20261009120000_code_v2_link_hub`, `20261014200000_code_link_redelivery` (the lease count). `tests/code-v2-env-link-pg.test.ts` runs every scenario against both stores (the Postgres half with `CODE_LINK_TEST_DATABASE_URL`); `tests/code-v2-link-concurrency-pg.test.ts` drives real interleavings, rollbacks and dropped connections against a disposable database. The routes and the Mac protocol do not change.

Runtime-lane commands the relay also carries: `checkpoint.applyPatch` (reject a hunk on the Mac), `turn.schedule` / `turn.unschedule` (resume at reset), and `provider.install` / `provider.auth` (Antigravity's install and Google sign-in; the pasted-redirect fallback exists for exactly this remote case). The Mac's `EnvServerDeviceLink.remoteCommands` lists the same ones, and the session-scoped ones only work on sessions opened through the link.
