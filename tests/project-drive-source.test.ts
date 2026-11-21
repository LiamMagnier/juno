import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorApiError, FirstPartyClient } from "@/lib/first-party-connectors/client";
import { fetchCloudFile } from "@/lib/cloud-files/drives";
import {
  browseDrive,
  classifyDriveFailure,
  listDriveFolderTree,
  planSourceSync,
  runSourceSync,
  SOURCE_LIMITS,
  SourceSyncError,
  type DriveListedFile,
  type SourceItemRecord,
  type SourceSyncPort,
} from "@/lib/projects/drive-source";
import { estimateKnowledgeTokens } from "@/lib/projects/knowledge-capacity";
import { mergeInheritedProjectContext } from "@/lib/projects/project-tree";
import { buildProjectContext, buildProjectReferenceFiles } from "@/lib/chat/context-assembly";

/*
 * A Google Drive folder as project knowledge, against a fake Drive v3: what
 * the folder walk asks Drive (every page, every subfolder), how a later sync
 * tells added, changed and removed files apart, what a refused token or a
 * folder no longer shared does to the source, and that what a sync mirrors is
 * what a chat in the project is given. No network: the fake answers from an
 * in-memory tree, and an unexpected request fails the test.
 */

const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);

interface FakeNode {
  id: string;
  name: string;
  mimeType: string;
  parent: string | null;
  version: number;
  body?: string;
  trashed?: boolean;
}

/** An in-memory Drive that answers files.get, files.list (by parent, paged), export and alt=media. */
function fakeDrive(nodes: FakeNode[], options: { pageSize?: number; fail?: (url: URL) => Response | null } = {}) {
  const tree = new Map(nodes.map((node) => [node.id, { ...node }]));
  const calls: URL[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const failure = options.fail?.(url);
    if (failure) return failure;
    assert.equal(url.origin, "https://www.googleapis.com");
    const fileMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)(\/export)?$/);
    if (fileMatch) {
      const node = tree.get(decodeURIComponent(fileMatch[1]));
      if (!node) return new Response(null, { status: 404 });
      if (fileMatch[2]) return new Response(new Uint8Array([...ZIP, ...new TextEncoder().encode(node.body ?? "")]), { status: 200 });
      if (url.searchParams.get("alt") === "media") return new Response(node.body ?? "", { status: 200, headers: { "content-type": node.mimeType } });
      return Response.json({ id: node.id, name: node.name, mimeType: node.mimeType, version: String(node.version), modifiedTime: "2026-11-01T00:00:00Z", size: node.body ? String(node.body.length) : undefined, trashed: node.trashed ?? false });
    }
    if (url.pathname === "/drive/v3/files") {
      const q = url.searchParams.get("q") ?? "";
      const parent = q.match(/^'([^']+)' in parents/)?.[1];
      assert.ok(parent, `listing without a parent: ${q}`);
      assert.match(q, /trashed = false/);
      assert.equal(url.searchParams.get("supportsAllDrives"), "true");
      const children = [...tree.values()].filter((node) => node.parent === parent && !node.trashed).sort((a, b) => a.name.localeCompare(b.name));
      const size = options.pageSize ?? 200;
      const start = Number(url.searchParams.get("pageToken") ?? "0");
      const page = children.slice(start, start + size);
      return Response.json({
        files: page.map((node) => ({ id: node.id, name: node.name, mimeType: node.mimeType, version: String(node.version), modifiedTime: "2026-11-01T00:00:00Z", size: node.body ? String(node.body.length) : undefined })),
        ...(start + size < children.length ? { nextPageToken: String(start + size) } : {}),
      });
    }
    throw new Error(`unexpected Drive request ${url.pathname}`);
  };
  return { tree, calls, client: new FirstPartyClient("google-drive", "drive-token", fetcher) };
}

