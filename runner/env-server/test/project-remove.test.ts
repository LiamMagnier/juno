/**
 * project.remove: every session in a folder (the folder, inside it, or a
 * worktree of it) stops and its log goes; sessions elsewhere and the folder's
 * own files stay; every client hears project.removed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import type { ModelSelection, ServerEventEnvelope } from "../src/contracts/code-v2.js";
import { TestClient, fakeBinDir, fakeClaudeQuery, tempDir } from "./helpers.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
after(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

async function boot() {
  const dataDir = tempDir("data");
  const server = await startEnvServer({
    dataDir,
    searchDirs: [fakeBinDir()],
    logger: silentLogger,
    probeOnStart: false,
    coalesceMs: 5,
    forcePipeTerminals: true,
    terminalShell: "/bin/sh",
    claudeQuery: fakeClaudeQuery(),
  });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  const other = await TestClient.connect(server.url, server.token);
  clients.push(client, other);
  return { dataDir, client, other };
}

async function openSession(c: TestClient, cwd: string, selection: ModelSelection): Promise<string> {
  const { sessionId } = await c.command<{ sessionId: string }>("session.open", { cwd, selection });
  await c.waitFor(() => c.snapshots.get(sessionId), 4000, "snapshot");
  return sessionId;
}

const selection = { instanceId: "acp:gemini", model: "default" };
const ask = { runtimeMode: "ask", interactionMode: "default" } as const;

test("project.remove stops and deletes the folder's sessions and leaves everything else", async () => {
  const { dataDir, client, other } = await boot();
  const project = tempDir("project");
  fs.writeFileSync(path.join(project, "keep.txt"), "mine\n");
  fs.mkdirSync(path.join(project, "pkg"));
  const elsewhere = tempDir("elsewhere");
  // A folder whose name starts like the project's is not inside it.
  const sibling = `${project}-sibling`;
  fs.mkdirSync(sibling);

  const root = await openSession(client, project, selection);
  const nested = await openSession(client, path.join(project, "pkg"), selection);
  const kept = await openSession(client, elsewhere, selection);
  const keptSibling = await openSession(client, sibling, selection);

  // A running turn is stopped first.
  const turn = await client.command<{ turnId: string }>("turn.start", { sessionId: root, input: { text: "slow" }, selection, ...ask });
  await client.waitFor(() => client.snapshot(root).state === "running", 5000, "running");

  const result = await client.command<{ sessionIds: string[] }>("project.remove", { cwd: project });
  assert.deepEqual(result.sessionIds, [root, nested].sort());
  assert.equal((await client.turnCompleted(root, turn.turnId)).outcome, "interrupted");

  const list = await client.command<{ sessions: { id: string }[] }>("session.list", {});
  assert.deepEqual(list.sessions.map((s) => s.id).sort(), [kept, keptSibling].sort());
  assert.ok(!fs.existsSync(path.join(dataDir, "sessions", root)), "the log is gone");
  assert.ok(fs.existsSync(path.join(dataDir, "sessions", kept)));
  assert.equal(fs.readFileSync(path.join(project, "keep.txt"), "utf8"), "mine\n", "the folder is untouched");

  // Every client hears it, on the global stream.
  const heard = (c: TestClient) =>
    c.waitFor(
      () => c.events.find((e): e is ServerEventEnvelope => e.stream === "global" && e.event.type === "project.removed"),
      4000,
      "project.removed",
    );
  for (const c of [client, other]) {
    const envelope = await heard(c);
    assert.deepEqual(envelope.event, { type: "project.removed", cwd: path.resolve(project), sessionIds: [root, nested].sort() });
  }

  // Removing again is harmless; a relative cwd is refused.
  assert.deepEqual((await client.command<{ sessionIds: string[] }>("project.remove", { cwd: project })).sessionIds, []);
  await assert.rejects(client.command("project.remove", { cwd: "relative/path" }), /absolute/);
});
