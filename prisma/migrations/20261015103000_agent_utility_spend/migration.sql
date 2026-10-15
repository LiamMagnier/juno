ALTER TABLE "ApiSpend" ADD COLUMN "agentId" TEXT;
CREATE INDEX "ApiSpend_userId_agentId_createdAt_idx" ON "ApiSpend"("userId", "agentId", "createdAt");
