-- W5: separate workspace identity from local filesystem paths.
-- Everything here is ADDITIVE and nullable — existing macOS clients and the
-- in-flight Windows client keep working unchanged on the path-based flows.

-- Stable, client-minted workspace identity. When present, mirror-sync matches
-- on (userId, key) before falling back to (userId, path), so a moved folder
-- keeps its server row (and therefore its sessions).
ALTER TABLE "CodeWorkspace" ADD COLUMN "key" TEXT;

-- Partial unique index: identity is unique per user, but pre-key rows (NULL)
-- stay unconstrained. Hand-written because Prisma cannot express filtered
-- unique indexes.
CREATE UNIQUE INDEX "CodeWorkspace_userId_key_key"
  ON "CodeWorkspace"("userId", "key")
  WHERE "key" IS NOT NULL;

-- Tasks carry the workspace identity alongside the (still required) path the
-- executing device resolves locally.
ALTER TABLE "CodeTask" ADD COLUMN "workspaceKey" TEXT;

-- Code sessions (kind:"code" conversations) attribute to their workspace by
-- key when known; name/path remain display/device metadata.
ALTER TABLE "Conversation" ADD COLUMN "codeWorkspaceKey" TEXT;
