import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * Memory layer boundaries against real PostgreSQL, through the production
 * reader (getMemoryProfile): account vs project, a shared project's other
 * member, and Orbit agents with each memory grant.
 *
 *   MEMORY_TEST_DATABASE_URL=postgresql://juno@127.0.0.1:54329/juno_memory_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test tests/memory-scope-db.test.ts
 */
const DB_URL = process.env.MEMORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("memory scope database suite requires MEMORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  const url = new URL(DB_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Memory scope tests require a loopback PostgreSQL host.");
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "memory-scope-local-test";
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  test("no reader sees memory it was not granted: projects, shared-project members, agents", async (t) => {
    const { getMemoryProfile } = await import("@/lib/memory");
    const { factFields } = await import("@/lib/memory-lifecycle");
    const { encryptField } = await import("@/lib/field-crypto");
    const suffix = randomUUID();
    const a = await prisma.user.create({ data: { email: `scope-a-${suffix}@example.invalid` } });
    const b = await prisma.user.create({ data: { email: `scope-b-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    });
    const shared = await prisma.project.create({ data: { userId: a.id, name: "Launch" } });
    await prisma.projectMember.create({ data: { projectId: shared.id, userId: b.id, role: "EDITOR" } });

    const fact = async (userId: string, content: string, projectId: string | null = null) => {
      const fields = factFields(content, { source: "MANUAL" });
      return prisma.memoryEntry.create({
        data: {
          userId, content, source: "MANUAL", sourceRef: "manual", projectId,
          category: fields.category, confidence: fields.confidence, normalized: fields.normalized,
          expiresAt: null, observedAt: new Date(),
        },
      });
    };
    await fact(a.id, "The user prefers concise answers.");
    await fact(a.id, "The user writes code in TypeScript.");
    await fact(a.id, "The user lives in Bristol.");
    await fact(a.id, "The user's partner is called Sam.");
    await fact(a.id, "The user was diagnosed with ADHD.");
    await fact(a.id, "The user is studying for a law degree.");
    await fact(a.id, "The launch site uses Astro.", shared.id);
    await fact(b.id, "The user is pregnant.");
    await fact(b.id, "The user owns the analytics dashboard for the launch.", shared.id);
    await prisma.memorySummary.create({
      data: { userId: a.id, content: encryptField("Lives in Bristol with their partner Sam; studying law; has ADHD."), entryCount: 6 },
    });

    const all = "concise answers code TypeScript Bristol partner diagnosed ADHD studying law launch Astro pregnant analytics dashboard";
    const read = async (userId: string, opts: Parameters<typeof getMemoryProfile>[1]) => {
      const profile = await getMemoryProfile(userId, { query: all, budgetTokens: 5_000, ...opts });
      return { facts: profile.recent, summary: profile.summary };
    };

    const account = await read(a.id, { projectId: null });
    assert.ok(account.summary?.includes("Bristol"), "an ordinary chat reads the account summary");
    assert.ok(!account.facts.some((f) => f.includes("Astro")), "project facts stay in their project");
    assert.ok(!account.facts.some((f) => f.includes("pregnant") || f.includes("analytics")), "never another account's");

    const project = await read(a.id, { projectId: shared.id });
    assert.deepEqual(project.facts, ["The launch site uses Astro."], "a project chat reads its project in isolation");
    assert.equal(project.summary, null);

    const member = await read(b.id, { projectId: shared.id });
    assert.deepEqual(member.facts, ["The user owns the analytics dashboard for the launch."], "a member reads only their own project memory");
    assert.ok(!JSON.stringify(member).includes("Astro") && !JSON.stringify(member).includes("Bristol"));

    const agentProfile = await read(a.id, { projectId: null, agent: { id: "agent-1", access: "profile" } });
    assert.equal(agentProfile.summary, null, "prose mixes every category, so a profile-grant agent reads none");
    assert.deepEqual(
      [...agentProfile.facts].sort(),
      ["The user lives in Bristol.", "The user prefers concise answers.", "The user writes code in TypeScript."],
      "profile grant: preferences, workflows, identity — no partner, diagnosis or studies"
    );

    const agentNone = await read(a.id, { projectId: null, agent: { id: "agent-2", access: "none" } });
    assert.deepEqual(agentNone, { facts: [], summary: null });

    const agentFull = await read(a.id, { projectId: shared.id, agent: { id: "agent-3", access: "full" } });
    assert.deepEqual(agentFull.facts, ["The launch site uses Astro."], "full grant in a project: that project, isolated");

    // The agent's memory grant is a column the person sets, default profile.
    const hired = await prisma.agent.create({ data: { userId: a.id, name: "Scout" } });
    assert.equal(hired.memoryAccess, "profile");
  });
}
