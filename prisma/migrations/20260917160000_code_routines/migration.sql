-- Routines for Code, and the API trigger's token.
--
-- Expand-only (see docs/JUNO.md §20.2b): five nullable-or-defaulted columns
-- and one index. Nothing is renamed, nothing is dropped, and every existing
-- row keeps its meaning — a WorkSchedule with runKind 'work' is exactly the
-- schedule it was before this migration, and a CodeTask with a NULL
-- scheduleId is a run somebody started by hand, which is every run that
-- exists today.

-- What one fire of a routine produces, and the configuration the Code half of
-- it needs. The default is 'work' rather than NULL so the dispatcher never has
-- to treat "written before this column" and "unreadable" as the same case:
-- every row that predates this migration really is a Work schedule.
ALTER TABLE "WorkSchedule" ADD COLUMN "runKind" TEXT NOT NULL DEFAULT 'work';
ALTER TABLE "WorkSchedule" ADD COLUMN "codeConfig" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "WorkSchedule" ADD COLUMN "codeConfigVersion" INTEGER NOT NULL DEFAULT 1;

-- The routine a Code run came from. SetNull, like WorkRun.scheduleId: deleting
-- a routine must not delete the Code sessions it opened.
ALTER TABLE "CodeTask" ADD COLUMN "scheduleId" TEXT;
ALTER TABLE "CodeTask"
    ADD CONSTRAINT "CodeTask_scheduleId_fkey"
    FOREIGN KEY ("scheduleId") REFERENCES "WorkSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "CodeTask_scheduleId_createdAt_idx" ON "CodeTask"("scheduleId", "createdAt");

-- SHA-256 of the bearer token this routine's api trigger fires with, and when
-- it was issued. On the routine rather than on the trigger row because a patch
-- that changes the trigger set rewrites those rows wholesale, and rather than
-- in a trigger's `config` because `config` is serialised back to every client
-- that can read the routine.
ALTER TABLE "WorkSchedule" ADD COLUMN "fireSecretHash" TEXT;
ALTER TABLE "WorkSchedule" ADD COLUMN "fireSecretIssuedAt" TIMESTAMP(3);
