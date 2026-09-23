-- Skills installed from one repository live in one source.
--
-- Importing anthropics/skills used to create seventeen unrelated WorkSkill
-- rows. Where they came from was written down (each version's
-- contract.provenance) and read by nothing, so the library could not group
-- them, switch them off together, check them for updates or remove them as a
-- unit. "WorkSkillSource" is that unit, and "WorkSkill"."sourceId" points at
-- it. See src/lib/skills/library-contract.ts for the shape the client reads.
--
-- "WorkSkill"."kind" separates the two things this table has been holding.
-- src/lib/assistants.ts stores assistants here as well, and with nothing to
-- tell them apart the Assistants page listed every imported skill and chat
-- offered every assistant as a slash skill.
--
-- Expand-only (docs/JUNO.md §20.2b): a new table, two nullable columns and a
-- defaulted one. The running release selects none of them, and a rollback
-- leaves them unread.
--
-- The backfill below writes "WorkSkill" rows. That table's change-capture
-- trigger is still held back in prisma/migrations-pending, so these UPDATEs do
-- not reach "AccountChange"; if that trigger is ever armed first, re-read the
-- note in 20260922210000_memory_observed_at_and_reader_version before shipping
-- an UPDATE like this one. Every statement is idempotent.

CREATE TABLE IF NOT EXISTS "WorkSkillSource" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'github',
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '',
    "commit" TEXT NOT NULL,
    "latestCommit" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkSkillSource_pkey" PRIMARY KEY ("id")
);

-- One source per repository and scope, per person. It leads with "userId", so
-- it is also the index every per-account listing reads.
CREATE UNIQUE INDEX IF NOT EXISTS "WorkSkillSource_userId_key_path_key"
  ON "WorkSkillSource"("userId", "key", "path");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkSkillSource_userId_fkey') THEN
    ALTER TABLE "WorkSkillSource" ADD CONSTRAINT "WorkSkillSource_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "WorkSkill"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'skill',
  ADD COLUMN IF NOT EXISTS "sourceId" TEXT,
  ADD COLUMN IF NOT EXISTS "sourcePath" TEXT;

CREATE INDEX IF NOT EXISTS "WorkSkill_userId_sourceId_idx"
  ON "WorkSkill"("userId", "sourceId");

-- SET NULL, not CASCADE: removing a source soft-deletes its skills first, and
-- a run that followed one of them still has to resolve the row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkSkill_sourceId_fkey') THEN
    ALTER TABLE "WorkSkill" ADD CONSTRAINT "WorkSkill_sourceId_fkey"
      FOREIGN KEY ("sourceId") REFERENCES "WorkSkillSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Closed to PostgREST like every other table
-- (20260921220000_lock_public_schema_from_postgrest). ENABLE, not FORCE: the
-- application connects as the table's owner and must be unaffected.
ALTER TABLE "WorkSkillSource" ENABLE ROW LEVEL SECURITY;

-- Backfill 1: assistants.
--
-- createAssistant writes contract keys no skill writer can produce:
-- skillContractToJson rebuilds a skill contract field by field, and "icon" and
-- "starterPrompts" are not among its fields. Any version carrying both marks
-- the row, not only the current one, because editing an assistant from the
-- skill page minted a version through the skill schema, which strips them.
UPDATE "WorkSkill" s
SET "kind" = 'assistant'
WHERE s."kind" = 'skill'
  AND EXISTS (
    SELECT 1 FROM "WorkSkillVersion" v
    WHERE v."skillId" = s."id"
      AND (v."contract" -> 'icon') IS NOT NULL
      AND (v."contract" -> 'starterPrompts') IS NOT NULL
  );

-- Backfill 2: one source per repository a live skill was imported from.
--
-- The key is githubSourceKey's, spelled in SQL: trimmed, lower-cased, ".git"
-- dropped, so "Anthropics/Skills" and "anthropics/skills" are one source. The
-- display spelling, ref and commit come from the most recently read version.
-- The scope is "" (the whole repository) because provenance recorded each
-- file's path and never the folder the import was scoped to. The id is
-- deterministic so the statement can run twice.
WITH imported AS (
  SELECT
    s."userId",
    s."createdAt" AS "skillCreatedAt",
    v."createdAt" AS "readAt",
    btrim(v."contract" -> 'provenance' ->> 'source.owner') AS "owner",
    btrim(v."contract" -> 'provenance' ->> 'source.repo') AS "repo",
    v."contract" -> 'provenance' ->> 'source.ref' AS "ref",
    v."contract" -> 'provenance' ->> 'source.commit' AS "commit",
    'github:' || lower(btrim(v."contract" -> 'provenance' ->> 'source.owner'))
      || '/' || regexp_replace(lower(btrim(v."contract" -> 'provenance' ->> 'source.repo')), '\.git$', '') AS "key"
  FROM "WorkSkill" s
  JOIN "WorkSkillVersion" v ON v."skillId" = s."id" AND v."version" = s."currentVersion"
  WHERE s."deletedAt" IS NULL
    AND s."kind" = 'skill'
    AND v."contract" -> 'provenance' ->> 'source.kind' = 'github'
    AND coalesce(btrim(v."contract" -> 'provenance' ->> 'source.owner'), '') <> ''
    AND coalesce(btrim(v."contract" -> 'provenance' ->> 'source.repo'), '') <> ''
    AND coalesce(v."contract" -> 'provenance' ->> 'source.ref', '') <> ''
    AND coalesce(v."contract" -> 'provenance' ->> 'source.commit', '') <> ''
),
ranked AS (
  SELECT
    imported.*,
    min("skillCreatedAt") OVER (PARTITION BY "userId", "key") AS "firstInstalledAt",
    row_number() OVER (PARTITION BY "userId", "key" ORDER BY "readAt" DESC, "commit" DESC) AS "rank"
  FROM imported
)
INSERT INTO "WorkSkillSource" (
  "id", "userId", "kind", "owner", "repo", "key", "ref", "path", "commit",
  "enabled", "createdAt", "updatedAt"
)
SELECT
  'wss_' || md5("userId" || ':' || "key" || ':'),
  "userId", 'github', "owner", "repo", "key", "ref", '', "commit",
  true, "firstInstalledAt", CURRENT_TIMESTAMP
FROM ranked
WHERE "rank" = 1
ON CONFLICT DO NOTHING;

-- Backfill 3: point each of those skills at its source, with the file path an
-- update check will match it by. "updatedAt" is left alone on purpose: it is
-- what the library sorted by, and nobody edited these skills.
UPDATE "WorkSkill" s
SET
  "sourceId" = src."id",
  "sourcePath" = nullif(v."contract" -> 'provenance' ->> 'source.path', '')
FROM "WorkSkillVersion" v, "WorkSkillSource" src
WHERE v."skillId" = s."id"
  AND v."version" = s."currentVersion"
  AND s."deletedAt" IS NULL
  AND s."kind" = 'skill'
  AND s."sourceId" IS NULL
  AND v."contract" -> 'provenance' ->> 'source.kind' = 'github'
  AND src."userId" = s."userId"
  AND src."path" = ''
  AND src."key" = 'github:' || lower(btrim(v."contract" -> 'provenance' ->> 'source.owner'))
    || '/' || regexp_replace(lower(btrim(v."contract" -> 'provenance' ->> 'source.repo')), '\.git$', '');
