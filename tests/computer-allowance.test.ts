/**
 * The weekly allowance (src/lib/computer/store.ts; docs/design/agents-v2/COMPUTERS_2026-10.md
 * §S1.2): awake time is metered whatever the price, and the account's week
 * bounds it, on the in-memory store as on the database.
 */
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");

const MONDAY_SENTENCE = "Your agents’ computers have used this week’s 2 hours. They can start again on Monday at 00:00 UTC.";

/** Now, or 01:00 on Monday when the week began less than an hour ago, so a test's few minutes never straddle Monday 00:00 UTC. */
function midWeekNow(): Date {
  const now = new Date();
  const weekStart = store.weekStartUtc(now).getTime();
  return now.getTime() - weekStart < 3_600_000 ? new Date(weekStart + 3_600_000) : now;
}

/** Everything metered for one agent, whichever weeks it was booked to. */
const meteredSeconds = (memDb: { usage: Array<{ agentId: string; seconds: number }> }, agentId: string) =>
  memDb.usage.filter((u) => u.agentId === agentId).reduce((sum, u) => sum + u.seconds, 0);

describe("the weekly allowance", () => {
  let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["AGENT_COMPUTER_PROVIDER", "AGENT_COMPUTER_ROLLOUT", "AGENT_COMPUTER_COST_USD_PER_MIN", "COMPUTER_COST_MICRO_USD_PER_SECOND", "AUTH_SECRET"];

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    process.env.AGENT_COMPUTER_ROLLOUT = "plans";
    delete process.env.AGENT_COMPUTER_COST_USD_PER_MIN;
    delete process.env.COMPUTER_COST_MICRO_USD_PER_SECOND;
    resetComputerProviderCache();
    fakeComputerProvider.reset();
    memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    // A Pro account: 1 computer, 120 awake minutes a week.
    memDb.accessUsers.set("pro_1", { id: "pro_1", email: null, emailVerified: null, plan: "PRO" });
  });
  afterEach(() => {
    store.setComputerStorePersistenceForTest(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetComputerProviderCache();
  });

  it("awake seconds are metered when the price is 0", async () => {
    assert.equal(store.computerCostMicroUsdPerSecond(), 0, "computer time is free here");
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    const since = new Date(Date.now() - 300_000);
    await memDb.updateByAgent("pro_1", "agent_1", { lastResumedAt: since });
    await store.sleepComputer("pro_1", "agent_1");
    // One row, or two when the five minutes ran across Monday 00:00 UTC.
    assert.ok(memDb.usage.length >= 1 && memDb.usage.length <= 2);
    assert.equal(memDb.usage[0]!.agentId, "agent_1");
    const total = meteredSeconds(memDb, "agent_1");
    assert.ok(total >= 300 && total < 310);
    assert.equal(memDb.usage[0]!.startedAt.getTime(), since.getTime());
    assert.equal(memDb.usage[0]!.weekStart.getTime(), store.weekStartUtc(since).getTime());
    assert.ok(memDb.audits.some((a) => a.kind === "slept"));
  });

  it("a wake past the weekly allowance is refused with the Monday sentence", async () => {
    await store.enableComputer("pro_1", "agent_1");
    const now = new Date();
    await memDb.recordUsageInterval({
      userId: "pro_1",
      agentId: "agent_old",
      startedAt: store.weekStartUtc(now),
      seconds: 120 * 60,
      weekStart: store.weekStartUtc(now),
      runId: null,
    });
    await assert.rejects(
      () => store.ensureAwake("pro_1", "agent_1"),
      (err: unknown) => err instanceof Error && err.message === MONDAY_SENTENCE && (err as { code?: string }).code === "allowance_exhausted",
    );
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "start"), false, "nothing was started");
    assert.ok(memDb.audits.some((a) => a.kind === "refused" && a.detail.reason === "allowance_exhausted"));
  });

  it("a running computer is put to sleep when the allowance runs out at lease renewal", async () => {
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    const now = midWeekNow();
    assert.equal((await store.acquireComputerLease("pro_1", "agent_1", "run_1", 120_000, now)).acquired, true);
    assert.equal(await store.renewComputerLease("pro_1", "agent_1", "run_1", 120_000, now), true, "time left: renewed");
    // 119 minutes already metered this week, and it has been awake 2 more.
    await memDb.recordUsageInterval({
      userId: "pro_1",
      agentId: "agent_other",
      startedAt: store.weekStartUtc(now),
      seconds: 119 * 60,
      weekStart: store.weekStartUtc(now),
      runId: null,
    });
    await memDb.updateByAgent("pro_1", "agent_1", { lastResumedAt: new Date(now.getTime() - 120_000) });
    assert.equal(await store.renewComputerLease("pro_1", "agent_1", "run_1", 120_000, now), false);
    const row = await memDb.findByAgent("pro_1", "agent_1");
    assert.equal(row?.status, "asleep");
    assert.equal(row?.leaseRunId, null);
    assert.equal(row?.lastError, MONDAY_SENTENCE);
    assert.ok(memDb.audits.some((a) => a.kind === "slept" && a.detail.reason === "allowance"));
    // The awake time up to the stop was metered too.
    assert.ok(meteredSeconds(memDb, "agent_1") >= 120);
  });

  it("an interval is metered once however often it is settled", async () => {
    const since = new Date("2026-10-28T12:00:00.000Z"); // a Wednesday: one week, one row
    for (let i = 0; i < 3; i++) {
      await store.billComputerSeconds({ userId: "pro_1", agentId: "agent_1", seconds: 600, since });
    }
    assert.equal(memDb.usage.length, 1);
    assert.equal(memDb.usage[0]!.seconds, 600);
    // A retried settlement of the same start that ran longer keeps the longer length, once.
    await store.billComputerSeconds({ userId: "pro_1", agentId: "agent_1", seconds: 660, since });
    await store.billComputerSeconds({ userId: "pro_1", agentId: "agent_1", seconds: 600, since });
    assert.equal(memDb.usage.length, 1);
    assert.equal(memDb.usage[0]!.seconds, 660);
    assert.equal(await store.computerWeekUsageSeconds("pro_1", new Date(since.getTime() + 1000)), 660);
  });

  it("disable meters the open interval", async () => {
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    const since = new Date(Date.now() - 300_000);
    await memDb.updateByAgent("pro_1", "agent_1", { lastResumedAt: since });
    await store.disableComputer("pro_1", "agent_1");
    assert.equal(memDb.rows.size, 0);
    assert.ok(memDb.usage.length >= 1, "deleting the computer does not drop its awake time");
    assert.ok(meteredSeconds(memDb, "agent_1") >= 300);
    assert.ok(memDb.audits.some((a) => a.kind === "disabled"));
  });

  it("the week starts Monday 00:00 UTC", () => {
    const iso = (d: Date) => d.toISOString();
    assert.equal(iso(store.weekStartUtc(new Date("2026-10-28T15:30:00Z"))), "2026-10-26T00:00:00.000Z"); // Wednesday
    assert.equal(iso(store.weekStartUtc(new Date("2026-10-26T00:00:00Z"))), "2026-10-26T00:00:00.000Z"); // Monday 00:00
    assert.equal(iso(store.weekStartUtc(new Date("2026-10-25T23:59:59Z"))), "2026-10-19T00:00:00.000Z"); // Sunday night
    assert.equal(iso(store.weekStartUtc(new Date("2026-11-01T12:00:00+09:00"))), "2026-10-26T00:00:00.000Z"); // Sunday in UTC
  });

  it("an interval that runs across Monday 00:00 UTC is split there: each week counts only its own share", async () => {
    // Sunday 23:00 to Monday 01:00: an hour in each week.
    const sunday = new Date("2026-10-25T23:00:00Z");
    await store.billComputerSeconds({ userId: "pro_1", agentId: "agent_1", seconds: 7200, since: sunday });
    assert.deepEqual(
      memDb.usage.map((u) => [u.startedAt.toISOString(), u.seconds, u.weekStart.toISOString()]),
      [
        ["2026-10-25T23:00:00.000Z", 3600, "2026-10-19T00:00:00.000Z"],
        ["2026-10-26T00:00:00.000Z", 3600, "2026-10-26T00:00:00.000Z"],
      ],
    );
    assert.equal(await store.computerWeekUsageSeconds("pro_1", new Date("2026-10-26T01:00:00Z")), 3600, "this week: its hour");
    assert.equal(await store.computerWeekUsageSeconds("pro_1", new Date("2026-10-25T23:30:00Z")), 3600, "last week: its hour");
    // Settled again, longer (a retry that ran on): only the last piece grows, and nothing is counted twice.
    await store.billComputerSeconds({ userId: "pro_1", agentId: "agent_1", seconds: 9000, since: sunday });
    assert.equal(memDb.usage.length, 2);
    assert.equal(await store.computerWeekUsageSeconds("pro_1", new Date("2026-10-26T02:00:00Z")), 5400);
    assert.equal(await store.computerWeekUsageSeconds("pro_1", new Date("2026-10-25T23:30:00Z")), 3600);
  });

  it("an interval longer than a week is booked to every week it ran in", () => {
    const pieces = store.splitUsageAtWeeks(new Date("2026-10-18T12:00:00Z"), 10 * 86_400);
    assert.deepEqual(
      pieces.map((p) => [p.startedAt.toISOString(), p.seconds]),
      [
        ["2026-10-18T12:00:00.000Z", 12 * 3600],
        ["2026-10-19T00:00:00.000Z", 7 * 86_400],
        ["2026-10-26T00:00:00.000Z", 2 * 86_400 + 12 * 3600],
      ],
    );
    assert.equal(pieces.reduce((sum, p) => sum + p.seconds, 0), 10 * 86_400);
    // Starting exactly at Monday 00:00, and nothing at all.
    assert.equal(store.splitUsageAtWeeks(new Date("2026-10-26T00:00:00Z"), 60).length, 1);
    assert.deepEqual(store.splitUsageAtWeeks(new Date("2026-10-26T00:00:00Z"), 0), []);
  });

  it("a computer awake since last week counts only this week's share of its open time", async () => {
    // The checker's case: awake since Sunday 23:00, not yet metered, asked on Wednesday.
    const now = new Date("2026-10-28T02:59:15Z");
    await store.enableComputer("pro_1", "agent_1");
    await memDb.updateByAgent("pro_1", "agent_1", { status: "awake", lastResumedAt: new Date("2026-10-25T23:00:00Z") });
    const thisWeek = Math.floor((now.getTime() - Date.parse("2026-10-26T00:00:00Z")) / 1000);
    assert.equal(await store.computerWeekUsageSeconds("pro_1", now), thisWeek, "open: only this week's share");
    // Metered (it went to sleep): this week's share stays this week's.
    await store.settleRunComputerBilling("pro_1", "agent_1", "run_1", now);
    assert.equal(await store.computerWeekUsageSeconds("pro_1", now), thisWeek, "metered: the same, not 0");
  });

  it("the in-memory persistence enforces the allowance (no early return)", async () => {
    assert.equal(store.computerStoreUsesDatabase(), false);
    assert.equal(store.computerCostMicroUsdPerSecond(), 0);
    await store.enableComputer("pro_1", "agent_1");
    assert.equal(await store.computerUsageBudgetRefusal("pro_1", "agent_1"), null);
    const now = new Date();
    await memDb.recordUsageInterval({ userId: "pro_1", agentId: "agent_x", startedAt: store.weekStartUtc(now), seconds: 7200, weekStart: store.weekStartUtc(now), runId: null });
    assert.equal(await store.computerUsageBudgetRefusal("pro_1", "agent_1"), MONDAY_SENTENCE);
    // Another account's week is its own.
    memDb.accessUsers.set("pro_2", { id: "pro_2", email: null, emailVerified: null, plan: "PRO" });
    assert.equal(await store.computerUsageBudgetRefusal("pro_2", "agent_2"), null);
  });
});
