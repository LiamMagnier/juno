-- Alevr Secrets (BRIEF §7): sealed credentials, task-scoped grants and an access log.
-- Additive. See src/lib/secrets/{policy,store}.ts.

-- CreateTable
CREATE TABLE "SecretCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "hosts" TEXT[],
    "username" TEXT,
    "sealed" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "hosts" TEXT[],
    "scopes" TEXT[],
    "credentialVersion" INTEGER NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 10,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "grantedVia" TEXT NOT NULL DEFAULT 'web',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretAccessEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT,
    "grantId" TEXT,
    "taskKey" TEXT,
    "host" TEXT,
    "scope" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "receiptRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecretAccessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecretCredential_userId_revokedAt_createdAt_idx" ON "SecretCredential"("userId", "revokedAt", "createdAt");

-- CreateIndex
CREATE INDEX "SecretGrant_userId_taskKey_revokedAt_idx" ON "SecretGrant"("userId", "taskKey", "revokedAt");

-- CreateIndex
CREATE INDEX "SecretGrant_userId_createdAt_idx" ON "SecretGrant"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SecretAccessEvent_userId_createdAt_idx" ON "SecretAccessEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SecretAccessEvent_userId_credentialId_createdAt_idx" ON "SecretAccessEvent"("userId", "credentialId", "createdAt");

-- AddForeignKey
ALTER TABLE "SecretCredential" ADD CONSTRAINT "SecretCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretGrant" ADD CONSTRAINT "SecretGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretGrant" ADD CONSTRAINT "SecretGrant_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "SecretCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretAccessEvent" ADD CONSTRAINT "SecretAccessEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A grant can never be spent past its budget, and always names at least one host and scope.
ALTER TABLE "SecretGrant" ADD CONSTRAINT "SecretGrant_uses_check" CHECK ("uses" >= 0 AND "uses" <= "maxUses");
ALTER TABLE "SecretGrant" ADD CONSTRAINT "SecretGrant_hosts_scopes_check" CHECK (cardinality("hosts") > 0 AND cardinality("scopes") > 0);
