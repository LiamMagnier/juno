import test from "node:test";
import assert from "node:assert/strict";
import { createArtifactMaintenance } from "@/lib/artifact-maintenance";

test("maintenance shares the worker clock and retries failures without blocking future sweeps", async () => {
  let seals = 0;
  let purges = 0;
  const reports: string[] = [];
  const tick = createArtifactMaintenance({
    seal: async () => { seals++; if (seals === 1) throw new Error("database unavailable"); return 2; },
    purge: async () => { purges++; return { eligible: 3, purged: 0, dryRun: true }; },
    report: (message) => { reports.push(message); },
  });
  await tick(1000);
  await tick(1001);
  assert.equal(seals, 1);
  assert.equal(purges, 1);
  await tick(61000);
  assert.equal(seals, 2);
  assert.equal(purges, 1);
  await tick(6 * 60 * 60_000 + 1000);
  assert.equal(purges, 2);
  assert.ok(reports.includes("artifact draft sweep failed"));
  assert.ok(reports.includes("artifact drafts sealed"));
});
