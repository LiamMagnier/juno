-- Conversations carry their surface: "chat" (web + app chat) or "code"
-- (Juno Code sessions synced from the app). Additive with a default, so
-- every existing row and every old client keeps working unchanged.
ALTER TABLE "Conversation" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'chat';
