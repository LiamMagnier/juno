ALTER TABLE "KnowledgeDocument"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

ALTER TABLE "KnowledgeBlock"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

ALTER TABLE "KnowledgeChunk"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

ALTER TABLE "KnowledgeIndexJob"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "KnowledgeDocument_userId_deletedAt_idx"
  ON "KnowledgeDocument"("userId", "deletedAt");

CREATE INDEX IF NOT EXISTS "KnowledgeBlock_documentId_deletedAt_idx"
  ON "KnowledgeBlock"("documentId", "deletedAt");

CREATE INDEX IF NOT EXISTS "KnowledgeChunk_documentId_deletedAt_idx"
  ON "KnowledgeChunk"("documentId", "deletedAt");