function sampleTree(): FakeNode[] {
  return [
    { id: "root-folder", name: "Q4 Planning", mimeType: FOLDER, parent: null, version: 1 },
    { id: "brief", name: "Brief.md", mimeType: "text/markdown", parent: "root-folder", version: 1, body: "# Brief\nShip the Atlas launch on 4 December." },
    { id: "plan", name: "Plan", mimeType: DOC, parent: "root-folder", version: 3, body: "launch plan" },
    { id: "specs", name: "Specs", mimeType: FOLDER, parent: "root-folder", version: 1 },
    { id: "api", name: "api.txt", mimeType: "text/plain", parent: "specs", version: 2, body: "The API rate limit is 600 requests a minute." },
    { id: "deep", name: "2026", mimeType: FOLDER, parent: "specs", version: 1 },
    { id: "notes", name: "notes.txt", mimeType: "text/plain", parent: "deep", version: 1, body: "Deep notes." },
    { id: "logo", name: "logo.svg", mimeType: "image/svg+xml", parent: "root-folder", version: 1, body: "<svg/>" },
    { id: "elsewhere", name: "elsewhere.txt", mimeType: "text/plain", parent: "other", version: 1, body: "not in the folder" },
  ];
}

/** The store half in memory: items, and project attachments with their text. */
function memoryPort(client: FirstPartyClient, remainingTokens = 1_000_000) {
  const items = new Map<string, SourceItemRecord & { error?: string | null }>();
  const attachments = new Map<string, { id: string; fileName: string; extractedText: string; deletedAt: Date | null; projectId: string }>();
  let next = 0;
  const log: string[] = [];
  const port: SourceSyncPort = {
    async items() {
      return [...items.values()].map((item) => ({ ...item }));
    },
    async importFile(file, previous) {
      const fetched = await fetchCloudFile(client, { id: file.id }, { maxBytes: 1024 * 1024, tooLarge: "Too large." });
      const tokens = estimateKnowledgeTokens({ size: fetched.bytes.byteLength, mimeType: fetched.mimeType });
      if (tokens > remainingTokens) throw new SourceSyncError("capacity", "This project’s knowledge is full.");
      remainingTokens -= tokens;
      const id = `att-${++next}`;
      const text = new TextDecoder().decode(fetched.bytes).replace(/^PK\u0003\u0004\u0014\u0000\u0006\u0000/, "");
      attachments.set(id, { id, fileName: fetched.fileName, extractedText: text, deletedAt: null, projectId: "project-1" });
      log.push(`import ${file.id}`);
      items.set(file.id, { id: previous?.id ?? `item-${file.id}`, externalId: file.id, version: file.version, attachmentId: id, state: "synced", name: file.name, path: file.path, error: null });
      if (previous?.attachmentId) {
        attachments.get(previous.attachmentId)!.deletedAt = new Date();
        log.push(`retire ${previous.attachmentId}`);
      }
    },
    async skipItem(file, error) {
      const existing = items.get(file.id);
      items.set(file.id, { id: existing?.id ?? `item-${file.id}`, externalId: file.id, version: file.version, attachmentId: null, state: "skipped", name: file.name, path: file.path, error });
    },
    async removeItem(item) {
      if (item.attachmentId) attachments.get(item.attachmentId)!.deletedAt = new Date();
      items.delete(item.externalId);
      log.push(`remove ${item.externalId}`);
    },
    async relabelItem(item, file) {
      items.set(item.externalId, { ...item, name: file.name, path: file.path });
      log.push(`relabel ${item.externalId}`);
    },
  };
  return { port, items, attachments, log };
}

const folderSource = { kind: "folder" as const, externalId: "root-folder", name: "Q4 Planning", includeSubfolders: true };

