-- Durable prompt-cache split on Message.
--
-- The read/write cache buckets previously existed only on the live `done` SSE
-- frame and in the ApiSpend billing ledger. Reloading a thread dropped them, so
-- the native cost badge could show a cache ratio for the turn you just sent and
-- nothing for the turn above it.
--
-- BOTH COLUMNS ARE NULLABLE WITH NO DEFAULT, DELIBERATELY. NULL is the honest
-- value for every row that already exists: we never recorded the split for
-- them. `NOT NULL DEFAULT 0` would have rewritten the entire message history to
-- claim "0 cache-read tokens" — i.e. a total cache miss — for turns that may
-- well have been near-total cache hits. That is inventing a measurement, and it
-- is indistinguishable downstream from a real one. Readers must render absent
-- as "unknown", never as zero.
--
-- Additive only: no backfill, no rewrite of existing rows, so this is a
-- metadata-only ALTER and safe to apply online.
ALTER TABLE "Message"
  ADD COLUMN "cacheReadTokens" INTEGER,
  ADD COLUMN "cacheWriteTokens" INTEGER;
