-- Semantic deliverables as first-class artifact types (BRIEF §29).
--
-- A workbook, document or deck is stored like every other artifact: one
-- Artifact row, one ArtifactVersion per revision, the model JSON as the body.
-- Additive only: Postgres appends the labels, no existing ordinal moves.
-- Installed native builds decode the type leniently (an unknown kind is
-- skipped, NativeArtifactStore), so they simply do not list these rows.
ALTER TYPE "ArtifactType" ADD VALUE IF NOT EXISTS 'SPREADSHEET';
ALTER TYPE "ArtifactType" ADD VALUE IF NOT EXISTS 'DOCUMENT';
ALTER TYPE "ArtifactType" ADD VALUE IF NOT EXISTS 'PRESENTATION';
