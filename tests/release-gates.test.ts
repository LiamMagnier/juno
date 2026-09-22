import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY_WORKFLOW = readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
const PRODUCTION_SMOKE = readFileSync(new URL("../scripts/production-smoke.mjs", import.meta.url), "utf8");
const DEPLOY_SCRIPT = readFileSync(new URL("../deploy/deploy.sh", import.meta.url), "utf8");
const MAC_DEPLOY_SCRIPT = readFileSync(new URL("../deploy/deploy-from-mac.sh", import.meta.url), "utf8");

function sectionAfter(source: string, marker: string, nextMarker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing expected section: ${marker}`);
  const end = source.indexOf(nextMarker, start + marker.length);
  return source.slice(start, end === -1 ? undefined : end);
}

function withoutCommentLines(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const deployJobStart = DEPLOY_WORKFLOW.indexOf("\n  build-and-deploy:\n");
assert.notEqual(deployJobStart, -1, "deploy workflow is missing the build-and-deploy job");
const DEPLOY_JOB = DEPLOY_WORKFLOW.slice(deployJobStart);
const RELEASE_PREFLIGHT = sectionAfter(
  DEPLOY_JOB,
  "      - name: Validate production release inputs before building or shipping\n",
  "\n      - name: Install dependencies",
);
const SMOKE_STEP = sectionAfter(
  DEPLOY_JOB,
  "      - name: Run authenticated production smoke",
  "\n      - name: ",
);
const SMOKE_REMOTE_BLOCK = SMOKE_STEP.match(/<<['"]REMOTE['"]\n([\s\S]*?)\n\s+REMOTE\b/)?.[1] ?? "";

test("production release preflight requires one smoke credential", () => {
  const preflight = withoutCommentLines(RELEASE_PREFLIGHT);
  const credentialGuard = Array.from(preflight.matchAll(/(?:^|\n)\s*if\b[\s\S]*?\bfi\b/g)).find(([block]) => {
    const hasToken = /JUNO_SMOKE_TOKEN/.test(block);
    const hasCookie = /JUNO_SMOKE_COOKIE/.test(block);
    const rejectsMissingCredentials = /(?:missing\s*=\s*1|exit\s+1)/.test(block);
    const checksEitherCredential =
      /\|\|/.test(block) || /\|/.test(block) || (/-z/.test(block) && hasToken && hasCookie);
    return hasToken && hasCookie && checksEitherCredential && rejectsMissingCredentials;
  });

  assert.ok(credentialGuard, "the release preflight must require an authenticated smoke credential");
});

test("production release preflight requires an explicit browser origin allowlist", () => {
  assert.match(RELEASE_PREFLIGHT, /for name in DATABASE_URL DIRECT_URL AUTH_SECRET AUTH_URL NEXT_PUBLIC_APP_URL ALLOWED_ORIGINS;/);
});

test("production deploy is protected and pins the VM host key", () => {
  assert.match(DEPLOY_WORKFLOW, /permissions:\s*\n\s+contents:\s+read/);
  assert.match(DEPLOY_JOB, /environment:\s+Production/);
  assert.match(DEPLOY_JOB, /VM_KNOWN_HOSTS:/);
  assert.match(DEPLOY_JOB, /StrictHostKeyChecking=yes/);
  assert.match(DEPLOY_JOB, /UserKnownHostsFile=/);
  assert.doesNotMatch(DEPLOY_JOB, /StrictHostKeyChecking=accept-new/);
});

test("the canonical CI deploy uses the immutable VM transaction, not in-place rsync", () => {
  assert.match(DEPLOY_JOB, /Deploy the exact reviewed commit through the immutable VM transaction/);
  assert.match(DEPLOY_JOB, /git archive --format=tar/);
  assert.match(DEPLOY_JOB, /git get-tar-commit-id/);
  assert.match(DEPLOY_JOB, /sha256sum "\$archive"/);
  assert.match(DEPLOY_JOB, /actual_checksum=.*sha256sum/);
  assert.match(DEPLOY_JOB, /Package the reviewed CI build artifact/);
  assert.match(DEPLOY_JOB, /juno-\$\{GITHUB_SHA\}\.build\.tar\.gz/);
  assert.match(DEPLOY_JOB, /actual_build_checksum=.*sha256sum/);
  assert.match(DEPLOY_JOB, /JUNO_DEPLOY_ARCHIVE/);
  assert.match(DEPLOY_JOB, /JUNO_BUILD_ARTIFACT/);
  assert.match(DEPLOY_JOB, /JUNO_APP_HOME=/);
  assert.match(DEPLOY_JOB, /JUNO_INITIAL_RELEASE_TARGET=/);
  assert.match(DEPLOY_JOB, /JUNO_PERSISTENT_DATA_ROOT=/);
  assert.doesNotMatch(DEPLOY_JOB, /git bundle create/);
  for (const marker of [
    "Snapshot the current build for rollback",
    "Ship build to the VM",
    "Post-deploy on the VM (install-if-changed, migrate, reload)",
  ]) {
    const section = sectionAfter(DEPLOY_JOB, `      - name: ${marker}\n`, "\n      - name: ");
    assert.match(section, /if:\s*\$\{\{\s*false\s*\}\}/, `${marker} must remain disabled legacy code`);
  }
});

test("production deploy proves public reachability and attempts code rollback on failed checks", () => {
  assert.match(DEPLOY_JOB, /Verify public production health externally/);
  assert.match(DEPLOY_JOB, /JUNO_PUBLIC_UI_BASE_URL=\"\$PUBLIC_APP_URL\" node scripts\/public-ui-smoke\.mjs/);
  assert.match(DEPLOY_JOB, /Roll back failed application release/);
  assert.match(DEPLOY_JOB, /if: \$\{\{ failure\(\) && steps\.configure_ssh\.outcome ===? 'success' \}\}/);
  assert.match(DEPLOY_JOB, /database state was not rewound/);
});

test("production deploy handles a first-deploy environment without copying a missing file", () => {
  assert.match(DEPLOY_JOB, /INCOMING_ENV=.*\.env\.incoming-/);
  assert.match(DEPLOY_JOB, /install -m 600 "\$INCOMING_ENV" "\$LIVE_ROOT\/\.env"/);
});

test("production nginx changes fail closed and restore the prior configuration", () => {
  assert.match(DEPLOY_JOB, /nginx -t failed; restoring the previous site configuration and aborting the deploy/);
  assert.match(DEPLOY_JOB, /sudo cp \"\$NGINX_BACKUP\" \"\$NGINX_SITE\"/);
  assert.doesNotMatch(DEPLOY_JOB, /WARNING: nginx -t failed/);
});

test("deploy smoke passes authentication and public UI checks without an optional skip", () => {
  assert.notEqual(SMOKE_REMOTE_BLOCK, "", "production smoke step is missing its remote block");
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_REQUIRE_AUTH\s*=\s*1\b/);
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_TOKEN\s*=\s*"\$SMOKE_TOKEN"/);
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_COOKIE\s*=\s*"\$SMOKE_COOKIE"/);
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_MODEL\s*=\s*"\$SMOKE_MODEL"/);
  /*
   * The candidate list, and the two things about it that must not drift.
   *
   * It used to assert one exact id, because the gate was pinned to one model so
   * that a stale VM-only setting could not roll back a good release by naming
   * something unfunded. Then that model's key died, and the pin written to stop
   * an unfunded provider from reverting good code became a hardcoded name FOR
   * one: three healthy releases were reverted on somebody's billing. It is an
   * ordered list now (see the comment above the assignment, and
   * CREDENTIAL_FAILURE in production-smoke.mjs).
   *
   * What survives of the original intent, asserted rather than assumed:
   *   - a LITERAL, so the list still cannot come from the VM;
   *   - Qwen still first, because it is the account default, and a gate that
   *     stops exercising what most users get is not testing production.
   */
  assert.match(SMOKE_REMOTE_BLOCK, /^\s*SMOKE_MODEL="[^"$`]+"\s*$/m, "SMOKE_MODEL must be a literal set here, never read from the VM");
  assert.match(SMOKE_REMOTE_BLOCK, /^\s*SMOKE_MODEL="qwen:qwen3\.6-flash(?:,|")/m, "the account default must stay the first candidate");
  assert.match(SMOKE_REMOTE_BLOCK, /\bJUNO_SMOKE_RUN_CHAT\s*=\s*1\b/);
  // Against the CODE, as the preflight check above already does. Only a shell
  // construct can skip a smoke; prose about one cannot. Run over the raw block
  // this pattern is loose enough (`[\s\S]*` between every clause, case
  // insensitive) that a comment merely CONTAINING the word "skip" completed a
  // match whose other halves came from the unrelated token-mint `if`/`else`
  // above it — so documenting why a provider is skipped failed the assertion
  // that no provider may be skipped.
  assert.doesNotMatch(
    withoutCommentLines(SMOKE_REMOTE_BLOCK),
    /if[\s\S]*(?:TOKEN|COOKIE)[\s\S]*else[\s\S]*(?:skip|skipped|not configured)[\s\S]*fi/i,
    "authenticated production smoke must fail closed instead of skipping",
  );
  assert.match(SMOKE_REMOTE_BLOCK, /node ~\/juno\/current\/scripts\/production-smoke\.mjs/);
  assert.match(SMOKE_REMOTE_BLOCK, /node ~\/juno\/current\/scripts\/public-ui-smoke\.mjs/);
});

