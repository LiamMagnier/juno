import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * The after-turn reader against what the person does while it reads.
 *
 * `extractConversationMemory` reads a chat's new messages, then waits on a
 * model for seconds before it saves what it heard. That wait is exactly when
 * someone who regrets what they said acts: deletes the chat, turns memory off
 * for it, pauses memory, clears the project's memory or resets everything.
 * Each of those promises the chat will not be learned from, so a reader that
 * started before the promise must not write after it.
 *
 *   MEMORY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/<disposable db> \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *   tests/memory-extraction-race-db.test.ts
 */
const DB_URL = process.env.MEMORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("extraction race database suite requires MEMORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "memory-extraction-race-local-test";

  let signedIn: { id: string } | null = null;
  test.before(async () => {
    mock.module("@/lib/session", {
      namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn },
    });
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: () => undefined } });
  });

  // Not a sensitive subject: those are refused at the door whatever the timing.
  const FACT = "The user takes the 7:40 train to work.";
  const policy = { mode: "any_allowed_provider" } as never;

  /** A user with one chat (in a project when asked) holding one unread message. */
  async function setup(label: string, opts: { project?: boolean } = {}) {
    const { prismaUnguarded: prisma } = await import("@/lib/prisma");
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const user = await prisma.user.create({ data: { email: `race-${label}-${randomUUID()}@example.invalid` } });
    const project = opts.project ? await prisma.project.create({ data: { userId: user.id, name: "Commute" } }) : null;
    const chat = await prisma.conversation.create({
      data: { userId: user.id, title: "Commute", projectId: project?.id ?? null, lastMessageAt: new Date() },
    });
    await prisma.message.create({
      data: { conversationId: chat.id, role: "USER", content: encryptMessageText("I take the 7:40 train to work.") },
    });
    return { prisma, user, chat, project };
  }

  /** A reader whose model "thinks" while `during` runs, then answers with FACT. */
  const readerThat = (during: () => Promise<unknown>) => async () => {
    await during();
    return JSON.stringify({ facts: [FACT], digest: "Talked about the commute." });
  };

  const facts = async (prisma: Awaited<ReturnType<typeof setup>>["prisma"], userId: string) =>
    prisma.memoryEntry.count({ where: { userId, kind: "FACT" } });

  test("control: with nothing in the way, the reader saves what it heard", async (t) => {
    const memory = await import("@/lib/memory");
    const { prisma, user, chat } = await setup("control");
    t.after(() => prisma.user.deleteMany({ where: { id: user.id } }));
    const result = await memory.extractConversationMemory({ userId: user.id, conversationId: chat.id, policy, llm: readerThat(async () => {}) });
    assert.equal(result.created, 1);
    assert.equal(await facts(prisma, user.id), 1);
  });

  test("a chat deleted while its reader waits on the model teaches memory nothing", async (t) => {
    const memory = await import("@/lib/memory");
    const { prisma, user, chat } = await setup("deleted");
    t.after(() => prisma.user.deleteMany({ where: { id: user.id } }));
    const result = await memory.extractConversationMemory({
      userId: user.id,
      conversationId: chat.id,
      policy,
      llm: readerThat(() => prisma.conversation.delete({ where: { id: chat.id } })),
    });
    assert.equal(result.created, 0);
    assert.equal(await facts(prisma, user.id), 0, "nothing from a deleted chat is remembered");
  });

  test("memory turned off for the chat while its reader waits: nothing saved", async (t) => {
    const memory = await import("@/lib/memory");
    const { setConversationMemoryOff } = await import("@/lib/chat/memory-off-store");
    const { prisma, user, chat } = await setup("chat-off");
    t.after(() => prisma.user.deleteMany({ where: { id: user.id } }));
    await memory.extractConversationMemory({
      userId: user.id,
      conversationId: chat.id,
      policy,
      llm: readerThat(() => setConversationMemoryOff(prisma, { userId: user.id, conversationId: chat.id, off: true })),
    });
    assert.equal(await facts(prisma, user.id), 0);
  });

  test("memory paused for the account while the reader waits: nothing saved", async (t) => {
    const memory = await import("@/lib/memory");
    const { prisma, user, chat } = await setup("paused");
    t.after(() => prisma.user.deleteMany({ where: { id: user.id } }));
    await memory.extractConversationMemory({
      userId: user.id,
      conversationId: chat.id,
      policy,
      llm: readerThat(() =>
        prisma.settings.upsert({
          where: { userId: user.id },
          create: { userId: user.id, memoryEnabled: false },
          update: { memoryEnabled: false },
        }),
      ),
    });
    assert.equal(await facts(prisma, user.id), 0);
  });

  test("a reset while the reader waits stays a reset: nothing relearned, the read mark not rewound", async (t) => {
    const memory = await import("@/lib/memory");
    const listRoute = await import("@/app/api/memory/route");
    const { prisma, user, chat } = await setup("reset");
    t.after(() => prisma.user.deleteMany({ where: { id: user.id } }));
    signedIn = { id: user.id };
    let resetAt: Date | null = null;
    await memory.extractConversationMemory({
      userId: user.id,
      conversationId: chat.id,
      policy,
      llm: readerThat(async () => {
        assert.equal((await listRoute.DELETE(new Request("http://x/api/memory", { method: "DELETE" }))).status, 200);
        resetAt = (await prisma.conversationMemory.findUniqueOrThrow({ where: { conversationId: chat.id } })).processedAt;
      }),
    });
    assert.equal(await facts(prisma, user.id), 0, "“permanently erased” is not undone by a reader already in flight");
    const mark = await prisma.conversationMemory.findUniqueOrThrow({ where: { conversationId: chat.id } });
    assert.equal(mark.processedAt?.getTime(), resetAt!.getTime(), "the reset's read mark stands");
  });

  test("a project's memory cleared while its chat's reader waits: nothing saved there", async (t) => {
    const memory = await import("@/lib/memory");
    const listRoute = await import("@/app/api/memory/route");
    const { prisma, user, chat, project } = await setup("project", { project: true });
    t.after(() => prisma.user.deleteMany({ where: { id: user.id } }));
    signedIn = { id: user.id };
    await memory.extractConversationMemory({
      userId: user.id,
      conversationId: chat.id,
      policy,
      llm: readerThat(async () => {
        const res = await listRoute.DELETE(new Request(`http://x/api/memory?projectId=${project!.id}`, { method: "DELETE" }));
        assert.equal(res.status, 200);
      }),
    });
    assert.equal(await prisma.memoryEntry.count({ where: { userId: user.id, projectId: project!.id } }), 0);
  });

  test("a chat moved out of its project while the reader waits: nothing lands in the scope it left", async (t) => {
    const memory = await import("@/lib/memory");
    const { prisma, user, chat, project } = await setup("moved", { project: true });
    t.after(() => prisma.user.deleteMany({ where: { id: user.id } }));
    await memory.extractConversationMemory({
      userId: user.id,
      conversationId: chat.id,
      policy,
      llm: readerThat(() => prisma.conversation.update({ where: { id: chat.id }, data: { projectId: null } })),
    });
    assert.equal(await prisma.memoryEntry.count({ where: { userId: user.id, projectId: project!.id } }), 0);
  });
}
