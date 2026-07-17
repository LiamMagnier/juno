-- A new, initially empty receipt table avoids rebuilding or locking a large
-- production chat table. The existing nullable Conversation keys remain the
-- compatibility bridge for rows accepted before this migration.
CREATE TABLE "ChatFirstSubmissionReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'accepted',
    "conversationId" TEXT NOT NULL,
    "userMessageId" TEXT NOT NULL,
    "assistantMessageId" TEXT,
    "finishReason" TEXT,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),

    CONSTRAINT "ChatFirstSubmissionReceipt_pkey" PRIMARY KEY ("id")
);

-- These indexes are built on the new empty table, so deployment does not need
-- a non-transactional/CONCURRENTLY index operation against production data.
CREATE UNIQUE INDEX "ChatFirstSubmissionReceipt_generationId_key"
ON "ChatFirstSubmissionReceipt"("generationId");

CREATE UNIQUE INDEX "ChatFirstSubmissionReceipt_userId_clientRequestId_key"
ON "ChatFirstSubmissionReceipt"("userId", "clientRequestId");

CREATE UNIQUE INDEX "ChatFirstSubmissionReceipt_userId_clientMessageId_key"
ON "ChatFirstSubmissionReceipt"("userId", "clientMessageId");

CREATE INDEX "ChatFirstSubmissionReceipt_conversationId_idx"
ON "ChatFirstSubmissionReceipt"("conversationId");

ALTER TABLE "ChatFirstSubmissionReceipt"
ADD CONSTRAINT "ChatFirstSubmissionReceipt_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
