-- Per-task connector grants.
--
-- One new table and one additive boolean, so a deploy that runs this and is
-- then rolled back leaves a database every previous build still reads: the
-- column defaults to false, which is what every session created before today
-- means — nobody was asked which apps this task may reach, so nothing narrows.
--
-- Why a table rather than a TEXT[] on WorkSession: every other permission in
-- this schema is a row. WorkFileGrant is a row per folder because a grant has
-- to be countable, indexable and individually revocable, and because an array
-- column cannot say when the grant was made. A per-task connector grant is the
-- same kind of fact and is answered by the same kind of question months later —
-- "was this task ever allowed to touch Gmail" — so it gets the same shape.
--
-- Why the boolean as well as the table: an empty table cannot tell "the reader
-- turned every app off" apart from "nothing ever asked", and those two must not
-- resolve the same way. The first is a task that reaches no connector; the
-- second is every session that predates this migration, every scheduled run and
-- every native client, none of which should change behaviour. The column is
-- what carries the difference, and src/lib/work/connectors.ts reads it as the
-- null-versus-empty distinction its allowlists already use.
--
-- `connectorId` holds the provider id ("github", "apple-mail") rather than a
-- Connection row id: disconnecting and reconnecting an app mints a new
-- Connection, and keying on that would drop the task's permission every time
-- somebody re-authorised.
--
-- IF NOT EXISTS / duplicate_object guards throughout, per the convention in
-- 20260805120000_work_domain: a database that picked any of this up out of band
-- must not fail the migration and P3009-poison every later deploy.

-- AlterTable
ALTER TABLE "WorkSession"
  ADD COLUMN IF NOT EXISTS "connectorsChosen" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkSessionConnector" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkSessionConnector_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkSessionConnector_sessionId_connectorId_key" ON "WorkSessionConnector"("sessionId", "connectorId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkSessionConnector_userId_createdAt_idx" ON "WorkSessionConnector"("userId", "createdAt");

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSessionConnector" ADD CONSTRAINT "WorkSessionConnector_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "WorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$
BEGIN
    ALTER TABLE "WorkSessionConnector" ADD CONSTRAINT "WorkSessionConnector_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
