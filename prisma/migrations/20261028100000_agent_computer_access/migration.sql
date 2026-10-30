-- Agent computers: access, the weekly allowance, the per-agent policy and the
-- operator audit (docs/design/agents-v2/COMPUTERS_2026-10.md §4.1, stage S1).
--
-- Expand-only (docs/JUNO.md §20.2b). Every change is additive: one defaulted
-- column and one nullable column on existing tables, and two new tables the
-- running release never reads. Nothing is dropped, so the deployment before
-- this one keeps working while PM2 reloads, and a rollback leaves the new
-- columns and tables unread.
--
--   Agent                       computerPolicy (off | ask | allowed), default
--                               'ask'. An agent that already has a computer
--                               maps to 'allowed', so it keeps being used
--                               without a new question.
--   AgentComputer               lastContactAt: the last time the sweep reached
--                               the computer through its provider.
--   AgentComputerUsageInterval  metered awake intervals against the weekly
--                               allowance; idempotent per (agentId, startedAt).
--   AgentComputerAudit          identifiers and verdicts only.
--
-- IF NOT EXISTS on the columns of existing tables so a database where one was
-- added out of band does not fail `migrate deploy` with P3009. Plain CREATE
-- INDEX, not CONCURRENTLY: Prisma runs the migration inside a transaction.
--
-- No `juno_record_account_change` trigger on the new tables: usage and audit
-- rows are operator records, and the apps never sync them.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "computerPolicy" TEXT NOT NULL DEFAULT 'ask';

-- AlterTable
ALTER TABLE "AgentComputer" ADD COLUMN IF NOT EXISTS "lastContactAt" TIMESTAMP(3);

-- Data: agents whose person already enabled a computer keep using it.
UPDATE "Agent" SET "computerPolicy" = 'allowed' WHERE "id" IN (SELECT "agentId" FROM "AgentComputer");

-- CreateTable
CREATE TABLE "AgentComputerUsageInterval" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "seconds" INTEGER NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentComputerUsageInterval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentComputerAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentComputerAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentComputerUsageInterval_agentId_startedAt_key" ON "AgentComputerUsageInterval"("agentId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentComputerUsageInterval_userId_weekStart_idx" ON "AgentComputerUsageInterval"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "AgentComputerAudit_userId_createdAt_idx" ON "AgentComputerAudit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentComputerAudit_agentId_createdAt_idx" ON "AgentComputerAudit"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentComputerAudit_kind_createdAt_idx" ON "AgentComputerAudit"("kind", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentComputerUsageInterval" ADD CONSTRAINT "AgentComputerUsageInterval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentComputerAudit" ADD CONSTRAINT "AgentComputerAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to PostgREST like every other user-owned table
-- (20260921220000_lock_public_schema_from_postgrest). ENABLE, not FORCE: the
-- application connects as the table's owner and must be unaffected.
ALTER TABLE "AgentComputerUsageInterval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentComputerAudit" ENABLE ROW LEVEL SECURITY;
