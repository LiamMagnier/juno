-- Universal external-action approval receipts.
--
-- Additive and rollback-safe: old builds ignore the new settings columns and
-- tables. The optional ToolInvocation pointer is SET NULL on receipt deletion,
-- so the audit row keeps its own lifetime.

ALTER TABLE "Settings"
    ADD COLUMN IF NOT EXISTS "actionApprovalPolicy" TEXT NOT NULL DEFAULT 'ask_for_any_change',
    ADD COLUMN IF NOT EXISTS "lockdownMode" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "blockedConnectors" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE IF NOT EXISTS "ActionApprovalReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "conversationId" TEXT,
    "projectId" TEXT,
    "connectorId" TEXT NOT NULL,
    "connectorVersion" TEXT NOT NULL DEFAULT 'unknown',
    "toolName" TEXT NOT NULL,
    "functionName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "riskClass" TEXT NOT NULL,
    "classificationReasons" JSONB NOT NULL DEFAULT '[]',
    "normalizedArgs" JSONB NOT NULL,
    "argsHash" TEXT NOT NULL,
    "receiptDigest" TEXT NOT NULL,
    "preview" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "derivedFromUntrusted" BOOLEAN NOT NULL DEFAULT false,
    "policy" TEXT NOT NULL,
    "policyDigest" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'one_time',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedVia" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "executionResult" TEXT,
    "undoInfo" JSONB,
    "completedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionApprovalReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ActionApprovalGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "projectId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "maxRiskClass" TEXT NOT NULL DEFAULT 'reversible_write',
    "sourceReceiptId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionApprovalGrant_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    ALTER TABLE "ActionApprovalReceipt"
        ADD CONSTRAINT "ActionApprovalReceipt_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "ActionApprovalGrant"
        ADD CONSTRAINT "ActionApprovalGrant_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ToolInvocation" ADD COLUMN IF NOT EXISTS "approvalReceiptId" TEXT;

DO $$
BEGIN
    ALTER TABLE "ToolInvocation"
        ADD CONSTRAINT "ToolInvocation_approvalReceiptId_fkey"
        FOREIGN KEY ("approvalReceiptId") REFERENCES "ActionApprovalReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ActionApprovalReceipt_userId_idempotencyKey_key"
    ON "ActionApprovalReceipt"("userId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "ActionApprovalReceipt_userId_status_expiresAt_idx"
    ON "ActionApprovalReceipt"("userId", "status", "expiresAt");
CREATE INDEX IF NOT EXISTS "ActionApprovalReceipt_conversationId_status_createdAt_idx"
    ON "ActionApprovalReceipt"("conversationId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "ActionApprovalReceipt_sessionId_createdAt_idx"
    ON "ActionApprovalReceipt"("sessionId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "ActionApprovalGrant_userId_connectorId_scopeKey_toolName_key"
    ON "ActionApprovalGrant"("userId", "connectorId", "scopeKey", "toolName");
CREATE INDEX IF NOT EXISTS "ActionApprovalGrant_userId_revokedAt_createdAt_idx"
    ON "ActionApprovalGrant"("userId", "revokedAt", "createdAt");
CREATE INDEX IF NOT EXISTS "ToolInvocation_approvalReceiptId_idx"
    ON "ToolInvocation"("approvalReceiptId");
