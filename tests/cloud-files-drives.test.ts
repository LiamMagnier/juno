import test from "node:test";
import assert from "node:assert/strict";
import { FirstPartyClient } from "@/lib/first-party-connectors/client";
import {
  CloudFileError,
  CloudFileTooLargeError,
  driveQueryLiteral,
  fetchCloudFile,
  googleExportFormats,
  graphCursor,
  listCloudFiles,
  matchesExport,
  readCappedBytes,
  resolveGoogleFile,
  resolveGraphItem,
  withExtension,
} from "@/lib/cloud-files/drives";
import type { CloudFileProvider } from "@/lib/cloud-files/shared";

/*
 * The drive adapters against fake Drive v3 and Graph responses: what each API
 * is asked (path, query, escaping), how its answer becomes picker rows, and
 * how a picked file's bytes are fetched, converted and capped. No network:
 * every reply is queued and an extra call fails the test.
 */

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");

function drive(provider: CloudFileProvider, replies: Array<unknown | Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new FirstPartyClient(provider, "provider-token", async (url, init) => {
    calls.push({ url: new URL(String(url)), init });
    assert.ok(replies.length, `unexpected extra API call: ${String(url)}`);
    const next = replies.shift();
    return next instanceof Response ? next : Response.json(next);
  });
  return { client, calls };
}

const bytes = (body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });
const limits = { maxBytes: 1024, tooLarge: "File is too large. Your plan allows up to 5 MB." };

test("Google's own formats export to Office first, then PDF or text; files with bytes are not exported", () => {
  assert.deepEqual(googleExportFormats("application/vnd.google-apps.document")?.map((f) => f.mimeType), [DOCX, "application/pdf", "text/plain"]);
  assert.deepEqual(googleExportFormats("application/vnd.google-apps.spreadsheet")?.map((f) => f.mimeType), [XLSX, "text/csv"]);
  assert.deepEqual(googleExportFormats("application/vnd.google-apps.presentation")?.map((f) => f.mimeType), [PPTX, "application/pdf", "text/plain"]);
  assert.deepEqual(googleExportFormats("application/vnd.google-apps.drawing")?.map((f) => f.mimeType), ["application/pdf"]);
  assert.equal(googleExportFormats("application/pdf"), null);
  assert.equal(googleExportFormats("toString"), null, "only own keys are formats");

  const doc = resolveGoogleFile({ id: "doc1", name: "Q3 plan", mimeType: "application/vnd.google-apps.document" });
  assert.ok(doc.ok);
  assert.deepEqual(doc.sources.map((s) => [s.fileName, s.mimeType, s.converted]), [
    ["Q3 plan.docx", DOCX, true],
    ["Q3 plan.pdf", "application/pdf", true],
    ["Q3 plan.txt", "text/plain", true],
  ]);
  assert.equal(doc.sources[0].path, `/drive/v3/files/doc1/export?mimeType=${encodeURIComponent(DOCX)}`);
  assert.equal(doc.size, null, "an export has no size until it is made");

  const pdf = resolveGoogleFile({ id: "p1", name: "Scan.pdf", mimeType: "application/pdf", size: "2048" });
  assert.ok(pdf.ok);
  assert.deepEqual(pdf.sources, [{ path: "/drive/v3/files/p1?alt=media&supportsAllDrives=true", fileName: "Scan.pdf", mimeType: "application/pdf", converted: false }]);
  assert.equal(pdf.size, 2048);

  assert.equal(withExtension("Budget.xlsx", "xlsx"), "Budget.xlsx");
  assert.equal(withExtension("  ", "docx"), "Untitled.docx");
});

