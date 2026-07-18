-- Additive, nullable: how an artifact version came to be
-- ("generated" | "edit" | "restore"; NULL on legacy rows).
ALTER TABLE "ArtifactVersion" ADD COLUMN "origin" TEXT;
