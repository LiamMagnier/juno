-- Link remote code tasks to the kind:"code" Conversation they ran in, so the
-- website's code session view can join history/status. Additive + nullable:
-- every existing task and every old client keeps working unchanged.
ALTER TABLE "CodeTask" ADD COLUMN IF NOT EXISTS "conversationId" TEXT;

CREATE INDEX IF NOT EXISTS "CodeTask_conversationId_idx" ON "CodeTask"("conversationId");
