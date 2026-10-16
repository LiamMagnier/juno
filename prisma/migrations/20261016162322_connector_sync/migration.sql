CREATE TABLE "ConnectorSyncState" (
  "connectionId" TEXT NOT NULL,
  "stream" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorSyncState_pkey" PRIMARY KEY ("connectionId", "stream"),
  CONSTRAINT "ConnectorSyncState_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "ConnectorSyncEvent" (
  "id" BIGSERIAL PRIMARY KEY,
  "connectionId" TEXT NOT NULL,
  "stream" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorSyncEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConnectorSyncEvent_connectionId_stream_eventKey_key" ON "ConnectorSyncEvent"("connectionId", "stream", "eventKey");
CREATE INDEX "ConnectorSyncEvent_connectionId_id_idx" ON "ConnectorSyncEvent"("connectionId", "id");