test("a folder is walked breadth first, every page of every listing, subfolders only when asked", async () => {
  const drive = fakeDrive(sampleTree(), { pageSize: 2 });
  const listing = await listDriveFolderTree(drive.client, "root-folder", { includeSubfolders: true });
  assert.deepEqual(
    listing.files.map((file) => [file.path, file.name, file.version]),
    [
      ["", "Brief.md", "1"],
      ["", "logo.svg", "1"],
      ["", "Plan", "3"],
      ["Specs", "api.txt", "2"],
      ["Specs/2026", "notes.txt", "1"],
    ],
  );
  assert.equal(listing.folders, 3);
  assert.equal(listing.truncated, false);
  // Paged: the top folder has four children at two a page.
  const topPages = drive.calls.filter((url) => url.searchParams.get("q")?.startsWith("'root-folder' in parents"));
  assert.equal(topPages.length, 2);
  assert.equal(topPages[1].searchParams.get("pageToken"), "2");
  assert.ok(!listing.files.some((file) => file.id === "elsewhere"), "a file outside the folder is never listed");

  const flat = await listDriveFolderTree(fakeDrive(sampleTree()).client, "root-folder", { includeSubfolders: false });
  assert.deepEqual(flat.files.map((file) => file.name), ["Brief.md", "logo.svg", "Plan"]);
});

test("a folder past the ceilings is listed up to them and says it was cut", async () => {
  const listing = await listDriveFolderTree(fakeDrive(sampleTree()).client, "root-folder", {
    includeSubfolders: true,
    limits: { ...SOURCE_LIMITS, maxFiles: 2 },
  });
  assert.equal(listing.files.length, 2);
  assert.equal(listing.truncated, true);
  const shallow = await listDriveFolderTree(fakeDrive(sampleTree()).client, "root-folder", {
    includeSubfolders: true,
    limits: { ...SOURCE_LIMITS, maxDepth: 1 },
  });
  assert.ok(!shallow.files.some((file) => file.path === "Specs/2026"));
  assert.equal(shallow.truncated, true);
});

test("a sync plan matches Drive's own ids: added, changed by version, renamed, and gone", () => {
  const existing: SourceItemRecord[] = [
    { id: "i1", externalId: "a", version: "1", attachmentId: "att-a", state: "synced", name: "a.txt", path: "" },
    { id: "i2", externalId: "b", version: "1", attachmentId: "att-b", state: "synced", name: "b.txt", path: "" },
    { id: "i3", externalId: "c", version: "4", attachmentId: "att-c", state: "synced", name: "c.txt", path: "" },
    { id: "i4", externalId: "d", version: "1", attachmentId: "att-d", state: "synced", name: "d.txt", path: "" },
  ];
  const remote: DriveListedFile[] = [
    { id: "a", name: "a.txt", mimeType: "text/plain", size: 1, modifiedTime: null, path: "", version: "1" },
    { id: "b", name: "b.txt", mimeType: "text/plain", size: 1, modifiedTime: null, path: "", version: "2" },
    { id: "c", name: "c renamed.txt", mimeType: "text/plain", size: 1, modifiedTime: null, path: "Moved", version: "4" },
    { id: "e", name: "e.txt", mimeType: "text/plain", size: 1, modifiedTime: null, path: "", version: "1" },
  ];
  const plan = planSourceSync(existing, remote);
  assert.deepEqual(plan.add.map((file) => file.id), ["e"]);
  assert.deepEqual(plan.update.map(({ item }) => item.externalId), ["b"]);
  assert.deepEqual(plan.relabel.map(({ item }) => item.externalId), ["c"]);
  assert.deepEqual(plan.remove.map((item) => item.externalId), ["d"]);
  assert.equal(plan.unchanged, 1);
});

