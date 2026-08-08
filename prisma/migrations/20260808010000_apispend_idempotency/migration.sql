-- An idempotency key for spend rows that can legitimately be reported twice.
--
-- The voice relay reports a cost delta every few seconds and re-sends any post
-- it could not confirm, so without this a lost acknowledgement bills the same
-- seconds again. Nullable, because every other writer of this table speaks once
-- and must keep being allowed to: Postgres treats NULLs as distinct in a unique
-- index, so unkeyed rows never collide with each other.
--
-- Additive and replay-safe. Rollback: drop the index, then the column.

-- AlterTable
ALTER TABLE "ApiSpend" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ApiSpend_userId_idempotencyKey_key" ON "ApiSpend"("userId", "idempotencyKey");
