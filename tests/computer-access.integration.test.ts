/**
 * Agent computer access on a real Postgres (src/lib/computer/store.ts, prisma
 * persistence; docs/design/agents-v2/COMPUTERS_2026-10.md §S1.2, §4.1).
 * Opt-in, like the other database tests, and run in CI's "Agent computer sweep
 * writes" step:
 *
 *   COMPUTER_TEST_DATABASE_URL=postgresql://…/juno_computer_test \
 *     NODE_OPTIONS=--conditions=react-server npx tsx --test tests/computer-access.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const url = process.env.COMPUTER_TEST_DATABASE_URL;

async function setup() {
  assert.match(url!, /\/juno_[a-z0-9_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "computer-access-integration-test-key";
  process.env.AGENT_COMPUTER_PROVIDER = "fake";
  process.env.AGENT_COMPUTER_ROLLOUT = "plans";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const store = await import("../src/lib/computer/store");
  const { resetComputerProviderCache } = await import("../src/lib/computer/provider");
  const { fakeComputerProvider } = await import("../src/lib/computer/fake");
  resetComputerProviderCache();
  fakeComputerProvider.reset();
  return { db, store, fakeComputerProvider };
}

test("two concurrent enables cannot pass the enabled cap", { skip: !url }, async () => {
  const { db, store, fakeComputerProvider } = await setup();
  const userId = `cap_${randomUUID()}`;
  const email = `${userId}@example.invalid`;
  // An owner account (OWNER_EMAILS), held to one computer for the test.
  const savedOwners = process.env.OWNER_EMAILS;
  process.env.OWNER_EMAILS = email;
  process.env.AGENT_COMPUTER_MAX_ENABLED_OWNER = "1";
  try {
    await db.user.create({ data: { id: userId, email } });
    const agents = await Promise.all(
      ["One", "Two", "Three"].map((name) => db.agent.create({ data: { userId, name, role: "Tester", instructions: "Tests caps." } })),
    );
    const results = await Promise.allSettled(agents.map((agent) => store.enableComputer(userId, agent.id)));
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(won.length, 1, "exactly one enable passed the cap");
    assert.equal(lost.length, 2);
    for (const failure of lost) assert.equal((failure.reason as { code?: string }).code, "enabled_cap");
    assert.equal(await db.agentComputer.count({ where: { userId } }), 1);
    assert.equal(fakeComputerProvider.calls.filter((c) => c.method === "create").length, 1);
    assert.ok((await db.agentComputerAudit.count({ where: { userId, kind: "refused" } })) >= 2, "the refusals are audited");
  } finally {
    if (savedOwners === undefined) delete process.env.OWNER_EMAILS;
    else process.env.OWNER_EMAILS = savedOwners;
    delete process.env.AGENT_COMPUTER_MAX_ENABLED_OWNER;
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});

test("a reset that would create a computer takes the same slot: an enable and resets at once cannot pass the cap", { skip: !url }, async () => {
  const { db, store, fakeComputerProvider } = await setup();
  const userId = `reset_${randomUUID()}`;
  const email = `${userId}@example.invalid`;
  const savedOwners = process.env.OWNER_EMAILS;
  process.env.OWNER_EMAILS = email;
  process.env.AGENT_COMPUTER_MAX_ENABLED_OWNER = "1";
  try {
    await db.user.create({ data: { id: userId, email } });
    const [one, two, three] = await Promise.all(
      ["One", "Two", "Three"].map((name) => db.agent.create({ data: { userId, name, role: "Tester", instructions: "Tests caps." } })),
    );
    const results = await Promise.allSettled([
      store.enableComputer(userId, one!.id),
      store.resetComputer(userId, two!.id),
      store.resetComputer(userId, three!.id),
    ]);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(results.length - lost.length, 1, "exactly one of them got a computer");
    for (const failure of lost) assert.equal((failure.reason as { code?: string }).code, "enabled_cap");
    assert.equal(await db.agentComputer.count({ where: { userId } }), 1);
    assert.equal(fakeComputerProvider.calls.filter((c) => c.method === "create").length, 1, "one container");
  } finally {
    if (savedOwners === undefined) delete process.env.OWNER_EMAILS;
    else process.env.OWNER_EMAILS = savedOwners;
    delete process.env.AGENT_COMPUTER_MAX_ENABLED_OWNER;
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});

test("usage intervals are idempotent per start", { skip: !url }, async () => {
  const { db, store } = await setup();
  const userId = `usage_${randomUUID()}`;
  try {
    await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    const persistence = store.getComputerStorePersistence();
    const startedAt = new Date("2026-10-27T10:00:00.000Z");
    const weekStart = store.weekStartUtc(startedAt);
    const row = { userId, agentId: `agent_${userId}`, startedAt, seconds: 600, weekStart, runId: "run_1" };
    await Promise.all([persistence.recordUsageInterval(row), persistence.recordUsageInterval(row), persistence.recordUsageInterval(row)]);
    assert.equal(await db.agentComputerUsageInterval.count({ where: { userId } }), 1);
    assert.equal(await persistence.sumUsageSeconds(userId, weekStart), 600);
    // A later settlement of the same start lengthens it; an earlier, shorter one never shortens it.
    await persistence.recordUsageInterval({ ...row, seconds: 900 });
    await persistence.recordUsageInterval({ ...row, seconds: 300 });
    assert.equal(await persistence.sumUsageSeconds(userId, weekStart), 900);
    assert.equal(await db.agentComputerUsageInterval.count({ where: { userId } }), 1);
    // Another week, another sum; the stored week is Monday 00:00 UTC.
    const stored = await db.agentComputerUsageInterval.findFirstOrThrow({ where: { userId } });
    assert.equal(stored.weekStart.toISOString(), "2026-10-26T00:00:00.000Z");
    assert.equal(await persistence.sumUsageSeconds(userId, new Date("2026-11-02T00:00:00.000Z")), 0);
    // Metering through the store at a price of 0.
    delete process.env.AGENT_COMPUTER_COST_USD_PER_MIN;
    delete process.env.COMPUTER_COST_MICRO_USD_PER_SECOND;
    await store.billComputerSeconds({ userId, agentId: `agent_${userId}`, seconds: 120, since: new Date("2026-10-27T12:00:00.000Z") });
    assert.equal(await persistence.sumUsageSeconds(userId, weekStart), 1020);
  } finally {
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});

test("an interval across Monday 00:00 UTC is stored as one row per week", { skip: !url }, async () => {
  const { db, store } = await setup();
  const userId = `week_${randomUUID()}`;
  try {
    await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    const persistence = store.getComputerStorePersistence();
    const agentId = `agent_${userId}`;
    const sunday = new Date("2026-10-25T23:00:00.000Z");
    // Settled twice (a retry that ran on): the pieces are keyed on their own starts.
    await store.billComputerSeconds({ userId, agentId, seconds: 7200, since: sunday });
    await store.billComputerSeconds({ userId, agentId, seconds: 9000, since: sunday });
    const rows = await db.agentComputerUsageInterval.findMany({ where: { userId }, orderBy: { startedAt: "asc" } });
    assert.deepEqual(
      rows.map((r) => [r.startedAt.toISOString(), r.seconds, r.weekStart.toISOString()]),
      [
        ["2026-10-25T23:00:00.000Z", 3600, "2026-10-19T00:00:00.000Z"],
        ["2026-10-26T00:00:00.000Z", 5400, "2026-10-26T00:00:00.000Z"],
      ],
    );
    assert.equal(await persistence.sumUsageSeconds(userId, new Date("2026-10-26T00:00:00.000Z")), 5400);
    assert.equal(await persistence.sumUsageSeconds(userId, new Date("2026-10-19T00:00:00.000Z")), 3600);
  } finally {
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
});

test("the migration maps agents with a computer to allowed and the rest to ask", { skip: !url }, async () => {
  const { db } = await setup();
  const userId = `migrate_${randomUUID()}`;
  try {
    await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    const withComputer = await db.agent.create({ data: { userId, name: "Has", role: "R", instructions: "x" } });
    const without = await db.agent.create({ data: { userId, name: "Hasnt", role: "R", instructions: "x" } });
    assert.equal(without.computerPolicy, "ask", "the column's default for every new agent");
    await db.agentComputer.create({ data: { userId, agentId: withComputer.id, provider: "fake" } });
    // The data step, exactly as the migration runs it, on rows as they were before it.
    await db.agent.updateMany({ where: { userId }, data: { computerPolicy: "ask" } });
    const sql = readFileSync(new URL("../prisma/migrations/20261028100000_agent_computer_access/migration.sql", import.meta.url), "utf8");
    const update = sql.split("\n").find((line) => line.startsWith('UPDATE "Agent" SET "computerPolicy"'));
    assert.ok(update, "the migration carries its data step");
    await db.$executeRawUnsafe(update!.replace(/;$/, ` AND "userId" = '${userId}';`));
    assert.equal((await db.agent.findUniqueOrThrow({ where: { id: withComputer.id } })).computerPolicy, "allowed");
    assert.equal((await db.agent.findUniqueOrThrow({ where: { id: without.id } })).computerPolicy, "ask");
    // And the new column on AgentComputer exists and starts empty.
    assert.equal((await db.agentComputer.findUniqueOrThrow({ where: { agentId: withComputer.id } })).lastContactAt, null);
  } finally {
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
    const { prismaUnguarded } = await import("../src/lib/prisma");
    await prismaUnguarded.$disconnect();
  }
});
