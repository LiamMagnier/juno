-- Cloud Juno Code: single-use runner handoff guard. ADDITIVE — a new nullable
-- column, no data change for existing rows (device tasks and every already-
-- dispatched cloud task keep NULL, i.e. "handoff not yet consumed").
--
-- runnerClaimedAt is stamped the first time a cloud task's GitHub Actions runner
-- exchanges its one-time dispatch code for runner-context. The runner-context
-- route claims it with `updateMany(where: runnerClaimedAt IS NULL)`, so the
-- clone token + fresh task token are minted AT MOST once per task.
ALTER TABLE "CodeTask" ADD COLUMN IF NOT EXISTS "runnerClaimedAt" TIMESTAMP(3);
