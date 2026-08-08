CREATE TABLE "ModelCapabilityProbe" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "probeVersion" INTEGER NOT NULL DEFAULT 1,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "detail" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelCapabilityProbe_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ModelCapabilityProbe_modelId_key" ON "ModelCapabilityProbe"("modelId");
CREATE INDEX "ModelCapabilityProbe_status_expiresAt_idx" ON "ModelCapabilityProbe"("status", "expiresAt");
CREATE INDEX "ModelCapabilityProbe_provider_status_idx" ON "ModelCapabilityProbe"("provider", "status");
