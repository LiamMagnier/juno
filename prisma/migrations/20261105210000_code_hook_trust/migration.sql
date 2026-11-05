-- Owner-reviewed project hook configurations for cloud Code runs.
CREATE TABLE "CodeHookTrust" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "ref" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeHookTrust_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodeHookTrust_userId_repoOwner_repoName_configHash_key" ON "CodeHookTrust"("userId", "repoOwner", "repoName", "configHash");
CREATE INDEX "CodeHookTrust_userId_createdAt_idx" ON "CodeHookTrust"("userId", "createdAt");

ALTER TABLE "CodeHookTrust" ADD CONSTRAINT "CodeHookTrust_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
