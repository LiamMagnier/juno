-- Governance for public share links (audit X-31, §12.8).
--
-- Moving artifact previews off srcdoc (audit X-01) lets scripts run on public
-- share pages again, so the ways to take a link down ship with it:
--
--   * "Share"."takenDownAt" / "takenDownBy" / "takedownReason": an admin
--     takedown, separate from the owner's own "revokedAt". The public page
--     404s, the owner's list drops it, and the target cannot be re-shared
--     until an admin restores it (src/lib/share-moderation.ts). A banned
--     owner's links are suspended by the lookup itself (src/lib/share.ts), so
--     a ban needs no column and lifting it brings them back.
--   * "ShareReport": what a visitor sends from the Report link. Keyed to the
--     share with ON DELETE SET NULL and carrying a copy of its token, title
--     and owner, so the record survives the link.
--   * "ModerationFlag"."shareId" / "artifactId": which link a takedown flag
--     was about. Plain columns, no foreign key, for the same reason.
--
-- Expand-only (docs/JUNO.md §20.2b): nullable columns the running release
-- never selects, and a table it never reads.
ALTER TABLE "Share" ADD COLUMN "takenDownAt" TIMESTAMP(3);
ALTER TABLE "Share" ADD COLUMN "takenDownBy" TEXT;
ALTER TABLE "Share" ADD COLUMN "takedownReason" TEXT;

ALTER TABLE "ModerationFlag" ADD COLUMN "shareId" TEXT;
ALTER TABLE "ModerationFlag" ADD COLUMN "artifactId" TEXT;

CREATE TABLE "ShareReport" (
    "id" TEXT NOT NULL,
    "shareId" TEXT,
    "shareToken" TEXT NOT NULL,
    "shareTitle" TEXT NOT NULL DEFAULT '',
    "shareOwnerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "contact" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShareReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShareReport_status_createdAt_idx" ON "ShareReport"("status", "createdAt");
CREATE INDEX "ShareReport_shareId_idx" ON "ShareReport"("shareId");

ALTER TABLE "ShareReport" ADD CONSTRAINT "ShareReport_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "Share"("id") ON DELETE SET NULL ON UPDATE CASCADE;
