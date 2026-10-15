ALTER TABLE "WorkRun" ADD COLUMN "pauseReason" TEXT;

-- Old pauses did not record intent. Keep them until a person resumes them.
UPDATE "WorkRun" SET "pauseReason" = 'user' WHERE "status" = 'paused';

CREATE INDEX "WorkRun_status_pauseReason_updatedAt_idx" ON "WorkRun"("status", "pauseReason", "updatedAt");
