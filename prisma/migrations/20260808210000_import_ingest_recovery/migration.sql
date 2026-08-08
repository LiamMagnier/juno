-- A durable lease for the post-response knowledge indexing hook. Imports can
-- commit an attachment and then lose the process before Next's after() callback
-- runs; the import-recovery worker reclaims old indexing leases.
ALTER TABLE "Attachment"
  ADD COLUMN "parserClaimedAt" TIMESTAMP(3);
