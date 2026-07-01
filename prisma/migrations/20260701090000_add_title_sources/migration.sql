ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "titleSource" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "nameSource" TEXT NOT NULL DEFAULT 'default';

WITH first_user AS (
  SELECT DISTINCT ON ("conversationId")
    "conversationId",
    regexp_replace(btrim("content"), '\s+', ' ', 'g') AS compact_content
  FROM "Message"
  WHERE "role" = 'USER'
  ORDER BY "conversationId", "createdAt" ASC
),
placeholder_titles AS (
  SELECT
    c."id",
    CASE
      WHEN fu.compact_content IS NULL THEN NULL
      WHEN char_length(fu.compact_content) > 48 THEN rtrim(left(fu.compact_content, 47)) || chr(8230)
      ELSE fu.compact_content
    END AS prompt_title
  FROM "Conversation" c
  LEFT JOIN first_user fu ON fu."conversationId" = c."id"
)
UPDATE "Conversation" c
SET "titleSource" = CASE
  WHEN nullif(btrim(c."title"), '') IS NULL THEN 'default'
  WHEN lower(btrim(c."title")) IN ('new chat', 'untitled', 'untitled chat') THEN 'default'
  WHEN p.prompt_title IS NOT NULL AND c."title" = p.prompt_title THEN 'default'
  ELSE 'manual'
END
FROM placeholder_titles p
WHERE p."id" = c."id";

UPDATE "Project"
SET "nameSource" = CASE
  WHEN nullif(btrim("name"), '') IS NULL THEN 'default'
  WHEN lower(btrim("name")) IN ('new project', 'untitled', 'untitled project') THEN 'default'
  ELSE 'manual'
END;
