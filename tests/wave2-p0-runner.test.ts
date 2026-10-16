import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedChildKeys,
  buildChildEnv,
  checkBaseUrl,
  checkSafeEnv,
  filterToAllowlist,
  parseQaDatabaseUrl,
  parseTestEnv,
} from "../scripts/qa/lib/safe-env.mjs";
import { findLeftovers, parsePs } from "../scripts/qa/lib/proc.mjs";
import { buildFingerprint, canReuseBuild, writeStamp } from "../scripts/qa/lib/build-stamp.mjs";

/*
 * P0 runner safety (spec appendix P0, "Runner safety", with fake values only).
 *
 * scripts/qa/run-prod-e2e.sh must exit non-zero, before it touches a database
 * or starts anything, for a remote DATABASE_URL, a database name not ending
 * in _test, a remote E2E_BASE_URL and a .env file in the working directory.
 * The runner is copied into a temporary root with stubbed database, seed and
 * Playwright steps that record what they were asked to do, so these tests
 * need no Postgres, no browser and no build.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE_DIR = path.dirname(process.execPath);
const GOOD_URL = "postgresql://postgres@127.0.0.1:55439/alevr_p0_test";

interface Fixture {
  dir: string;
  log: string;
  cleanup: () => void;
}

/** A temp root holding the real runner, real safety checks and stubbed side effects. */
function makeRoot(playwrightStub = "exit 0"): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-runner-"));
  const log = path.join(dir, "calls.log");
  writeFileSync(log, "");
  mkdirSync(path.join(dir, "scripts", "qa", "lib"), { recursive: true });
  for (const file of ["run-prod-e2e.sh", "assert-safe-env.mjs", "teardown.mjs", "test.env", "lib/safe-env.mjs", "lib/proc.mjs"]) {
    cpSync(path.join(ROOT, "scripts", "qa", file), path.join(dir, "scripts", "qa", file));
  }
  // The database step records its arguments and the database it was given.
  writeFileSync(
    path.join(dir, "scripts", "qa", "ensure-test-db.mjs"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, "db " + (process.argv.slice(2).join(" ") || "create") + " " + process.env.DATABASE_URL + "\\n");\n`
  );
  mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
  const playwright = path.join(dir, "node_modules", ".bin", "playwright");
  writeFileSync(
    playwright,
    `#!/bin/bash\necho "playwright $*" >> ${JSON.stringify(log)}\nenv > ${JSON.stringify(path.join(dir, "playwright.env"))}\n${playwrightStub}\n`
  );
  chmodSync(playwright, 0o755);
  return { dir, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: tmpdir(), ...extra } as unknown as NodeJS.ProcessEnv;
}

function runRunner(fixture: Fixture, env: Record<string, string>, args: string[] = ["--no-seed"], cwd = fixture.dir) {
  return spawnSync("bash", [path.join(fixture.dir, "scripts", "qa", "run-prod-e2e.sh"), ...args], {
    cwd,
    env: bareEnv(env),
    encoding: "utf8",
    timeout: 60_000,
  });
}

