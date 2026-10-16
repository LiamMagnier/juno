import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUDGETS, GATES, gateById, type GateDefinition } from "../e2e/support/budgets";
import { evaluateMeasurement, evaluateResults, gateMode, loadGateConfig, parseGateFile, readResults, type GateResult } from "../e2e/support/gates";
import { renderReadme } from "../scripts/qa/lib/gate-table";

/*
 * P0's gate registry (spec appendix P0 (4) and "Acceptance. Gate registry").
 *
 * Listing a gate in a package's e2e/wave2/<pkg>/gates.ts flips it from
 * report-only to enforced; a seeded regression then fails the run while
 * unlisted gates only warn. Checked through the functions and through the
 * `scripts/qa/gates.ts evaluate` command CI and the runner call.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(ROOT, "scripts", "qa", "gates.ts");

function fixtureRoot(gateFiles: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-gates-"));
  writeFileSync(path.join(dir, "package.json"), "{}\n");
  writeFileSync(path.join(dir, "playwright.config.ts"), "export default {};\n");
  for (const [pkg, source] of Object.entries(gateFiles)) {
    mkdirSync(path.join(dir, "e2e", "wave2", pkg), { recursive: true });
    writeFileSync(path.join(dir, "e2e", "wave2", pkg, "gates.ts"), source);
  }
  return dir;
}

function writeResult(dir: string, result: Partial<GateResult> & { gate: string; pass: boolean }) {
  const folder = path.join(dir, result.gate);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, `${Math.random().toString(36).slice(2)}.json`), JSON.stringify({ observed: null, stat: null, budget: "", detail: "", recordedAt: "", ...result }));
}

function evaluateCli(root: string, results: string) {
  return spawnSync(TSX, [CLI, "evaluate", "--root", root, results], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
}

const SEEDED_REGRESSION = { gate: "shell.sidebar-cls", pass: false, observed: 0.2, detail: "0.2 CLS (budget = 0)" };

test("a fixture gate listed in a fixture gates.ts flips to enforce, and a seeded regression fails the run", () => {
  const root = fixtureRoot({
    "p9-fixture": `import type { GateId } from "../../support/budgets";\n// enforced by the fixture package\nexport const enforce = ["shell.sidebar-cls"] as const satisfies readonly GateId[];\n`,
  });
  const results = path.join(root, "results");
  try {
    writeResult(results, SEEDED_REGRESSION);
    writeResult(results, { gate: "chat.tail-drain", pass: false, observed: 400, detail: "400 ms (budget ≤ 250)" });
    const config = loadGateConfig(root);
    assert.deepEqual(config.errors, []);
    assert.equal(gateMode(config, "shell.sidebar-cls"), "enforce");
    assert.equal(gateMode(config, "chat.tail-drain"), "report");
    assert.deepEqual(config.enforcedBy.get("shell.sidebar-cls"), ["p9-fixture"]);

    const run = evaluateCli(root, results);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /FAIL {2}shell\.sidebar-cls \(enforced by p9-fixture\)/);
    assert.match(run.stdout, /warn {2}chat\.tail-drain \(report-only\)/);
    const summary = JSON.parse(readFileSync(path.join(results, "summary.json"), "utf8"));
    assert.equal(summary.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same regression only warns while no package lists the gate", () => {
  const root = fixtureRoot({ "p9-fixture": `export const enforce = [] as const;\n` });
  const results = path.join(root, "results");
  try {
    writeResult(results, SEEDED_REGRESSION);
    const run = evaluateCli(root, results);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /warn {2}shell\.sidebar-cls \(report-only\)/);
    assert.match(run.stdout, /0 enforced failure\(s\), 1 report-only warning\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an enforced gate that passes keeps the run green", () => {
  const root = fixtureRoot({ "p4-fixture": `export const enforce = ["shell.sidebar-cls"];\n` });
  const results = path.join(root, "results");
  try {
    writeResult(results, { gate: "shell.sidebar-cls", pass: true, observed: 0, detail: "0 CLS" });
    const run = evaluateCli(root, results);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /pass {2}shell\.sidebar-cls \(enforced by p4-fixture\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a typo in a gates.ts fails the run instead of silently staying report-only", () => {
  const root = fixtureRoot({ "p5-fixture": `export const enforce = ["chat.enter-bubbel"];\n` });
  const results = path.join(root, "results");
  try {
    mkdirSync(results);
    const run = evaluateCli(root, results);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /enforces "chat\.enter-bubbel", which is not a known gate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseGateFile reads string literals only, ignoring comments", () => {
  assert.deepEqual(parseGateFile(`export const enforce = ["a.b", 'c.d', \`e.f\`] as const;`), ["a.b", "c.d", "e.f"]);
  assert.deepEqual(parseGateFile(`/* export const enforce = ["x"]; */\nexport const enforce: readonly string[] = [\n  // "commented.out",\n  "a.b",\n];`), ["a.b"]);
  assert.deepEqual(parseGateFile(`export const enforce = [] as const satisfies readonly GateId[];`), []);
  assert.throws(() => parseGateFile(`export default ["a.b"];`), /must export `enforce`/);
  assert.throws(() => parseGateFile(`export const enforce = [...others, "a.b"];`), /may only contain gate id string literals/);
});

