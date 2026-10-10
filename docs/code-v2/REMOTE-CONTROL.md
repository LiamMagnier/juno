# Alevr remote control, hand-off and sync

Driving Alevr Code on a Mac from an iPhone or a browser, the way the Codex app's "Control this Mac remotely" works, plus moving an open thread between devices. It builds on the device link (`DEVICE-LINK.md`): the phone and the web talk alevr-code-v2 to the Mac through the backend hub. This document adds who may do that (pairing), what else they may do (the remote lane), and how threads follow you (hand-off and sync).

## 1. Pairing

```
Mac  Settings › Connections › Control this Mac remotely  (also Code settings)
 │   POST /api/code/pairing {deviceId, kind:"phone"|"browser"}      native sign-in only
 │   ← {id, token, url, code?, expiresAt, deviceName}
 │   sheet: Phone | Computer
 │     Phone:    QR of url = <app>/pair?t=<token>, Continuum logo in the centre
 │     Computer: <app>/pair and the code "K7QM-4MZP"
 │   polls GET /api/code/pairing/offers/<id> → pending | approved{pair} | denied | expired
 ▼
iPhone  scans (AVFoundation) or opens the link (/pair?t= or com.liammagnier.juno://juno/pair?t=)
 │   POST /api/code/pairing/inspect {token} → {deviceName, expiresAt, …}
 │   "Allow this iPhone to control Alevr on <Mac>?"  Approve | Deny
 │   POST /api/code/pairing/approve {token} → {pair}    or  /deny
Browser  opens <app>/pair, types the code, same screen, approve sets the alevr_remote cookie
```

- The token is `rcp1.<payload>.<hmac>`: HMAC-SHA256 under a key derived from `AUTH_SECRET`, naming the offer row, the account, the Mac, the kind and the expiry. Only its sha256 is stored (`PairingToken.tokenHash`). A browser code is 8 characters from an alphabet without 0/O/1/I/L/U, stored as a hash too.
- **Two minutes, single use.** Approve and deny both consume the offer with one conditional update (`consumedAt IS NULL AND status='pending' AND expiresAt > now`), so two approvals race to one pair. An expired, used, forged, other-account or wrong-kind offer is refused before anything is shown; another account's token is a 404 that does not reveal the offer exists.
- **A pair** (`DevicePair`) binds one controller to one Mac. A phone by its native sign-in (`deviceSessionId`), so signing that phone out ends it; a browser by the sha256 of a random 32-byte `alevr_remote` cookie (httpOnly, SameSite=Lax, 400 days) minted on approval. Re-pairing the same controller with the same Mac replaces the old pair.
- The Mac lists its pairs (`GET /api/code/pairing/pairs?deviceId=`) with Remove (`DELETE /api/code/pairing/pairs/<id>`). The phone lists the Macs it may drive (`GET /api/code/pairing/pairs`).
- Pairing routes are rate limited (20 tries a minute per account); creating an offer needs the Mac app's native sign-in.

Implementation: rules in `src/lib/code-v2/device-pairing.ts` (pure, behind a `PairingStore`), Prisma in `device-pairing-store.ts`, routes under `src/app/api/code/pairing/`. Tests: `tests/remote-control-pairing.test.ts`, `tests/remote-control-routes.test.ts`.

## 2. Security model

Every remote command passes three checks, in order:

1. **Same account**: `requireUser` (web cookie or native bearer).
2. **Owns the Mac**: a `CodeDevice` row of this user.
3. **Live pair**: `requireRemotePair(req, userId, deviceId)`: a `DevicePair` for this Mac, not revoked, matching this phone's live native sign-in or this browser's cookie. Refused with 403 `{code:"not_paired"}` and a message saying where to pair.

