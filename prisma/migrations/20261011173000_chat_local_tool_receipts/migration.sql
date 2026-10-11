CREATE TABLE "ChatLocalToolCall" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sealedResult" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "ChatLocalToolCall_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ChatLocalToolCall_status_check" CHECK ("status" IN ('pending', 'completed', 'cancelled', 'expired')),
    CONSTRAINT "ChatLocalToolCall_result_check" CHECK (("status" = 'completed') = ("sealedResult" IS NOT NULL))
);
CREATE INDEX "ChatLocalToolCall_userId_generationId_createdAt_idx" ON "ChatLocalToolCall"("userId", "generationId", "createdAt");
CREATE INDEX "ChatLocalToolCall_expiresAt_idx" ON "ChatLocalToolCall"("expiresAt");
ALTER TABLE "ChatLocalToolCall" ADD CONSTRAINT "ChatLocalToolCall_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
