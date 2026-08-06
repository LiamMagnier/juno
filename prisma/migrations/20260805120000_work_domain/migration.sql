-- Juno Work — the domain.
--
-- Fifteen new tables and nothing else: no column is altered, no table is
-- dropped, no data is rewritten. A deploy that runs this and is then rolled
-- back leaves a database that every previous build still reads correctly,
-- because every previous build simply never looks at these tables.
--
-- Why new tables rather than columns on the existing ones:
--
--   * A Work task outlives the request that created it, runs again on a
--     schedule, and moves between a cloud container and a Mac. Conversation
--     and Message model a request/response the user is present for; adding a
--     `kind` to them would mean every chat query grew an AND, and every Work
--     query pretended a run was a message.
--
--   * CodeTask is per-execution and per-device. Work needs session (durable)
--     and run (per attempt) as separate rows, because "what did last Tuesday's
--     run cost" is unanswerable once the second attempt has overwritten the
--     first one's columns.
--
-- WorkHost hangs off CodeDevice rather than replacing it. Device identity,
-- pairing and revocation are already solved there and are reused verbatim;
-- what is new is an explicitly-activated, separately-revocable grant that
-- defaults to off. Folding it into CodeDevice would have meant that signing
-- into Juno Code silently made a Mac available for filesystem work.
--
-- Statuses, kinds and targets are TEXT, not PostgreSQL enums. The canonical
-- lists live in src/lib/work/domain.ts and are generated into Swift, so adding
-- one is a code deploy rather than a migration that must land strictly before
-- the first writer emits the value and cannot be rolled back past it.

-- CreateTable

