-- Reconcile the two places where the applied migration history had drifted from
-- `schema.prisma`, so that replaying `prisma/migrations` from empty reproduces
-- the datamodel exactly and the deploy gate stops failing.
--
-- The two other disagreements in the same drift report were schema-side, not
-- database-side, and are fixed in `schema.prisma` rather than here:
--
--   * Attachment (userId, idempotencyKey) is UNIQUE in the database and was
--     declared as a plain @@index. The database is right — /api/v1/attachments
--     reads the prior row and only then inserts, so the constraint is the only
--     thing standing between two concurrent retries of one upload and two rows.
--   * EntityRevision."updatedAt" carries DEFAULT CURRENT_TIMESTAMP, which
--     `schema.prisma` did not declare. The database is right again: this table
--     is written by the juno_record_account_change() trigger as well as by the
--     Prisma client, so a server-side default belongs on it.

-- 1. The CodeTask agent-profile columns.
--
-- 20260726003000_code_agent_runtime added these six for a provider-neutral
-- agent profile; 03ce5cb reverted the feature the same day — schema, API route,
-- cloud runner and native client — but deliberately left the migration in
-- place, because deleting an applied migration makes `migrate deploy` fail on a
-- migration recorded in the database and missing on disk. That commit named the
-- remaining work exactly: "removing them would need a new migration, not the
-- deletion of an old one." This is that migration.
--
-- Nothing reads these columns. The only mention of "agentRuntime" left anywhere
-- in the tree is the migration that created it.
--
-- Destructive and NOT reversible by re-running an earlier migration: any values
-- written during the window when the feature was live are dropped with the
-- columns. That is accepted — they have had no reader since the revert.
ALTER TABLE "CodeTask"
  DROP COLUMN IF EXISTS "agentRuntime",
  DROP COLUMN IF EXISTS "permissionMode",
  DROP COLUMN IF EXISTS "modelId",
  DROP COLUMN IF EXISTS "reasoningEffort",
  DROP COLUMN IF EXISTS "computerUse",
  DROP COLUMN IF EXISTS "subagentsEnabled";

-- 2. The MutationReceipt unique index name.
--
-- 20260716200000_account_change_log is hand-written SQL and spelled the index
-- out in full, as "MutationReceipt_accountId_authenticatedDeviceId_clientMutat\
-- ionId_key" — 68 characters. Postgres silently truncates identifiers at 63,
-- landing on "..._clientMutationI". Prisma truncates differently, keeping its
-- "_key" suffix, so it expects "..._clientMutat_key" and reports a rename.
--
-- Name-only: same table, same columns, same uniqueness. Renaming an index is a
-- catalog update, so there is no rebuild and no table scan.
--
-- The guard matches what the rename itself will do. ALTER INDEX takes an
-- unqualified name and resolves it through search_path, so a probe on relname
-- alone can answer for a different object than the one the statement would
-- touch — another schema's index of the same name, or a non-index relation
-- that happens to share it. Both conditions therefore pin relkind = 'i' and
-- require search_path visibility, so the object detected is the object
-- renamed, and a same-named index parked in some other schema neither
-- triggers a rename here nor suppresses one.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relname = 'MutationReceipt_accountId_authenticatedDeviceId_clientMutationI'
      AND c.relkind = 'i'
      AND pg_catalog.pg_table_is_visible(c.oid)
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relname = 'MutationReceipt_accountId_authenticatedDeviceId_clientMutat_key'
      AND c.relkind = 'i'
      AND pg_catalog.pg_table_is_visible(c.oid)
  ) THEN
    ALTER INDEX "MutationReceipt_accountId_authenticatedDeviceId_clientMutationI"
      RENAME TO "MutationReceipt_accountId_authenticatedDeviceId_clientMutat_key";
  END IF;
END $$;
