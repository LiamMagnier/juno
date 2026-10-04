-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "memoryAccess" TEXT NOT NULL DEFAULT 'profile';

-- CreateTable
CREATE TABLE "MessageRecallIndex" (
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "keyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tokens" TEXT[],
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageRecallIndex_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX "MessageRecallIndex_userId_createdAt_idx" ON "MessageRecallIndex"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageRecallIndex_conversationId_idx" ON "MessageRecallIndex"("conversationId");

-- CreateIndex
CREATE INDEX "MessageRecallIndex_tokens_idx" ON "MessageRecallIndex" USING GIN ("tokens");

-- AddForeignKey
ALTER TABLE "MessageRecallIndex" ADD CONSTRAINT "MessageRecallIndex_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageRecallIndex" ADD CONSTRAINT "MessageRecallIndex_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

