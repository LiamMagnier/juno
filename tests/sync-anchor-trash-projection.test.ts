import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

/*
 * WHAT NATIVE SYNC SEES OF THE ANCHOR AND OF RECENTLY DELETED (Artifacts R1).
 *
 * Neither needs a wire change, and installed builds must keep working as they
 * are (spec §6). So both are projections of state the contract already has:
 *
 *   - The account's anchor conversation is never announced (its change
 *     trigger skips kind 'anchor') and never loaded, so it has no revision
 *     and hydration omits it like an id that never existed. No build ever
 *     learns it is there.
 *   - A trashed artifact hydrates as a tombstone. Trashing is an UPDATE, so
 *     its revision moves and devices ask again; the loader leaves the row out
 *     and buildEntityEnvelopes reports "revision, no row" as deleted. Restore
 *     is another UPDATE and the row comes back live. Its versions are never
 *     projected away, because nothing re-announces them on restore.
 *
 * The first test reads the source and always runs. The database suite is
 * skipped unless ARTIFACT_TEST_DATABASE_URL names a throwaway database (it
 * never falls back to DATABASE_URL). Run it with:
 *
 *   ARTIFACT_TEST_DATABASE_URL=postgresql:///juno_artifact_sync_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/sync-anchor-trash-projection.test.ts
 *
 * after `prisma migrate deploy` against that database, as for
 * tests/artifact-lifecycle.test.ts.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the loaders project the anchor and the trash, and leave versions alone", () => {
  const source = read("src/lib/sync-entities.ts");
  const loader = (name: string) => {
    const start = source.indexOf(`  ${name}: async (accountId, ids) => {`);
    assert.ok(start > 0, `the ${name} loader is where this test expects it`);
    return source.slice(start, source.indexOf("\n  },\n", start));
  };
  assert.match(loader("conversation"), /where: visibleConversationWhere\(\{ id: \{ in: ids \}, userId: accountId \}\)/);
  assert.match(loader("artifact"), /deletedAt: null/);
  assert.doesNotMatch(loader("artifact_version"), /deletedAt/, "versions stay live while their artifact is trashed");
  const index = source.slice(source.indexOf("export async function listEntityIndex"));
  assert.match(index, /NOT: \{ entityType: "conversation", entityId: anchorConversationId\(accountId\) \}/);
});

const DB_URL = process.env.ARTIFACT_TEST_DATABASE_URL;

if (!DB_URL) {
  test("sync projection database suite is skipped without ARTIFACT_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  delete process.env.JUNO_LIFECYCLE_DETACH_ON_DELETE;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  async function revisionOf(accountId: string, entityType: string, entityId: string) {
    const row = await prisma.entityRevision.findUnique({
      where: { accountId_entityType_entityId: { accountId, entityType, entityId } },
    });
    assert.ok(row, `${entityType} ${entityId} has a revision`);
    return row;
  }

  /** An account whose one chat made an artifact, then was deleted: the artifact now sits in the anchor. */
  async function anchoredArtifact() {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `sync-anchor-trash-${suffix}@example.invalid`, name: "Sync projection", emailVerified: new Date() },
    });
    const chat = await prisma.conversation.create({ data: { userId: user.id, title: "Launch plan" } });
    const artifact = await prisma.artifact.create({
      data: {
        conversationId: chat.id,
        identifier: "launch-plan",
        title: "Launch plan",
        type: "MARKDOWN",
        currentVersion: 2,
        versions: {
          create: [
            { version: 1, origin: "generated", content: "# Plan" },
            { version: 2, origin: "edit", content: "# Plan, edited" },
          ],
        },
      },
      include: { versions: { orderBy: { version: "asc" } } },
    });

    const { deleteConversationsKeepingArtifacts } = await import("@/lib/artifact-home");
    const { prisma: guarded } = await import("@/lib/prisma");
    const result = await guarded.$transaction((tx) => deleteConversationsKeepingArtifacts(tx, user.id, [chat.id]));
    assert.deepEqual(result, { deleted: 1, keptArtifacts: 1 });
    return { user, chat, artifact, anchor: `anchor_${user.id}` };
  }

  test("the anchor is never hydrated and never listed", async () => {
    const { user, chat, artifact, anchor } = await anchoredArtifact();
    const { loadEntities, listEntityIndex } = await import("@/lib/sync-entities");

    assert.ok(await prisma.conversation.findUnique({ where: { id: anchor } }), "the anchor exists");
    assert.deepEqual(await loadEntities(user.id, "conversation", [anchor]), [], "omitted, not even a tombstone");

    // The deleted chat itself is a tombstone, as any deleted chat is.
    const [gone] = await loadEntities(user.id, "conversation", [chat.id]);
    assert.equal(gone?.data, null);
    assert.ok(gone?.deletedAt);

    // The artifact is live, and points at the anchor.
    const [live] = await loadEntities(user.id, "artifact", [artifact.id]);
    assert.equal(live?.deletedAt, null);
    assert.equal(live?.data?.conversationId, anchor);

    const { items, hasMore } = await listEntityIndex(user.id, null, 500);
    assert.equal(hasMore, false);
    assert.ok(!items.some((item) => item.id === anchor), "the inventory never offers the anchor");
    assert.ok(items.some((item) => item.type === "artifact" && item.id === artifact.id), "the artifact is offered");
    assert.equal(await prisma.accountChange.count({ where: { accountId: user.id, entityId: anchor } }), 0);
  });

  test("a trashed artifact hydrates as a tombstone at its current revision, and restore brings it back", async () => {
    const { user, artifact } = await anchoredArtifact();
    const { loadEntities } = await import("@/lib/sync-entities");
    const versionIds = artifact.versions.map((v) => v.id);
    const before = await revisionOf(user.id, "artifact", artifact.id);

    // What DELETE /api/artifacts/[id] writes with the trash on (S3); done
    // directly here so this suite tests the projection and nothing else.
    await prisma.artifact.update({
      where: { id: artifact.id },
      data: { deletedAt: new Date(), deletedReason: "user" },
    });
    const trashedRevision = await revisionOf(user.id, "artifact", artifact.id);
    assert.ok(trashedRevision.revision > before.revision, "the trash is announced as a change");
    assert.equal(trashedRevision.deletedAt, null, "the revision itself is not a deletion");

    const [trashed] = await loadEntities(user.id, "artifact", [artifact.id]);
    assert.equal(trashed?.revision, trashedRevision.revision, "at the current revision");
    assert.equal(trashed?.data, null, "a tombstone");
    assert.ok(trashed?.deletedAt, "with a deletion time, never data and deletedAt both null");

    const versions = await loadEntities(user.id, "artifact_version", versionIds);
    assert.deepEqual(
      versions.map((v) => [v.id, v.deletedAt, v.data?.content]),
      [
        [versionIds[0], null, "# Plan"],
        [versionIds[1], null, "# Plan, edited"],
      ],
      "its versions stay live",
    );

    await prisma.artifact.update({ where: { id: artifact.id }, data: { deletedAt: null, deletedReason: null } });
    const restoredRevision = await revisionOf(user.id, "artifact", artifact.id);
    assert.ok(restoredRevision.revision > trashedRevision.revision, "the restore is announced too");
    const [restored] = await loadEntities(user.id, "artifact", [artifact.id]);
    assert.equal(restored?.revision, restoredRevision.revision);
    assert.equal(restored?.deletedAt, null);
    assert.equal(restored?.data?.currentVersion, 2, "live again, and its versions never left");
  });

  test("clean up the throwaway accounts", async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: "sync-anchor-trash-" } } });
    await prisma.$disconnect();
    const { prisma: guarded } = await import("@/lib/prisma");
    await guarded.$disconnect();
  });
}