test("what cannot be attached is said before a byte is fetched", () => {
  const cases: Array<[Parameters<typeof resolveGoogleFile>[0], string]> = [
    [{ id: "f", name: "Folder", mimeType: "application/vnd.google-apps.folder" }, "folder"],
    [{ id: "s", name: "Shortcut", mimeType: "application/vnd.google-apps.shortcut" }, "folder"],
    [{ id: "form", name: "Survey", mimeType: "application/vnd.google-apps.form" }, "not_exportable"],
    [{ id: "h", name: "page.html", mimeType: "text/html" }, "unsupported"],
    [{ id: "svg", name: "logo.svg", mimeType: "image/svg+xml" }, "unsupported"],
    [{ id: "heic", name: "IMG_1.HEIC", mimeType: "image/heic" }, "heic"],
  ];
  for (const [meta, reason] of cases) {
    const resolution = resolveGoogleFile(meta);
    assert.equal(resolution.ok, false, meta.name);
    if (!resolution.ok) assert.equal(resolution.reason, reason, meta.name);
  }
  // Graph: folders and OneNote packages are not files; legacy Office converts to PDF.
  assert.equal(resolveGraphItem({ id: "a" }, { name: "Docs", folder: { childCount: 3 } }).ok, false);
  assert.equal(resolveGraphItem({ id: "a" }, { name: "Notebook", package: { type: "oneNote" } }).ok, false);
  const legacy = resolveGraphItem({ id: "x!1", driveId: "b!drive" }, { name: "Budget.xls", file: { mimeType: "application/vnd.ms-excel" }, size: 900 });
  assert.ok(legacy.ok);
  assert.deepEqual(legacy.sources, [{ path: "/v1.0/drives/b!drive/items/x!1/content?format=pdf", fileName: "Budget.pdf", mimeType: "application/pdf", converted: true }]);
});

