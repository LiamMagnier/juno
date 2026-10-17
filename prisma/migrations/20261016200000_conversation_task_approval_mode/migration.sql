-- How often a task started from a chat stops to ask (G15). Nullable with no
-- default: every existing conversation keeps following the default mode, and
-- adding the column is a metadata-only change on a live table.
ALTER TABLE "Conversation" ADD COLUMN "taskApprovalMode" TEXT;
