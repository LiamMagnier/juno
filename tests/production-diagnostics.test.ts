import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// The diagnostic exports pure reducers and performs I/O only with --run.
import { classifyDatabaseFailure, processSummary, summarizeHealthFailures, healthLogPath } from "../scripts/production-diagnostics.mjs";

test("health diagnostics distinguish acquisition pressure from unavailable databases", () => {
  assert.equal(classifyDatabaseFailure("Unable to start a transaction in the given time"), "transaction_acquisition_timeout");
  assert.equal(classifyDatabaseFailure("P1001: Can't reach database server"), "unreachable");
  assert.equal(classifyDatabaseFailure("P2024: Timed out fetching a new connection from the connection pool"), "pool_timeout");
  assert.equal(classifyDatabaseFailure("Transaction already closed"), "transaction_expired");
});

test("process and log summaries omit credentials and customer data", () => {
  const summary = processSummary([{ name: "juno", pm2_env: { status: "online", restart_time: 2, DATABASE_URL: "secret", env: { PASSWORD: "secret" } }, monit: { memory: 12, cpu: 1 } }, { name: "unrelated-private-process" }]);
  assert.deepEqual(summary, [{ name: "juno", status: "online", restarts: 2, memoryBytes: 12, cpuPercent: 1 }]);
  const failures = summarizeHealthFailures("private unrelated log\n[health] database check failed { message: 'Unable to start a transaction in the given time', url: 'postgres://private' }\n[health] database check failed { message: 'P1001 secret server' }");
  assert.deepEqual(failures, { count: 2, categories: { transaction_acquisition_timeout: 1, unreachable: 1 } });
  assert.doesNotMatch(JSON.stringify({ summary, failures }), /secret|private|PASSWORD|DATABASE_URL/);
});

test("production diagnostics are manual, pinned to main, and use protected pinned SSH", () => {
  const workflow = readFileSync(new URL("../.github/workflows/production-diagnostics.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request|schedule:/);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: Production/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
});


test("only fixed health-log names and bounded numeric process IDs become paths", () => {
  assert.equal(healthLogPath(null, "/home/service"), "/home/service/.pm2/logs/juno-error.log");
  assert.equal(healthLogPath(12, "/home/service"), "/home/service/.pm2/logs/juno-error-12.log");
  for (const value of ["../../.env", "12/../../.env", -1, NaN, Infinity, 1.5, 1_000_001]) {
    assert.throws(() => healthLogPath(value));
  }
});
