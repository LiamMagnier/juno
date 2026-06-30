-- CreateEnum
CREATE TYPE "FeatureStatus" AS ENUM ('UNDER_REVIEW', 'PLANNED', 'IN_PROGRESS', 'SHIPPED', 'DECLINED');

-- CreateEnum
CREATE TYPE "FeatureCategory" AS ENUM ('CHAT', 'MODELS', 'CANVAS', 'MEMORY', 'VOICE', 'FILES', 'BILLING', 'UI', 'INTEGRATIONS', 'OTHER');

-- CreateTable
CREATE TABLE "FeatureRequest" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "FeatureCategory" NOT NULL DEFAULT 'OTHER',
    "status" "FeatureStatus" NOT NULL DEFAULT 'UNDER_REVIEW',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "declineReason" TEXT,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureVote" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureComment" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "official" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureStatusEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" "FeatureStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeatureRequest_status_createdAt_idx" ON "FeatureRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FeatureVote_userId_idx" ON "FeatureVote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureVote_requestId_userId_key" ON "FeatureVote"("requestId", "userId");

-- CreateIndex
CREATE INDEX "FeatureComment_requestId_createdAt_idx" ON "FeatureComment"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "FeatureStatusEvent_requestId_createdAt_idx" ON "FeatureStatusEvent"("requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "FeatureRequest" ADD CONSTRAINT "FeatureRequest_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureVote" ADD CONSTRAINT "FeatureVote_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "FeatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureVote" ADD CONSTRAINT "FeatureVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureComment" ADD CONSTRAINT "FeatureComment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "FeatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureComment" ADD CONSTRAINT "FeatureComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureStatusEvent" ADD CONSTRAINT "FeatureStatusEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "FeatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