// Every assertion above this line passed while the smoke was completely broken,
// because they ask whether the block *contains* the right text. It did. What it
// did not do was run: a comment had been written between `JUNO_SMOKE_RUN_CHAT=1
// \` and the `node` it was prefixing, the backslash joined the comment onto the
// assignments, the `#` ended the command, and the variables were left as
// non-exported shell variables that an external `node` cannot see. Production
// smoke died on "JUNO_SMOKE_BASE_URL is required", the post-deploy check rolled
// the release back, and three deploys in a row were reverted while the workflow
// still read correctly to a human.
test("no line continuation in the deploy workflow is severed by a comment", () => {
  const lines = DEPLOY_WORKFLOW.split(/\r?\n/);
  const severed = lines.flatMap((line, index) =>
    /\\\s*$/.test(line) && /^\s*#/.test(lines[index + 1] ?? "")
      ? [`line ${index + 2}: ${lines[index + 1].trim()}`]
      : [],
  );
  assert.deepEqual(
    severed,
    [],
    `a comment after a "\\" continuation ends the command it was meant to document:\n${severed.join("\n")}`,
  );
});

test("the production smoke command receives its environment prefix", () => {
  const lines = SMOKE_REMOTE_BLOCK.split(/\r?\n/);
  for (const script of ["production-smoke.mjs", "public-ui-smoke.mjs"]) {
    // The line that RUNS it, not any line that mentions it. This matched on
    // `includes` until a comment in the block cited production-smoke.mjs by
    // name to explain the candidate list — whereupon the check read the prose
    // above that comment, found no backslash, and failed a workflow that was
    // perfectly correct. A guard a comment can break is a guard people learn
    // to route around, which is the opposite of what this one is for.
    const index = lines.findIndex((line) => new RegExp(`^\\s*node\\b.*${script.replace(".", "\\.")}`).test(line));
    assert.notEqual(index, -1, `smoke block no longer runs ${script}`);
    assert.match(
      lines[index - 1] ?? "",
      /\\\s*$/,
      `${script} must be the continuation of the assignments above it, not a separate command`,
    );
  }
});

