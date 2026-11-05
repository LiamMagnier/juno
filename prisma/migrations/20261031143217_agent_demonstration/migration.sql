-- Teach by demonstration (docs/design/agents-v2/TEACH.md): a task the person
-- showed an agent once on its computer, recorded during a take over.
--
-- Expand-only (docs/JUNO.md §20.2b): one new table the running release never
-- reads. Nothing existing changes, so the deployment before this one keeps
-- working while PM2 reloads, and a rollback leaves the table unread.
--
--   AgentDemonstration  one row per recording. `trace` and `shots` are
--                       encryptField() ciphertext of the redacted trace and of
--                       at most eight low-resolution screenshots. Secrets typed
--                       during the recording are never in either: the page
--                       capture and the trace builder replace them with
--                       placeholders such as {{password}}.
--
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma runs the migration inside a
-- transaction. No `juno_record_account_change` trigger: the apps never sync it.

-- CreateTable
CREATE TABLE "AgentDemonstration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'recording',
    "endReason" TEXT,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "trace" TEXT,
    "shots" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDemonstration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentDemonstration_userId_agentId_createdAt_idx" ON "AgentDemonstration"("userId", "agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentDemonstration" ADD CONSTRAINT "AgentDemonstration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentDemonstration" ADD CONSTRAINT "AgentDemonstration_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to PostgREST like every other user-owned table
-- (20260921220000_lock_public_schema_from_postgrest). ENABLE, not FORCE: the
-- application connects as the table's owner and must be unaffected.
ALTER TABLE "AgentDemonstration" ENABLE ROW LEVEL SECURITY;
