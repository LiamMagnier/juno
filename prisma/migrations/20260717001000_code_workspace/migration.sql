-- Juno Code sessions carry their app-side workspace (project folder) so the
-- website can group them like the app does. Nullable — chat conversations and
-- older clients simply leave them empty.
ALTER TABLE "Conversation" ADD COLUMN "codeWorkspaceName" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "codeWorkspacePath" TEXT;
