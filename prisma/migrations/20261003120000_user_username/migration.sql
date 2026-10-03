-- User.username: the @handle an account chooses (src/lib/username.ts).
-- Additive and nullable: no backfill; until a user picks one, the profile shows
-- a handle derived from the email.
ALTER TABLE "User" ADD COLUMN "username" TEXT;

-- Usernames are stored lowercased, so the plain unique index below is
-- case-insensitive uniqueness ("Liam" and "liam" cannot both exist). The CHECK
-- holds that invariant for every writer, not only the API that normalises.
ALTER TABLE "User" ADD CONSTRAINT "User_username_lowercase_check" CHECK ("username" = lower("username"));

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
