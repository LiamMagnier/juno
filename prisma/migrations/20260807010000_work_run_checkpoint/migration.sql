-- Persist the provider-neutral Work checkpoint so a paused cloud run can be
-- resumed by another executor without replaying its completed tool calls.
ALTER TABLE "WorkRun"
    ADD COLUMN "checkpoint" JSONB;
