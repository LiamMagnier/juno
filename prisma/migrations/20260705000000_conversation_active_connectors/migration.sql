-- AlterTable
-- IF NOT EXISTS keeps this safe on databases where the column was already added
-- out-of-band via `prisma db push` (avoids the P3009 "column already exists"
-- failure that blocks `migrate deploy`).
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "activeConnectors" TEXT[] DEFAULT ARRAY[]::TEXT[];
