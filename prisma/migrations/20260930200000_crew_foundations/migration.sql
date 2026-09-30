-- Crew foundations (docs/rework/PRODUCT_REFOUNDATION.md §7, DECISIONS D-007,
-- D-010, D-011).
--
-- Expand-only (docs/JUNO.md §20.2b). Every change is additive: nullable
-- columns on existing tables, and two new tables the running release never
-- reads. Nothing is backfilled and nothing is dropped, so the deployment before
-- this one keeps working while PM2 reloads, and a rollback leaves the new
-- columns unread.
--
--   WorkSession    parentSessionId, delegatedByAgentId, originConversationId,
--                  ownerTransferredAt: the delegation link and the transfer
--                  record (agentId already names the owning crew member).
--   Agent          budgetMicroUsd (a member's own cap inside the account's
--                  weekly window), sourceAssistantId (moved from an assistant).
--   WorkSkill      movedToAgentId, movedAt: an assistant moved to the crew
--                  stays readable and leaves the lists.
--   AgentComputer  takeoverUntil, takeoverStartedAt, takeoverBy: exclusive
--                  takeover the runner checks before every computer tool.
--   ResearchRun    agentId: the crew member whose thread started it.
--   AgentComputerHandoff  single-use, session-bound computer view links.
--   AgentSetupChange      setup changes asked for in a member's thread.
--
-- IF NOT EXISTS on the columns of existing tables so a database where one was
-- added out of band does not fail `migrate deploy` with P3009. Plain CREATE
-- INDEX, not CONCURRENTLY: Prisma runs the migration inside a transaction.
--
-- No `juno_record_account_change` trigger on the new tables: handoffs are
-- runtime state, and setup changes reach the apps through the agent routes.

-- AlterTable
ALTER TABLE "WorkSession" ADD COLUMN IF NOT EXISTS "parentSessionId" TEXT;
ALTER TABLE "WorkSession" ADD COLUMN IF NOT EXISTS "delegatedByAgentId" TEXT;
ALTER TABLE "WorkSession" ADD COLUMN IF NOT EXISTS "originConversationId" TEXT;
ALTER TABLE "WorkSession" ADD COLUMN IF NOT EXISTS "ownerTransferredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WorkSkill" ADD COLUMN IF NOT EXISTS "movedToAgentId" TEXT;
ALTER TABLE "WorkSkill" ADD COLUMN IF NOT EXISTS "movedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ResearchRun" ADD COLUMN IF NOT EXISTS "agentId" TEXT;

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "budgetMicroUsd" INTEGER;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "sourceAssistantId" TEXT;

-- AlterTable
ALTER TABLE "AgentComputer" ADD COLUMN IF NOT EXISTS "takeoverUntil" TIMESTAMP(3);
ALTER TABLE "AgentComputer" ADD COLUMN IF NOT EXISTS "takeoverStartedAt" TIMESTAMP(3);
ALTER TABLE "AgentComputer" ADD COLUMN IF NOT EXISTS "takeoverBy" TEXT;

-- CreateTable
CREATE TABLE "AgentComputerHandoff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "deviceSessionId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "ticketHash" TEXT,
    "ticketExpiresAt" TIMESTAMP(3),
    "exchangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentComputerHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSetupChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "conversationId" TEXT,
    "userMessageId" TEXT,
    "callKey" TEXT,
    "kind" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "affects" TEXT NOT NULL,
    "before" JSONB NOT NULL DEFAULT '{}',
    "after" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "approvalReceiptId" TEXT,
    "detail" TEXT,
    "appliedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSetupChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentComputerHandoff_codeHash_key" ON "AgentComputerHandoff"("codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "AgentComputerHandoff_ticketHash_key" ON "AgentComputerHandoff"("ticketHash");

-- CreateIndex
CREATE INDEX "AgentComputerHandoff_userId_createdAt_idx" ON "AgentComputerHandoff"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentComputerHandoff_expiresAt_idx" ON "AgentComputerHandoff"("expiresAt");

-- CreateIndex
CREATE INDEX "AgentSetupChange_agentId_createdAt_idx" ON "AgentSetupChange"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSetupChange_userId_conversationId_createdAt_idx" ON "AgentSetupChange"("userId", "conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSetupChange_userId_callKey_key" ON "AgentSetupChange"("userId", "callKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSession_parentSessionId_idx" ON "WorkSession"("parentSessionId");

-- AddForeignKey
ALTER TABLE "AgentComputerHandoff" ADD CONSTRAINT "AgentComputerHandoff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSetupChange" ADD CONSTRAINT "AgentSetupChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSetupChange" ADD CONSTRAINT "AgentSetupChange_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to PostgREST like every other user-owned table
-- (20260921220000_lock_public_schema_from_postgrest). ENABLE, not FORCE: the
-- application connects as the table's owner and must be unaffected.
ALTER TABLE "AgentComputerHandoff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentSetupChange" ENABLE ROW LEVEL SECURITY;
