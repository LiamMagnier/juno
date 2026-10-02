-- ToolRun: one execution of model-written code in a hosted sandbox
-- (docs/rework/TOOL_RUNTIME_DESIGN.md §6.6). Additive: a new table only.
CREATE TABLE "ToolRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "argsDigest" TEXT NOT NULL,
    "conversationId" TEXT,
    "projectId" TEXT,
    "workRunId" TEXT,
    "tool" TEXT NOT NULL DEFAULT 'run_code',
    "language" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT 'hosted_sandbox',
    "skillVersionId" TEXT,
    "skillBundleDigest" TEXT,
    "codeDigest" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "exitCode" INTEGER,
    "durationMs" INTEGER,
    "stdoutBytes" INTEGER,
    "stderrBytes" INTEGER,
    "stdoutTail" TEXT,
    "stderrTail" TEXT,
    "error" TEXT,
    "logKey" TEXT,
    "remoteRunId" TEXT,
    "remoteSession" TEXT,
    "inputs" JSONB NOT NULL DEFAULT '[]',
    "outputs" JSONB NOT NULL DEFAULT '[]',
    "finishedLate" BOOLEAN NOT NULL DEFAULT false,
    "meteredAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ToolRun_sessionId_callId_argsDigest_key" ON "ToolRun"("sessionId", "callId", "argsDigest");
CREATE INDEX "ToolRun_userId_createdAt_idx" ON "ToolRun"("userId", "createdAt");
CREATE INDEX "ToolRun_status_leaseUntil_idx" ON "ToolRun"("status", "leaseUntil");
CREATE INDEX "ToolRun_conversationId_idx" ON "ToolRun"("conversationId");
CREATE INDEX "ToolRun_workRunId_idx" ON "ToolRun"("workRunId");

ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_workRunId_fkey" FOREIGN KEY ("workRunId") REFERENCES "WorkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
