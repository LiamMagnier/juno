import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * DELETE /api/memory?projectId= — "Clear this project's memory", through the
 * real route handler against real PostgreSQL.
 *
 *   MEMORY_TEST_DATABASE_URL=postgresql://juno@127.0.0.1:54329/juno_memory_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *   tests/memory-clear-project-db.test.ts
 */
const DB_URL = process.env.MEMORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("clear-project database suite requires MEMORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "clear-project-local-test";
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn } });

  test("clearing a project removes only that person's facts and summary there, and marks its chats read", async (t) => {
    const { DELETE } = await import("@/app/api/memory/route");
    const { encryptField } = await import("@/lib/field-crypto");
    const suffix = randomUUID();
    const a = await prisma.user.create({ data: { email: `clear-a-${suffix}@example.invalid` } });
    const b = await prisma.user.create({ data: { email: `clear-b-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    });
    const p = await prisma.project.create({ data: { userId: a.id, name: "Launch" } });
    await prisma.projectMember.create({ data: { projectId: p.id, userId: b.id } });
    const chat = await prisma.conversation.create({ data: { userId: a.id, projectId: p.id, title: "Launch chat" } });
    const row = (userId: string, content: string, projectId: string | null, kind: "FACT" | "SUPPRESSION" = "FACT") =>
      prisma.memoryEntry.create({ data: { userId, content, projectId, kind, source: "MANUAL" } });
    await row(a.id, "The launch site uses Astro.", p.id);
    await row(a.id, "The user lives in Bristol.", null);
    await row(b.id, "The user owns analytics for the launch.", p.id);
    await prisma.projectMemorySummary.create({ data: { userId: a.id, projectId: p.id, content: encryptField("Astro launch.") } });
    await prisma.projectMemorySummary.create({ data: { userId: b.id, projectId: p.id, content: encryptField("Analytics.") } });

    signedIn = null;
    assert.equal((await DELETE(new Request(`http://x/api/memory?projectId=${p.id}`, { method: "DELETE" }))).status, 401);

    signedIn = { id: a.id };
    const res = await DELETE(new Request(`http://x/api/memory?projectId=${p.id}`, { method: "DELETE" }));
    assert.equal(res.status, 200);
    assert.equal(await prisma.memoryEntry.count({ where: { userId: a.id, projectId: p.id } }), 0);
    assert.equal(await prisma.memoryEntry.count({ where: { userId: a.id, projectId: null } }), 1, "account memory untouched");
    assert.equal(await prisma.projectMemorySummary.count({ where: { userId: a.id, projectId: p.id } }), 0);
    assert.equal(await prisma.memoryEntry.count({ where: { userId: b.id, projectId: p.id } }), 1, "another member's untouched");
    assert.equal(await prisma.projectMemorySummary.count({ where: { userId: b.id, projectId: p.id } }), 1);
    const read = await prisma.conversationMemory.findUnique({ where: { conversationId: chat.id } });
    assert.ok(read, "the project's chats are marked read so background learning does not relearn them");
  });
}
