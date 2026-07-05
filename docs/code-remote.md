# Remote code task queue

Queue coding tasks from any Juno client and have a Mac host (running Claude Code) pick them up, stream progress back, and pause for approvals. The server is a dumb relay: it stores devices, tasks, and an append-only event log per task.

## Auth

Every endpoint uses the normal next-auth session cookie — same as the rest of the API. All resources are scoped to the session user; a task or device belonging to someone else is a 404.

## Flow

1. **Register / heartbeat** — the Mac host POSTs `/api/code/devices` on launch and then every 60s. The same call upserts the device (by `deviceId` if provided and owned, else by `userId+name`) and refreshes `lastSeenAt` + `workspaces`. A device is considered `online` when `lastSeenAt` is within 120s.
2. **Queue** — a client POSTs `/api/code/tasks` with a `deviceId`, `workspacePath`, and `prompt`. The task starts as `queued`.
3. **Claim** — the host long-polls `GET /api/code/queue?deviceId=` (up to 25s per request; the server re-checks the DB every 1.5s) and, when a task arrives, POSTs `/tasks/[id]/claim`. Only `queued -> running` succeeds; anything else is `409 {error:"not_queued"}`.
4. **Events** — while running, the host POSTs batches to `/tasks/[id]/events`. The server assigns `seq` numbers atomically (transactional increment of `task.lastSeq`) and returns any pending control events (`approval_response`, `cancel_request`) with `seq > afterControlSeq`. Clients render the task by polling `GET /tasks/[id]?afterSeq=N`.
5. **Approvals** — when the host needs permission it appends an `approval_request` event and sets `status: "awaiting_approval"` in the same POST. A client answers via `/tasks/[id]/respond {requestId, approve}`, which appends an `approval_response` and flips the task back to `running`. The host picks the response up from the `control` array on its next events POST.
6. **Done / cancel** — the host finishes with a `done` (or `error`) event plus a final status. `/tasks/[id]/cancel` appends a `cancel_request`; a still-`queued` task is cancelled immediately, a running one is left for the host to finalize.

## Endpoints

All JSON, under `/api/code`:

| Endpoint | Purpose |
| --- | --- |
| `POST /devices` | `{deviceId?, name, platform:"macos", workspaces:[{name,path}]}` — upsert + heartbeat. Returns `{device:{id,name,platform,workspaces,lastSeenAt}}`. |
| `GET /devices` | `{devices:[{id,name,platform,workspaces,lastSeenAt,online}]}` — `online` = seen within 120s. |
| `POST /tasks` | `{deviceId, workspacePath, workspaceName?, title?, prompt}` — creates `queued`; `title` defaults to the prompt truncated to 60 chars. Returns `{task}`. |
| `GET /tasks?deviceId=&status=&limit=30` | `{tasks}` newest-first. |
| `GET /tasks/[id]?afterSeq=N` | `{task, events:[{seq,kind,payload,createdAt}]}` — events with `seq > N`, ascending, capped at 500. |
| `POST /tasks/[id]/claim` | `{deviceId}` — `queued -> running` or `409 {error:"not_queued"}`. Returns `{task}`. |
| `POST /tasks/[id]/events` | `{events:[{kind,payload}], status?, afterControlSeq?}` — host appends; bodies over 256KB are rejected with 413. Returns `{lastSeq, control:[{seq,kind,payload}]}`. |
| `POST /tasks/[id]/respond` | `{requestId, approve}` — appends `approval_response`; resumes an `awaiting_approval` task. Returns `{lastSeq}`. |
| `POST /tasks/[id]/cancel` | Appends `cancel_request`; cancels immediately only if still `queued`. Returns `{task}`. |
| `GET /queue?deviceId=` | Long-poll (≤25s) for the oldest `queued` task on the device. Returns `{task\|null}`. |

Task shape: `{id, deviceId, workspacePath, workspaceName, title, prompt, status, lastSeq, createdAt, updatedAt}`.

## Event kinds

| Kind | Payload |
| --- | --- |
| `status` | `{status}` |
| `user` | `{text}` — initial prompt echo, host appends first |
| `text` | `{text}` — assistant prose delta; host batches ~1/s; clients concatenate consecutive `text` events |
| `tool` | `{name, summary, detail?}` — human-readable, e.g. `"Read src/foo.ts"`, `"$ npm test — exit 0"` |
| `file_change` | `{path, changeKind:"edit"\|"create"\|"delete", added, removed, diff?}` — `diff` is unified diff text, cap 40KB |
| `approval_request` | `{requestId, summary, risk:"neutral"\|"destructive"\|"outside", detail?}` — host also sets status `awaiting_approval` in the same POST |
| `approval_response` | `{requestId, approve}` |
| `cancel_request` | `{}` |
| `error` | `{message}` |
| `done` | `{finishReason, promptTokens?, completionTokens?}` |

## Statuses

`queued -> running (claim) -> awaiting_approval <-> running -> done | failed | cancelled`

## Database

Three Prisma models: `CodeDevice`, `CodeTask`, `CodeTaskEvent` (append-only, `@@unique([taskId, seq])`). The production tables appear on the next deploy — `deploy.sh` runs `prisma db push`. For local dev, run `npm run db:push` once against your dev database.
