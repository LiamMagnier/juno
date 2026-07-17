-- Cloud Juno Code: a CodeTask may run on a GitHub Actions runner ("cloud")
-- instead of a registered device. Everything here is ADDITIVE — existing
-- device tasks and every macOS/Windows client keep working unchanged.

-- Cloud tasks have no device, so deviceId becomes nullable. Existing rows keep
-- their deviceId; the foreign key (ON DELETE CASCADE) is unchanged and simply
-- ignores NULLs, so device deletion still cascades to that device's tasks.
ALTER TABLE "CodeTask" ALTER COLUMN "deviceId" DROP NOT NULL;

-- Execution target: "device" (default, unchanged behavior) | "cloud".
ALTER TABLE "CodeTask" ADD COLUMN IF NOT EXISTS "target" TEXT NOT NULL DEFAULT 'device';

-- The GitHub repo a cloud run clones + branches from (NULL for device tasks).
ALTER TABLE "CodeTask" ADD COLUMN IF NOT EXISTS "repoOwner" TEXT;
ALTER TABLE "CodeTask" ADD COLUMN IF NOT EXISTS "repoName" TEXT;
ALTER TABLE "CodeTask" ADD COLUMN IF NOT EXISTS "baseRef" TEXT;

-- The pull request URL the finished cloud run opened.
ALTER TABLE "CodeTask" ADD COLUMN IF NOT EXISTS "prUrl" TEXT;
