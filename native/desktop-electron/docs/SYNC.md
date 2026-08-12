# Sync

How Juno Desktop mirrors an account offline, and what the server actually
promises.

Everything below was read off the implementation, not inferred from the contract
prose. Where the two disagreed, the implementation won and the difference is
recorded here.

**Sources of truth consulted**

| What | Where |
| --- | --- |
| Contract | `contracts/openapi/juno-native-v1.yaml` (v1.3.0, 1233 lines) |
| Route handlers | `src/app/api/v1/**` |
| Feed + stream semantics | `src/lib/sync-feed.ts`, `src/lib/sync-protocol.ts` |
| Hydration + entity types | `src/lib/sync-entities.ts`, `src/lib/sync-entity-envelope.ts` |
| Mutation union | `src/lib/sync-mutations.ts` |
| Change capture | `prisma/migrations/20260716200000_account_change_log/` |
| Proven reference | `native/Packages/JunoNativeKit/Sources/JunoSync/` (Swift) |

> **Audit note.** `prisma/schema.prisma` in the working tree currently carries an
> uncommitted Postgres→SQLite conversion. The change feed is implemented entirely
> as PL/pgSQL triggers, so on SQLite there is no trigger, no `BIGSERIAL` cursor,
> and no sync at all. Every schema statement here was checked against
> `git show HEAD:prisma/schema.prisma`.

---

## 1. The protocol, as it actually is

### Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/bootstrap` | Account baseline. Carries `currentChangeCursor` and `compactionFloorCursor`. |
| `GET /api/v1/entities/index` | Keyset-paginated inventory of every **live** entity: `{type, id, revision}`. Max 500/page. |
| `GET /api/v1/entities?type=&ids=` | Batch hydration. **Max 100 ids per request.** |
| `GET /api/v1/changes?after=&limit=` | The authoritative change feed. Max 500/page, default 100. |
| `GET /api/v1/changes/stream?after=` | SSE **wakeup** channel. Carries no data. |
| `POST /api/v1/mutations` | The only write path. 15 operations. |

### The cursor

A Postgres `BIGSERIAL` id rendered as a decimal string. `parseCursor` accepts
`0` or a 1–31 digit number with no leading zero.

- **It is not a number.** It routinely exceeds `Number.MAX_SAFE_INTEGER`. It is
  carried as a string and compared with `BigInt` (`compareCursors` in
  `sync/types.ts`). This is also why it is stored as `TEXT`: `node:sqlite` throws
  `ERR_OUT_OF_RANGE` when reading an INTEGER past 2^53 unless BigInt mode is on
  for that statement, so a large cursor in an INTEGER column would turn every
  read of the sync state into a hard failure.
- **Numeric gaps are normal.** The sequence is global across all accounts, so one
  account's cursors are sparse. Never treat `n+1` as meaningful.
- `nextCursor` equals the last change's cursor, or equals `after` when the page is
  empty. An empty page with `nextCursor === after` means "you are current" — not
  a stalled feed.

### The realtime stream is a wakeup, and this is verified

`accountChangeStreamResponse` in `src/lib/sync-feed.ts`:

- polls the account's maximum cursor every **2s**,
- emits `event: cursor` with body `{"cursor":"N"}` on each advance,
- emits a `: ping` comment every **15s**,
- holds for **55s**, then emits `event: done` so the client reconnects.

**A `cursor` frame contains a cursor and nothing else.** No entity id, no
revision, no operation, no payload. There is no shape in that stream that could
be mistaken for canonical state, which is deliberate. Every byte that reaches
SQLite comes from `GET /changes` followed by `GET /entities`.

Two dialect details that differ from Juno's other SSE routes:

- This endpoint uses **named events** (`event: ready` / `event: cursor` /
  `event: done`). The chat SSE routes use anonymous `data:` frames with a `type`
  field inside the JSON. The reader in `sync/client.ts` speaks the named dialect.
