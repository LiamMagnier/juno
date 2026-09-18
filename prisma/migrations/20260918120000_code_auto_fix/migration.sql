-- Auto-fix: Juno answering what GitHub says about a pull request it opened.
--
-- Expand-only (see docs/JUNO.md §20.2b): two new tables, nothing renamed and
-- nothing dropped. No existing row changes meaning, and a deployment that never
-- configures GITHUB_APP_WEBHOOK_SECRET simply never writes to either table —
-- auto-fix is off for every pull request until someone switches it on, and
-- there is no route that can create a row already enabled.

CREATE TABLE "CodeAutoFixWatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    -- The head branch at the time the toggle was set. A check run that names no
    -- pull request still names a branch, and this is what lets such a delivery
    -- find its session.
    "branch" TEXT,
    "conversationId" TEXT,
    -- OFF by default, and there is no path that inserts a row already true. A
    -- machine that edits your branch because it read a comment is not something
    -- anyone should discover.
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeAutoFixWatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodeAutoFixWatch_userId_repoOwner_repoName_prNumber_key"
  ON "CodeAutoFixWatch"("userId", "repoOwner", "repoName", "prNumber");
-- The webhook arrives holding a repository and a number and no user at all;
-- these two indexes are the only lookups it can make.
CREATE INDEX "CodeAutoFixWatch_repoOwner_repoName_prNumber_idx"
  ON "CodeAutoFixWatch"("repoOwner", "repoName", "prNumber");
CREATE INDEX "CodeAutoFixWatch_repoOwner_repoName_branch_idx"
  ON "CodeAutoFixWatch"("repoOwner", "repoName", "branch");

ALTER TABLE "CodeAutoFixWatch"
  ADD CONSTRAINT "CodeAutoFixWatch_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CodeAutoFixDelivery" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    -- Identity of the EVIDENCE, not of the delivery: GitHub redelivers a failed
    -- webhook under a fresh delivery id, and answering the same failing check
    -- twice is the duplicate this column exists to catch.
    "digest" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "note" TEXT NOT NULL,
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CodeAutoFixDelivery_pkey" PRIMARY KEY ("id")
);

-- The duplicate guard, enforced by the database rather than by a read-then-write
-- in the route: two deliveries of the same check run can arrive concurrently,
-- and a check-then-insert would dispatch two runs against one branch.
CREATE UNIQUE INDEX "CodeAutoFixDelivery_watchId_digest_key"
  ON "CodeAutoFixDelivery"("watchId", "digest");
CREATE INDEX "CodeAutoFixDelivery_watchId_createdAt_idx"
  ON "CodeAutoFixDelivery"("watchId", "createdAt");

ALTER TABLE "CodeAutoFixDelivery"
  ADD CONSTRAINT "CodeAutoFixDelivery_watchId_fkey" FOREIGN KEY ("watchId")
  REFERENCES "CodeAutoFixWatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
