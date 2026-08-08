ALTER TABLE "AttachmentVersion"
  ADD COLUMN "kind" "AttachmentKind" NOT NULL DEFAULT 'FILE';

ALTER TABLE "AttachmentVersion"
  ALTER COLUMN "kind" DROP DEFAULT;
