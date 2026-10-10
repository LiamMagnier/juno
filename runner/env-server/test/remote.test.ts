/**
 * The remote lane (docs/code-v2/REMOTE-CONTROL.md): the folder browser and
 * commit / push against real temporary repositories, the porcelain parser,
 * and the host.* commands the env server leaves to the Mac app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitCommit, gitPush, gitStatus, listFolder, parsePorcelain, remoteWebUrl } from "../src/remote/remote-commands.js";
import { initRepo, tempDir } from "./helpers.js";

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repoWithIdentity(): string {
  const repo = initRepo();
  g(repo, "config", "user.name", "Remote Tester");
  g(repo, "config", "user.email", "remote@example.com");
  return repo;
}

test("fs.list: folders first, repositories marked, hidden and files left out unless asked", async () => {
  const root = tempDir("fs");
  fs.mkdirSync(path.join(root, "beta"));
  fs.mkdirSync(path.join(root, "Alpha"));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.mkdirSync(path.join(root, "app", ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes.txt"), "x");

  const folders = await listFolder(root);
  assert.deepEqual(folders.entries.map((e) => e.name), ["Alpha", "app", "beta"]);
  assert.equal(folders.entries.find((e) => e.name === "app")?.isRepo, true);
  assert.equal(folders.entries.find((e) => e.name === "beta")?.isRepo, undefined);
  assert.equal(folders.parent, path.dirname(folders.path));

  const all = await listFolder(root, { files: true, showHidden: true });
  assert.deepEqual(all.entries.map((e) => `${e.kind}:${e.name}`), ["dir:.hidden", "dir:Alpha", "dir:app", "dir:beta", "file:notes.txt"]);
});

test("fs.list: a relative or missing path is refused with a wire error", async () => {
  await assert.rejects(listFolder("relative/path"), (e: { code?: string }) => e.code === "bad_request");
  await assert.rejects(listFolder(path.join(tempDir("fs"), "nope")), (e: { code?: string }) => e.code === "not_found");
});

test("porcelain: branch, upstream, ahead/behind and renames", () => {
  const parsed = parsePorcelain(["## main...origin/main [ahead 2, behind 1]", " M src/app.ts", "?? new.txt", "R  b.txt", "a.txt", ""].join("\0"));
  assert.equal(parsed.branch, "main");
  assert.equal(parsed.upstream, "origin/main");
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 1);
  assert.deepEqual(parsed.files, [
    { path: "src/app.ts", status: " M" },
    { path: "new.txt", status: "??" },
    { path: "b.txt", status: "R " },
  ]);
  assert.equal(parsePorcelain("## No commits yet on main\0").branch, "main");
  assert.equal(parsePorcelain("## feature/x.y\0").branch, "feature/x.y");
  assert.equal(parsePorcelain("## HEAD (no branch)\0").branch, undefined);
});

test("remote web url: ssh and https remotes both become a browsable address", () => {
  assert.equal(remoteWebUrl("git@github.com:alevr/app.git"), "https://github.com/alevr/app");
  assert.equal(remoteWebUrl("https://token@github.com/alevr/app.git\n"), "https://github.com/alevr/app");
  assert.equal(remoteWebUrl("/local/path"), undefined);
});

test("git.status, git.commit and git.push: the user's own identity, upstream set on first push", async () => {
  const repo = repoWithIdentity();
  const outside = tempDir("plain");
  assert.equal((await gitStatus(outside, { probeGh: false })).isRepo, false);

  fs.writeFileSync(path.join(repo, "src", "app.ts"), "export const a = 2;\n");
  fs.writeFileSync(path.join(repo, "added.txt"), "new\n");
  const before = await gitStatus(repo, { probeGh: false });
  assert.equal(before.isRepo, true);
  assert.equal(before.branch, "main");
  assert.deepEqual(before.files.map((f) => f.path).sort(), ["added.txt", "src/app.ts"]);

  await assert.rejects(gitCommit(repo, "   "), (e: { code?: string }) => e.code === "bad_request");
  const commit = await gitCommit(repo, "Ship it from the phone");
  assert.match(commit.sha, /^[0-9a-f]{40}$/);
  assert.equal(commit.summary, "Ship it from the phone");
  assert.equal(g(repo, "log", "-1", "--format=%an <%ae>"), "Remote Tester <remote@example.com>");
  assert.equal((await gitStatus(repo, { probeGh: false })).files.length, 0);
  await assert.rejects(gitCommit(repo, "again"), (e: { code?: string }) => e.code === "conflict");

  const bare = tempDir("bare");
  g(bare, "init", "-q", "--bare");
  g(repo, "remote", "add", "origin", bare);
  const pushed = await gitPush(repo);
  assert.deepEqual(pushed, { branch: "main", remote: "origin" });
  assert.equal(g(bare, "rev-parse", "main"), commit.sha);
  const after = await gitStatus(repo, { probeGh: false });
  assert.equal(after.upstream, "origin/main");
  assert.equal(after.ahead, 0);
});
