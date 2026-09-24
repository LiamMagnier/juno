import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

/*
 * DELETING A CHAT KEEPS WHAT JUNO MADE IN IT (Artifacts R1, 04-MERGE-PLAN §3.5).
 *
 * `Artifact` cascades on its conversation, so every conversation delete used
 * to take the chat's artifacts with it: versions, hand edits, public links,
 * and with "Delete all chats" the whole library. Now each of the three delete
 * paths (the sidebar's single delete, Settings' "Delete all", and the native
 * `conversation.delete` mutation) moves the artifacts into the account's
 * hidden anchor conversation first, through src/lib/artifact-home.ts.
 *
 * The first tests read the sources and always run: they fail a new
 * `conversation.delete`/`deleteMany` that skips the helper without saying why
 * it may (`// detach-safe:`), and a delete route that stops calling it.
 *
 * The database suite drives the real route handlers against Postgres, because
 * the rule lives in foreign keys and triggers as much as in the code: the
 * cascade that must find nothing left to take, the SetNull that clears
 * `messageId`, and the change-capture trigger that must never announce the
 * anchor. Only the session and the native bearer check are stand-ins. It is
 * skipped unless ARTIFACT_TEST_DATABASE_URL names a throwaway database, and
 * never falls back to DATABASE_URL. Run it with:
 *
 *   createdb juno_artifact_delete_test
 *   DATABASE_URL=postgresql:///juno_artifact_delete_test \
 *   DIRECT_URL=postgresql:///juno_artifact_delete_test npx prisma migrate deploy
 *   ARTIFACT_TEST_DATABASE_URL=postgresql:///juno_artifact_delete_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/conversation-delete-keeps-artifacts.test.ts
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Every .ts/.tsx file under src, as repo-relative paths, tests excluded. */
function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** A Prisma conversation delete, however it is spaced, or the raw SQL spelling of one. */
const CONVERSATION_DELETE = /\.\s*conversation\s*\.\s*(?:delete|deleteMany)\s*\(|DELETE\s+FROM\s+"Conversation"/g;

test("every conversation delete goes through artifact-home.ts or says why it cannot hold an artifact", () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const file of sourceFiles()) {
    if (file === "src/lib/artifact-home.ts") continue;
    const text = read(file);
    const lines = text.split("\n");
    for (const match of text.matchAll(CONVERSATION_DELETE)) {
      seen += 1;
      const line = text.slice(0, match.index).split("\n").length - 1;
      // The comment sits on the line of the call or within three lines above.
      const context = lines.slice(Math.max(0, line - 3), line + 1).join("\n");
      if (!/detach-safe:/.test(context)) offenders.push(`${file}:${line + 1}`);
    }
  }
  assert.ok(seen > 0, "the scan finds the sanctioned exceptions, so it is not vacuous");
  assert.deepEqual(
    offenders,
    [],
    "a conversation delete outside artifact-home.ts cascades its artifacts away: call " +
      "deleteConversationsKeepingArtifacts, or add `// detach-safe: <why this chat can never hold one>`",
  );
});

test("the helper deletes only what it resolved, never the anchor, and moves before it deletes", () => {
  const home = read("src/lib/artifact-home.ts");
  const body = home.slice(home.indexOf("export async function deleteConversationsKeepingArtifacts"));
  const resolve = body.indexOf("db.conversation.findMany({\n    where: visibleConversationWhere(");
  const move = body.indexOf('UPDATE "Artifact" a');
  const files = body.indexOf("detachReferencedFiles(");
  const remove = body.indexOf("db.conversation.deleteMany({\n    where: visibleConversationWhere(");
  assert.ok(resolve > 0 && move > resolve && files > move && remove > files, "resolve, move, keep files, then delete");
  assert.match(body, /AND \$\{visibleConversationSql\("c"\)\}/, "the move never rewrites the anchor's own rows");
  // The SQL spells the anchored identifier itself; it must agree with the helper.
  assert.match(body, /"identifier"\s+= a\."identifier" \|\| '~' \|\| a\."id"/);
  assert.match(home, /return `\$\{identifier\}~\$\{id\}`;/);
  // Neither `updatedAt` nor `deletedAt` is written by the move.
  const statement = body.slice(move, body.indexOf("RETURNING", move));
  assert.doesNotMatch(statement, /"updatedAt"|"deletedAt"/);
});