test("first sync mirrors the folder; the next picks up added, changed and removed files", async () => {
  const drive = fakeDrive(sampleTree());
  const store = memoryPort(drive.client);
  const first = await runSourceSync({ client: drive.client, source: folderSource, port: store.port });
  assert.equal(first.state, "ready");
  assert.equal(first.added, 4, "four files the project can take");
  assert.equal(first.fileCount, 4);
  // The SVG is refused by the same gate an upload passes, recorded once against
  // its version so it is not fetched again until it changes.
  assert.equal(first.skippedCount, 1);
  assert.equal(store.items.get("logo")?.state, "skipped");
  assert.match(store.items.get("logo")?.error ?? "", /can’t be attached/);
  // A Google Doc arrives as the Office export, named for it.
  const plan = [...store.attachments.values()].find((file) => file.fileName === "Plan.docx");
  assert.ok(plan, "the Doc was exported to .docx");

  // Unchanged since the last sync: no request for any file's bytes.
  store.log.length = 0;
  const quiet = await runSourceSync({ client: drive.client, source: folderSource, port: store.port });
  assert.deepEqual([quiet.added, quiet.updated, quiet.removed], [0, 0, 0]);
  assert.equal(store.log.length, 0, "nothing is fetched twice");

  // Someone edits a spec, adds a file, deletes the brief and renames the plan.
  drive.tree.get("api")!.version = 3;
  drive.tree.get("api")!.body = "The API rate limit is 900 requests a minute.";
  drive.tree.set("new", { id: "new", name: "Pricing.csv", mimeType: "text/csv", parent: "specs", version: 1, body: "tier,price\npro,20" });
  drive.tree.get("brief")!.trashed = true;
  const oldApi = store.items.get("api")!.attachmentId!;
  const second = await runSourceSync({ client: drive.client, source: folderSource, port: store.port });
  assert.equal(second.state, "ready");
  assert.deepEqual([second.added, second.updated, second.removed], [1, 1, 1]);
  assert.ok(store.attachments.get(oldApi)!.deletedAt, "the old copy of a changed file leaves the project");
  assert.ok(store.log.includes("remove brief"));
  const live = [...store.attachments.values()].filter((file) => !file.deletedAt);
  assert.deepEqual(live.map((file) => file.fileName).sort(), ["Plan.docx", "Pricing.csv", "api.txt", "notes.txt"]);
  assert.match(live.find((file) => file.fileName === "api.txt")!.extractedText, /900 requests/);
});

test("what a sync mirrors is what a chat in the project is given, and nothing it removed", async () => {
  const drive = fakeDrive(sampleTree());
  const store = memoryPort(drive.client);
  await runSourceSync({ client: drive.client, source: folderSource, port: store.port });

  // The chat route's own path (lib/chat/turn/project-context.ts): the project
  // row's live files, merged with its lineage, in the first user turn.
  const liveFiles = () =>
    [...store.attachments.values()]
      .filter((file) => file.projectId === "project-1" && !file.deletedAt)
      .map((file) => ({ id: file.id, fileName: file.fileName, extractedText: file.extractedText }));
  const project = mergeInheritedProjectContext([{ name: "Atlas", instructions: "Answer as the launch lead.", files: liveFiles() }]);
  const reference = buildProjectReferenceFiles(project, null);
  assert.match(reference, /Ship the Atlas launch on 4 December/);
  assert.match(reference, /600 requests a minute/);
  assert.match(buildProjectContext(project, null), /Answer as the launch lead/);

  drive.tree.get("brief")!.trashed = true;
  await runSourceSync({ client: drive.client, source: folderSource, port: store.port });
  const after = buildProjectReferenceFiles(mergeInheritedProjectContext([{ name: "Atlas", instructions: "", files: liveFiles() }]), null);
  assert.doesNotMatch(after, /4 December/, "a file deleted from the folder no longer reaches the chat");
  assert.match(after, /600 requests a minute/);
});

