import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * P0's playwright.config.ts (spec appendix P0 (3) and "Acceptance. Config").
 *
 * `npx playwright test` without the runner throws before any web server
 * starts. With the runner's variables the config starts only
 * `node scripts/qa/serve-prod.mjs`, never reuses a server, takes its port from
 * E2E_PORT, passes the allowlist (never ...process.env), keeps the existing
 * projects (firefox in CI only), adds the wave-2 matrix projects, and runs 1
 * worker locally and 2 in CI.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_DIR = path.dirname(process.execPath);
const GOOD_URL = "postgresql://postgres@127.0.0.1:55439/alevr_p0_test";

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: tmpdir(), ...extra } as unknown as NodeJS.ProcessEnv;
}

interface Resolved {
  baseURL: string;
  workers: number;
  outputDir: string;
  projects: string[];
  webServer: null | { command: string; reuseExistingServer: boolean; url: string; envKeys: string[]; env: Record<string, string> };
}

/** Loads the config in a child process with exactly `vars` and returns what it resolved to. */
function resolveConfig(vars: Record<string, string>): { status: number | null; stderr: string; config?: Resolved } {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-config-"));
  try {
    const probe = path.join(dir, "probe.ts");
    writeFileSync(
      probe,
      `import config from ${JSON.stringify(path.join(ROOT, "playwright.config.ts"))};
const ws = config.webServer as { command: string; reuseExistingServer: boolean; url: string; env: Record<string, string> } | undefined;
console.log(JSON.stringify({
  baseURL: config.use?.baseURL,
  workers: config.workers,
  outputDir: config.outputDir,
  projects: (config.projects ?? []).map((p) => p.name),
  webServer: ws ? { command: ws.command, reuseExistingServer: ws.reuseExistingServer, url: ws.url, envKeys: Object.keys(ws.env ?? {}).sort(), env: ws.env } : null,
}));
`
    );
    const run = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [probe], { cwd: ROOT, env: env(vars), encoding: "utf8", timeout: 60_000 });
    const line = run.stdout.trim().split("\n").pop() ?? "";
    return { status: run.status, stderr: run.stderr, config: run.status === 0 ? (JSON.parse(line) as Resolved) : undefined };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RUNNER = { ALEVR_QA_RUNNER: "1", E2E_PORT: "45678", DATABASE_URL: GOOD_URL, DIRECT_URL: GOOD_URL };

test("`playwright test` without the runner throws before any web server starts", () => {
  const started = Date.now();
  const run = spawnSync(path.join(ROOT, "node_modules", ".bin", "playwright"), ["test", "--list"], {
    cwd: ROOT,
    env: env({}),
    encoding: "utf8",
    timeout: 90_000,
  });
  const output = run.stdout + run.stderr;
  assert.notEqual(run.status, 0, output);
  assert.match(output, /Playwright must be started by the QA runner/);
  assert.doesNotMatch(output, /\[WebServer\]|next dev|npm run dev/);
  assert.ok(Date.now() - started < 60_000, "it failed at config load, not after a server timeout");
});

test("the config itself refuses to load without ALEVR_QA_RUNNER=1", () => {
  const result = resolveConfig({ E2E_PORT: "45678", DATABASE_URL: GOOD_URL, DIRECT_URL: GOOD_URL });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be started by the QA runner/);
});

test("with the runner, the only server is a fresh production build on E2E_PORT with the allowlisted env", () => {
  const result = resolveConfig({ ...RUNNER, LEAKED_PROVIDER_KEY: "sk-test-must-not-pass" });
  assert.equal(result.status, 0, result.stderr);
  const config = result.config!;
  assert.equal(config.baseURL, "http://127.0.0.1:45678");
  assert.ok(config.webServer);
  assert.equal(config.webServer.command, "node scripts/qa/serve-prod.mjs");
  assert.equal(config.webServer.reuseExistingServer, false);
  assert.equal(config.webServer.url, "http://127.0.0.1:45678/api/health");
  assert.ok(!config.webServer.envKeys.includes("LEAKED_PROVIDER_KEY"), "parent variables never reach the server env");
  assert.equal(config.webServer.env.DATABASE_URL, GOOD_URL);
  assert.equal(config.webServer.env.ALEVR_QA_RUNNER, "1");
  assert.ok(config.webServer.envKeys.includes("AUTH_SECRET"), "test.env keys are passed");
  // Playwright empties its outputDir on every run; gate reports must live outside it.
  assert.equal(config.outputDir, "test-results/playwright");
});

test("existing projects stay, firefox only in CI, and the matrix projects are added", () => {
  const local = resolveConfig(RUNNER).config!;
  for (const name of ["setup", "chromium", "webkit", "Mobile Safari", "iPad Safari", "anon-auth", "chromium-1440", "chromium-390", "webkit-390"]) {
    assert.ok(local.projects.includes(name), `missing project ${name}`);
  }
  assert.ok(!local.projects.includes("firefox"), "firefox runs in CI only");
  assert.equal(local.workers, 1);
  const ci = resolveConfig({ ...RUNNER, CI: "true" }).config!;
  assert.ok(ci.projects.includes("firefox"));
  assert.equal(ci.workers, 2);
});

test("E2E_BASE_URL must be local; a local one replaces the managed server", () => {
  const remote = resolveConfig({ ...RUNNER, E2E_BASE_URL: "https://alevr.app" });
  assert.notEqual(remote.status, 0);
  assert.match(remote.stderr, /Only 127\.0\.0\.1 or localhost/);
  const local = resolveConfig({ ...RUNNER, E2E_BASE_URL: "http://localhost:4100" });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(local.config!.baseURL, "http://localhost:4100");
  assert.equal(local.config!.webServer, null);
});

test("without a port the config refuses rather than guessing :3000", () => {
  const result = resolveConfig({ ALEVR_QA_RUNNER: "1", DATABASE_URL: GOOD_URL, DIRECT_URL: GOOD_URL });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E2E_PORT is not set/);
});

test("package.json runs e2e only through the runner", async () => {
  const pkg = (await import("../package.json", { with: { type: "json" } })).default as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["test:e2e"], "bash scripts/qa/run-prod-e2e.sh");
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (/playwright/.test(command)) assert.fail(`script ${name} calls Playwright directly: ${command}`);
  }
});

test("design-gates.yml can read main's commit status, keeps its database local, and requires enforced gates to be measured", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "design-gates.yml"), "utf8");
  // check-base.sh calls GET /commits/main/status, which needs statuses: read
  // once the workflow narrows the token's permissions.
  assert.match(workflow, /^permissions:\n(?:  .*\n)*  statuses: read$/m);
  assert.match(workflow, /^  checks: read$/m);
  assert.doesNotMatch(workflow, /secrets\./, "the design gates read no secrets");
  assert.match(workflow, /- 55439:5432/);
  assert.doesNotMatch(workflow, /DATABASE_URL:/, "the runner's default local *_test URL is the only database");
  assert.match(workflow, /gates\.ts evaluate --require-enforced /);
});
