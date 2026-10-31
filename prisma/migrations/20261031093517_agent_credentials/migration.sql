-- The agents' credential vault (docs/design/agents-v2/VAULT.md): a site login
-- saved for one agent and filled into its computer's browser by
-- `computer_fill_login`, never shown to the model.
--
-- Expand-only (docs/JUNO.md §20.2b): one new table the running release never
-- reads. Nothing existing changes, so the deployment before this one keeps
-- working while PM2 reloads, and a rollback leaves the table unread.
--
--   AgentCredential  one row per saved login, owned by (userId, agentId).
--                    `origin` is scheme://host[:port], normalized. The
--                    username, password and TOTP secret are each
--                    encryptSecretBound() to the owner, the agent and the row.
--
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma runs the migration inside a
-- transaction. No `juno_record_account_change` trigger: the apps never sync it.

-- CreateTable
CREATE TABLE "AgentCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "usernameSealed" TEXT NOT NULL,
    "passwordSealed" TEXT NOT NULL,
    "totpSealed" TEXT,
    "approvedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentCredential_userId_agentId_idx" ON "AgentCredential"("userId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCredential_agentId_label_key" ON "AgentCredential"("agentId", "label");

-- AddForeignKey
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to PostgREST like every other user-owned table
-- (20260921220000_lock_public_schema_from_postgrest). ENABLE, not FORCE: the
-- application connects as the table's owner and must be unaffected.
ALTER TABLE "AgentCredential" ENABLE ROW LEVEL SECURITY;
