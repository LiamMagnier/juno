-- One synchronized agent profile for Web, iOS and macOS Code sessions.
-- Additive defaults preserve every existing task and older native client.
ALTER TABLE "CodeTask"
  ADD COLUMN IF NOT EXISTS "agentRuntime" TEXT NOT NULL DEFAULT 'codex',
  ADD COLUMN IF NOT EXISTS "permissionMode" TEXT NOT NULL DEFAULT 'ask',
  ADD COLUMN IF NOT EXISTS "modelId" TEXT,
  ADD COLUMN IF NOT EXISTS "reasoningEffort" TEXT,
  ADD COLUMN IF NOT EXISTS "computerUse" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "subagentsEnabled" BOOLEAN NOT NULL DEFAULT true;
