-- Where an agent's work runs: the cloud executor (the default every existing
-- agent keeps) or the person's own Mac through the Work relay, optionally a
-- named one. Expand-only (docs/JUNO.md §20.2b): one defaulted column and one
-- nullable column, both metadata-only on a live table.
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "executionTarget" TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "preferredHostId" TEXT;
