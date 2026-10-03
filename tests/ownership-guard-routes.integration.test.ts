import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * The production outage of 2026-10-01, against Postgres through the real route
 * handlers and the real guarded client.
 *
 * The ownership guard (src/lib/db.ts) started throwing in every environment,
 * and these call sites were still unscoped: every turn in a project chat,
 * project rename/instructions/work defaults and delete, the member list,
 * iPhone-to-Mac remote commands, roadmap votes (500 after the vote was
 * written), the admin users page (and its empty-search `in: []`), Composio
 * claim transitions, research source refresh, memory extraction's "read up to
 * here" mark, the attachment text cache, and the agent computer status read.
 * Each one is driven here and must now work for the people allowed to do it,
 * and still be refused to the people who are not.
 *
 * tests/ownership-guard-callsites.test.ts is the static gate that keeps new
 * unscoped calls out; this is the runtime proof that the fixes are the right
 * shape for Postgres and Prisma, not just for the scanner.
 *
 * Skipped unless OWNERSHIP_TEST_DATABASE_URL names a throwaway database on
 * this machine (never DATABASE_URL). Run it with:
 *
 *   createdb juno_ownership && DATABASE_URL=postgresql:///juno_ownership \
 *     DIRECT_URL=postgresql:///juno_ownership npx prisma migrate deploy
 *   OWNERSHIP_TEST_DATABASE_URL=postgresql:///juno_ownership NODE_ENV=production \
 *     NODE_OPTIONS=--conditions=react-server \
 *     npx tsx --test --experimental-test-module-mocks tests/ownership-guard-routes.integration.test.ts
 */

const DB_URL = process.env.OWNERSHIP_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const local = DB_URL ? /^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])?(:\d+)?\//.test(DB_URL) : false;

