-- Grounded Google searches per ledger row (docs/chat-rework/SPEC.md §3.9).
--
-- Expand-only (docs/JUNO.md §20.2b): one nullable column that every existing
-- row starts NULL on, which is exactly what it means for a row that did no
-- grounding. Nothing is backfilled, so the release before this one keeps
-- working against the migrated database while PM2 reloads.
--
-- The chat route sums it for the calendar month to know how much of Gemini's
-- free grounding quota is left; only the queries beyond it are billed.
--
-- IF NOT EXISTS, as the other column migrations do, so a database where it was
-- added out of band does not fail `migrate deploy` with P3009.

-- AlterTable
ALTER TABLE "ApiSpend" ADD COLUMN IF NOT EXISTS "groundingQueries" INTEGER;
