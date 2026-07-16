-- The Juno app's Code workspaces (project folders), mirrored server-side so the
-- website's Code tab lists the same Projects the app shows — sessions or not.
CREATE TABLE "CodeWorkspace" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "lastOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CodeWorkspace_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CodeWorkspace_userId_path_key" ON "CodeWorkspace"("userId", "path");
CREATE INDEX "CodeWorkspace_userId_lastOpenedAt_idx" ON "CodeWorkspace"("userId", "lastOpenedAt");
ALTER TABLE "CodeWorkspace" ADD CONSTRAINT "CodeWorkspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
