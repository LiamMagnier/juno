-- Knowledge engine, Memory v2, durable Research, and the spend ceiling.
--
-- Additive and replay-safe throughout: every column, table and index is guarded,
-- and each foreign key is wrapped so a re-run cannot fail on a constraint that
-- already exists. Nothing is dropped and no data is transformed, so an older
-- build ignores all of it and keeps running.
--
-- Rollback: drop the tables listed below, drop the MemoryEntry and Settings
-- columns, and the previous build is byte-for-byte correct again.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "monthlySpendCapEur" INTEGER,
ADD COLUMN IF NOT EXISTS "spendCapDisabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MemoryEntry" ADD COLUMN IF NOT EXISTS "category" TEXT,
ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "normalized" TEXT,
ADD COLUMN IF NOT EXISTS "projectId" TEXT,
ADD COLUMN IF NOT EXISTS "reason" TEXT,
ADD COLUMN IF NOT EXISTS "sourceMessageId" TEXT,
ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN IF NOT EXISTS "supersededById" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "SpendPeriod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "committedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "reservedMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpendPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SpendReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "estimateMicroUsd" BIGINT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "settledMicroUsd" BIGINT,
    "ref" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "SpendReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "attachmentId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "parser" TEXT,
    "parserVersion" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededById" TEXT,
    "pageCount" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "indexedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "KnowledgeBlock" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "page" INTEGER,
    "slide" INTEGER,
    "sheet" TEXT,
    "cellRange" TEXT,
    "path" TEXT,
    "lineStart" INTEGER,
    "lineEnd" INTEGER,
    "heading" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bbox" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "blockIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "KnowledgeIndexJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "KnowledgeIndexJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ResearchRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "goal" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'accepted',
    "plan" JSONB,
    "queries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "costMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "budgetMicroUsd" BIGINT,
    "error" TEXT,
    "report" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ResearchSource" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "contentHash" TEXT,
    "snapshot" TEXT,
    "publishedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authority" DOUBLE PRECISION,
    "duplicateOfId" TEXT,

    CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ResearchPassage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "locator" TEXT,
    "ordinal" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ResearchPassage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ResearchClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'fact',
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "supportStrength" DOUBLE PRECISION,
    "answerSpan" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ResearchClaimLink" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "passageId" TEXT NOT NULL,
    "stance" TEXT NOT NULL DEFAULT 'supports',
    "strength" DOUBLE PRECISION,

    CONSTRAINT "ResearchClaimLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ResearchEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SpendPeriod_userId_period_idx" ON "SpendPeriod"("userId", "period");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SpendPeriod_userId_period_key" ON "SpendPeriod"("userId", "period");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SpendReservation_userId_state_createdAt_idx" ON "SpendReservation"("userId", "state", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SpendReservation_periodId_state_idx" ON "SpendReservation"("periodId", "state");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SpendReservation_userId_ref_key" ON "SpendReservation"("userId", "ref");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeDocument_userId_state_createdAt_idx" ON "KnowledgeDocument"("userId", "state", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeDocument_userId_projectId_idx" ON "KnowledgeDocument"("userId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeDocument_userId_checksum_version_key" ON "KnowledgeDocument"("userId", "checksum", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeBlock_documentId_ordinal_idx" ON "KnowledgeBlock"("documentId", "ordinal");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeBlock_userId_documentId_idx" ON "KnowledgeBlock"("userId", "documentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_documentId_ordinal_idx" ON "KnowledgeChunk"("documentId", "ordinal");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_userId_embeddingModel_idx" ON "KnowledgeChunk"("userId", "embeddingModel");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeIndexJob_state_createdAt_idx" ON "KnowledgeIndexJob"("state", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "KnowledgeIndexJob_userId_documentId_idx" ON "KnowledgeIndexJob"("userId", "documentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchRun_userId_state_createdAt_idx" ON "ResearchRun"("userId", "state", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchRun_conversationId_createdAt_idx" ON "ResearchRun"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchSource_runId_fetchedAt_idx" ON "ResearchSource"("runId", "fetchedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchSource_userId_runId_idx" ON "ResearchSource"("userId", "runId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchPassage_sourceId_ordinal_idx" ON "ResearchPassage"("sourceId", "ordinal");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchClaim_runId_status_idx" ON "ResearchClaim"("runId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchClaimLink_passageId_idx" ON "ResearchClaimLink"("passageId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ResearchClaimLink_claimId_passageId_stance_key" ON "ResearchClaimLink"("claimId", "passageId", "stance");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResearchEvent_runId_createdAt_idx" ON "ResearchEvent"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ResearchEvent_runId_seq_key" ON "ResearchEvent"("runId", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MemoryEntry_userId_status_category_idx" ON "MemoryEntry"("userId", "status", "category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MemoryEntry_userId_projectId_status_idx" ON "MemoryEntry"("userId", "projectId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "MemoryEntry_userId_expiresAt_idx" ON "MemoryEntry"("userId", "expiresAt");

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "MemoryEntry" ADD CONSTRAINT "MemoryEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "SpendPeriod" ADD CONSTRAINT "SpendPeriod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "SpendPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "KnowledgeBlock" ADD CONSTRAINT "KnowledgeBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "KnowledgeBlock" ADD CONSTRAINT "KnowledgeBlock_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "KnowledgeIndexJob" ADD CONSTRAINT "KnowledgeIndexJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "KnowledgeIndexJob" ADD CONSTRAINT "KnowledgeIndexJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchPassage" ADD CONSTRAINT "ResearchPassage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchPassage" ADD CONSTRAINT "ResearchPassage_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ResearchSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchClaimLink" ADD CONSTRAINT "ResearchClaimLink_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ResearchClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchClaimLink" ADD CONSTRAINT "ResearchClaimLink_passageId_fkey" FOREIGN KEY ("passageId") REFERENCES "ResearchPassage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchEvent" ADD CONSTRAINT "ResearchEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "ResearchEvent" ADD CONSTRAINT "ResearchEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

