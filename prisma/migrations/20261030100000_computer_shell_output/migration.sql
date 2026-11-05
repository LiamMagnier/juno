-- Streamed computer_shell output for the read-only terminal pane
-- (docs/design/agents-v2/COMPUTERS_2026-10.md §4.1 and S5.1).
--
-- Expand-only (docs/JUNO.md §20.2b): one new table the running release never
-- reads. Nothing existing changes, so the deployment before this one keeps
-- working while PM2 reloads, and a rollback leaves the table unread.
--
--   ComputerShellOutput  one row per batch of a shell call's output: a
--                        `command` row first, `stdout`/`stderr` rows, an
--                        `exit` row last. `text` is encryptSecret() of at most
--                        16 KB of plaintext. `seq` is numbered per run by the
--                        Work runner's writer, so the pane reads "after <seq>".
--
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma runs the migration inside a
-- transaction. No `juno_record_account_change` trigger: the apps never sync it.

-- CreateTable
CREATE TABLE "ComputerShellOutput" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComputerShellOutput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComputerShellOutput_runId_callId_seq_key" ON "ComputerShellOutput"("runId", "callId", "seq");

-- CreateIndex
CREATE INDEX "ComputerShellOutput_userId_agentId_createdAt_idx" ON "ComputerShellOutput"("userId", "agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "ComputerShellOutput" ADD CONSTRAINT "ComputerShellOutput_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComputerShellOutput" ADD CONSTRAINT "ComputerShellOutput_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to PostgREST like every other user-owned table
-- (20260921220000_lock_public_schema_from_postgrest). ENABLE, not FORCE: the
-- application connects as the table's owner and must be unaffected.
ALTER TABLE "ComputerShellOutput" ENABLE ROW LEVEL SECURITY;
