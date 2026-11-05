import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, it } from "node:test";

/*
 * The sweep survives one unreachable computer (docs/design/agents-v2/
 * COMPUTERS_2026-10.md fact 24, S2.7). It used to run every row in one loop
 * with no catch, so a single state() that threw (a daemon or broker hiccup, a
 * host outage) ended the pass, and every later computer missed its idle, disk
 * and access checks that minute. Now each row is tried on its own; the one that
 * throws is skipped (never taken for missing, never recreated) and logged once
 * per outage.
 */

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const errors = req("../src/lib/computer/errors") as typeof import("@/lib/computer/errors");
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const sweep = req("../src/lib/computer/sweep") as typeof import("@/lib/computer/sweep");

type Row = import("@/lib/computer/store").AgentComputerRow;
const NOW = new Date("2026-10-28T12:00:00Z");
const saved = { provider: process.env.AGENT_COMPUTER_PROVIDER, secret: process.env.AUTH_SECRET };
let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;
const warnings: string[] = [];
const realWarn = console.warn;
const realState = fakeComputerProvider.state;

beforeEach(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";
  process.env.AGENT_COMPUTER_PROVIDER = "fake";
  resetComputerProviderCache();
  fakeComputerProvider.reset();
  memDb = store.createInMemoryComputerPersistence();
  store.setComputerStorePersistenceForTest(memDb);
  sweep.resetOrphanTrackingForTest();
  sweep.resetSweepLogsForTest();
  warnings.length = 0;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
  };
});

afterEach(() => {
  console.warn = realWarn;
  fakeComputerProvider.state = realState;
  if (saved.provider === undefined) delete process.env.AGENT_COMPUTER_PROVIDER;
  else process.env.AGENT_COMPUTER_PROVIDER = saved.provider;
  if (saved.secret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = saved.secret;
  resetComputerProviderCache();
  store.setComputerStorePersistenceForTest(null);
});

/** A computer resting (paused) for two hours: past the 30-minute sleep threshold. */
async function seedResting(agentId: string): Promise<void> {
  const handle = await fakeComputerProvider.create({ agentId, userId: "user_sw", cdpToken: "t" });
  await fakeComputerProvider.start(handle);
  await fakeComputerProvider.pause(handle);
  const idle = new Date(NOW.getTime() - 2 * 3_600_000);
  const createData = {
    userId: "user_sw",
    agentId,
    provider: "fake",
    containerRef: store.encodeHandle(handle),
    secrets: null,
    status: "resting",
    streamOn: false,
    leaseRunId: null,
    leaseExpiresAt: null,
    lastResumedAt: null,
    lastActiveAt: idle,
    lastViewedAt: idle,
    activeSeconds: 0,
    diskMb: null,
    lastError: null,
  } as unknown as Omit<Row, "id" | "createdAt" | "updatedAt">;
  await memDb.upsertByAgent("user_sw", agentId, createData, {});
}

it("one computer whose state() throws does not stop the pass, and is not recreated", async () => {
  await seedResting("agent_down");
  await seedResting("agent_fine");
  fakeComputerProvider.state = async function (handle) {
    if (handle.name === "juno-agent-agent_down") {
      throw new errors.ComputerError(errors.COMPUTER_UNREACHABLE, "docker inspect exited 1: Cannot connect to the Docker daemon");
    }
    return realState.call(this, handle);
  };
  const callsBefore = fakeComputerProvider.calls.length;

  const first = await sweep.sweepAgentComputers({ now: NOW });
  assert.deepEqual(first.skipped, ["agent_down"]);
  assert.deepEqual(first.slept, ["agent_fine"], "the row after the failing one still got its idle check");
  assert.deepEqual(first.reconciledAfterReboot, [], "an unreachable computer is never taken for a stopped one");
  assert.equal((await memDb.findByAgent("user_sw", "agent_fine"))?.status, "asleep");
  const down = await memDb.findByAgent("user_sw", "agent_down");
  assert.equal(down?.status, "resting", "the unreachable computer's row is untouched");
  const recreated = fakeComputerProvider.calls.slice(callsBefore).filter((call) => call.method === "create" || call.method === "destroy");
  assert.deepEqual(recreated, [], "nothing was created or destroyed");

  // Logged once per outage, not every minute; and again after it recovers and fails anew.
  await sweep.sweepAgentComputers({ now: new Date(NOW.getTime() + 60_000) });
  const logged = () => warnings.filter((w) => w.includes("sweep skipped a computer")).length;
  assert.equal(logged(), 1);
  assert.ok(!warnings.join("\n").includes("Cannot connect to the Docker daemon at"), "the log line carries the scrubbed detail only");
  fakeComputerProvider.state = realState;
  const recovered = await sweep.sweepAgentComputers({ now: new Date(NOW.getTime() + 120_000) });
  assert.deepEqual(recovered.skipped, []);
  assert.deepEqual(recovered.slept, ["agent_down"], "once reachable, it gets its checks again");
});
