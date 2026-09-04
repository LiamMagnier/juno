-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "appStoreOriginalTransactionId" TEXT,
ADD COLUMN "appStoreProductId" TEXT,
ADD COLUMN "appStoreEnvironment" TEXT;

-- CreateTable
CREATE TABLE "AppStoreTransaction" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "originalTransactionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "expiresDate" TIMESTAMP(3),
    "revocationDate" TIMESTAMP(3),
    "environment" TEXT NOT NULL DEFAULT 'Production',
    "rawPayload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppStoreTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevicePushToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "bundleId" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevicePushToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_appStoreOriginalTransactionId_key" ON "Subscription"("appStoreOriginalTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "AppStoreTransaction_transactionId_key" ON "AppStoreTransaction"("transactionId");

-- CreateIndex
CREATE INDEX "AppStoreTransaction_originalTransactionId_idx" ON "AppStoreTransaction"("originalTransactionId");

-- CreateIndex
CREATE INDEX "AppStoreTransaction_subscriptionId_idx" ON "AppStoreTransaction"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "DevicePushToken_token_key" ON "DevicePushToken"("token");

-- CreateIndex
CREATE INDEX "DevicePushToken_userId_active_idx" ON "DevicePushToken"("userId", "active");

-- CreateIndex
CREATE INDEX "DevicePushToken_token_idx" ON "DevicePushToken"("token");

-- AddForeignKey
ALTER TABLE "AppStoreTransaction" ADD CONSTRAINT "AppStoreTransaction_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePushToken" ADD CONSTRAINT "DevicePushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
