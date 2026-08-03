-- Background-processing provider policy.
--
-- Background work (memory extraction, titles, research planning, moderation,
-- consolidation) used to walk every configured provider's free models and take
-- whichever answered first, so a conversation held with one provider could have
-- its decrypted messages read by another. These two columns make the rule
-- explicit and per-account.
--
-- Additive and reversible: both columns are nullable-or-defaulted, so an older
-- deployment reading this schema is unaffected, and `DROP COLUMN` is a clean
-- rollback.
--
-- Every existing row takes "same_provider" — the privacy-preserving default —
-- via the column default, which Postgres backfills for existing rows.
ALTER TABLE "Settings"
  ADD COLUMN "backgroundProviderMode" TEXT NOT NULL DEFAULT 'same_provider',
  ADD COLUMN "backgroundProviderSelected" TEXT;
