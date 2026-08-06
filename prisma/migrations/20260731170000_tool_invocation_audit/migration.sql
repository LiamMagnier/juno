-- Connector tool calls — the audit trail.
--
-- Every tool call a model makes through a linked connector is recorded here
-- with its arguments, written BEFORE dispatch and updated with the outcome, so
-- a call that never returns still leaves a row.
--
-- Purely additive: a new table plus its indexes, no change to any existing
-- one. IF NOT EXISTS throughout so a database that already picked this up
-- out-of-band does not fail the migration and block every later `migrate
-- deploy` with P3009.

CREATE TABLE IF NOT EXISTS "ToolInvocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "connectorId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "functionName" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "argsTruncated" BOOLEAN NOT NULL DEFAULT false,
    "derivedFromUntrusted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ToolInvocation_pkey" PRIMARY KEY ("id")
);

-- No FK on "conversationId": the column is a soft pointer, and an audit row
-- must outlive the chat it happened in. Deleting a conversation must not
-- silently erase the record of what its tool calls did.
DO $$
BEGIN
    ALTER TABLE "ToolInvocation"
        ADD CONSTRAINT "ToolInvocation_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "ToolInvocation_userId_createdAt_idx" ON "ToolInvocation"("userId", "createdAt");
-- Serves the gate's hot read: this user's still-pending confirmations.
CREATE INDEX IF NOT EXISTS "ToolInvocation_userId_status_createdAt_idx" ON "ToolInvocation"("userId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "ToolInvocation_conversationId_createdAt_idx" ON "ToolInvocation"("conversationId", "createdAt");
