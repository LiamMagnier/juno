import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * BRANCHES, THROUGH THE REAL ROUTES AGAINST POSTGRES (G03, G50).
 *
 * Editing a question used to delete every later message; it is a branch now.
 * What runs for real: PATCH /api/messages/[id] (edit), POST
 * /api/messages/[id]/branch (the pager), GET /api/conversations/[id] (whole
 * and paged) and its /messages pager, POST /api/conversations/[id]/fork,
 * GET /api/account/export, the shared-chat snapshot, the search and recall
 * statements, native sync hydration, the legacy-version adoption, message
 * encryption and the serializers. Stand-in: the signed-in session.
 *
 * Covers: nothing is deleted by an edit; the old wording keeps its answers,
 * files and artifacts; every reader sees the shown branch only (paging, the
 * whole-thread contract the apps read, search, recall, sync, export unless it
 * opts in, a shared link pinned to what it showed); switching restores a
 * branch whole; a fork copies one line of the thread; older MessageVersion
 * rows join the pager; owner scoping; a hidden message cannot be edited.
 *
 * Skipped unless HISTORY_TEST_DATABASE_URL names a throwaway, migrated database:
 *   HISTORY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_branches_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/chat-branches.integration.test.ts
 */

const DB_URL = process.env.HISTORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("branches suite is skipped without HISTORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "branches-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn } });

  type Wire = {
    id: string;
    role: string;
    content: string;
    attachments: Array<{ fileName: string }>;
    branch?: { index: number; siblingIds: string[] };
    versions?: unknown[];
  };
  const tag = randomUUID().slice(0, 8);
  let alice: { id: string; email: string; name: string };
  let mallory: { id: string; email: string; name: string };
  let conversationId = "";
  const ids: Record<string, string> = {};
  let edited = "";

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function thread(query = "") {
    const route = await import("@/app/api/conversations/[id]/route");
    const res = await route.GET(new Request(`http://juno.test/api/conversations/${conversationId}${query}`), params(conversationId));
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as { messages: Wire[] }) : null };
  }
  async function edit(messageId: string, content: string) {
    const route = await import("@/app/api/messages/[id]/route");
    const res = await route.PATCH(new Request(`http://juno.test/api/messages/${messageId}`, { ...json({ content }), method: "PATCH" }), params(messageId));
    return { status: res.status, body: (await res.json()) as { message?: Wire; replacedId?: string; error?: string } };
  }
  async function select(messageId: string) {
    const route = await import("@/app/api/messages/[id]/branch/route");
    const res = await route.POST(new Request(`http://juno.test/api/messages/${messageId}/branch`, { method: "POST" }), params(messageId));
    return { status: res.status, body: (await res.json()) as { replacedId?: string; messages?: Wire[] | null; changed?: boolean; error?: string } };
  }
  const shownIds = async () => (await thread()).body!.messages.map((m) => m.id);
  const name = (id: string) => Object.entries(ids).find(([, value]) => value === id)?.[0] ?? (id === edited ? "u2'" : id);

  test("seed a linear conversation with a file, an artifact, a share made before branches, and a second account", async () => {
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const make = (who: string) => prisma.user.create({ data: { email: `${who}-${tag}@branches.test`, name: who } });
    const a = await make("alice");
    const m = await make("mallory");
    alice = { id: a.id, email: a.email!, name: "alice" };
    mallory = { id: m.id, email: m.email!, name: "mallory" };
    const conversation = await prisma.conversation.create({ data: { userId: a.id, title: "Trip" } });
    conversationId = conversation.id;
    const start = Date.UTC(2026, 8, 1);
    for (const [i, key] of ["u1", "a1", "u2", "a2", "u3", "a3"].entries()) {
      const row = await prisma.message.create({
        data: {
          conversationId,
          role: key.startsWith("u") ? "USER" : "ASSISTANT",
          content: encryptMessageText(`${key} says something about Lisbon`),
          createdAt: new Date(start + i * 60_000),
        },
      });
      ids[key] = row.id;
    }
    await prisma.attachment.create({
      data: { userId: a.id, conversationId, messageId: ids.u2, kind: "FILE", fileName: "itinerary.pdf", mimeType: "application/pdf", size: 10, storageKey: `k/${tag}`, extractedText: "day one" },
    });
    await prisma.artifact.create({ data: { userId: a.id, conversationId, messageId: ids.a3, identifier: `plan-${tag}`, type: "MARKDOWN", title: "Plan" } });
    // A link shared before branches existed: no pinned leaf.
    await prisma.share.create({ data: { token: `tok-${tag}`, userId: a.id, kind: "CHAT", conversationId, title: "Trip", snapshotAt: new Date(start + 10 * 60_000) } });
    // An answer regenerated in place before branches: its older text is a MessageVersion.
    await prisma.messageVersion.create({ data: { messageId: ids.a2, content: encryptMessageText("an older a2"), model: "anthropic:old" } });
    signedIn = alice;
    assert.deepEqual(await shownIds(), Object.values(ids));
  });

  test("editing a question is a new branch: nothing is deleted and the old wording keeps its answers and files", async () => {
    signedIn = alice;
    const { status, body } = await edit(ids.u2, "u2 asks about Porto instead");
    assert.equal(status, 200, body.error);
    assert.equal(body.replacedId, ids.u2);
    edited = body.message!.id;
    assert.notEqual(edited, ids.u2, "a new row, never the old one rewritten");
    assert.equal(body.message!.content, "u2 asks about Porto instead");
    assert.deepEqual(body.message!.branch, { index: 1, siblingIds: [ids.u2, edited] });
    assert.deepEqual(body.message!.attachments.map((a) => a.fileName), ["itinerary.pdf"], "the question keeps its file");

    assert.equal(await prisma.message.count({ where: { conversationId } }), 7, "nothing deleted");
    const old = await prisma.message.findMany({ where: { id: { in: [ids.u2, ids.a2, ids.u3, ids.a3] } }, select: { onActivePath: true } });
    assert.ok(old.every((row) => !row.onActivePath), "the old continuation is hidden, not gone");
    assert.equal(await prisma.attachment.count({ where: { messageId: ids.u2, deletedAt: null } }), 1, "the old wording keeps its own file");
    const copy = await prisma.attachment.findFirst({ where: { messageId: edited } });
    assert.equal(copy?.origin, "branch_copy");
    assert.equal(copy?.storageKey, `k/${tag}`, "the same stored object, no byte copy");
    const artifact = await prisma.artifact.findFirst({ where: { conversationId } });
    assert.equal(artifact?.messageId, ids.a3, "the artifact stays with the answer that made it");

    assert.deepEqual((await shownIds()).map(name), ["u1", "a1", "u2'"]);
  });

  test("every reader sees the shown branch: paging, search, recall, sync, and a pinned shared link", async () => {
    signedIn = alice;
    const paged = await thread("?limit=10");
    assert.deepEqual(paged.body!.messages.map((m) => name(m.id)), ["u1", "a1", "u2'"]);
    const history = await import("@/app/api/conversations/[id]/messages/route");
    const all = await history.GET(new Request(`http://juno.test/api/conversations/${conversationId}/messages?all=1`), params(conversationId));
    assert.deepEqual(((await all.json()) as { messages: Wire[] }).messages.map((m) => name(m.id)), ["u1", "a1", "u2'"]);
    // A deep link to a hidden message opens the newest page, as a deleted one would.
    const { getConversationThreadPage } = await import("@/lib/queries");
    const focused = (await getConversationThreadPage(alice.id, conversationId, { focusMessageId: ids.a3 }))!;
    assert.equal(focused.messages.some((m) => m.id === ids.a3), false);

    const { messageScanSql, recallBodiesSql } = await import("@/lib/search/sql");
    const scanned = await prisma.$queryRaw<Array<{ id: string }>>(messageScanSql({ userId: alice.id, conversationIds: [conversationId], since: null, limit: 50 }));
    assert.deepEqual(new Set(scanned.map((row) => name(row.id))), new Set(["u1", "a1", "u2'"]));
    const bodies = await prisma.$queryRaw<Array<{ id: string }>>(recallBodiesSql({ userId: alice.id, messageIds: [ids.a3, ids.a1] }));
    assert.deepEqual(bodies.map((row) => name(row.id)), ["a1"]);

    const { loadEntities } = await import("@/lib/sync-entities");
    const envelopes = await loadEntities(alice.id, "message", [ids.a3, ids.a1]);
    const hidden = envelopes.find((e) => e.id === ids.a3);
    const live = envelopes.find((e) => e.id === ids.a1);
    assert.ok(hidden && hidden.data === null && hidden.deletedAt, "a hidden message syncs as a tombstone");
    assert.ok(live?.data, "a shown one syncs live");

    const share = await prisma.share.findFirst({ where: { token: `tok-${tag}` } });
    assert.equal(share?.leafMessageId, ids.a3, "the edit pinned the old link to the leaf it showed");
    const { getSharedChatSnapshot } = await import("@/lib/share");
    const snapshot = await getSharedChatSnapshot(share!);
    assert.equal(snapshot?.messages.length, 6, "the public page still shows the thread as shared");
    assert.ok(snapshot!.messages.every((m) => !m.content.includes("Porto")));
  });

  test("the pager switches whole branches and back", async () => {
    signedIn = alice;
    const back = await select(ids.u2);
    assert.equal(back.status, 200, back.body.error);
    assert.equal(back.body.replacedId, edited);
    assert.deepEqual(back.body.messages!.map((m) => name(m.id)), ["u2", "a2", "u3", "a3"]);
    assert.deepEqual(back.body.messages![0].branch, { index: 0, siblingIds: [ids.u2, edited] });
    assert.deepEqual((await shownIds()).map(name), ["u1", "a1", "u2", "a2", "u3", "a3"]);
    // The legacy version pager still reads on a message that has never branched.
    const a2 = (await thread()).body!.messages.find((m) => m.id === ids.a2)!;
    assert.equal(a2.versions?.length, 1);
    assert.equal(a2.branch, undefined);

    const again = await select(ids.u2);
    assert.equal(again.body.changed, false, "selecting the shown one changes nothing");
    const forward = await select(edited);
    assert.deepEqual(forward.body.messages!.map((m) => name(m.id)), ["u2'"]);
    assert.deepEqual((await shownIds()).map(name), ["u1", "a1", "u2'"]);
    await select(ids.u2);
  });

  test("a regenerate on an answer with older versions brings them into one pager", async () => {
    signedIn = alice;
    const { encryptMessageText, decryptMessageText } = await import("@/lib/message-crypto");
    const { forkMessage } = await import("@/lib/chat/branches");
    // The app's client, as the regenerate writer uses it (persist.ts).
    const { prisma: app } = await import("@/lib/prisma");
    const created = await app.$transaction((tx) =>
      forkMessage(tx, { userId: alice.id, conversationId, targetId: ids.a2 }, (fields) =>
        tx.message.create({ data: { conversationId, role: "ASSISTANT", content: encryptMessageText("a newer a2"), ...fields } })
      )
    );
    assert.ok("created" in created);
    assert.equal(await prisma.messageVersion.count({ where: { messageId: ids.a2 } }), 0, "moved, not copied");
    const group = await prisma.message.findMany({ where: { branchGroupId: ids.a2 }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    assert.deepEqual(group.map((row) => decryptMessageText(row.content)), ["an older a2", "a2 says something about Lisbon", "a newer a2"]);
    assert.equal(group[0].model, "anthropic:old");
    const shown = (await thread()).body!.messages;
    assert.deepEqual(shown.map((m) => m.content), ["u1 says something about Lisbon", "a1 says something about Lisbon", "u2 says something about Lisbon", "a newer a2"]);
    assert.deepEqual(shown.at(-1)!.branch?.index, 2);
    // The apps page through `versions` and do not read `branch` yet: the
    // alternatives before this one stand in, and /versions reads them back.
    assert.deepEqual(
      (shown.at(-1)!.versions as Array<{ id: string }>).map((v) => v.id),
      shown.at(-1)!.branch!.siblingIds.slice(0, 2)
    );
    const versionsRoute = await import("@/app/api/messages/[id]/versions/route");
    const listed = (await (await versionsRoute.GET(new Request(`http://juno.test/api/messages/${shown.at(-1)!.id}/versions`), params(shown.at(-1)!.id))).json()) as {
      versions: Array<{ id: string; content: string; model: string | null }>;
    };
    assert.deepEqual(listed.versions.map((v) => v.content), ["an older a2", "a2 says something about Lisbon"]);
    assert.equal(listed.versions[0].model, "anthropic:old");
    signedIn = mallory;
    assert.equal((await versionsRoute.GET(new Request("http://juno.test/x"), params(shown.at(-1)!.id))).status, 404, "another account reads no versions");
    signedIn = alice;
    // Back to the original answer: its continuation comes back with it.
    await select(ids.a2);
    assert.deepEqual((await shownIds()).map(name), ["u1", "a1", "u2", "a2", "u3", "a3"]);
  });

  test("a new chat branched from a hidden message copies that line only", async () => {
    signedIn = alice;
    await select(edited);
    const route = await import("@/app/api/conversations/[id]/fork/route");
    const res = await route.POST(new Request(`http://juno.test/api/conversations/${conversationId}/fork`, json({ atMessageId: ids.a2 })), params(conversationId));
    assert.equal(res.status, 200);
    const { conversation } = (await res.json()) as { conversation: { id: string } };
    const { decryptMessageText } = await import("@/lib/message-crypto");
    const copied = await prisma.message.findMany({ where: { conversationId: conversation.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    assert.deepEqual(copied.map((row) => decryptMessageText(row.content)?.split(" ")[0]), ["u1", "a1", "u2", "a2"]);
    assert.ok(copied.every((row) => row.onActivePath && !row.branchGroupId), "a fresh, linear chat");
    await prisma.conversation.delete({ where: { id: conversation.id } });
  });

  test("an export carries every branch with its place in the tree; the CSV and ?branches=shown read the shown one", async () => {
    signedIn = alice;
    const route = await import("@/app/api/account/export/route");
    // The JSON is the whole account: the earlier wordings and answers an edit
    // or regenerate kept are the person's data as much as the shown thread.
    const everything = (await (await route.GET(new Request("http://juno.test/api/account/export"))).json()) as {
      conversations: Array<{ id: string; messages: Array<{ id: string; onActivePath: boolean; branchGroupId: string | null }> }>;
      messageBranches: string;
    };
    const tree = everything.conversations.find((c) => c.id === conversationId)!;
    assert.equal(everything.messageBranches, "all");
    assert.equal(tree.messages.length, await prisma.message.count({ where: { conversationId } }));
    assert.equal(tree.messages.filter((m) => m.onActivePath).length, 3);
    const shown = (await (await route.GET(new Request("http://juno.test/api/account/export?branches=shown"))).json()) as {
      conversations: Array<{ id: string; messages: Array<{ id: string; parentId?: string }> }>;
      messageBranches: string;
    };
    const mine = shown.conversations.find((c) => c.id === conversationId)!;
    assert.equal(shown.messageBranches, "shown");
    assert.deepEqual(mine.messages.map((m) => name(m.id)), ["u1", "a1", "u2'"]);
    assert.equal(mine.messages[0].parentId, undefined, "a shown-only export carries no tree");
    // The spreadsheet reads as the chat does.
    const csv = await (await route.GET(new Request("http://juno.test/api/account/export?format=csv"))).text();
    assert.equal(csv.split(/\r?\n/)[0], "conversation,role,model,content,createdAt");
    assert.equal(csv.includes("a2 says something"), false, "a hidden answer is not in the CSV");
  });

  test("an export of every branch imports as the same tree: one branch shown, the others a pager step away", async () => {
    signedIn = alice;
    const exporter = await import("@/app/api/account/export/route");
    // The JSON export as Settings offers it (the ZIP adds the stored files,
    // which this test does not write to disk): every branch, re-uploaded as
    // the import reads it.
    const payload = (await (await exporter.GET(new Request("http://juno.test/api/account/export"))).json()) as {
      attachments?: { items?: unknown[] };
    };
    // Files travel in the ZIP restore; this metadata-only file carries the tree.
    if (payload.attachments?.items) payload.attachments.items = [];
    const made = await prisma.user.create({ data: { email: `importer-${tag}@branches.test`, name: "importer" } });
    const importer = { id: made.id, email: made.email!, name: "importer" };
    signedIn = importer;
    try {
      const importRoute = await import("@/app/api/import/route");
      const form = new FormData();
      form.set("file", new File([JSON.stringify(payload)], "export.json", { type: "application/json" }));
      const res = await importRoute.POST(new Request("http://juno.test/api/import", { method: "POST", body: form }));
      assert.equal(res.status, 200, await res.clone().text());
      const copy = await prisma.conversation.findFirstOrThrow({ where: { userId: importer.id } });
      assert.equal(await prisma.message.count({ where: { conversationId: copy.id } }), await prisma.message.count({ where: { conversationId } }), "every branch came across");

      const route = await import("@/app/api/conversations/[id]/route");
      const read = async () =>
        ((await (await route.GET(new Request(`http://juno.test/api/conversations/${copy.id}`), params(copy.id))).json()) as { messages: Wire[] }).messages;
      const shown = await read();
      assert.deepEqual(shown.map((m) => m.content), ["u1 says something about Lisbon", "a1 says something about Lisbon", "u2 asks about Porto instead"]);
      const question = shown.at(-1)!;
      assert.equal(question.branch?.index, 1);
      assert.equal(question.branch?.siblingIds.length, 2);

      // Back to the old wording: its continuation returns with the answer that
      // was chosen in it (the original a2, not the newest of its three).
      const back = await select(question.branch!.siblingIds[0]);
      assert.equal(back.status, 200, back.body.error);
      assert.deepEqual((await read()).map((m) => m.content.split(" ")[0]), ["u1", "a1", "u2", "a2", "u3", "a3"]);
      const answer = (await read())[3];
      assert.equal(answer.content, "a2 says something about Lisbon");
      assert.deepEqual(answer.branch?.index, 1, "between the older version and the newer regenerate");
    } finally {
      await prisma.conversation.deleteMany({ where: { userId: importer.id } });
      await prisma.user.delete({ where: { id: importer.id } }).catch(() => {});
    }
  });

  test("another account can neither edit nor switch, and a hidden question cannot be edited", async () => {
    signedIn = mallory;
    assert.equal((await edit(ids.u1, "mine now")).status, 404);
    assert.equal((await select(ids.u2)).status, 404);
    signedIn = alice;
    const hidden = await edit(ids.u3, "edit a question nobody can see");
    assert.equal(hidden.status, 409);
    assert.equal((await edit(ids.a1, "rewrite the answer")).status, 400, "only questions are edited");
    signedIn = null;
    assert.equal((await select(ids.u2)).status, 401);
  });

  test("a reply lands with its question: its parent at the leaf, hidden with a hidden question, never a second shown child", async () => {
    const { replyPlacement, pathIdsTo } = await import("@/lib/chat/branches");
    // The app's client, as the reply writer uses it (persist.ts).
    const { prisma: app } = await import("@/lib/prisma");
    const convo = await prisma.conversation.create({ data: { userId: alice.id, title: "Placement" } });
    const start = Date.UTC(2026, 8, 2);
    const write = async (role: "USER" | "ASSISTANT", i: number, placement: { parentId?: string; onActivePath?: boolean } = {}) =>
      (await prisma.message.create({ data: { conversationId: convo.id, role, content: "x", createdAt: new Date(start + i * 1000), ...placement } })).id;
    const place = (answers: string | null) => app.$transaction((tx) => replyPlacement(tx, convo.id, answers));

    const q1 = await write("USER", 0);
    assert.deepEqual(await place(q1), { parentId: q1 }, "the question is the shown leaf: it is the reply's parent");
    // Another device appended a question while the reply to q1 was written.
    const q2 = await write("USER", 1);
    const late = await place(q1);
    assert.deepEqual(late, {}, "the reply follows the shown leaf rather than giving q1 two shown children");
    const reply = await write("ASSISTANT", 2, late);
    assert.deepEqual(await pathIdsTo(app, convo.id, reply), [q1, q2, reply], "the shown path stays one line");
    // A question switched away from: its reply stays with it, hidden.
    await prisma.message.update({ where: { id: q2 }, data: { onActivePath: false, parentId: q1 } });
    assert.deepEqual(await place(q2), { parentId: q2, onActivePath: false });
    assert.deepEqual(await place(null), {});
    assert.deepEqual(await place("not-a-message"), {});
    await prisma.conversation.delete({ where: { id: convo.id } });
  });

  test("clean up", async () => {
    await prisma.share.deleteMany({ where: { userId: alice.id } });
    await prisma.attachment.deleteMany({ where: { userId: alice.id } });
    await prisma.conversation.deleteMany({ where: { userId: { in: [alice.id, mallory.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [alice.id, mallory.id] } } });
    await prisma.$disconnect();
  });
}
