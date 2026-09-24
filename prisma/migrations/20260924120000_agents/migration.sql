-- Agents: named, persistent teammates over Work (docs/design/AGENTS.md).
--
-- Expand-only (docs/JUNO.md §20.2b). Five new tables the running release never
-- reads, and two nullable pointer columns ("Conversation"."agentId",
-- "WorkSession"."agentId") that every existing row starts NULL on — which is
-- exactly what they mean for a chat or a task that no agent owns. Nothing is
-- backfilled, renamed or tightened, so the release before this one keeps
-- working against the migrated database while PM2 reloads.
--
-- The two pointers are plain columns, not foreign keys, for the reason
-- "WorkSession"."conversationId" already gives: retiring an agent must not take
-- its thread or its tasks' history with it.
--
-- IF NOT EXISTS on the columns and indexes on existing tables, as the other
-- index migrations do, so a database where one was added out of band does not
-- fail `migrate deploy` with P3009. Plain CREATE INDEX, not CONCURRENTLY:
-- Prisma runs the migration inside a transaction.

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "agentId" TEXT;

-- AlterTable
ALTER TABLE "WorkSession" ADD COLUMN IF NOT EXISTS "agentId" TEXT;

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "avatar" JSONB NOT NULL DEFAULT '{}',
    "style" TEXT NOT NULL DEFAULT 'warm',
    "instructions" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "reasoningEffort" TEXT,
    "approvalMode" TEXT NOT NULL DEFAULT 'balanced',
    "connectorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "projectId" TEXT,
    "conversationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "proactive" BOOLEAN NOT NULL DEFAULT true,
    "template" TEXT,
    "lastReflectedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentGoal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "cadence" TEXT NOT NULL DEFAULT 'weekly',
    "lastCheckInAt" TIMESTAMP(3),
    "lastCheckInNote" TEXT,
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentIdea" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "goalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "AgentIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentNote" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AgentNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_conversationId_key" ON "Agent"("conversationId");

-- CreateIndex
CREATE INDEX "Agent_userId_deletedAt_sortOrder_idx" ON "Agent"("userId", "deletedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "AgentGoal_agentId_status_createdAt_idx" ON "AgentGoal"("agentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentGoal_userId_createdAt_idx" ON "AgentGoal"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentIdea_agentId_status_createdAt_idx" ON "AgentIdea"("agentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentIdea_userId_createdAt_idx" ON "AgentIdea"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentNote_agentId_deletedAt_createdAt_idx" ON "AgentNote"("agentId", "deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "AgentNote_userId_createdAt_idx" ON "AgentNote"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEvent_agentId_createdAt_idx" ON "AgentEvent"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEvent_userId_createdAt_idx" ON "AgentEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Conversation_agentId_idx" ON "Conversation"("agentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSession_userId_agentId_lastActivityAt_idx" ON "WorkSession"("userId", "agentId", "lastActivityAt");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGoal" ADD CONSTRAINT "AgentGoal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGoal" ADD CONSTRAINT "AgentGoal_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentIdea" ADD CONSTRAINT "AgentIdea_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentIdea" ADD CONSTRAINT "AgentIdea_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentNote" ADD CONSTRAINT "AgentNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentNote" ADD CONSTRAINT "AgentNote_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

