-- Whether a registered Juno Code host actually claims and runs queued work.
--
-- Registration announced presence only, and the phone read presence as
-- capability: it offered Remote as an execution target, the backend queued the
-- task, and nothing on the Mac ever claimed it. The task sat `queued` forever
-- with no error anywhere.
--
-- Additive and reversible. The default is false — the truthful answer for every
-- host registered before this column existed, none of which run a claim loop.
ALTER TABLE "CodeDevice"
  ADD COLUMN "servesQueuedTasks" BOOLEAN NOT NULL DEFAULT false;
