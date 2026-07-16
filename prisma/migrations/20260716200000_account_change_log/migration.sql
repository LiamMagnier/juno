CREATE TABLE "EntityRevision" (
    "id" TEXT NOT NULL, "accountId" TEXT NOT NULL, "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL, "parentEntityId" TEXT, "revision" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntityRevision_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AccountChange" (
    "cursor" BIGSERIAL NOT NULL, "accountId" TEXT NOT NULL, "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL, "parentEntityId" TEXT, "revision" INTEGER NOT NULL, "operation" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountChange_pkey" PRIMARY KEY ("cursor")
);
CREATE TABLE "MutationReceipt" (
    "id" TEXT NOT NULL, "accountId" TEXT NOT NULL, "authenticatedDeviceId" TEXT NOT NULL,
    "clientMutationId" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "status" INTEGER NOT NULL,
    "result" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MutationReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EntityRevision_accountId_entityType_entityId_key" ON "EntityRevision"("accountId", "entityType", "entityId");
CREATE INDEX "EntityRevision_accountId_entityType_idx" ON "EntityRevision"("accountId", "entityType");
CREATE INDEX "AccountChange_accountId_cursor_idx" ON "AccountChange"("accountId", "cursor");
CREATE UNIQUE INDEX "MutationReceipt_accountId_authenticatedDeviceId_clientMutationId_key" ON "MutationReceipt"("accountId", "authenticatedDeviceId", "clientMutationId");
CREATE INDEX "MutationReceipt_accountId_createdAt_idx" ON "MutationReceipt"("accountId", "createdAt");
ALTER TABLE "EntityRevision" ADD CONSTRAINT "EntityRevision_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountChange" ADD CONSTRAINT "AccountChange_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MutationReceipt" ADD CONSTRAINT "MutationReceipt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
    IF account_id IS NULL AND TG_OP = 'DELETE' THEN
      SELECT "accountId" INTO account_id FROM "EntityRevision" WHERE "entityType" = 'message' AND "entityId" = entity_id LIMIT 1;
    END IF;
  ELSIF TG_ARGV[1] = 'code_task' THEN
    parent_entity_id := row_data."taskId"::text;
    SELECT "userId" INTO account_id FROM "CodeTask" WHERE id = row_data."taskId";
  ELSIF TG_ARGV[1] = 'artifact' THEN
    parent_entity_id := row_data."artifactId"::text;
    SELECT c."userId" INTO account_id FROM "Artifact" a JOIN "Conversation" c ON c.id = a."conversationId" WHERE a.id = row_data."artifactId";
  ELSIF TG_ARGV[1] = 'message_parent' THEN
    parent_entity_id := row_data."messageId"::text;
    SELECT c."userId" INTO account_id FROM "Message" m JOIN "Conversation" c ON c.id = m."conversationId" WHERE m.id = row_data."messageId";
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

CREATE TRIGGER juno_change_user AFTER UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('profile', 'user');
CREATE TRIGGER juno_change_settings AFTER INSERT OR UPDATE OR DELETE ON "Settings" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('settings', 'direct');
CREATE TRIGGER juno_change_subscription AFTER INSERT OR UPDATE OR DELETE ON "Subscription" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('subscription', 'direct');
CREATE TRIGGER juno_change_folder AFTER INSERT OR UPDATE OR DELETE ON "Folder" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('folder', 'direct');
CREATE TRIGGER juno_change_conversation AFTER INSERT OR UPDATE OR DELETE ON "Conversation" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('conversation', 'direct');
CREATE TRIGGER juno_change_message AFTER INSERT OR UPDATE OR DELETE ON "Message" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('message', 'conversation');
CREATE TRIGGER juno_change_message_version AFTER INSERT OR UPDATE OR DELETE ON "MessageVersion" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('message_version', 'message_parent');
CREATE TRIGGER juno_change_attachment AFTER INSERT OR UPDATE OR DELETE ON "Attachment" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('attachment', 'direct');
CREATE TRIGGER juno_change_artifact AFTER INSERT OR UPDATE OR DELETE ON "Artifact" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('artifact', 'conversation');
CREATE TRIGGER juno_change_artifact_version AFTER INSERT OR UPDATE OR DELETE ON "ArtifactVersion" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('artifact_version', 'artifact');
CREATE TRIGGER juno_change_project AFTER INSERT OR UPDATE OR DELETE ON "Project" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('project', 'direct');
CREATE TRIGGER juno_change_memory AFTER INSERT OR UPDATE OR DELETE ON "MemoryEntry" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('memory', 'direct');
CREATE TRIGGER juno_change_prompt AFTER INSERT OR UPDATE OR DELETE ON "SavedPrompt" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('saved_prompt', 'direct');
CREATE TRIGGER juno_change_connection AFTER INSERT OR UPDATE OR DELETE ON "Connection" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('connection', 'direct');
CREATE TRIGGER juno_change_usage AFTER INSERT OR UPDATE OR DELETE ON "Usage" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('usage', 'direct');
CREATE TRIGGER juno_change_share AFTER INSERT OR UPDATE OR DELETE ON "Share" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('share', 'direct');
CREATE TRIGGER juno_change_announcement_dismissal AFTER INSERT OR UPDATE OR DELETE ON "AnnouncementDismissal" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('announcement_dismissal', 'direct');
CREATE TRIGGER juno_change_task AFTER INSERT OR UPDATE OR DELETE ON "ScheduledTask" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('scheduled_task', 'direct');
CREATE TRIGGER juno_change_code_device AFTER INSERT OR UPDATE OR DELETE ON "CodeDevice" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('code_device', 'direct');
CREATE TRIGGER juno_change_code_task AFTER INSERT OR UPDATE OR DELETE ON "CodeTask" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('code_task', 'direct');
CREATE TRIGGER juno_change_code_event AFTER INSERT OR UPDATE OR DELETE ON "CodeTaskEvent" FOR EACH ROW EXECUTE FUNCTION juno_record_account_change('code_task_event', 'code_task');
