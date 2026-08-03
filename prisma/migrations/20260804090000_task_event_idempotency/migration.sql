-- Idempotency for cloud-runner task events.
--
-- The runner retries a batch whose POST succeeded server-side but whose
-- response was lost. Without a producer-supplied key those events were appended
-- a second time and the transcript showed everything twice.
--
-- Nullable on purpose: events written before the outbox existed, and any host
-- that does not send a key, carry none. In Postgres a NULL never collides under
-- a unique index, so those rows are unaffected and no backfill is needed.
--
-- Additive and reversible: DROP COLUMN restores the previous shape.
ALTER TABLE "CodeTaskEvent"
  ADD COLUMN "eventKey" TEXT;

CREATE UNIQUE INDEX "CodeTaskEvent_taskId_eventKey_key"
  ON "CodeTaskEvent" ("taskId", "eventKey");
