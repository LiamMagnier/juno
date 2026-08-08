import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const RECOVERY_SOURCE = readFileSync(new URL("../src/lib/import-recovery.ts", import.meta.url), "utf8");

test("recovery rebinds abandoned objects before rotating cleanup to a new lease", () => {
  assert.match(RECOVERY_SOURCE, /status: \{ in: \[\.\.\.CLEANUP_STATES\] \},\n\s+\},\n\s+data: \{ leaseToken: replacementLeaseToken \}/);
  assert.match(RECOVERY_SOURCE, /cleanupImportRun\(run\.userId, run\.id, replacementLeaseToken\)/);
  assert.match(RECOVERY_SOURCE, /leaseToken: replacementLeaseToken, status: \{ in: \[\.\.\.CLEANUP_STATES\] \}/);
  assert.match(RECOVERY_SOURCE, /Attached rows are intentionally excluded/);
});

test("recovery never broadens cleanup beyond the run owner and import run", () => {
  const rebindStart = RECOVERY_SOURCE.indexOf("await prismaUnguarded.importObject.updateMany({", RECOVERY_SOURCE.indexOf("replacementLeaseToken = randomUUID"));
  const rebindEnd = RECOVERY_SOURCE.indexOf("      });", rebindStart) + "      });".length;
  const rebindBlock = RECOVERY_SOURCE.slice(rebindStart, rebindEnd);
  assert.match(rebindBlock, /userId: run\.userId/);
  assert.match(rebindBlock, /importRunId: run\.id/);
  assert.match(rebindBlock, /status: \{ in: \[\.\.\.CLEANUP_STATES\] \}/);
});
