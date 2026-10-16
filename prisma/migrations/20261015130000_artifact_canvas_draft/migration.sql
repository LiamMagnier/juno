-- G12: never lose canvas edits.
--
-- "ArtifactCanvasDraft" holds a person's unsaved edit to an artifact's source
-- in the canvas, autosaved as they type and offered back when the artifact
-- reopens. It is NOT "ArtifactDraft" (the design editor's working copy, which
-- every other write and the idle sweeper seal into a version): an unsaved code
-- edit only becomes a version when the person saves it.
--
-- Additive and safe on a live database: one new table with foreign keys that
-- cascade from "Artifact" and "User"; nothing existing is read or rewritten.

-- CreateTable
CREATE TABLE "ArtifactCanvasDraft" (
    "artifactId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtifactCanvasDraft_pkey" PRIMARY KEY ("artifactId","userId")
);

-- CreateIndex
CREATE INDEX "ArtifactCanvasDraft_userId_updatedAt_idx" ON "ArtifactCanvasDraft"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "ArtifactCanvasDraft" ADD CONSTRAINT "ArtifactCanvasDraft_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactCanvasDraft" ADD CONSTRAINT "ArtifactCanvasDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to PostgREST, like every user-owned table since
-- 20260921220000_lock_public_schema_from_postgrest: the row is the owner's
-- unsaved work. The default privileges already withhold grants from anon and
-- authenticated; row level security means a grant restored by mistake later
-- still reads nothing. ENABLE, not FORCE: the application connects as the
-- table's owner and must be unaffected.
ALTER TABLE "ArtifactCanvasDraft" ENABLE ROW LEVEL SECURITY;