test("a refused token, a folder no longer shared or gone, keep what the project holds and say how to fix it", async () => {
  const drive = fakeDrive(sampleTree());
  const store = memoryPort(drive.client);
  await runSourceSync({ client: drive.client, source: folderSource, port: store.port });
  const held = [...store.attachments.values()].filter((file) => !file.deletedAt).length;

  for (const [status, code, words] of [
    [401, "reconnect", /reconnected/],
    [403, "forbidden", /Ask its owner/],
    [404, "not_found", /no longer in Google Drive/],
    [429, "rate_limited", /busy/],
    [500, "provider_error", /Couldn’t reach Google Drive/],
  ] as const) {
    const refusing = fakeDrive(sampleTree(), { fail: () => new Response(null, { status }) });
    const result = await runSourceSync({ client: refusing.client, source: folderSource, port: store.port });
    assert.equal(result.state, "error");
    assert.equal(result.errorCode, code, `HTTP ${status}`);
    assert.match(result.error ?? "", words);
    assert.equal(result.fileCount, 4, "the files already mirrored are still counted");
  }
  assert.equal([...store.attachments.values()].filter((file) => !file.deletedAt).length, held, "nothing was removed");

  drive.tree.get("root-folder")!.trashed = true;
  const trashed = await runSourceSync({ client: drive.client, source: folderSource, port: store.port });
  assert.equal(trashed.errorCode, "not_found");
  assert.equal([...store.attachments.values()].filter((file) => !file.deletedAt).length, held);
});

test("a token that expires mid-sync stops the sync instead of marking every file skipped", async () => {
  const drive = fakeDrive(sampleTree(), {
    fail: (url) => (url.pathname.endsWith("/export") ? new Response(null, { status: 401 }) : null),
  });
  const store = memoryPort(drive.client);
  const result = await runSourceSync({ client: drive.client, source: folderSource, port: store.port });
  assert.equal(result.state, "error");
  assert.equal(result.errorCode, "reconnect");
  assert.ok(![...store.items.values()].some((item) => item.externalId === "plan"), "the Doc is retried after reconnecting, not skipped");
});

test("a project at capacity stops adding files and says why", async () => {
  const drive = fakeDrive(sampleTree());
  const store = memoryPort(drive.client, 11);
  const result = await runSourceSync({ client: drive.client, source: folderSource, port: store.port });
  assert.equal(result.state, "error");
  assert.equal(result.errorCode, "capacity");
  assert.equal(result.added, 1, "the first file fits; the rest wait for room");
  assert.match(result.error ?? "", /knowledge is full/);
});

test("a single-file source mirrors that file and follows its versions", async () => {
  const drive = fakeDrive(sampleTree());
  const store = memoryPort(drive.client);
  const source = { kind: "file" as const, externalId: "api", name: "api.txt", includeSubfolders: false };
  const first = await runSourceSync({ client: drive.client, source, port: store.port });
  assert.deepEqual([first.state, first.added, first.fileCount], ["ready", 1, 1]);
  drive.tree.get("api")!.version = 9;
  const second = await runSourceSync({ client: drive.client, source, port: store.port });
  assert.equal(second.updated, 1);
  drive.tree.delete("api");
  const gone = await runSourceSync({ client: drive.client, source, port: store.port });
  assert.equal(gone.errorCode, "not_found");
});

