CREATE TABLE "NativeAuthorizationCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "installationIdHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    CONSTRAINT "NativeAuthorizationCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NativeDeviceSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installationIdHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revocationReason" TEXT,
    CONSTRAINT "NativeDeviceSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NativeRefreshToken" (
    "id" TEXT NOT NULL,
    "deviceSessionId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "parentTokenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "NativeRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NativeAuthorizationCode_codeHash_key" ON "NativeAuthorizationCode"("codeHash");
CREATE INDEX "NativeAuthorizationCode_userId_expiresAt_idx" ON "NativeAuthorizationCode"("userId", "expiresAt");
CREATE INDEX "NativeDeviceSession_userId_revokedAt_idx" ON "NativeDeviceSession"("userId", "revokedAt");
CREATE INDEX "NativeDeviceSession_userId_installationIdHash_idx" ON "NativeDeviceSession"("userId", "installationIdHash");
CREATE UNIQUE INDEX "NativeRefreshToken_tokenHash_key" ON "NativeRefreshToken"("tokenHash");
CREATE INDEX "NativeRefreshToken_deviceSessionId_familyId_idx" ON "NativeRefreshToken"("deviceSessionId", "familyId");
CREATE INDEX "NativeRefreshToken_expiresAt_idx" ON "NativeRefreshToken"("expiresAt");

ALTER TABLE "NativeAuthorizationCode" ADD CONSTRAINT "NativeAuthorizationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeDeviceSession" ADD CONSTRAINT "NativeDeviceSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NativeRefreshToken" ADD CONSTRAINT "NativeRefreshToken_deviceSessionId_fkey" FOREIGN KEY ("deviceSessionId") REFERENCES "NativeDeviceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