- The bearer credential must travel in a header, so `EventSource` is unusable.
  The stream is read with `fetch` + `ReadableStream`.

`after` semantics: an explicit `after` emits an immediate catch-up `cursor` event
if the account is already ahead of it; omitting it baselines to the current
cursor so only *new* changes wake the client. This client always sends an
explicit `after` — its committed cursor — so a change that landed between the
last page and the subscribe is not missed.

### The sequence

```
authenticate
  └─ GET /bootstrap ─────────── capture the cursor BEFORE enumerating
       └─ GET /entities/index ─ walk the keyset to completion
            └─ GET /entities ── hydrate, ≤100 ids per call
                 └─ commit baseline + captured cursor in ONE transaction
subscribe GET /changes/stream?after=<committed cursor>
  └─ on `cursor` event  (a doorbell — the cursor it carries is not trusted)
       └─ GET /changes?after=<committed cursor>
            └─ GET /entities for what the page names
                 └─ reduce → apply writes + advance cursor in ONE transaction
                      └─ drain the outbox
```

**Why the bootstrap cursor is captured first.** Enumerating and *then* reading
the cursor would silently drop every write that happened during the enumeration:
the later cursor claims to cover changes the snapshot never saw. Taking it first
can only cause the opposite, harmless error — a change already in the snapshot is
replayed from the feed, and the reducer discards it as already-current.

### Change capture

Done entirely by Postgres triggers, so *any* write — web, native, or a background
job — emits an `AccountChange` with a monotonic cursor and upserts an
`EntityRevision`. There is no application code path that can forget to.

---

## 2. Revisions and tombstones

**No domain model carries a `revision` field, and 46 of 85 models have no
`updatedAt` at all.** Revisions and tombstones live entirely in the
`EntityRevision` side table.

The consequence is architectural, not cosmetic: **a watermark / `updatedAt`
sync is impossible.** There is no per-table column to compare against. The cursor
feed is the only correct mechanism, and the local schema mirrors the server's
envelope (`type`, `id`, `revision`, `deletedAt`, `data`) rather than inventing
per-table revision columns that would have nothing to sync from.

- `/changes` revisions are always `>= 1`.
- `/entities` revisions may be `0` — entities that predate change capture.
- **Tombstone invariant:** `data === null` **iff** `deletedAt !== null`. Enforced
  server-side in `buildEntityEnvelopes` and client-side by a Zod refinement *and*
  a SQLite `CHECK` constraint. This invariant exists because of a real
  release-blocking bug: artifacts cascade-deleted by Postgres left an
  `EntityRevision` with `deletedAt: null` whose row was gone, producing an
  envelope that was neither live nor tombstoned and stalling initial sync on a
  production account.

### Compaction

`AccountChange` rows are pruned past a retention window (default 30 days, min 7)
and a monotonic **compaction floor** is advanced. A cursor below the floor gets
**410 `cursor_compacted`**.

**This is a normal path, not an error.** It is exactly what happens after a
laptop is closed for a month. The client clears its cursor and re-bootstraps. A
second 410 immediately after a rebuild *is* treated as an error, because that
would mean the floor is racing us and looping would not help.

`EntityRevision` is never pruned, so current state is always recoverable.

---

## 3. Conflict policy

Stated exactly, because the vague version of this is where data gets lost.

**The server is authoritative for entity content.** The mirror always ends up
holding what `/entities` returned. There is no client-side merge, and the server
never merges either — conflicts are strict-equality 409s.

**The client never silently discards user intent.** When a change page carries a
server revision for an entity that has an unacknowledged outbox mutation against
it, and that revision is not the echo of our own mutation, the reducer emits a
`ReducedConflict` *alongside* the write. The caller then:

1. writes the server's state to the mirror (so the mirror does not lie),
2. moves the outbox entry to `conflicted` (so nothing is sent against a stale
   base revision),
3. inserts a `sync_conflicts` row carrying the full local request body.

The user's text is never destroyed. It is still in `outbox.request_body`, which
is why the UI can offer to reapply it.

