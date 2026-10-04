-- CreateTable
CREATE TABLE "SkillCandidate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "method" JSONB NOT NULL,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "skillId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SkillCandidate_userId_status_idx" ON "SkillCandidate"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SkillCandidate_userId_key_key" ON "SkillCandidate"("userId", "key");

-- AddForeignKey
ALTER TABLE "SkillCandidate" ADD CONSTRAINT "SkillCandidate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

