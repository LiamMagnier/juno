import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installIsCurrent, lockHash, nodeSatisfies, RUNNER_PACKAGES, STAMP_NAME } from "../scripts/test-prepare.mjs";

/**
 * `npm run test:prepare && npm test` must test in the state CI's unit-test
 * shards test in (ledger P2-1). The shards call the same script, so these
 * tests hold three things: the script's own decisions, that CI really calls
 * it (and nothing that could make the two differ), and that a wrong Node
 * major is refused instead of producing a different pass/fail list.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };

test("nodeSatisfies reads the package.json engines range", () => {
  assert.equal(nodeSatisfies("v24.0.0", ">=24.0.0 <25").ok, true);
  assert.equal(nodeSatisfies("v24.22.1", ">=24.0.0 <25").ok, true);
  assert.equal(nodeSatisfies("v22.22.0", ">=24.0.0 <25").ok, false);
  assert.equal(nodeSatisfies("v25.0.0", ">=24.0.0 <25").ok, false);
  assert.equal(nodeSatisfies("v23.11.0", ">=24.0.0 <25").ok, false);
  // An unfamiliar range is reported, never waved through.
  const odd = nodeSatisfies("v24.0.0", "^24");
  assert.equal(odd.ok, false);
  assert.match(odd.reason ?? "", /does not understand/);
});

test("the repository's engines range is one the check understands, and it is Node 24 like CI", () => {
  const engines = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).engines.node as string;
  assert.equal(nodeSatisfies("v24.0.0", engines).ok, true);
  assert.equal(nodeSatisfies("v22.0.0", engines).ok, false);
});

test("a runner install counts as current only when its stamp matches the lockfile", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "test-prepare-"));
  try {
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    assert.equal(installIsCurrent(dir), false, "no node_modules at all");
    mkdirSync(path.join(dir, "node_modules"));
    assert.equal(installIsCurrent(dir), false, "an install this script did not stamp");
    writeFileSync(path.join(dir, "node_modules", STAMP_NAME), `${lockHash(dir)}\n`);
    assert.equal(installIsCurrent(dir), true);
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
    assert.equal(installIsCurrent(dir), false, "the lockfile changed since the install");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("it prepares exactly the runner packages the suites import", () => {
  assert.deepEqual(RUNNER_PACKAGES, ["runner/agent-core", "runner/env-server"]);
  // The two import paths behind the AUDIT's local-only failures.
  assert.match(readFileSync(path.join(ROOT, "runner/env-server/package.json"), "utf8"), /"ws":/);
  assert.equal(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).dependencies.ws, undefined, "ws is not a root dependency");
});

test("package.json exposes it as test:prepare", () => {
  const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
  assert.equal(scripts["test:prepare"], "node scripts/test-prepare.mjs");
});

test("CI's unit-test shards prepare with the same script and run the same files", () => {
  type Step = { name?: string; run?: string };
  const workflow = yaml.load(readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = workflow.jobs["unit-tests"].steps;
  const runs = steps.map((step) => (step.run ?? "").trim());
  const install = runs.indexOf("npm ci");
  const prepare = runs.indexOf("npm run test:prepare");
  const shard = runs.findIndex((run) => run.includes("tsx --test --test-shard="));
  assert.ok(install >= 0 && prepare > install && shard > prepare, "npm ci, then test:prepare, then the shard");
  assert.match(runs[shard], /tests\/\*\.test\.ts$/, "the shards run the same glob as `npm test`");
  // Anything the script does must not be done differently by a sibling step.
  for (const run of runs) {
    assert.doesNotMatch(run, /npm ci --prefix runner\//, "runner installs come from test:prepare only");
    assert.doesNotMatch(run, /npm run build --prefix runner\/agent-core/, "the agent-core build comes from test:prepare only");
  }
  const setupNode = (workflow.jobs["unit-tests"].steps as Array<{ uses?: string; with?: { "node-version"?: number } }>).find((step) =>
    step.uses?.startsWith("actions/setup-node")
  );
  assert.equal(setupNode?.with?.["node-version"], 24, "CI's Node is the major test:prepare insists on");
});

test("the script refuses a Node outside engines before touching anything", () => {
  // Run it under a fake version: the check reads process.version, which a
  // preload can replace without needing a second Node installed.
  const dir = mkdtempSync(path.join(tmpdir(), "test-prepare-node-"));
  try {
    const preload = path.join(dir, "fake-node.cjs");
    writeFileSync(preload, 'Object.defineProperty(process, "version", { value: "v22.22.0" });\n');
    const run = spawnSync(process.execPath, ["--require", preload, path.join(ROOT, "scripts", "test-prepare.mjs"), "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Node v22\.22\.0 is outside package\.json engines\.node/);
    assert.match(run.stderr, /RuleTester/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
