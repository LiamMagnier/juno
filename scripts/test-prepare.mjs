#!/usr/bin/env node
// Puts a checkout into the state CI's unit-test shards run in (ledger P2-1).
//
//   npm run test:prepare            then: npm test
//   node scripts/test-prepare.mjs --force    reinstall the runner packages even if current
//   node scripts/test-prepare.mjs --check    report what is missing; change nothing
//
// `npm test` on a fresh clone used to differ from the CI shards by dozens of
// failures that said nothing about the code (AUDIT 2026-10-25 §1):
//
//   - runner/agent-core/dist is build output (gitignored). Three suites import
//     it by path and failed with "Cannot find module .../dist/work/index.js".
//   - runner/env-server has its own install; `ws` lives there, not at the root,
//     so code-v2-env-link failed with "Cannot find module 'ws'".
//   - src/lib/i18n-catalog.generated.ts is generated (predev/prebuild make it).
//   - Node 22 instead of the Node 24 CI and package.json "engines" pin: ESLint's
//     RuleTester under node:test cancels its own cases on 22 ("test did not
//     finish before its parent and was cancelled"), 16 failures in
//     wave2-p1-lint alone.
//
// deploy.yml's unit-test shards run this same script after `npm ci`, so the
// local preparation and CI's cannot drift apart again. It never runs the root
// `npm ci` itself: that is the caller's (and wipes node_modules), and CI does
// it in its own step first.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/** Runner packages with an install of their own, in dependency order. */
export const RUNNER_PACKAGES = ["runner/agent-core", "runner/env-server"];
/** Where a successful `npm ci` records which lockfile it installed. */
export const STAMP_NAME = ".test-prepare-lock.sha256";

/**
 * Does `version` satisfy the `>=A.B.C <D` range package.json "engines" uses?
 * Only that shape is understood; anything else is reported, not guessed.
 * @param {string} version e.g. "v24.1.0" or "24.1.0"
 * @param {string} range e.g. ">=24.0.0 <25"
 * @returns {{ ok: boolean, reason?: string }}
 */
export function nodeSatisfies(version, range) {
  const parse = (v) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const match = /^\s*>=\s*(\d+(?:\.\d+){0,2})\s+<\s*(\d+(?:\.\d+){0,2})\s*$/.exec(range ?? "");
  if (!match) return { ok: false, reason: `package.json engines.node is "${range}", a range this check does not understand` };
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i += 1) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const v = parse(version);
  if (cmp(v, parse(match[1])) < 0 || cmp(v, parse(match[2])) >= 0) {
    return { ok: false, reason: `Node ${version} is outside package.json engines.node "${range}"` };
  }
  return { ok: true };
}

/** sha256 of a package's lockfile, or null when it has none. */
export function lockHash(dir) {
  const lock = path.join(dir, "package-lock.json");
  if (!existsSync(lock)) return null;
  return createHash("sha256").update(readFileSync(lock)).digest("hex");
}

/**
 * Whether a runner package's node_modules was installed from its current
 * lockfile by this script. A missing install, a missing stamp, or a lockfile
 * that changed since all mean "reinstall".
 */
export function installIsCurrent(dir) {
  const stamp = path.join(dir, "node_modules", STAMP_NAME);
  if (!existsSync(stamp)) return false;
  return readFileSync(stamp, "utf8").trim() === lockHash(dir);
}

function run(label, command, args, options = {}) {
  const started = Date.now();
  process.stderr.write(`[test:prepare] ${label}...\n`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? result.signal}).`);
  process.stderr.write(`[test:prepare] ${label}: done in ${Math.round((Date.now() - started) / 100) / 10}s.\n`);
}

function main(argv) {
  const force = argv.includes("--force");
  const checkOnly = argv.includes("--check");
  const problems = [];

  const engines = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).engines?.node;
  const node = nodeSatisfies(process.version, engines);
  if (!node.ok) {
    problems.push(
      `${node.reason}. CI runs Node 24, and suites behave differently on other majors (wave2-p1-lint's RuleTester cases are cancelled on Node 22). Switch Node, then re-run.`
    );
  }
  if (!existsSync(path.join(ROOT, "node_modules", ".bin", "tsx"))) {
    problems.push("The root install is missing (node_modules/.bin/tsx). Run `npm ci` first; test:prepare never runs the root install itself.");
  }
  if (problems.length) {
    for (const problem of problems) console.error(`[test:prepare] ${problem}`);
    return 1;
  }

  const stale = RUNNER_PACKAGES.filter((pkg) => force || !installIsCurrent(path.join(ROOT, pkg)));
  const distMissing = !existsSync(path.join(ROOT, "runner", "agent-core", "dist", "work", "index.js"));
  if (checkOnly) {
    for (const pkg of stale) console.error(`[test:prepare] ${pkg}: install missing or from an older lockfile.`);
    if (distMissing) console.error("[test:prepare] runner/agent-core/dist is not built.");
    if (!existsSync(path.join(ROOT, "src", "lib", "i18n-catalog.generated.ts"))) console.error("[test:prepare] the i18n catalog is not generated.");
    return stale.length || distMissing ? 1 : 0;
  }

  // The same three things deploy.yml's unit-test shards needed before every
  // run, in the same order: the generated catalog, the runner installs, the
  // agent-core build.
  run("Generate the i18n catalog", process.execPath, [path.join(ROOT, "scripts", "generate-i18n-catalog.mjs")]);
  for (const pkg of RUNNER_PACKAGES) {
    const dir = path.join(ROOT, pkg);
    if (!stale.includes(pkg)) {
      process.stderr.write(`[test:prepare] ${pkg}: install is current with its lockfile; skipping npm ci.\n`);
      continue;
    }
    run(`npm ci --prefix ${pkg}`, NPM, ["ci", "--prefix", pkg, "--no-audit", "--no-fund"]);
    writeFileSync(path.join(dir, "node_modules", STAMP_NAME), `${lockHash(dir)}\n`);
  }
  // Always rebuilt: tsc is incremental-free here but quick, and a stale dist
  // (built from an older checkout) fails tests just like a missing one.
  run("Build runner/agent-core", NPM, ["run", "build", "--prefix", "runner/agent-core"]);
  if (!existsSync(path.join(ROOT, "runner", "agent-core", "dist", "work", "index.js"))) {
    console.error("[test:prepare] runner/agent-core built, but dist/work/index.js is still missing.");
    return 1;
  }
  console.error("[test:prepare] Ready: `npm test` now runs in the state CI's unit-test shards run in.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`[test:prepare] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
