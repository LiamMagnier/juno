-- Artifacts become deliverables (PRODUCT_REFOUNDATION §10, DECISIONS D-013).
--
-- 1. Ownership. "Artifact" gets its own "userId", "projectId" and trash
--    ("deletedAt"), and "conversationId" becomes nullable with ON DELETE SET
--    NULL. Deleting a chat detaches its artifacts instead of cascading them
--    (audit X-22, B5), and an artifact can exist without a chat (New design,
--    Duplicate). "derivedFromId"/"derivedFromVersion" record a Duplicate's
--    source as plain pointers.
--
--    Expand step of docs/JUNO.md §20.2b: "userId" is nullable, backfilled here
--    from the conversation, and filled by a BEFORE INSERT trigger for any row
--    the previous release writes between this migration and the reload (it
--    does not know the column). Every writer in this release sets it; a later
--    release makes it NOT NULL and drops the fill trigger.
--
-- 2. Immutable versions. "ArtifactVersion" rows are never rewritten again: a
--    BEFORE UPDATE trigger refuses a change to a row's body, number or
--    artifact. The design editor's gesture folding moves to "ArtifactDraft",
--    a per-artifact working copy that is sealed into a new version on
--    checkpoint, on idle, or before any other write. This closes audit B1
--    (design edits made after sharing leaked into the public link through an
--    in-place rewrite of the shared version) by construction.
--
-- 3. The re-emit guard's "ArtifactProposal" (taken from artifacts/r1-lifecycle,
--    without its hidden anchor conversation): a model rewrite of an artifact
--    the person edited waits as a suggestion instead of becoming a version.
--
-- 4. "ArtifactPublication": Publish, separate from Share. A stable token per
--    artifact pinned to a version or to latest; "ShareReport"."publicationId"
--    lets the Report link and the admin queue work for publications.
--
-- 5. Change capture. The "Artifact" trigger resolved its owner through the
--    conversation, which a detached artifact no longer has, and the version
--    trigger joined through it too. Both now read "Artifact"."userId" (with
--    the conversation as the fallback for a row the fill trigger has not
--    reached). juno_record_account_change() is 20260815180000's body verbatim
--    except for the 'artifact' branch and one new 'artifact_owner' branch; the
--    account-delete guard and the tombstone fallback are unchanged, and the
--    search_path pin from 20260921220000 is restated because CREATE OR REPLACE
--    resets it.
--
-- The backfill runs with the artifact trigger dropped, so it does not write an
-- AccountChange row per existing artifact (a re-sync of every artifact on every
-- device for a payload that only gained fields). New tables are empty, so their
-- indexes are built without CONCURRENTLY (see deploy.yml).

BEGIN;

DROP TRIGGER IF EXISTS juno_change_artifact ON "Artifact";

-- DropForeignKey
ALTER TABLE "Artifact" DROP CONSTRAINT "Artifact_conversationId_fkey";

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "derivedFromId" TEXT,
ADD COLUMN     "derivedFromVersion" INTEGER,
ADD COLUMN     "projectId" TEXT,
ADD COLUMN     "userId" TEXT,
ALTER COLUMN "conversationId" DROP NOT NULL;

-- Backfill: every existing artifact has a conversation (the column was NOT
-- NULL until the statement above), so every row gets its owner.
UPDATE "Artifact" a
   SET "userId" = c."userId",
       "projectId" = c."projectId"
  FROM "Conversation" c
 WHERE c."id" = a."conversationId"
   AND a."userId" IS NULL;

-- AlterTable
ALTER TABLE "ShareReport" ADD COLUMN     "publicationId" TEXT;

-- CreateTable
CREATE TABLE "ArtifactDraft" (
    "artifactId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtifactDraft_pkey" PRIMARY KEY ("artifactId")
);

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

-- CreateTable
CREATE TABLE "ArtifactPublication" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "pinnedVersion" INTEGER,
    "title" TEXT NOT NULL DEFAULT '',
    "publishedAt" TIMESTAMP(3),
    "unpublishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "views" INTEGER NOT NULL DEFAULT 0,
    "takenDownAt" TIMESTAMP(3),
    "takenDownBy" TEXT,
    "takedownReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtifactPublication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArtifactDraft_userId_idx" ON "ArtifactDraft"("userId");

-- CreateIndex
CREATE INDEX "ArtifactDraft_updatedAt_idx" ON "ArtifactDraft"("updatedAt");

-- CreateIndex
CREATE INDEX "ArtifactProposal_artifactId_status_idx" ON "ArtifactProposal"("artifactId", "status");

