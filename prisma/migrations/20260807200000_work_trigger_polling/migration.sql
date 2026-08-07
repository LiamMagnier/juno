
ALTER TABLE "WorkTrigger"
  ADD COLUMN IF NOT EXISTS "cursor" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "lastPolledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastPollError" TEXT,
  ADD COLUMN IF NOT EXISTS "nextPollAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pollLockedUntil" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "WorkTrigger_enabled_nextPollAt_idx"
  ON "WorkTrigger"("enabled", "nextPollAt");
