-- Juno Code Remote sessions: a relay-side index of local SwiftData Code
-- conversations plus an idempotent command channel back to the owning Mac.

ALTER TABLE "CodeDevice"
  ADD COLUMN "appVersion" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "protocolVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sessionListVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "sessionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "activeCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CodeTask"
  ADD COLUMN "parentSessionId" TEXT,
  ADD COLUMN "createsNewSession" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'remote',
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "CodeTask_userId_idempotencyKey_key"
  ON "CodeTask"("userId", "idempotencyKey");

CREATE TABLE "CodeRemoteSession" (
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

CREATE UNIQUE INDEX "CodeRemoteSession_deviceId_sessionId_key"
  ON "CodeRemoteSession"("deviceId", "sessionId");
CREATE INDEX "CodeRemoteSession_userId_deviceId_sessionUpdatedAt_idx"
  ON "CodeRemoteSession"("userId", "deviceId", "sessionUpdatedAt");
CREATE INDEX "CodeRemoteSession_deviceId_workspaceKey_idx"
  ON "CodeRemoteSession"("deviceId", "workspaceKey");
CREATE INDEX "CodeRemoteSession_deviceId_currentStatus_idx"
  ON "CodeRemoteSession"("deviceId", "currentStatus");
CREATE INDEX "CodeRemoteSession_deviceId_pinned_archived_idx"
  ON "CodeRemoteSession"("deviceId", "pinned", "archived");

CREATE TABLE "CodeRemoteSessionEvent" (
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

CREATE UNIQUE INDEX "CodeRemoteSessionEvent_remoteSessionId_seq_key"
  ON "CodeRemoteSessionEvent"("remoteSessionId", "seq");
CREATE INDEX "CodeRemoteSessionEvent_deviceId_sessionId_seq_idx"
  ON "CodeRemoteSessionEvent"("deviceId", "sessionId", "seq");

CREATE TABLE "CodeSessionCommand" (
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

CREATE UNIQUE INDEX "CodeSessionCommand_userId_idempotencyKey_key"
  ON "CodeSessionCommand"("userId", "idempotencyKey");
CREATE INDEX "CodeSessionCommand_deviceId_status_createdAt_idx"
  ON "CodeSessionCommand"("deviceId", "status", "createdAt");
CREATE INDEX "CodeSessionCommand_deviceId_sessionId_createdAt_idx"
  ON "CodeSessionCommand"("deviceId", "sessionId", "createdAt");

ALTER TABLE "CodeRemoteSession"
  ADD CONSTRAINT "CodeRemoteSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CodeRemoteSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CodeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodeRemoteSessionEvent"
  ADD CONSTRAINT "CodeRemoteSessionEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CodeRemoteSessionEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CodeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CodeRemoteSessionEvent_remoteSessionId_fkey" FOREIGN KEY ("remoteSessionId") REFERENCES "CodeRemoteSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CodeSessionCommand"
  ADD CONSTRAINT "CodeSessionCommand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CodeSessionCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CodeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CodeSessionCommand_remoteSessionId_fkey" FOREIGN KEY ("remoteSessionId") REFERENCES "CodeRemoteSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
