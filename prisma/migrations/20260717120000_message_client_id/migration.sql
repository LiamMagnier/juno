-- Native transcript pushes (POST /api/conversations/[id]/messages) are
-- idempotent on (conversationId, clientId): a retried batch reuses the rows
-- the first attempt created instead of duplicating turns. Additive + nullable:
-- every message the web pipeline writes simply leaves clientId NULL, and
-- Postgres unique indexes treat NULLs as distinct, so existing rows are
-- unaffected.
ALTER TABLE "Message" ADD COLUMN "clientId" TEXT;

CREATE UNIQUE INDEX "Message_conversationId_clientId_key" ON "Message"("conversationId", "clientId");
