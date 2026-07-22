-- Juno Code Remote sessions: a relay-side index of local Code conversations
-- plus an idempotent command channel back to the owning Mac.
--
-- Two deliberate changes from the version that sat uncommitted for days:
--
-- 1. RE-DATED. The original was stamped 20260719120000, which sorts *before*
--    migrations already applied in production. Prisma would still apply it, but
--    a history that does not read in the order it ran is a trap for whoever
--    reads it next.
--
-- 2. IDEMPOTENT. Every statement is IF NOT EXISTS / guarded. It was never
--    established whether the original ever ran anywhere — answering that needs
--    a _prisma_migrations query against production — so this is written to be
--    safe under either answer instead of betting on one. Re-dating a migration
--    that HAD already run would otherwise re-apply non-idempotent DDL and fail
--    the deploy.
--
-- The CodeTask and CodeSessionCommand unique indexes are (userId,
-- idempotencyKey) with a nullable column: Postgres treats NULLs as distinct, so
-- every existing row and every future host-created task coexist without
-- collision, and the scope to userId stops one account's key matching another's
-- row.

ALTER TABLE "CodeDevice"
  ADD COLUMN IF NOT EXISTS "appVersion" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CodeDevice"
  ADD COLUMN IF NOT EXISTS "protocolVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CodeDevice"
  ADD COLUMN IF NOT EXISTS "sessionListVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "CodeDevice"
  ADD COLUMN IF NOT EXISTS "sessionCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CodeDevice"
  ADD COLUMN IF NOT EXISTS "activeCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CodeTask"
  ADD COLUMN IF NOT EXISTS "parentSessionId" TEXT;
ALTER TABLE "CodeTask"
  ADD COLUMN IF NOT EXISTS "createsNewSession" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CodeTask"
  ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'remote';
ALTER TABLE "CodeTask"
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "CodeTask_userId_idempotencyKey_key"
  ON "CodeTask"("userId", "idempotencyKey");

CREATE TABLE IF NOT EXISTS "CodeRemoteSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "workspaceId" TEXT,
  "workspaceKey" TEXT,
  "workspaceName" TEXT,
  "projectId" TEXT,
  "projectName" TEXT,
  "title" TEXT NOT NULL,
  "titleSource" TEXT NOT NULL DEFAULT 'default',
  "modelId" TEXT NOT NULL,
  "reasoningEffort" TEXT,
  "rolePreset" TEXT NOT NULL DEFAULT 'builder',
  "permissionMode" TEXT NOT NULL DEFAULT 'approvalRequired',
  "origin" TEXT NOT NULL DEFAULT 'local',
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "sessionUpdatedAt" TIMESTAMP(3) NOT NULL,
  "lastMessageAt" TIMESTAMP(3) NOT NULL,
  "currentStatus" TEXT NOT NULL DEFAULT 'idle',
  "isRunning" BOOLEAN NOT NULL DEFAULT false,
  "isAwaitingApproval" BOOLEAN NOT NULL DEFAULT false,
  "pendingChangeCount" INTEGER NOT NULL DEFAULT 0,
  "activeBranch" TEXT,
  "gitDirtyState" TEXT,
  "lastError" TEXT,
  "lastEventSequence" INTEGER NOT NULL DEFAULT 0,
  "transcriptVersion" INTEGER NOT NULL DEFAULT 1,
  "snapshotVersion" INTEGER NOT NULL DEFAULT 1,
  "transcriptPolicy" TEXT NOT NULL DEFAULT 'metadata',
  "transcript" JSONB,
  "changes" JSONB,
  "terminal" JSONB,
  "tests" JSONB,
  "git" JSONB,
  "approvals" JSONB,
  "subagents" JSONB,
  "usage" JSONB,
  "indexedSearch" TEXT NOT NULL DEFAULT '',
  "deletedAt" TIMESTAMP(3),
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CodeRemoteSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CodeRemoteSession_deviceId_sessionId_key"
  ON "CodeRemoteSession"("deviceId", "sessionId");
CREATE INDEX IF NOT EXISTS "CodeRemoteSession_userId_deviceId_sessionUpdatedAt_idx"
  ON "CodeRemoteSession"("userId", "deviceId", "sessionUpdatedAt");
CREATE INDEX IF NOT EXISTS "CodeRemoteSession_deviceId_workspaceKey_idx"
  ON "CodeRemoteSession"("deviceId", "workspaceKey");
CREATE INDEX IF NOT EXISTS "CodeRemoteSession_deviceId_currentStatus_idx"
  ON "CodeRemoteSession"("deviceId", "currentStatus");
CREATE INDEX IF NOT EXISTS "CodeRemoteSession_deviceId_pinned_archived_idx"
  ON "CodeRemoteSession"("deviceId", "pinned", "archived");

CREATE TABLE IF NOT EXISTS "CodeRemoteSessionEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "remoteSessionId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CodeRemoteSessionEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CodeRemoteSessionEvent_remoteSessionId_seq_key"
  ON "CodeRemoteSessionEvent"("remoteSessionId", "seq");
CREATE INDEX IF NOT EXISTS "CodeRemoteSessionEvent_deviceId_sessionId_seq_idx"
  ON "CodeRemoteSessionEvent"("deviceId", "sessionId", "seq");

CREATE TABLE IF NOT EXISTS "CodeSessionCommand" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "remoteSessionId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "result" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "CodeSessionCommand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CodeSessionCommand_userId_idempotencyKey_key"
  ON "CodeSessionCommand"("userId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "CodeSessionCommand_deviceId_status_createdAt_idx"
  ON "CodeSessionCommand"("deviceId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "CodeSessionCommand_deviceId_sessionId_createdAt_idx"
  ON "CodeSessionCommand"("deviceId", "sessionId", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CodeRemoteSession_userId_fkey') THEN
    ALTER TABLE "CodeRemoteSession" ADD CONSTRAINT "CodeRemoteSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CodeRemoteSession_deviceId_fkey') THEN
    ALTER TABLE "CodeRemoteSession" ADD CONSTRAINT "CodeRemoteSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CodeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CodeRemoteSessionEvent_userId_fkey') THEN
    ALTER TABLE "CodeRemoteSessionEvent" ADD CONSTRAINT "CodeRemoteSessionEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CodeRemoteSessionEvent_deviceId_fkey') THEN
    ALTER TABLE "CodeRemoteSessionEvent" ADD CONSTRAINT "CodeRemoteSessionEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CodeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CodeRemoteSessionEvent_remoteSessionId_fkey') THEN
    ALTER TABLE "CodeRemoteSessionEvent" ADD CONSTRAINT "CodeRemoteSessionEvent_remoteSessionId_fkey" FOREIGN KEY ("remoteSessionId") REFERENCES "CodeRemoteSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CodeSessionCommand_userId_fkey') THEN
    ALTER TABLE "CodeSessionCommand" ADD CONSTRAINT "CodeSessionCommand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CodeSessionCommand_deviceId_fkey') THEN
    ALTER TABLE "CodeSessionCommand" ADD CONSTRAINT "CodeSessionCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CodeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CodeSessionCommand_remoteSessionId_fkey') THEN
    ALTER TABLE "CodeSessionCommand" ADD CONSTRAINT "CodeSessionCommand_remoteSessionId_fkey" FOREIGN KEY ("remoteSessionId") REFERENCES "CodeRemoteSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
