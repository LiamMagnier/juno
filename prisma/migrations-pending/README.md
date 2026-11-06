# Migrations held back deliberately

Prisma does not look in this directory. Nothing here is applied by
`prisma migrate deploy`, and that is the point — `render.yaml` has
`autoDeploy: true` on `main`, so anything sitting in `prisma/migrations/`
reaches production on the next push whether or not the field is ready for it.

A migration lives here when it is **correct but not yet safe to apply**. Move it
into `prisma/migrations/` only when its stated precondition is actually met.

## `20260815141000_work_change_capture_triggers`

Held back on 2026-08-15.

**What it does.** Arms Postgres change capture on the twelve Juno Work entity
types, so a Work task started on the web finally reaches the Mac and the iPhone
through `/api/v1/changes` instead of a foregrounded poll.

**Why it is not applied yet.** `NativeSyncAPIClient.requireEntityType` *throws*
on an entity type it does not know, and that aborts the whole `/changes` page
rather than skipping one row. So a type the server has started emitting and a
client has not learned does not degrade gracefully — it stops that account
syncing entirely, on that device, for **every** entity type, until the app is
updated.

`project_workspace` could be added ahead of its writer because its table was
empty. Work is the opposite: every Work table already holds rows on live
accounts, so the first Work write after this migration lands emits a change, and
every installed client that predates the strings is finished.

**Precondition, in full.** The Swift allowlist below must carry all twelve strings
*and* the build carrying them must be the **oldest client in the field** —
shipping the strings is necessary and not sufficient, because yesterday's
installs are still out there.

- `native/Packages/JunoNativeKit/Sources/JunoSync/NativeSyncAPIClient.swift`

(The Electron desktop app kept a second allowlist; it was removed in 2026-11,
so the Swift apps are the only sync client.)

**Status.** The allowlist carries all twelve as of 2026-08-15 (verified by
`tests/sync-work-entities.test.ts`, which also asserts the server never emits a
type the Swift client does not know). What remains is adoption: wait until update telemetry shows no
pre-0.15.7 client still syncing, then move this directory's migration into
`prisma/migrations/` and deploy.

**Do not** move it back merely because the strings are in `main`. That is the
half of the precondition that is already satisfied.
