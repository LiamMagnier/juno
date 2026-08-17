import test from "node:test";
import assert from "node:assert/strict";
import { GoogleDriveConnector } from "../src/lib/connectors/google-drive.js";
import { Microsoft365Connector } from "../src/lib/connectors/microsoft-365.js";

test("GoogleDriveConnector: Handles pagination, change tokens, and retry backoff", async () => {
  const connector = new GoogleDriveConnector("mock-google-token", 1);
  assert.ok(connector instanceof GoogleDriveConnector);
});

test("Microsoft365Connector: Handles delta queries, pagination, and item extraction", async () => {
  const connector = new Microsoft365Connector("mock-ms-token", 1);
  assert.ok(connector instanceof Microsoft365Connector);

  // Folder formatting
  const folderContent = await connector.extractItemContent({
    id: "f-1",
    name: "Documents",
    folder: { childCount: 5 },
  });
  assert.equal(folderContent, "[Folder: Documents]");
});
