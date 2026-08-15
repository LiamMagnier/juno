-- Teaches the change-capture function the five ownership shapes Juno Work uses,
-- and generalises the tombstone fallback it already had for one of them.
--
-- Creates NO triggers. Applying this file changes nothing about what any
-- existing trigger records; it only makes the arming migration
-- (20260815141000_work_change_capture_triggers) expressible. Split in two on
-- purpose — the second half is the one with a blast radius, and a deployer must
-- be able to take this one without taking that one.
--
-- Two changes to existing behaviour, both fixes:
--
-- 1. The DELETE fallback moves out of the 'conversation' branch and applies to
--    every resolution mode. It also stops hard-coding the entity type. As
--    written it read `"entityType" = 'message'` regardless of which trigger was
--    firing, so it only ever rescued messages. Every other child row whose
--    parent cascade-deletes first — artifact_version when its Conversation
--    goes, message_version when its Message goes — resolved a NULL account and
--    returned early, leaving an EntityRevision that says the entity is live
--    while the row is gone. That is exactly the "neither live nor tombstoned"
--    envelope described in src/lib/sync-entity-envelope.ts, which stalled a real
--    account's initial sync with "Juno returned malformed synchronization data".
--    Postgres deletes the parent and only then cascades, so at the moment a
--    child's trigger fires the parent is already unreadable; the revision row is
--    the only remaining witness to who owned it.
--
-- 2. Five Work modes are added. Work rows carry `userId` directly, so ownership
--    is not the problem — the parent pointer is. `parent_entity_id` is what lets
--    a client tombstone a run's approvals when the run goes without refetching
--    the account, and the existing 'direct' mode records none.
--
--      work_session   parent = sessionId,  owner = row.userId
--      work_run       parent = runId,      owner = row.userId
--      work_schedule  parent = scheduleId, owner = row.userId
--      work_artifact  parent = artifactId, owner = WorkArtifact.userId
--      work_skill     parent = skillId,    owner = WorkSkill.userId
--
--    The last two have no owner column of their own, so they resolve through the
--    head row exactly as 'artifact' already does, and rely on the generalised
--    fallback above when that head row has already been cascaded away.

BEGIN;

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

-- The DELETE fallback above is a sequential scan on "EntityRevision" without
-- this: the table's only index on the pair is the unique key, which leads with
-- "accountId", and the fallback is the one query that does not know it yet. It
-- runs once per cascaded child row, so on a conversation delete that is once per
-- message. Partial rather than full — this lookup only ever runs for a child
-- whose parent is gone, and the index is here to bound a delete, not to serve
-- reads.
CREATE INDEX IF NOT EXISTS "EntityRevision_entityType_entityId_idx"
  ON "EntityRevision"("entityType", "entityId");

COMMIT;
