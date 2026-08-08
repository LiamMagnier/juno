ALTER TABLE "WorkRun"
  ADD COLUMN IF NOT EXISTS "spendReservationRef" TEXT;

CREATE INDEX IF NOT EXISTS "WorkRun_userId_spendReservationRef_idx"
  ON "WorkRun"("userId", "spendReservationRef");
