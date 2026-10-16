-- Message branches (src/lib/chat/branches.ts): editing a question or
-- regenerating an answer adds a sibling row instead of deleting or
-- overwriting, so a conversation becomes a tree with one shown path.
--
-- Additive and safe on a live table:
--  - Every new column is nullable or has a constant default. Since PostgreSQL
--    11 a constant default is recorded in the catalog, so none of these
--    statements rewrites "Message" or scans it.
--  - Every existing row reads as what it already is: a linear, shown,
--    never-branched message (parentId NULL means "follows the previous shown
--    message"; the application writes the pointer down the first time a branch
--    operation runs in that conversation).
--  - No data is moved. Older MessageVersion rows (the earlier wordings and
--    answers kept by the in-place edit and regenerate) stay where they are and
--    keep rendering through the version pager; a branch operation on such a
--    message adopts them as siblings inside its own transaction, so code that
--    predates this migration never meets a row it would draw twice.
--  - No index: sibling lookups are always scoped to one conversation, which
--    the existing ("conversationId", "createdAt") index already narrows, and a
--    plain CREATE INDEX would hold the write lock on this table for the whole
--    build (see 20260731190000_api_spend_created_at_index for why this repo
--    does not use CONCURRENTLY inside Prisma's transaction).

ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "parentId" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "branchGroupId" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "branchSelected" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "onActivePath" BOOLEAN NOT NULL DEFAULT true;

-- A shared chat pins the branch it showed (Share.leafMessageId), so a later
-- edit or branch switch never changes a public link.
ALTER TABLE "Share" ADD COLUMN IF NOT EXISTS "leafMessageId" TEXT;
