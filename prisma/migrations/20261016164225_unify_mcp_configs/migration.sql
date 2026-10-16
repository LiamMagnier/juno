-- Additive migration: preserve old CustomConnector rows as a rollback snapshot.
-- All runtime writes switch to UserMcpServer. IDs and Connection token rows are unchanged.
ALTER TABLE "UserMcpServer"
 ADD COLUMN "authMode" TEXT NOT NULL DEFAULT 'header',
 ADD COLUMN "description" TEXT,
 ADD COLUMN "serverName" TEXT,
 ADD COLUMN "disabledTools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 ADD COLUMN "toolCatalog" JSONB,
 ADD COLUMN "toolsCheckedAt" TIMESTAMP(3);
DO $$
DECLARE c RECORD; label TEXT; attempt INTEGER;
BEGIN
 FOR c IN SELECT * FROM "CustomConnector" ORDER BY "createdAt", "id" LOOP
  IF NOT EXISTS (SELECT 1 FROM "UserMcpServer" WHERE "id"=c."id") THEN
   label := c."name"; attempt := 0;
   WHILE EXISTS (SELECT 1 FROM "UserMcpServer" WHERE "userId"=c."userId" AND "name"=label) LOOP
    attempt := attempt + 1;
    label := c."name" || ' (' || c."id" || ':' || attempt || ')';
   END LOOP;
   INSERT INTO "UserMcpServer" ("id","userId","name","url","authMode","enabled","status","toolCount","tools","description","serverName","disabledTools","toolCatalog","toolsCheckedAt","createdAt","updatedAt")
   VALUES (c."id",c."userId",label,c."url",'oauth',true,'untested',0,ARRAY[]::TEXT[],c."description",c."serverName",c."disabledTools",c."tools",c."toolsCheckedAt",c."createdAt",c."updatedAt");
  END IF;
 END LOOP;
END $$;
CREATE UNIQUE INDEX "UserMcpServer_oauth_userId_url_key" ON "UserMcpServer"("userId","url") WHERE "authMode"='oauth';
