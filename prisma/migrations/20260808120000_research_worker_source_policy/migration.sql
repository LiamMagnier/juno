-- Make research restart-safe and keep source-policy classifications next to
-- the immutable evidence snapshot.

ALTER TABLE "ResearchSource"
  ADD COLUMN IF NOT EXISTS "sourceType" TEXT;

ALTER TABLE "ResearchRun"
  ADD COLUMN IF NOT EXISTS "workerLeaseOwner" TEXT,
  ADD COLUMN IF NOT EXISTS "workerLeaseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastHeartbeatAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ResearchRun_state_workerLeaseUntil_idx"
  ON "ResearchRun"("state", "workerLeaseUntil");
