-- Project.parentId: projects nest as folders (src/lib/projects/project-tree.ts).
-- Additive and nullable: every existing project stays top level.
ALTER TABLE "Project" ADD COLUMN "parentId" TEXT;

-- A project cannot be its own parent. Longer cycles are refused by the API
-- (validateProjectMove), which walks the owner's tree before every move.
ALTER TABLE "Project" ADD CONSTRAINT "Project_parentId_not_self_check" CHECK ("parentId" IS NULL OR "parentId" <> "id");

-- CreateIndex
CREATE INDEX "Project_parentId_idx" ON "Project"("parentId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