-- CreateIndex
CREATE INDEX "ArtifactProposal_messageId_idx" ON "ArtifactProposal"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactPublication_token_key" ON "ArtifactPublication"("token");

-- CreateIndex
CREATE INDEX "ArtifactPublication_artifactId_retiredAt_idx" ON "ArtifactPublication"("artifactId", "retiredAt");

-- CreateIndex
CREATE INDEX "ArtifactPublication_userId_createdAt_idx" ON "ArtifactPublication"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Artifact_userId_deletedAt_updatedAt_idx" ON "Artifact"("userId", "deletedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "Artifact_projectId_idx" ON "Artifact"("projectId");

-- CreateIndex
CREATE INDEX "Artifact_deletedAt_idx" ON "Artifact"("deletedAt");

-- CreateIndex
CREATE INDEX "ShareReport_publicationId_idx" ON "ShareReport"("publicationId");

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactDraft" ADD CONSTRAINT "ArtifactDraft_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactDraft" ADD CONSTRAINT "ArtifactDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactProposal" ADD CONSTRAINT "ArtifactProposal_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactProposal" ADD CONSTRAINT "ArtifactProposal_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactPublication" ADD CONSTRAINT "ArtifactPublication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareReport" ADD CONSTRAINT "ShareReport_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "ArtifactPublication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Owner fill for the previous release (expand step) ─────────────────────
-- The release this migration ships with sets "userId" on every insert. The
-- release still serving while it applies does not know the column, so its
-- inserts arrive with NULL; this fills the owner (and the project, which that
-- release also never writes) from the conversation it always sets. A row that
-- arrives WITH an owner is left exactly as written.
CREATE OR REPLACE FUNCTION juno_artifact_fill_owner() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS NULL AND NEW."conversationId" IS NOT NULL THEN
    SELECT c."userId", COALESCE(NEW."projectId", c."projectId")
      INTO NEW."userId", NEW."projectId"
      FROM "Conversation" c
     WHERE c."id" = NEW."conversationId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER juno_artifact_fill_owner BEFORE INSERT ON "Artifact"
  FOR EACH ROW EXECUTE FUNCTION juno_artifact_fill_owner();

-- ─── Versions are immutable ────────────────────────────────────────────────
-- A version is what a publication pins, what a share froze and what every
-- device synced as "version N". Rewriting one in place is how B1 leaked, so the
-- database refuses it outright rather than trusting every writer to remember.
-- "createdAt" is covered because a legacy share serves the newest version
-- created at or before its snapshot, and "origin" because the re-emit guard
-- decides on it. Deletes (the purge, account deletion) are unaffected.
CREATE OR REPLACE FUNCTION juno_artifact_version_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."content" IS DISTINCT FROM OLD."content"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."artifactId" IS DISTINCT FROM OLD."artifactId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."origin" IS DISTINCT FROM OLD."origin" THEN
    RAISE EXCEPTION 'ArtifactVersion % is immutable; write a new version instead', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER juno_artifact_version_immutable BEFORE UPDATE ON "ArtifactVersion"
  FOR EACH ROW EXECUTE FUNCTION juno_artifact_version_immutable();

