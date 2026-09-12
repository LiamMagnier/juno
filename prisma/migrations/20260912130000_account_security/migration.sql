-- Account security: two-step verification, and email verification that is
-- already true for everyone who has an account today.

-- Two-step verification. "totpSecret" holds a keyring-encrypted payload
-- (src/lib/message-crypto.ts), never the raw base32 secret.
ALTER TABLE "User"
  ADD COLUMN "totpSecret" TEXT,
  ADD COLUMN "totpEnabledAt" TIMESTAMP(3);

-- Single-use recovery codes, stored as SHA-256 digests only.
CREATE TABLE "MfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MfaRecoveryCode_codeHash_key" ON "MfaRecoveryCode"("codeHash");
CREATE INDEX "MfaRecoveryCode_userId_idx" ON "MfaRecoveryCode"("userId");

ALTER TABLE "MfaRecoveryCode"
  ADD CONSTRAINT "MfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill emailVerified for every existing account.
--
-- This is the whole reason this migration is hand-written. From the next
-- deploy an unverified address cannot spend (src/lib/usage.ts), and every
-- password account created before today has emailVerified = NULL simply
-- because nothing ever set it. Shipping the gate without this line would
-- lock every existing paying user out of the product they already bought,
-- for a verification email they were never sent.
--
-- Dated from the account's own createdAt rather than now(), so the column
-- keeps meaning "when this address was accepted" instead of "when this
-- migration ran", and so nothing downstream reads a cohort of identical
-- timestamps as a verification spike.
UPDATE "User" SET "emailVerified" = "createdAt" WHERE "emailVerified" IS NULL;
