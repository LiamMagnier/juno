-- Code session UX (additive, safe on a live database: nullable columns and a new table).

-- A share link's client-supplied transcript (Code sessions whose transcript lives on the Mac).
ALTER TABLE "Share" ADD COLUMN "transcript" JSONB;

-- The account's Code defaults (what a new session starts with).
ALTER TABLE "Settings" ADD COLUMN "codePrefs" JSONB;

-- Thumbs on answers in Mac-hosted Code sessions (no Message row to carry them).
CREATE TABLE "CodeTurnFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "turnKey" TEXT NOT NULL,
    "feedback" "Feedback" NOT NULL,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeTurnFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CodeTurnFeedback_conversationId_turnKey_key" ON "CodeTurnFeedback"("conversationId", "turnKey");
CREATE INDEX "CodeTurnFeedback_userId_createdAt_idx" ON "CodeTurnFeedback"("userId", "createdAt");

ALTER TABLE "CodeTurnFeedback" ADD CONSTRAINT "CodeTurnFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CodeTurnFeedback" ADD CONSTRAINT "CodeTurnFeedback_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
