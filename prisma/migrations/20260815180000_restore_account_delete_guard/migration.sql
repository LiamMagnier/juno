-- Restore the account-delete guard that 20260815140000 dropped.
--
-- `20260717050000_change_log_survives_account_delete` added one line to
-- `juno_record_account_change()`:
--
--   IF NOT EXISTS (SELECT 1 FROM "User" WHERE id = account_id) THEN RETURN NULL; END IF;
--
-- Its own comment says why: during a user delete the cascade fires this trigger
-- for every child row, and writing a change-log row for an account that is on
-- its way out means an "EntityRevision"."accountId" FK back to a "User" that no
-- longer exists — which does not fail quietly, it aborts the whole deletion.
--
-- `20260815140000_work_change_capture_functions` rewrote the function to teach
-- it the five Work owner lookups, and reconstructed the body without that line.
-- Everything else about that migration is correct; this is the one omission.
-- `tests/work-relay-dispatch.test.ts` caught it on its `tear down` step, which
-- is a plain `prisma.user.deleteMany()` — CI failed on
-- `Foreign key constraint violated on the constraint:
-- EntityRevision_accountId_fkey`, one commit after the rewrite landed.
--
-- The function below is 20260815140000's verbatim, with the guard put back in
-- its original position: after the owner has been resolved (so `account_id` is
-- known) and before the first write (so nothing has been inserted yet).
--
-- This is why the function and trigger halves were split across two migrations:
-- the functions half is `CREATE OR REPLACE` on the shared trigger function that
-- EVERY entity type already routes through, so it is not inert — a defect in it
-- reaches conversations, messages and projects immediately, without a single
-- Work trigger being armed.

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
    SELECT c."userId" INTO account_id FROM "Artifact" a JOIN "Conversation" c ON c.id = a."conversationId" WHERE a.id = row_data."artifactId";
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
$$ LANGUAGE plpgsql;