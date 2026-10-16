/**
 * The Files dialog, against the real route (GET /api/agents/[id]/computer/files)
 * and the real store on the fake computer provider.
 *
 * It was broken twice over: the transport read `files` while the route
 * answers `{ path, entries }`, so every folder looked empty and said "Nothing
 * saved yet.", a 409 (asleep) said the same, and each download link pointed
 * at a `/files/{name}` route that does not exist.
 */
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

const USER = { id: "user_files" };
const AGENT_ID = "agent_files";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  // The route's session and agent lookups, without a database.
  if (request === "@/lib/code-remote") return { requireUser: async () => ({ user: USER, error: null }) };
  if (request === "@/lib/agents/store") {
    return {
      findAgent: async (userId: string, agentId: string) => (userId === USER.id && agentId === AGENT_ID ? { id: agentId } : null),
      recordAgentEvent: async () => undefined,
    };
  }
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const errors = req("../src/lib/computer/errors") as typeof import("@/lib/computer/errors");
const route = req("../src/app/api/agents/[id]/computer/files/route") as typeof import("@/app/api/agents/[id]/computer/files/route");
const transport = req("../src/components/agents/agents-transport") as typeof import("@/components/agents/agents-transport");

const realFetch = globalThis.fetch;
const requested: string[] = [];

/** Every request the transport makes goes to the real route handler. */
function routeFetchToFilesRoute() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://alevr.test");
    requested.push(`${url.pathname}${url.search}`);
    assert.equal(url.pathname, `/api/agents/${AGENT_ID}/computer/files`, "the only files route there is");
    return route.GET(new Request(url), { params: Promise.resolve({ id: AGENT_ID }) });
  }) as typeof fetch;
}

describe("Files: the transport reads what the route answers", () => {
  const prevProvider = process.env.AGENT_COMPUTER_PROVIDER;
  let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;

  beforeEach(async () => {
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    resetComputerProviderCache();
    fakeComputerProvider.reset();
    memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    requested.length = 0;
    routeFetchToFilesRoute();
    const awake = await store.ensureAwake(USER.id, AGENT_ID, { autoEnable: true });
    await fakeComputerProvider.writeFile(awake.handle, "/home/agent/work/report.pdf", Buffer.from("%PDF-1.7 report"));
    await fakeComputerProvider.writeFile(awake.handle, "/home/agent/work/receipts/may.txt", Buffer.from("paid"));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    store.setComputerStorePersistenceForTest(null);
    if (prevProvider === undefined) delete process.env.AGENT_COMPUTER_PROVIDER;
    else process.env.AGENT_COMPUTER_PROVIDER = prevProvider;
    resetComputerProviderCache();
  });

  it("maps entries with their type, size and path, and opens folders", async () => {
    const outcome = await transport.fetchComputerFiles(AGENT_ID);
    assert.equal(outcome.kind, "ok");
    if (outcome.kind !== "ok") return;
    assert.equal(outcome.value.path, "/home/agent/work");
    const byName = new Map(outcome.value.entries.map((entry) => [entry.name, entry]));
    assert.deepEqual(
      { type: byName.get("receipts")?.type, path: byName.get("receipts")?.path },
      { type: "directory", path: "/home/agent/work/receipts" }
    );
    assert.deepEqual(
      { type: byName.get("report.pdf")?.type, path: byName.get("report.pdf")?.path, size: byName.get("report.pdf")?.sizeBytes },
      { type: "file", path: "/home/agent/work/report.pdf", size: Buffer.byteLength("%PDF-1.7 report") }
    );

    const folder = await transport.fetchComputerFiles(AGENT_ID, "/home/agent/work/receipts");
    assert.equal(folder.kind, "ok");
    if (folder.kind !== "ok") return;
    assert.equal(folder.value.path, "/home/agent/work/receipts");
    assert.deepEqual(folder.value.entries.map((entry) => entry.name), ["may.txt"]);
    assert.equal(requested[1], `/api/agents/${AGENT_ID}/computer/files?path=%2Fhome%2Fagent%2Fwork%2Freceipts`);
  });

  it("download links go to the files route in download mode, and that route serves the file", async () => {
    const href = transport.computerFileDownloadUrl(AGENT_ID, "/home/agent/work/report.pdf");
    assert.equal(href, `/api/agents/${AGENT_ID}/computer/files?path=%2Fhome%2Fagent%2Fwork%2Freport.pdf&download=1`);
    const res = await globalThis.fetch(href);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="report\.pdf"/);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString("utf8"), "%PDF-1.7 report");
  });

  it("a 409 (asleep) says the route's own sentence, never an empty folder", async () => {
    await store.sleepComputer(USER.id, AGENT_ID);
    const outcome = await transport.fetchComputerFiles(AGENT_ID);
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    assert.equal(outcome.status, 409);
    assert.equal(outcome.message, "Wake the computer first to browse its files.");
  });

  it("a 400 (a refused path) says the route's own sentence", async () => {
    const outcome = await transport.fetchComputerFiles(AGENT_ID, "/etc");
    assert.equal(outcome.kind, "failed");
    if (outcome.kind !== "failed") return;
    assert.equal(outcome.status, 400);
    // The provider's refusal or the store's, whichever caught it first.
    assert.match(outcome.message, /stay inside \/home\/agent/);
    assert.match(errors.COMPUTER_PATH_REFUSED, /stay inside \/home\/agent/);
  });
});
