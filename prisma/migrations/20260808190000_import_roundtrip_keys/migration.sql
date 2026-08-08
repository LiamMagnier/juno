-- Stable, account-scoped identities for Juno package re-imports.
-- Nullable values keep existing non-imported rows and ordinary projects valid.
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "importSourceId" TEXT;
ALTER TABLE "MemoryEntry" ADD COLUMN IF NOT EXISTS "importSourceId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Project_userId_importSourceId_key"
  ON "Project" ("userId", "importSourceId");
CREATE UNIQUE INDEX IF NOT EXISTS "MemoryEntry_userId_importSourceId_key"
  ON "MemoryEntry" ("userId", "importSourceId");