test("the picker browses a folder, what was shared, or a search, folders first and offered whole", async () => {
  const drive = fakeDrive(sampleTree());
  const page = await browseDrive(drive.client, { view: "folder", parent: "root-folder" }, 1024 * 1024);
  assert.deepEqual(page.entries.map((entry) => [entry.name, entry.kind]), [
    ["Brief.md", "file"],
    ["logo.svg", "file"],
    ["Plan", "file"],
    ["Specs", "folder"],
  ]);
  assert.equal(page.entries.find((entry) => entry.name === "logo.svg")?.unavailable, "Can’t attach this type");
  assert.equal(page.entries.find((entry) => entry.kind === "folder")?.unavailable, null);
  assert.match(drive.calls.at(-1)!.searchParams.get("q")!, /^'root-folder' in parents and trashed = false/);

  const calls: URL[] = [];
  const client = new FirstPartyClient("google-drive", "t", async (input) => {
    calls.push(new URL(String(input)));
    return Response.json({ files: [] });
  });
  await browseDrive(client, { view: "shared" }, 1);
  await browseDrive(client, { view: "search", query: "it's" }, 1);
  assert.match(calls[0].searchParams.get("q")!, /^sharedWithMe = true/);
  assert.match(calls[1].searchParams.get("q")!, /^name contains 'it\\'s'/, "the query is quoted the way Drive escapes it");
  await assert.rejects(browseDrive(client, { view: "folder", parent: "../x" }, 1), /isn’t valid/);
});

test("Drive refusals map to the fix the page offers", () => {
  const cases: Array<[number, string]> = [[401, "reconnect"], [403, "forbidden"], [404, "not_found"], [429, "rate_limited"], [502, "provider_error"]];
  for (const [status, code] of cases) assert.equal(classifyDriveFailure(new ConnectorApiError(status), "X").code, code, `HTTP ${status}`);
  assert.equal(classifyDriveFailure(new Error("socket hang up"), "X").code, "provider_error");
});

test("the folder walk stops paging after reaching the file ceiling", async () => {
  const drive = fakeDrive(sampleTree(), { pageSize: 1 });
  const listing = await listDriveFolderTree(drive.client, "root-folder", {
    includeSubfolders: true,
    limits: { ...SOURCE_LIMITS, maxFiles: 1 },
  });
  assert.equal(listing.files.length, 1);
  assert.equal(listing.truncated, true);
  assert.equal(drive.calls.length, 1);
});

test("repeating an opaque page token ends the walk with an incomplete listing", async () => {
  let requests = 0;
  const client = new FirstPartyClient("google-drive", "fixture", async () => {
    assert.ok(++requests <= 2, "a repeated cursor should never be requested again");
    return Response.json({ files: [], nextPageToken: "cursor" });
  });
  const listing = await listDriveFolderTree(client, "root-folder", { includeSubfolders: true });
  assert.equal(listing.truncated, true);
  assert.equal(requests, 2);
});

test("files missing from an incomplete listing stay mirrored", async () => {
  const drive = fakeDrive(sampleTree());
  const store = memoryPort(drive.client);
  const input = { client: drive.client, source: folderSource, port: store.port };
  const before = await runSourceSync(input);
  const after = await runSourceSync({ ...input, limits: { ...SOURCE_LIMITS, maxDepth: 0 } });
  assert.equal(after.truncated, true);
  assert.equal(after.removed, 0);
  assert.equal(after.fileCount, before.fileCount);
  assert.ok(store.items.has("notes"));
});

test("a temporary provider failure leaves the file eligible for the next sync", async () => {
  let unavailable = true;
  const drive = fakeDrive(sampleTree(), {
    fail: (url) => unavailable && url.pathname.endsWith("/api") && url.searchParams.get("alt") === "media" ? new Response(null, { status: 503 }) : null,
  });
  const store = memoryPort(drive.client);
  const input = { client: drive.client, source: folderSource, port: store.port };
  const failed = await runSourceSync(input);
  assert.equal(failed.errorCode, "provider_error");
  assert.equal(store.items.has("api"), false);
  unavailable = false;
  const recovered = await runSourceSync(input);
  assert.equal(recovered.state, "ready");
  assert.equal(store.items.get("api")?.state, "synced");
});

test("empty pages still count toward the total page budget", async () => {
  let requests = 0;
  const client = new FirstPartyClient("google-drive", "fixture", async () => {
    assert.ok(++requests <= 3);
    return Response.json({ files: [], nextPageToken: String(requests) });
  });
  const listing = await listDriveFolderTree(client, "root-folder", {
    includeSubfolders: true, limits: { ...SOURCE_LIMITS, maxPages: 3 },
  });
  assert.equal(listing.truncated, true);
  assert.equal(requests, 3);
});

test("Drive can flag a listing incomplete even when there is no next page", async () => {
  const client = new FirstPartyClient("google-drive", "fixture", async (input) => {
    assert.match(new URL(String(input)).searchParams.get("fields") ?? "", /incompleteSearch/);
    return Response.json({ files: [], incompleteSearch: true });
  });
  const listing = await listDriveFolderTree(client, "root-folder", { includeSubfolders: true });
  assert.equal(listing.truncated, true);
});
