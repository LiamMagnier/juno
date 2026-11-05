-- Tone characteristics (src/lib/characteristics.ts): Warm, Enthusiastic,
-- Headers & lists, Emoji and Concise, each "less" | "default" | "more".
--
-- Expand-only (docs/JUNO.md §20.2b): five new columns with a constant default,
-- which Postgres adds without rewriting the table. Every existing row takes
-- "default", which the prompt builder reads as "inject nothing", so no account
-- changes behaviour until it moves a control; a build that predates the
-- columns never selects them. Settings already has row-level security and its
-- OWNER_COLUMN entry; neither changes, and nothing here is encrypted.
ALTER TABLE "Settings" ADD COLUMN "toneWarmth" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Settings" ADD COLUMN "toneEnthusiasm" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Settings" ADD COLUMN "toneFormatting" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Settings" ADD COLUMN "toneEmoji" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Settings" ADD COLUMN "toneConciseness" TEXT NOT NULL DEFAULT 'default';
