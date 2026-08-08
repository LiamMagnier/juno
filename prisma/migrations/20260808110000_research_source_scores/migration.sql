-- Persist the source-policy dimensions used by the evidence ranking. Keeping
-- these alongside the snapshot makes an old report auditable even after the
-- freshness clock moves or the scoring heuristics evolve.

ALTER TABLE "ResearchSource"
  ADD COLUMN IF NOT EXISTS "freshness" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "directness" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "independence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "composite" DOUBLE PRECISION;
