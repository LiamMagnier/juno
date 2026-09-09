-- The model and thinking depth the submitter chose for a Juno Code task.
--
-- Both were offered by the composer, on /code/new and inside a live session,
-- and neither reached a run: the create route's schema did not accept them and
-- the cloud runner took the first available model in the catalog. Nullable, so
-- existing rows and native clients keep that fallback.
ALTER TABLE "CodeTask" ADD COLUMN "model" TEXT;
ALTER TABLE "CodeTask" ADD COLUMN "reasoningEffort" TEXT;

-- The list route filters on (userId, status); the cloud concurrency cap counts
-- (userId, target, status) on every cloud create. Both were scanning the
-- userId/createdAt index and filtering in memory.
CREATE INDEX "CodeTask_userId_status_idx" ON "CodeTask"("userId", "status");
CREATE INDEX "CodeTask_userId_target_status_idx" ON "CodeTask"("userId", "target", "status");
