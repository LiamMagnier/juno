-- Orbit durable goals, the work ledger's task fields and temporary specialist
-- teams (docs/rework/program/ORBIT.md).
-- Additive only: every new column has a default or is nullable, so existing
-- goals keep working as before: maxRuns 0 means a goal is not driven, so
-- nothing starts work for an existing goal until its owner turns driving on.

ALTER TABLE "AgentGoal"
  ADD COLUMN "milestones" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "successCriteria" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "blockers" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAction" TEXT,
  ADD COLUMN "budgetMicroUsd" INTEGER,
  ADD COLUMN "spentMicroUsd" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maxRuns" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "runsUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maxAttemptsPerStep" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "advanceLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "lastAdvancedAt" TIMESTAMP(3);

CREATE INDEX "AgentGoal_status_lastAdvancedAt_idx" ON "AgentGoal"("status", "lastAdvancedAt");

ALTER TABLE "WorkSession"
  ADD COLUMN "goalId" TEXT,
  ADD COLUMN "goalStepKey" TEXT,
  ADD COLUMN "dependsOnSessionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "deadlineAt" TIMESTAMP(3),
  ADD COLUMN "completionCriteria" TEXT,
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "dependencyMode" TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN "teamRole" TEXT;

CREATE INDEX "WorkSession_userId_goalId_createdAt_idx" ON "WorkSession"("userId", "goalId", "createdAt");
CREATE INDEX "WorkSession_teamRole_status_idx" ON "WorkSession"("teamRole", "status");
