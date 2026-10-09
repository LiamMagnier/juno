-- Alevr Code v2 device link on Postgres (docs/code-v2/DEVICE-LINK.md): the hub's
-- commands, answers, event rings and replay bookkeeping, used when
-- ALEVR_LINK_STORE=postgres. Additive only; transient rows.

-- CreateTable
CREATE TABLE "CodeLinkHost" (
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "lastPullAt" TIMESTAMP(3) NOT NULL,
    "appVersion" TEXT,
    "globalSeq" INTEGER NOT NULL DEFAULT 0,
    "terminalShared" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CodeLinkHost_pkey" PRIMARY KEY ("userId","deviceId")
);

-- CreateTable
CREATE TABLE "CodeLinkCommand" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "relayId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeLinkCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeLinkResponse" (
    "relayId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeLinkResponse_pkey" PRIMARY KEY ("relayId")
);

-- CreateTable
CREATE TABLE "CodeLinkEvent" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeLinkEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeLinkSession" (
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "floor" INTEGER,
    "lastReplayAt" TIMESTAMP(3),
    "replayRelayId" TEXT,
    "replayCursor" INTEGER,

    CONSTRAINT "CodeLinkSession_pkey" PRIMARY KEY ("userId","deviceId","sessionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CodeLinkCommand_relayId_key" ON "CodeLinkCommand"("relayId");

-- CreateIndex
CREATE INDEX "CodeLinkCommand_userId_deviceId_id_idx" ON "CodeLinkCommand"("userId", "deviceId", "id");

-- CreateIndex
CREATE INDEX "CodeLinkCommand_createdAt_idx" ON "CodeLinkCommand"("createdAt");

-- CreateIndex
CREATE INDEX "CodeLinkResponse_createdAt_idx" ON "CodeLinkResponse"("createdAt");

-- CreateIndex
CREATE INDEX "CodeLinkEvent_userId_deviceId_sessionId_sequence_idx" ON "CodeLinkEvent"("userId", "deviceId", "sessionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "CodeLinkEvent_userId_deviceId_sessionId_sequence_eventType_key" ON "CodeLinkEvent"("userId", "deviceId", "sessionId", "sequence", "eventType");

