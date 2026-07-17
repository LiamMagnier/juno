-- Change-log retention support: a single "global" row recording the highest
-- AccountChange cursor scripts/prune-sync.ts has deleted. bootstrap/changes
-- serve it as compactionFloorCursor, and a client whose cursor predates it
-- gets 410 (it may have missed pruned changes and must resync). Seeded at 0
-- so the floor is well-defined before the first prune ever runs.
CREATE TABLE "SyncCompaction" (
    "id" TEXT NOT NULL,
    "floorCursor" BIGINT NOT NULL DEFAULT 0,
    "prunedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SyncCompaction_pkey" PRIMARY KEY ("id")
);

INSERT INTO "SyncCompaction" ("id") VALUES ('global') ON CONFLICT ("id") DO NOTHING;
