import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("web gate stamps require the exact clean tree, scripts and locks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alevr-gate-stamp-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } }).trim();
  const command = (mode: string, ref = "HEAD") => spawnSync(process.execPath, ["scripts/gate-stamp.mjs", mode, ref], { cwd: dir, encoding: "utf8" });
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
  try {
    git("init", "-q");
    write("scripts/gate-stamp.mjs", fs.readFileSync("scripts/gate-stamp.mjs", "utf8"));
    for (const file of ["scripts/local-gates.sh", "scripts/release-gates.sh", "package-lock.json", "runner/agent-core/package-lock.json", "runner/env-server/package-lock.json", "relay/package-lock.json"]) write(file, "initial\n");
    git("add", "."); git("commit", "-qm", "fixture");
    const original = git("rev-parse", "HEAD");
    assert.equal(command("check").status, 1, "no stamp before a successful full run records one");
    assert.equal(command("record").status, 0);
    assert.match(command("check").stdout, /web gates already passed for tree [a-f0-9]+/);
    write("untracked.txt", "unverified");
    assert.equal(command("check").status, 1);
    assert.equal(command("record").status, 1);
    fs.unlinkSync(path.join(dir, "untracked.txt"));
    write("package-lock.json", "changed lock\n");
    assert.equal(command("check").status, 1);
    git("add", "."); git("commit", "-qm", "changed lock");
    assert.equal(command("check").status, 1);
    assert.equal(command("check", original).status, 1, "old release differs from checkout");
    assert.equal(command("record").status, 0);
    write("scripts/local-gates.sh", "changed gate\n");
    git("add", "."); git("commit", "-qm", "changed gate");
    assert.equal(command("check").status, 1);
    assert.equal(command("record").status, 0);
    git("commit", "--allow-empty", "-qm", "same source tree");
    assert.equal(command("check").status, 0, "same verified tree may have a new commit identity");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