test("P0's own gates.ts parses and enforces nothing yet", () => {
  const config = loadGateConfig(ROOT);
  assert.deepEqual(config.errors, []);
  const p0 = config.files.find((f) => f.pkg === "p0-harness");
  assert.ok(p0, "e2e/wave2/p0-harness/gates.ts is found by the glob");
  assert.deepEqual(p0.enforce, []);
});

test("evaluateMeasurement applies each gate's statistic, operator and minimum runs", () => {
  const bubble = gateById("chat.enter-bubble")!;
  const fast = Array.from({ length: 20 }, (_, i) => 50 + i);
  assert.equal(evaluateMeasurement(bubble, { samples: fast }).pass, true);
  const slowTail = [...fast.slice(0, 18), 400, 500];
  const slow = evaluateMeasurement(bubble, { samples: slowTail });
  assert.equal(slow.pass, false, "two slow runs in twenty push p95 over 100ms");
  assert.equal(slow.stat, "p95");
  assert.equal(slow.stats?.n, 20);
  const tooFew = evaluateMeasurement(bubble, { samples: [10, 10, 10] });
  assert.equal(tooFew.pass, false);
  assert.match(tooFew.detail, /only 3 of the 20 required runs/);

  const inp = gateById("chat.inp")!;
  assert.equal(evaluateMeasurement(inp, { value: 199.9 }).pass, true);
  assert.equal(evaluateMeasurement(inp, { value: 200 }).pass, false, "INP is strictly under 200");

  const cls = gateById("shell.sidebar-cls")!;
  assert.equal(evaluateMeasurement(cls, { value: 0 }).pass, true);
  assert.equal(evaluateMeasurement(cls, { value: 0.0001 }).pass, false);

  const heap = gateById("web.js-heap")!;
  assert.equal(evaluateMeasurement(heap, { value: 1.1 }).pass, true);
  assert.equal(evaluateMeasurement(heap, { value: 1.11 }).pass, false);

  const parity = gateById("design.bubble-composer-parity")!;
  assert.equal(evaluateMeasurement(parity, { pass: true }).pass, true);
  assert.equal(evaluateMeasurement(parity, {}).pass, false, "a pass/fail gate needs a verdict");
  assert.equal(evaluateMeasurement(bubble, { samples: [Number.NaN] }).pass, false);
});

