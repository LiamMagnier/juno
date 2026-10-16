-- Thumbs-down reasons (G33). Nullable columns with no default: a metadata-only
-- change in Postgres, safe on the live Message table.
ALTER TABLE "Message" ADD COLUMN "feedbackReason" TEXT;
ALTER TABLE "Message" ADD COLUMN "feedbackNote" TEXT;
ALTER TABLE "RoutingOutcome" ADD COLUMN "feedbackReason" TEXT;
