ALTER TABLE "Attachment"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'upload',
  ADD COLUMN "parserState" TEXT NOT NULL DEFAULT 'queued',
  ADD COLUMN "parserVersion" TEXT,
  ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE TABLE "AttachmentVersion" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'upload',
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "extractedText" TEXT,
    "parserState" TEXT NOT NULL DEFAULT 'ready',
    "parserVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttachmentVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttachmentVersion_attachmentId_version_key"
  ON "AttachmentVersion"("attachmentId", "version");
CREATE INDEX "AttachmentVersion_attachmentId_createdAt_idx"
  ON "AttachmentVersion"("attachmentId", "createdAt");

ALTER TABLE "AttachmentVersion"
  ADD CONSTRAINT "AttachmentVersion_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Attachment_userId_deletedAt_createdAt_idx"
  ON "Attachment"("userId", "deletedAt", "createdAt");