test("authenticated production smoke rejects missing credentials and missing chat mode", () => {
  assert.match(PRODUCTION_SMOKE, /const requireAuth\s*=\s*process\.env\.JUNO_SMOKE_REQUIRE_AUTH\s*===\s*["']1["']/);
  assert.match(
    PRODUCTION_SMOKE,
    /if\s*\(\s*requireAuth\s*&&\s*!token\s*&&\s*!cookie\s*\)\s*\{[\s\S]*?throw new Error\([\s\S]*JUNO_SMOKE_TOKEN[\s\S]*JUNO_SMOKE_COOKIE/,
  );
  assert.match(
    PRODUCTION_SMOKE,
    /if\s*\(\s*requireAuth\s*&&\s*process\.env\.JUNO_SMOKE_RUN_CHAT\s*!==\s*["']1["']\s*\)\s*\{[\s\S]*?throw new Error\([\s\S]*JUNO_SMOKE_RUN_CHAT=1/,
  );
});

test("deploy job has no executable prisma db push or db execute fallback", () => {
  assert.doesNotMatch(
    withoutCommentLines(DEPLOY_JOB),
    /\b(?:npx\s+)?prisma\s+db\s+(?:push|execute)\b/i,
    "production deploys must use the controlled migration path, never db push/db execute",
  );
});

test("deploy script only applies committed Prisma migrations", () => {
  assert.match(DEPLOY_SCRIPT, /set -Eeuo pipefail/);
  assert.match(DEPLOY_SCRIPT, /reviewed_migrations_exist\(\)/);
  assert.match(DEPLOY_SCRIPT, /git -C \"\$APP_HOME\" ls-tree/);
  assert.match(DEPLOY_SCRIPT, /npx prisma migrate deploy/);
  assert.doesNotMatch(
    withoutCommentLines(DEPLOY_SCRIPT),
    /\b(?:npx\s+)?prisma\s+db\s+(?:push|execute)\b/i,
    "the standalone deploy script must fail closed instead of converging schema outside reviewed migrations",
  );
});

test("manual deployment requires a direct schema connection and never mutates the model registry", () => {
  assert.match(DEPLOY_SCRIPT, /for name in DATABASE_URL DIRECT_URL AUTH_SECRET AUTH_URL NEXT_PUBLIC_APP_URL ALLOWED_ORIGINS/);
  assert.match(DEPLOY_SCRIPT, /JUNO_APP_HOME/);
  assert.match(DEPLOY_SCRIPT, /verify_source_archive\(\)/);
  assert.match(DEPLOY_SCRIPT, /git get-tar-commit-id/);
  assert.match(DEPLOY_SCRIPT, /verify_build_artifact\(\)/);
  assert.match(DEPLOY_SCRIPT, /normalize_next_build_paths\(\)/);
  assert.match(DEPLOY_SCRIPT, /normalize_next_build_paths "\$STAGING_DIR" "\$RELEASE_DIR"/);
  assert.match(DEPLOY_SCRIPT, /runner\/agent-core\/dist\/index\.js/);
  assert.doesNotMatch(DEPLOY_SCRIPT, /sync:models:write/);
  assert.match(DEPLOY_SCRIPT, /JUNO_PERSISTENT_DATA_ROOT/);
  assert.match(DEPLOY_SCRIPT, /mkdir -p -- "\$PERSISTENT_DATA_ROOT\/\.uploads" "\$PERSISTENT_DATA_ROOT\/logs"/);
  assert.match(DEPLOY_SCRIPT, /ln -s -- "\$PERSISTENT_DATA_ROOT\/\.uploads" "\$STAGING_DIR\/\.uploads"/);
  assert.match(DEPLOY_SCRIPT, /ln -s -- "\$PERSISTENT_DATA_ROOT\/logs" "\$STAGING_DIR\/logs"/);
});

// Runs deploy.sh's own normalize_next_build_paths over a fake .next, so these
// tests exercise the shipped function rather than a description of it.
function normalizeNextBuild(buildRoot: string, files: Record<string, string>) {
  const releaseDir = mkdtempSync(path.join(tmpdir(), "juno-normalize-"));
  const runtimeRoot = "/home/deploy/juno/releases/0123456789ab-20260922000000-42";
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(releaseDir, ".next", name)), { recursive: true });
      writeFileSync(path.join(releaseDir, ".next", name), content);
    }
    const start = DEPLOY_SCRIPT.indexOf("normalize_next_build_paths() {");
    assert.notEqual(start, -1, "deploy.sh no longer defines normalize_next_build_paths");
    const harness = [
      "set -Eeuo pipefail",
      'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
      'require_command() { command -v "$1" >/dev/null; }',
      DEPLOY_SCRIPT.slice(start, DEPLOY_SCRIPT.indexOf("\n}\n", start) + 2),
      'BUILD_ROOT="$1"',
      'normalize_next_build_paths "$2" "$3"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", harness, "bash", buildRoot, releaseDir, runtimeRoot], { encoding: "utf8" });
    const after = Object.fromEntries(
      Object.keys(files).map((name) => [name, readFileSync(path.join(releaseDir, ".next", name), "utf8")]),
    );
    return { status: result.status, stderr: result.stderr, after, runtimeRoot };
  } finally {
    rmSync(releaseDir, { recursive: true, force: true });
  }
}

// The chunk that took the 08d62f80 release down: a user-agent regex and route
// names that merely start with "/app", beside one real build path.
function serverChunk(root: string): string {
  return [
    String.raw`var ua=[/\((ipad);[-\w\),; ]+apple/i,/\/applecoremedia\/[\w\.]+ \((ipad)/i];`,
    `var routes=["/app-auth","/apple-icon.png","/api/v1/billing/app-store"];`,
    `var appDir="${root}/src/app";`,
  ].join("\n");
}

test("a build root that is also part of other names is refused before anything is rewritten", () => {
  const original = serverChunk("/app");
  const { status, stderr, after } = normalizeNextBuild("/app", { "server/chunks/6423.js": original });
  assert.notEqual(status, 0, "rewriting /app would corrupt the regex and the route names");
  assert.match(stderr, /part of longer names/);
  assert.equal(after["server/chunks/6423.js"], original, "nothing may be rewritten once a collision is found");
});

test("the Mac deploy builds in a root the rewrite can use, and hands deploy.sh that same root", () => {
  const buildRoot = MAC_DEPLOY_SCRIPT.match(/^BUILD_ROOT="([^"]+)"$/m)?.[1];
  assert.ok(buildRoot, "deploy-from-mac.sh must name its build root in one place");
  assert.match(MAC_DEPLOY_SCRIPT, /-e BUILD_ROOT="\$BUILD_ROOT"/);
  assert.match(MAC_DEPLOY_SCRIPT, /cd "\$BUILD_ROOT"/);
  assert.match(MAC_DEPLOY_SCRIPT, /JUNO_BUILD_ROOT='\$BUILD_ROOT'/);

  const { status, stderr, after, runtimeRoot } = normalizeNextBuild(buildRoot, {
    "server/chunks/6423.js": serverChunk(buildRoot),
  });
  assert.equal(status, 0, stderr);
  assert.equal(after["server/chunks/6423.js"], serverChunk(runtimeRoot), "only the real build path may change");
});

// Both callers used to run their own inline VM preflight before uploading, and
// took no lock to do it. Beside a deploy in flight it deleted that deploy's
// uploaded archive and build artifact (the deploy then failed its checksum or
// tar step) and its staged release, and the upload after it overwrote files
// named for the same commit. It is one script now, deploy/vm-preflight.sh, and
// these tests run it the way the callers do: piped to `bash -s`.
const VM_PREFLIGHT = readFileSync(new URL("../deploy/vm-preflight.sh", import.meta.url), "utf8");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "mac-20260922120000-Ab3dE9";

// The VM and CI have util-linux flock; a Mac does not. The stand-in takes the
// same flock(2) lock on the same inherited descriptor, so the lock outlives it
// exactly as the real one's does, and two runs contend for real.
const HAS_SYSTEM_FLOCK = spawnSync("sh", ["-c", "command -v flock"]).status === 0;
const FLOCK_STAND_IN = [
  "#!/bin/sh",
  '[ "$#" -eq 2 ] && [ "$1" = -n ] || { echo "flock stand-in: only flock -n FD" >&2; exit 64; }',
  `exec perl -MFcntl=:flock -e 'open(my $fh, ">&=", $ARGV[0]) or die "flock: $!\\n"; flock($fh, LOCK_EX | LOCK_NB) or exit 1' "$2"`,
  "",
].join("\n");

// A VM in the middle of other runs' deploys, under a temporary root: HOME with
// ~/juno as the callers leave it, and an upload root standing in for /tmp.
function fakeVm() {
  const root = mkdtempSync(path.join(tmpdir(), "juno-vm-"));
  const home = path.join(root, "home");
  const live = path.join(home, "juno");
  const releases = path.join(live, "releases");
  const uploads = path.join(root, "tmp");
  const bin = path.join(root, "bin");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const age = (file: string) => utimesSync(file, twoHoursAgo, twoHoursAgo);
  const put = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "x");
    return file;
  };

  // A staged release belongs to a transaction in flight; one release is older
  // than both current and previous.
  for (const release of ["101-older", "202-previous", "303-current", ".staging-404"]) {
    put(path.join(releases, release, "package.json"));
  }
  symlinkSync(path.join(releases, "303-current"), path.join(live, "current"));
  symlinkSync(path.join(releases, "202-previous"), path.join(live, "previous"));
  writeFileSync(path.join(live, ".deploy.lock"), "");

  // Another run's upload: its archive went up over an hour ago, and its build
  // artifact is still being written.
  const uploading = path.join(uploads, "juno-upload-17811234567-1");
  age(put(path.join(uploading, `juno-${COMMIT}.tar.gz`)));
  put(path.join(uploading, `juno-${COMMIT}.build.tar.gz`));
  age(uploading);
  // A run cut off two hours ago.
  const abandoned = path.join(uploads, "juno-upload-mac-20260922100000-Qx7Lm2");
  age(put(path.join(abandoned, `juno-${COMMIT}.tar.gz`)));
  age(abandoned);
  // Uploads under the old per-commit names, as an older copy of a caller still
  // writes them: three long abandoned, one still arriving.
  for (const name of [`juno-${COMMIT}.tar.gz`, `juno-${COMMIT}.tar.gz.sha256`, "juno-17811234567.env"]) {
    age(put(path.join(uploads, name)));
  }
  put(path.join(uploads, "juno-fedcba9876543210fedcba9876543210fedcba98.build.tar.gz"));
  // Not uploads at all.
  age(put(path.join(uploads, "juno-nodesource-24.sh")));
  age(put(path.join(uploads, "backup.tar.gz")));

  mkdirSync(bin);
  if (!HAS_SYSTEM_FLOCK) {
    writeFileSync(path.join(bin, "flock"), FLOCK_STAND_IN);
    chmodSync(path.join(bin, "flock"), 0o755);
  }
  return {
    root,
    live,
    releases,
    uploads,
    lock: path.join(live, ".deploy.lock"),
    uploadDir: path.join(uploads, `juno-upload-${RUN_ID}`),
    env: {
      ...process.env,
      HOME: home,
      UPLOAD_DIR: path.join(uploads, `juno-upload-${RUN_ID}`),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    },
  };
}

function listTree(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" }).sort();
}

test("the VM preflight changes nothing while a deploy holds the lock, and says who holds it", () => {
  const vm = fakeVm();
  // Only what the preflight may clean or create: tools the test runs can leave
  // caches elsewhere under HOME (Rosetta does, under emulation).
  const state = () => ({ live: listTree(vm.live), uploads: listTree(vm.uploads) });
  try {
    const before = state();
    // A release transaction holding the host's deploy lock as deploy.sh holds
    // it: on a descriptor opened for append, with a note of who it is. The
    // preflight then runs as a process of its own, as the callers run it.
    const holdTheLockThenPreflight = [
      'exec 8>>"$1"',
      "flock -n 8 || exit 97",
      `printf 'pid %s since %s\\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$1"`,
      'echo "$$"',
      "bash -s 8>&-",
    ].join("\n");
    const run = spawnSync("bash", ["-c", holdTheLockThenPreflight, "bash", vm.lock], {
      encoding: "utf8",
      input: VM_PREFLIGHT,
      env: vm.env,
    });
    const holder = run.stdout.split("\n")[0];
    assert.match(holder, /^\d+$/, `the stand-in deploy could not take the lock:\n${run.stderr}`);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stderr,
      new RegExp(
        String.raw`^Another deployment is already running \(pid ${holder} since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\): ` +
          vm.lock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "\n$",
      ),
    );
    assert.deepEqual(
      state(),
      before,
      "no staged or older release and no upload may be removed, and no upload directory created",
    );
    assert.match(readFileSync(vm.lock, "utf8"), new RegExp(`^pid ${holder} since `), "a refused run must leave the holder's note");
  } finally {
    rmSync(vm.root, { recursive: true, force: true });
  }
});

