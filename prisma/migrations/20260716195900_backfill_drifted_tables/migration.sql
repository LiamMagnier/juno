-- Backfill: these tables reached production via one-off `db push` runs, so no

-- migration in the chain creates them and every fresh database broke at the

-- first migration referencing them (20260716200000_account_change_log's

-- triggers). Everything here is guarded, so databases that already carry the

-- tables (production) apply this as a no-op.

--

-- INVARIANT: shapes here must match what `db push` actually put on production

-- at THIS point in the chain — NOT the current schema.prisma. On production

-- every CREATE TABLE below no-ops (the table already exists), so any column a

-- LATER pending migration adds must NOT be referenced here: the CREATE TABLE

-- would not add it and a following statement (e.g. an index) would then fail

-- against the real, older column set and wedge the deploy. Concretely,

-- CodeTask."conversationId" (+ its index) belongs to 20260717090000 and

-- CodeTask."workspaceKey" to 20260717130000; both are IF-NOT-EXISTS-guarded

-- there, so fresh databases converge to the same final shape either way.



DO $$ BEGIN
    CREATE TYPE "MemoryKind" AS ENUM ('FACT', 'SUPPRESSION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "ShareKind" AS ENUM ('CHAT', 'ARTIFACT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "TaskCadence" AS ENUM ('DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ConversationMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "digest" TEXT,
    "factCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationMemory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ApiSpend" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'chat',
    "source" TEXT NOT NULL DEFAULT 'web',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiSpend_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ModerationFlag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "severity" TEXT NOT NULL DEFAULT 'low',
    "category" TEXT NOT NULL DEFAULT 'other',
    "detail" TEXT NOT NULL,
    "messagePreview" TEXT,
    "action" TEXT NOT NULL DEFAULT 'flagged',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationFlag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CodeDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'macos',
    "workspaces" JSONB NOT NULL DEFAULT '[]',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CodeTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "workspacePath" TEXT NOT NULL,
    "workspaceName" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CodeTaskEvent" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeTaskEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Share" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ShareKind" NOT NULL,
    "conversationId" TEXT,
    "artifactId" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "views" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Share_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScheduledTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "cadence" "TaskCadence" NOT NULL DEFAULT 'DAILY',
    "hour" INTEGER NOT NULL DEFAULT 8,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "weekday" INTEGER,
    "monthday" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "webSearch" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ScheduledTaskRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "messageId" TEXT,
    "error" TEXT,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ScheduledTaskRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MessageVersion" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "reasoning" TEXT,
    "model" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "sources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConversationMemory_conversationId_key" ON "ConversationMemory"("conversationId");

CREATE INDEX IF NOT EXISTS "ConversationMemory_userId_idx" ON "ConversationMemory"("userId");

CREATE INDEX IF NOT EXISTS "ApiSpend_userId_createdAt_idx" ON "ApiSpend"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "ModerationFlag_userId_createdAt_idx" ON "ModerationFlag"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "ModerationFlag_reviewedAt_idx" ON "ModerationFlag"("reviewedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "CodeDevice_userId_name_key" ON "CodeDevice"("userId", "name");

CREATE INDEX IF NOT EXISTS "CodeTask_userId_createdAt_idx" ON "CodeTask"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "CodeTask_deviceId_status_idx" ON "CodeTask"("deviceId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "CodeTaskEvent_taskId_seq_key" ON "CodeTaskEvent"("taskId", "seq");

CREATE UNIQUE INDEX IF NOT EXISTS "Share_token_key" ON "Share"("token");

CREATE INDEX IF NOT EXISTS "Share_userId_createdAt_idx" ON "Share"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "Share_conversationId_idx" ON "Share"("conversationId");

CREATE INDEX IF NOT EXISTS "Share_artifactId_idx" ON "Share"("artifactId");

CREATE INDEX IF NOT EXISTS "ScheduledTask_enabled_nextRunAt_idx" ON "ScheduledTask"("enabled", "nextRunAt");

CREATE INDEX IF NOT EXISTS "ScheduledTask_userId_createdAt_idx" ON "ScheduledTask"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "ScheduledTaskRun_taskId_startedAt_idx" ON "ScheduledTaskRun"("taskId", "startedAt");

CREATE INDEX IF NOT EXISTS "MessageVersion_messageId_createdAt_idx" ON "MessageVersion"("messageId", "createdAt");

DO $$ BEGIN
    ALTER TABLE "ConversationMemory" ADD CONSTRAINT "ConversationMemory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ConversationMemory" ADD CONSTRAINT "ConversationMemory_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ApiSpend" ADD CONSTRAINT "ApiSpend_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ModerationFlag" ADD CONSTRAINT "ModerationFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CodeDevice" ADD CONSTRAINT "CodeDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CodeTask" ADD CONSTRAINT "CodeTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CodeTask" ADD CONSTRAINT "CodeTask_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CodeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "CodeTaskEvent" ADD CONSTRAINT "CodeTaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "CodeTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "Share" ADD CONSTRAINT "Share_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "Share" ADD CONSTRAINT "Share_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "Share" ADD CONSTRAINT "Share_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "ScheduledTaskRun" ADD CONSTRAINT "ScheduledTaskRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "MessageVersion" ADD CONSTRAINT "MessageVersion_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- Column-level drift: these columns/values also reached production outside the
-- chain (db push) and are referenced by application code and later migrations.
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'MAX20';
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "forkedFromId" TEXT;
ALTER TABLE "MemoryEntry" ADD COLUMN IF NOT EXISTS "kind" "MemoryKind" NOT NULL DEFAULT 'FACT';
ALTER TABLE "MemoryEntry" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "emailBudgetAlerts" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "emailWeeklyDigest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Usage" ADD COLUMN IF NOT EXISTS "completionTokens" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Usage" ADD COLUMN IF NOT EXISTS "promptTokens" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "banReason" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bannedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bannedBy" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "strikes" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "MemoryEntry_userId_kind_idx" ON "MemoryEntry"("userId", "kind");
