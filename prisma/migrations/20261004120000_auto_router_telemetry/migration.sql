-- Auto Router 2.0 (docs/rework/program/AUTO_ROUTER.md).
-- All additive: a nullable column, two defaulted TEXT settings, one new table.

-- Auto's receipt on the turn it routed.
ALTER TABLE "Message" ADD COLUMN "routing" JSONB;

-- The reader's Auto preference and data boundary.
ALTER TABLE "Settings" ADD COLUMN "autoPreference" TEXT NOT NULL DEFAULT 'balanced';
ALTER TABLE "Settings" ADD COLUMN "autoDataBoundary" TEXT NOT NULL DEFAULT 'verified_no_training';

-- Privacy-conscious routing telemetry: no user id, no content.
CREATE TABLE "RoutingOutcome" (
    "id" TEXT NOT NULL,
    "messageId" TEXT,
    "routerVersion" INTEGER NOT NULL,
    "auto" BOOLEAN NOT NULL,
    "taskClass" TEXT NOT NULL,
    "complexity" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "effort" TEXT,
    "latencyMs" INTEGER,
    "firstTokenMs" INTEGER,
    "toolRounds" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "completionState" TEXT NOT NULL,
    "finishReason" TEXT,
    "userRegenerated" BOOLEAN NOT NULL DEFAULT false,
    "userSwitchedModel" BOOLEAN NOT NULL DEFAULT false,
    "userEdited" BOOLEAN NOT NULL DEFAULT false,
    "feedback" TEXT,
    "costMicroUsd" INTEGER,
    "expectedMicroUsd" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RoutingOutcome_messageId_key" ON "RoutingOutcome"("messageId");
CREATE INDEX "RoutingOutcome_modelId_taskClass_createdAt_idx" ON "RoutingOutcome"("modelId", "taskClass", "createdAt");
CREATE INDEX "RoutingOutcome_createdAt_idx" ON "RoutingOutcome"("createdAt");
