-- The orchestrator-worker research engine.
--
-- `canonicalUrl` is the run-wide dedup key: two search engines, or two
-- parallel workers, returning the same page with different tracking
-- parameters now share one ResearchSource row, enforced by the unique index
-- rather than by a read-then-write race. `summary` caches the worker model's
-- condensation of a page so every later open_page is served from it.
-- ResearchFinding holds what the workers noted — the compressed product of a
-- round that the lead reviews and the writer is given.

ALTER TABLE "ResearchSource"
  ADD COLUMN IF NOT EXISTS "canonicalUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "summary" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ResearchSource_runId_canonicalUrl_key" ON "ResearchSource"("runId", "canonicalUrl");

-- CreateTable
CREATE TABLE IF NOT EXISTS "ResearchFinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceId" TEXT,
    "workerId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "objectiveId" TEXT,
    "claim" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "locator" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchFinding_runId_round_idx" ON "ResearchFinding"("runId", "round");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchFinding_sourceId_idx" ON "ResearchFinding"("sourceId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ResearchFinding_userId_fkey') THEN
    ALTER TABLE "ResearchFinding" ADD CONSTRAINT "ResearchFinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ResearchFinding_runId_fkey') THEN
    ALTER TABLE "ResearchFinding" ADD CONSTRAINT "ResearchFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ResearchFinding_sourceId_fkey') THEN
    ALTER TABLE "ResearchFinding" ADD CONSTRAINT "ResearchFinding_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ResearchSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
