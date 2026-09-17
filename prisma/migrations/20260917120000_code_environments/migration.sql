-- Cloud Code environments, and the permission mode a run is dispatched under.
--
-- Expand-only (see docs/JUNO.md §20.2b): one new table and two nullable
-- columns. Nothing is renamed, nothing is dropped, and every existing row
-- keeps its meaning — a CodeTask with a NULL environmentId runs in exactly the
-- shape every cloud run has had until now (no network, no variables, no setup
-- step), and a NULL permissionMode resolves to "full", which is the literal
-- string the driver passed to AgentSession.create before the column existed.

CREATE TABLE "CodeEnvironment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'none',
    -- One AES-256-GCM ciphertext over a JSON object, sealed with the connector
    -- keyring (src/lib/crypto.ts). A database dump alone yields nothing usable.
    "envVars" TEXT,
    -- The names in the clear, so a list endpoint can describe an environment
    -- without a decryption key anywhere near a browser response.
    "envVarNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "setupScript" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeEnvironment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodeEnvironment_userId_name_key" ON "CodeEnvironment"("userId", "name");
CREATE INDEX "CodeEnvironment_userId_updatedAt_idx" ON "CodeEnvironment"("userId", "updatedAt");

-- One default per user, enforced by the database rather than by the route that
-- clears the old one. Hand-written because Prisma cannot express a filtered
-- index — the same reason CodeWorkspace's (userId, key) index is hand-written
-- in migration 20260717130000. Without it, a PATCH that sets a new default and
-- fails between the two statements leaves the user with two.
CREATE UNIQUE INDEX "CodeEnvironment_userId_default_key"
  ON "CodeEnvironment"("userId") WHERE "isDefault";

ALTER TABLE "CodeEnvironment"
  ADD CONSTRAINT "CodeEnvironment_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The task's link to it. ON DELETE SET NULL, not CASCADE: retiring an
-- environment must never delete the runs that used it.
ALTER TABLE "CodeTask" ADD COLUMN "environmentId" TEXT;
ALTER TABLE "CodeTask" ADD COLUMN "permissionMode" TEXT;

CREATE INDEX "CodeTask_environmentId_idx" ON "CodeTask"("environmentId");

ALTER TABLE "CodeTask"
  ADD CONSTRAINT "CodeTask_environmentId_fkey" FOREIGN KEY ("environmentId")
  REFERENCES "CodeEnvironment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
