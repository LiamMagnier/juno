-- AlterTable
ALTER TABLE "MemoryEntry" ADD COLUMN     "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "embeddingModel" TEXT;

-- CreateTable
CREATE TABLE "MemoryEdit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "summary" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "operations" JSONB NOT NULL DEFAULT '[]',
    "inverse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryEdit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemoryEdit_userId_createdAt_idx" ON "MemoryEdit"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryEdit_userId_clientId_key" ON "MemoryEdit"("userId", "clientId");

-- CreateIndex
CREATE INDEX "MemoryEntry_userId_embeddingModel_idx" ON "MemoryEntry"("userId", "embeddingModel");

-- AddForeignKey
ALTER TABLE "MemoryEdit" ADD CONSTRAINT "MemoryEdit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
