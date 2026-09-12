-- Resumable web chat streams.
--
-- ChatStreamEvent is the append-only log of one generation's SSE frames: a
-- client whose stream dropped reconnects to GET /api/chat/stream/[generationId]
-- with the last `seq` it saw and replays from there, instead of polling the
-- conversation and, on giving up, regenerating (a second charge). `payload` is
-- the frame's JSON encrypted with the message keyring — it carries transcript
-- text. Rows are deleted ~10 minutes after the generation's terminal frame.
CREATE TABLE "ChatStreamEvent" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatStreamEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatStreamEvent_generationId_seq_key" ON "ChatStreamEvent"("generationId", "seq");
CREATE INDEX "ChatStreamEvent_generationId_createdAt_idx" ON "ChatStreamEvent"("generationId", "createdAt");

-- A cancel recorded on the durable receipt, so it reaches the stream loop from
-- another process or tab; the in-memory registry stays the fast path. Nullable
-- and additive — existing rows and older releases are unaffected.
ALTER TABLE "ChatFirstSubmissionReceipt" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);
