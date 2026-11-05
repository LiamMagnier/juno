import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

/*
 * Retention of agent computers is implemented and OFF (docs/design/agents-v2/
 * COMPUTERS_2026-10.md D14, S2.6). Deleting a computer deletes the person's
 * files and every site they signed in to, so it takes the owner's switch AND a
 * number of days; the old COMPUTER_RETENTION_DAYS, which three docs once gave
 * a 30-day default, is never read for deletion.
 */

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const retention = req("../src/lib/computer/retention") as typeof import("@/lib/computer/retention");
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const sweep = req("../src/lib/computer/sweep") as typeof import("@/lib/computer/sweep");

type Row = import("@/lib/computer/store").AgentComputerRow;
const DAY = 86_400_000;
const NOW = new Date("2026-10-28T12:00:00Z");

function row(agentId: string, overrides: Partial<Row> = {}): Row {
  const old = new Date(NOW.getTime() - 40 * DAY);
  return {
    id: `id-${agentId}`,
    userId: "user_ret",
    agentId,
    provider: "fake",
    containerRef: null,
    secrets: null,
    status: "asleep",
    streamOn: false,
    leaseRunId: null,
    leaseExpiresAt: null,
    lastResumedAt: null,
    lastActiveAt: old,
    lastViewedAt: old,
    activeSeconds: 0,
    diskMb: null,
    lastError: null,
    takeoverUntil: null,
    takeoverStartedAt: null,
    takeoverBy: null,
    takeoverEpoch: 0,
    createdAt: new Date(NOW.getTime() - 90 * DAY),
    updatedAt: old,
    ...overrides,
  };
}

describe("the retention policy", () => {
  it("is off with nothing set", () => {
    assert.deepEqual(retention.computerRetentionPolicy({}), { enforce: false, days: null, legacyIgnored: false, problem: null });
  });

  it("COMPUTER_RETENTION_DAYS=30 alone deletes nothing and is reported as ignored", () => {
    const policy = retention.computerRetentionPolicy({ COMPUTER_RETENTION_DAYS: "30" });
    assert.equal(policy.enforce, false);
    assert.equal(policy.legacyIgnored, true);
    assert.deepEqual(retention.retentionCandidates([row("a")], NOW, policy), []);
  });

  it("the switch without a valid number of days deletes nothing, and says why", () => {
    for (const days of [undefined, "", "thirty", "30.5", "-30", "3e1"]) {
      const policy = retention.computerRetentionPolicy({ AGENT_COMPUTER_RETENTION_ENFORCE: "1", AGENT_COMPUTER_RETENTION_DAYS: days });
      assert.equal(policy.enforce, false, String(days));
      assert.match(policy.problem ?? "", /AGENT_COMPUTER_RETENTION_DAYS/);
      assert.deepEqual(retention.retentionCandidates([row("a")], NOW, policy), []);
    }
  });

  it("days without the switch delete nothing (the switch is exactly 1)", () => {
    for (const enforce of [undefined, "", "true", "yes", " 1", "1 ", "2"]) {
      const policy = retention.computerRetentionPolicy({ AGENT_COMPUTER_RETENTION_ENFORCE: enforce, AGENT_COMPUTER_RETENTION_DAYS: "30" });
      assert.equal(policy.enforce, false, String(enforce));
      assert.deepEqual(retention.retentionCandidates([row("a")], NOW, policy), []);
    }
  });

  it("fewer than 7 days is refused", () => {
    for (const days of ["0", "1", "6"]) {
      const policy = retention.computerRetentionPolicy({ AGENT_COMPUTER_RETENTION_ENFORCE: "1", AGENT_COMPUTER_RETENTION_DAYS: days });
      assert.equal(policy.enforce, false, days);
      assert.match(policy.problem ?? "", /at least 7/);
    }
    const seven = retention.computerRetentionPolicy({ AGENT_COMPUTER_RETENTION_ENFORCE: "1", AGENT_COMPUTER_RETENTION_DAYS: "7" });
    assert.deepEqual(seven, { enforce: true, days: 7, legacyIgnored: false, problem: null });
    // A forged policy object below the floor still deletes nothing.
    assert.deepEqual(retention.retentionCandidates([row("a")], NOW, { ...seven, days: 3 }), []);
  });

  it("with both, only idle asleep computers past N days are candidates", () => {
    const policy = retention.computerRetentionPolicy({ AGENT_COMPUTER_RETENTION_ENFORCE: "1", AGENT_COMPUTER_RETENTION_DAYS: "30" });
    const recent = new Date(NOW.getTime() - 5 * DAY);
    const rows = [
      row("old"),
      row("used_recently", { lastActiveAt: recent }),
      row("watched_recently", { lastViewedAt: recent }),
      row("never_used_but_new", { lastActiveAt: null, lastViewedAt: null, createdAt: recent }),
      row("never_used_and_old", { lastActiveAt: null, lastViewedAt: null }),
      row("awake", { status: "awake" }),
      row("resting", { status: "resting" }),
    ];
    assert.deepEqual(retention.retentionCandidates(rows, NOW, policy).map((r) => r.agentId), ["old", "never_used_and_old"]);
  });

  it("a leased, streaming or taken-over computer is never a candidate", () => {
    const policy = retention.computerRetentionPolicy({ AGENT_COMPUTER_RETENTION_ENFORCE: "1", AGENT_COMPUTER_RETENTION_DAYS: "30" });
    const rows = [
      row("leased", { leaseRunId: "run_1", leaseExpiresAt: new Date(NOW.getTime() + 60_000) }),
      row("streaming", { streamOn: true }),
      row("taken_over", { takeoverBy: "web:abc", takeoverUntil: new Date(NOW.getTime() + 60_000) }),
      row("holder_left_set", { takeoverBy: "web:abc", takeoverUntil: new Date(NOW.getTime() - 60_000) }),
      row("being_created", { creationToken: "t", creationExpiresAt: new Date(NOW.getTime() + 60_000) }),
    ];
    assert.deepEqual(retention.retentionCandidates(rows, NOW, policy), []);
  });
});

