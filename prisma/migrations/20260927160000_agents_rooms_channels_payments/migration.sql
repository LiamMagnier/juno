-- Agents features: rooms, iMessage channels and one-time payment cards
-- (docs/design/agents-rework/FEATURES.md).
--
-- Expand-only (docs/JUNO.md §20.2b). Six new tables and nothing else: no
-- existing table or column changes, so the release before this one keeps
-- working while PM2 reloads.
--
--   "AgentRoomMember"  which agents are in a room (a room is a chat conversation)
--   "AgentRoomTurn"    the per-message plan of agent turns in a room (cap + loop guard)
--   "ChannelLink"      a phone number linked for iMessage (number encrypted, HMAC for lookup)
--   "ChannelInbound"   replay ledger of inbound message handles (hashed, no owner)
--   "AgentSpendLimit"  an agent's monthly spending limit
--   "AgentPayment"     a payment an agent asked for and its single-use card (never the PAN)
--
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma runs the migration inside a
-- transaction. Row level security is ENABLED (never FORCED) on each new table,
-- like every other table. No `juno_record_account_change` trigger: none of
-- these are offline-synced entities.

-- CreateTable
CREATE TABLE "AgentRoomMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRoomMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRoomTurn" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userMessageId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fromAgentId" TEXT,
    "reason" TEXT NOT NULL,
    "request" TEXT,
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRoomTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "phoneHash" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "defaultAgentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelInbound" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "handleHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelInbound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSpendLimit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "monthlyLimitMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSpendLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "conversationId" TEXT,
    "merchant" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCardId" TEXT,
    "last4" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvalReceiptId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "spentMinor" INTEGER,
    "spentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRoomMember_userId_conversationId_idx" ON "AgentRoomMember"("userId", "conversationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRoomMember_userId_agentId_idx" ON "AgentRoomMember"("userId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentRoomMember_conversationId_agentId_key" ON "AgentRoomMember"("conversationId", "agentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRoomTurn_userId_conversationId_createdAt_idx" ON "AgentRoomTurn"("userId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentRoomTurn_messageId_idx" ON "AgentRoomTurn"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentRoomTurn_userMessageId_agentId_key" ON "AgentRoomTurn"("userMessageId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentRoomTurn_userMessageId_position_key" ON "AgentRoomTurn"("userMessageId", "position");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChannelLink_userId_idx" ON "ChannelLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelLink_provider_phoneHash_key" ON "ChannelLink"("provider", "phoneHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChannelInbound_receivedAt_idx" ON "ChannelInbound"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelInbound_provider_handleHash_key" ON "ChannelInbound"("provider", "handleHash");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentSpendLimit_agentId_key" ON "AgentSpendLimit"("agentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentSpendLimit_userId_idx" ON "AgentSpendLimit"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentPayment_userId_agentId_createdAt_idx" ON "AgentPayment"("userId", "agentId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentPayment_providerCardId_idx" ON "AgentPayment"("providerCardId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentPayment_userId_idempotencyKey_key" ON "AgentPayment"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "AgentRoomMember" ADD CONSTRAINT "AgentRoomMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRoomTurn" ADD CONSTRAINT "AgentRoomTurn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelLink" ADD CONSTRAINT "ChannelLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSpendLimit" ADD CONSTRAINT "AgentSpendLimit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPayment" ADD CONSTRAINT "AgentPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row level security (ENABLE, never FORCE)
ALTER TABLE "AgentRoomMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRoomTurn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChannelInbound" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentSpendLimit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentPayment" ENABLE ROW LEVEL SECURITY;
