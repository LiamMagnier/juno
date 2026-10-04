-- AgentComputer.takeoverEpoch: counts takeovers ever started, so a computer or
-- browser tool call overlapped by a takeover (even one that began and ended
-- inside the call) is discarded rather than returned to the model.
-- Additive with a default: existing rows start at 0.
ALTER TABLE "AgentComputer" ADD COLUMN "takeoverEpoch" INTEGER NOT NULL DEFAULT 0;
