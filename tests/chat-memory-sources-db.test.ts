import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * G20 against real PostgreSQL: a turn's "Memory updated" receipt names the
 * rows it saved by id, Undo on one of them forgets it through the memory
 * route (so it is not relearned), and pressing Undo again after a reload does
 * not pile up block-list rows.
 *
 *   MEMORY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *   tests/chat-memory-sources-db.test.ts
 */
const DB_URL = process.env.MEMORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("memory sources database suite requires MEMORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "memory-sources-local-test";

  let signedIn: { id: string } | null = null;
  test.before(async () => {
    mock.module("@/lib/session", {
      namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn },
    });
    const server = await import("next/server");
    // Summary rebuilds are scheduled with after(); not needed here.
    mock.module("next/server", { namedExports: { ...server, after: () => undefined } });
  });

  const FAKE_MODEL = { id: "test:flat", provider: "openai", providerModel: "flat", dimensions: 3 } as const;
  const embed = async ({ texts }: { texts: string[] }) => ({ ok: true as const, model: FAKE_MODEL, vectors: texts.map(() => [0, 0, 1]) });

  test("the receipt names the saved rows, and Undo forgets them once", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const itemRoute = await import("@/app/api/memory/[id]/route");
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `mem-src-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });
    const chat = await prisma.conversation.create({ data: { userId: user.id, title: "Training" } });

    const receipts: Array<{ title: string; url: string; memoryWrite?: { saved: Array<{ id: string; content: string }> } }> = [];
    const result = await memory.saveCandidates(
      user.id,
      ["The user is training for a marathon.", "The user prefers morning runs."],
      chat.id,
      { embed: embed as never, policy: { mode: "any_allowed_provider" } as never, onActivity: (event) => receipts.push(event) },
    );
    assert.equal(result.created, 2);
    assert.equal(result.believed.length, 2);
    const rows = await prisma.memoryEntry.findMany({ where: { userId: user.id, kind: "FACT" }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(new Set(result.believed.map((b) => b.id)), new Set(rows.map((r) => r.id)));

    // One receipt, naming both rows by id and linking to the first.
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].title, "Memory updated");
    assert.deepEqual(new Set(receipts[0].memoryWrite?.saved.map((s) => s.id)), new Set(rows.map((r) => r.id)));
    assert.equal(receipts[0].url, `/memory?entry=${encodeURIComponent(receipts[0].memoryWrite!.saved[0].id)}`);

    // A refresh of a known fact is not announced as an update.
    const again: unknown[] = [];
    const repeat = await memory.saveCandidates(user.id, ["The user is training for a marathon."], chat.id, {
      embed: embed as never,
      policy: { mode: "any_allowed_provider" } as never,
      onActivity: (event) => again.push(event),
    });
    assert.equal(repeat.believed.length, 0);
    assert.equal(again.length, 0);

    // Undo: the chat's PATCH { forget: true } on the saved row.
    const target = receipts[0].memoryWrite!.saved[0];
    const undo = () =>
      itemRoute.PATCH(
        new Request(`http://x/api/memory/${target.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ forget: true }),
        }),
        { params: Promise.resolve({ id: target.id }) },
      );
    signedIn = { id: user.id };
    assert.equal((await undo()).status, 200);
    const retired = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(retired.status, "suppressed");
    const blocks = () => prisma.memoryEntry.count({ where: { userId: user.id, kind: "SUPPRESSION" } });
    assert.equal(await blocks(), 1, "the undone fact is blocked from being learned again");

    // The receipt is historical, so after a reload Undo can be pressed again:
    // it answers as already done and writes nothing more.
    const second = await undo();
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { status?: string }).status, "suppressed");
    assert.equal(await blocks(), 1);

    // And the extractor cannot bring it back.
    const relearn = await memory.saveCandidates(user.id, [target.content], chat.id, {
      embed: embed as never,
      policy: { mode: "any_allowed_provider" } as never,
    });
    assert.equal(relearn.believed.length, 0);
  });

  test("Undo on a fact that replaced another brings the older one back; Forget does not", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const itemRoute = await import("@/app/api/memory/[id]/route");
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `mem-undo-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });
    const chat = await prisma.conversation.create({ data: { userId: user.id, title: "Moving" } });
    const opts = { embed: embed as never, policy: { mode: "any_allowed_provider" } as never };
    const save = async (fact: string) => {
      const receipts: Array<{ memoryWrite?: { saved: Array<{ id: string }> } }> = [];
      await memory.saveCandidates(user.id, [fact], chat.id, { ...opts, onActivity: (event) => receipts.push(event) });
      const id = receipts[0]?.memoryWrite?.saved[0]?.id;
      assert.ok(id, `the receipt names the row saved for “${fact}”`);
      return id;
    };
    const patch = (id: string, body: Record<string, unknown>) =>
      itemRoute.PATCH(
        new Request(`http://x/api/memory/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      );
    signedIn = { id: user.id };
    const status = async (id: string) => (await prisma.memoryEntry.findUniqueOrThrow({ where: { id } })).status;

    // Lisbon, then Porto replaces it, and the chat's Undo takes Porto back.
    const lisbon = await save("The user lives in Lisbon.");
    const porto = await save("The user lives in Porto.");
    assert.equal(await status(lisbon), "superseded");
    const undone = await patch(porto, { forget: true, undo: true });
    assert.equal(undone.status, 200);
    assert.equal(((await undone.json()) as { restored?: number }).restored, 1);
    assert.equal(await status(porto), "suppressed");
    const back = await prisma.memoryEntry.findUniqueOrThrow({ where: { id: lisbon } });
    assert.equal(back.status, "active", "what the undone fact replaced is believed again");
    assert.equal(back.supersededById, null);
    assert.equal(back.reason, null);

    // A plain Forget of a replacing fact leaves what it replaced retired.
    const madrid = await save("The user lives in Madrid.");
    assert.equal(await status(lisbon), "superseded");
    const forgot = await patch(madrid, { forget: true });
    assert.equal(((await forgot.json()) as { restored?: number }).restored, 0);
    assert.equal(await status(madrid), "suppressed");
    assert.equal(await status(lisbon), "superseded", "Forget is not a claim the older fact holds again");
  });

  test("Not relevant marks a fact in use, on its own, and can be taken back", async (t) => {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const memory = await import("@/lib/memory");
    const itemRoute = await import("@/app/api/memory/[id]/route");
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `mem-nr-${suffix}@example.invalid` } });
    const other = await prisma.user.create({ data: { email: `mem-nr-b-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
    });
    const fact = await prisma.memoryEntry.create({
      data: { userId: user.id, content: "The user prefers short answers.", category: "preferences" },
    });
    const patch = (id: string, body: unknown) =>
      itemRoute.PATCH(
        new Request(`http://x/api/memory/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      );
    const row = () => prisma.memoryEntry.findUniqueOrThrow({ where: { id: fact.id } });

    // Someone else's fact is not found.
    signedIn = { id: other.id };
    assert.equal((await patch(fact.id, { notRelevant: true })).status, 404);

    signedIn = { id: user.id };
    const before = await row();
    // A signal about ranking, not an edit: it travels alone.
    assert.equal((await patch(fact.id, { notRelevant: true, content: "x" })).status, 400);
    const marked = await patch(fact.id, { notRelevant: true });
    assert.equal(marked.status, 200);
    const after = await row();
    assert.ok(after.notRelevantAt, "the mark is saved");
    assert.equal(after.content, before.content);
    assert.equal(after.status, "active", "the fact is still remembered");
    assert.equal(after.lastVerifiedAt?.getTime() ?? null, before.lastVerifiedAt?.getTime() ?? null, "marking is not restating");

    // The ranking reads it: an off-topic message no longer carries this fact.
    const profile = await memory.getMemoryProfile(user.id, { query: "What is 17 times 23?" });
    assert.equal(profile.used.some((m) => m.id === fact.id), false);

    // Taken back, and the fact rides along again.
    assert.equal((await patch(fact.id, { notRelevant: false })).status, 200);
    assert.equal((await row()).notRelevantAt, null);
    const again = await memory.getMemoryProfile(user.id, { query: "What is 17 times 23?" });
    assert.equal(again.used.some((m) => m.id === fact.id), true);

    // A forgotten fact is not in use, so there is nothing to mark.
    assert.equal((await patch(fact.id, { forget: true })).status, 200);
    assert.equal((await patch(fact.id, { notRelevant: true })).status, 409);
  });
}
