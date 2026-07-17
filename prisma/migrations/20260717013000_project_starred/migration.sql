-- Starred projects surface in the sidebar's Pinned section. Additive with a
-- default, so every existing row and every old client keeps working unchanged.
ALTER TABLE "Project" ADD COLUMN "starred" BOOLEAN NOT NULL DEFAULT false;