The guard runs on the device link (`POST /api/code/v2/link/<deviceId>`, before the hub and again before a long-poll's events go out, so a pair removed while a poll waits delivers nothing more) and on every v1 control command (`commands` enqueue, `messages`, `stop`, `approvals`, session `PATCH`/`DELETE`). The Mac's own host routes (`…/host`, session sync) are unchanged: they are the Mac, not a controller. Backend-originated link commands (`conversation.deliver`) do not pass through the route.

The Mac keeps its own defence in depth (`EnvServerDeviceLink`): only the allow-listed commands; sessions, terminals and the folder browser only inside folders shared with Remote; turn, approval, checkpoint and git commands only on sessions opened through the link; `terminal.*` only while **Share this Mac's terminal** is on; `env.configure` never. Turning **Control this Mac remotely** off stops the link at once.

## 3. Remote capabilities (the remote lane)

Everything the Mac's own Code window does over the env server, the phone does over the link: `session.list` / `open` (a live session list with states, a snapshot plus cursor stream), `turn.start` with model (subscriptions included), effort, mode (Full access included), team (`routing`) and skills, `turn.steer` / `queue` / `interrupt`, `approval.respond`, `checkpoint.diff` and `checkpoint.applyPatch {reverse:true}` (per-hunk revert), `terminal.*` (when shared), `skills.list`, `provider.list`.

Added, additive in the contract (`src/lib/code-v2/contracts.ts`, mirrors, schema, fixtures):

| Command | Answered by | Result |
|---|---|---|
| `fs.list {path, files?, showHidden?}` | env server | `{path, parent?, entries:[{name, path, kind:"dir"\|"file", isRepo?}]}`; the Mac allows only paths inside its shared folders |
| `git.status {sessionId? \| cwd?}` | env server | branch, upstream, ahead/behind, changed files, `canOpenPr` (gh signed in), `remoteUrl` |
| `git.commit {sessionId, message}` | env server | `git add -A` then commit as the user's own identity → `{sha, summary}` |
| `git.push {sessionId}` | env server | push, setting `origin` upstream on first push → `{branch, remote}` |
| `git.pr {sessionId, title, body?, draft?, base?}` | env server | `gh pr create` → `{url}` |
| `host.info {}` | the Mac app | `{name, sharedFolders, terminal, captures, appVersion}` |
| `host.capture {target:"preview"\|"simulator"}` | the Mac app | `{mime:"image/png", data(base64), width, height, at}` |

Git commands run without prompts (`GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`), so a push that needs a password fails with the reason instead of hanging.

## 4. Approvals from a notification

When the Mac pushes an `approval_request` item (added, updated, or inside a snapshot) that is pending, the host route rings **the paired phones only** (`DevicePushToken.deviceSessionId` in the Mac's live phone pairs, each device's "needs you" switch respected): category `ALEVR_CODE_APPROVAL` with actions `alevr.approval.allow-once` and `alevr.approval.deny`, `userInfo {link:"v2", deviceID, sessionID, requestID}`, collapse id = request id. The action answers through the link (`approval.respond` with `accept` or `decline`) like the in-app card. Once the item is no longer pending, a background push `{clearApproval:<requestId>}` withdraws the delivered notification on every paired phone. Both are deduplicated per request id, so a replayed snapshot never rings twice and never rings after the answer. (`src/lib/code-v2/remote-push.ts`.)

## 5. Hand-off and sync

**Apple Handoff.** Both apps advertise the open Chat or Code thread as `NSUserActivity` of type `com.liammagnier.juno.thread` (declared under `NSUserActivityTypes`), `userInfo` from `JunoHandoff` (ids only: kind, id, deviceID for Code, title, conversationID) and `webpageURL` as the web fallback (`/chat/<id>`, or `/code/<conversationId>` or `/code`). Continuing opens the same thread.

**Continue on iPhone / Mac / web.** A thread action. iPhone and Mac: `POST /api/sync/handoff {target, kind, id, deviceId?, title?}` pushes a notification (category `ALEVR_HANDOFF`, `handoff`, `conversationId` or `deviceID`+`sessionID`) to the other platform's devices, never to the asking device. Web: opens the fallback URL.

**Per-thread state** (`ThreadSync`, key `chat:<conversationId>` or `code:<deviceId>:<sessionId>`): the draft, the composer prefs (model, effort, mode, interactionMode, team, skills), needs-you and read. `PUT /api/sync/threads/<key>` writes a group only when it is newer than what is stored, by the writer's own clock (capped 5 minutes ahead of the server), so the latest typing wins on every device; `GET /api/sync/threads?cursor=&wait=&keys=` long-polls (≤ 20 s) and returns rows after a `(updatedAt, key)` cursor, so rows written in the same millisecond are neither skipped nor repeated. Clients debounce drafts (`ThreadDraftSyncer`, 700 ms after the last keystroke, flushed on leave), clear the draft everywhere on send, ignore their own echo and never overwrite typing that has not been sent yet. Needs-you is written by the backend from the link's events (`session.state` waiting, a pending approval), so an approval answered on one device clears everywhere.

## 6. Sync audit (missed, duplicated, stale)

- Mac → backend push: a failed push used to drop its batch (events lost until a gap replay). It is now kept and retried in order with backoff (`EnvServerDeviceLinkChannel.flush`).
- Re-open after a Mac restart: the hub's replay `session.open {sessionId, cwd:"/", afterSequence}` was refused because the restarted Mac had forgotten which sessions the link opened; an existing session in a shared folder is now re-admitted by its own folder.
- Clients apply events through `classifyEvent` (stale snapshots never roll a thread back, duplicates dropped, gaps re-open with `afterSequence`).
- Approval notifications and needs-you are deduplicated per request id (above).
