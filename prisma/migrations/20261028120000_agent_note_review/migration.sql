-- Agent notes learned during a task (src/lib/agents/run-notes.ts): a note an
-- agent saves from one of its Work runs waits for the person when its
-- "What it may remember" setting asks for review.
--
-- Expand-only (docs/JUNO.md §20.2b): one defaulted column on an existing
-- table. Every existing note reads as 'kept', exactly as it is used today, so
-- the release before this one keeps working while PM2 reloads, and a rollback
-- leaves the column unread.
--
--   AgentNote  status (kept | pending), default 'kept'.
--
-- IF NOT EXISTS so a database where the column was added out of band does not
-- fail `migrate deploy` with P3009.

-- AlterTable
ALTER TABLE "AgentNote" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'kept';