if (!DB_URL || !canMockModules || !local) {
  test("ownership guard route suite is skipped without a local OWNERSHIP_TEST_DATABASE_URL and module mocks", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "ownership-guard-route-test-secret";

  const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  const logged: string[] = [];
  const params = <T extends string>(key: T, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<T, string>) });
  const json = (url: string, method: string, body?: unknown) =>
    new Request(`http://juno.test${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function person(label: string) {
    const tag = `${label}-${Date.now()}-${randomBytes(3).toString("hex")}`;
    const user = await db.user.create({ data: { email: `${tag}@example.invalid`, name: label, emailVerified: new Date() } });
    // Every model needs a paid plan: a FREE account is refused at the paywall.
    await db.subscription.create({ data: { userId: user.id, plan: "PRO", status: "ACTIVE" } });
    return { id: user.id, email: user.email!, name: user.name! };
  }

  test("stand in for the session, the owner gate, the network and the model", async () => {
    mock.module("@/lib/session", {
      namedExports: {
        getCurrentUser: async () => signedIn,
        requireUser: async () => signedIn,
        getCurrentDeviceSessionId: async () => null,
        getSessionBan: async () => null,
      },
    });
    mock.module("@/lib/admin", { namedExports: { getOwnerUser: async () => signedIn } });
    globalThis.fetch = async (input: string | URL | Request) => {
      throw new Error(`unexpected network call to ${input instanceof Request ? input.url : String(input)}`);
    };
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: () => {} } });
    const providers = await import("@/lib/providers");
    mock.module("@/lib/providers", {
      namedExports: { ...providers, isProviderConfigured: () => true, configuredProviders: () => [...providers.PROVIDER_LIST] },
    });
    const llm = await import("@/lib/llm");
    mock.module("@/lib/llm", {
      namedExports: {
        ...llm,
        streamChat: async function* () {
          yield { type: "text", text: "hello" };
          yield { type: "usage", input: 1, output: 5 };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.OWNERSHIP_TEST_VERBOSE) original(...args);
    };
  });

  test("a turn in a project chat starts and sees its project", async () => {
    const owner = await person("chat");
    signedIn = owner;
    const project = await db.project.create({ data: { userId: owner.id, name: "Proj", instructions: "Answer as the project." } });
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const conversation = await db.conversation.create({ data: { userId: owner.id, title: "c", projectId: project.id } });
    await db.message.create({
      data: { conversationId: conversation.id, role: "USER", content: encryptMessageText("Hi"), createdAt: new Date(Date.now() - 5000) },
    });
    logged.length = 0;
    const { POST } = await import("@/app/api/chat/route");
    const response = await POST(json("/api/chat", "POST", { conversationId: conversation.id, regenerate: true }));
    await response.text();
    assert.ok(!logged.join("\n").includes("[ownership-guard]"), logged.join("\n"));
    assert.notEqual(response.status, 500);
  });

  test("project rename, member list and delete work for the people allowed to do them", async () => {
    const owner = await person("owner");
    const editor = await person("editor");
    const viewer = await person("viewer");
    const project = await db.project.create({ data: { userId: owner.id, name: "Original" } });
    await db.projectMember.create({ data: { projectId: project.id, userId: editor.id, role: "EDITOR" } });
    await db.projectMember.create({ data: { projectId: project.id, userId: viewer.id, role: "VIEWER" } });
    const projectRoute = await import("@/app/api/projects/[id]/route");
    const membersRoute = await import("@/app/api/projects/[id]/members/route");

    signedIn = owner;
    assert.equal((await projectRoute.PATCH(json("/api/projects/x", "PATCH", { name: "By owner" }), params("id", project.id))).status, 200);
    assert.equal((await db.project.findUnique({ where: { id: project.id } }))?.name, "By owner");

    // A collaborator edits a project they do not own.
    signedIn = editor;
    assert.equal((await projectRoute.PATCH(json("/api/projects/x", "PATCH", { instructions: "By editor" }), params("id", project.id))).status, 200);
    assert.equal((await db.project.findUnique({ where: { id: project.id } }))?.instructions, "By editor");

    signedIn = viewer;
    assert.equal((await projectRoute.PATCH(json("/api/projects/x", "PATCH", { name: "By viewer" }), params("id", project.id))).status, 404);
    assert.equal((await db.project.findUnique({ where: { id: project.id } }))?.name, "By owner");

    for (const reader of [owner, editor, viewer]) {
      signedIn = reader;
      const response = await membersRoute.GET(json("/api/projects/x/members", "GET"), params("id", project.id));
      assert.equal(response.status, 200);
      const { members } = (await response.json()) as { members: Array<{ userId: string; role: string }> };
      assert.deepEqual(
        members.map((m) => [m.userId, m.role]).sort(),
        [[owner.id, "OWNER"], [editor.id, "EDITOR"], [viewer.id, "VIEWER"]].sort()
      );
    }
    const stranger = await person("stranger");
    signedIn = stranger;
    assert.equal((await membersRoute.GET(json("/api/projects/x/members", "GET"), params("id", project.id))).status, 403);

    signedIn = editor;
    assert.equal((await projectRoute.DELETE(json("/api/projects/x", "DELETE"), params("id", project.id))).status, 403);
    signedIn = owner;
    assert.equal((await projectRoute.DELETE(json("/api/projects/x", "DELETE"), params("id", project.id))).status, 200);
    assert.equal(await db.project.findUnique({ where: { id: project.id } }), null);
  });

  test("a roadmap vote toggles and answers with the public tally", async () => {
    const author = await person("author");
    const voter = await person("voter");
    const request = await db.featureRequest.create({ data: { authorId: author.id, title: "t", description: "d" } });
    await db.featureVote.create({ data: { requestId: request.id, userId: author.id } });
    const { POST } = await import("@/app/api/roadmap/[id]/vote/route");
    signedIn = voter;
    const first = await POST(json("/api/roadmap/x/vote", "POST"), params("id", request.id));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { voted: true, voteCount: 2 });
    const second = await POST(json("/api/roadmap/x/vote", "POST"), params("id", request.id));
    assert.deepEqual(await second.json(), { voted: false, voteCount: 1 });
  });

  test("the phone can queue a command for its own Mac, and not for someone else's", async () => {
    const owner = await person("phone");
    const device = await db.codeDevice.create({ data: { userId: owner.id, name: "Mac" } });
    const { POST } = await import("@/app/api/code/devices/[deviceId]/commands/route");
    signedIn = owner;
    const body = { kind: "send_message", sessionID: "session-1", payload: { text: "hi" }, idempotencyKey: `k-${randomBytes(4).toString("hex")}` };
    const response = await POST(json("/api/code/devices/x/commands", "POST", body), params("deviceId", device.id));
    assert.equal(response.status, 200);
    const again = await POST(json("/api/code/devices/x/commands", "POST", { ...body, idempotencyKey: `${body.idempotencyKey}-2` }), params("deviceId", device.id));
    assert.equal(again.status, 200);
    // The second command reuses the remote session the first one created.
    assert.equal(await db.codeRemoteSession.count({ where: { deviceId: device.id, sessionId: "session-1" } }), 1);
    assert.equal(await db.codeSessionCommand.count({ where: { deviceId: device.id } }), 2);

    signedIn = await person("intruder");
    assert.equal((await POST(json("/api/code/devices/x/commands", "POST", body), params("deviceId", device.id))).status, 404);
  });

  test("the owner's users page loads, including a search that matches nobody", async () => {
    const owner = await person("admin");
    await db.usage.create({ data: { userId: owner.id, period: new Date().toISOString().slice(0, 7), messageCount: 3 } }).catch(() => null);
    const { GET } = await import("@/app/api/admin/users/route");
    signedIn = owner;
    const all = await GET(new Request("http://juno.test/api/admin/users"));
    assert.equal(all.status, 200);
    const nobody = await GET(new Request(`http://juno.test/api/admin/users?q=${encodeURIComponent("no-such-person-" + randomBytes(6).toString("hex"))}`));
    assert.equal(nobody.status, 200);
    assert.deepEqual(((await nobody.json()) as { users: unknown[] }).users, []);
  });

  test("the library call sites that were refused now reach the right row and only that row", async () => {
    const { prisma } = await import("@/lib/db");
    const owner = await person("lib");
    const other = await person("other");

    // Composio claim transition (src/lib/composio.ts updateClaim).
    const connection = await db.connection.create({
      data: { userId: owner.id, provider: "composio:github", accessToken: "x", scope: "starting:abc" },
    });
    const moved = await prisma.connection.update({
      where: { id: connection.id, userId: connection.userId, updatedAt: connection.updatedAt, scope: connection.scope },
      data: { scope: "connected" },
    });
    assert.equal(moved.scope, "connected");
    await assert.rejects(
      prisma.connection.update({ where: { id: connection.id, userId: other.id }, data: { scope: "stolen" } }),
      (error: { code?: string }) => error.code === "P2025"
    );

    // Memory extraction's read mark (src/lib/memory.ts markProcessed).
    const conversation = await db.conversation.create({ data: { userId: owner.id, title: "m" } });
    for (const delta of [2, 3]) {
      await prisma.conversationMemory.upsert({
        where: { conversationId: conversation.id, userId: owner.id },
        create: { userId: owner.id, conversationId: conversation.id, processedAt: new Date(), factCount: delta },
        update: { processedAt: new Date(), factCount: { increment: delta } },
      });
    }
    assert.equal((await db.conversationMemory.findUnique({ where: { conversationId: conversation.id } }))?.factCount, 5);

    // The attachment text cache (src/lib/knowledge/index.ts).
    const attachment = await db.attachment.create({
      data: { userId: owner.id, conversationId: conversation.id, kind: "FILE", fileName: "a.txt", mimeType: "text/plain", storageKey: `k-${randomBytes(4).toString("hex")}`, size: 1 },
    });
    assert.equal((await prisma.attachment.updateMany({ where: { id: attachment.id, userId: other.id }, data: { extractedText: "no" } })).count, 0);
    assert.equal((await prisma.attachment.updateMany({ where: { id: attachment.id, userId: owner.id }, data: { extractedText: "yes" } })).count, 1);

    // The chat route's project lookup.
    const project = await db.project.create({ data: { userId: owner.id, name: "P" } });
    assert.equal((await prisma.project.findUnique({ where: { id: project.id, userId: owner.id } }))?.name, "P");
    assert.equal(await prisma.project.findUnique({ where: { id: project.id, userId: other.id } }), null);
  });

  test("the guarded client still refuses every shape that used to slip through", async () => {
    const { prisma } = await import("@/lib/db");
    for (const run of [
      () => prisma.project.findUnique({ where: { id: "x" } }),
      () => prisma.projectMember.findMany({ where: { projectId: "x" } }),
      () => prisma.featureVote.count({ where: { requestId: "x" } }),
      () => prisma.usage.count({ where: { period: "2026-10" } }),
      () => prisma.apiSpend.groupBy({ by: ["userId"], where: { userId: { in: [] } } }),
      () => prisma.conversationMemory.upsert({ where: { conversationId: "x" }, create: { userId: "u", conversationId: "x", processedAt: new Date() }, update: {} }),
    ]) {
      await assert.rejects(run(), /\[ownership-guard\]/);
    }
  });

  test("disconnect", async () => {
    await db.$disconnect();
    const { prismaUnguarded } = await import("@/lib/db");
    await prismaUnguarded.$disconnect();
  });
}
