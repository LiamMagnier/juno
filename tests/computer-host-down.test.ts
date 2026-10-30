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
  /** When set, the host answers these lifecycle calls with this status and changes nothing (a broker refusing, or timing out). */
  failing = new Map<string, number>();

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
        const failure = this.failing.get(action);
        if (failure) return reply(failure, { error: failure === 504 ? "host_timeout" : "host_error" });
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

describe("a sleep or rest the host could not carry out", () => {
  const MINUTE = 60_000;
  const USER = "pro_2";
  const AGENT = "agent_2";
  const NAME = `juno-agent-${AGENT}`;
  const T = Date.now();
  const resumedAt = new Date(T - 10 * MINUTE);
  const contactAt = new Date(T - 4 * MINUTE);
  const metered = () => memDb.usage.filter((u) => u.agentId === AGENT).reduce((sum, u) => sum + u.seconds, 0);
  const auditsOf = (kind: string) => memDb.audits.filter((a) => a.agentId === AGENT && a.kind === kind);
  let containerRef: string | null = null;

  it("wakes a second computer through the host (the setup)", async () => {
    // The first suite's computer is put to sleep, so these passes see only this one.
    await store.sleepComputer("pro_1", "agent_1", { now: new Date(T + 60 * MINUTE) });
    host.failing.clear();
    memDb.accessUsers.set(USER, { id: USER, email: null, emailVerified: null, plan: "PRO" });
    access.resetComputerAvailabilityCacheForTest();
    const awake = await store.ensureAwake(USER, AGENT, { autoEnable: true });
    containerRef = awake.row.containerRef;
    assert.equal(host.containers.get(NAME), "running");
    await memDb.updateByAgent(USER, AGENT, { lastResumedAt: resumedAt, lastContactAt: contactAt, lastActiveAt: new Date(T) });
    await host.down();
  });

  it("Sleep during an outage is held: never an error, never asleep, metered to the last contact", async () => {
    const error = await store.sleepComputer(USER, AGENT, { reason: "person", actor: "web", now: new Date(T) }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof errors.ComputerError);
    assert.equal(error.message, errors.COMPUTER_UNREACHABLE);
    let row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.status, "stopping", "the computer may still be running on the host");
    assert.equal(row?.lastError ?? null, null, "never marked as an error");
    assert.equal(row?.billingStoppedAt?.getTime(), contactAt.getTime(), "the end is pinned at the last contact");
    assert.equal(row?.lastResumedAt, null, "nothing accrues while the host is gone");
    assert.equal(row?.containerRef, containerRef);
    assert.equal(metered(), 6 * 60, "settled exactly up to the last contact");
    assert.equal(auditsOf("host_unreachable").length, 1);
    assert.equal(auditsOf("host_unreachable")[0]!.actor, "web");
    // Still in the sweep's list, and still holding its slot on the caps.
    assert.ok((await memDb.findAllActiveUnguarded()).some((r) => r.agentId === AGENT));
    assert.equal(await memDb.countAwakeUser(USER), 1);

    // Pressing Sleep again changes nothing.
    await assert.rejects(() => store.sleepComputer(USER, AGENT, { reason: "person", actor: "web", now: new Date(T + MINUTE) }), {
      message: errors.COMPUTER_UNREACHABLE,
    });
    row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.billingStoppedAt?.getTime(), contactAt.getTime());
    assert.equal(metered(), 6 * 60);
    assert.equal(auditsOf("host_unreachable").length, 1);
  });

  it("sweeps during the outage keep it held and meter nothing more", async () => {
    for (const minutes of [30, 90]) {
      const pass = await sweep.sweepAgentComputers({ now: new Date(T + minutes * MINUTE) });
      assert.ok(pass.skipped.includes(AGENT), JSON.stringify(pass));
      assert.ok(!pass.slept.includes(AGENT));
    }
    const row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.status, "stopping");
    assert.equal(row?.billingStoppedAt?.getTime(), contactAt.getTime());
    assert.equal(metered(), 6 * 60);
  });

  it("once the host answers, the sweep stops the computer and nothing goes unmetered", async () => {
    await host.up();
    host.calls = [];
    const back = new Date(T + 3 * 60 * MINUTE);
    const pass = await sweep.sweepAgentComputers({ now: back });
    assert.ok(pass.slept.includes(AGENT), JSON.stringify(pass));
    assert.ok(host.calls.includes(`POST /v1/computers/${NAME}/stop`), JSON.stringify(host.calls));
    assert.equal(host.containers.get(NAME), "exited", "the container is stopped on the host");
    const row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.status, "asleep");
    assert.equal(row?.billingStoppedAt, null);
    assert.equal(row?.lastResumedAt, null);
    assert.equal(row?.containerRef, containerRef, "never recreated");
    assert.equal(metered(), 6 * 60, "the interval before the outage, once; the outage itself never");
    assert.equal(auditsOf("slept").at(-1)?.actor, "sweep");
    assert.ok(!host.calls.some((call) => call === "POST /v1/computers" || call.startsWith("DELETE")), JSON.stringify(host.calls));
  });

  it("a stop the host answers with 502 is held the same way, and a run hears unavailable, not busy", async () => {
    access.resetComputerAvailabilityCacheForTest();
    await store.ensureAwake(USER, AGENT);
    assert.equal(host.containers.get(NAME), "running");
    host.failing.set("stop", 502);
    await assert.rejects(() => store.sleepComputer(USER, AGENT, { reason: "person", actor: "web" }), { message: errors.COMPUTER_UNREACHABLE });
    let row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.status, "stopping");
    assert.ok(row?.billingStoppedAt, "held for the host");
    assert.equal(host.containers.get(NAME), "running", "the 502 stopped nothing");

    const attempt = await store.resolveRunComputerSession({ userId: USER, agentId: AGENT, runId: "run_held" });
    assert.equal(attempt.attached, false);
    assert.ok(!attempt.attached && attempt.fallbackReason === "unavailable", JSON.stringify(attempt));
    assert.ok(!attempt.attached && attempt.note === errors.COMPUTER_UNREACHABLE);
    row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.leaseRunId ?? null, null);
    assert.equal(row?.status, "stopping");
  });

  it("a wake finishes a held sleep first, then starts the computer", async () => {
    host.failing.clear();
    host.calls = [];
    const before = auditsOf("slept").length;
    const awake = await store.ensureAwake(USER, AGENT, { by: "person", actor: "web" });
    assert.equal(awake.row.status, "awake");
    assert.equal(awake.row.billingStoppedAt ?? null, null);
    const stop = host.calls.indexOf(`POST /v1/computers/${NAME}/stop`);
    const start = host.calls.indexOf(`POST /v1/computers/${NAME}/start`);
    assert.ok(stop >= 0 && start > stop, JSON.stringify(host.calls));
    assert.equal(auditsOf("slept").length, before + 1);
    assert.equal(host.containers.get(NAME), "running");
  });

  it("a rest the host could not carry out puts the idle claim back and settles at the last contact", async () => {
    const R = T + 5 * 60 * MINUTE;
    await memDb.updateByAgent(USER, AGENT, {
      lastResumedAt: new Date(R - 10 * MINUTE),
      lastContactAt: new Date(R - 2 * MINUTE),
      lastActiveAt: new Date(R - 5 * MINUTE),
      lastViewedAt: null,
    });
    const before = metered();
    const unreachableBefore = auditsOf("host_unreachable").length;
    host.failing.set("pause", 502);
    const failed = await sweep.sweepAgentComputers({ now: new Date(R) });
    assert.ok(failed.skipped.includes(AGENT), JSON.stringify(failed));
    let row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.status, "awake", "the idle claim's stopping is put back, never an error");
    assert.equal(row?.lastError ?? null, null);
    assert.equal(row?.lastResumedAt, null, "nothing accrues until the host answers");
    // The sweep reached the host for state() at R, so that is the last contact.
    assert.equal(metered() - before, 10 * 60);
    assert.equal(auditsOf("host_unreachable").length, unreachableBefore + 1);
    assert.equal(host.containers.get(NAME), "running");

    host.failing.clear();
    await sweep.sweepAgentComputers({ now: new Date(R + MINUTE) });
    row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.lastResumedAt?.getTime(), R + MINUTE, "metering resumes at the first contact");
    const rested = await sweep.sweepAgentComputers({ now: new Date(R + 5 * MINUTE) });
    assert.ok(rested.rested.includes(AGENT), JSON.stringify(rested));
    row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.status, "resting");
    assert.equal(host.containers.get(NAME), "paused");
    assert.equal(metered() - before, 10 * 60 + 4 * 60);
  });
});

