import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { GateDefinition } from "../e2e/support/budgets";
import { evaluateResults, loadGateConfig, readResults, type GateResult } from "../e2e/support/gates";
import { EMPTY_FIXTURES, readQaFixtures } from "../e2e/support/fixtures";
import { readHeapBaseline } from "../e2e/support/heap";
import { readGeometryRecords, readNativeGeometry } from "../e2e/support/parity";
import { encodePng, solidBitmap } from "../e2e/support/png";
import { settleBaseline } from "../e2e/support/screenshot-matrix";
import { cell, gateTable } from "../scripts/qa/lib/gate-table";
import { parseTestEnv } from "../scripts/qa/lib/safe-env.mjs";
import { PROVIDERS } from "../src/lib/providers";

/*
 * What changed in PR #99's harness on the way in (ledger P1-5):
 *
 * - the five CodeQL alerts that failed its CodeQL check: three file-system
 *   races (check, then use the same path), incomplete Markdown escaping in the
 *   README gate table, an unanchored host regex in a test;
 * - `evaluate --require-enforced` no longer demands a Playwright measurement
 *   for external gates (platform "ci"), which P1 enforces and which turned
 *   every full run red on this branch.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("settleBaseline: no baseline is a capture, an update records one, a rerun matches, a change is reported", () => {
  const { dir, cleanup } = tmp("qa-baseline-");
  try {
    const baseline = path.join(dir, "route", "chromium-1440-light-full.png");
    const red = encodePng(solidBitmap(4, 4, [255, 0, 0, 255]));
    const blue = encodePng(solidBitmap(4, 4, [0, 0, 255, 255]));

    assert.deepEqual(settleBaseline(baseline, red, { update: false, threshold: 16 }), { baseline: null, status: "captured", diff: null });

    const created = settleBaseline(baseline, red, { update: true, threshold: 16 });
    assert.equal(created.status, "new-baseline");
    assert.deepEqual(readFileSync(baseline), red);

    const updated = settleBaseline(baseline, blue, { update: true, threshold: 16 });
    assert.equal(updated.status, "updated");
    assert.deepEqual(readFileSync(baseline), blue);

    assert.equal(settleBaseline(baseline, blue, { update: false, threshold: 16 }).status, "match");
    const changed = settleBaseline(baseline, red, { update: false, threshold: 16 });
    assert.equal(changed.status, "changed");
    assert.equal(changed.diff?.differing, 16);
  } finally {
    cleanup();
  }
});

test("settleBaseline surfaces errors other than a missing baseline instead of calling them a capture", () => {
  const { dir, cleanup } = tmp("qa-baseline-err-");
  try {
    const asDirectory = path.join(dir, "not-a-file.png");
    mkdirSync(asDirectory);
    assert.throws(() => settleBaseline(asDirectory, encodePng(solidBitmap(1, 1, [0, 0, 0, 255])), { update: false, threshold: 16 }), /EISDIR/);
  } finally {
    cleanup();
  }
});

test("Markdown cells escape backslashes before pipes, so text can never open a new column", () => {
  assert.equal(cell("a|b"), "a\\|b");
  assert.equal(cell("a\\b"), "a\\\\b");
  // The case the incomplete escape got wrong: a backslash already before a pipe.
  assert.equal(cell("a\\|b"), "a\\\\\\|b");
  assert.equal(cell("one\ntwo\r\nthree"), "one two three");
  // Every row of the real table still has exactly its seven columns.
  const config = loadGateConfig(ROOT);
  for (const row of gateTable(config).split("\n")) {
    const columns = row.replace(/\\\\/g, "").replace(/\\\|/g, "").split("|").length - 2;
    assert.equal(columns, 7, row);
  }
});

test("the result reader treats a missing directory as empty and walks nested ones", () => {
  const { dir, cleanup } = tmp("qa-results-");
  try {
    assert.deepEqual(readResults([path.join(dir, "missing")]), { results: [], errors: [] });
    mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    const result: GateResult = { gate: "a11y.axe", pass: true, observed: 0, stat: null, budget: "0", detail: "", recordedAt: "" };
    writeFileSync(path.join(dir, "a", "b", "r.json"), JSON.stringify(result));
    writeFileSync(path.join(dir, "a", "notes.txt"), "not json");
    writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ gate: "a11y.axe", pass: false }));
    const { results, errors } = readResults([dir]);
    assert.deepEqual(errors, []);
    assert.equal(results.length, 1, "summary.json and non-JSON files are not results");
    // A dangling symlink is neither a file nor a directory: skipped, not a crash.
    symlinkSync(path.join(dir, "nowhere.json"), path.join(dir, "dangling.json"));
    assert.equal(readResults([dir]).results.length, 1);
  } finally {
    cleanup();
  }
});

test("missing optional inputs read as absent, not as errors", () => {
  const { dir, cleanup } = tmp("qa-optional-");
  try {
    assert.deepEqual(readQaFixtures(dir), EMPTY_FIXTURES);
    assert.equal(readHeapBaseline(path.join(dir, "heap.json")), null);
    assert.deepEqual(readGeometryRecords(path.join(dir, "geometry")), []);
    assert.deepEqual(readNativeGeometry(path.join(dir, "native")), []);
    // A gates.ts-less package directory is ignored.
    mkdirSync(path.join(dir, "e2e", "wave2", "p9-empty"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(path.join(dir, "playwright.config.ts"), "");
    const config = loadGateConfig(dir);
    assert.deepEqual(config.files, []);
    assert.deepEqual(config.errors, []);
  } finally {
    cleanup();
  }
});

const FIXTURE_CATALOG: GateDefinition[] = [
  { id: "web.thing", title: "Web thing", budget: "pass", measuredBy: "Playwright", owners: ["P0"], harness: "e2e", platform: "web" },
  { id: "ci.thing", title: "CI thing", budget: "pass", measuredBy: "its own CI job", owners: ["P1"], harness: "P1", platform: "ci" },
];

test("--require-enforced still demands a measurement for enforced browser gates, but not for external CI gates", () => {
  const { dir, cleanup } = tmp("qa-enforced-");
  try {
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(path.join(dir, "playwright.config.ts"), "");
    mkdirSync(path.join(dir, "e2e", "wave2", "p1"), { recursive: true });
    writeFileSync(path.join(dir, "e2e", "wave2", "p1", "gates.ts"), 'export const enforce = ["web.thing", "ci.thing"] as const;\n');
    const config = loadGateConfig(dir, FIXTURE_CATALOG);
    const summary = evaluateResults(config, [], [], { requireEnforced: true });
    assert.deepEqual(summary.errors, ["web.thing is enforced by p1 but this run recorded no measurement for it."]);
    assert.equal(summary.exitCode, 1);
    const external = summary.gates.find((gate) => gate.id === "ci.thing");
    assert.equal(external?.external, true);
    assert.equal(external?.status, "unmeasured");
  } finally {
    cleanup();
  }
});

test("this branch's full-run summary passes with only P1's external gates enforced", () => {
  const { dir, cleanup } = tmp("qa-summary-");
  try {
    const run = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "scripts", "qa", "gates.ts"), "evaluate", "--require-enforced", dir], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /ext {3}design\.contrast-matrix is enforced by p1-pipeline and measured outside this run/);
    assert.match(run.stdout, /ext {3}design\.lint is enforced by p1-pipeline and measured outside this run/);
    assert.doesNotMatch(run.stdout, /ERROR/);
  } finally {
    cleanup();
  }
});

test("test.env configures a provider only with a fake key dead-ended on a loopback port", () => {
  // The journey needs a model catalog (Regenerate › Switch model, a default
  // model the composer can resolve), and a catalog lists only configured
  // providers. test.env may configure one only so that nothing can reach it:
  // the key says test-only and the provider's base URL is 127.0.0.1.
  const testEnv = parseTestEnv(readFileSync(path.join(ROOT, "scripts", "qa", "test.env"), "utf8"));
  const configured = Object.entries(PROVIDERS).filter(([, def]) => testEnv[def.apiKeyEnv] !== undefined);
  assert.ok(configured.length >= 1, "the journey's catalog needs one configured provider");
  for (const [provider, def] of configured) {
    assert.match(testEnv[def.apiKeyEnv], /test-only/, `${def.apiKeyEnv} must be an obviously fake value`);
    assert.ok(def.baseUrlEnv, `${provider} has no base URL override, so its fake key would be sent to the real host`);
    const base = new URL(testEnv[def.baseUrlEnv!] ?? "");
    assert.equal(base.hostname, "127.0.0.1", `${def.baseUrlEnv} must keep ${provider}'s calls on the runner`);
    assert.equal(base.protocol, "http:");
  }
  // The deterministic default model's provider is the configured one, so a
  // new chat resolves a real catalog entry instead of falling back to Auto.
  assert.ok(configured.some(([provider]) => provider === "qwen"));
});
