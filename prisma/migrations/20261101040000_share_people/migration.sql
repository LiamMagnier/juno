-- Share a chat or an artifact with specific people by email
-- (src/lib/share-people-core.ts).
--
--   "Share"."audience"  LINK (every existing row, and every link made since)
--                       or PEOPLE. A PEOPLE share is never served by its token
--                       alone: the public lookup skips it, and the share page
--                       opens it only for its owner and for a signed-in
--                       account whose verified email is on its recipients.
--
--   ShareRecipient      one row per address a PEOPLE share was sent to, owned
--                       by the share's OWNER (`userId`). `emailHash` is an
--                       HMAC of the normalized address (domainMac) and the
--                       lookup key; `email` is the address, encryptField()ed.
--                       No column points at a recipient's account.
--
-- Expand-only (docs/JUNO.md §20.2b): a defaulted column the running release
-- never reads and one new table it never reads, so the deployment before this
-- one keeps working while PM2 reloads. ROLLING BACK PAST THIS RELEASE IS NOT
-- SAFE WHILE PEOPLE SHARES ARE LIVE: the previous release does not know the
-- column and would serve a PEOPLE share to anyone holding its token. Revoke
-- them first:
--
--   UPDATE "Share" SET "revokedAt" = now()
--   WHERE "audience" = 'PEOPLE' AND "revokedAt" IS NULL;
--
-- Plain CREATE INDEX, not CONCURRENTLY: Prisma runs the migration inside a
-- transaction. No `juno_record_account_change` trigger on ShareRecipient: the
-- apps never sync it (the Share row keeps the trigger it already has).

-- CreateEnum
CREATE TYPE "ShareAudience" AS ENUM ('LINK', 'PEOPLE');

-- AlterTable
ALTER TABLE "Share" ADD COLUMN "audience" "ShareAudience" NOT NULL DEFAULT 'LINK';

-- CreateTable
CREATE TABLE "ShareRecipient" (
    "id" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invitedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShareRecipient_shareId_emailHash_key" ON "ShareRecipient"("shareId", "emailHash");

-- CreateIndex
CREATE INDEX "ShareRecipient_userId_createdAt_idx" ON "ShareRecipient"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ShareRecipient" ADD CONSTRAINT "ShareRecipient_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "Share"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareRecipient" ADD CONSTRAINT "ShareRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed to PostgREST like every other user-owned table
-- (20260921220000_lock_public_schema_from_postgrest). ENABLE, not FORCE: the
-- application connects as the table's owner and must be unaffected.
ALTER TABLE "ShareRecipient" ENABLE ROW LEVEL SECURITY;
