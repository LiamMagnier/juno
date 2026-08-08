-- Persist bounded skill security evidence and the consent gate for permission
-- expansion. The scan never stores instruction excerpts or secrets.

ALTER TABLE "WorkSkill"
  ADD COLUMN IF NOT EXISTS "securityStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "securityUpdatedAt" TIMESTAMP(3);

ALTER TABLE "WorkSkillVersion"
  ADD COLUMN IF NOT EXISTS "securityStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "securityScan" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "permissionDigest" TEXT,
  ADD COLUMN IF NOT EXISTS "requiresConsent" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "WorkSkill_securityStatus_idx"
  ON "WorkSkill"("securityStatus");

CREATE INDEX IF NOT EXISTS "WorkSkillVersion_securityStatus_idx"
  ON "WorkSkillVersion"("securityStatus");