test("native records are evaluated against the same budgets; probes without a gate are skipped", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-native-"));
  try {
    writeFileSync(path.join(dir, "idle.json"), JSON.stringify({ name: "idle", gate: "mac.idle-rss", measurement: { samples: [200, 230], unit: "MB" } }));
    writeFileSync(path.join(dir, "probe.json"), JSON.stringify({ name: "probe", gate: null, measurement: { samples: [1], unit: "MB" } }));
    writeFileSync(path.join(dir, "geometry.json"), JSON.stringify({ context: "macos-chat", platform: "macos" }));
    const { results, errors } = readResults([dir]);
    assert.deepEqual(errors, []);
    assert.equal(results.length, 1);
    assert.equal(results[0].gate, "mac.idle-rss");
    assert.equal(results[0].pass, false, "230MB is over the 220MB budget");
    const summary = evaluateResults(loadGateConfig(ROOT), results);
    assert.equal(summary.exitCode, 0, "report-only until P8 enforces it");
    assert.equal(summary.warnings[0]?.id, "mac.idle-rss");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`gates.ts parity` combines web and native geometry into one parity result", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-parity-"));
  try {
    const web = path.join(dir, "web");
    const native = path.join(dir, "native");
    const out = path.join(dir, "results");
    mkdirSync(web);
    mkdirSync(native);
    const radii = { startStart: 12, startEnd: 12, endEnd: 8, endStart: 12 };
    writeFileSync(path.join(web, "web-chat.json"), JSON.stringify({ context: "web-chat", platform: "web", bubble: { radii }, composer: { radius: 22 }, disc: { radius: 12 } }));
    writeFileSync(path.join(native, "macos-chat.json"), JSON.stringify({ context: "macos-chat", platform: "macos", bubble: { radii }, composer: { radius: 24 }, disc: { radius: 12 } }));
    const run = spawnSync(TSX, [CLI, "parity", "--out", out, web, native, path.join(dir, "missing")], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /web-chat, macos-chat: macos-chat: composer radius 24 \(expected 22\)/);
    const { results } = readResults([out]);
    assert.equal(results.length, 1);
    assert.equal(results[0].gate, "design.bubble-composer-parity");
    assert.equal(results[0].pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the catalog carries the spec §9 numbers", () => {
  const check = (id: string) => (gateById(id) as GateDefinition).check;
  assert.deepEqual(check("chat.enter-bubble"), { op: "lte", value: 100, unit: "ms", stat: "p95", minSamples: 20 });
  assert.equal(check("chat.enter-status")?.value, 300);
  assert.equal(check("shell.palette-warm")?.value, 20);
  assert.equal(check("shell.palette-cold-rows")?.value, 150);
  assert.equal(check("shell.route-shell")?.value, 100);
  assert.deepEqual([check("chat.inp")?.op, check("chat.inp")?.value], ["lt", 200]);
  assert.equal(check("chat.tail-drain")?.value, 250);
  assert.equal(check("shell.sidebar-cls")?.value, 0);
  assert.equal(check("web.js-heap")?.value, 1.1);
  assert.equal(check("motion.galaxy-cap")?.value, 3);
  assert.equal(check("code.dock-panes")?.value, 3);
  assert.equal(check("mac.idle-rss")?.value, 220);
  assert.equal(check("mac.quick-entry-rss")?.value, 30);
  assert.equal(check("mac.quick-entry-hotkey")?.value, 120);
  assert.equal(check("native.webview-pool")?.value, 3);
  assert.equal(check("ios.thread-memory")?.value, 300);
  assert.equal(check("ios.paging")?.value, 250);
  assert.equal(check("ios.hitch-ratio")?.value, 5);
  assert.equal(check("a11y.axe")?.value, 0);
  assert.deepEqual(BUDGETS.bubbleRadii, [12, 12, 12, 8]);
  assert.equal(BUDGETS.composerRadius, 22);
  assert.equal(BUDGETS.discRadius, 12);
  const ids = GATES.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, "gate ids are unique");
  for (const gate of GATES as readonly GateDefinition[]) {
    assert.match(gate.id, /^[a-z0-9]+\.[a-z0-9-]+$/, `${gate.id} is <area>.<name>`);
    assert.ok(gate.owners.length > 0, `${gate.id} names an owner`);
  }
});

test("scripts/qa/README.md lists every gate with its owner and current state", () => {
  const readme = readFileSync(path.join(ROOT, "scripts", "qa", "README.md"), "utf8");
  assert.equal(readme, renderReadme(readme, loadGateConfig(ROOT)), "the gate table is stale: npx tsx scripts/qa/gates.ts readme --write");
  for (const gate of GATES) assert.ok(readme.includes(`\`${gate.id}\``), `README is missing ${gate.id}`);
});
