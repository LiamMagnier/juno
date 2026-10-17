-- "Not relevant" on a memory an answer used (G20). Nullable with no default,
-- so adding it is a metadata-only change on a live table and every existing
-- fact keeps ranking exactly as it did.
ALTER TABLE "MemoryEntry" ADD COLUMN "notRelevantAt" TIMESTAMP(3);
