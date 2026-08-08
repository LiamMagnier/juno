-- Fence a retry that reclaimed an expired import from a stale request. The
-- first import-recovery migration created these tables, so backfill before
-- making the token mandatory for every future object/run mutation.
ALTER TABLE "ImportRun"
  ADD COLUMN "leaseToken" TEXT;
ALTER TABLE "ImportObject"
  ADD COLUMN "leaseToken" TEXT;

UPDATE "ImportRun"
SET "leaseToken" = md5(random()::text || clock_timestamp()::text || "id")
WHERE "leaseToken" IS NULL;

UPDATE "ImportObject" AS object
SET "leaseToken" = run."leaseToken"
FROM "ImportRun" AS run
WHERE object."importRunId" = run."id"
  AND object."leaseToken" IS NULL;

ALTER TABLE "ImportRun"
  ALTER COLUMN "leaseToken" SET NOT NULL;
ALTER TABLE "ImportObject"
  ALTER COLUMN "leaseToken" SET NOT NULL;

CREATE INDEX "ImportObject_userId_leaseToken_status_idx"
  ON "ImportObject"("userId", "leaseToken", "status");
