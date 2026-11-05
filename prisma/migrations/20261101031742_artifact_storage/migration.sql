-- Artifacts that keep persistent storage (window.alevr.storage,
-- src/lib/artifact-ai/storage.ts).
--
-- "ArtifactStorageEntry" holds what an HTML or React artifact's own code saved,
-- per artifact AND per viewer: on a shared or published link each signed-in
-- visitor has their own rows, which the artifact's owner never reads. `value`
-- is encryptField() ciphertext of the value's JSON text; `bytes` is the
-- plaintext size of key + value that the 20 MB-per-artifact and
-- 100 MB-per-viewer caps are counted in.
--
-- Expand-only (docs/JUNO.md §20.2b): one new table the running release never
-- reads, with foreign keys that cascade from "Artifact" and "User"; nothing
-- existing is read or rewritten, so a rollback leaves the table unread. No
-- `juno_record_account_change` trigger: the apps never sync it.

-- CreateTable
CREATE TABLE "ArtifactStorageEntry" (
    "artifactId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtifactStorageEntry_pkey" PRIMARY KEY ("artifactId","userId","key")
);

-- CreateIndex
CREATE INDEX "ArtifactStorageEntry_userId_idx" ON "ArtifactStorageEntry"("userId");

-- AddForeignKey
ALTER TABLE "ArtifactStorageEntry" ADD CONSTRAINT "ArtifactStorageEntry_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactStorageEntry" ADD CONSTRAINT "ArtifactStorageEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to PostgREST like every other user-owned table
-- (20260921220000_lock_public_schema_from_postgrest). ENABLE, not FORCE: the
-- application connects as the table's owner and must be unaffected.
ALTER TABLE "ArtifactStorageEntry" ENABLE ROW LEVEL SECURITY;
