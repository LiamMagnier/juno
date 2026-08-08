-- Durable import operation and object lifecycle ledger. Object storage is not
-- transactional with PostgreSQL, so these rows let a worker clean staged or
-- uploaded objects after a crash without touching committed attachments.
CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "archiveSha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'applying',
    "result" JSONB,
    "error" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportObject" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "importRunId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'staged',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportObject_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImportRun_userId_archiveSha256_key"
  ON "ImportRun"("userId", "archiveSha256");
CREATE INDEX "ImportRun_userId_status_leaseExpiresAt_idx"
  ON "ImportRun"("userId", "status", "leaseExpiresAt");
CREATE UNIQUE INDEX "ImportObject_importRunId_storageKey_key"
  ON "ImportObject"("importRunId", "storageKey");
CREATE INDEX "ImportObject_userId_status_updatedAt_idx"
  ON "ImportObject"("userId", "status", "updatedAt");

ALTER TABLE "ImportRun"
  ADD CONSTRAINT "ImportRun_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportObject"
  ADD CONSTRAINT "ImportObject_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImportObject"
  ADD CONSTRAINT "ImportObject_importRunId_fkey"
  FOREIGN KEY ("importRunId") REFERENCES "ImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