-- IF NOT EXISTS / duplicate_object guards throughout, per the convention in
-- 20260731170000_tool_invocation_audit: a database that picked any of this up
-- out of band must not fail the migration and P3009-poison every later deploy.

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "conversationId" TEXT,
    "title" TEXT NOT NULL,
    "titleSource" TEXT NOT NULL DEFAULT 'default',
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "requestedTarget" TEXT NOT NULL DEFAULT 'automatic',
    "preferredHostId" TEXT,
    "requestedModel" TEXT,
    "reasoningEffort" TEXT,
    "permissionPolicy" TEXT NOT NULL DEFAULT 'balanced',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WorkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkRun" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "scheduleId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "terminalReason" TEXT,
    "terminalDetail" TEXT,
    "requestedTarget" TEXT NOT NULL DEFAULT 'automatic',
    "effectiveTarget" TEXT,
    "hostId" TEXT,
    "requestedModel" TEXT,
    "effectiveModel" TEXT,
    "requiredCapabilities" JSONB NOT NULL DEFAULT '[]',
    "availableCapabilities" JSONB NOT NULL DEFAULT '[]',
    "degradation" JSONB NOT NULL DEFAULT '[]',
    "planVersion" INTEGER NOT NULL DEFAULT 1,
    "permissionPolicy" JSONB NOT NULL DEFAULT '{}',
    "maxCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "maxTokens" INTEGER NOT NULL DEFAULT 0,
    "maxRuntimeMs" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "inputSensitivity" TEXT NOT NULL DEFAULT 'internal',
    "outputSensitivity" TEXT NOT NULL DEFAULT 'internal',
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "visibility" TEXT NOT NULL DEFAULT 'internal',
    "payload" JSONB NOT NULL,
    "eventKey" TEXT,
    "agentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkApproval" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "risk" TEXT NOT NULL DEFAULT 'edit',
    "summary" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "detailVersion" INTEGER NOT NULL DEFAULT 1,
    "actionDigest" TEXT NOT NULL,
    "policyDigest" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "decidedAt" TIMESTAMP(3),
    "decidedVia" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkArtifact" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "validatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WorkArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkArtifactVersion" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "contentHash" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'generated',
    "provenance" JSONB NOT NULL DEFAULT '[]',
    "provenanceVersion" INTEGER NOT NULL DEFAULT 1,
    "validation" JSONB,
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkArtifactVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkFileGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "hostId" TEXT,
    "kind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "localPath" TEXT,
    "remoteRef" TEXT,
    "accessMode" TEXT NOT NULL DEFAULT 'read',
    "resolvedRealPath" TEXT,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkFileGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkHost" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'macos',
    "appVersion" TEXT NOT NULL DEFAULT '',
    "protocolVersion" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "allowsFileWork" BOOLEAN NOT NULL DEFAULT false,
    "allowsBrowser" BOOLEAN NOT NULL DEFAULT false,
    "allowsComputerUse" BOOLEAN NOT NULL DEFAULT false,
    "allowsShell" BOOLEAN NOT NULL DEFAULT false,
    "allowsBackground" BOOLEAN NOT NULL DEFAULT false,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "capabilitiesVersion" INTEGER NOT NULL DEFAULT 1,
    "allowedApps" JSONB NOT NULL DEFAULT '[]',
    "blockedApps" JSONB NOT NULL DEFAULT '[]',
    "allowedDomains" JSONB NOT NULL DEFAULT '[]',
    "approvalPolicy" TEXT NOT NULL DEFAULT 'conservative',
    "state" TEXT NOT NULL DEFAULT 'offline',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activeRunCount" INTEGER NOT NULL DEFAULT 0,
    "queuedRunCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkHost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkCommand" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "runId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "error" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WorkCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkSkill" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trust" TEXT NOT NULL DEFAULT 'user_authored',
    "autoSelect" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "WorkSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkSkillVersion" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "instructions" TEXT NOT NULL,
    "contract" JSONB NOT NULL DEFAULT '{}',
    "contractVersion" INTEGER NOT NULL DEFAULT 1,
    "requestedTools" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkSkillVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT NOT NULL,
    "instructionsVersion" INTEGER NOT NULL DEFAULT 1,
    "target" TEXT NOT NULL DEFAULT 'cloud',
    "hostId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "runConfig" JSONB NOT NULL DEFAULT '{}',
    "runConfigVersion" INTEGER NOT NULL DEFAULT 1,
    "maxCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "maxTokens" INTEGER NOT NULL DEFAULT 0,
    "maxRuntimeMs" INTEGER NOT NULL DEFAULT 0,
    "unattendedPolicy" TEXT NOT NULL DEFAULT 'pause_for_approval',
    "hostOfflinePolicy" TEXT NOT NULL DEFAULT 'skip',
    "maxConcurrentRuns" INTEGER NOT NULL DEFAULT 1,
    "notifyPolicy" TEXT NOT NULL DEFAULT 'on_attention',
    "missedRunPolicy" TEXT NOT NULL DEFAULT 'run_once',
    "retryPolicy" JSONB NOT NULL DEFAULT '{}',
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "legacyScheduledTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkTrigger" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastEventKey" TEXT,
    "lastFiredAt" TIMESTAMP(3),
    "dedupeWindowSec" INTEGER NOT NULL DEFAULT 3600,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkRunIO" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "refKind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkRunIO_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkAuditEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "runId" TEXT,
    "hostId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "actor" TEXT NOT NULL DEFAULT 'cloud_runner',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSession_userId_lastActivityAt_idx" ON "WorkSession"("userId", "lastActivityAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSession_userId_status_lastActivityAt_idx" ON "WorkSession"("userId", "status", "lastActivityAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSession_userId_needsAttention_lastActivityAt_idx" ON "WorkSession"("userId", "needsAttention", "lastActivityAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSession_projectId_lastActivityAt_idx" ON "WorkSession"("projectId", "lastActivityAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSession_conversationId_idx" ON "WorkSession"("conversationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkRun_userId_createdAt_idx" ON "WorkRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkRun_status_leaseExpiresAt_idx" ON "WorkRun"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkRun_hostId_status_idx" ON "WorkRun"("hostId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkRun_scheduleId_createdAt_idx" ON "WorkRun"("scheduleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkRun_sessionId_attempt_key" ON "WorkRun"("sessionId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkRun_userId_idempotencyKey_key" ON "WorkRun"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkEvent_runId_seq_idx" ON "WorkEvent"("runId", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkEvent_userId_createdAt_idx" ON "WorkEvent"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkEvent_runId_seq_key" ON "WorkEvent"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkEvent_runId_eventKey_key" ON "WorkEvent"("runId", "eventKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkApproval_runId_createdAt_idx" ON "WorkApproval"("runId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkApproval_userId_decision_expiresAt_idx" ON "WorkApproval"("userId", "decision", "expiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkArtifact_userId_updatedAt_idx" ON "WorkArtifact"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkArtifact_sessionId_identifier_key" ON "WorkArtifact"("sessionId", "identifier");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkArtifactVersion_runId_idx" ON "WorkArtifactVersion"("runId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkArtifactVersion_artifactId_version_key" ON "WorkArtifactVersion"("artifactId", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkFileGrant_userId_revokedAt_idx" ON "WorkFileGrant"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkFileGrant_hostId_revokedAt_idx" ON "WorkFileGrant"("hostId", "revokedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkFileGrant_sessionId_idx" ON "WorkFileGrant"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkHost_deviceId_key" ON "WorkHost"("deviceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkHost_userId_state_idx" ON "WorkHost"("userId", "state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkHost_userId_revokedAt_idx" ON "WorkHost"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkCommand_hostId_status_createdAt_idx" ON "WorkCommand"("hostId", "status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkCommand_sessionId_createdAt_idx" ON "WorkCommand"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkCommand_userId_idempotencyKey_key" ON "WorkCommand"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSkill_userId_enabled_idx" ON "WorkSkill"("userId", "enabled");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSkill_projectId_idx" ON "WorkSkill"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkSkill_userId_slug_key" ON "WorkSkill"("userId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkSkillVersion_skillId_version_key" ON "WorkSkillVersion"("skillId", "version");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkSchedule_legacyScheduledTaskId_key" ON "WorkSchedule"("legacyScheduledTaskId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSchedule_enabled_nextRunAt_idx" ON "WorkSchedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSchedule_userId_createdAt_idx" ON "WorkSchedule"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSchedule_hostId_enabled_idx" ON "WorkSchedule"("hostId", "enabled");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkTrigger_scheduleId_enabled_idx" ON "WorkTrigger"("scheduleId", "enabled");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkTrigger_userId_kind_idx" ON "WorkTrigger"("userId", "kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkRunIO_runId_direction_idx" ON "WorkRunIO"("runId", "direction");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkRunIO_refKind_refId_idx" ON "WorkRunIO"("refKind", "refId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkAuditEvent_userId_createdAt_idx" ON "WorkAuditEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkAuditEvent_userId_kind_createdAt_idx" ON "WorkAuditEvent"("userId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkAuditEvent_sessionId_createdAt_idx" ON "WorkAuditEvent"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkAuditEvent_hostId_createdAt_idx" ON "WorkAuditEvent"("hostId", "createdAt");

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSession" ADD CONSTRAINT "WorkSession_preferredHostId_fkey" FOREIGN KEY ("preferredHostId") REFERENCES "WorkHost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkRun" ADD CONSTRAINT "WorkRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkRun" ADD CONSTRAINT "WorkRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkRun" ADD CONSTRAINT "WorkRun_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "WorkHost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkRun" ADD CONSTRAINT "WorkRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "WorkSchedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkEvent" ADD CONSTRAINT "WorkEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkEvent" ADD CONSTRAINT "WorkEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkApproval" ADD CONSTRAINT "WorkApproval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkApproval" ADD CONSTRAINT "WorkApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkArtifact" ADD CONSTRAINT "WorkArtifact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkArtifact" ADD CONSTRAINT "WorkArtifact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkArtifactVersion" ADD CONSTRAINT "WorkArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "WorkArtifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkFileGrant" ADD CONSTRAINT "WorkFileGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkFileGrant" ADD CONSTRAINT "WorkFileGrant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkFileGrant" ADD CONSTRAINT "WorkFileGrant_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "WorkHost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkHost" ADD CONSTRAINT "WorkHost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkHost" ADD CONSTRAINT "WorkHost_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CodeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkCommand" ADD CONSTRAINT "WorkCommand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkCommand" ADD CONSTRAINT "WorkCommand_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "WorkHost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkCommand" ADD CONSTRAINT "WorkCommand_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkCommand" ADD CONSTRAINT "WorkCommand_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSkill" ADD CONSTRAINT "WorkSkill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSkill" ADD CONSTRAINT "WorkSkill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSkillVersion" ADD CONSTRAINT "WorkSkillVersion_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "WorkSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSchedule" ADD CONSTRAINT "WorkSchedule_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "WorkHost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkTrigger" ADD CONSTRAINT "WorkTrigger_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "WorkSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkTrigger" ADD CONSTRAINT "WorkTrigger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkRunIO" ADD CONSTRAINT "WorkRunIO_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkAuditEvent" ADD CONSTRAINT "WorkAuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkAuditEvent" ADD CONSTRAINT "WorkAuditEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