/** True once `pid` is gone (a killed process can take a moment to be reaped). */
async function waitDead(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function calls(fixture: Fixture): string {
  return readFileSync(fixture.log, "utf8");
}

const REFUSALS: { name: string; env: Record<string, string>; files?: string[]; message: RegExp }[] = [
  {
    name: "a remote DATABASE_URL",
    env: { DATABASE_URL: "postgresql://user@db.example.com:5432/app" },
    message: /db\.example\.com/,
  },
  {
    name: "a database name not ending in _test",
    env: { DATABASE_URL: "postgresql://postgres@127.0.0.1:55439/alevr_app" },
    message: /ending in _test/,
  },
  { name: "a remote E2E_BASE_URL", env: { E2E_BASE_URL: "https://alevr.app" }, message: /E2E_BASE_URL points at "alevr\.app"/ },
  { name: "a .env file in the working directory", env: {}, files: [".env"], message: /\.env exists/ },
  { name: "a .env.local file", env: {}, files: [".env.local"], message: /\.env\.local exists/ },
  { name: "a .env.production file", env: {}, files: [".env.production"], message: /\.env\.production exists/ },
  { name: "a .env.production.local file", env: {}, files: [".env.production.local"], message: /\.env\.production\.local exists/ },
  { name: "a password in the URL", env: { DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:55439/alevr_p0_test" }, message: /password/ },
  {
    name: "a query parameter that could redirect libpq",
    env: { DATABASE_URL: "postgresql://postgres@127.0.0.1:55439/alevr_p0_test?host=db.example.com" },
    message: /query parameter "host"/,
  },
  { name: "the wrong port", env: { DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/alevr_p0_test" }, message: /port 5432/ },
  {
    name: "DATABASE_URL and DIRECT_URL naming different databases",
    env: { DATABASE_URL: GOOD_URL, DIRECT_URL: "postgresql://postgres@127.0.0.1:55439/other_test" },
    message: /different databases/,
  },
  { name: "a remote DIRECT_URL", env: { DATABASE_URL: GOOD_URL, DIRECT_URL: "postgresql://postgres@10.0.0.5:55439/alevr_p0_test" }, message: /10\.0\.0\.5/ },
];

for (const refusal of REFUSALS) {
  test(`run-prod-e2e.sh refuses ${refusal.name}, before any database or server step`, () => {
    const fixture = makeRoot();
    try {
      for (const file of refusal.files ?? []) writeFileSync(path.join(fixture.dir, file), "DATABASE_URL=postgresql://prod.example.com/app\n");
      const run = runRunner(fixture, refusal.env);
      assert.notEqual(run.status, 0, `expected a refusal, got exit 0\n${run.stderr}`);
      assert.match(run.stderr, refusal.message);
      assert.match(run.stderr, /Refusing to run/);
      assert.equal(calls(fixture), "", "no database, seed or Playwright step may run after a refusal");
    } finally {
      fixture.cleanup();
    }
  });
}

test("run-prod-e2e.sh refuses an env file in the directory it was invoked from, too", () => {
  const fixture = makeRoot();
  const elsewhere = mkdtempSync(path.join(tmpdir(), "alevr-qa-cwd-"));
  try {
    writeFileSync(path.join(elsewhere, ".env.local"), "X=1\n");
    const run = runRunner(fixture, {}, ["--no-seed"], elsewhere);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /\.env\.local exists/);
    assert.equal(calls(fixture), "");
  } finally {
    fixture.cleanup();
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("run-prod-e2e.sh refuses a package id that would not make a safe database name", () => {
  const fixture = makeRoot();
  try {
    const run = runRunner(fixture, {}, ["--package", "p5;drop", "--no-seed"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--package must be/);
    assert.equal(calls(fixture), "");
  } finally {
    fixture.cleanup();
  }
});

test("a safe run creates alevr_<package>_test, passes only the allowlist to Playwright, then drops the database", () => {
  const fixture = makeRoot();
  try {
    const run = runRunner(fixture, { LEAKED_PROVIDER_KEY: "sk-test-must-not-pass", NEXT_PUBLIC_APP_URL: "https://alevr.app" }, ["--package", "p7", "--no-seed", "--", "e2e/wave2", "--project=chromium-1440"]);
    assert.equal(run.status, 0, run.stderr);
    const log = calls(fixture).trim().split("\n");
    assert.equal(log[0], "db create postgresql://postgres@127.0.0.1:55439/alevr_p7_test");
    assert.equal(log[1], "playwright test e2e/wave2 --project=chromium-1440");
    assert.equal(log[2], "db --drop postgresql://postgres@127.0.0.1:55439/alevr_p7_test");
    assert.match(run.stderr, /ps check: no node, next or postgres process from this run is left/);

    const env = Object.fromEntries(
      readFileSync(path.join(fixture.dir, "playwright.env"), "utf8")
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
    );
    const testEnv = parseTestEnv(readFileSync(path.join(ROOT, "scripts", "qa", "test.env"), "utf8"));
    const allowed = allowedChildKeys(testEnv);
    // bash itself adds PWD, SHLVL and _ to a child; those are not inherited values.
    const unexpected = Object.keys(env).filter((key) => !allowed.has(key) && !["PWD", "SHLVL", "_", "OLDPWD"].includes(key));
    assert.deepEqual(unexpected, [], `keys outside the allowlist reached Playwright: ${unexpected.join(", ")}`);
    assert.equal(env.LEAKED_PROVIDER_KEY, undefined);
    assert.equal(env.NEXT_PUBLIC_APP_URL, undefined);
    assert.equal(env.ALEVR_QA_RUNNER, "1");
    assert.equal(env.NODE_ENV, "production");
    assert.equal(env.JUNO_E2E_SMOKE_PROVIDER, "1");
    assert.equal(env.DATABASE_URL, "postgresql://postgres@127.0.0.1:55439/alevr_p7_test");
    assert.equal(env.DIRECT_URL, env.DATABASE_URL);
    assert.match(env.E2E_PORT, /^\d+$/);
    assert.equal(env.PORT, env.E2E_PORT);
    assert.equal(env.AUTH_SECRET, testEnv.AUTH_SECRET);
  } finally {
    fixture.cleanup();
  }
});

test("each run starts with an empty report directory, and a foreign directory is refused", () => {
  const fixture = makeRoot();
  try {
    const reports = path.join(fixture.dir, "reports");
    const first = runRunner(fixture, {}, ["--no-seed", "--report-dir", reports]);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(path.join(reports, ".alevr-qa-report")));
    writeFileSync(path.join(reports, "stale.json"), JSON.stringify({ gate: "shell.sidebar-cls", pass: false }));
    const second = runRunner(fixture, {}, ["--no-seed", "--report-dir", reports]);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(!existsSync(path.join(reports, "stale.json")), "a stale result from an earlier run was cleared");

    const foreign = path.join(fixture.dir, "not-reports");
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, "keep.txt"), "mine");
    writeFileSync(fixture.log, "");
    const refused = runRunner(fixture, {}, ["--no-seed", "--report-dir", foreign]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /is not empty and is not a QA report directory/);
    assert.ok(existsSync(path.join(foreign, "keep.txt")), "nothing outside a QA report directory is deleted");
    assert.equal(calls(fixture), "", "refused before any database step");
  } finally {
    fixture.cleanup();
  }
});

test("Playwright's exit code is the runner's, and the database is still dropped", () => {
  const fixture = makeRoot("exit 7");
  try {
    const run = runRunner(fixture, {});
    assert.equal(run.status, 7, run.stderr);
    assert.match(calls(fixture), /db --drop/);
  } finally {
    fixture.cleanup();
  }
});

test("teardown stops processes the run left behind and the ps check passes", async () => {
  const pidFile = (dir: string) => path.join(dir, "sleeper.pid");
  const fixture = makeRoot(`node -e 'setInterval(() => {}, 1000)' &\necho $! > "$PWD/sleeper.pid"\nexit 0`);
  try {
    const run = runRunner(fixture, {});
    assert.equal(run.status, 0, run.stderr);
    const pid = Number(readFileSync(pidFile(fixture.dir), "utf8"));
    assert.ok(pid > 1);
    assert.ok(await waitDead(pid), "the sleeper the stub left behind was stopped");
    assert.match(run.stderr, /Stopped process groups/);
    assert.match(run.stderr, /ps check: no node/);
  } finally {
    fixture.cleanup();
  }
});

test("SIGTERM to the runner mid-run stops Playwright's group, drops the database and exits 143", async () => {
  const fixture = makeRoot(`echo started >> "$PWD/started"\nnode -e 'setInterval(() => {}, 1000)' &\necho $! > "$PWD/sleeper.pid"\nwait`);
  try {
    const child = spawn("bash", [path.join(fixture.dir, "scripts", "qa", "run-prod-e2e.sh"), "--no-seed"], {
      cwd: fixture.dir,
      env: bareEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 30_000;
    while (!existsSync(path.join(fixture.dir, "sleeper.pid")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(path.join(fixture.dir, "sleeper.pid")), `the stub never started\n${stderr}`);
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 143, stderr);
    const pid = Number(readFileSync(path.join(fixture.dir, "sleeper.pid"), "utf8"));
    assert.ok(await waitDead(pid), "Playwright's process group was stopped");
    assert.match(calls(fixture), /db --drop/);
  } finally {
    fixture.cleanup();
  }
});

// The rules themselves, case by case.

test("parseQaDatabaseUrl accepts only the disposable local database", () => {
  assert.deepEqual(parseQaDatabaseUrl(GOOD_URL), { ok: true, database: "alevr_p0_test" });
  assert.deepEqual(parseQaDatabaseUrl(`${GOOD_URL}?schema=public`), { ok: true, database: "alevr_p0_test" });
  for (const bad of [
    undefined,
    "",
    "not a url",
    "postgres://postgres@127.0.0.1:55439/alevr_p0_test",
    "postgresql://postgres@localhost:55439/alevr_p0_test",
    "postgresql://postgres@127.0.0.1.nip.io:55439/alevr_p0_test",
    "postgresql://admin@127.0.0.1:55439/alevr_p0_test",
    "postgresql://postgres@127.0.0.1:55439/",
    "postgresql://postgres@127.0.0.1:55439/a/b_test",
    "postgresql://postgres@127.0.0.1:55439/Alevr_test",
    "postgresql://postgres@127.0.0.1:55439/_test",
    "postgresql://postgres@127.0.0.1:55439/alevr_test_prod",
    "postgresql://postgres@127.0.0.1:55439/alevr%22%3Bdrop_test",
    `${GOOD_URL}?sslmode=disable`,
    `${GOOD_URL}?hostaddr=10.0.0.1`,
    `${GOOD_URL}#x`,
  ]) {
    assert.equal(parseQaDatabaseUrl(bad).ok, false, `accepted ${bad}`);
  }
});

test("checkBaseUrl allows only 127.0.0.1 and localhost", () => {
  assert.equal(checkBaseUrl(undefined), null);
  assert.equal(checkBaseUrl("http://127.0.0.1:3000"), null);
  assert.equal(checkBaseUrl("http://localhost:4321/chat"), null);
  for (const bad of ["https://alevr.app", "http://localhost.evil.com", "http://user:pw@localhost:3000", "file:///etc/passwd", "http://[::1]:3000", "nope"]) {
    assert.notEqual(checkBaseUrl(bad), null, `accepted ${bad}`);
  }
});

test("checkSafeEnv reports every problem at once", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-env-"));
  try {
    writeFileSync(path.join(dir, ".env"), "");
    mkdirSync(path.join(dir, "prisma"));
    writeFileSync(path.join(dir, "prisma", ".env"), "");
    const result = checkSafeEnv({ env: { DATABASE_URL: "postgresql://x@db.example.com/app", E2E_BASE_URL: "https://alevr.app" }, dirs: [dir], root: dir });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length >= 4, result.errors.join("\n"));
    assert.ok(result.errors.some((e) => e.includes("DIRECT_URL is not set")));
    assert.ok(result.errors.some((e) => e.includes(path.join("prisma", ".env"))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test.env holds only test values and may not set what the runner owns", () => {
  const testEnv = parseTestEnv(readFileSync(path.join(ROOT, "scripts", "qa", "test.env"), "utf8"));
  for (const [key, value] of Object.entries(testEnv)) {
    assert.doesNotMatch(key, /^(ANTHROPIC|OPENAI|GOOGLE|STRIPE|RESEND|AWS|S3|GITHUB|XAI|MISTRAL|DEEPSEEK)_/, `${key} looks like a real provider key`);
    assert.doesNotMatch(value, /\b(sk-[A-Za-z0-9]{16,}|sk_live_|AKIA[0-9A-Z]{16}|ghp_)/, `${key} looks like a real secret`);
  }
  assert.match(testEnv.AUTH_SECRET, /test-only/);
  for (const reserved of ["DATABASE_URL", "PATH", "NODE_ENV", "ALEVR_QA_RUNNER", "PORT"]) {
    assert.throws(() => parseTestEnv(`${reserved}=x\n`), new RegExp(`may not set ${reserved}`));
  }
  assert.throws(() => parseTestEnv("not a pair\n"), /not KEY=VALUE/);
});

test("buildChildEnv and filterToAllowlist drop everything outside the allowlist", () => {
  const parent = { PATH: "/bin", HOME: "/h", SECRET: "x", DATABASE_URL: GOOD_URL, DIRECT_URL: GOOD_URL, NODE_ENV: "development" };
  const child = buildChildEnv({ env: parent, testEnv: { AUTH_SECRET: "t" }, port: 4567, control: { ALEVR_QA_RUNNER: "1", E2E_PORT: "4567" } });
  assert.deepEqual(Object.keys(child).sort(), ["ALEVR_QA_RUNNER", "AUTH_SECRET", "DATABASE_URL", "DIRECT_URL", "E2E_PORT", "HOME", "JUNO_E2E_SMOKE_PROVIDER", "NODE_ENV", "PATH", "PORT"]);
  assert.equal(child.NODE_ENV, "production");
  const filtered = filterToAllowlist({ ...child, FORCE_COLOR: "1", npm_config_cache: "/x", SECRET: "x" }, { AUTH_SECRET: "t" });
  assert.equal(filtered.SECRET, undefined);
  assert.equal(filtered.FORCE_COLOR, undefined);
  assert.equal(filtered.AUTH_SECRET, "t");
});

test("the ps check counts descendants and recorded groups, and never itself", () => {
  const procs = parsePs(
    [
      "  100     1   100 bash scripts/qa/run-prod-e2e.sh",
      "  101   100   101 /usr/local/bin/node node_modules/.bin/playwright test",
      "  102     1   101 /usr/local/bin/node scripts/qa/serve-prod.mjs",
      "  103   102   101 next-server (v15.5.0)",
      "  104   100   100 node scripts/qa/teardown.mjs --check-only",
      "  105   104   100 ps -axo pid=,ppid=,pgid=,command=",
      "  106     1   106 /usr/local/bin/node some-other-agent.js",
      "  107   100   100 sleep 5",
      "  108     1   200 postgres: checkpointer",
    ].join("\n")
  );
  const leftovers = findLeftovers({ procs, rootPid: 100, pgids: [101], excludePids: [104] }).map((p) => p.pid);
  assert.deepEqual(leftovers, [101, 102, 103]);
  assert.deepEqual(findLeftovers({ procs, rootPid: 100, pgids: [], excludePids: [104] }).map((p) => p.pid), [101]);
});

test("--reuse-build reuses only a build whose inputs are unchanged; harness edits do not count", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-stamp-"));
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "QA", GIT_AUTHOR_EMAIL: "qa@example.test", GIT_COMMITTER_NAME: "QA", GIT_COMMITTER_EMAIL: "qa@example.test" };
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" });
  try {
    mkdirSync(path.join(dir, "src"));
    mkdirSync(path.join(dir, "e2e"));
    writeFileSync(path.join(dir, "src", "page.tsx"), "export default 1;\n");
    writeFileSync(path.join(dir, "e2e", "a.spec.ts"), "// spec\n");
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const first = buildFingerprint(dir);
    assert.ok(first);
    mkdirSync(path.join(dir, ".next"));
    writeFileSync(path.join(dir, ".next", "BUILD_ID"), "x");
    writeStamp(dir, first);
    assert.equal(canReuseBuild(dir, buildFingerprint(dir)), true);

    writeFileSync(path.join(dir, "e2e", "a.spec.ts"), "// edited spec\n");
    writeFileSync(path.join(dir, "e2e", "new.spec.ts"), "// new spec\n");
    assert.equal(canReuseBuild(dir, buildFingerprint(dir)), true, "spec edits cannot change the build");

    writeFileSync(path.join(dir, "src", "page.tsx"), "export default 2;\n");
    assert.equal(canReuseBuild(dir, buildFingerprint(dir)), false, "an uncommitted source change rebuilds");
    git("checkout", "--", "src/page.tsx");
    assert.equal(canReuseBuild(dir, buildFingerprint(dir)), true);

    writeFileSync(path.join(dir, "src", "extra.ts"), "export const x = 1;\n");
    assert.equal(canReuseBuild(dir, buildFingerprint(dir)), false, "an untracked source file rebuilds");
    rmSync(path.join(dir, "src", "extra.ts"));

    git("commit", "-q", "--allow-empty", "-m", "empty");
    assert.equal(canReuseBuild(dir, buildFingerprint(dir)), true, "a new HEAD with the same inputs reuses");
    rmSync(path.join(dir, ".next", "BUILD_ID"));
    assert.equal(canReuseBuild(dir, buildFingerprint(dir)), false, "no build, nothing to reuse");
    const notARepo = mkdtempSync(path.join(tmpdir(), "alevr-qa-norepo-"));
    assert.equal(buildFingerprint(notARepo), null);
    rmSync(notARepo, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
