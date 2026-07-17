-- Record the surface that created a saved chat. Existing rows remain NULL
-- because the old web|app spend tag cannot distinguish iOS, macOS, or Windows.
ALTER TABLE "Conversation"
ADD COLUMN "origin" TEXT,
ADD COLUMN "clientRequestId" TEXT;

-- A client request identifier is scoped to its owner. NULL remains legal for
-- every legacy caller and PostgreSQL permits multiple NULLs in this index.
CREATE UNIQUE INDEX "Conversation_userId_clientRequestId_key"
ON "Conversation"("userId", "clientRequestId");

