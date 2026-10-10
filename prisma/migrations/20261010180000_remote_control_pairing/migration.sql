-- Remote control (docs/code-v2/REMOTE-CONTROL.md): the phones and browsers a
-- Mac approved, its two-minute single-use pairing offers, and the per-thread
-- state every device shares (draft, composer settings, unread, needs-you).
-- Additive only: three new tables.

-- CreateTable
CREATE TABLE "DevicePair" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeDeviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT '',
    "deviceSessionId" TEXT,
    "browserKeyHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DevicePair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairingToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeDeviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "codeHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "pairId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadSync" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "draft" TEXT NOT NULL DEFAULT '',
    "draftUpdatedAt" TIMESTAMP(3),
    "draftBy" TEXT,
    "prefs" JSONB NOT NULL DEFAULT '{}',
    "prefsUpdatedAt" TIMESTAMP(3),
    "needsYou" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DevicePair_userId_codeDeviceId_revokedAt_idx" ON "DevicePair"("userId", "codeDeviceId", "revokedAt");

-- CreateIndex
CREATE INDEX "DevicePair_userId_deviceSessionId_idx" ON "DevicePair"("userId", "deviceSessionId");

-- CreateIndex
CREATE INDEX "DevicePair_userId_browserKeyHash_idx" ON "DevicePair"("userId", "browserKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "PairingToken_tokenHash_key" ON "PairingToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PairingToken_userId_codeHash_idx" ON "PairingToken"("userId", "codeHash");

-- CreateIndex
CREATE INDEX "PairingToken_expiresAt_idx" ON "PairingToken"("expiresAt");

-- CreateIndex
CREATE INDEX "ThreadSync_userId_updatedAt_idx" ON "ThreadSync"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadSync_userId_key_key" ON "ThreadSync"("userId", "key");

-- AddForeignKey
ALTER TABLE "DevicePair" ADD CONSTRAINT "DevicePair_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePair" ADD CONSTRAINT "DevicePair_codeDeviceId_fkey" FOREIGN KEY ("codeDeviceId") REFERENCES "CodeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairingToken" ADD CONSTRAINT "PairingToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairingToken" ADD CONSTRAINT "PairingToken_codeDeviceId_fkey" FOREIGN KEY ("codeDeviceId") REFERENCES "CodeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadSync" ADD CONSTRAINT "ThreadSync_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

