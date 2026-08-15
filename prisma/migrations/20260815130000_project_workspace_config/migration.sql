-- Project workspace (custom-assistant) configuration, and its registration in
-- the account change feed.
--
-- Until now this lived only in the native client's local encrypted record
-- store, under a namespace the sync engine does not manage: a tool whitelist
-- set on the Mac never reached the phone because there was no route and no
-- table for it to travel through.
--
-- WHY ITS OWN TABLE rather than columns on "Project": the native sync contract
-- versions a whole entity. Sharing "Project"'s EntityRevision would make
-- toggling a tool on one device collide with renaming the project on another,
-- and the mutation endpoint resolves that collision by REJECTING one of them
-- (409 revision_conflict, which the client's outbox records as a dropped
-- write). An independent row gets an independent revision, so the two edits
-- never contend. It also keeps a config edit from touching Project.updatedAt,
-- which drives the sidebar's ordering.
--
-- WHY ONE JSON COLUMN rather than scalar columns: the configuration is
-- three-valued in three places. "Inherit the account default", "restricted to
-- exactly these" and "restricted to nothing" are three different instructions,
-- and the last two differ only as an absent key versus []. Nullable scalar
-- columns cannot hold that distinction through a partial update — Prisma reads
-- an omitted field and an explicit null the same way on a patch — and the
-- collapse turns "inherits account defaults" into "allowed no tools", i.e. an
-- assistant that silently loses every capability. "configVersion" mirrors
-- "Project"."workDefaultsVersion" so an older client can read the parts of a
-- newer payload it understands instead of rejecting the whole shape.
CREATE TABLE "ProjectWorkspace" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "projectId"     TEXT NOT NULL,
  "config"        JSONB NOT NULL DEFAULT '{}',
  "configVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectWorkspace_pkey" PRIMARY KEY ("id")
);

-- One workspace per project. Enforced here rather than by making "projectId"
-- the primary key because the change-capture trigger keys the feed on a scalar
-- "id" column (juno_record_account_change reads row_data.id), and every other
-- synced table has a cuid there.
CREATE UNIQUE INDEX "ProjectWorkspace_projectId_key"
  ON "ProjectWorkspace"("projectId");
-- Redundant as a constraint, kept because it is what lets the mutation's upsert
-- carry the account id in its row lookup. Upserting on "projectId" alone would
-- be a write whose correctness rests entirely on the ownership check preceding
-- it; this way a bug in that check cannot become a cross-account edit.
CREATE UNIQUE INDEX "ProjectWorkspace_userId_projectId_key"
  ON "ProjectWorkspace"("userId", "projectId");
CREATE INDEX "ProjectWorkspace_userId_updatedAt_idx"
  ON "ProjectWorkspace"("userId", "updatedAt");

-- "userId" is denormalised alongside "projectId" so the trigger's 'direct'
-- account resolution applies unchanged. Deriving the account through the
-- project instead would have meant a new TG_ARGV[1] mode, i.e. a CREATE OR
-- REPLACE of the one function all 22 existing change triggers depend on.
ALTER TABLE "ProjectWorkspace"
  ADD CONSTRAINT "ProjectWorkspace_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectWorkspace"
  ADD CONSTRAINT "ProjectWorkspace_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Register the table in the account change feed. Same shape as every other
-- userId-owned synced table; TG_ARGV[0] is the entity type string that
-- /api/v1/changes emits and /api/v1/entities?type= accepts, and it must match
-- the loader key in src/lib/sync-entities.ts exactly.
--
-- No backfill of EntityRevision here (contrast 20260721120000): the table is
-- new and empty, so there is no pre-trigger history to seed.
DROP TRIGGER IF EXISTS juno_change_project_workspace ON "ProjectWorkspace";
CREATE TRIGGER juno_change_project_workspace
  AFTER INSERT OR UPDATE OR DELETE ON "ProjectWorkspace"
  FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('project_workspace', 'direct');
