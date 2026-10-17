import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * P0's base gate (spec appendix P0 (1) and "Acceptance. Base gate").
 *
 * scripts/qa/check-base.sh fails unless there are no unmerged paths, the
 * wave-1 integration commit is an ancestor of HEAD and main CI is green. Each
 * condition is exercised on a fixture repository; CI is read through a fake
 * `gh` on PATH, so no network is used. The last test runs the gate on this
 * repository's real wave-1 base (with CI faked green), when the clone has the
 * history to do so.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "qa", "check-base.sh");
const GIT_ENV = {
  GIT_AUTHOR_NAME: "QA",
  GIT_AUTHOR_EMAIL: "qa@example.test",
  GIT_COMMITTER_NAME: "QA",
  GIT_COMMITTER_EMAIL: "qa@example.test",
  GIT_CONFIG_NOSYSTEM: "1",
};

type CiMode = "green" | "red" | "vercel-red" | "pending" | "status-pending" | "empty" | "error";

/** A fake GitHub CLI that answers the three `gh api` calls the gate makes. */
function fakeGh(binDir: string, mode: CiMode, head = "main") {
  const checks: Record<CiMode, string> = {
    green: "test\\tcompleted\\tsuccess\\nmacOS app\\tcompleted\\tskipped\\nAnalyze\\tcompleted\\tneutral",
    red: "test\\tcompleted\\tsuccess\\niOS app\\tcompleted\\tfailure",
    "vercel-red": "test\\tcompleted\\tsuccess\\nVercel\\tcompleted\\tfailure",
    pending: "test\\tin_progress\\t\\nmigrations\\tcompleted\\tsuccess",
    "status-pending": "test\\tcompleted\\tsuccess",
    empty: "",
    error: "",
  };
  const status = mode === "status-pending" ? "pending 2" : mode === "green" ? "success 1" : "success 0";
  const script = `#!/bin/bash
if [ "${mode}" = error ]; then echo "gh: authentication required" >&2; exit 1; fi
case "$*" in
  *check-runs*) printf '${checks[mode]}\\n' ;;
  *"/status"*) echo "${status}" ;;
  *) git rev-parse ${head} ;;
esac
`;
  writeFileSync(path.join(binDir, "gh"), script);
  chmodSync(path.join(binDir, "gh"), 0o755);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" }).trim();
}

interface Repo {
  dir: string;
  bin: string;
  wave1: string;
  cleanup: () => void;
}

