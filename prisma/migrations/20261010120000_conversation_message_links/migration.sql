-- Conversations messaging each other (src/lib/cross-conversation): the
-- messages, the account settings and a conversation's own toggle. Additive
-- only; every new column is nullable or has a default.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "crossMessagesChat" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "crossMessagesCode" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "crossMessages" TEXT;

-- CreateTable
CREATE TABLE "ConversationMessageLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromRef" TEXT NOT NULL,
    "fromTitle" TEXT NOT NULL,
    "toRef" TEXT NOT NULL,
    "toTitle" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "hop" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "notifyWhenIdle" BOOLEAN NOT NULL DEFAULT false,
    "notifiedAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "replyClaimedAt" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessageLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationMessageLink_userId_toRef_createdAt_idx" ON "ConversationMessageLink"("userId", "toRef", "createdAt");
CREATE INDEX "ConversationMessageLink_userId_fromRef_createdAt_idx" ON "ConversationMessageLink"("userId", "fromRef", "createdAt");
CREATE INDEX "ConversationMessageLink_userId_chainId_idx" ON "ConversationMessageLink"("userId", "chainId");
CREATE INDEX "ConversationMessageLink_userId_dedupeKey_createdAt_idx" ON "ConversationMessageLink"("userId", "dedupeKey", "createdAt");
