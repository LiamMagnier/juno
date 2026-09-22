-- One memory summary per project, per person.
--
-- A chat filed in a project reads memory in isolation: that project's facts,
-- never the account's (getMemoryProfile in src/lib/memory.ts). The account
-- summary — the settled, distilled profile every other chat opens with — was
-- therefore never shown to a project chat, and nothing took its place, so a
-- project had no overview of itself at all: only whichever of its facts ranked
-- into the token budget on a given turn. This table is that overview, rebuilt
-- the same way the account summary is and encrypted at rest the same way
-- (src/lib/field-crypto.ts; rotated by scripts/rotate-message-keys.ts).
--
-- Keyed on ("userId", "projectId"), not "projectId" alone: memory is personal.
-- Each member of a shared project has their own facts in it and gets their own
-- summary of them; nobody reads anybody else's.
--
-- Expand-only (docs/JUNO.md §20.2b): a new table, nothing existing is read or
-- rewritten, and a build that predates it never touches it. Rows appear as
-- project chats happen; there is no backfill to run.
CREATE TABLE "ProjectMemorySummary" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectMemorySummary_pkey" PRIMARY KEY ("id")
);

-- The owner-scoped lookup every read and upsert makes.
CREATE UNIQUE INDEX "ProjectMemorySummary_userId_projectId_key" ON "ProjectMemorySummary"("userId", "projectId");

-- Deleting a project cascades through this.
CREATE INDEX "ProjectMemorySummary_projectId_idx" ON "ProjectMemorySummary"("projectId");

ALTER TABLE "ProjectMemorySummary" ADD CONSTRAINT "ProjectMemorySummary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectMemorySummary" ADD CONSTRAINT "ProjectMemorySummary_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to PostgREST like every other table
-- (20260921220000_lock_public_schema_from_postgrest). The default privileges
-- that migration revoked already keep anon and authenticated off a new table;
-- row level security is enabled as well, so this table matches every other
-- one and a grant restored by mistake later still reads nothing. ENABLE, not
-- FORCE — the application connects as the table's owner and must be
-- unaffected, exactly as that migration explains.
ALTER TABLE "ProjectMemorySummary" ENABLE ROW LEVEL SECURITY;
