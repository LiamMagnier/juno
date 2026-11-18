import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/**
 * A project's Google Drive folder source against real PostgreSQL: a folder is
 * filed and synced into project attachments that the project's chats read
 * (indexed under the project, listed in its lineage), a later sync adds,
 * re-imports and tombstones what changed in the folder, a refused token keeps
 * the knowledge and records the fix, one sync holds a source at a time, and
 * another account can neither sync nor remove it.
 *
 * Google is a fake answering from memory (globalThis.fetch); storage is an
 * in-memory stand-in; `after` queues its callbacks so the test runs the index
 * itself. Opt in with a migrated, disposable, local database:
 *
 *   PROJECT_SOURCES_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_codex_projects_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *   tests/project-sources-db.test.ts
 */
const DB_URL = process.env.PROJECT_SOURCES_TEST_DATABASE_URL;

if (!DB_URL) {
  test("project sources database suite requires PROJECT_SOURCES_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  const target = new URL(DB_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) throw new Error("loopback only");
  if (!/_test$/.test(target.pathname)) throw new Error("a disposable *_test database only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.AUTH_SECRET ??= "project-sources-disposable-test-key";
  process.env.CONNECTOR_GOOGLE_CLIENT_ID = "test-google-app";
  process.env.CONNECTOR_GOOGLE_CLIENT_SECRET = "test-google-secret";
  process.env.CLOUD_ATTACH_ENABLED = "1";

  const FOLDER = "application/vnd.google-apps.folder";
  interface Node { id: string; name: string; mimeType: string; parent: string | null; version: number; body?: string; trashed?: boolean }
  const drive = new Map<string, Node>();
  let refuse: number | null = null;
  const reset = () => {
    drive.clear();
    for (const node of [
      { id: "folder1", name: "Atlas", mimeType: FOLDER, parent: null, version: 1 },
      { id: "brief1", name: "brief.md", mimeType: "text/markdown", parent: "folder1", version: 1, body: "# Brief\nThe Atlas launch is on 4 December." },
      { id: "sub1", name: "Specs", mimeType: FOLDER, parent: "folder1", version: 1 },
      { id: "api1", name: "api.txt", mimeType: "text/plain", parent: "sub1", version: 1, body: "Rate limit: 600 requests a minute." },
    ] as Node[]) drive.set(node.id, { ...node });
  };
  reset();
  const fakeGoogle: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (refuse) return new Response(null, { status: refuse });
    const file = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (file) {
      const node = drive.get(decodeURIComponent(file[1]));
      if (!node) return new Response(null, { status: 404 });
      if (url.searchParams.get("alt") === "media") return new Response(node.body ?? "", { status: 200 });
      return Response.json({ id: node.id, name: node.name, mimeType: node.mimeType, version: String(node.version), size: node.body ? String(node.body.length) : undefined, trashed: node.trashed ?? false });
    }
    if (url.pathname === "/drive/v3/files") {
      const parent = url.searchParams.get("q")?.match(/^'([^']+)' in parents/)?.[1];
      const children = [...drive.values()].filter((node) => node.parent === parent && !node.trashed);
      return Response.json({ files: children.map((node) => ({ id: node.id, name: node.name, mimeType: node.mimeType, version: String(node.version), size: node.body ? String(node.body.length) : undefined })) });
    }
    throw new Error(`unexpected request ${url.href}`);
  };

  const objects = new Map<string, Uint8Array>();
  const afterQueue: Array<() => unknown> = [];
  test.before(async () => {
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: (task: () => unknown) => void afterQueue.push(task) } });
    const storage = await import("@/lib/storage");
    mock.module("@/lib/storage", {
      namedExports: {
        ...storage,
        putObject: async (key: string, body: Uint8Array) => void objects.set(key, new Uint8Array(body)),
        deleteObject: async (key: string) => void objects.delete(key),
        getObjectBytes: async (key: string) => ({ bytes: objects.get(key) ?? new Uint8Array(), contentType: "application/octet-stream" }),
        getViewUrl: async (key: string) => `/api/files/${key}`,
      },
    });
  });

  /** Runs everything `after` queued (the index), including what those tasks queue. */
  async function drain() {
    while (afterQueue.length) await afterQueue.shift()!();
  }

  test("a Drive folder source mirrors the folder into project knowledge and keeps it in sync", async (t) => {
    const { prismaUnguarded: db } = await import("@/lib/prisma");
    const { encryptSecret } = await import("@/lib/crypto");
    const store = await import("@/lib/projects/drive-source-store");
    const { loadProjectLineage } = await import("@/lib/projects/project-tree-server");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fakeGoogle;

    const owner = await db.user.create({ data: { email: `sources-${randomUUID()}@example.invalid` } });
    const other = await db.user.create({ data: { email: `sources-${randomUUID()}@example.invalid` } });
    t.after(async () => {
      globalThis.fetch = originalFetch;
      await db.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
      await db.$disconnect();
    });
    const project = await db.project.create({ data: { userId: owner.id, name: "Atlas", instructions: "Answer as the launch lead." } });
    await db.connection.create({ data: { userId: owner.id, provider: "google-drive", accessToken: encryptSecret("drive-access"), refreshToken: encryptSecret("drive-refresh"), accountLabel: "owner@example.invalid" } });

    // Filing: the kind and name are Drive's, read with the owner's token.
    const { sourceIds } = await store.addDriveSources(owner.id, project.id, [{ id: "folder1", kind: "file" }], true);
    const sourceId = sourceIds[0];
    const filed = await db.projectSource.findFirstOrThrow({ where: { id: sourceId } });
    assert.deepEqual([filed.kind, filed.name, filed.userId, filed.state], ["folder", "Atlas", owner.id, "pending"]);
    assert.deepEqual(await store.dueSourceIds(owner.id, project.id), [sourceId], "a source never synced is due");
    afterQueue.length = 0;

    // Another account reaches nothing.
    assert.equal(await store.syncProjectSource(other.id, sourceId), null);
    assert.equal(await store.removeProjectSource(other.id, project.id, sourceId), false);
    await assert.rejects(store.addDriveSources(other.id, project.id, [{ id: "folder1", kind: "folder" }], true), /Connect Google Drive/);

    // One sync at a time: of two racing, one runs and the other stands down.
    const [a, b] = await Promise.all([store.syncProjectSource(owner.id, sourceId), store.syncProjectSource(owner.id, sourceId)]);
    assert.equal([a, b].filter((result) => result === null).length, 1);
    const first = (a ?? b)!;
    assert.deepEqual([first.state, first.added, first.fileCount], ["ready", 2, 2]);
    await drain();

    const synced = await db.projectSource.findFirstOrThrow({ where: { id: sourceId } });
    assert.equal(synced.state, "ready");
    assert.equal(synced.syncClaimedAt, null, "the lease is released");
    assert.ok(synced.lastSyncedAt);
    assert.deepEqual(await store.dueSourceIds(owner.id, project.id), [], "a fresh sync is not due again");
    assert.deepEqual(await store.dueSourceIds(owner.id, project.id, Date.now() + 11 * 60_000), [sourceId], "it is due once stale");

    const files = await db.attachment.findMany({ where: { userId: owner.id, projectId: project.id, deletedAt: null }, orderBy: { fileName: "asc" } });
    assert.deepEqual(files.map((file) => [file.fileName, file.origin]), [["api.txt", "cloud_import"], ["brief.md", "cloud_import"]]);
    // Indexed under the project, which is what project retrieval searches.
    const documents = await db.knowledgeDocument.findMany({ where: { userId: owner.id, attachmentId: { in: files.map((file) => file.id) } } });
    assert.equal(documents.length, 2);
    assert.ok(documents.every((document) => document.projectId === project.id && document.chunkCount > 0));
    // And in the lineage the chat route prompts with.
    const lineage = await loadProjectLineage(owner.id, project.id);
    assert.match(lineage!.merged.files.map((file) => file.extractedText).join("\n"), /4 December/);

    // The folder changes: a spec edited, a file added, the brief deleted.
    drive.get("api1")!.version = 2;
    drive.get("api1")!.body = "Rate limit: 900 requests a minute.";
    drive.set("notes1", { id: "notes1", name: "notes.txt", mimeType: "text/plain", parent: "folder1", version: 1, body: "Freeze on 1 December." });
    drive.get("brief1")!.trashed = true;
    const second = (await store.syncProjectSource(owner.id, sourceId))!;
    assert.deepEqual([second.added, second.updated, second.removed, second.fileCount], [1, 1, 1, 2]);
    await drain();
    const live = await db.attachment.findMany({ where: { userId: owner.id, projectId: project.id, deletedAt: null }, orderBy: { fileName: "asc" } });
    assert.deepEqual(live.map((file) => file.fileName), ["api.txt", "notes.txt"]);
    const brief = files.find((file) => file.fileName === "brief.md")!;
    const briefDocs = await db.knowledgeDocument.findMany({ where: { userId: owner.id, attachmentId: brief.id } });
    assert.ok(briefDocs.every((document) => document.state === "tombstoned"), "a file gone from the folder leaves retrieval too");
    const after = await loadProjectLineage(owner.id, project.id);
    const text = after!.merged.files.map((file) => file.extractedText).join("\n");
    assert.doesNotMatch(text, /4 December/);
    assert.match(text, /900 requests/);
    assert.doesNotMatch(text, /600 requests/, "the old copy of a changed file is gone");

    // Drive refuses the token: the knowledge stays, the source says reconnect.
    refuse = 401;
    const refused = (await store.syncProjectSource(owner.id, sourceId))!;
    refuse = null;
    assert.deepEqual([refused.state, refused.errorCode], ["error", "reconnect"]);
    const waiting = await db.projectSource.findFirstOrThrow({ where: { id: sourceId } });
    assert.deepEqual([waiting.state, waiting.errorCode, waiting.fileCount, waiting.syncClaimedAt], ["error", "reconnect", 2, null]);
    assert.equal(await db.attachment.count({ where: { userId: owner.id, projectId: project.id, deletedAt: null } }), 2);
    assert.deepEqual(await store.dueSourceIds(owner.id, project.id, Date.now() + 60 * 60_000), [], "a source waiting on a reconnect is not retried on every view");

    // Disconnecting Drive: the next sync says to connect it.
    await db.connection.deleteMany({ where: { userId: owner.id, provider: "google-drive" } });
    const disconnected = (await store.syncProjectSource(owner.id, sourceId))!;
    assert.equal(disconnected.errorCode, "not_connected");

    // Removing the source takes its files out of the project.
    assert.equal(await store.removeProjectSource(owner.id, project.id, sourceId), true);
    assert.equal(await db.projectSource.count({ where: { id: sourceId } }), 0);
    assert.equal(await db.projectSourceItem.count({ where: { sourceId } }), 0);
    assert.equal(await db.attachment.count({ where: { userId: owner.id, projectId: project.id, deletedAt: null } }), 0);
  });
}
