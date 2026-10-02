-- Skill bundles (docs/rework/TOOL_RUNTIME_DESIGN.md §6.8): a version may carry
-- its folder as a content-addressed tar. Additive and nullable; existing rows
-- are instructions-only skills and stay exactly as they are.
ALTER TABLE "WorkSkillVersion" ADD COLUMN "bundleKey" TEXT;
ALTER TABLE "WorkSkillVersion" ADD COLUMN "bundleDigest" TEXT;
ALTER TABLE "WorkSkillVersion" ADD COLUMN "bundleManifest" JSONB;
