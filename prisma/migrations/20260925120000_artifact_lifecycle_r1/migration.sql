-- Artifact lifecycle, R1 (docs/design/artifacts-design/04-MERGE-PLAN.md §2.6,
-- §3.5; the release spec is R1-lite).
--
--   * "Artifact"."projectId": the artifact's own project once it has no chat.
--     Written only when a chat is deleted and its artifacts move into the
--     account's hidden anchor conversation (`anchor_<userId>`, kind 'anchor');
--     while an artifact sits in a chat, the chat's projectId stays the truth.
--     SET NULL on project delete, like "Conversation"."projectId".
--   * "Artifact"."deletedAt" / "deletedReason": Recently deleted. A trashed row
--     is hidden from lists, search, projects and sync, and purged after 30 days
--     by scripts/purge-artifact-trash.ts (unarmed until the deletion ledger).
--   * "ArtifactProposal": a re-emit Juno held back instead of appending it as a
--     version, because a person edited after Juno's last write or because it
--     would drop design structure. No change-capture trigger on purpose: a
--     suggestion is never synced, so writing one must not touch the feed.
--
-- Additive only: nullable or defaulted columns and a new table, no backfill
-- (no anchor exists before this release). The DDL below is Prisma's own
-- `migrate diff` output so every name matches what the drift check expects.
--
-- No CHECK constraint and no partial index, although both would be natural
-- here ("kind" IN (...), one anchor per account): Prisma cannot declare
-- either in schema.prisma, so CI's "Migrations reproduce the schema" step
-- would fail on the drift. The anchor's fixed id makes the unique index
-- unnecessary anyway.

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedReason" TEXT,
ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "ArtifactProposal" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'suggestion',
    "kind" TEXT NOT NULL DEFAULT 'REWRITE',
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "messageId" TEXT,
    "taint" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ArtifactProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArtifactProposal_artifactId_status_idx" ON "ArtifactProposal"("artifactId", "status");

-- CreateIndex
CREATE INDEX "ArtifactProposal_messageId_idx" ON "ArtifactProposal"("messageId");

-- CreateIndex
CREATE INDEX "Artifact_projectId_idx" ON "Artifact"("projectId");

-- CreateIndex
CREATE INDEX "Artifact_deletedAt_idx" ON "Artifact"("deletedAt");

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactProposal" ADD CONSTRAINT "ArtifactProposal_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactProposal" ADD CONSTRAINT "ArtifactProposal_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The account anchor never reaches the change feed (04 §3.5, §3.7 protection A).
-- Installed native builds would otherwise receive a conversation called "Your
-- artifacts" and list it as a chat. With no revision behind it, hydration
-- simply omits the anchor, and no build ever learns it exists.
--
-- One trigger per event set because a DELETE trigger's WHEN may not name NEW
-- (and an INSERT trigger's may not name OLD). Same function, same arguments:
-- no change to juno_record_account_change(), so every other entity type is
-- untouched. The migration runs as one transaction, so the swap is atomic and
-- there is no moment when conversation changes go uncaptured.
--
-- The artifact and artifact_version triggers stay as they are: a move into the
-- anchor, a trash and a restore are all Artifact UPDATEs that still resolve the
-- owner through the anchor row, which carries the account's userId.
DROP TRIGGER IF EXISTS juno_change_conversation ON "Conversation";
CREATE TRIGGER juno_change_conversation AFTER INSERT OR UPDATE ON "Conversation"
  FOR EACH ROW WHEN (NEW."kind" <> 'anchor') EXECUTE FUNCTION juno_record_account_change('conversation', 'direct');
CREATE TRIGGER juno_change_conversation_delete AFTER DELETE ON "Conversation"
  FOR EACH ROW WHEN (OLD."kind" <> 'anchor') EXECUTE FUNCTION juno_record_account_change('conversation', 'direct');
