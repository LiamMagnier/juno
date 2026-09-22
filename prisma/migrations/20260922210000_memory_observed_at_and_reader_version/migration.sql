-- When a remembered fact was said, and which reader distilled each chat.
--
-- "observedAt" is the source message's time, as opposed to "createdAt", when
-- the row was written. They are minutes apart for a fact learned during the
-- chat it came from and months apart for one learned by re-reading history —
-- and history is read newest chat first ("Learn from past chats", the
-- dreamer), so judging conflicts by write time handed every one of them to the
-- OLDER statement. Ingestion now judges by this column; see
-- planFactIngestion and planTimelineReconciliation in src/lib/memory-lifecycle.ts.
--
-- "extractorVersion" records which version of the reader (EXTRACTOR_VERSION
-- in src/lib/memory-extraction.ts) distilled a chat, so history read by an
-- older reader can be read again when the reader improves.
--
-- Expand-only (docs/JUNO.md §20.2b): a nullable column and a defaulted one;
-- the running release never selects either.
--
-- NO BACKFILL HERE, on purpose. "MemoryEntry" carries the native-sync
-- change-capture trigger (juno_change_memory), so an UPDATE of every row would
-- write one AccountChange per row and send every device to re-download every
-- memory at once. Readers fall back to "createdAt" instead, and the re-judge
-- pass recovers each row's time from its source message, a bounded batch at a
-- time, as it visits the account. Every existing distilled chat is version 1,
-- which is what it was read by.
ALTER TABLE "MemoryEntry" ADD COLUMN "observedAt" TIMESTAMP(3);

ALTER TABLE "ConversationMemory" ADD COLUMN "extractorVersion" INTEGER NOT NULL DEFAULT 1;
