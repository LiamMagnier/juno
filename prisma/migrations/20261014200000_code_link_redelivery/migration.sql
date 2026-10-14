-- Device link redelivery (docs/code-v2/DEVICE-LINK.md "Receipts"): how many times a command was
-- leased, so a host that keeps receipts gets an unanswered command again a bounded number of
-- times. Additive only.

-- AlterTable
ALTER TABLE "CodeLinkCommand" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
