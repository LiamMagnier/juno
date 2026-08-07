-- Event-trigger polling: the cursor, the clock and the lease.
--
-- NOT a Prisma migration directory, deliberately. This is written to be read
-- and applied by a person against the live database, because the schema change
-- it describes was made in a checkout that must never touch one:
--
--     psql "$DATABASE_URL" -f prisma/work-trigger-polling.sql
--
-- Once it has been applied, move it into a migration directory of its own
-- (`prisma/migrations/<timestamp>_work_trigger_polling/migration.sql`) so that
-- `prisma migrate deploy` records it and a fresh database gets it too. It is
-- written to be safe either way: every statement is idempotent, so applying it
-- twice — by hand and then again through `migrate deploy` — is a no-op rather
-- than a failure that P3009-poisons every later deploy.
--
-- WHY EACH COLUMN EXISTS
--
-- `cursor` is what stops a restart re-firing history. A poller with no memory
-- of where it had read to sees the twenty-five newest messages in the mailbox
-- every time it starts, and every one of them is new to it. The first poll of
-- a source records that source's high-water mark and fires nothing; only what
-- arrives after it can start a run.
--
-- `nextPollAt` and `pollLockedUntil` are the poller's own clock and lease. They
-- are not `WorkSchedule.nextRunAt` and `lockedUntil` — the scheduler holds those
-- for the length of a dispatch, and a poller that shared them would stall every
-- clock trigger on a schedule while it waited on an IMAP connection.
--
-- `lastPolledAt` and `lastPollError` are how a trigger that is quietly failing
-- becomes visible. A mailbox whose app-specific password was rotated three
-- weeks ago is otherwise indistinguishable from one nothing has matched in.
--
-- All five are nullable or defaulted, so a build deployed before this migration
-- reads the rows it writes, and a build deployed after it reads the rows that
-- existed before: a null cursor is "never polled", which is exactly what every
-- trigger that predates the poller is.

-- AlterTable
ALTER TABLE "WorkTrigger"
  ADD COLUMN IF NOT EXISTS "cursor" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "lastPolledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastPollError" TEXT,
  ADD COLUMN IF NOT EXISTS "nextPollAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pollLockedUntil" TIMESTAMP(3);

-- CreateIndex
--
-- The poller's sweep is "enabled triggers whose next poll is due", ordered by
-- how long they have been waiting.
--
-- No null ordering on the index, on purpose. The poller asks for ASC NULLS
-- FIRST — a trigger that has never been polled has a null `nextPollAt` and must
-- be picked up on the next tick rather than behind everything that already has
-- a schedule, and Postgres's ASC default is NULLS LAST, so it has to say so.
-- An index matching that sort would have to be `("enabled", "nextPollAt" NULLS
-- FIRST)`, which `prisma/schema.prisma` has no syntax for and which the next
-- `prisma migrate dev` would therefore offer to revert. This index is here to
-- narrow the scan; the ordering is a sort over what is due right now, which is
-- a handful of rows.
CREATE INDEX IF NOT EXISTS "WorkTrigger_enabled_nextPollAt_idx"
  ON "WorkTrigger"("enabled", "nextPollAt");
