/**
 * Runtime lane: rollback scoped to the session, patches applied in the
 * session's own folder (rejected hunks), and resume at reset (scheduled,
 * cancellable, persisted across a restart). Fake codex app-server throughout.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import type { ModelSelection, ScheduledResume, TurnItem } from "../src/contracts/code-v2.js";
import { normalizeRepoPath, patchPaths } from "../src/git/checkpoints.js";
import { TestClient, fakeBinDir, initRepo, tempDir } from "./helpers.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
after(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

async function boot(dataDir = tempDir("rt-data"), bin = fakeBinDir()) {
  const server = await startEnvServer({ dataDir, searchDirs: [bin], logger: silentLogger, probeOnStart: false, coalesceMs: 5, forcePipeTerminals: true, computerUse: false });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);
  await client.command("provider.probe", { instanceId: "codex:default" });
  return { server, client, dataDir, bin };
}

const codex: ModelSelection = { instanceId: "codex:default", model: "gpt-6.1-codex" };
const full = { runtimeMode: "full", interactionMode: "default" } as const;

async function open(client: TestClient, cwd: string): Promise<string> {
  const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd, selection: codex });
  await client.waitFor(() => client.snapshots.get(sessionId), 4000, "snapshot");
  return sessionId;
}

async function turn(client: TestClient, sid: string, text: string) {
  const { turnId } = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text }, selection: codex, ...full });
  return client.turnCompleted(sid, turnId);
}

const notices = (client: TestClient, sid: string) =>
  client.snapshot(sid).items.filter((i): i is Extract<TurnItem, { kind: "system_notice" }> => i.kind === "system_notice");

// ── Rollback scope ──────────────────────────────────────────────────────────

test("rollback: only this session's files, never another session's or a later edit", async () => {
  const { client } = await boot();
  const repo = initRepo();
  const a = await open(client, repo);
  const b = await open(client, repo);
  await turn(client, a, "write a.md");
  await turn(client, b, "write b.md");
  assert.ok(fs.existsSync(path.join(repo, "a.md")) && fs.existsSync(path.join(repo, "b.md")));

  // A goes back to before its first turn: a.md goes, B's b.md stays.
  const { restoredFiles } = await client.command<{ restoredFiles: number }>("checkpoint.rollback", { sessionId: a, checkpointId: "cp_0" });
  assert.equal(restoredFiles, 1);
  assert.equal(fs.existsSync(path.join(repo, "a.md")), false);
  assert.equal(fs.readFileSync(path.join(repo, "b.md"), "utf8"), "written by fake codex turn 1\n");

  // B's own file changed again by someone else after B's turn: B's rollback leaves it and says so.
  fs.writeFileSync(path.join(repo, "b.md"), "edited by hand\n");
  const second = await client.command<{ restoredFiles: number }>("checkpoint.rollback", { sessionId: b, checkpointId: "cp_0" });
  assert.equal(second.restoredFiles, 0);
  assert.equal(fs.readFileSync(path.join(repo, "b.md"), "utf8"), "edited by hand\n");
  const said = await client.waitFor(() => notices(client, b).find((n) => n.code === "rollback"), 4000, "rollback notice");
  assert.match(said.text, /Left 1 file alone.*b\.md/);
});

test("rollback: a session in a subfolder never restores files outside it", async () => {
  const { client } = await boot();
  const repo = initRepo();
  const sub = path.join(repo, "src");
  const s = await open(client, sub);
  await turn(client, s, "write inner.md");
  // Something outside the session's folder changes during its next turn window.
  fs.writeFileSync(path.join(repo, "README.md"), "outside edit\n");
  await turn(client, s, "write inner2.md");
  const { restoredFiles } = await client.command<{ restoredFiles: number }>("checkpoint.rollback", { sessionId: s, checkpointId: "cp_0" });
  assert.equal(restoredFiles, 2);
  assert.equal(fs.existsSync(path.join(sub, "inner.md")), false);
  assert.equal(fs.existsSync(path.join(sub, "inner2.md")), false);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "outside edit\n");
});

// ── checkpoint.applyPatch ───────────────────────────────────────────────────

test("applyPatch: a rejected change is reverted in the session's folder, all or nothing, and checked first", async () => {
  const { client } = await boot();
  const repo = initRepo();
  const sid = await open(client, repo);
  await turn(client, sid, "write notes.md");
  const cp = client.snapshot(sid).items.find((i) => i.kind === "checkpoint");
  assert.ok(cp && cp.kind === "checkpoint");
  const { diff } = await client.command<{ diff: string }>("checkpoint.diff", { sessionId: sid, checkpointId: cp.checkpointId });
  assert.match(diff, /notes\.md/);

  const check = await client.command<{ applied: boolean; files: string[] }>("checkpoint.applyPatch", { sessionId: sid, patch: diff, reverse: true, checkOnly: true });
  assert.deepEqual(check, { applied: false, files: ["notes.md"] });
  assert.ok(fs.existsSync(path.join(repo, "notes.md")));

  const done = await client.command<{ applied: boolean; files: string[] }>("checkpoint.applyPatch", { sessionId: sid, patch: diff, reverse: true });
  assert.deepEqual(done, { applied: true, files: ["notes.md"] });
  assert.equal(fs.existsSync(path.join(repo, "notes.md")), false);
  await client.waitFor(() => notices(client, sid).find((n) => n.code === "patch_applied"), 4000, "patch notice");

  // Applying the same reverse again no longer fits: refused, nothing written.
  await assert.rejects(client.command("checkpoint.applyPatch", { sessionId: sid, patch: diff, reverse: true }), (e: Error & { code?: string }) => e.code === "conflict");

  // A hunk patch from the dock (already reversed by the client) on an edited file.
  fs.writeFileSync(path.join(repo, "README.md"), "hello\nmore\n");
  const hunk = "--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,1 @@\n hello\n-more\n";
  const applied = await client.command<{ files: string[] }>("checkpoint.applyPatch", { sessionId: sid, patch: hunk });
  assert.deepEqual(applied.files, ["README.md"]);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "hello\n");
});

test("applyPatch: paths outside the session's folder, traversal and .git are refused", async () => {
  const { client } = await boot();
  const repo = initRepo();
  const sid = await open(client, path.join(repo, "src"));
  const outside = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-hello\n+bye\n";
  await assert.rejects(client.command("checkpoint.applyPatch", { sessionId: sid, patch: outside }), /outside this session's folder/);
  const traversal = "--- a/src/../README.md\n+++ b/src/../README.md\n@@ -1 +1 @@\n-hello\n+bye\n";
  await assert.rejects(client.command("checkpoint.applyPatch", { sessionId: sid, patch: traversal }), (e: Error & { code?: string }) => e.code === "bad_request");
  const gitDir = "--- a/src/.git/config\n+++ b/src/.git/config\n@@ -0,0 +1 @@\n+x\n";
  await assert.rejects(client.command("checkpoint.applyPatch", { sessionId: sid, patch: gitDir }), (e: Error & { code?: string }) => e.code === "bad_request");
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "hello\n");
  // Inside the folder it works.
  const inside = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n";
  await client.command("checkpoint.applyPatch", { sessionId: sid, patch: inside });
  assert.equal(fs.readFileSync(path.join(repo, "src", "app.ts"), "utf8"), "export const a = 2;\n");
});

test("patch paths are read from every header and normalized strictly", () => {
  assert.deepEqual([...patchPaths("diff --git a/x/y.ts b/x/z.ts\nrename from x/y.ts\nrename to x/z.ts\n")].sort(), ["x/y.ts", "x/z.ts"]);
  assert.deepEqual([...patchPaths("--- /dev/null\n+++ b/new.md\n")], ["new.md"]);
  assert.equal(normalizeRepoPath("a/./b"), "a/b");
  assert.equal(normalizeRepoPath("../a"), undefined);
  assert.equal(normalizeRepoPath("/etc/passwd"), undefined);
});

// ── Resume at reset ─────────────────────────────────────────────────────────

test("schedule: a limited turn resumes at the reset by itself; a schedule can be cancelled; a manual turn supersedes it", async () => {
  const { client } = await boot();
  const sid = await open(client, tempDir("rt-cwd"));
  const limited = await turn(client, sid, "please limit");
  assert.equal(limited.outcome, "limited");
  const resumeAt = client.snapshot(sid).resumeAt;
  assert.ok(resumeAt);

  // Default time: the session's own reset.
  const byDefault = await client.command<{ schedule: ScheduledResume }>("turn.schedule", { sessionId: sid });
  assert.equal(Date.parse(byDefault.schedule.at), Date.parse(resumeAt!));
  const shown = await client.waitFor(() => client.snapshot(sid).scheduledResume, 4000, "scheduled");
  assert.equal(shown.id, byDefault.schedule.id);

  // Cancel: a wrong id does nothing, the right one clears it.
  assert.deepEqual(await client.command("turn.unschedule", { sessionId: sid, scheduleId: "rs_other" }), { cancelled: false });
  assert.deepEqual(await client.command("turn.unschedule", { sessionId: sid, scheduleId: byDefault.schedule.id }), { cancelled: true });
  await client.waitFor(() => client.snapshot(sid).scheduledResume === undefined, 4000, "cleared");

  // Fires: a new turn starts with the continue message.
  const soon = new Date(Date.now() + 300).toISOString();
  await client.command("turn.schedule", { sessionId: sid, at: soon });
  const resumed = await client.waitFor(
    () => client.snapshot(sid).items.find((i) => i.kind === "user_message" && /usage window has reset/.test(i.text)),
    8000,
    "resumed turn",
  );
  assert.ok(resumed);
  await client.waitFor(() => client.snapshot(sid).state === "idle" && client.snapshot(sid).scheduledResume === undefined, 8000, "idle again");

  // A manual turn clears a pending schedule.
  await client.command("turn.schedule", { sessionId: sid, at: new Date(Date.now() + 60_000).toISOString(), input: { text: "custom resume" } });
  await client.waitFor(() => client.snapshot(sid).scheduledResume?.input?.text === "custom resume", 4000, "custom");
  await turn(client, sid, "hello");
  assert.equal(client.snapshot(sid).scheduledResume, undefined);

  await assert.rejects(client.command("turn.schedule", { sessionId: sid, at: "tomorrow-ish" }), (e: Error & { code?: string }) => e.code === "bad_request");
  await assert.rejects(client.command("turn.schedule", { sessionId: sid, at: new Date(Date.now() + 30 * 864e5).toISOString() }), /8 days/);
});

test("schedule: survives an env server restart", async () => {
  const dataDir = tempDir("rt-persist");
  const bin = fakeBinDir();
  const first = await boot(dataDir, bin);
  const sid = await open(first.client, tempDir("rt-cwd2"));
  await turn(first.client, sid, "limit me");
  await first.client.command("turn.schedule", { sessionId: sid, at: new Date(Date.now() + 1500).toISOString(), input: { text: "after restart" } });
  first.client.close();
  await first.server.close();
  assert.ok(JSON.parse(fs.readFileSync(path.join(dataDir, "schedules.json"), "utf8"))[sid]);

  const second = await boot(dataDir, bin);
  await second.client.command("session.open", { sessionId: sid, cwd: "/", afterSequence: -1 });
  const resumed = await second.client.waitFor(
    () => second.client.snapshots.get(sid)?.items.find((i) => i.kind === "user_message" && i.text === "after restart"),
    10_000,
    "resumed after restart",
  );
  assert.ok(resumed);
});

test("git is available for these tests", () => {
  assert.match(execFileSync("git", ["--version"], { encoding: "utf8" }), /git version/);
});

test("computer bridge token: only a private regular file of this user is read, never a symlink", async () => {
  const { readBridgeToken } = await import("../src/mcp/computer-bridge.js");
  const dir = tempDir("bridge");
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "bridge.token");
  fs.writeFileSync(file, "a".repeat(64), { mode: 0o600 });
  assert.equal(readBridgeToken(file), "a".repeat(64));
  fs.chmodSync(file, 0o644);
  assert.throws(() => readBridgeToken(file), /not private/);
  fs.chmodSync(file, 0o600);
  const link = path.join(dir, "link.token");
  fs.symlinkSync(file, link);
  assert.throws(() => readBridgeToken(link));
  fs.chmodSync(dir, 0o755);
  assert.throws(() => readBridgeToken(file), /folder is not private/);
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(file, "short\n", { mode: 0o600 });
  assert.throws(() => readBridgeToken(file), /malformed/);
});