-- ─── Change capture: artifacts own themselves ─────────────────────────────
-- 20260815180000's function, verbatim except:
--   'artifact'        (artifact_version rows): owner from "Artifact"."userId",
--                     falling back to the conversation for an unfilled row.
--   'artifact_owner'  (new, "Artifact" rows): owner = row."userId", parent =
--                     row."conversationId" (null once detached), falling back
--                     to the conversation for an unfilled row.
CREATE OR REPLACE FUNCTION juno_record_account_change() RETURNS trigger AS $$
DECLARE
  row_data record;
  account_id text;
  entity_id text;
  next_revision integer;
  tombstone_time timestamp(3);
  parent_entity_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN row_data := OLD; tombstone_time := CURRENT_TIMESTAMP; ELSE row_data := NEW; tombstone_time := NULL; END IF;
  entity_id := row_data.id::text;
  IF TG_ARGV[1] = 'user' THEN
    account_id := row_data.id::text;
  ELSIF TG_ARGV[1] = 'direct' THEN
    account_id := row_data."userId"::text;
  ELSIF TG_ARGV[1] = 'conversation' THEN
    parent_entity_id := row_data."conversationId"::text;
    SELECT "userId" INTO account_id FROM "Conversation" WHERE id = row_data."conversationId";
  ELSIF TG_ARGV[1] = 'code_task' THEN
    parent_entity_id := row_data."taskId"::text;
    SELECT "userId" INTO account_id FROM "CodeTask" WHERE id = row_data."taskId";
  ELSIF TG_ARGV[1] = 'artifact' THEN
    parent_entity_id := row_data."artifactId"::text;
    SELECT COALESCE(a."userId", c."userId") INTO account_id
      FROM "Artifact" a LEFT JOIN "Conversation" c ON c.id = a."conversationId"
     WHERE a.id = row_data."artifactId";
  ELSIF TG_ARGV[1] = 'artifact_owner' THEN
    parent_entity_id := row_data."conversationId"::text;
    account_id := row_data."userId"::text;
    IF account_id IS NULL AND row_data."conversationId" IS NOT NULL THEN
      SELECT "userId" INTO account_id FROM "Conversation" WHERE id = row_data."conversationId";
    END IF;
  ELSIF TG_ARGV[1] = 'message_parent' THEN
    parent_entity_id := row_data."messageId"::text;
    SELECT c."userId" INTO account_id FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId" WHERE m.id = row_data."messageId";
  ELSIF TG_ARGV[1] = 'work_session' THEN
    parent_entity_id := row_data."sessionId"::text;
    account_id := row_data."userId"::text;
  ELSIF TG_ARGV[1] = 'work_run' THEN
    parent_entity_id := row_data."runId"::text;
    account_id := row_data."userId"::text;
  ELSIF TG_ARGV[1] = 'work_schedule' THEN
    parent_entity_id := row_data."scheduleId"::text;
    account_id := row_data."userId"::text;
  ELSIF TG_ARGV[1] = 'work_artifact' THEN
    parent_entity_id := row_data."artifactId"::text;
    SELECT "userId" INTO account_id FROM "WorkArtifact" WHERE id = row_data."artifactId";
  ELSIF TG_ARGV[1] = 'work_skill' THEN
    parent_entity_id := row_data."skillId"::text;
    SELECT "userId" INTO account_id FROM "WorkSkill" WHERE id = row_data."skillId";
  END IF;

  -- The parent went first in the same cascade. The revision row this trigger
  -- wrote on the way in is the only record left of who owned the child.
  IF account_id IS NULL AND TG_OP = 'DELETE' THEN
    SELECT "accountId" INTO account_id FROM "EntityRevision"
      WHERE "entityType" = TG_ARGV[0] AND "entityId" = entity_id LIMIT 1;
  END IF;
  IF account_id IS NULL THEN RETURN NULL; END IF;

  -- Restored guard. See 20260815180000_restore_account_delete_guard.
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE id = account_id) THEN RETURN NULL; END IF;

  INSERT INTO "EntityRevision" ("id", "accountId", "entityType", "entityId", "parentEntityId", "revision", "deletedAt", "updatedAt")
  VALUES ('rev_' || md5(account_id || ':' || TG_ARGV[0] || ':' || entity_id), account_id, TG_ARGV[0], entity_id, parent_entity_id, 1, tombstone_time, CURRENT_TIMESTAMP)
  ON CONFLICT ("accountId", "entityType", "entityId") DO UPDATE
  SET "revision" = "EntityRevision"."revision" + 1, "parentEntityId" = COALESCE(parent_entity_id, "EntityRevision"."parentEntityId"), "deletedAt" = tombstone_time, "updatedAt" = CURRENT_TIMESTAMP
  RETURNING "revision" INTO next_revision;
  IF parent_entity_id IS NULL AND TG_OP = 'DELETE' THEN
    SELECT "parentEntityId" INTO parent_entity_id FROM "EntityRevision" WHERE "accountId" = account_id AND "entityType" = TG_ARGV[0] AND "entityId" = entity_id;
  END IF;
  INSERT INTO "AccountChange" ("accountId", "entityType", "entityId", "parentEntityId", "revision", "operation", "changedAt")
  VALUES (account_id, TG_ARGV[0], entity_id, parent_entity_id, next_revision, CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END, CURRENT_TIMESTAMP);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER juno_change_artifact AFTER INSERT OR UPDATE OR DELETE ON "Artifact"
  FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('artifact', 'artifact_owner');

-- ─── Closed to PostgREST ─────────────────────────────────────────────────────
-- Like every user-owned table since 20260921220000_lock_public_schema_from_postgrest:
-- a draft is the owner's unsaved work, a proposal is Juno's unapplied work, and
-- a publication row holds a public capability token. The default privileges
-- already withhold grants from anon and authenticated; row level security
-- means a grant restored by mistake later still reads nothing. ENABLE, not
-- FORCE: the application connects as the tables' owner and must be unaffected.
ALTER TABLE "ArtifactDraft" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArtifactProposal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ArtifactPublication" ENABLE ROW LEVEL SECURITY;

COMMIT;
