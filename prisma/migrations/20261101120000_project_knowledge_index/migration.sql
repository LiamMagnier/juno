-- PRJ-1: turn on the project knowledge index. Additive only: ingest now
-- writes chunks (with no vectors) and records how many; an embedding sweep
-- fills the vectors later and records why a document stays lexical-only.
-- Both tables are already in OWNER_COLUMN and under RLS; no new table.

ALTER TABLE "KnowledgeDocument"
  ADD COLUMN "embeddingState" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "embeddingModel" TEXT,
  ADD COLUMN "embeddingReason" TEXT,
  ADD COLUMN "embeddingClaimedAt" TIMESTAMP(3),
  ADD COLUMN "chunkCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "tokenCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "KnowledgeChunk" ADD COLUMN "textHash" TEXT;

CREATE INDEX "KnowledgeDocument_userId_embeddingState_idx" ON "KnowledgeDocument"("userId", "embeddingState");
CREATE INDEX "KnowledgeDocument_userId_attachmentId_idx" ON "KnowledgeDocument"("userId", "attachmentId");
CREATE INDEX "KnowledgeChunk_documentId_textHash_idx" ON "KnowledgeChunk"("documentId", "textHash");
