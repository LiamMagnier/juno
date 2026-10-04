import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * Procedural memory against real PostgreSQL: completed runs → a proposal;
 * "Not a skill" is never proposed again; "Make it a skill" creates a skill
 * the person owns with auto-selection off. Another account sees nothing.
 *
 *   MEMORY_TEST_DATABASE_URL=postgresql://juno@127.0.0.1:54329/juno_memory_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test tests/procedural-memory-db.test.ts
 */
const DB_URL = process.env.MEMORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("procedural memory database suite requires MEMORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "procedural-local-test";
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  test("repeated successful runs are proposed, reviewed, and only then become a skill", async (t) => {
    const store = await import("@/lib/procedural-memory-store");
    const suffix = randomUUID();
    const me = await prisma.user.create({ data: { email: `proc-${suffix}@example.invalid` } });
    const other = await prisma.user.create({ data: { email: `proc-other-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [me.id, other.id] } } });
    });
    const runOf = async (userId: string, title: string, goal: string, tools: string[], status = "completed") => {
      const session = await prisma.workSession.create({ data: { userId, title, goal, status } });
      const run = await prisma.workRun.create({ data: { sessionId: session.id, userId, status: "succeeded" } });
      let seq = 0;
      for (const tool of tools) {
        await prisma.workEvent.create({
          data: { runId: run.id, userId, seq: ++seq, kind: "tool_finished", payload: { tool, isError: false } },
        });
      }
      return session.id;
    };
    for (const goal of [
      "Draft this week's investor update from the metrics sheet",
      "Write the weekly investor update from the metrics sheet",
      "Draft the investor update from the metrics sheet and changelog",
    ]) {
      await runOf(me.id, "Weekly investor update", goal, ["read_spreadsheet", "write_document"]);
    }
    // A failed run does not count; another account's runs are invisible.
    await runOf(me.id, "Weekly investor update", "Draft the investor update from the metrics sheet", ["write_document"], "failed");
    for (let i = 0; i < 3; i++) await runOf(other.id, "Weekly investor update", "Draft the investor update from the metrics sheet", ["write_document"]);

    assert.deepEqual(await store.refreshSkillCandidates(me.id), { proposed: 1 });
    assert.deepEqual(await store.refreshSkillCandidates(me.id), { proposed: 0 }, "a refresh updates, never duplicates");
    const [candidate] = await store.listSkillCandidates(me.id);
    assert.equal(candidate.title, "Weekly investor update");
    assert.equal(candidate.runCount, 3);
    assert.equal(await prisma.workSkill.count({ where: { userId: me.id } }), 0, "a proposal creates nothing");

    const accepted = await store.acceptSkillCandidate(me.id, candidate.id);
    assert.ok(accepted.ok);
    const skill = await prisma.workSkill.findFirst({ where: { userId: me.id } });
    assert.equal(skill?.autoSelect, false);
    assert.equal(skill?.trust, "user_authored");
    assert.equal((await store.listSkillCandidates(me.id)).length, 0);

    // Another account cannot accept or dismiss my proposal.
    await prisma.skillCandidate.updateMany({ where: { userId: me.id }, data: { status: "pending", skillId: null } });
    const mine = (await store.listSkillCandidates(me.id))[0];
    assert.equal(await store.dismissSkillCandidate(other.id, mine.id), false);
    assert.equal((await store.acceptSkillCandidate(other.id, mine.id)).ok, false);

    // Dismissed: never proposed again.
    assert.equal(await store.dismissSkillCandidate(me.id, mine.id), true);
    await store.refreshSkillCandidates(me.id);
    assert.equal((await store.listSkillCandidates(me.id)).length, 0);
  });
}
