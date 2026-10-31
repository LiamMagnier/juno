-- "Memory off for this chat" (src/lib/chat/memory-off.ts). A constant default,
-- so adding the column is a metadata-only change on a live table, and every
-- existing conversation keeps following the account's memory setting. A new
-- column on an existing table: "Conversation" keeps the row-level security it
-- was given with the rest of the public schema
-- (20260921220000_lock_public_schema_from_postgrest), nothing to add here.
ALTER TABLE "Conversation" ADD COLUMN "memoryOff" BOOLEAN NOT NULL DEFAULT false;
