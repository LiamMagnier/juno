-- Projects as workspaces (src/app/(app)/projects): a description beside the
-- name, and cloud sources kept in sync as project knowledge.
--
--   "Project"."description"  What the project is for, shown under its name.
--                            Defaulted, so every existing row reads "".
--
--   ProjectSource            A Google Drive file or folder filed into a
--                            project, read with the owner's own first-party
--                            Drive connection (src/lib/projects/drive-source.ts).
--
--   ProjectSourceItem        One Drive file a source mirrors, with the
--                            project attachment it was stored as and the
--                            Drive version it was read at, so a later sync
--                            tells an added file from a changed or removed one.
--
-- Expand-only (docs/JUNO.md §20.2b): a defaulted column and two new tables the
-- running release never reads, so the deployment before this one keeps working
-- while PM2 reloads. Plain CREATE INDEX, not CONCURRENTLY: Prisma runs the
-- migration inside a transaction. No `juno_record_account_change` trigger on
-- the new tables: the apps do not sync them (the Attachment rows a source
-- writes keep the capture they already have).

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "description" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "ProjectSource" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "includeSubfolders" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "errorCode" TEXT,
    "error" TEXT,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "syncClaimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSourceItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '',
    "version" TEXT NOT NULL,
    "attachmentId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'synced',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSourceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectSource_userId_projectId_idx" ON "ProjectSource"("userId", "projectId");

-- CreateIndex
CREATE INDEX "ProjectSource_userId_lastSyncedAt_idx" ON "ProjectSource"("userId", "lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSource_projectId_provider_externalId_key" ON "ProjectSource"("projectId", "provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSourceItem_attachmentId_key" ON "ProjectSourceItem"("attachmentId");

-- CreateIndex
CREATE INDEX "ProjectSourceItem_userId_sourceId_idx" ON "ProjectSourceItem"("userId", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSourceItem_sourceId_externalId_key" ON "ProjectSourceItem"("sourceId", "externalId");

-- AddForeignKey
ALTER TABLE "ProjectSource" ADD CONSTRAINT "ProjectSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSource" ADD CONSTRAINT "ProjectSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSourceItem" ADD CONSTRAINT "ProjectSourceItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSourceItem" ADD CONSTRAINT "ProjectSourceItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ProjectSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSourceItem" ADD CONSTRAINT "ProjectSourceItem_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Closed to PostgREST like every other user-owned table
-- (20260921220000_lock_public_schema_from_postgrest). ENABLE, not FORCE: the
-- application connects as the table's owner and must be unaffected.
ALTER TABLE "ProjectSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectSourceItem" ENABLE ROW LEVEL SECURITY;
