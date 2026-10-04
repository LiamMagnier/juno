-- Cost engineering (docs/pricing/COST_ENGINEERING.md).
--
-- 1. Context trimming: a long conversation's rolling summary of the messages
--    that have left the model's history window (src/lib/chat/history-summary-store.ts).
--    Encrypted like a message body. Nullable / defaulted, so every existing
--    row reads as "no summary yet".
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "historySummary" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "historySummaryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "historySummaryUntilId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "historySummaryAt" TIMESTAMP(3);

-- 2. Provider Batch API jobs for background work nobody is waiting on
--    (memory dreaming first): submitted on one dreamer tick, polled and
--    applied on later ones (src/lib/batch/*). One row per submitted batch.
CREATE TABLE IF NOT EXISTS "BatchJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "providerBatchId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "requests" JSONB NOT NULL,
    "results" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "billedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "BatchJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "BatchJob_userId_status_idx" ON "BatchJob"("userId", "status");
CREATE INDEX IF NOT EXISTS "BatchJob_status_createdAt_idx" ON "BatchJob"("status", "createdAt");

DO $$ BEGIN
  ALTER TABLE "BatchJob" ADD CONSTRAINT "BatchJob_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
