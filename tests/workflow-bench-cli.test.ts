/**
 * The workflow benchmark end to end through its CLI (`npm run bench:workflows`),
 * in a child process so the product's server-only modules load under the
 * react-server condition exactly as the npm script runs them.
 *
 * Every workflow with an offline Alevr product path is executed for real —
 * renderers, extractors, the MCP client against a loopback server, the tool
 * dispatcher, the resumable stream, the stall watchdog — and graded by the
 * independent validators (LibreOffice checks off here, so office-dependent
 * runs may be unverified, never passed by default).
 *
 * Like the memory benchmark's record, the committed baseline pins which
 * offline workflows FAIL: if a product change fixes one or breaks another,
 * this test fails until the baseline is re-recorded on purpose
 * (`npm run bench:workflows -- run --run-id baseline-<date>`).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { WORKFLOWS } from "../bench/workflows/lib/catalog";
import { BENCH_DIR, REPO_ROOT } from "../bench/workflows/lib/fixtures";
import type { BenchResults } from "../bench/workflows/lib/types";

const BASELINE = path.join(BENCH_DIR, "results", "baseline-2026-10-25", "results.json");
const out = mkdtempSync(path.join(tmpdir(), "wb-cli-"));
after(() => rmSync(out, { recursive: true, force: true }));

describe("workflow benchmark CLI", () => {
  const offline = WORKFLOWS.filter((w) => w.offline).map((w) => w.id);
  const selected = [...offline, "chat-02", "coding-01"];
  const run = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), "scripts/workflow-bench.ts", "run", "--no-office", "--run-id", "cli-test", "--out", out, "--only", selected.join(",")],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 240_000, env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } }
  );

  it("exits cleanly and writes results.json and report.md", () => {
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.ok(existsSync(path.join(out, "results.json")));
    assert.match(readFileSync(path.join(out, "report.md"), "utf8"), /## Acceptance \(LEDGER P1-7\)/);
  });

  const results = (): BenchResults => JSON.parse(readFileSync(path.join(out, "results.json"), "utf8")) as BenchResults;

  it("executes every offline-capable workflow, with no validator crash", () => {
    const records = results().records.filter((r) => r.scope === "offline_pipeline");
    assert.deepEqual(records.map((r) => r.workflowId).sort(), [...selected].sort());
    for (const r of records.filter((x) => offline.includes(x.workflowId))) {
      assert.notEqual(r.state, "not_run", `${r.workflowId}: ${r.reason}`);
      assert.ok(r.checks.length > 0, `${r.workflowId}: no checks`);
      assert.ok(!r.checks.some((c) => c.id.endsWith("validator-error")), `${r.workflowId}: ${JSON.stringify(r.checks.find((c) => c.id.endsWith("validator-error")))}`);
      assert.equal(r.cost.source, "offline_no_provider_calls");
      assert.ok(r.product.version && r.startedAt && r.attempts.length === 1);
    }
    for (const id of ["chat-02", "coding-01"]) assert.equal(records.find((r) => r.workflowId === id)?.state, "not_run");
  });

  it("an office check that cannot run keeps a run unverified rather than passed", () => {
    for (const r of results().records.filter((x) => x.scope === "offline_pipeline" && x.checks.some((c) => c.id.startsWith("office:")))) {
      assert.notEqual(r.state, "passed", `${r.workflowId} passed without its office reopen check`);
    }
  });

  it("never runs end-to-end without a live model, and says why", () => {
    for (const r of results().records.filter((x) => x.scope === "end_to_end")) {
      assert.equal(r.state, "not_run");
      assert.ok(r.reason.length > 10);
    }
  });

  it("fails exactly the offline workflows the committed baseline records as failing", () => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as BenchResults;
    // Office checks are off here, so compare failures that do not depend on them.
    const failing = (res: BenchResults) =>
      res.records
        .filter((r) => r.scope === "offline_pipeline" && r.state === "failed" && r.checks.some((c) => c.status === "fail" && !c.id.startsWith("office:")))
        .map((r) => r.workflowId)
        .sort();
    assert.deepEqual(failing(results()), failing(baseline));
  });
});
