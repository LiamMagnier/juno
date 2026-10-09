/**
 * Hidden-ref checkpoints against a real temporary git repository: the user's
 * index, HEAD, branches and ignored files are never touched; per-turn and
 * whole-thread diffs are right; rollback restores exactly the changed paths
 * and is itself undoable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitCheckpoints, checkpointRef, safeRefSegment, CHECKPOINT_REF_ROOT } from "../src/git/checkpoints.js";
import { initRepo, tempDir } from "./helpers.js";

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (repo: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const read = (repo: string, file: string) => fs.readFileSync(path.join(repo, file), "utf8");

test("checkpoints: refs are hidden and the user's index, HEAD and branches stay as they were", async () => {
  const repo = initRepo();
  const cp = new GitCheckpoints();
  write(repo, "staged.txt", "staged by the user\n");
  g(repo, "add", "staged.txt");
  const indexBefore = g(repo, "diff", "--cached", "--name-only");
  const headBefore = g(repo, "rev-parse", "HEAD");
  const branchesBefore = g(repo, "branch", "--list");

  const base = await cp.create(repo, "thread-1", 0);
  assert.ok(base);
  assert.equal(base.ref, `${CHECKPOINT_REF_ROOT}/thread-1/turn/0`);
  write(repo, "src/app.ts", "export const a = 2;\n");
  write(repo, "src/new.ts", "export const b = 1;\n");
  write(repo, "ignored.txt", "never captured\n");
  const t1 = await cp.create(repo, "thread-1", 1);
  assert.ok(t1);
  assert.equal(t1.filesChanged, 2);
  assert.equal(t1.additions, 2);
  assert.equal(t1.deletions, 1);

  assert.equal(g(repo, "diff", "--cached", "--name-only"), indexBefore, "staging area untouched");
  assert.equal(g(repo, "rev-parse", "HEAD"), headBefore);
  assert.equal(g(repo, "branch", "--list"), branchesBefore);
  assert.equal(g(repo, "stash", "list"), "");
  assert.deepEqual(await cp.list(repo, "thread-1"), [0, 1]);
  // The checkpoint never contains ignored files.
  assert.ok(!g(repo, "ls-tree", "-r", "--name-only", t1.commit).split("\n").includes("ignored.txt"));
  // Turn 1's parent is turn 0, so the refs form one history per thread.
  assert.equal(g(repo, "rev-parse", `${t1.commit}^`), base.commit);
});

test("checkpoints: per-turn and whole-thread diffs", async () => {
  const repo = initRepo();
  const cp = new GitCheckpoints();
  await cp.create(repo, "t", 0);
  write(repo, "README.md", "hello\nworld\n");
  await cp.create(repo, "t", 1);
  fs.rmSync(path.join(repo, "src", "app.ts"));
  write(repo, "docs/guide.md", "# Guide\n");
  await cp.create(repo, "t", 2);

  const turn2 = await cp.diff(repo, (await cp.resolve(repo, "t", 1))!, (await cp.resolve(repo, "t", 2))!);
  assert.deepEqual(
    turn2.files.map((f) => `${f.change}:${f.path}`).sort(),
    ["add:docs/guide.md", "delete:src/app.ts"],
  );
  assert.match(turn2.diff, /\+# Guide/);

  write(repo, "README.md", "hello\nworld\nagain\n");
  const whole = await cp.diff(repo, (await cp.resolve(repo, "t", 0))!, "worktree");
  const readme = whole.files.find((f) => f.path === "README.md");
  assert.ok(readme);
  assert.equal(readme.additions, 2);
  assert.equal(whole.files.length, 3);
});

test("checkpoints: rollback restores only changed paths, keeps ignored files and can be undone", async () => {
  const repo = initRepo();
  const cp = new GitCheckpoints();
  await cp.create(repo, "t", 0);
  write(repo, "src/app.ts", "export const a = 99;\n");
  write(repo, "deep/nested/file.ts", "x\n");
  write(repo, "ignored.txt", "local secret\n");
  await cp.create(repo, "t", 1);
  const untouched = path.join(repo, ".gitignore");
  const mtime = fs.statSync(untouched).mtimeMs;

  const { restoredFiles, undoRef } = await cp.rollback(repo, "t", 0);
  assert.equal(restoredFiles, 2);
  assert.equal(read(repo, "src/app.ts"), "export const a = 1;\n");
  assert.equal(fs.existsSync(path.join(repo, "deep")), false, "emptied directories are pruned");
  assert.equal(read(repo, "ignored.txt"), "local secret\n", "ignored files are never touched");
  assert.equal(fs.statSync(untouched).mtimeMs, mtime, "unchanged files are not rewritten");
  assert.equal(g(repo, "status", "--porcelain"), "", "working tree matches HEAD again");

  // Undo the rollback from its saved ref.
  assert.match(undoRef, /pre-rollback\/\d+$/);
  const undo = g(repo, "rev-parse", undoRef);
  assert.equal(g(repo, "show", `${undo}:src/app.ts`), "export const a = 99;");

  await assert.rejects(cp.rollback(repo, "t", 7), /no checkpoint/);
  await cp.drop(repo, "t");
  assert.equal(g(repo, "for-each-ref", `${CHECKPOINT_REF_ROOT}/t/`), "");
});

test("checkpoints: not a repository, unsafe thread ids and repos without commits", async () => {
  const cp = new GitCheckpoints();
  assert.equal(await cp.create(tempDir("plain"), "t", 0), null);
  assert.ok(!safeRefSegment("../../etc").includes(".."));
  assert.ok(!safeRefSegment("../../etc").includes("/"));
  assert.ok(!checkpointRef("a/../b", 1).includes(".."));
  assert.throws(() => safeRefSegment("..."));

  const empty = tempDir("empty");
  g(empty, "init", "-q");
  write(empty, "a.txt", "a\n");
  const first = await cp.create(empty, "t", 0);
  assert.ok(first, "a repo with no HEAD still checkpoints");
  assert.ok(g(empty, "ls-tree", "-r", "--name-only", first.commit).includes("a.txt"));
});
