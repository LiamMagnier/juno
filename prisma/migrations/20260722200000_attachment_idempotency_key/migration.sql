-- Native attachment uploads are retried by the client on a flaky network, so an
-- upload needs an identity of its own or every retry leaves a duplicate row.
--
-- The column is nullable and the index is scoped to (userId, idempotencyKey):
--   * nullable, because the web upload route does not send a key, and Postgres
--     treats NULLs as distinct — so every existing row and every future web
--     upload coexists under the unique index without collision;
--   * scoped to userId, so one account's key can never match another's row.
ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Attachment_userId_idempotencyKey_key"
  ON "Attachment" ("userId", "idempotencyKey");
