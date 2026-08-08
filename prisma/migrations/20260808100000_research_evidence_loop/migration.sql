-- Research evidence loop: structured report ownership, immutable revisions,
-- and original-run message linkage. Additive and replay-safe for deployments
-- that already have durable research rows.

ALTER TABLE "ResearchRun"
  ADD COLUMN IF NOT EXISTS "assistantMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "reportRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "ResearchReportRevision" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "assistantMessageId" TEXT,
  "revision" INTEGER NOT NULL,
  "report" TEXT NOT NULL,
  "audit" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ResearchReportRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ResearchReportRevision_runId_revision_key"
  ON "ResearchReportRevision"("runId", "revision");
CREATE INDEX IF NOT EXISTS "ResearchReportRevision_userId_createdAt_idx"
  ON "ResearchReportRevision"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "ResearchReportRevision_assistantMessageId_idx"
  ON "ResearchReportRevision"("assistantMessageId");
CREATE INDEX IF NOT EXISTS "ResearchRun_assistantMessageId_idx"
  ON "ResearchRun"("assistantMessageId");

DO $$
BEGIN
  ALTER TABLE "ResearchRun"
    ADD CONSTRAINT "ResearchRun_assistantMessageId_fkey"
    FOREIGN KEY ("assistantMessageId") REFERENCES "Message"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "ResearchReportRevision"
    ADD CONSTRAINT "ResearchReportRevision_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "ResearchReportRevision"
    ADD CONSTRAINT "ResearchReportRevision_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "ResearchReportRevision"
    ADD CONSTRAINT "ResearchReportRevision_assistantMessageId_fkey"
    FOREIGN KEY ("assistantMessageId") REFERENCES "Message"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
