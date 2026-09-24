-- Push notifications end to end (docs/design/AGENTS.md §8). Expand-only.

-- Native device tokens: which sign-in registered them, and the two per-device switches.
ALTER TABLE "DevicePushToken" ADD COLUMN IF NOT EXISTS "deviceSessionId" TEXT;
ALTER TABLE "DevicePushToken" ADD COLUMN IF NOT EXISTS "notifyNeedsYou" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "DevicePushToken" ADD COLUMN IF NOT EXISTS "notifyUpdates" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS "DevicePushToken_deviceSessionId_idx" ON "DevicePushToken"("deviceSessionId");

-- The inbox lists newest first regardless of read state.
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- Browser Web Push subscriptions.
CREATE TABLE "WebPushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "notifyNeedsYou" BOOLEAN NOT NULL DEFAULT true,
    "notifyUpdates" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebPushSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebPushSubscription_endpoint_key" ON "WebPushSubscription"("endpoint");
CREATE INDEX "WebPushSubscription_userId_active_idx" ON "WebPushSubscription"("userId", "active");
ALTER TABLE "WebPushSubscription" ADD CONSTRAINT "WebPushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keys Juno provisions for itself (the VAPID pair when VAPID_* is unset).
CREATE TABLE "ServiceKey" (
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceKey_pkey" PRIMARY KEY ("name")
);
