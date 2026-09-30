import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient, type Share } from "@prisma/client";

/*
 * A public page never shows an edit its owner did not publish (audit
 * docs/rework/audit/artifacts.md, B1).
 *
 * The security hotfix closed B1 on the old design store, which folded a quick
 * run of edits into the newest checkpoint by rewriting that row in place: an
 * edit made seconds after sharing landed in the very version the link served.
 * The artifact lifecycle (src/lib/artifact-writes.ts) replaced that store:
 * versions are immutable (the database refuses a rewrite), design gestures go
 * to a draft that is sealed as a NEW version, and publishing is its own thing
 * (src/lib/artifact-publication.ts). These are the hotfix's cases, ported to
 * that model and run against Postgres through the real store, routes and
 * public resolvers:
 *
 *   - a legacy share link serves the newest version created at or before its
 *     snapshot, and a later edit (draft, sealed draft, Juno's change) is a
 *     newer row it cannot see;
 *   - a revoked link never serves again; a taken-down one that an admin
 *     restores still shows exactly what it froze;
 *   - a publication made without naming a version is pinned to what the owner
 *     sees, so a later edit reaches it only through Update, and following the
 *     latest version is something the owner asks for.
 *
 * Skipped unless ARTIFACT_TEST_DATABASE_URL names a throwaway, migrated
 * database (never DATABASE_URL):
 *
 *   ARTIFACT_TEST_DATABASE_URL=postgresql:///juno_share_freeze \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/share-snapshot-freeze.test.ts
 */

