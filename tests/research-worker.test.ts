import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("research production topology has a restart-safe worker", () => {
  const worker = readFileSync("scripts/research-worker.ts", "utf8");
  const ecosystem = readFileSync("deploy/ecosystem.config.js", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20260808120000_research_worker_source_policy/migration.sql",
    "utf8"
  );

  assert.match(worker, /workerLeaseUntil/);
  assert.match(worker, /workerId: WORKER_ID/);
  assert.match(worker, /researchEngine\(\)\.drive/);
  assert.equal(
    packageJson.scripts?.["research:worker"],
    "NODE_OPTIONS=--conditions=react-server tsx scripts/research-worker.ts"
  );
  assert.match(ecosystem, /name: "juno-research"/);
  assert.match(ecosystem, /args: "run research:worker"/);
  assert.match(schema, /workerLeaseOwner\s+String\?/);
  assert.match(schema, /@@index\(\[state, workerLeaseUntil\]\)/);
  assert.match(migration, /ResearchRun_state_workerLeaseUntil_idx/);
});
