/**
 * Losing the computer host mid-run (docs/design/agents-v2/COMPUTERS_2026-10.md
 * S3.3): the real RemoteComputerProvider, the real store on its in-memory
 * persistence and the real sweep, against a stub host that is stopped and
 * started again. While it is gone, tool calls get the unreachable sentence,
 * nothing is recreated or reaped, the outage is not metered against the weekly
 * allowance, and the panel says the computers can't be reached; at the first
 * contact afterwards metering resumes and the outage is audited with its length.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Module, { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const sweep = req("../src/lib/computer/sweep") as typeof import("@/lib/computer/sweep");
const access = req("../src/lib/computer/access") as typeof import("@/lib/computer/access");
const copy = req("../src/lib/computer/access-copy") as typeof import("@/lib/computer/access-copy");
const errors = req("../src/lib/computer/errors") as typeof import("@/lib/computer/errors");
const remote = req("../src/lib/computer/remote") as typeof import("@/lib/computer/remote");
const providerModule = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");

const TOKEN = "f".repeat(64);
const KEYS = ["COMPUTER_PROVIDER", "AGENT_COMPUTER_PROVIDER", "COMPUTER_HOST_URL", "COMPUTER_HOST_TOKEN", "AGENT_COMPUTER_ROLLOUT", "AUTH_SECRET", "AGENT_COMPUTER_COST_USD_PER_MIN", "COMPUTER_COST_MICRO_USD_PER_SECOND"];
const saved: Record<string, string | undefined> = {};

/** A computer host that keeps containers in memory, and can be switched off. */
class StubHost {
  server: Server | null = null;
  port = 0;
  calls: string[] = [];
  containers = new Map<string, string>();

