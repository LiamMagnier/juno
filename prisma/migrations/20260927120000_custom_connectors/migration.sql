-- Remote MCP servers users add by URL (OAuth only). Tokens stay in "Connection".
CREATE TABLE "CustomConnector" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "serverName" TEXT,
    "disabledTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tools" JSONB,
    "toolsCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomConnector_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomConnector_userId_url_key" ON "CustomConnector"("userId", "url");
CREATE INDEX "CustomConnector_userId_idx" ON "CustomConnector"("userId");

ALTER TABLE "CustomConnector" ADD CONSTRAINT "CustomConnector_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
