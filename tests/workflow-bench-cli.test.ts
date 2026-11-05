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
 * The committed baseline records which offline workflows FAIL. This test
 * fails on a NEW failure (a product change broke a workflow the baseline
 * passes). A baseline failure that now passes does not turn CI red: it prints
 * a notice asking for the baseline to be re-recorded on purpose
 * (`npm run bench:workflows -- run --run-id baseline-<date>`), so other
 * workstreams are not coupled to this one. The current baseline,
 * baseline-2026-10-25-r2, was re-recorded after the calculator and the
 * injection scanner fixes made reasoning-03 and research-03 pass; it records
 * no offline failure, so any offline failure now turns this red.
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

const BASELINE = path.join(BENCH_DIR, "results", "baseline-2026-10-25-r2", "results.json");
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

  it("`run` never labels anything end_to_end; its live column is model_via_router, not_run without a key, and says why", () => {
    const records = results().records;
    assert.equal(records.filter((x) => x.scope === "end_to_end").length, 0, "only an imported run of the real product is end_to_end");
    const live = records.filter((x) => x.scope === "model_via_router");
    assert.equal(live.length, selected.length);
    for (const r of live) {
      assert.equal(r.state, "not_run");
      assert.ok(r.reason.length > 10);
    }
  });

  it("the two product findings stay fixed: reasoning-03 (calculator) and research-03 (injection label) pass offline", () => {
    const records = results().records.filter((r) => r.scope === "offline_pipeline");
    for (const id of ["reasoning-03", "research-03"]) {
      const record = records.find((r) => r.workflowId === id);
      assert.equal(record?.state, "passed", `${id}: ${JSON.stringify(record?.checks.filter((c) => c.status !== "pass"))}`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as BenchResults;
    for (const id of ["reasoning-03", "research-03"]) {
      assert.equal(baseline.records.find((r) => r.scope === "offline_pipeline" && r.workflowId === id)?.state, "passed", `${id} in the baseline`);
    }
  });

  it("introduces no offline failure the committed baseline does not record (a fixed one asks for a re-record)", (t) => {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as BenchResults;
    // Office checks are off here, so compare failures that do not depend on them.
    const failing = (res: BenchResults) =>
      res.records
        .filter((r) => r.scope === "offline_pipeline" && r.state === "failed" && r.checks.some((c) => c.status === "fail" && !c.id.startsWith("office:")))
        .map((r) => r.workflowId)
        .sort();
    const now = failing(results());
    const before = failing(baseline);
    const added = now.filter((id) => !before.includes(id));
    assert.deepEqual(added, [], `new offline failure(s) not in ${path.relative(REPO_ROOT, BASELINE)}`);
    const fixed = before.filter((id) => selected.includes(id) && !now.includes(id));
    if (fixed.length) {
      t.diagnostic(`RE-RECORD NOTICE: ${fixed.join(", ")} failed in the committed baseline and pass now. Re-record it on purpose: npm run bench:workflows -- run --run-id baseline-<date>`);
    }
  });
});
