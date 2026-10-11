/**
 * Changes without git: line diffs in git's format, the folder store's
 * per-turn manifests (diffs, rollback, per-hunk reject) and the Claude
 * runtime's real edit patches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { FolderCheckpoints, fileChangesDiff } from "../src/git/folder-checkpoints.js";
import { applyHunks, diffText, fileSection, parsePatch } from "../src/git/line-diff.js";
import { appliedPatch } from "../src/providers/claude-agent.js";
import type { TurnItem } from "../src/contracts/code-v2.js";
import { tempDir } from "./helpers.js";

const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");

/** git's own verdict on the same two texts, for comparison. */
function gitNumstat(before: string, after: string): [number, number] {
  const dir = tempDir("gitdiff");
  write(dir, "a", before);
  write(dir, "b", after);
  let out = "";
  try {
    out = execFileSync("git", ["diff", "--no-index", "--numstat", "a", "b"], { cwd: dir, encoding: "utf8" });
  } catch (error) {
    out = String((error as { stdout?: string }).stdout ?? "");
  }
  const [a, d] = out.trim().split("\t");
  return [Number(a) || 0, Number(d) || 0];
}

test("line diff: counts agree with git and the patch round-trips both ways", () => {
  const cases: [string, string][] = [
    ["", "one\ntwo\n"],
    ["one\ntwo\n", ""],
    ["a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "a\nB\nc\nd\ne\nf\ng\nh\nI\nj\nk\n"],
    ["keep\nno newline", "keep\nno newline\n"],
    ["x\ny\nz", "x\nY\nz"],
    [Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") + "\n", Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? `changed ${i}` : `line ${i}`)).join("\n") + "\n"],
  ];
  for (const [before, after] of cases) {
    const d = diffText(before, after);
    assert.deepEqual([d.additions, d.deletions], gitNumstat(before, after), JSON.stringify([before, after]));
    const section = fileSection("f.txt", before, after);
    const [file] = parsePatch(section.text);
    assert.equal(applyHunks(before, file.hunks), after, "forward");
    assert.equal(applyHunks(after, file.hunks, true), before, "reverse");
  }
  assert.equal(diffText("same\n", "same\n").hunks, "");
});

test("line diff: a hunk that no longer matches applies nothing", () => {
  const section = fileSection("f.txt", "a\nb\nc\n", "a\nB\nc\n");
  const [file] = parsePatch(section.text);
  assert.throws(() => applyHunks("a\nsomething else\nc\n", file.hunks, true), /no longer applies/);
});

test("folder checkpoints: per-turn and whole-session diffs of a folder that is not a repository", async () => {
  const cwd = tempDir("portfolio");
  write(cwd, "index.html", "<h1>Hi</h1>\n");
  write(cwd, "node_modules/dep/index.js", "vendored\n");
  const store = new FolderCheckpoints(tempDir("store"));
  assert.equal(fs.existsSync(path.join(cwd, ".git")), false);

  await store.create(cwd, "thread", 0);
  write(cwd, "index.html", "<h1>Hi</h1>\n<p>Portfolio</p>\n");
  write(cwd, "styles.css", "body { margin: 0; }\n");
  write(cwd, "node_modules/dep/index.js", "changed vendored\n");
  const one = await store.create(cwd, "thread", 1);
  assert.deepEqual(one, { turn: 1, filesChanged: 2, additions: 2, deletions: 0 });

  fs.rmSync(path.join(cwd, "styles.css"));
  write(cwd, "script.js", "console.log(1);\n");
  const two = await store.create(cwd, "thread", 2);
  assert.equal(two.filesChanged, 2);

  const turn1 = (await store.diff(cwd, "thread", 0, 1))!;
  assert.deepEqual(turn1.files.map((f) => [f.path, f.change, f.additions, f.deletions]), [
    ["index.html", "modify", 1, 0],
    ["styles.css", "add", 1, 0],
  ]);
  assert.match(turn1.diff, /^diff --git a\/index.html b\/index.html\n--- a\/index.html\n\+\+\+ b\/index.html\n@@ -1 \+1,2 @@\n <h1>Hi<\/h1>\n\+<p>Portfolio<\/p>\n/);
  assert.match(turn1.diff, /new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/styles.css\n@@ -0,0 \+1 @@\n\+body/);
  assert.ok(!turn1.diff.includes("node_modules"), "vendored folders are not the session's changes");

  // Whole session: from before the first turn to the live folder, later edits included.
  write(cwd, "index.html", "<h1>Hello</h1>\n<p>Portfolio</p>\n");
  const whole = (await store.diff(cwd, "thread", 0, "worktree"))!;
  assert.deepEqual(whole.files.map((f) => [f.path, f.change, f.additions, f.deletions]), [
    ["index.html", "modify", 2, 1],
    ["script.js", "add", 1, 0],
  ]);
  assert.equal(await store.diff(cwd, "missing-thread", 0, "worktree"), undefined);
});

test("folder checkpoints: rollback restores only the session's own files and keeps later edits", async () => {
  const cwd = tempDir("rollback");
  write(cwd, "a.txt", "a0\n");
  write(cwd, "b.txt", "b0\n");
  const store = new FolderCheckpoints(tempDir("store"));
  await store.create(cwd, "t", 0);
  write(cwd, "a.txt", "a1\n");
  write(cwd, "new/c.txt", "c1\n");
  await store.create(cwd, "t", 1);
  write(cwd, "b.txt", "b by the user\n");
  const result = await store.rollback(cwd, "t", 0, { latestTurn: 1 });
  assert.equal(result.restoredFiles, 2);
  assert.equal(read(cwd, "a.txt"), "a0\n");
  assert.equal(fs.existsSync(path.join(cwd, "new")), false, "a created file and its empty folder are removed");
  assert.equal(read(cwd, "b.txt"), "b by the user\n", "a file the session never changed is left alone");
  assert.ok(fs.existsSync(result.undoRef));
});

test("folder checkpoints: rejecting one hunk reverts it in place, all or nothing", () => {
  const cwd = tempDir("reject");
  write(cwd, "app.js", "one\ntwo\nthree\n");
  const store = new FolderCheckpoints(tempDir("store"));
  const patch = "--- a/app.js\n+++ b/app.js\n@@ -1,3 +1,3 @@\n one\n-TWO\n+two\n three\n";
  assert.deepEqual(store.applyPatch(cwd, patch, { reverse: true, checkOnly: true }), { applied: false, files: ["app.js"] });
  assert.equal(read(cwd, "app.js"), "one\ntwo\nthree\n");
  assert.deepEqual(store.applyPatch(cwd, patch, { reverse: true }), { applied: true, files: ["app.js"] });
  assert.equal(read(cwd, "app.js"), "one\nTWO\nthree\n");
  assert.throws(() => store.applyPatch(cwd, patch, { reverse: true }), /no longer applies/);
  assert.throws(() => store.applyPatch(cwd, "--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n"), /unsafe path/);
  // Undoing a created file removes it.
  write(cwd, "made.txt", "made\n");
  store.applyPatch(cwd, fileSection("made.txt", null, "made\n").text, { reverse: true });
  assert.equal(fs.existsSync(path.join(cwd, "made.txt")), false);
});

test("file_change items stand in when no manifest exists, with the card's own counts", () => {
  const cwd = "/Users/me/Desktop/test";
  const item = (id: string, changes: Extract<TurnItem, { kind: "file_change" }>["changes"]): TurnItem => ({ id, kind: "file_change", turnId: "t1", createdAt: "", callId: id, status: "completed", changes });
  const out = fileChangesDiff(cwd, [
    item("1", [{ path: `${cwd}/portfolio/index.html`, change: "add", diff: "--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+a\n+b", additions: 2, deletions: 0 }]),
    item("2", [{ path: `${cwd}/portfolio/index.html`, change: "modify", diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+A", additions: 1, deletions: 1 }]),
    item("3", [{ path: `${cwd}/portfolio/script.js`, change: "add", additions: 23, deletions: 0 }]),
  ]);
  assert.deepEqual(out.files.map((f) => [f.path, f.additions, f.deletions]), [
    ["portfolio/index.html", 3, 1],
    ["portfolio/script.js", 23, 0],
  ]);
  assert.match(out.diff, /diff --git a\/portfolio\/index.html b\/portfolio\/index.html\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/portfolio\/index.html\n@@ -0,0 \+1,2 @@\n\+a\n\+b\n@@ -1 \+1 @@\n-a\n\+A\n/);
});

test("Claude edits: the CLI's structuredPatch gives real hunks; a Write says whether it created the file", () => {
  const edit = appliedPatch("/p/styles.css", "Edit", { old_string: "a", new_string: "b" }, {
    structuredPatch: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [" x", "-old", "+new", "+more", " y"] }],
  });
  assert.deepEqual(edit, { change: "modify", diff: "--- a//p/styles.css\n+++ b//p/styles.css\n@@ -10,3 +10,4 @@\n x\n-old\n+new\n+more\n y", additions: 2, deletions: 1 });
  const created = appliedPatch("/p/index.html", "Write", { content: "one\ntwo\n" }, { type: "create", structuredPatch: [], content: "one\ntwo\n" });
  assert.equal(created?.change, "add");
  assert.equal(created?.additions, 2);
  const replaced = appliedPatch("/p/index.html", "Write", { content: "new\n" }, { type: "update", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }] });
  assert.deepEqual([replaced?.change, replaced?.additions, replaced?.deletions], ["modify", 1, 1]);
  assert.equal(appliedPatch("/p/x", "Edit", {}, undefined), undefined);
  assert.equal(appliedPatch("/p/x", "Edit", {}, { staged: true, structuredPatch: [] }), undefined);
});
