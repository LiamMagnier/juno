-- Older builds persisted provider-internal chain of thought. Remove it during
-- migration; new builds persist only explicit provider reasoning summaries.
UPDATE "Message" SET "reasoning" = NULL, "reasoningParts" = NULL
WHERE "reasoning" IS NOT NULL OR "reasoningParts" IS NOT NULL;
UPDATE "MessageVersion" SET "reasoning" = NULL WHERE "reasoning" IS NOT NULL;