  async up(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://stub");
        const call = `${request.method} ${url.pathname}`;
        this.calls.push(call);
        const reply = (status: number, body: unknown) => {
          const data = Buffer.from(JSON.stringify(body));
          response.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
          response.end(data);
        };
        if (request.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "unauthorized" });
        const match = url.pathname.match(/^\/v1\/computers\/(juno-agent-[A-Za-z0-9_-]+)(?:\/(.+))?$/);
        if (call === "GET /v1/available" || call === "GET /v1/preflight") return reply(200, { ok: true });
        if (call === "GET /v1/image") return reply(200, { id: "sha256:stub", label: "pipe-v4", createdAt: new Date().toISOString() });
        if (call === "GET /v1/owned") {
          return reply(200, { containers: [...this.containers].map(([name, state]) => ({ name, agentId: name.slice(11), userId: "u_x", state })), volumes: [...this.containers.keys()] });
        }
        if (call === "POST /v1/computers") {
          const { agentId } = JSON.parse(Buffer.concat(chunks).toString()) as { agentId: string };
          const name = `juno-agent-${agentId}`;
          if (!this.containers.has(name)) this.containers.set(name, "exited");
          return reply(200, { name, volume: name });
        }
        if (!match) return reply(404, { error: "not_found" });
        const [, name, action = ""] = match;
        if (!this.containers.has(name)) return reply(404, { error: "no_such_container" });
        if (action === "state") return reply(200, { state: this.containers.get(name) });
        if (action === "start" || action === "unpause") this.containers.set(name, "running");
        if (action === "stop") this.containers.set(name, "exited");
        if (action === "pause") this.containers.set(name, "paused");
        if (request.method === "DELETE" && !action) this.containers.delete(name);
        if (action === "disk") return reply(200, { mb: 3 });
        if (action === "browser-sandbox") return reply(200, { state: "off" });
        if (action === "outdated") return reply(200, { outdated: false });
        if (action === "vnc" && request.method === "GET") return reply(200, { running: false });
        return reply(200, { ok: true });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, "127.0.0.1", () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async down(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const host = new StubHost();
let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;

function resetCaches(): void {
  remote.resetRemoteComputerProviderForTest();
  providerModule.resetComputerProviderCache();
  access.resetComputerAvailabilityCacheForTest();
}

before(async () => {
  for (const key of KEYS) saved[key] = process.env[key];
  await host.up();
  process.env.COMPUTER_PROVIDER = "remote";
  delete process.env.AGENT_COMPUTER_PROVIDER;
  process.env.COMPUTER_HOST_URL = `http://127.0.0.1:${host.port}`;
  process.env.COMPUTER_HOST_TOKEN = TOKEN;
  process.env.AGENT_COMPUTER_ROLLOUT = "plans";
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";
  delete process.env.AGENT_COMPUTER_COST_USD_PER_MIN;
  delete process.env.COMPUTER_COST_MICRO_USD_PER_SECOND;
  resetCaches();
  sweep.resetSweepLogsForTest();
  sweep.resetOrphanTrackingForTest();
  memDb = store.createInMemoryComputerPersistence();
  store.setComputerStorePersistenceForTest(memDb);
  memDb.accessUsers.set("pro_1", { id: "pro_1", email: null, emailVerified: null, plan: "PRO" });
});

after(async () => {
  store.setComputerStorePersistenceForTest(null);
  await host.down();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetCaches();
});

describe("losing the computer host mid-run", () => {
  const MINUTE = 60_000;
  let handle: { name: string; volume: string };
  let containerRef: string | null = null;
  // The outage: the computer woke 10 minutes before `t0`, the last contact was 5 minutes before.
  const t0 = Date.now();
  const resumedAt = new Date(t0 - 10 * MINUTE);
  const contactAt = new Date(t0 - 5 * MINUTE);

  it("wakes through the host (the setup)", async () => {
    const awake = await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    handle = awake.handle;
    assert.equal(awake.row.status, "awake");
    assert.ok(awake.row.lastContactAt, "a wake is a contact");
    assert.equal(providerModule.computerProvider()?.name, "remote");
    containerRef = awake.row.containerRef;
    await memDb.updateByAgent("pro_1", "agent_1", { lastResumedAt: resumedAt, lastContactAt: contactAt, lastActiveAt: new Date(t0) });
    await host.down();
    host.calls = [];
  });

  it("tool calls get the unreachable sentence, and a wake leaves the row alone", async () => {
    const provider = providerModule.computerProvider()!;
    const error = await provider.exec(handle, "ls").then(() => null, (e: unknown) => e);
    assert.ok(error instanceof errors.ComputerError);
    assert.equal(errors.publicComputerMessage(error), errors.COMPUTER_UNREACHABLE);
    assert.equal(error.message, `${error.message.split(" could not")[0]} could not reach the agent's computer right now.`);
    access.resetComputerAvailabilityCacheForTest();
    await assert.rejects(() => store.ensureAwake("pro_1", "agent_1"), (e: unknown) => e instanceof errors.ComputerError);
    const row = await memDb.findByAgent("pro_1", "agent_1");
    assert.equal(row?.status, "awake", "never marked as an error");
    assert.equal(row?.lastError, null);
    assert.equal(row?.containerRef, containerRef);
  });

  it("the panel says the computers can't be reached", async () => {
    access.resetComputerAvailabilityCacheForTest();
    const verdict = await access.computerAccessFor("pro_1");
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.reason === "unavailable");
    assert.equal(!verdict.ok && verdict.message, copy.COMPUTER_ACCESS_COPY.unavailable);
    assert.equal(access.publicComputerAccess(verdict).reason, "unavailable");
  });

  it("the outage is not metered against the allowance, and nothing is recreated or reaped", async () => {
    const first = await sweep.sweepAgentComputers({ now: new Date(t0) });
    assert.deepEqual(first.skipped, ["agent_1"]);
    assert.deepEqual(first.reapedOrphans, []);
    assert.deepEqual(first.reconciledAfterReboot, []);
    const row = await memDb.findByAgent("pro_1", "agent_1");
    assert.equal(row?.lastResumedAt, null, "nothing accrues during the outage");
    assert.equal(row?.status, "awake");
    assert.equal(row?.containerRef, containerRef, "not recreated");
    const metered = memDb.usage.filter((u) => u.agentId === "agent_1").reduce((sum, u) => sum + u.seconds, 0);
    assert.equal(metered, 5 * 60, "settled exactly up to the last contact");
    assert.equal(memDb.audits.filter((a) => a.kind === "host_unreachable").length, 1);

    // Later passes during the same outage: no second audit, no more time.
    const later = new Date(t0 + 30 * MINUTE);
    await sweep.sweepAgentComputers({ now: later });
    await sweep.sweepAgentComputers({ now: new Date(t0 + 45 * MINUTE) });
    assert.equal(memDb.audits.filter((a) => a.kind === "host_unreachable").length, 1);
    assert.equal(await store.computerWeekUsageSeconds("pro_1", later), 5 * 60);
    assert.deepEqual(host.calls, [], "the host was down; nothing reached it");
  });

  it("metering resumes at the first contact afterwards", async () => {
    await host.up();
    host.calls = [];
    const back = new Date(t0 + 50 * MINUTE);
    const pass = await sweep.sweepAgentComputers({ now: back });
    assert.deepEqual(pass.skipped, []);
    const row = await memDb.findByAgent("pro_1", "agent_1");
    assert.equal(row?.lastResumedAt?.getTime(), back.getTime());
    assert.equal(row?.lastContactAt?.getTime(), back.getTime());
    const reachable = memDb.audits.filter((a) => a.kind === "host_reachable");
    assert.equal(reachable.length, 1);
    assert.equal(reachable[0]!.detail.minutes, 55, "from the last contact to this one");
    assert.equal(await store.computerWeekUsageSeconds("pro_1", new Date(back.getTime() + MINUTE)), 5 * 60 + 60);
    assert.ok(!host.calls.some((call) => call === "POST /v1/computers" || call.startsWith("DELETE")), JSON.stringify(host.calls));
    assert.equal(row?.containerRef, containerRef);
  });
});
