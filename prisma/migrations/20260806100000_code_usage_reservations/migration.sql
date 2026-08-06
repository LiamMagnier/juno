-- Code usage is reported after a turn finishes, so the desktop/runner needs an
-- opaque server-owned handle. Without it, any authenticated client could replay
-- record/refund calls or refund a reservation it never created.
CREATE TABLE "CodeUsageReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'reserved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CodeUsageReservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CodeUsageReservation_userId_createdAt_idx"
    ON "CodeUsageReservation"("userId", "createdAt");

CREATE INDEX "CodeUsageReservation_state_createdAt_idx"
    ON "CodeUsageReservation"("state", "createdAt");

ALTER TABLE "CodeUsageReservation"
    ADD CONSTRAINT "CodeUsageReservation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
