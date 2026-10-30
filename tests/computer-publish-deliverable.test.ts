/**
 * The agent publishes a file from its computer as a run deliverable
 * (docs/design/agents-v2/COMPUTERS_2026-10.md S5.3): a regular file of at most
 * 25 MB, typed by an extension allowlist, filed under a kind the web never
 * previews inline, stored unchanged, and downloaded as an attachment with its
 * own type and name. The download route re-derives the type through the
 * allowlist rather than trusting the stored column.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { describe, it } from "node:test";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
const stubs = new Map<string, unknown>();
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (stubs.has(request)) return stubs.get(request);
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const fileTypes = req("../src/lib/computer/file-types") as typeof import("@/lib/computer/file-types");
const { FakeProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const files = req("../src/lib/computer/files") as typeof import("@/lib/computer/files");

const handle = { name: "juno-agent-agent_1", volume: "juno-agent-agent_1" };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("the type a published file is served as", () => {
  it("picks the MIME type from the allowlist and anything else is octet-stream", () => {
    const expected: Record<string, [string, string]> = {
      "report.pdf": ["application/pdf", "pdf"],
      "chart.PNG": ["image/png", "image"],
      "photo.jpg": ["image/jpeg", "image"],
      "photo.jpeg": ["image/jpeg", "image"],
      "anim.gif": ["image/gif", "image"],
      "pic.webp": ["image/webp", "image"],
      "primes.csv": ["text/csv", "bundle"],
      "notes.txt": ["text/plain", "bundle"],
      "README.md": ["text/markdown", "bundle"],
      "data.json": ["application/json", "bundle"],
      "page.html": ["text/html", "bundle"],
      "memo.docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
      "sheet.xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "bundle"],
      "deck.pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "presentation"],
      "all.zip": ["application/zip", "archive"],
      "drawing.svg": ["application/octet-stream", "bundle"],
      "script.sh": ["application/octet-stream", "bundle"],
      "Makefile": ["application/octet-stream", "bundle"],
      ".hidden": ["application/octet-stream", "bundle"],
    };
    for (const [name, [mime, kind]] of Object.entries(expected)) {
      const type = fileTypes.computerFileType(name);
      assert.equal(type.mimeType, mime, name);
      assert.equal(type.kind, kind, name);
    }
  });

  it("is never filed under a kind the web previews inline (site, report, spreadsheet)", () => {
    for (const extension of ["html", "htm", "md", "csv", "xlsx", "zip", "svg", "txt", "json", "pdf", "png"]) {
      assert.equal(["site", "report", "spreadsheet"].includes(fileTypes.computerFileType(`f.${extension}`).kind), false, extension);
    }
  });

  it("a download is always an attachment, named for the file, its extension kept or added, and never a stored type off the list", () => {
    assert.equal(
      fileTypes.computerFileDisposition("primes.csv", "text/csv"),
      `attachment; filename="primes.csv"; filename*=UTF-8''primes.csv`
    );
    assert.equal(
      fileTypes.computerFileDisposition("Q3 primes", "text/csv"),
      `attachment; filename="Q3 primes.csv"; filename*=UTF-8''Q3%20primes.csv`
    );
    assert.match(fileTypes.computerFileDisposition('evil"\r\nX-Header: 1.txt', "text/plain"), /^attachment; filename="evil X-Header 1\.txt"/);
    assert.match(fileTypes.computerFileDisposition("Café.pdf", "application/pdf"), /filename="Caf_\.pdf"; filename\*=UTF-8''Caf%C3%A9\.pdf$/);
    assert.equal(fileTypes.computerFileDisposition("photo.jpeg", "image/jpeg").includes(".jpeg.jpg"), false);
    assert.equal(fileTypes.servableComputerMime("text/csv"), "text/csv");
    assert.equal(fileTypes.servableComputerMime("image/svg+xml"), "application/octet-stream");
    assert.equal(fileTypes.servableComputerMime("text/html; charset=utf-8"), "application/octet-stream");
    assert.equal(fileTypes.servableComputerMime(null), "application/octet-stream");
  });
});

describe("reading a computer file for publishing", () => {
  it("a regular file is read whole, unchanged, with its title, a stable identifier and its type", async () => {
    const fake = new FakeProvider();
    const bytes = randomBytes(3 * 1024 * 1024);
    await fake.writeFile(handle, "/home/agent/work/out/primes.csv", bytes);
    const file = await files.readComputerFileForPublish(fake, handle, "out/primes.csv");
    assert.equal(file.ok, true);
    if (!file.ok) return;
    assert.equal(file.path, "/home/agent/work/out/primes.csv");
    assert.equal(file.sha256, sha(bytes));
    assert.equal(sha(file.bytes), sha(bytes), "byte for byte");
    assert.equal(file.title, "primes.csv");
    assert.equal(file.identifier, "computer-primes.csv");
    assert.equal(file.type.mimeType, "text/csv");
    const titled = await files.readComputerFileForPublish(fake, handle, "/home/agent/work/out/primes.csv", "First primes");
    assert.equal(titled.ok && titled.title, "First primes");
  });

  it("refuses a missing path, a folder and a file over 25 MB, each with a sentence, reading nothing it should not", async () => {
    const fake = new FakeProvider();
    await fake.writeFile(handle, "/home/agent/work/dir/a.txt", "a");
    await fake.writeFile(handle, "/home/agent/work/huge.bin", Buffer.alloc(25 * 1024 * 1024 + 1));
    const missing = await files.readComputerFileForPublish(fake, handle, "/home/agent/work/nope.txt");
    assert.deepEqual(missing, { ok: false, message: "/home/agent/work/nope.txt does not exist on the computer. Nothing was published." });
    const folder = await files.readComputerFileForPublish(fake, handle, "/home/agent/work/dir");
    assert.equal(folder.ok, false);
    assert.match(folder.ok ? "" : folder.message, /not a regular file/);
    fake.calls = [];
    const huge = await files.readComputerFileForPublish(fake, handle, "/home/agent/work/huge.bin");
    assert.equal(huge.ok, false);
    assert.match(huge.ok ? "" : huge.message, /over the 25 MB limit/);
    assert.equal(fake.calls.some((c) => c.method === "readFile"), false, "a file over the limit is not read");
    await assert.rejects(files.readComputerFileForPublish(fake, handle, "/etc/passwd"), /Paths must stay inside \/home\/agent/);
  });
});

describe("the download route serves a computer file as it is", () => {
  const bytes = Buffer.from("2,3,5\n");
  let artifact: Record<string, unknown>;
  let version: Record<string, unknown>;
  stubs.set("@/lib/code-remote", { requireUser: async () => ({ user: { id: "user_1" }, error: null }) });
  stubs.set("@/lib/prisma", {
    prisma: {
      workArtifact: { findFirst: async () => artifact },
      workArtifactVersion: { findFirst: async () => version },
    },
  });
  stubs.set("@/lib/storage", { getObjectBytes: async () => ({ bytes: new Uint8Array(bytes) }) });
  const route = () => req("../src/app/api/work/artifacts/[id]/download/route") as { GET: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> };
  const download = () => route().GET(new Request("https://alevr.test/api/work/artifacts/art_1/download"), { params: Promise.resolve({ id: "art_1" }) });
  const base = (mimeType: string, origin: string, kind = "bundle", title = "primes.csv") => {
    artifact = {
      id: "art_1", sessionId: "s1", userId: "user_1", identifier: "computer-primes.csv", title, kind, mimeType,
      currentVersion: 1, validatedAt: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    };
    version = { id: "v1", artifactId: "art_1", version: 1, storageKey: "k", byteSize: bytes.byteLength, contentHash: sha(bytes), origin, validation: { ok: false } };
  };

  it("its own type and name, as an attachment, the bytes and their hash unchanged", async () => {
    base("text/csv", "computer");
    const res = await download();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv");
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="primes.csv"; filename*=UTF-8''primes.csv`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-juno-content-sha256"), sha(bytes));
    assert.equal(res.headers.get("x-juno-validated"), "false", "nothing opened it, and the route says so");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  });

  it("a stored type off the allowlist is served as octet-stream; an HTML file still only downloads", async () => {
    base("image/svg+xml", "computer", "bundle", "drawing.svg");
    const svg = await download();
    assert.equal(svg.headers.get("content-type"), "application/octet-stream");
    assert.match(svg.headers.get("content-disposition") ?? "", /^attachment; filename="drawing\.svg"/);
    base("text/html", "computer", "bundle", "page.html");
    const html = await download();
    assert.equal(html.headers.get("content-type"), "text/html");
    assert.match(html.headers.get("content-disposition") ?? "", /^attachment;/);
  });

  it("a generated deliverable is served exactly as before", async () => {
    base("text/csv", "generated", "report", "Summary");
    const res = await download();
    assert.equal(res.headers.get("content-type"), "text/markdown");
    assert.match(res.headers.get("content-disposition") ?? "", /filename="Summary\.md"/);
  });
});

describe("the Work runner stores a published file as a computer deliverable", () => {
  it("passes origin computer, the file's own disposition, records the artifact, and audits its size", () => {
    const runner = readFileSync("scripts/work-runner.ts", "utf8");
    const publish = runner.slice(runner.indexOf("async publish(request)"), runner.indexOf("// Pixel tools only for a model"));
    assert.ok(publish.length > 200, "the publish dependency is wired");
    assert.match(publish, /readComputerFileForPublish\(/);
    assert.match(publish, /origin: "computer"/);
    assert.match(publish, /disposition: computerFileDisposition\(file\.title, file\.type\.mimeType\)/);
    assert.match(publish, /input\.sink\.session\?\.recordArtifact\(artifact\.ref\)/);
    assert.match(publish, /kind: "file_published"[\s\S]*detail: \{ bytes: file\.bytes\.byteLength, runId: input\.runId \}/);
    assert.match(publish, /ok: false,\s*validator: "none"/, "never claims a validator opened it");
    assert.match(runner, /origin: input\.origin \?\? "generated"/, "the version records where it came from");
  });
});
