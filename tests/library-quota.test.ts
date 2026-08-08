import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LIBRARY = readFileSync(new URL("../src/lib/library.ts", import.meta.url), "utf8");
const ROUTES = new Map([
  ["web upload", readFileSync(new URL("../src/app/api/upload/route.ts", import.meta.url), "utf8")],
  ["native upload", readFileSync(new URL("../src/app/api/v1/attachments/route.ts", import.meta.url), "utf8")],
  ["replacement upload", readFileSync(new URL("../src/app/api/attachments/[id]/versions/route.ts", import.meta.url), "utf8")],
  ["generated media", readFileSync(new URL("../src/app/api/generate/route.ts", import.meta.url), "utf8")],
  ["history import", readFileSync(new URL("../src/app/api/import/route.ts", import.meta.url), "utf8")],
]);

test("library quota reads and writes are fenced by one account row lock", () => {
  assert.match(LIBRARY, /SELECT [^`]+FROM \"User\"[^`]+FOR UPDATE/);
  assert.match(LIBRARY, /libraryUsageBytes\(userId, excludeAttachmentId, db\)/);
  assert.match(LIBRARY, /throw new LibraryQuotaExceededError\(capacity\)/);
});

test("every quota-bearing producer rechecks inside its persistence transaction", () => {
  for (const [name, source] of ROUTES) {
    assert.match(source, /lockedLibraryCapacity\(/, `${name} is missing the transaction-scoped quota check`);
    assert.match(source, /assertLibraryCapacity\(/, `${name} does not fail closed on the locked quota result`);
  }
});

test("object-producing routes compensate storage when persistence fails", () => {
  for (const [name, source] of ROUTES) {
    assert.match(source, /deleteObject\(/, `${name} is missing object compensation`);
  }
});