test("with the lock free, the VM preflight clears only what no deploy can still need, then claims the run's upload directory", () => {
  const vm = fakeVm();
  try {
    const preflight = () => spawnSync("bash", ["-s"], { encoding: "utf8", input: VM_PREFLIGHT, env: vm.env });
    const run = preflight();
    assert.equal(run.status, 0, run.stdout + run.stderr);

    assert.deepEqual(readdirSync(vm.releases).sort(), ["202-previous", "303-current"]);
    assert.deepEqual(
      readdirSync(vm.uploads).sort(),
      [
        "backup.tar.gz",
        "juno-fedcba9876543210fedcba9876543210fedcba98.build.tar.gz",
        "juno-nodesource-24.sh",
        "juno-upload-17811234567-1",
        `juno-upload-${RUN_ID}`,
      ].sort(),
      "abandoned uploads go; uploads still being written, and files that are not uploads, stay",
    );
    assert.deepEqual(
      readdirSync(path.join(vm.uploads, "juno-upload-17811234567-1")).sort(),
      [`juno-${COMMIT}.build.tar.gz`, `juno-${COMMIT}.tar.gz`],
      "an upload in progress stays whole, however long ago it began",
    );
    assert.deepEqual(readdirSync(vm.uploadDir), []);
    assert.equal(statSync(vm.uploadDir).mode & 0o777, 0o700, "the upload holds the production env");
    assert.match(
      readFileSync(vm.lock, "utf8"),
      new RegExp(String.raw`^pid \d+ since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ, preflight of run ${RUN_ID}\n$`),
      "while it holds the lock, a refused deploy must be able to say the preflight holds it",
    );
    const next = spawnSync("bash", ["-c", 'exec 9>>"$1" && flock -n 9', "bash", vm.lock], { env: vm.env });
    assert.equal(next.status, 0, "the lock must be free again once the preflight has finished");

    // The directory is taken now, as it is for a run whose upload is in flight.
    const again = preflight();
    assert.equal(again.status, 1, again.stdout + again.stderr);
    assert.match(again.stderr, new RegExp(`already exists: run id ${RUN_ID} is another run's`));
    assert.ok(statSync(vm.uploadDir).isDirectory(), "a directory the preflight did not create is never removed");
  } finally {
    rmSync(vm.root, { recursive: true, force: true });
  }
});

