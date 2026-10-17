-- A routine scheduled from a chat proposal (`propose_routine`) carries the
-- proposal's key, so a second press of Schedule finds the routine the first
-- press made. Additive: a nullable column, and a unique index on which every
-- existing row (all null) is distinct, so it builds on a live table.
ALTER TABLE "WorkSchedule" ADD COLUMN IF NOT EXISTS "proposalKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "WorkSchedule_userId_proposalKey_key" ON "WorkSchedule"("userId", "proposalKey");
