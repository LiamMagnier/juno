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

  // The edit ledger keeps each applied edit's Undo, and an Undo carries the
  // text it would put back. A cleared project whose ledger kept them still
  // held the cleared facts verbatim, and pressing Undo wrote them back.
  test("clearing a project drops the edits whose Undo would put its facts back, and only those", async (t) => {
    const { DELETE } = await import("@/app/api/memory/route");
    const suffix = randomUUID();
    const a = await prisma.user.create({ data: { email: `clear-ledger-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: a.id } });
    });
    const p = await prisma.project.create({ data: { userId: a.id, name: "Launch" } });
    const other = await prisma.project.create({ data: { userId: a.id, name: "Garden" } });
    const fact = (content: string, projectId: string | null) =>
      prisma.memoryEntry.create({ data: { userId: a.id, content, projectId, source: "MANUAL" } });
    const kept = await fact("The launch site uses Astro.", p.id);
    const account = await fact("The user lives in Bristol.", null);
    const edit = (clientId: string, operations: unknown[], inverse: unknown[]) =>
      prisma.memoryEdit.create({
        data: { userId: a.id, clientId, instruction: clientId, status: "applied", operations: operations as never, inverse: inverse as never },
      });
    // Removed a project fact: the Undo re-adds it, into the project.
    await edit("removed-in-project", [{ op: "remove", id: "gone-row", before: "The launch is on Friday." }], [
      { op: "add", content: "The launch is on Friday.", projectId: p.id },
    ]);
    // Rewrote a project fact that is still there.
    await edit("rewrote-in-project", [{ op: "update", id: kept.id, before: "The site uses Hugo.", content: "The launch site uses Astro." }], [
      { op: "update", id: kept.id, before: "The launch site uses Astro.", content: "The site uses Hugo." },
    ]);
    // An account fact, and another project's: neither is this clear's business.
    await edit("rewrote-account", [{ op: "update", id: account.id, before: "The user lives in Bath.", content: "The user lives in Bristol." }], [
      { op: "update", id: account.id, before: "The user lives in Bristol.", content: "The user lives in Bath." },
    ]);
    await edit("added-elsewhere", [{ op: "add", content: "Roses need pruning in March.", projectId: other.id }], [
      { op: "remove", id: "rose-row", before: "Roses need pruning in March." },
    ]);

    signedIn = { id: a.id };
    const res = await DELETE(new Request(`http://x/api/memory?projectId=${p.id}`, { method: "DELETE" }));
    assert.equal(res.status, 200);
    const left = (await prisma.memoryEdit.findMany({ where: { userId: a.id }, select: { clientId: true } })).map((row) => row.clientId).sort();
    assert.deepEqual(left, ["added-elsewhere", "rewrote-account"]);
  });
}