The two alternatives were both rejected: overwriting the local edit loses the
user's work, and withholding the server's state makes the mirror lie.

### Resolution

- **Reapply** → `outbox.rebase(seq, newBaseRevision, deviceSessionId)`. This
  mints a **new** entry with a **new** `clientMutationId` and marks the old one
  `superseded`. Reusing the key is impossible: see §4.
- **Discard** → `outbox.discard(seq, reason)`.

### The reducer's other cases

| Case | Behaviour |
| --- | --- |
| Duplicate delivery (`nextCursor === storedCursor`) | `already-applied`, no writes. |
| Out-of-order page (`page.after !== storedCursor`) | `cursor_gap` error → refetch from the committed cursor. |
| Revision at or below what we hold | Ignored. This is what makes replay idempotent. |
| Several changes for one entity in one page | Collapsed to the newest; hydration returns current state anyway. |
| Tombstone | Entity row retained with `deleted_at`; the typed projection row is deleted. |
| `/entities` omitted an id on a **delete** | Treated as a tombstone. Unambiguous — the row is gone. |
| `/entities` omitted an id on an **upsert** | Fatal. Advancing the cursor past content we never received would lose it. |
| `/entities` older than `/changes` said | `stale_hydration` error → retry. Replica lag must not pin the mirror to stale content. |
| Unknown entity type | Recorded in `unknownEntityTypes`, skipped, logged. A newer server must not brick an older client. Requires a re-bootstrap after the client is updated. |

`reduceChangePage` is a pure function: no I/O, no clock, no database. All of the
above is unit-testable as data.

---

## 4. The outbox

### Atomicity

Every local mutation is written to the outbox **in the same transaction** as the
local state change. `MutationOutbox.commit()` is the only supported way in, and
`enqueue()` *throws* if it is called outside a transaction — the invariant is
enforced, not documented.

Without this, a crash between the two writes either loses the mutation (state
written, intent lost) or double-applies it (intent written, state rolled back and
re-entered by the user).

Outbox writes use `durableTransaction()`, which raises `synchronous` to `FULL`
for the duration. The mirror is reconstructible from the server and runs at
`NORMAL`; the outbox is the only copy of the user's intent until it lands, so it
is worth the fsync.

### Idempotency — VERIFIED, with one important limit

**The server does honour an idempotency key.** From
`src/app/api/v1/mutations/route.ts`, inside a `Serializable` transaction:

```ts
const key = { accountId_authenticatedDeviceId_clientMutationId: {
  accountId, authenticatedDeviceId, clientMutationId } };
const prior = await tx.mutationReceipt.findUnique({ where: key });
if (prior) {
  if (prior.requestHash !== requestHash) throw new ApiV1Error("idempotency_key_reused", 409, ...);
  return prior.result;
}
```

- `clientMutationId` must be a **UUID** (`z.string().uuid()`); anything else is a
  400.
- `requestHash` is `sha256(JSON.stringify(body))` over the **whole** request —
  including `baseRevision`.
- Same key + same body ⇒ the stored result is returned and the work is **not**
  repeated.
- Same key + different body ⇒ **409 `idempotency_key_reused`**, permanently.

Two consequences the outbox is built around:

1. **The request body is frozen at enqueue time**, stored verbatim, and resent
   byte-identical. A mutation that loses an optimistic-concurrency race cannot be
   retried with a fresh `baseRevision` under the same key — that is exactly the
   "same key, different work" the server rejects. Hence `rebase()` mints a new
   UUID. This is also right on the merits: an edit composed against revision 7 is
   a genuinely different intent from the same edit composed against revision 9.

