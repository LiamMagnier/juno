-- CreateTable
CREATE TABLE "VoiceTranscriptSession" (
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceTranscriptSession_pkey" PRIMARY KEY ("userId","sessionId")
);

-- CreateIndex
CREATE INDEX "VoiceTranscriptSession_conversationId_idx" ON "VoiceTranscriptSession"("conversationId");

-- AddForeignKey
ALTER TABLE "VoiceTranscriptSession" ADD CONSTRAINT "VoiceTranscriptSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceTranscriptSession" ADD CONSTRAINT "VoiceTranscriptSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
