/**
 * The person adds a file to the agent's computer (docs/design/agents-v2/COMPUTERS_2026-10.md
 * S5.2): `POST /api/agents/[id]/computer/files` with the raw bytes and the
 * name in `X-File-Name`. Caps (Content-Length and the bytes actually sent),
 * names (last segment only, no control characters, no leading dot, at most
 * 200 characters), collisions (" (2)"), the disk quota, gating (plan, server,
 * asleep, the hourly limit), the upload working while the person holds control,
 * and the audit (its size only). Through the real route, store and fake provider.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
const stubs = new Map<string, unknown>();
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (stubs.has(request)) return stubs.get(request);
  return origLoad.call(this, request, parent, isMain);
};

let currentUser = "pro_1";
let rateLimited = false;
const rateKeys: Array<{ key: string; limit: number; windowSec: number }> = [];
stubs.set("@/lib/code-remote", { requireUser: async () => ({ user: { id: currentUser }, error: null }) });
stubs.set("@/lib/agents/store", {
  findAgent: async (_userId: string, agentId: string) => ({ id: agentId, name: "Mira" }),
  recordAgentEvent: async () => undefined,
});
stubs.set("@/lib/session", { getCurrentDeviceSessionId: async () => "device_1" });
stubs.set("@/lib/rate-limit", {
  rateLimit: async (input: { key: string; limit: number; windowSec: number }) => {
    rateKeys.push(input);
    return { success: !rateLimited, remaining: 1, resetAt: new Date() };
  },
});

const req = createRequire(import.meta.url);
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const access = req("../src/lib/computer/access") as typeof import("@/lib/computer/access");
const fileTypes = req("../src/lib/computer/file-types") as typeof import("@/lib/computer/file-types");

type Route = { POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> };
const filesRoute = () => req("../src/app/api/agents/[id]/computer/files/route") as Route;
const handleFor = (agentId: string) => ({ name: `juno-agent-${agentId}`, volume: `juno-agent-${agentId}` });

async function upload(agentId: string, name: string | null, body: Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  const init: RequestInit & { duplex?: string } = {
    method: "POST",
    headers: { "content-type": "application/octet-stream", ...(name === null ? {} : { "x-file-name": encodeURIComponent(name) }), ...headers },
    body: body as BodyInit,
  };
  if (body instanceof ReadableStream) init.duplex = "half";
  const res = await filesRoute().POST(new Request(`https://alevr.test/api/agents/${agentId}/computer/files`, init), { params: Promise.resolve({ id: agentId }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("adding a file to the computer's inbox", () => {
  let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;
  const KEYS = ["AGENT_COMPUTER_PROVIDER", "AGENT_COMPUTER_ROLLOUT", "AGENT_COMPUTER_ALLOWLIST", "AGENT_COMPUTER_UPLOAD_MAX_MB"];
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    process.env.AGENT_COMPUTER_ROLLOUT = "plans";
    delete process.env.AGENT_COMPUTER_UPLOAD_MAX_MB;
    resetComputerProviderCache();
    access.resetComputerAvailabilityCacheForTest();
    fakeComputerProvider.reset();
    memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    memDb.accessUsers.set("pro_1", { id: "pro_1", email: null, emailVerified: null, plan: "PRO" });
    memDb.accessUsers.set("free_1", { id: "free_1", email: null, emailVerified: null, plan: "FREE" });
    currentUser = "pro_1";
    rateLimited = false;
    rateKeys.length = 0;
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
  });
  afterEach(() => {
    store.setComputerStorePersistenceForTest(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetComputerProviderCache();
  });

  it("writes the bytes unchanged into ~/work/inbox as the person, and audits its size only", async () => {
    const bytes = randomBytes(1024 * 1024);
    const res = await upload("agent_1", "Q3 report (final).pdf", bytes);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { name: "Q3 report (final).pdf", path: "/home/agent/work/inbox/Q3 report (final).pdf", sizeBytes: bytes.byteLength });
    const stored = await fakeComputerProvider.readFile(handleFor("agent_1"), "/home/agent/work/inbox/Q3 report (final).pdf", { maxBytes: 2 * 1024 * 1024 });
    assert.equal(createHash("sha256").update(stored).digest("hex"), createHash("sha256").update(bytes).digest("hex"), "byte for byte");
    const write = fakeComputerProvider.calls.find((c) => c.method === "writeFile");
    assert.deepEqual(write?.args[2], { by: "person" }, "the launcher's helper mode, not the agent's");
    const audit = memDb.audits.find((a) => a.kind === "file_uploaded");
    assert.ok(audit);
    assert.deepEqual(audit.detail, { bytes: bytes.byteLength }, "never the name or the path");
    assert.equal(audit.actor, "web");
    assert.deepEqual(rateKeys.at(-1), { key: "agents:computer-upload:pro_1:agent_1", limit: 30, windowSec: 3600 });
  });

  it("a name already in the inbox gets (2), then (3); the name is the last path segment, NFC", async () => {
    assert.equal((await upload("agent_1", "notes.txt", Buffer.from("one"))).body.name, "notes.txt");
    assert.equal((await upload("agent_1", "notes.txt", Buffer.from("two"))).body.name, "notes (2).txt");
    assert.equal((await upload("agent_1", "notes.txt", Buffer.from("three"))).body.name, "notes (3).txt");
    assert.equal((await upload("agent_1", "C:\\fakepath\\README", Buffer.from("x"))).body.name, "README");
    assert.equal((await upload("agent_1", "../../etc/passwd", Buffer.from("x"))).body.path, "/home/agent/work/inbox/passwd");
    assert.equal((await upload("agent_1", "cafe\u0301.txt", Buffer.from("x"))).body.name, "café.txt");
    const first = await fakeComputerProvider.readFile(handleFor("agent_1"), "/home/agent/work/inbox/notes.txt");
    assert.equal(first.toString(), "one", "nothing was overwritten");
    assert.equal(fileTypes.freeInboxName("a.tar", new Set(["a.tar", "a (2).tar"])), "a (3).tar");
    assert.equal(fileTypes.freeInboxName("Makefile", new Set(["Makefile"])), "Makefile (2)");
  });

  it("refuses names it can't use, with a sentence, and writes nothing", async () => {
    const cases: Array<[string | null, RegExp]> = [
      [null, /Choose a file/],
      ["", /Choose a file/],
      [".env", /start with a dot/],
      ["dir/.ssh", /start with a dot/],
      ["bad\nname.txt", /characters the computer can't use/],
      ["tab\u0007.txt", /characters the computer can't use/],
      ["x".repeat(201), /longer than 200 characters/],
      ["..", /Choose a file/],
    ];
    for (const [name, message] of cases) {
      const res = await upload("agent_1", name, Buffer.from("x"));
      assert.equal(res.status, 400, String(name));
      assert.match(String(res.body.message), message, String(name));
    }
    const malformed = await filesRoute().POST(
      new Request("https://alevr.test/api/agents/agent_1/computer/files", { method: "POST", headers: { "x-file-name": "%E0%A4%A" }, body: "x" }),
      { params: Promise.resolve({ id: "agent_1" }) }
    );
    assert.equal(malformed.status, 400);
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "writeFile"), false);
    assert.equal(memDb.audits.some((a) => a.kind === "file_uploaded"), false);
    assert.ok(fileTypes.inboxFileName("x".repeat(200)).ok, "200 characters is allowed");
  });

  it("caps the size from Content-Length before reading, and while reading when the length lies", async () => {
    process.env.AGENT_COMPUTER_UPLOAD_MAX_MB = "1";
    const declared = await upload("agent_1", "big.bin", Buffer.alloc(16), { "content-length": String(2 * 1024 * 1024) });
    assert.equal(declared.status, 413);
    assert.equal(declared.body.message, "That file is larger than the 1 MB limit for adding files to the computer.");
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const streamed = await upload("agent_1", "big.bin", endless);
    assert.equal(streamed.status, 413);
    assert.ok(pulled <= 20, `stopped reading soon after the cap (${pulled} pieces of 64 KB)`);
    const empty = await upload("agent_1", "empty.txt", new Uint8Array());
    assert.equal(empty.status, 400);
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "writeFile"), false);
    process.env.AGENT_COMPUTER_UPLOAD_MAX_MB = "500";
    const { env } = req("../src/lib/env") as typeof import("@/lib/env");
    assert.equal(env.agentComputer.uploadMaxMb, 25, "never above 25 MB, whatever the env says");
  });

  it("refuses a computer over its disk quota, or that this file would put over it", async () => {
    const row = memDb.rows.get("agent_1")!;
    row.diskMb = 10_300;
    const full = await upload("agent_1", "a.txt", Buffer.from("x"));
    assert.equal(full.status, 409);
    assert.equal(full.body.error, "disk_full");
    row.diskMb = 10_240 - 0.5;
    const tipping = await upload("agent_1", "b.bin", Buffer.alloc(1024 * 1024));
    assert.equal(tipping.status, 409);
    row.diskMb = 100;
    assert.equal((await upload("agent_1", "c.txt", Buffer.from("x"))).status, 200);
  });

  it("is gated: plan, server off, asleep, the hourly limit; a refusal is audited without a file", async () => {
    currentUser = "free_1";
    const free = await upload("agent_1", "a.txt", Buffer.from("x"));
    assert.equal(free.status, 403);
    assert.equal(free.body.error, "plan");
    assert.ok(memDb.audits.some((a) => a.userId === "free_1" && a.kind === "refused" && a.detail.reason === "plan"));
    currentUser = "pro_1";

    await store.sleepComputer("pro_1", "agent_1");
    const asleep = await upload("agent_1", "a.txt", Buffer.from("x"));
    assert.equal(asleep.status, 409);
    assert.deepEqual(asleep.body, { error: "asleep", message: "Wake the computer first to add a file." });
    assert.equal((await upload("agent_2", "a.txt", Buffer.from("x"))).status, 409, "no computer at all: nothing is created");
    assert.equal(memDb.rows.has("agent_2"), false);

    rateLimited = true;
    const limited = await upload("agent_1", "a.txt", Buffer.from("x"));
    assert.equal(limited.status, 429);
    assert.match(String(limited.body.message), /up to 30 files an hour/);
    rateLimited = false;

    process.env.AGENT_COMPUTER_PROVIDER = "";
    resetComputerProviderCache();
    const off = await upload("agent_1", "a.txt", Buffer.from("x"));
    assert.equal(off.status, 403);
    assert.equal(off.body.error, "server_off");
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "writeFile"), false);
  });

  it("works while the person holds control (the agent's own writes are refused then)", async () => {
    await store.openComputerViewSession("pro_1", "agent_1", "control", { deviceSessionId: "device_1" });
    assert.equal(fakeComputerProvider.isFrozen(handleFor("agent_1")), true, "the agent is frozen for the take over");
    const res = await upload("agent_1", "for-mira.txt", Buffer.from("hello"));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assert.rejects(fakeComputerProvider.writeFile(handleFor("agent_1"), "/home/agent/work/x.txt", "agent"), /did not respond/);
  });

  it("never answers with a raw error", async () => {
    fakeComputerProvider.writeFile = async () => {
      throw new Error("EACCES /var/lib/docker/volumes/juno-agent-agent_1/_data at 10.0.0.4");
    };
    try {
      const res = await upload("agent_1", "a.txt", Buffer.from("x"));
      assert.equal(res.status, 400);
      assert.equal(JSON.stringify(res.body).includes("10.0.0.4"), false);
      assert.equal(JSON.stringify(res.body).includes("/var/lib/docker"), false);
    } finally {
      delete (fakeComputerProvider as { writeFile?: unknown }).writeFile;
    }
  });
});
