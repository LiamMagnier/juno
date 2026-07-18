-- Persist the exact generation cost so reloads don't recompute from
-- promptTokens/completionTokens alone (which omit cache writes + tool fees).
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "costMicroUsd" INTEGER;