2. > ### ⚠️ The receipt is scoped to the device session
   >
   > The key is `(accountId, authenticatedDeviceId, clientMutationId)`. **A
   > mutation replayed under a different device session is a brand-new mutation
   > to the server and executes again.** Idempotency holds within a device
   > session; it does **not** survive a re-authentication that issues a new
   > session.

   The outbox handles this by classifying operations
   (`isSafeToReplayAcrossDeviceSessions`):

   - **Creates are not safe.** `conversation.create` and friends require
     `baseRevision === 0` and then unconditionally insert. A replay produces a
     duplicate conversation, folder, project or memory. These are **quarantined**
     as `conflicted` with `device_session_changed` and surfaced for confirmation
     rather than sent.
   - **Everything else is safe.** `rename`, `update`, `archive`, `delete` and
     `settings.update` all pass through `requireRevision()`, which demands strict
     equality with the current server revision. A replay of an already-applied
     mutation finds the revision moved on and fails harmlessly with a 409; a
     replay of one that never landed does exactly what the user asked. The
     `baseRevision` check *is* the deduplication.

   Note this makes the *destructive* operations the safe ones and the creates the
   dangerous ones, which is the opposite of the usual intuition.

**The `request_hash` stored locally is not the server's hash.** It cannot be —
the server hashes its own re-serialisation after Zod parsing, so the key order
depends on that schema. Ours is a local integrity check that catches a body that
changed between attempts.

### Ordering

Global FIFO by `seq`, except that an entry is skipped while an *earlier* entry
for the same entity is unresolved (`pending`, `inflight`, `conflicted`, `dead`).

That gives strict per-entity ordering — a rename cannot overtake the create that
produced the id — without letting one stuck entity halt the entire queue, which
is what a strictly serial drain would do the first time something dead-letters.

### Retry and dead-lettering

- Exponential backoff with **full jitter** (`delay * (0.5 + rand*0.5)`). The
  jitter is not decoration: a network partition ends for every queued mutation at
  the same instant, and without it they retry in lockstep forever.
- Default 8 attempts, 1s initial, 5min ceiling.
- After the last attempt the entry becomes **`dead`** — retained in the table,
  counted in `stats()`, and listed by `listDeadLetters()`. **Nothing is ever
  silently dropped.** A mutation that vanishes is a bug nobody can file.

Non-retryable outcomes short-circuit straight to `conflicted`:

| Response | Handling |
| --- | --- |
| 409 `revision_conflict` | Conflict; `details.currentRevision` recorded for the rebase. |
| 409 `idempotency_key_reused` | Conflict. Never resent — it can never succeed. |
| 409 `suppressed_by_memory` | Conflict, dropped. The account asked Juno to forget this; retrying forever cannot help. `retryable:false`. |
| 401 | Not the mutation's fault. Left claimable; the loop handles re-authentication. |
| 429 / 5xx | Retryable, honouring `retryAfterMs`. |

### Crash recovery

`recoverInflight()` returns entries stranded `inflight` to `pending` at startup.
Safe by construction: same key, same body, same device session ⇒ the server
returns the stored result rather than repeating the work. This is precisely what
the idempotency key is for.

---

## 5. Offline behaviour

- **Reads** are served from the local mirror. There is no online-only path.
- **Writes** go to the outbox and apply optimistically to the mirror. They drain
  whenever connectivity returns.
- **Resume is always from the stored cursor**, re-read from SQLite on every
  iteration — never from a variable. Memory is not a source of truth about what
  has been committed. A crash, a sleep, or a restart resumes at exactly the right
  place.
- **Sleep/wake** is handled by `powerMonitor` `resume` and `unlock-screen`. A
  closed lid suspends the SSE socket without closing it, so neither end knows it
  is dead until a write fails. Rather than waiting out the 90s idle timeout, the
  resume hook aborts *only the stream* (a separate `AbortController` from the
  lifecycle one) and redials. Aborting the lifecycle controller here would have
  killed sync until the next app restart — a bug caught in testing.
