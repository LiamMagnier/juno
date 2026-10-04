-- The October 2026 lineup: Lite (€9) under Pro, Plus (€50) between Pro and
-- Max ×5, and Ultra (€500) above Max ×10.
--
-- Additive only. Postgres appends each label to the end of the enum, so no
-- stored value changes meaning; tier ORDER lives in planRank() (plans.ts), never
-- in the enum's ordinal. IF NOT EXISTS keeps it idempotent where `prisma db
-- push` already introduced the labels.
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'LITE';
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'PLUS';
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'ULTRA';