describe("finishing a held sleep is a claim", () => {
  const MINUTE = 60_000;
  const USER = "pro_3";
  const AGENT = "agent_3";
  const NAME = `juno-agent-${AGENT}`;
  const callsFor = () => host.calls.filter((call) => call.includes(NAME) && !call.endsWith("/state"));
  const auditsOf = (kind: string) => memDb.audits.filter((a) => a.agentId === AGENT && a.kind === kind);

  async function holdASleep(): Promise<void> {
    access.resetComputerAvailabilityCacheForTest();
    await store.ensureAwake(USER, AGENT, { autoEnable: true });
    assert.equal(host.containers.get(NAME), "running");
    await host.down();
    await assert.rejects(() => store.sleepComputer(USER, AGENT, { reason: "person", actor: "web" }), {
      message: errors.COMPUTER_UNREACHABLE,
    });
    const row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.status, "stopping");
    assert.ok(row?.billingStoppedAt, "held for the host");
    await host.up();
    host.calls = [];
    access.resetComputerAvailabilityCacheForTest();
  }

  it("a run that finishes the held sleep after the sweep read the row keeps its computer and its lease", async () => {
    memDb.accessUsers.set(USER, { id: USER, email: null, emailVerified: null, plan: "PRO" });
    await holdASleep();
    // The sweep reads its rows; before it reaches this one, a run attaches the
    // computer (finishing the held sleep and waking it).
    const original = memDb.findAllActiveUnguarded.bind(memDb);
    let attachment: Awaited<ReturnType<typeof store.resolveRunComputerSession>> | null = null;
    memDb.findAllActiveUnguarded = async () => {
      const rows = await original();
      attachment = await store.resolveRunComputerSession({ userId: USER, agentId: AGENT, runId: "run_live" });
      return rows;
    };
    let pass: Awaited<ReturnType<typeof sweep.sweepAgentComputers>>;
    try {
      pass = await sweep.sweepAgentComputers({ now: new Date() });
    } finally {
      memDb.findAllActiveUnguarded = original;
    }
    const attached = attachment as Awaited<ReturnType<typeof store.resolveRunComputerSession>> | null;
    assert.ok(attached?.attached, JSON.stringify(attached));
    assert.ok(!pass.slept.includes(AGENT), "the sweep's stale read claims nothing");
    const row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.leaseRunId, "run_live", "the run still holds its lease");
    assert.equal(row?.status, "awake");
    assert.equal(host.containers.get(NAME), "running", "the run's computer is still running");
    const calls = callsFor();
    assert.equal(calls.filter((call) => call.endsWith("/stop")).length, 1, JSON.stringify(calls));
    assert.ok(calls.indexOf(`POST /v1/computers/${NAME}/stop`) < calls.indexOf(`POST /v1/computers/${NAME}/start`));
    if (attached?.attached) await attached.release();
  });

  it("a wake that loses the claim to the sweep waits for that sleep, then wakes: one stop, metered once", async () => {
    await store.sleepComputer(USER, AGENT, { actor: "web" });
    await holdASleep();
    // A held sleep whose interval is still open (a ledger write that failed after the stop).
    const end = new Date(Date.now() - MINUTE);
    const resumed = new Date(end.getTime() - 5 * MINUTE);
    await memDb.updateByAgent(USER, AGENT, { billingStoppedAt: end, lastResumedAt: resumed });
    const meteredFrom = () => memDb.usage.filter((u) => u.agentId === AGENT && u.startedAt.getTime() === resumed.getTime());
    const sleptBefore = auditsOf("slept").length;
    // The wake reads the held row; the sweep claims and finishes it before the wake's claim lands.
    const original = memDb.claimHeldSleepCas.bind(memDb);
    let sweepPass: Awaited<ReturnType<typeof sweep.sweepAgentComputers>> | null = null;
    let first = true;
    memDb.claimHeldSleepCas = async (...args: Parameters<typeof original>) => {
      if (first) {
        first = false;
        sweepPass = await sweep.sweepAgentComputers({ now: new Date() });
      }
      return original(...args);
    };
    let awake: Awaited<ReturnType<typeof store.ensureAwake>>;
    try {
      awake = await store.ensureAwake(USER, AGENT, { by: "person", actor: "web" });
    } finally {
      memDb.claimHeldSleepCas = original;
    }
    const pass = sweepPass as Awaited<ReturnType<typeof sweep.sweepAgentComputers>> | null;
    assert.ok(pass?.slept.includes(AGENT), JSON.stringify(pass));
    assert.equal(awake.row.status, "awake");
    assert.equal(awake.row.billingStoppedAt ?? null, null);
    assert.equal(host.containers.get(NAME), "running");
    const calls = callsFor();
    assert.equal(calls.filter((call) => call.endsWith("/stop")).length, 1, `one finisher stops it: ${JSON.stringify(calls)}`);
    assert.ok(calls.indexOf(`POST /v1/computers/${NAME}/stop`) < calls.indexOf(`POST /v1/computers/${NAME}/start`));
    assert.equal(auditsOf("slept").length, sleptBefore + 1, "one sleep, the sweep's");
    assert.equal(auditsOf("slept").at(-1)?.actor, "sweep");
    assert.deepEqual(meteredFrom().map((u) => u.seconds), [5 * 60], "the held interval, once, up to its pinned end");
  });

  it("a wake that lost the host after docker start is put to sleep once past the grace, never left running", async () => {
    await store.sleepComputer(USER, AGENT, { actor: "web" });
    assert.equal(host.containers.get(NAME), "exited");
    host.failing.set("cdp-token", 502);
    await assert.rejects(() => store.ensureAwake(USER, AGENT, { by: "person", actor: "web" }), { message: errors.COMPUTER_UNREACHABLE });
    host.failing.clear();
    let row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.status, "starting");
    assert.equal(host.containers.get(NAME), "running", "docker start went through");
    const t = Date.now();
    const early = await sweep.sweepAgentComputers({ now: new Date(t + MINUTE) });
    assert.ok(!early.slept.includes(AGENT), "inside the grace a wake may still be finishing");
    assert.equal(host.containers.get(NAME), "running");
    const late = await sweep.sweepAgentComputers({ now: new Date(t + 6 * MINUTE) });
    assert.ok(late.slept.includes(AGENT), JSON.stringify(late));
    row = await memDb.findByAgent(USER, AGENT);
    assert.equal(row?.status, "asleep");
    assert.equal(host.containers.get(NAME), "exited", "its awake slot is given back");
    assert.equal(auditsOf("slept").at(-1)?.actor, "sweep");
    // It wakes normally afterwards.
    access.resetComputerAvailabilityCacheForTest();
    assert.equal((await store.ensureAwake(USER, AGENT, { by: "person", actor: "web" })).row.status, "awake");
  });

  it("a sleep that crashed after its claim (stopping, nothing held) is finished past the grace", async () => {
    assert.equal(host.containers.get(NAME), "running");
    await memDb.updateByAgent(USER, AGENT, { status: "stopping", leaseRunId: null, leaseExpiresAt: null });
    const t = Date.now();
    assert.ok(!(await sweep.sweepAgentComputers({ now: new Date(t + MINUTE) })).slept.includes(AGENT));
    assert.equal(host.containers.get(NAME), "running");
    const late = await sweep.sweepAgentComputers({ now: new Date(t + 6 * MINUTE) });
    assert.ok(late.slept.includes(AGENT), JSON.stringify(late));
    assert.equal((await memDb.findByAgent(USER, AGENT))?.status, "asleep");
    assert.equal(host.containers.get(NAME), "exited");
  });
});
