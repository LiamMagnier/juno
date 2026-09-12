-- The branch a cloud run pushed to, and the pull request it opened or reused.
--
-- Continuity: a follow-up in the same conversation is dispatched with
-- baseRef = the previous run's branch, checks that branch out, pushes to it
-- and reuses the open pull request instead of opening a second one. Before
-- these columns every follow-up cloned the base, branched afresh and opened a
-- new PR with no memory of the first. Nullable: device tasks, and cloud runs
-- that made no changes, have neither.
ALTER TABLE "CodeTask" ADD COLUMN "branch" TEXT;
ALTER TABLE "CodeTask" ADD COLUMN "prNumber" INTEGER;
