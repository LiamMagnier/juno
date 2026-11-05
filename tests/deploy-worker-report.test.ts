import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * After a deploy, deploy.sh reports how juno-work and juno-sweepers came back
 * (`report_background_workers`): a warning in the deploy log for one that is
 * missing, not online or restarting, never a failure. And juno-work is given
 * the time to set its runs aside before PM2 kills it.
 *
 * Runs the shipped function, sourced from deploy.sh without its `main`, against
 * tests/fixtures/fake-pm2.mjs, as tests/release-gates.test.ts does.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEPLOY_SCRIPT = readFileSync(path.join(ROOT, "deploy/deploy.sh"), "utf8");
const FAKE_PM2 = path.join(ROOT, "tests/fixtures/fake-pm2.mjs");

const DEPLOY_LIBRARY = (() => {
  const entry = '\nmain "$@"\n';
  assert.ok(DEPLOY_SCRIPT.endsWith(entry), "deploy.sh must end by calling main");
  return DEPLOY_SCRIPT.slice(0, DEPLOY_SCRIPT.length - entry.length + 1);
})();

type App = { name: string; status: string; restarts?: number; upSince?: number; restartEachJlist?: number };

function report(running: App[], options: { failJlist?: boolean; jlistBanner?: string; jlistRaw?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "juno-worker-report-"));
  try {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const stateFile = path.join(root, "pm2.json");
    writeFileSync(path.join(bin, "pm2"), `#!/bin/sh\nexec node "${FAKE_PM2}" "$@"\n`);
    // The settle wait is real time in production; nothing to wait for here.
    writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "pm2"), 0o755);
    chmodSync(path.join(bin, "sleep"), 0o755);
    writeFileSync(
      stateFile,
      JSON.stringify({
        running,
        dump: null,
        calls: [],
        failToStart: [],
        failToDelete: [],
        failJlist: options.failJlist ?? false,
        ...(options.jlistBanner === undefined ? {} : { jlistBanner: options.jlistBanner }),
        ...(options.jlistRaw === undefined ? {} : { jlistRaw: options.jlistRaw }),
      })
    );
    const library = path.join(root, "deploy.sh");
    writeFileSync(library, DEPLOY_LIBRARY);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("JUNO_")));
    const result = spawnSync("bash", ["-c", 'source "$0"\nset -e\nreport_background_workers\necho "after the report"', library], {
      encoding: "utf8",
      env: { ...inherited, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_PM2_STATE: stateFile } as unknown as NodeJS.ProcessEnv,
    });
    const calls = (JSON.parse(readFileSync(stateFile, "utf8")) as { calls: string[] }).calls;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const warnings = (stdout: string) => stdout.split("\n").filter((line) => line.startsWith("::warning::"));

