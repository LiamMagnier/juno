import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The release gates cannot be skipped by accident.
 *
 * 133dd285 ("Allow deployment gates bypass") made scripts/local-gates.sh exit 0
 * whenever SKIP_CHECKS=1 was in the environment, and deploy-from-mac.sh read the
 * same variable. CI, the Mac release and the Mac deploy all call local-gates.sh,
 * so one leftover export turned every gate into a silent pass.
 *
 * What remains is one emergency path, on purpose: deploy-from-mac.sh
 * --skip-checks=<reason>. It is a flag (never inherited), needs a reason,
 * still runs the migration replay, the security check and `next build`, and
 * writes a line to a log on this Mac and on the VM. A push to main never takes
 * it: the CI workflow calls local-gates.sh, which has no bypass at all.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_GATES = readFileSync(path.join(ROOT, "scripts/local-gates.sh"), "utf8");
const MAC_DEPLOY = readFileSync(path.join(ROOT, "deploy/deploy-from-mac.sh"), "utf8");
const DEPLOY_WORKFLOW = readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8");
const RELEASE_MACOS = readFileSync(path.join(ROOT, "native/Scripts/release-macos.sh"), "utf8");

/** A bare environment for a child shell (Next types ProcessEnv with a required NODE_ENV). */
const bareEnv = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

const code = (source: string) =>
  source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

test("SKIP_CHECKS=1 in the environment does not skip a single shared gate", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "juno-gates-"));
  try {
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "scripts", "local-gates.sh"), LOCAL_GATES);
    const log = path.join(dir, "calls.log");
    // Every tool the gate script calls is a stub that records its argv.
    for (const tool of ["npm", "node", "python3"]) {
      const stub = path.join(dir, "bin", tool);
      writeFileSync(stub, `#!/bin/bash\necho "${tool} $*" >> "${log}"\n`);
      chmodSync(stub, 0o755);
    }
    writeFileSync(path.join(dir, "scripts", "release-gates.sh"), `echo "release-gates" >> "${log}"\n`);
    const run = spawnSync("bash", [path.join(dir, "scripts", "local-gates.sh")], {
      env: bareEnv({ PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, SKIP_CHECKS: "1", HOME: dir }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /SKIP_CHECKS is set in the environment and is ignored/);
    const calls = readFileSync(log, "utf8");
    for (const expected of [
      "node scripts/check-local-migrations.mjs",
      "npm run typecheck",
      "npm test",
      "npm run lint",
      "npm run security:check",
      "python3 -m unittest",
      "npm run native:wire:check",
      "npm test --prefix runner/agent-core",
      "npm test --prefix relay",
      "release-gates",
    ]) {
      assert.ok(calls.includes(expected), `${expected} did not run:\n${calls}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shared gate script has no bypass branch left in it", () => {
  const body = code(LOCAL_GATES);
  assert.doesNotMatch(body, /exit 0/);
  assert.doesNotMatch(body, /SKIP_CHECKS[^\n]*\n[^\n]*exit/);
});

test("the Mac deploy never inherits the bypass and refuses one without a reason", () => {
  const body = code(MAC_DEPLOY);
  assert.doesNotMatch(body, /SKIP_CHECKS="\$\{SKIP_CHECKS/, "SKIP_CHECKS must not be read from the environment");
  assert.match(body, /\nSKIP_CHECKS=0\n/);
  const script = path.join(ROOT, "deploy/deploy-from-mac.sh");
  // These all stop during argument parsing, before any SSH, Docker or network.
  const bare = spawnSync("bash", [script, "--skip-checks"], { encoding: "utf8", env: bareEnv({ PATH: "/usr/bin:/bin", HOME: tmpdir() }) });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /needs a reason/);
  const short = spawnSync("bash", [script, "--skip-checks=tests"], { encoding: "utf8", env: bareEnv({ PATH: "/usr/bin:/bin", HOME: tmpdir() }) });
  assert.equal(short.status, 2);
  assert.match(short.stderr, /12 to 300 characters/);
  const help = spawnSync("bash", [script, "--help"], { encoding: "utf8", env: bareEnv({ PATH: "/usr/bin:/bin", HOME: tmpdir(), SKIP_CHECKS: "1" }) });
  assert.equal(help.status, 0);
  assert.match(help.stderr, /SKIP_CHECKS in the environment is ignored/);
  assert.match(help.stdout, /EMERGENCY ONLY/);
});

test("the emergency path still runs the security check and leaves a record on both machines", () => {
  const body = code(MAC_DEPLOY);
  const container = body.slice(body.indexOf("docker run --rm -i"), body.indexOf('step "next build"'));
  assert.match(container, /JUNO_EMERGENCY_SKIP_GATES[\s\S]*npm run security:check[\s\S]*else[\s\S]*bash scripts\/local-gates\.sh --without-migrations/);
  // The migration replay runs on the host before the build, bypass or not.
  assert.ok(body.indexOf("local-gates.sh --migrations-only") < body.indexOf("docker run --rm -i"));
  // Local log, then the same line appended on the VM before deploy.sh runs.
  assert.match(body, /deploy-bypass\.log/);
  const remote = body.slice(body.indexOf("<<'REMOTE'"), body.indexOf("\nREMOTE\n"));
  assert.match(remote, /GATES_BYPASS_B64[\s\S]*base64 -d[\s\S]*deploy-bypass\.log[\s\S]*deploy\/deploy\.sh/);
  // The reason crosses SSH as base64, never as text an ssh command line could interpret.
  assert.match(body, /GATES_BYPASS_B64='\$GATES_BYPASS_B64'/);
});

test("a push cannot reach a bypass: CI and the Mac release run the shared gates unconditionally", () => {
  assert.match(DEPLOY_WORKFLOW, /run: bash scripts\/local-gates\.sh\n/);
  assert.doesNotMatch(DEPLOY_WORKFLOW, /SKIP_CHECKS|skip-checks|JUNO_EMERGENCY_SKIP_GATES/);
  assert.match(code(RELEASE_MACOS), /\nbash scripts\/local-gates\.sh\n/);
  assert.doesNotMatch(code(RELEASE_MACOS), /SKIP_CHECKS/);
});
