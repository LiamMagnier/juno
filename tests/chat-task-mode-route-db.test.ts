import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * /api/conversations/[id]/task-mode through the real route handler against
 * real PostgreSQL (G15): the composer's task mode is saved per conversation,
 * owned, validated, and reported with whatever narrows it.
 *
 *   TASK_MODE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *   tests/chat-task-mode-route-db.test.ts
 */
const DB_URL = process.env.TASK_MODE_TEST_DATABASE_URL;

if (!DB_URL) {
  test("task mode route database suite requires TASK_MODE_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "task-mode-local-test";
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn } });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const patch = (mode: unknown) =>
    new Request("http://x/api/conversations/c/task-mode", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });

  test("the composer's mode is saved on the conversation and read back with what narrows it", async (t) => {
    const { GET, PATCH } = await import("@/app/api/conversations/[id]/task-mode/route");
    const suffix = randomUUID();
    const owner = await prisma.user.create({ data: { email: `mode-a-${suffix}@example.invalid` } });
    const other = await prisma.user.create({ data: { email: `mode-b-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    });
    const chat = await prisma.conversation.create({ data: { userId: owner.id, title: "Plain chat" } });

    signedIn = null;
    assert.equal((await GET(new Request("http://x"), params(chat.id))).status, 401);

    // Someone else's chat is not found, and cannot be written.
    signedIn = { id: other.id };
    assert.equal((await GET(new Request("http://x"), params(chat.id))).status, 404);
    assert.equal((await PATCH(patch("permissive"), params(chat.id))).status, 404);
    assert.equal((await prisma.conversation.findUnique({ where: { id: chat.id } }))?.taskApprovalMode, null);

    signedIn = { id: owner.id };
    const fresh = await (await GET(new Request("http://x"), params(chat.id))).json();
    assert.deepEqual(fresh, { chosen: null, effective: "balanced", narrowedBy: null });

    // Only the three modes, or null.
    assert.equal((await PATCH(patch("plan"), params(chat.id))).status, 400);
    const saved = await PATCH(patch("permissive"), params(chat.id));
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).effective, "permissive");
    assert.equal((await prisma.conversation.findUnique({ where: { id: chat.id } }))?.taskApprovalMode, "permissive");
    const reset = await PATCH(patch(null), params(chat.id));
    assert.equal((await reset.json()).chosen, null);
    assert.equal((await prisma.conversation.findUnique({ where: { id: chat.id } }))?.taskApprovalMode, null);

    // In a project that asks before every change, a hands-off choice is reported as narrowed.
    const project = await prisma.project.create({
      data: { userId: owner.id, name: "Careful", workDefaults: { permissionPolicy: "conservative" } },
    });
    const inProject = await prisma.conversation.create({
      data: { userId: owner.id, title: "Project chat", projectId: project.id, taskApprovalMode: "permissive" },
    });
    const narrowed = await (await GET(new Request("http://x"), params(inProject.id))).json();
    assert.equal(narrowed.chosen, "permissive");
    assert.equal(narrowed.effective, "conservative");
    assert.equal(narrowed.narrowedBy, "project");

    // A project set to "Just do it" cannot loosen anything: the dispatcher
    // folds it from the default (inheritFromProjectDefaults), so its tasks run
    // as "Ask before risky steps", and the chip must say so rather than
    // promise "Just do it".
    const loose = await prisma.project.create({
      data: { userId: owner.id, name: "Loose", workDefaults: { permissionPolicy: "permissive" } },
    });
    const inLoose = await prisma.conversation.create({
      data: { userId: owner.id, title: "Loose chat", projectId: loose.id, taskApprovalMode: "permissive" },
    });
    const looseView = await (await GET(new Request("http://x"), params(inLoose.id))).json();
    assert.equal(looseView.effective, "balanced");
    assert.equal(looseView.narrowedBy, "project");
    // A project with no approval setting of its own leaves the choice alone.
    const open = await prisma.project.create({ data: { userId: owner.id, name: "Open", workDefaults: {} } });
    const inOpen = await prisma.conversation.create({
      data: { userId: owner.id, title: "Open chat", projectId: open.id, taskApprovalMode: "permissive" },
    });
    const openView = await (await GET(new Request("http://x"), params(inOpen.id))).json();
    assert.equal(openView.effective, "permissive");
    assert.equal(openView.narrowedBy, null);

    // An agent's thread keeps the agent's mode as the ceiling.
    const agent = await prisma.agent.create({ data: { userId: owner.id, name: "Mira", approvalMode: "balanced" } });
    const thread = await prisma.conversation.create({
      data: { userId: owner.id, title: "Mira", agentId: agent.id, taskApprovalMode: "permissive" },
    });
    const agentView = await (await GET(new Request("http://x"), params(thread.id))).json();
    assert.equal(agentView.effective, "balanced");
    assert.equal(agentView.narrowedBy, "agent");

    // A Code conversation has no chat composer mode.
    const code = await prisma.conversation.create({ data: { userId: owner.id, title: "Code", kind: "code" } });
    assert.equal((await GET(new Request("http://x"), params(code.id))).status, 404);
  });

  test.after(async () => {
    await prisma.$disconnect();
  });
}