test("Drive listing: recent files by recency, folders excluded, rows carry the exported name and type", async () => {
  const { client, calls } = drive("google-drive", [
    {
      nextPageToken: "page-2",
      files: [
        { id: "doc1", name: "Q3 plan", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-30T10:00:00Z" },
        { id: "img1", name: "Photo.png", mimeType: "image/png", size: "2000000", modifiedTime: "2026-10-29T10:00:00Z" },
        { id: "form1", name: "Survey", mimeType: "application/vnd.google-apps.form" },
        { id: "bad id", name: "Not an id", mimeType: "text/plain" },
      ],
    },
  ]);
  const page = await listCloudFiles(client, { query: "", cursor: null, limit: 25, maxBytes: 1024 * 1024 });
  const url = calls[0].url;
  assert.equal(url.origin + url.pathname, "https://www.googleapis.com/drive/v3/files");
  assert.equal(url.searchParams.get("orderBy"), "recency desc");
  assert.equal(url.searchParams.get("q"), "trashed = false and mimeType != 'application/vnd.google-apps.folder' and mimeType != 'application/vnd.google-apps.shortcut'");
  assert.equal(url.searchParams.get("supportsAllDrives"), "true");
  assert.equal(calls[0].init?.redirect, "manual");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer provider-token");
  assert.equal(page.nextCursor, "page-2");
  assert.deepEqual(
    page.files.map((f) => [f.id, f.attachName, f.attachMime, f.size, f.unavailable]),
    [
      ["doc1", "Q3 plan.docx", DOCX, null, null],
      ["img1", "Photo.png", "image/png", 2000000, "Over 1 MB"],
      ["form1", "Survey", "application/vnd.google-apps.form", null, "Can’t be exported"],
    ],
    "an id Drive would never issue is dropped, not passed back to the browser",
  );
});

test("Drive search: names and text, quoted and escaped, sorted by relevance, paged by token", async () => {
  const { client, calls } = drive("google-drive", [{ files: [] }]);
  await listCloudFiles(client, { query: "  O'Brien \\ notes ", cursor: "tok", limit: 10, maxBytes: 1 });
  const url = calls[0].url;
  assert.equal(driveQueryLiteral("O'Brien \\ notes"), "'O\\'Brien \\\\ notes'");
  assert.match(url.searchParams.get("q") ?? "", / and \(name contains 'O\\'Brien \\\\ notes' or fullText contains 'O\\'Brien \\\\ notes'\)$/);
  assert.equal(url.searchParams.get("orderBy"), null, "Drive refuses to sort a fullText query");
  assert.equal(url.searchParams.get("pageToken"), "tok");
  assert.equal(url.searchParams.get("pageSize"), "10");
});

test("OneDrive listing: recent files, shared ones through remoteItem, folders dropped", async () => {
  const { client, calls } = drive("microsoft-365", [
    {
      value: [
        { id: "own1", name: "Report.docx", size: 300, lastModifiedDateTime: "2026-10-30T09:00:00Z", file: { mimeType: DOCX } },
        { id: "outer", name: "Shared deck.pptx", lastModifiedDateTime: "2026-10-29T09:00:00Z", remoteItem: { id: "remote!7", size: 700, file: { mimeType: PPTX }, parentReference: { driveId: "b!other" } } },
        { id: "dir", name: "Projects", folder: { childCount: 2 } },
      ],
    },
  ]);
  const page = await listCloudFiles(client, { query: "", cursor: null, limit: 25, maxBytes: 4096 });
  assert.equal(calls[0].url.href, "https://graph.microsoft.com/v1.0/me/drive/recent");
  assert.deepEqual(
    page.files.map((f) => [f.id, f.driveId, f.name, f.size]),
    [
      ["own1", null, "Report.docx", 300],
      ["remote!7", "b!other", "Shared deck.pptx", 700],
    ],
  );
  assert.equal(page.nextCursor, null, "recent is one page");
});

test("OneDrive listing falls back to the drive's top level where recent is not served", async () => {
  const { client, calls } = drive("microsoft-365", [
    new Response(null, { status: 404 }),
    {
      value: [
        { id: "old", name: "Old.txt", lastModifiedDateTime: "2025-01-01T00:00:00Z", file: { mimeType: "text/plain" } },
        { id: "new", name: "New.txt", lastModifiedDateTime: "2026-10-01T00:00:00Z", file: { mimeType: "text/plain" } },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc",
    },
  ]);
  const page = await listCloudFiles(client, { query: "", cursor: null, limit: 25, maxBytes: 4096 });
  assert.equal(calls[1].url.pathname, "/v1.0/me/drive/root/children");
  assert.deepEqual(page.files.map((f) => f.id), ["new", "old"], "newest first");
  assert.equal(page.nextCursor, "https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc");
});

test("OneDrive search doubles quotes, and a cursor is held to Graph's drive APIs", async () => {
  const { client, calls } = drive("microsoft-365", [{ value: [] }]);
  await listCloudFiles(client, { query: "Q3 'final'", cursor: null, limit: 25, maxBytes: 1 });
  assert.equal(calls[0].url.pathname, "/v1.0/me/drive/root/search(q='Q3%20''final''')");
  assert.equal(calls[0].url.searchParams.get("$top"), "25");

  assert.equal(graphCursor("https://graph.microsoft.com/v1.0/drives/b!x/root/children?$skiptoken=1"), "https://graph.microsoft.com/v1.0/drives/b!x/root/children?$skiptoken=1");
  for (const cursor of [
    "https://attacker.example/v1.0/me/drive/recent",
    "https://graph.microsoft.com/v1.0/me/messages",
    "https://graph.microsoft.com/beta/me/drive/recent",
    "https://user:pass@graph.microsoft.com/v1.0/me/drive/recent",
  ]) {
    assert.throws(() => graphCursor(cursor), (error: unknown) => error instanceof CloudFileError && error.status === 400, cursor);
  }
});

test("fetching a Google Doc reads Drive's metadata, never the browser's, and exports it as .docx", async () => {
  const { client, calls } = drive("google-drive", [
    { id: "doc1", name: "Q3 plan", mimeType: "application/vnd.google-apps.document" },
    bytes(ZIP),
  ]);
  const file = await fetchCloudFile(client, { id: "doc1" }, limits);
  assert.equal(calls[0].url.pathname, "/drive/v3/files/doc1");
  assert.equal(calls[0].url.searchParams.get("supportsAllDrives"), "true");
  assert.equal(calls[1].url.pathname, "/drive/v3/files/doc1/export");
  assert.equal(calls[1].url.searchParams.get("mimeType"), DOCX);
  assert.deepEqual({ fileName: file.fileName, mimeType: file.mimeType, size: file.bytes.byteLength }, { fileName: "Q3 plan.docx", mimeType: DOCX, size: ZIP.byteLength });
});

test("an export Drive refuses, or one over the cap, falls back to the next format", async () => {
  const { client, calls } = drive("google-drive", [
    { id: "doc1", name: "Big doc", mimeType: "application/vnd.google-apps.document" },
    new Response("exportSizeLimitExceeded", { status: 403 }),
    bytes(new Uint8Array(2048)),
    bytes(new TextEncoder().encode("Just the words")),
  ]);
  const file = await fetchCloudFile(client, { id: "doc1" }, limits);
  assert.deepEqual(calls.slice(1).map((c) => c.url.searchParams.get("mimeType")), [DOCX, "application/pdf", "text/plain"]);
  assert.equal(file.fileName, "Big doc.txt");
  assert.equal(file.mimeType, "text/plain");
});

test("an export that is not the format asked for is not the file", async () => {
  assert.equal(matchesExport(DOCX, ZIP), true);
  assert.equal(matchesExport(DOCX, new TextEncoder().encode("<html>")), false);
  assert.equal(matchesExport("application/pdf", PDF_BYTES), true);
  assert.equal(matchesExport("application/pdf", new TextEncoder().encode("<html>")), false);
  const { client } = drive("google-drive", [
    { id: "draw", name: "Diagram", mimeType: "application/vnd.google-apps.drawing" },
    bytes(new TextEncoder().encode("<html>Sign in</html>")),
  ]);
  await assert.rejects(fetchCloudFile(client, { id: "draw" }, limits), (error: unknown) => error instanceof CloudFileError && error.status === 502);
});

test("the size cap holds three ways: Drive's size, the declared length, and the bytes as they stream", async () => {
  {
    const { client, calls } = drive("google-drive", [{ id: "big", name: "Video.pdf", mimeType: "application/pdf", size: "4096" }]);
    await assert.rejects(fetchCloudFile(client, { id: "big" }, limits), (error: unknown) => error instanceof CloudFileError && error.status === 413 && error.message === limits.tooLarge);
    assert.equal(calls.length, 1, "nothing is downloaded once the metadata says it will not fit");
  }
  {
    const { client } = drive("microsoft-365", [
      { id: "i1", name: "Notes.txt", file: { mimeType: "text/plain" } },
      bytes(new Uint8Array(10), { "content-length": "999999" }),
    ]);
    await assert.rejects(fetchCloudFile(client, { id: "i1" }, limits), (error: unknown) => error instanceof CloudFileError && error.code === "payload_too_large");
  }
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(512));
    },
  });
  await assert.rejects(readCappedBytes(new Response(endless), 1024), CloudFileTooLargeError);
  assert.ok(pulled <= 4, "reading stops just past the cap");
  assert.equal((await readCappedBytes(new Response(new Uint8Array(1024)), 1024)).byteLength, 1024, "exactly the cap fits");
});