/** main: base → wave1 → later. A side branch forks from base and never sees wave1. */
function makeRepo(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-base-"));
  const bin = path.join(dir, ".bin");
  mkdirSync(bin);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, ".gitignore"), ".bin/\n");
  writeFileSync(path.join(dir, "file.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  writeFileSync(path.join(dir, "wave1.txt"), "wave 1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "wave 1 integration");
  const wave1 = git(dir, "rev-parse", "HEAD");
  writeFileSync(path.join(dir, "later.txt"), "later\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "later");
  return { dir, bin, wave1, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runGate(repo: Repo, args: string[], opts: { gh?: CiMode | null } = { gh: "green" }) {
  if (opts.gh) fakeGh(repo.bin, opts.gh);
  // Linux CI installs gh in /usr/bin. An isolated PATH must expose only
  // the gate's required tools to exercise genuine CLI absence on every host.
  if (opts.gh === null) {
    for (const tool of ["git", "sed"]) symlinkSync(`/usr/bin/${tool}`, path.join(repo.bin, tool));
  }
  const pathDirs = opts.gh === null ? [repo.bin] : [repo.bin, "/usr/bin", "/bin"];
  return spawnSync("/bin/bash", [SCRIPT, ...args], {
    cwd: repo.dir,
    env: { PATH: pathDirs.join(":"), HOME: repo.dir, ...GIT_ENV } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("passes when wave 1 is in the history, nothing is unmerged and main CI is green", () => {
  const repo = makeRepo();
  try {
    const run = runGate(repo, ["--wave1", repo.wave1]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`Base SHA: ${git(repo.dir, "rev-parse", "HEAD")}`));
    assert.match(run.stdout, /pass {2}no unmerged paths/);
    assert.match(run.stdout, /pass {2}wave-1 integration commit/);
    assert.match(run.stdout, new RegExp(String.raw`pass {2}main CI is green for main at ${git(repo.dir, "rev-parse", "main").slice(0, 9)} \(3 checks\)`));
    assert.match(run.stdout, /Base gate: pass/);
  } finally {
    repo.cleanup();
  }
});

test("fails on a fixture repo with an unmerged path", () => {
  const repo = makeRepo();
  try {
    git(repo.dir, "checkout", "-q", "-b", "side", "HEAD~2");
    writeFileSync(path.join(repo.dir, "file.txt"), "side change\n");
    git(repo.dir, "commit", "-q", "-am", "side");
    git(repo.dir, "checkout", "-q", "main");
    writeFileSync(path.join(repo.dir, "file.txt"), "main change\n");
    git(repo.dir, "commit", "-q", "-am", "main");
    const merge = spawnSync("git", ["merge", "side"], { cwd: repo.dir, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
    assert.notEqual(merge.status, 0, "the fixture merge must conflict");
    assert.equal(git(repo.dir, "diff", "--name-only", "--diff-filter=U"), "file.txt");

    const run = runGate(repo, ["--wave1", repo.wave1]);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /FAIL {2}unmerged paths:/);
    assert.match(run.stdout, /^ +file\.txt$/m);
    assert.match(run.stdout, /Base gate: FAIL/);
  } finally {
    repo.cleanup();
  }
});

test("fails when the wave-1 commit is not an ancestor of HEAD", () => {
  const repo = makeRepo();
  try {
    git(repo.dir, "checkout", "-q", "-b", "stale", "HEAD~2");
    const run = runGate(repo, ["--wave1", repo.wave1]);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /FAIL {2}none of the wave-1 commits/);
  } finally {
    repo.cleanup();
  }
});

test("fails when the wave-1 commit is not in the clone at all", () => {
  const repo = makeRepo();
  try {
    const run = runGate(repo, ["--wave1", "244366124"]);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /FAIL {2}none of the wave-1 commits \(244366124\)/);
  } finally {
    repo.cleanup();
  }
});

for (const [mode, message] of [
  ["red", /FAIL {2}main CI is not green .*\n +iOS app: failure/],
  ["pending", /FAIL {2}main CI is not green .*\n +test: in_progress/],
  ["status-pending", /combined commit status: pending/],
  ["empty", /FAIL {2}main CI has no check runs/],
  ["error", /FAIL {2}main CI could not be read from GitHub/],
] as const) {
  test(`fails when main CI is ${mode}`, () => {
    const repo = makeRepo();
    try {
      const run = runGate(repo, ["--wave1", repo.wave1], { gh: mode });
      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stdout, message);
    } finally {
      repo.cleanup();
    }
  });
}

test("fails closed when the GitHub CLI is not installed", () => {
  const repo = makeRepo();
  try {
    const run = runGate(repo, ["--wave1", repo.wave1], { gh: null });
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /main CI could not be read: the GitHub CLI \(gh\) is not installed/);
  } finally {
    repo.cleanup();
  }
});

test("passes on this repository's wave-1 base (CI faked green)", (t) => {
  const present = spawnSync("git", ["cat-file", "-e", "244366124^{commit}"], { cwd: ROOT });
  if (present.status !== 0) {
    t.skip("this clone does not have commit 244366124 (shallow checkout)");
    return;
  }
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", "244366124", "HEAD"], { cwd: ROOT });
  if (ancestor.status !== 0) {
    t.skip("HEAD is not based on wave 1 in this clone");
    return;
  }
  const unmerged = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (unmerged) {
    t.skip("the working tree has unmerged paths right now");
    return;
  }
  if (spawnSync("git", ["merge-base", "--is-ancestor", "main", "HEAD"], { cwd: ROOT }).status !== 0) {
    t.skip("the existing package branch must be updated onto main first");
    return;
  }
  const bin = mkdtempSync(path.join(tmpdir(), "alevr-qa-gh-"));
  try {
    fakeGh(bin, "green");
    const run = spawnSync("bash", [SCRIPT, "--repo", ROOT], {
      cwd: ROOT,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /pass {2}wave-1 integration commit 244366124 is an ancestor of HEAD/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("fails when the checked main commit is newer than this package's base", () => {
  const repo = makeRepo();
  try {
    git(repo.dir, "checkout", "-q", "-b", "package");
    git(repo.dir, "checkout", "-q", "main");
    writeFileSync(path.join(repo.dir, "new-main.txt"), "new main");
    git(repo.dir, "add", ".");
    git(repo.dir, "commit", "-q", "-m", "advance main");
    git(repo.dir, "checkout", "-q", "package");
    const run = runGate(repo, ["--wave1", repo.wave1]);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /HEAD does not include main/);
  } finally { repo.cleanup(); }
});

test("the owner-excluded Vercel check cannot block an otherwise green Actions base", () => {
  const repo = makeRepo();
  try {
    const run = runGate(repo, ["--wave1", repo.wave1], { gh: "vercel-red" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /main CI is green/);
  } finally { repo.cleanup(); }
});


test("checks the verified remote SHA even when local main is stale", () => {
  const repo = makeRepo();
  try {
    git(repo.dir, "checkout", "-q", "-b", "package");
    writeFileSync(path.join(repo.dir, "remote-main.txt"), "remote main\n");
    git(repo.dir, "add", ".");
    git(repo.dir, "commit", "-q", "-m", "remote main advanced");
    const remoteHead = git(repo.dir, "rev-parse", "HEAD");
    fakeGh(repo.bin, "green", remoteHead);
    const run = spawnSync("bash", [SCRIPT, "--wave1", repo.wave1], {
      cwd: repo.dir,
      env: { PATH: `${repo.bin}:/usr/bin:/bin`, HOME: repo.dir, NODE_ENV: "test", ...GIT_ENV },
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`main CI is green for main at ${remoteHead.slice(0, 9)}`));
  } finally { repo.cleanup(); }
});
