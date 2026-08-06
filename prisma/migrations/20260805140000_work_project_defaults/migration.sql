-- The defaults a Work session inherits from its project.
--
-- Two additive columns with defaults, so every existing project acquires an
-- empty object and behaves exactly as it did: an empty defaults payload means
-- "inherit from the account", which is what a project that predates Juno Work
-- should do.
--
-- One JSON column rather than eight scalar ones because target, model, budget,
-- permission policy and connector scope move together and are read as a unit.
-- The version column beside it is what lets an older build read the fields it
-- understands rather than failing on a shape it has never seen — the same
-- pattern the Work tables use for capability manifests and run configuration.
--
-- Defaults are not grants. A project can only narrow what the account and the
-- host already allow, and the resolver in src/lib/work/projects.ts intersects
-- rather than unions, so nothing storable here can widen anything.
ALTER TABLE "Project"
  ADD COLUMN IF NOT EXISTS "workDefaults" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "workDefaultsVersion" INTEGER NOT NULL DEFAULT 1;