test("all three delete paths call the helper", () => {
  const single = read("src/app/api/conversations/[id]/route.ts");
  const singleDelete = single.slice(single.indexOf("export async function DELETE"));
  assert.match(singleDelete, /prisma\.\$transaction\(\s*\(tx\) => deleteConversationsKeepingArtifacts\(tx, user\.id, \[id\]\)/);
  assert.match(singleDelete, /keptArtifacts/);

  const bulk = read("src/app/api/conversations/route.ts");
  const bulkDelete = bulk.slice(bulk.indexOf("export async function DELETE"));
  assert.match(bulkDelete, /deleteAllConversationsKeepingArtifacts\(user\.id\)/);
  assert.doesNotMatch(bulkDelete, /conversation\.deleteMany/);

  const native = read("src/app/api/v1/mutations/route.ts");
  const nativeDelete = native.slice(native.indexOf('case "conversation.delete"'), native.indexOf('case "folder.create"'));
  assert.match(nativeDelete, /deleteConversationsKeepingArtifacts\(tx, accountId, \[op\.entityId\]\)/);
});

test("the conversation routes refuse the anchor through the visibility filter", () => {
  const single = read("src/app/api/conversations/[id]/route.ts");
  const patch = single.slice(single.indexOf("export async function PATCH"), single.indexOf("export async function DELETE"));
  const patchCalls = [...patch.matchAll(/prisma\.conversation\.(findFirst|updateMany|update)\(\{\s*where: ([^,]+)/g)];
  assert.equal(patchCalls.length, 3, "the lookup, the archive stamp and the update");
  for (const call of patchCalls) {
    assert.match(call[2], /^visibleConversationWhere\(/, `PATCH's ${call[1]} is limited to visible conversations`);
  }
  const native = read("src/app/api/v1/mutations/route.ts");
  const ops = native.slice(native.indexOf('case "conversation.rename"'), native.indexOf('case "conversation.delete"'));
  const calls = [...ops.matchAll(/tx\.conversation\.\w+\(\{ where: (\w+)/g)];
  assert.equal(calls.length, 5, "rename, update, archive's lookup and its two writes");
  for (const call of calls) assert.equal(call[1], "visibleConversationWhere");
});

const DB_URL = process.env.ARTIFACT_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!DB_URL || !canMockModules) {
  test(
    "conversation delete database suite is skipped without ARTIFACT_TEST_DATABASE_URL and module mocks",
    { skip: true },
    () => {},
  );
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  // Throwaway rows, throwaway key: nothing here should read a real keyring.
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "conversation-delete-test-secret";
  delete process.env.JUNO_LIFECYCLE_DETACH_ON_DELETE;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });
  // The bearer check is the one part of the native route that is not under
  // test; everything after it (the Serializable transaction, the revision
  // check, the receipt) is the real route.
  let nativeDevice: { id: string } | null = null;
  mock.module("@/lib/native-request", {
    namedExports: {
      requireNativeRequest: async () => ({ user: signedIn, deviceSession: nativeDevice }),
    },
  });

  // A tripwire for the ownership guard: outside development it only logs, and
  // a log line does not fail a test on its own.
  const guardComplaints: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    if (text.includes("[ownership-guard]")) guardComplaints.push(text);
    consoleError(...args);
  };

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const request = (method: string, body?: unknown) =>
    new Request("http://juno.test/api", {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer stand-in" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function signUp(label: string) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: {
        email: `conversation-delete-${label}-${suffix}@example.invalid`,
        name: "Conversation delete",
        emailVerified: new Date(),
      },
    });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  /**
   * A chat in a project holding what the old cascade destroyed: an artifact
   * with a generated v1 and a hand-edited v2, a public link to it, a public
   * link to the chat, a picture the artifact shows and a file it does not,
   * plus an artifact already in Recently deleted.
   */
  async function chatWithArtifact(userId: string, title = "Launch plan") {
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const project = await prisma.project.create({ data: { userId, name: "Bakery" } });
    const chat = await prisma.conversation.create({ data: { userId, title, projectId: project.id } });
    await prisma.message.create({
      data: { conversationId: chat.id, role: "USER", content: encryptMessageText("Draft a launch plan.") },
    });
    const answer = await prisma.message.create({
      data: { conversationId: chat.id, role: "ASSISTANT", content: encryptMessageText("Here it is.") },
    });

    const shown = await prisma.attachment.create({
      data: {
        userId,
        conversationId: chat.id,
        messageId: answer.id,
        kind: "IMAGE",
        fileName: "storefront.png",
        mimeType: "image/png",
        size: 10,
        storageKey: `uploads/${userId}/${randomUUID()}.png`,
      },
    });
    const unused = await prisma.attachment.create({
      data: {
        userId,
        conversationId: chat.id,
        kind: "IMAGE",
        fileName: "draft.png",
        mimeType: "image/png",
        size: 10,
        storageKey: `uploads/${userId}/${randomUUID()}.png`,
      },
    });

    const artifact = await prisma.artifact.create({
      data: {
        conversationId: chat.id,
        messageId: answer.id,
        identifier: "launch-plan",
        title: "Launch plan",
        type: "HTML",
        currentVersion: 2,
        versions: {
          create: [
            { version: 1, origin: "generated", content: "<h1>Plan</h1>" },
            { version: 2, origin: "edit", content: `<h1>Plan</h1><img src="/api/files/${shown.storageKey}">` },
          ],
        },
      },
    });
    const trashed = await prisma.artifact.create({
      data: {
        conversationId: chat.id,
        identifier: "old-draft",
        title: "Old draft",
        type: "MARKDOWN",
        deletedAt: new Date(),
        deletedReason: "user",
        versions: { create: [{ version: 1, origin: "generated", content: "# Old" }] },
      },
    });

    const artifactShare = await prisma.share.create({
      data: { token: randomBytes(24).toString("base64url"), userId, kind: "ARTIFACT", artifactId: artifact.id, title: "Launch plan" },
    });
    const chatShare = await prisma.share.create({
      data: { token: randomBytes(24).toString("base64url"), userId, kind: "CHAT", conversationId: chat.id, title },
    });
    return { project, chat, answer, shown, unused, artifact, trashed, artifactShare, chatShare };
  }

  type Fixture = Awaited<ReturnType<typeof chatWithArtifact>>;

  /** Everything the spec promises once the chat is gone. */
  async function assertKept(userId: string, fx: Fixture) {
    const { anchorConversationId } = await import("@/lib/conversation-visibility");
    const { anchoredIdentifier } = await import("@/lib/artifact-home");
    const anchor = anchorConversationId(userId);

    assert.equal(await prisma.conversation.findUnique({ where: { id: fx.chat.id } }), null, "the chat is gone");
    assert.equal(await prisma.message.count({ where: { conversationId: fx.chat.id } }), 0, "and its messages");

    const artifact = await prisma.artifact.findUnique({
      where: { id: fx.artifact.id },
      include: { versions: { orderBy: { version: "asc" } } },
    });
    assert.ok(artifact, "the artifact survives under its own id");
    assert.equal(artifact.conversationId, anchor, "in the account's anchor");
    assert.equal(artifact.identifier, anchoredIdentifier("launch-plan", fx.artifact.id));
    assert.equal(artifact.identifier, `launch-plan~${fx.artifact.id}`);
    assert.equal(artifact.projectId, fx.project.id, "still in its project");
    assert.equal(artifact.messageId, null, "let go of the deleted answer");
    assert.equal(artifact.deletedAt, null);
    assert.equal(artifact.updatedAt.getTime(), fx.artifact.updatedAt.getTime(), "the move does not reorder the library");
    assert.deepEqual(
      artifact.versions.map((v) => [v.version, v.origin]),
      [
        [1, "generated"],
        [2, "edit"],
      ],
      "both versions, the hand edit included",
    );

    const trashed = await prisma.artifact.findUnique({ where: { id: fx.trashed.id } });
    assert.equal(trashed?.conversationId, anchor, "a trashed artifact moves too");
    assert.ok(trashed?.deletedAt, "and stays in Recently deleted");

    const { getPublicShare, getSharedArtifactSnapshot } = await import("@/lib/share");
    const share = await getPublicShare(fx.artifactShare.token);
    assert.ok(share, "the artifact's public link still resolves");
    const snapshot = await getSharedArtifactSnapshot(share);
    assert.match(snapshot?.content ?? "", /<h1>Plan<\/h1>/);
    assert.equal(await prisma.share.findUnique({ where: { id: fx.chatShare.id } }), null, "the chat's link is gone");

    const shown = await prisma.attachment.findUnique({ where: { id: fx.shown.id } });
    assert.ok(shown, "the picture the artifact shows survives");
    assert.equal(shown.conversationId, null);
    assert.equal(shown.messageId, null);
    assert.equal(shown.deletedAt, null);
    assert.equal(await prisma.attachment.findUnique({ where: { id: fx.unused.id } }), null, "the unused file goes");

    assert.equal(
      await prisma.accountChange.count({ where: { entityId: anchor } }),
      0,
      "the anchor never reaches the change feed",
    );
    assert.equal(await prisma.entityRevision.count({ where: { entityId: anchor } }), 0, "and has no revision");
    assert.equal(
      await prisma.conversation.count({ where: { userId, kind: "anchor" } }),
      1,
      "one anchor for the account",
    );
  }

  /** GET, PATCH and DELETE on the anchor answer exactly like a missing id. */
  async function assertAnchorRefused(userId: string) {
    const { anchorConversationId } = await import("@/lib/conversation-visibility");
    const anchor = anchorConversationId(userId);
    const route = await import("@/app/api/conversations/[id]/route");
    const got = await route.GET(request("GET"), params(anchor));
    assert.equal(got.status, 404, "GET");
    const patched = await route.PATCH(request("PATCH", { title: "Mine now", pinned: true }), params(anchor));
    assert.equal(patched.status, 404, "PATCH");
    const deleted = await route.DELETE(request("DELETE"), params(anchor));
    assert.equal(deleted.status, 404, "DELETE");
    const row = await prisma.conversation.findUnique({ where: { id: anchor } });
    assert.ok(row, "the anchor is still there");
    assert.equal(row.title, "Your artifacts");
    assert.equal(row.pinned, false);
    assert.equal(row.projectId, null);
  }

  test("deleting one chat keeps its artifacts in the anchor", async () => {
    const user = await signUp("single");
    const fx = await chatWithArtifact(user.id);
    const other = await prisma.conversation.create({ data: { userId: user.id, title: "Unrelated" } });

    const route = await import("@/app/api/conversations/[id]/route");
    const res = await route.DELETE(request("DELETE"), params(fx.chat.id));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, keptArtifacts: 1 }, "the trashed artifact is not counted as kept");

    await assertKept(user.id, fx);
    assert.ok(await prisma.conversation.findUnique({ where: { id: other.id } }), "only that chat is deleted");
    await assertAnchorRefused(user.id);

    // A second chat whose artifact has the same identifier: both live side by
    // side in the anchor, because the suffix is the full id.
    const again = await chatWithArtifact(user.id, "Launch plan, again");
    const second = await route.DELETE(request("DELETE"), params(again.chat.id));
    assert.equal(second.status, 200);
    const anchored = await prisma.artifact.findMany({
      where: { conversation: { userId: user.id, kind: "anchor" }, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
      anchored.map((a) => a.identifier),
      [`launch-plan~${fx.artifact.id}`, `launch-plan~${again.artifact.id}`],
    );
  });

  test("another account's chat, or no chat, is a 404 and moves nothing", async () => {
    const owner = await signUp("owner");
    const fx = await chatWithArtifact(owner.id);
    await signUp("stranger");
    const route = await import("@/app/api/conversations/[id]/route");
    const res = await route.DELETE(request("DELETE"), params(fx.chat.id));
    assert.equal(res.status, 404);
    const artifact = await prisma.artifact.findUnique({ where: { id: fx.artifact.id } });
    assert.equal(artifact?.conversationId, fx.chat.id, "untouched");
    assert.equal(await prisma.conversation.count({ where: { id: { startsWith: "anchor_" }, userId: owner.id } }), 0);
  });

  test("delete all keeps every artifact, and a second delete all leaves the anchor alone", async () => {
    const user = await signUp("bulk");
    const fx = await chatWithArtifact(user.id);
    const code = await prisma.conversation.create({ data: { userId: user.id, title: "Refactor", kind: "code" } });
    const empty = await prisma.conversation.create({ data: { userId: user.id, title: "Hello" } });

    const kept = await import("@/app/api/conversations/kept-artifacts/route");
    const counted = await kept.GET(new Request("http://juno.test/api/conversations/kept-artifacts"));
    assert.deepEqual(await counted.json(), { count: 1, kept: true }, "the dialog quotes live artifacts only");

    const route = await import("@/app/api/conversations/route");
    const res = await route.DELETE();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, deleted: 3, keptArtifacts: 1 });
    assert.equal(await prisma.conversation.findUnique({ where: { id: code.id } }), null, "Code sessions go too");
    assert.equal(await prisma.conversation.findUnique({ where: { id: empty.id } }), null);
    await assertKept(user.id, fx);

    const again = await route.DELETE();
    assert.deepEqual(await again.json(), { ok: true, deleted: 0, keptArtifacts: 0 });
    const artifact = await prisma.artifact.findUnique({ where: { id: fx.artifact.id } });
    assert.equal(artifact?.identifier, `launch-plan~${fx.artifact.id}`, "not suffixed a second time");
    await assertKept(user.id, fx);
    await assertAnchorRefused(user.id);

    const afterwards = await kept.GET(new Request("http://juno.test/api/conversations/kept-artifacts"));
    assert.deepEqual(await afterwards.json(), { count: 0, kept: true }, "anchored artifacts are not counted again");
  });

  test("the native conversation.delete keeps them too, inside its own transaction", async () => {
    const user = await signUp("native");
    nativeDevice = await prisma.nativeDeviceSession.create({
      data: { userId: user.id, installationIdHash: randomUUID(), name: "Test Mac", platform: "macos", appVersion: "1.6.0" },
    });
    const fx = await chatWithArtifact(user.id);
    const revision = await prisma.entityRevision.findUnique({
      where: { accountId_entityType_entityId: { accountId: user.id, entityType: "conversation", entityId: fx.chat.id } },
    });
    assert.ok(revision, "the chat has a revision to delete at");

    const route = await import("@/app/api/v1/mutations/route");
    const res = await route.POST(
      request("POST", {
        clientMutationId: randomUUID(),
        baseRevision: revision.revision,
        operation: { type: "conversation.delete", entityId: fx.chat.id },
      }),
    );
    const body = (await res.json()) as { entity?: { id: string; deleted: boolean } };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.entity?.id, fx.chat.id);
    assert.equal(body.entity?.deleted, true, "the response shape installed builds decode is unchanged");
    await assertKept(user.id, fx);

    // The anchor has no revision, so base 0 passes the revision check; the
    // visibility filter is what refuses it, as not_found.
    const { anchorConversationId } = await import("@/lib/conversation-visibility");
    const anchor = anchorConversationId(user.id);
    for (const operation of [
      { type: "conversation.rename", entityId: anchor, title: "Mine now" },
      { type: "conversation.update", entityId: anchor, patch: { pinned: true } },
      { type: "conversation.archive", entityId: anchor, archived: true },
      { type: "conversation.delete", entityId: anchor },
    ]) {
      const refused = await route.POST(request("POST", { clientMutationId: randomUUID(), baseRevision: 0, operation }));
      assert.equal(refused.status, 404, operation.type);
    }
    const row = await prisma.conversation.findUnique({ where: { id: anchor } });
    assert.ok(row);
    assert.equal(row.title, "Your artifacts");
    assert.equal(row.archivedAt, null);
    assert.equal(await prisma.artifact.count({ where: { conversationId: anchor } }), 2, "nothing cascaded");
  });

  test("ensureArtifactHome twice leaves one anchor", async () => {
    const user = await signUp("ensure");
    const { ensureArtifactHome } = await import("@/lib/artifact-home");
    const { prisma: guarded } = await import("@/lib/prisma");
    const first = await guarded.$transaction((tx) => ensureArtifactHome(tx, user.id));
    const second = await guarded.$transaction((tx) => ensureArtifactHome(tx, user.id));
    assert.equal(first, `anchor_${user.id}`);
    assert.equal(second, first);
    assert.equal(await prisma.conversation.count({ where: { userId: user.id } }), 1);
    const row = await prisma.conversation.findUniqueOrThrow({ where: { id: first } });
    assert.deepEqual(
      [row.kind, row.title, row.titleSource, row.projectId, row.folderId, row.pinned, row.archivedAt],
      ["anchor", "Your artifacts", "system", null, null, false, null],
    );
    assert.equal(await prisma.entityRevision.count({ where: { entityId: first } }), 0);
  });

  test("with the detach flag off, a delete cascades as it did before R1", async () => {
    const user = await signUp("flag-off");
    const fx = await chatWithArtifact(user.id);
    process.env.JUNO_LIFECYCLE_DETACH_ON_DELETE = "0";
    try {
      const kept = await import("@/app/api/conversations/kept-artifacts/route");
      const counted = await kept.GET(
        new Request(`http://juno.test/api/conversations/kept-artifacts?id=${encodeURIComponent(fx.chat.id)}`),
      );
      assert.deepEqual(await counted.json(), { count: 1, kept: false }, "the dialog promises nothing");

      const route = await import("@/app/api/conversations/[id]/route");
      const res = await route.DELETE(request("DELETE"), params(fx.chat.id));
      assert.deepEqual(await res.json(), { ok: true, keptArtifacts: 0 });
    } finally {
      delete process.env.JUNO_LIFECYCLE_DETACH_ON_DELETE;
    }
    assert.equal(await prisma.artifact.findUnique({ where: { id: fx.artifact.id } }), null);
    assert.equal(await prisma.conversation.count({ where: { userId: user.id, kind: "anchor" } }), 0, "no anchor made");
  });

  test("nothing reached the database unscoped", () => {
    assert.deepEqual(guardComplaints, []);
  });

  test("clean up the throwaway accounts", async () => {
    console.error = consoleError;
    await prisma.user.deleteMany({ where: { email: { startsWith: "conversation-delete-" } } });
    await prisma.$disconnect();
    const { prisma: guarded } = await import("@/lib/prisma");
    await guarded.$disconnect();
  });
}