describe("the sweep's retention pass", () => {
  const saved = { provider: process.env.AGENT_COMPUTER_PROVIDER, secret: process.env.AUTH_SECRET };
  let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;
  const warnings: string[] = [];
  const realWarn = console.warn;

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
      warnings.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.warn = realWarn;
    if (saved.provider === undefined) delete process.env.AGENT_COMPUTER_PROVIDER;
    else process.env.AGENT_COMPUTER_PROVIDER = saved.provider;
    if (saved.secret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = saved.secret;
    resetComputerProviderCache();
    store.setComputerStorePersistenceForTest(null);
  });

  /** An asleep computer with a real (fake-provider) container and volume. */
  async function seedAsleep(agentId: string, overrides: Partial<Row> = {}): Promise<Row> {
    const handle = await fakeComputerProvider.create({ agentId, userId: "user_ret", cdpToken: "t" });
    const base = row(agentId, { containerRef: store.encodeHandle(handle), ...overrides });
    const { id: _id, createdAt: _c, updatedAt: _u, ...createData } = base;
    await memDb.upsertByAgent("user_ret", agentId, createData, {});
    return (await memDb.findByAgent("user_ret", agentId)) as Row;
  }

  it("COMPUTER_RETENTION_DAYS=30 alone deletes nothing, and the sweep says once that it is ignored", async () => {
    const seeded = await seedAsleep("legacy");
    const destroyed: string[] = [];
    const options = {
      policy: retention.computerRetentionPolicy({ COMPUTER_RETENTION_DAYS: "30" }),
      listAsleep: async () => [seeded],
      destroy: async (r: Row) => {
        destroyed.push(r.agentId);
      },
    };
    await sweep.sweepAgentComputers({ now: NOW, retention: options });
    await sweep.sweepAgentComputers({ now: NOW, retention: options });
    assert.deepEqual(destroyed, []);
    assert.ok(await memDb.findByAgent("user_ret", "legacy"));
    assert.equal(warnings.filter((w) => w.includes(retention.LEGACY_RETENTION_IGNORED)).length, 1);
  });

  it("the default policy (nothing set) never lists or deletes anything", async () => {
    await seedAsleep("plain");
    let listed = false;
    await sweep.sweepAgentComputers({
      now: NOW,
      retention: {
        policy: retention.computerRetentionPolicy({}),
        listAsleep: async () => {
          listed = true;
          return [];
        },
      },
    });
    assert.equal(listed, false);
    assert.ok(await memDb.findByAgent("user_ret", "plain"));
  });

  it("with both set, an idle asleep computer is deleted with its volumes through the Delete path, and audited", async () => {
    const old = await seedAsleep("expired");
    const fresh = await seedAsleep("fresh", { lastActiveAt: new Date(NOW.getTime() - DAY) });
    const leased = await seedAsleep("leased", { leaseRunId: "run_x", leaseExpiresAt: new Date(NOW.getTime() + 60_000) });
    const audits: unknown[] = [];
    const summary = await sweep.sweepAgentComputers({
      now: NOW,
      retention: {
        policy: retention.computerRetentionPolicy({ AGENT_COMPUTER_RETENTION_ENFORCE: "1", AGENT_COMPUTER_RETENTION_DAYS: "30" }),
        listAsleep: async () => [old, fresh, leased],
        audit: async (input) => {
          audits.push(input);
        },
      },
    });
    assert.deepEqual(summary.retentionDeleted, ["expired"]);
    assert.equal(await memDb.findByAgent("user_ret", "expired"), null, "the row is gone");
    assert.equal(fakeComputerProvider.containers.has("juno-agent-expired"), false, "the container is gone");
    assert.equal(fakeComputerProvider.volumes.has("juno-agent-expired"), false, "the files are gone");
    assert.ok(await memDb.findByAgent("user_ret", "fresh"));
    assert.ok(await memDb.findByAgent("user_ret", "leased"));
    assert.deepEqual(audits, [{ userId: "user_ret", agentId: "expired", kind: "retention_deleted", actor: "sweep", detail: { days: 30 } }]);
  });

  it("a computer woken after the sweep listed it is not deleted", async () => {
    const listed = await seedAsleep("woken");
    await memDb.updateByAgent("user_ret", "woken", { status: "awake", lastActiveAt: NOW });
    const destroyed: string[] = [];
    await sweep.sweepAgentComputers({
      now: NOW,
      retention: {
        policy: retention.computerRetentionPolicy({ AGENT_COMPUTER_RETENTION_ENFORCE: "1", AGENT_COMPUTER_RETENTION_DAYS: "30" }),
        listAsleep: async () => [listed],
        destroy: async (r) => {
          destroyed.push(r.agentId);
        },
      },
    });
    assert.deepEqual(destroyed, []);
  });
});
