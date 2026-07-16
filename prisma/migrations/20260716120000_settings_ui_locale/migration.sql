-- Idempotent by necessity: deploy.yml:101 runs `prisma db push`, which creates this
-- column from schema.prisma WITHOUT recording a row in _prisma_migrations. A later
-- `migrate deploy` would then fail on "column already exists" and block all deploys.
-- AlterTable
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS     "uiLocale" TEXT NOT NULL DEFAULT 'auto';