const CI_DEPLOY_STEP = sectionAfter(
  DEPLOY_JOB,
  "      - name: Deploy the exact reviewed commit through the immutable VM transaction\n",
  "\n      - name: ",
);

test("both callers upload only after that preflight, only into the directory it created, and remove only that", () => {
  const callers = [
    { caller: "deploy-from-mac.sh", code: withoutCommentLines(MAC_DEPLOY_SCRIPT), dir: "UPLOAD_DIR", runId: "$RUN_ID" },
    { caller: "deploy.yml", code: withoutCommentLines(CI_DEPLOY_STEP), dir: "upload_dir", runId: "${RUN_ID}" },
  ];
  for (const { caller, code, dir, runId } of callers) {
    assert.ok(code.includes(`${dir}="/tmp/juno-upload-${runId}"`), `${caller}: the upload directory is named for the run`);
    const preflight = code.indexOf(`"UPLOAD_DIR='$${dir}' bash -s" < deploy/vm-preflight.sh`);
    const upload = code.indexOf(`:$${dir}/"`);
    const transaction = code.search(new RegExp(String.raw`UPLOAD_DIR='\$${dir}'[^\n]*bash -s" <<'REMOTE'\n`));
    assert.notEqual(preflight, -1, `${caller} must run deploy/vm-preflight.sh on the VM, for its own upload directory`);
    assert.ok(
      preflight < upload && upload < transaction,
      `${caller}: the preflight, then the upload into its directory, then the transaction given that directory`,
    );
    assert.doesNotMatch(code, /<<'PREFLIGHT'|\/tmp\/juno-\*/, `${caller} must not keep a preflight of its own`);

    const remote = code.slice(transaction).match(/<<'REMOTE'\n([\s\S]*?)\n[ \t]*REMOTE\n/)?.[1] ?? "";
    assert.notEqual(remote, "", `${caller}: the release transaction block is missing`);
    for (const file of ["ARCHIVE", "BUILD_ARTIFACT"]) {
      assert.match(remote, new RegExp(String.raw`^\s*${file}="\$UPLOAD_DIR/juno-`, "m"), `${caller}: ${file}`);
    }
    assert.doesNotMatch(remote, /\/tmp\/juno-\$/, `${caller}: no upload is named for the commit any more`);
    assert.match(remote, /\bcleanup\(\) \{\n\s*rm -rf -- "\$UPLOAD_DIR"\n/, `${caller}: the transaction removes its own upload`);
    // deploy.sh locks .deploy.lock beside `current`: the lock the preflight takes.
    assert.match(remote, /^\s*LIVE_ROOT="\$HOME\/juno"$/m, caller);
    assert.match(remote, /JUNO_CURRENT_LINK="\$LIVE_ROOT\/current"/, caller);
  }

  // A run id is claimed by creating its directory, so each run needs one of its own.
  assert.match(CI_DEPLOY_STEP, /RUN_ID: \$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(MAC_DEPLOY_SCRIPT, /^RUN_ID="mac-\$\(date \+%Y%m%d%H%M%S\)-\$\{WORK##\*\.\}"$/m);
  // The Mac script removes a failed or interrupted upload itself, but must let
  // go of it before the transaction starts reading it.
  const mac = withoutCommentLines(MAC_DEPLOY_SCRIPT);
  const owned = mac.indexOf('VM_UPLOAD_OWNED="$UPLOAD_DIR"');
  const released = mac.indexOf("VM_UPLOAD_OWNED=''", owned);
  assert.ok(owned > mac.indexOf("< deploy/vm-preflight.sh"), "only once the preflight has created it");
  assert.ok(released !== -1 && released < mac.indexOf("<<'REMOTE'"), "never while the transaction may be reading it");
});

test("deploy script builds before atomic activation and has an application rollback path", () => {
  const archive = DEPLOY_SCRIPT.indexOf('git -C "$APP_HOME" archive');
  const migrate = DEPLOY_SCRIPT.indexOf('run_in_release "$STAGING_DIR" npx prisma migrate deploy');
  const materialize = DEPLOY_SCRIPT.indexOf('mv -- "$STAGING_DIR" "$RELEASE_DIR"');
  const switchCurrent = DEPLOY_SCRIPT.indexOf('atomic_symlink "$RELEASE_DIR" "$CURRENT_LINK"');
  const activate = DEPLOY_SCRIPT.indexOf('reload_release "$RELEASE_DIR" "$TARGET_SHA"');

  assert.ok(archive >= 0, "the target commit must be archived into a candidate release");
  assert.ok(archive < migrate, "migrations must run from the candidate release");
  assert.ok(migrate < materialize, "the candidate must pass migrations before publication");
  assert.ok(materialize < switchCurrent, "the built candidate must be finalized before current changes");
  assert.ok(switchCurrent < activate, "PM2 must activate only after the current pointer is switched");
  assert.match(DEPLOY_SCRIPT, /atomic_symlink\(\)/);
  assert.match(DEPLOY_SCRIPT, /mv -Tf -- \"\$temporary\" \"\$pointer\"/);
  assert.match(DEPLOY_SCRIPT, /ROLLBACK_NEEDED=1/);
  assert.match(DEPLOY_SCRIPT, /rollback_release\(\)/);
  assert.match(DEPLOY_SCRIPT, /restore_pointer \"\$CURRENT_LINK\"/);
  assert.match(DEPLOY_SCRIPT, /trap on_exit EXIT/);
});

// deploy.sh without its closing `main "$@"`. Sourcing this defines every
// function and resolves the configuration exactly as a deploy does, without
// running one, so the tests below exercise the shipped code rather than a copy.
const DEPLOY_LIBRARY = (() => {
  const entry = '\nmain "$@"\n';
  assert.ok(DEPLOY_SCRIPT.endsWith(entry), "deploy.sh must end by calling main");
  return DEPLOY_SCRIPT.slice(0, DEPLOY_SCRIPT.length - entry.length + 1);
})();

const DEPLOY_SCRIPT_PATH = fileURLToPath(new URL("../deploy/deploy.sh", import.meta.url));
const PRODUCTION_ECOSYSTEM = fileURLToPath(new URL("../deploy/ecosystem.config.js", import.meta.url));
const PM2_SERVICE_STARTER_PATH = fileURLToPath(new URL("../scripts/reconcile-pm2-service.mjs", import.meta.url));
const FAKE_PM2 = fileURLToPath(new URL("./fixtures/fake-pm2.mjs", import.meta.url));

// The runner's own environment, minus anything that would configure deploy.sh.
function deployEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("JUNO_") && name !== "GIT_SHA");
  // Next declares NODE_ENV as a required key of ProcessEnv, which a filtered
  // copy of the runner's environment cannot promise statically.
  return { ...Object.fromEntries(inherited), ...overrides } as NodeJS.ProcessEnv;
}

// Runs `commands` in bash after sourcing DEPLOY_LIBRARY, with `args` as $1...
function runDeployLibrary(directory: string, commands: string, env: Record<string, string>, args: string[] = []) {
  const library = path.join(directory, "deploy.sh");
  writeFileSync(library, DEPLOY_LIBRARY);
  return spawnSync("bash", ["-c", `source "$0"\n${commands}`, library, ...args], {
    encoding: "utf8",
    env: deployEnvironment(env),
  });
}

type Pm2App = { name: string; status: string };

// Runs deploy.sh's reload_release against tests/fixtures/fake-pm2.mjs, for a
// release whose ecosystem declares `ecosystem` (app names, or a config's raw
// source), and returns what PM2 was asked to do and what it ended up running.
function reloadRelease(options: {
  ecosystem: string[] | string;
  running: Pm2App[];
  failToStart?: string[];
  failToDelete?: string[];
  asRollback?: boolean;
}) {
  const root = mkdtempSync(path.join(tmpdir(), "juno-reload-"));
  try {
    const bin = path.join(root, "bin");
    const release = path.join(root, "release");
    const stateFile = path.join(root, "pm2.json");
    mkdirSync(bin);
    mkdirSync(path.join(release, "deploy"), { recursive: true });
    writeFileSync(path.join(bin, "pm2"), `#!/bin/sh\nexec node "${FAKE_PM2}" "$@"\n`);
    // verify_pm2_ecosystem polls with `sleep 3`; the fake PM2 has nothing to wait for.
    writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "pm2"), 0o755);
    chmodSync(path.join(bin, "sleep"), 0o755);
    writeFileSync(
      path.join(release, "deploy", "ecosystem.config.js"),
      typeof options.ecosystem === "string"
        ? options.ecosystem
        : `module.exports = ${JSON.stringify({ apps: options.ecosystem.map((name) => ({ name, script: "server.js" })) })};\n`,
    );
    writeFileSync(
      stateFile,
      JSON.stringify({
        running: options.running,
        dump: null,
        calls: [],
        failToStart: options.failToStart ?? [],
        failToDelete: options.failToDelete ?? [],
      }),
    );
    // rollback_release calls reload_release on the left of `||`, so bash
    // ignores errexit for everything the function runs.
    const reload = options.asRollback ? 'reload_release "$1" "$2" || exit "$?"' : 'reload_release "$1" "$2"';
    const result = runDeployLibrary(
      root,
      reload,
      {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FAKE_PM2_STATE: stateFile,
        JUNO_PM2_SERVICE_STARTER: PM2_SERVICE_STARTER_PATH,
      },
      [release, "0123456789abcdef0123456789abcdef01234567"],
    );
    const pm2 = JSON.parse(readFileSync(stateFile, "utf8")) as { running: Pm2App[]; dump: string[] | null; calls: string[] };
    return { ...pm2, status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("production activation verifies every PM2 service, including workers and the relay", () => {
  // What deploy.sh reads out of the shipped ecosystem is the list it verifies,
  // repairs and keeps; a juno app missing from it is deleted by the next deploy.
  const directory = mkdtempSync(path.join(tmpdir(), "juno-ecosystem-"));
  try {
    const result = runDeployLibrary(directory, 'declared_pm2_apps "$1"', {}, [PRODUCTION_ECOSYSTEM]);
    assert.equal(result.status, 0, result.stderr);
    const declared = JSON.parse(result.stdout) as string[];
    for (const name of [
      "juno-backend",
      "juno-work",
      "juno-work-scheduler",
      "juno-research",
      "juno-work-triggers",
      "juno-memory-dreamer",
      "juno-import-recovery",
      "juno-code-sweeper",
      "juno-voice-relay",
    ]) {
      assert.ok(declared.includes(name), `the ecosystem no longer declares ${name}, so the next deploy would delete it`);
    }
    assert.equal(new Set(declared).size, declared.length, "every app needs a name of its own");
    for (const name of declared) {
      assert.match(name, /^juno-/, `${name} is outside the juno- namespace: a release that drops it would leave it running`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("activation repairs a service PM2 failed to start from a one-service ecosystem, and saves it", () => {
  const run = reloadRelease({
    ecosystem: ["juno-backend", "juno-work", "juno-voice-relay"],
    running: [{ name: "juno-backend", status: "online" }],
    // `startOrReload` throws on a stale PM2 slot before it creates juno-work.
    failToStart: ["juno-work"],
  });
  assert.equal(run.status, 0, run.output);
  assert.ok(
    run.calls.includes("startOrReload ecosystem.config.js(juno-backend,juno-work,juno-voice-relay) --update-env"),
    run.calls.join("\n"),
  );
  const repair = run.calls.indexOf("start ecosystem.config.cjs(juno-work) --update-env");
  assert.ok(repair !== -1, `juno-work must be started from a one-service ecosystem:\n${run.calls.join("\n")}`);
  assert.ok(repair < run.calls.indexOf("save"), "the repaired service must be saved");
  assert.deepEqual([...(run.dump ?? [])].sort(), ["juno-backend", "juno-voice-relay", "juno-work"]);
  assert.match(run.stdout, /PM2 ecosystem healthy: juno-backend, juno-work, juno-voice-relay\n/);
});

test("apps only a rolled-back release declared are deleted before PM2 saves, not repaired onto the older code", () => {
  // 2026-09-22: rolling back to c3004795 reloaded its ecosystem, which does not
  // declare juno-memory-dreamer, and the failed release's dreamer went on
  // crash-looping against the older code. A deploy that drops an app (as the
  // one that retired juno-scheduler did) must end the same way.
  for (const asRollback of [true, false]) {
    const context = asRollback ? "rollback" : "deploy";
    const run = reloadRelease({
      ecosystem: ["juno-backend", "juno-work", "juno-voice-relay"],
      running: [
        { name: "juno-backend", status: "online" },
        { name: "juno-work", status: "online" },
        { name: "juno-voice-relay", status: "online" },
        { name: "juno-memory-dreamer", status: "errored" },
        { name: "pm2-logrotate", status: "online" },
      ],
      asRollback,
    });
    assert.equal(run.status, 0, `${context}: ${run.output}`);
    const kept = ["juno-backend", "juno-voice-relay", "juno-work", "pm2-logrotate"];
    assert.deepEqual(run.running.map((app) => app.name).sort(), kept, context);
    assert.deepEqual([...(run.dump ?? [])].sort(), kept, `${context}: a reboot must not resurrect it either`);
    assert.deepEqual(
      run.calls.filter((call) => call.includes("juno-memory-dreamer")),
      ["delete juno-memory-dreamer"],
      `${context}: deleted, never restarted or "repaired"`,
    );
    assert.ok(run.calls.indexOf("delete juno-memory-dreamer") < run.calls.indexOf("save"), `${context}: deleted before PM2 saves`);
    assert.ok(!run.calls.some((call) => call.includes("pm2-logrotate")), `${context}: apps outside the juno- namespace are left alone`);
    assert.match(run.stdout, /PM2 ecosystem healthy: juno-backend, juno-work, juno-voice-relay\n/, context);
  }
});

test("an ecosystem deploy.sh cannot read fails the reload before PM2 is touched", () => {
  const running = [
    { name: "juno-backend", status: "online" },
    { name: "juno-voice-relay", status: "online" },
  ];
  for (const ecosystem of [
    'throw new Error("a half-written release");\n',
    "module.exports = { apps: [] };\n",
    'module.exports = { apps: [{ script: "server.js" }] };\n',
  ]) {
    // As a rollback runs it, with errexit off: an unread list must not pass
    // for "declares nothing" and retire every juno app on the box.
    const run = reloadRelease({ ecosystem, running, asRollback: true });
    assert.notEqual(run.status, 0, `${ecosystem} must fail the reload`);
    assert.deepEqual(run.calls, [], `${ecosystem}: PM2 must not be asked to do anything`);
    assert.deepEqual(run.running, running);
  }
});

test("an undeclared juno app PM2 will not delete fails the reload", () => {
  const run = reloadRelease({
    ecosystem: ["juno-backend", "juno-voice-relay"],
    running: [
      { name: "juno-backend", status: "online" },
      { name: "juno-voice-relay", status: "online" },
      { name: "juno-memory-dreamer", status: "errored" },
    ],
    failToDelete: ["juno-memory-dreamer"],
    asRollback: true,
  });
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.stderr, /Could not retire undeclared PM2 apps: still running: juno-memory-dreamer/);
});

test("every deploy and rollback on a host takes the same lock, whichever stage runs deploy.sh", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "juno-lock-path-"));
  try {
    const live = "/home/deploy/juno";
    const lockFor = (env: Record<string, string>) => runDeployLibrary(directory, 'printf "%s" "$LOCK_FILE"', env).stdout;
    // Both callers deploy from a per-run source stage and roll back from `current`.
    const appHomes: Record<string, string> = {
      "a CI deploy": "/home/deploy/.juno-source-17811234567",
      "a Mac deploy": "/home/deploy/.juno-source-mac-20260922120000",
      "a rollback": `${live}/current`,
    };
    for (const [caller, appHome] of Object.entries(appHomes)) {
      assert.equal(lockFor({ JUNO_APP_HOME: appHome, JUNO_CURRENT_LINK: `${live}/current` }), `${live}/.deploy.lock`, caller);
    }
    // A checkout that is itself the live root still locks where it always did.
    assert.equal(lockFor({ JUNO_APP_HOME: live }), `${live}/.deploy.lock`);
    for (const caller of [DEPLOY_WORKFLOW, MAC_DEPLOY_SCRIPT]) {
      assert.doesNotMatch(caller, /JUNO_DEPLOY_LOCK/, "a per-caller lock path is how every deploy came to lock its own file");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const HAS_FLOCK = spawnSync("sh", ["-c", "command -v flock"]).status === 0;

test(
  "a second deploy or a rollback is refused while a deploy holds the lock, and told who holds it",
  { skip: !HAS_FLOCK && "flock is not installed here (the VM and CI both have it)" },
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "juno-lock-"));
    try {
      // The host as the callers leave it: a live root whose `current` points
      // at a release, and a source stage per run.
      const live = path.join(directory, "juno");
      const bin = path.join(directory, "bin");
      mkdirSync(path.join(live, "releases", "0123456789ab-20260922000000-42"), { recursive: true });
      symlinkSync(path.join("releases", "0123456789ab-20260922000000-42"), path.join(live, "current"));
      for (const run of [1, 2, 3]) mkdirSync(path.join(directory, `.juno-source-${run}`));
      mkdirSync(bin);
      // main() checks for pm2 before it reaches the lock.
      writeFileSync(path.join(bin, "pm2"), "#!/bin/sh\nexit 0\n");
      chmodSync(path.join(bin, "pm2"), 0o755);
      const library = path.join(directory, "deploy.sh");
      writeFileSync(library, DEPLOY_LIBRARY);
      const env = (appHome: string) =>
        deployEnvironment({
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          JUNO_APP_HOME: appHome,
          JUNO_CURRENT_LINK: path.join(live, "current"),
          // Were the lock not taken, a deploy would stop here instead.
          JUNO_ENV_FILE: path.join(directory, "missing.env"),
        });
      const takeLock = 'source "$0"\numask 077\nacquire_deploy_lock\necho locked\nread -r _ || true';

      // The first deploy, running from its own source stage, holds the lock
      // until its stdin closes.
      const holder = spawn("bash", ["-c", takeLock, library], { env: env(path.join(directory, ".juno-source-1")) });
      try {
        await Promise.race([
          once(holder.stdout, "data"),
          once(holder, "exit").then(() => {
            throw new Error("the first deploy could not take the lock");
          }),
        ]);
        const refusal = new RegExp(
          String.raw`Another deployment is already running \(pid ${holder.pid} since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\): ` +
            path.join(live, ".deploy.lock").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        );
        const contenders: [string, string[], string][] = [
          ["a second deploy", [], path.join(directory, ".juno-source-2")],
          ["a rollback", ["--rollback"], path.join(live, "current")],
        ];
        for (const [contender, args, appHome] of contenders) {
          const result = spawnSync("bash", [DEPLOY_SCRIPT_PATH, ...args], { encoding: "utf8", env: env(appHome) });
          assert.notEqual(result.status, 0, contender);
          assert.match(result.stderr, refusal, `${contender}:\n${result.stderr}`);
        }
      } finally {
        holder.stdin.end();
        if (holder.exitCode === null && holder.signalCode === null) await once(holder, "exit");
      }

      // Released with its holder: the next deploy takes it.
      const next = spawnSync("bash", ["-c", takeLock, library], {
        encoding: "utf8",
        env: env(path.join(directory, ".juno-source-3")),
        input: "",
      });
      assert.equal(next.status, 0, next.stderr);
      assert.equal(next.stdout, "locked\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("external release failures use the same verified rollback transaction", () => {
  const rollbackStep = DEPLOY_JOB.slice(DEPLOY_JOB.indexOf("      - name: Roll back failed application release"));
  assert.match(rollbackStep, /bash "\$DEPLOY_SCRIPT" --rollback/);
  assert.match(rollbackStep, /CURRENT_SHA.*GITHUB_SHA/);
  assert.doesNotMatch(rollbackStep, /juno-previous/);
});

test("deploy script does not pull or rewrite the live checkout", () => {
  assert.doesNotMatch(DEPLOY_SCRIPT, /git checkout|git pull/);
  assert.match(DEPLOY_SCRIPT, /git -C \"\$APP_HOME\" fetch --prune origin main/);
  assert.match(DEPLOY_SCRIPT, /git -C \"\$APP_HOME\" diff --quiet/);
});

test("deploy validates the voice relay before shipping it", () => {
  assert.match(DEPLOY_JOB, /npm test --prefix relay/);
  assert.match(DEPLOY_JOB, /npm run build --prefix relay/);
});