test("OneDrive downloads read the item's drive, and a malformed reference never reaches a URL", async () => {
  const { client, calls } = drive("microsoft-365", [
    { id: "remote!7", name: "Deck.pptx", size: 8, file: { mimeType: PPTX } },
    bytes(ZIP),
  ]);
  const file = await fetchCloudFile(client, { id: "remote!7", driveId: "b!other" }, limits);
  assert.equal(calls[0].url.pathname, "/v1.0/drives/b!other/items/remote!7");
  assert.equal(calls[1].url.pathname, "/v1.0/drives/b!other/items/remote!7/content");
  assert.equal(file.fileName, "Deck.pptx");

  const none = drive("google-drive", []);
  for (const ref of [{ id: "../../me" }, { id: "a/b" }, { id: ".." }, { id: "ok", driveId: "b!x" }]) {
    await assert.rejects(fetchCloudFile(none.client, ref, limits), (error: unknown) => error instanceof CloudFileError && error.status === 400);
  }
});

test("drive refusals become sentences; provider bodies are never echoed", async () => {
  const cases: Array<[number, number, string]> = [
    [401, 409, "connector_reconnect"],
    [404, 404, "not_found"],
    [429, 429, "rate_limited"],
    [500, 502, "provider_error"],
  ];
  for (const [upstream, status, code] of cases) {
    const { client } = drive("google-drive", [new Response("secret provider detail", { status: upstream })]);
    await assert.rejects(fetchCloudFile(client, { id: "f1" }, limits), (error: unknown) => {
      assert.ok(error instanceof CloudFileError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /secret provider detail/);
      return true;
    });
  }
  const { client } = drive("google-drive", [{ id: "f1", name: "Locked.pdf", mimeType: "application/pdf" }, new Response(null, { status: 403 })]);
  await assert.rejects(fetchCloudFile(client, { id: "f1" }, limits), (error: unknown) => error instanceof CloudFileError && error.code === "forbidden");
});
