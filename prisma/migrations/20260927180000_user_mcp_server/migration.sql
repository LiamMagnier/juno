-- UserMcpServer: remote MCP servers people register themselves (URL + optional
-- Authorization header), projected into chat and agents as `user_mcp:<id>`
-- (docs/design/PREMIUM_REWORK_PASS.md W1, prisma/migrations-pending/user-mcp-server.md).
--
-- Expand-only (docs/JUNO.md §20.2b): one new table the running release never
-- wrote before this deploy. The code that reads it (GET /api/connectors,
-- getActiveConnectors, /api/mcp/servers) shipped in the same release and failed
-- closed with P2021 until this migration landed; this is the table those calls
-- expect, nothing existing is altered.
--
-- Shapes mirror the Agent tables (TEXT ids and strings, TIMESTAMP(3), cascade
-- on user delete). `tools`/`toolCount` cache the last successful test so the
-- directory can say "12 tools" without opening a connection on every list.

-- CreateTable
CREATE TABLE "UserMcpServer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "authHeader" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "toolCount" INTEGER NOT NULL DEFAULT 0,
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accountLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMcpServer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserMcpServer_userId_name_key" ON "UserMcpServer"("userId", "name");

-- CreateIndex
CREATE INDEX "UserMcpServer_userId_enabled_idx" ON "UserMcpServer"("userId", "enabled");

-- AddForeignKey
ALTER TABLE "UserMcpServer" ADD CONSTRAINT "UserMcpServer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