- **A stream that closes immediately backs off.** Reconnecting instantly on
  `done` is right for the server's normal 55s cycle, but a proxy closing
  connections instantly would turn that into an unthrottled request loop. Only a
  stream that survived ≥5s earns an instant redial and resets the attempt
  counter. (Also caught in testing — it OOM'd the test process.)

### The cursor is committed with its data

The cursor advances in the **same transaction** as the rows it describes. There
is no instant at which the cursor claims coverage the data does not have. This is
the entire basis of crash-safety, and it is why `synchronous = NORMAL` is
acceptable for the mirror: a lost tail simply means the next sync replays from an
older cursor.

---

## 6. Storage

One SQLite database **per account**, at `<userData>/accounts/<accountId>/juno.db`.
This is a security boundary, not a convenience: a shared file with an
`account_id` column is one missing `WHERE` clause away from cross-account
disclosure, and it makes "forget this account" a delete-by-predicate instead of
an unlink. Account ids are validated against a conservative charset before being
used as a path segment, and hashed otherwise — a server-supplied string does not
get to choose a filesystem path.

### `node:sqlite`, not `better-sqlite3`

`better-sqlite3` is a native addon: `@electron/rebuild` in the packaging
pipeline, and an ABI matrix (Electron × arch × Node ABI) that breaks in CI far
more often than the database does. Electron 43.4.0 bundles Node 24.18.1, whose
`node:sqlite` is compiled into the runtime, so the persistence path has **zero**
native modules.

**Stability: 1.2 — Release candidate.** The mitigation is that the Electron
version pins the Node version. The API cannot shift under this app without an
explicit Electron upgrade, which is a reviewed change with its own test run.
`SqlDatabase` in `storage/database.ts` is a deliberately thin interface so that
if the module does move, the blast radius is one file.

**API differences from `better-sqlite3`, verified against the Node 24 docs and
probed against the runtime — not assumed:**

| | `better-sqlite3` | `node:sqlite` |
| --- | --- | --- |
| In a transaction? | `db.inTransaction` | **`db.isTransaction`** |
| Transaction helper | `db.transaction(fn)` | **None.** Explicit `BEGIN`/`COMMIT`/`ROLLBACK`; rollback-on-throw is ours to get right. |
| Big integers | returns as number, lossy | **throws `ERR_OUT_OF_RANGE`** past 2^53 unless `setReadBigInts(true)` |
| Rows | plain objects | null-prototype objects (no `row.hasOwnProperty`) |
| Named params | `:name` with prefixed keys | bare keys allowed (`allowBareNamedParameters`, default true); unknown keys **rejected** by default |

`Session`/changeset and `backup()` also exist. `backup()` is a plausible future
basis for a consistent on-disk backup; `Session` is not built on here.

### Pragmas

| Pragma | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | Readers never block the writer — the sync loop writes pages while the UI reads. Survives process crash without corruption. |
| `foreign_keys` | `ON` | Projection tables cascade from `entities`; off, they would accumulate orphans. |
| `busy_timeout` | 5000ms | Default is 0 (immediate `SQLITE_BUSY`). Two writers exist: the sync loop and IPC mutation handlers. |
| `synchronous` | `NORMAL`, `FULL` for outbox | See below. |
| `wal_autocheckpoint` | 1000 | Stops an idle app sitting on a huge WAL after a bootstrap. |

**`synchronous = NORMAL` justified.** In WAL mode this fsyncs at checkpoints
rather than every commit. It is fully durable against a *process* crash — the
failure a desktop app actually has — and cannot corrupt the database under any
failure. It can lose the last few commits on power loss. That is the right
default because most writes are change-page applications and the mirror is
reconstructible: the cursor moves with its data, so a lost tail replays. Paying
an fsync per commit to protect data the server will hand back for free is the
wrong trade, and during a bootstrap of tens of thousands of entities it is the
difference between seconds and minutes. Writes that are **not** reconstructible —
anything touching the outbox — go through `durableTransaction()`, which raises it
to `FULL`.

Transactions use `BEGIN IMMEDIATE`. A deferred transaction takes its write lock
at the first write, so two concurrent read-then-write transactions can both read
and then one gets `SQLITE_BUSY` at upgrade time with no busy-handler retry
available. Taking the lock up front lets the busy timeout do its job.

`close()` runs `PRAGMA wal_checkpoint(TRUNCATE)` before closing. Closing without
it leaves `-wal`/`-shm` beside the database; SQLite recovers from them, but only
if all three are present and consistent. A backup tool or a user copying "the
database file" takes one of three — and that is how a silently-stale database
happens.

### Schema

- `entities` — the authoritative mirror, one row per `(type, id)`, matching the
  server's envelope exactly. Generic, because the server's model is generic.
- `conversations`, `messages`, `projects`, `work_tasks`, `code_sessions` —
  **projections**: derived, indexed, live-rows-only, rebuildable from `entities`,
  cascading from it via foreign key. They exist so the UI can
  `ORDER BY last_message_at` without deserialising every blob. 17 of the 22
  entity types have no projection and live only in `entities`.
- `outbox`, `sync_conflicts`, `sync_state`.

Migrations are forward-only, numbered, one transaction each, versioned in
SQLite's own `user_version`. A database from a newer build is **refused**, not
downgraded.

---

## 7. Contract gaps

Numbered so they can be referenced. None of these are worked around by inventing
endpoints.

**GAP-S1 — Only 22 of 85 models are in the change feed.** The synced types are:
`profile`, `settings`, `subscription`, `folder`, `conversation`, `message`,
`message_version`, `attachment`, `artifact`, `artifact_version`, `project`,
`memory`, `saved_prompt`, `connection`, `usage`, `share`,
`announcement_dismissal`, `scheduled_task`, `code_device`, `code_task`,
`code_task_event`, `code_workspace`.

Everything else has **no sync path at all** and would require its own polling.
Confirmed absent from the feed:

| Family | Models |
| --- | --- |
| **Work** (15) | `WorkApproval`, `WorkArtifact`, `WorkArtifactVersion`, `WorkAuditEvent`, `WorkCommand`, `WorkEvent`, `WorkFileGrant`, `WorkHost`, `WorkRun`, `WorkRunIO`, `WorkSchedule`, `WorkSession`, `WorkSessionConnector`, `WorkSkill`, `WorkSkillVersion`, `WorkTrigger` |
| **Knowledge** (4) | `KnowledgeBlock`, `KnowledgeChunk`, `KnowledgeDocument`, `KnowledgeIndexJob` |
| **Research** (7) | `ResearchClaim`, `ResearchClaimLink`, `ResearchEvent`, `ResearchPassage`, `ResearchReportRevision`, `ResearchRun`, `ResearchSource` |
| **Import** (2) | `ImportObject`, `ImportRun` |
| **Code remote session** (3) | `CodeRemoteSession`, `CodeRemoteSessionEvent`, `CodeSessionCommand` |

> **The Work product surface does not sync.** The `work_tasks` table in this
> schema projects the `scheduled_task` entity — recurring prompts — which is
> *not* the Work surface. Nothing in this engine makes Work offline-capable, and
> nothing here should be read as claiming otherwise.

**GAP-S2 — Only 15 mutation operations exist.** `conversation.{create, rename,
update, archive, delete}`, `folder.{create, rename, delete}`, `project.{create,
update, delete}`, `memory.{create, update, delete}`, `settings.update`. Counted
three ways and consistent across all of them: the OpenAPI `type` enum, the
`switch` in the route handler, and the discriminated union in
`src/lib/sync-mutations.ts`.

Everything else in the feed is **read-only** to a native client. Notably there is
no mutation for `artifact`, `attachment`, `share`, `saved_prompt`,
`scheduled_task` or any Code entity — those are reachable only through separate,
non-idempotent `/api` routes outside the sync contract.

**GAP-S3 — Idempotency does not span device sessions.** See §4. The mitigation is
client-side classification; a server-side fix would be to key `MutationReceipt`
on `(accountId, clientMutationId)` alone, since the UUID is already globally
unique.

**GAP-S4 — No bulk hydration by cursor.** Catching up on a large page costs
`ceil(n/100)` round trips against `/entities`, on top of the `/changes` call.
A `/changes?include=entities` variant would make catch-up a single request.

**GAP-S5 — No server-side conflict detail beyond `currentRevision`.** The 409
gives the current revision but not the current *content*, so a rebase needs a
further hydration round-trip before it can show the user what changed.

**GAP-S6 — `/entities/index` lists live entities only.** A client that has been
away long enough to be compacted cannot learn which entities were *deleted* while
it was gone; it discovers them only by their absence. The full-rebuild path
(`DELETE FROM entities` then reinstall) handles this correctly, but only because
it is a full replace — an incremental reconciliation against the index would
silently retain deleted rows.

**GAP-S7 — No `Origin` may be sent.** `src/middleware.ts:144` returns **403** for
any mutating `/api/` request whose `Origin` does not match the host, and there is
no CORS anywhere. A request with **no** `Origin` is the intended native path.
Running in the main process, nothing adds one for us — but nothing stops us
adding one by accident either, so `sync/client.ts` carries an explicit comment.

**GAP-S8 — Legacy `/api` routes use a different error envelope.**
`GeneralRouteErrorEnvelope` (`{error: string}`) rather than the typed
`{error: {code, message, requestId, retryable}}`. Tracked upstream as GAP-006.
This client only speaks `/api/v1`, where the typed envelope is guaranteed.

---

## 8. Security notes

- **No bearer token is logged, stored in the sync module, placed on an error, or
  returned to the renderer.** A token is requested per call from
  `AccessTokenProvider`, used for one `fetch`, and forgotten. `SyncStatus` and
  `SyncError.toDiagnostic()` are the only shapes that cross toward the renderer,
  and neither has a field that could hold one.
- `redirect: 'error'` on every request. A redirect off-origin would otherwise
  carry the `Authorization` header to wherever it pointed.
- Transport errors report a **redacted path** — query strings carry cursors and
  entity ids.
- **Every network response is Zod-validated before it touches SQLite.** A
  malformed payload becomes an error at the boundary rather than a corrupt row
  discovered three releases later.

---

## 9. Manual verification still required

Everything below needs real credentials against a live backend. Each has a
unit-testable pure function standing in for it today, but none of these are
*proven* until run for real.

1. **Idempotent replay.** POST the same `clientMutationId` + body twice; confirm
   one effect and an identical response body. Then POST the same key with a
   changed `baseRevision`; confirm 409 `idempotency_key_reused`.
2. **Device-session replay.** Sign out, sign in (new device session), replay a
   queued `conversation.rename` and confirm it is a harmless 409; confirm a
   `conversation.create` would have duplicated — this is the assumption
   `isSafeToReplayAcrossDeviceSessions` rests on and it is the one worth proving.
3. **Compaction 410.** Set a cursor below the floor and confirm the 410 body
   carries `details.compactionFloorCursor`, and that the rebuild path converges.
4. **Stream frame shapes.** Capture raw bytes from `/changes/stream` on a live
   account and confirm the named-event dialect, the 15s `: ping`, and the 55s
   `done`.
5. **Large-account bootstrap.** Confirm `/entities/index` keyset paging
   terminates and that hydration batching stays at ≤100 ids on an account with
   tens of thousands of messages.
6. **Revision 0 entities.** Confirm entities predating change capture hydrate at
   revision `0` and are not mistaken for missing.
7. **`suppressed_by_memory`.** Queue a `memory.create` offline for content the
   account has since suppressed; confirm the 409 and that the entry is dropped
   rather than retried.

Automated coverage today: 29 checks over migrations, account isolation, path
traversal, transaction atomicity and rollback, per-entity ordering, backoff,
device-session classification, all reducer branches, the schema invariants, and a
full fake-server run of bootstrap → wakeup → page → apply → drain.