const DB_URL = process.env.ARTIFACT_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!DB_URL || !canMockModules) {
  test("share freeze database suite is skipped without ARTIFACT_TEST_DATABASE_URL and module mocks", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "share-freeze-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;

  test("stand in for the session", () => {
    mock.module("@/lib/session", {
      namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn },
    });
  });

  const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
  const request = (method: string, body?: unknown) =>
    new Request("http://juno.test/api", {
      method,
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function signUp(label: string) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `share-freeze-${label}-${suffix}@example.invalid`, name: "Link owner", emailVerified: new Date() },
    });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  async function designBody(name: string) {
    const { serializeDesignDocument } = await import("../src/lib/design/migrations");
    const { signInDocument } = await import("./design-fixtures");
    return serializeDesignDocument({ ...signInDocument(), name });
  }

  /** One design, its versions made at the given instants (default: now). */
  async function design(userId: string, versions: Array<{ name: string; createdAt?: Date }>) {
    const bodies = await Promise.all(versions.map((v) => designBody(v.name)));
    return prisma.artifact.create({
      data: {
        userId,
        identifier: `sign-in-${Math.random().toString(16).slice(2, 8)}`,
        title: "Sign in",
        type: "DESIGN",
        currentVersion: versions.length,
        versions: {
          create: versions.map((v, i) => ({
            version: i + 1,
            content: bodies[i],
            origin: i === 0 ? "generated" : "edit",
            ...(v.createdAt ? { createdAt: v.createdAt } : {}),
          })),
        },
      },
    });
  }

  /** One design gesture through the real transactions route. */
  async function edit(artifactId: string, name: string, author: "user" | "juno" = "user") {
    const { parseStoredDesignDocument } = await import("../src/lib/design/migrations");
    const current = await prisma.artifact.findUniqueOrThrow({ where: { id: artifactId }, include: { draft: true } });
    const content =
      current.draft?.content ??
      (await prisma.artifactVersion.findUniqueOrThrow({
        where: { artifactId_version: { artifactId, version: current.currentVersion } },
      })).content;
    const route = await import("@/app/api/design/[artifactId]/transactions/route");
    const res = await route.POST(
      request("POST", {
        origin: "edit",
        transaction: {
          id: `tx-${Math.random().toString(16).slice(2)}`,
          baseRevision: parseStoredDesignDocument(content).revision,
          operations: [{ op: "renameDocument", name }],
          author,
          summary: `Rename to ${name}`,
          createdAt: new Date().toISOString(),
        },
      }),
      params({ artifactId })
    );
    assert.equal(res.status, 200, `the edit lands: ${await res.clone().text()}`);
  }

  async function seal(artifactId: string, userId: string) {
    const { sealArtifactDraft } = await import("@/lib/artifact-writes");
    return sealArtifactDraft(artifactId, userId);
  }

  /** What the public page of a legacy share link shows, or null when it serves nothing. */
  async function linkShows(token: string) {
    const { getPublicShare, getSharedArtifactSnapshot } = await import("@/lib/share");
    const share = await getPublicShare(token);
    if (!share) return null;
    const snapshot = await getSharedArtifactSnapshot(share);
    return snapshot ? { version: snapshot.version, name: (JSON.parse(snapshot.content) as { name: string }).name } : null;
  }

  async function shareOf(userId: string, artifactId: string) {
    const { createShare } = await import("@/lib/share");
    const share = await createShare(userId, "ARTIFACT", artifactId);
    assert.ok(share);
    return share;
  }

  // ─── The rule a link resolves with ──────────────────────────────────────

  test("a link serves the newest version that existed when it was made", async () => {
    const user = await signUp("rule");
    const base = Date.now() - 60 * 60_000;
    const at = (seconds: number) => new Date(base + seconds * 1_000);
    const artifact = await design(user.id, [
      { name: "One", createdAt: at(0) },
      { name: "Two", createdAt: at(10) },
      { name: "Three", createdAt: at(20) },
    ]);
    const { getSharedArtifactSnapshot } = await import("@/lib/share");
    const servedAt = async (snapshotAt: Date) =>
      (await getSharedArtifactSnapshot({ kind: "ARTIFACT", artifactId: artifact.id, userId: user.id, snapshotAt } as Share))?.version ?? null;

    assert.equal(await servedAt(at(15)), 2);
    assert.equal(await servedAt(at(20)), 3, "a version made in the same instant counts");
    assert.equal(await servedAt(at(99)), 3);
    assert.equal(await servedAt(at(-5)), 1, "a link older than every version serves the first");
  });

  // ─── The store and the public page ──────────────────────────────────────

  test("without a link, a quick run of edits folds into the draft, never a version", async () => {
    const user = await signUp("fold");
    const artifact = await design(user.id, [{ name: "Original" }]);
    await edit(artifact.id, "Edit one");
    await edit(artifact.id, "Edit two");
    assert.equal(await prisma.artifactVersion.count({ where: { artifactId: artifact.id } }), 1);
    const draft = await prisma.artifactDraft.findUniqueOrThrow({ where: { artifactId: artifact.id } });
    assert.match(draft.content, /"name":"Edit two"/);
  });

  test("an edit made seconds after sharing never reaches the link, sealed or not (B1)", async () => {
    const user = await signUp("b1");
    const artifact = await design(user.id, [{ name: "Shared state" }]);
    const link = await shareOf(user.id, artifact.id);
    assert.deepEqual(await linkShows(link.token), { version: 1, name: "Shared state" });

    // Inside the old checkpoint window, where the old store rewrote v1 in place.
    await edit(artifact.id, "Private edit");
    assert.deepEqual(await linkShows(link.token), { version: 1, name: "Shared state" }, "a draft is not a version");

    assert.equal(await seal(artifact.id, user.id), 2, "the run seals as a version of its own");
    assert.deepEqual(await linkShows(link.token), { version: 1, name: "Shared state" }, "sealed after the link, so still private");

    // The run carries on, sealed again, and the link still cannot see it.
    await edit(artifact.id, "Private edit two");
    await seal(artifact.id, user.id);
    assert.deepEqual(await linkShows(link.token), { version: 1, name: "Shared state" });
    const v1 = await prisma.artifactVersion.findUniqueOrThrow({ where: { artifactId_version: { artifactId: artifact.id, version: 1 } } });
    assert.match(v1.content, /"name":"Shared state"/, "the shared version is untouched");
  });

  test("a link frozen at an older version is untouched by edits to the newest", async () => {
    const user = await signUp("older");
    const artifact = await design(user.id, [
      { name: "First", createdAt: new Date(Date.now() - 20_000) },
      { name: "Moved", createdAt: new Date(Date.now() - 10_000) },
    ]);
    const link = await prisma.share.create({
      data: { token: randomBytes(24).toString("base64url"), userId: user.id, kind: "ARTIFACT", artifactId: artifact.id, title: "Sign in", snapshotAt: new Date(Date.now() - 15_000) },
    });
    await edit(artifact.id, "Newest");
    await seal(artifact.id, user.id);
    assert.deepEqual(await linkShows(link.token), { version: 1, name: "First" });
  });

  test("a revoked link never serves again; a taken-down one that is restored still shows what it froze", async () => {
    const user = await signUp("standing");
    const artifact = await design(user.id, [{ name: "Original" }]);
    const { revokeShare } = await import("@/lib/share");

    const revoked = await shareOf(user.id, artifact.id);
    assert.equal(await revokeShare(user.id, revoked.id), true);
    assert.equal(await linkShows(revoked.token), null);

    // An admin takedown, then edits, then the admin's restore.
    const link = await shareOf(user.id, artifact.id);
    assert.notEqual(link.token, revoked.token, "a revoked link is never reused");
    await prisma.share.update({ where: { id: link.id }, data: { takenDownAt: new Date(), takedownReason: "test" } });
    assert.equal(await linkShows(link.token), null);
    await edit(artifact.id, "Edited while down");
    await seal(artifact.id, user.id);
    await prisma.share.update({ where: { id: link.id }, data: { takenDownAt: null, takedownReason: null } });
    assert.deepEqual(await linkShows(link.token), { version: 1, name: "Original" });
  });

  test("a change Juno authors gets a version of its own, which the link cannot see", async () => {
    const user = await signUp("juno");
    const artifact = await design(user.id, [{ name: "Mine" }]);
    const link = await shareOf(user.id, artifact.id);
    await edit(artifact.id, "Juno's", "juno");
    assert.equal((await prisma.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).currentVersion, 2);
    assert.deepEqual(await linkShows(link.token), { version: 1, name: "Mine" });
  });

  test("the database refuses to rewrite a version a link serves", async () => {
    const user = await signUp("immutable");
    const artifact = await design(user.id, [{ name: "Shared" }]);
    await shareOf(user.id, artifact.id);
    await assert.rejects(
      prisma.artifactVersion.update({
        where: { artifactId_version: { artifactId: artifact.id, version: 1 } },
        data: { content: await designBody("Rewritten") },
      })
    );
  });

  // ─── Publishing ─────────────────────────────────────────────────────────

  test("Publish without a version pins what the owner sees; later edits reach the page only through Update", async () => {
    const user = await signUp("publish");
    const artifact = await design(user.id, [{ name: "Head" }]);
    await edit(artifact.id, "Looking at this");
    const route = await import("@/app/api/artifacts/[id]/publication/route");
    const publish = async (body: unknown) => {
      const res = await route.POST(request("POST", body), params({ id: artifact.id }));
      assert.equal(res.status, 200, await res.clone().text());
      return ((await res.json()) as { publication: { token: string; pinnedVersion: number | null; servedVersion: number } }).publication;
    };
    const { findPublicPublication } = await import("@/lib/artifact-publication");
    const pageShows = async (token: string) => {
      const found = await findPublicPublication(token);
      return found?.state === "live" ? { version: found.snapshot.version, name: (JSON.parse(found.snapshot.content) as { name: string }).name } : null;
    };

    const first = await publish({});
    assert.deepEqual([first.pinnedVersion, first.servedVersion], [2, 2], "the draft was sealed and pinned: what the owner saw");
    assert.deepEqual(await pageShows(first.token), { version: 2, name: "Looking at this" });

    await edit(artifact.id, "Later edit");
    await seal(artifact.id, user.id);
    assert.deepEqual(await pageShows(first.token), { version: 2, name: "Looking at this" }, "a sealed later edit stays private");

    const updated = await publish({ version: "current" });
    assert.equal(updated.token, first.token, "Update keeps the URL");
    assert.deepEqual(await pageShows(first.token), { version: 3, name: "Later edit" });

    // Following later saves is asked for, by name.
    const following = await publish({ version: "latest" });
    assert.equal(following.pinnedVersion, null);
  });

  test("clean up the throwaway accounts", async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: "share-freeze-" } } });
    await prisma.$disconnect();
  });
}