test("healthy workers are reported, with no warning", () => {
  const run = report([
    { name: "juno-backend", status: "online" },
    { name: "juno-work", status: "online", restarts: 3, upSince: Date.now() - 30_000 },
    { name: "juno-sweepers", status: "online", restarts: 0, upSince: Date.now() - 31_000 },
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(warnings(run.stdout), []);
  assert.match(run.stdout, /Background worker juno-work: online, up \d+s, no restart in the 20s after this deploy\./);
  assert.match(run.stdout, /Background worker juno-sweepers: online/);
  assert.match(run.stdout, /after the report/, "the deploy carries on");
  assert.deepEqual(run.calls, ["jlist", "jlist"], "it only reads PM2, twice");
});

test("a missing, stopped or crash-looping worker is a warning in the log, never a failure", () => {
  const run = report([
    { name: "juno-backend", status: "online" },
    { name: "juno-work", status: "online", restarts: 1, upSince: Date.now() - 2_000, restartEachJlist: 2 },
    // juno-sweepers absent
  ]);
  assert.equal(run.status, 0, run.stderr);
  const lines = warnings(run.stdout);
  assert.equal(lines.length, 2, run.stdout);
  assert.match(lines[0]!, /juno-work restarted 2 times in the 20s after this deploy/);
  assert.match(lines[1]!, /juno-sweepers is not running after this deploy/);
  assert.match(run.stdout, /after the report/);

  const errored = report([
    { name: "juno-work", status: "errored", restarts: 15 },
    { name: "juno-sweepers", status: "stopped", restarts: 0 },
  ]);
  assert.equal(errored.status, 0, errored.stderr);
  assert.deepEqual(
    warnings(errored.stdout).map((line) => line.replace(/ The release is live.*$/, "")),
    [
      "::warning::Background worker juno-work is errored after this deploy (15 restarts in all).",
      "::warning::Background worker juno-sweepers is stopped after this deploy (0 restarts in all).",
    ]
  );
});

test("an unreadable PM2 is a warning too, and the deploy carries on", () => {
  const run = report([], { failJlist: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(warnings(run.stdout)[0] ?? "", /Could not read the background workers from PM2 after this deploy \(exit 1\)\./);
  assert.match(run.stdout, /after the report/);
});

test("a PM2 banner before the list is skipped, as pause_background_apps skips it", () => {
  const run = report(
    [
      { name: "juno-work", status: "online", restarts: 0, upSince: Date.now() - 40_000 },
      { name: "juno-sweepers", status: "online", restarts: 0, upSince: Date.now() - 40_000 },
    ],
    { jlistBanner: "[PM2] Spawning PM2 daemon with pm2_home=/root/.pm2 [ok]" }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(warnings(run.stdout), [], run.stdout);
  assert.match(run.stdout, /Background worker juno-work: online/);
  assert.match(run.stdout, /Background worker juno-sweepers: online/);
});

test("a list PM2 garbled is a warning that quotes none of it", () => {
  // What a parse error would have quoted: the environment PM2 keeps per app.
  const secret = "sk_live_must_never_reach_the_log";
  const run = report([], { jlistRaw: `[{"name":"juno-work","pm2_env":{"STRIPE_SECRET_KEY":"${secret}","status":online}}]` });
  assert.equal(run.status, 0, run.stderr);
  assert.match(warnings(run.stdout)[0] ?? "", /Could not read the background workers from PM2 after this deploy \(NO_PROCESS_LIST\)\./);
  assert.doesNotMatch(run.stdout + run.stderr, new RegExp(secret));
  assert.doesNotMatch(run.stdout + run.stderr, /STRIPE|pm2_env|online\}/);
  assert.match(run.stdout, /after the report/);
});

test("every PM2 read and the settle wait are bounded, so a hung PM2 cannot hold the deploy", () => {
  const source = DEPLOY_SCRIPT.slice(DEPLOY_SCRIPT.indexOf("report_background_workers() {"));
  const body = source.slice(0, source.indexOf("\n}\n"));
  const calls = body.match(/execFileSync\([^;]*\);/g) ?? [];
  assert.equal(calls.length, 2, "one jlist call and one settle wait");
  for (const call of calls) assert.match(call, /timeout: /, call);
  assert.doesNotMatch(body, /error\.message/, "an error is reported by its code, never its message");
});

test("the report never prints what pm2 jlist holds beyond names, states and counts", () => {
  const source = DEPLOY_SCRIPT.slice(DEPLOY_SCRIPT.indexOf("report_background_workers() {"));
  const body = source.slice(0, source.indexOf("\n}\n"));
  assert.doesNotMatch(body, /console\.log\((out|rows|before|after|row|env)\b/);
  assert.doesNotMatch(body, /JSON\.stringify/);
});

test("it runs after the rollback point, so a warning cannot roll the release back", () => {
  const main = DEPLOY_SCRIPT.slice(DEPLOY_SCRIPT.indexOf("\nmain() {"));
  const cleared = main.indexOf("ROLLBACK_NEEDED=0");
  const reported = main.indexOf("report_background_workers || true");
  assert.ok(cleared !== -1 && reported > cleared, "report_background_workers runs once ROLLBACK_NEEDED=0");
});

test("juno-work waits long enough for its runs to reach a step boundary before PM2 kills it", async () => {
  const { apps } = createRequire(import.meta.url)("../deploy/ecosystem.config.js") as {
    apps: Array<{ name: string; kill_timeout?: number }>;
  };
  const work = apps.find((app) => app.name === "juno-work");
  const { DEFAULT_SHUTDOWN_STEP_WAIT_MS, HARD_STOP_GRACE_MS } = await import("../src/lib/work/restart-resume-rules");
  assert.ok(work?.kill_timeout, "juno-work has a kill_timeout");
  assert.ok(
    work.kill_timeout >= DEFAULT_SHUTDOWN_STEP_WAIT_MS + HARD_STOP_GRACE_MS + 2_000,
    `kill_timeout ${work.kill_timeout} must cover the step wait and the grace`
  );
  assert.equal(work.kill_timeout, 60_000);
});

test("PM2 signals the runner alone, never the browser or the computer commands it is running", () => {
  const { apps } = createRequire(import.meta.url)("../deploy/ecosystem.config.js") as {
    apps: Array<{ name: string; treekill?: boolean }>;
  };
  // PM2 sends the stop signal to every descendant unless treekill is false
  // (lib/God/Methods.js: `pm2_env.treekill !== true` is the plain kill).
  assert.equal(apps.find((app) => app.name === "juno-work")?.treekill, false);
});
