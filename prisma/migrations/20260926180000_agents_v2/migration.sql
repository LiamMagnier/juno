-- Agents v2: thread-first agents and agent computers (docs/design/AGENTS.md).
--
-- Expand-only (docs/JUNO.md §20.2b). Two additive columns on "Agent" ("notify"
-- defaulting to 'results' and nullable "pinnedAt") plus the new "AgentComputer"
-- table. The running release does not read the new columns or table, so the
-- deployment before this one keeps working while PM2 reloads.
--
-- IF NOT EXISTS on the columns on the existing "Agent" table so a database
-- where one was added out of band does not fail `migrate deploy` with P3009.
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma runs the migration inside a
-- transaction.
--
-- No `juno_record_account_change` trigger on "AgentComputer": computers are
-- runtime state, not offline-synced entities.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "notify" TEXT NOT NULL DEFAULT 'results';
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AgentComputer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "containerRef" TEXT,
    "secrets" TEXT,
    "status" TEXT NOT NULL DEFAULT 'asleep',
    "streamOn" BOOLEAN NOT NULL DEFAULT false,
    "leaseRunId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastResumedAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),
    "activeSeconds" INTEGER NOT NULL DEFAULT 0,
    "diskMb" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentComputer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentComputer_agentId_key" ON "AgentComputer"("agentId");

-- CreateIndex
CREATE INDEX "AgentComputer_userId_status_idx" ON "AgentComputer"("userId", "status");

-- CreateIndex
CREATE INDEX "AgentComputer_status_lastActiveAt_idx" ON "AgentComputer"("status", "lastActiveAt");

-- AddForeignKey
ALTER TABLE "AgentComputer" ADD CONSTRAINT "AgentComputer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentComputer" ADD CONSTRAINT "AgentComputer_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to PostgREST like every other user-owned table
-- (20260921220000_lock_public_schema_from_postgrest). ENABLE, not FORCE: the
-- application connects as the table's owner and must be unaffected.
ALTER TABLE "AgentComputer" ENABLE ROW LEVEL SECURITY;
