/**
 * A public link to a design stays frozen at the version it was made on
 * (audit docs/rework/audit/artifacts.md, B1).
 *
 * The Share dialog promises "Later edits stay private", and a link serves the
 * version current at its `snapshotAt`. The design store used to fold every
 * edit inside the 30 s checkpoint window into the newest version by rewriting
 * that row in place, so an edit made up to ~30 s after sharing landed in the
 * very version the link serves, and went public.
 *
 * The rule both sides now read is `sharedVersionAt` / `versionIsShared`
 * (src/lib/share-snapshot.ts), checked directly first. Then the real
 * `commitTransaction` (src/lib/design/store.ts) and the real public resolver
 * `getSharedArtifactSnapshot` (src/lib/share.ts) run against one stand-in
 * Prisma client, so each case asserts what the store wrote and what the link
 * shows afterwards.
 *
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/share-snapshot-freeze.test.ts
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import type { Share } from "@prisma/client";

import { sharedVersionAt, versionIsShared } from "@/lib/share-snapshot";
import { serializeDesignDocument } from "@/lib/design/migrations";
import type { DesignDocument } from "@/lib/design/types";
import { run, signInDocument, transaction } from "./design-fixtures";

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 30, 12, 0, 0) + seconds * 1_000);
const history = [
  { version: 1, createdAt: at(0) },
  { version: 2, createdAt: at(10) },
  { version: 3, createdAt: at(20) },
];

test("a link serves the newest version that existed when it was made", () => {
  assert.equal(sharedVersionAt(history, at(15)), 2);
  assert.equal(sharedVersionAt(history, at(20)), 3, "a version made in the same instant counts");
  assert.equal(sharedVersionAt(history, at(99)), 3);
  assert.equal(sharedVersionAt([...history].reverse(), at(15)), 2, "the order rows arrive in is irrelevant");
});

test("a link older than every version serves the first; no versions serve nothing", () => {
  assert.equal(sharedVersionAt(history, at(-5)), 1);
  assert.equal(sharedVersionAt([], at(5)), null);
});

test("a version is shared exactly when some link resolves to it", () => {
  assert.equal(versionIsShared(3, history, []), false, "no links, nothing shared");
  assert.equal(versionIsShared(3, history, [at(15)]), false, "a link frozen at v2 cannot see v3");
  assert.equal(versionIsShared(2, history, [at(15)]), true);
  assert.equal(versionIsShared(3, history, [at(15), at(25)]), true, "the newer link can");
  assert.equal(versionIsShared(1, history.slice(0, 1), [at(-5)]), true, "the first-version fallback is covered too");
  // The first edit after sharing gets a version the link cannot see, and the
  // run is free to fold into that one.
  const afterShare = [...history, { version: 4, createdAt: at(30) }];
  assert.equal(versionIsShared(4, afterShare, [at(15), at(25)]), false);
});

// ---------------------------------------------------------------------------
// The store and the public page, against one stand-in database
// ---------------------------------------------------------------------------

const OWNER = "user-owner";
const ARTIFACT_ID = "art-design-1";

type VersionRow = { id: string; artifactId: string; version: number; content: string; origin: string | null; createdAt: Date };
type ShareRow = { id: string; userId: string; kind: "ARTIFACT"; artifactId: string; snapshotAt: Date; revokedAt: Date | null; takenDownAt: Date | null };

const db = {
  artifact: {
    id: ARTIFACT_ID,
    conversationId: "c1",
    messageId: null,
    identifier: "sign-in",
    title: "Sign in",
    type: "DESIGN",
    language: null,
    currentVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  versions: [] as VersionRow[],
  shares: [] as ShareRow[],
};
const shareQueries: Record<string, unknown>[] = [];

const withVersions = () => ({
  ...db.artifact,
  versions: [...db.versions].sort((a, b) => a.version - b.version).map((v) => ({ ...v })),
});

const prisma = {
  artifact: {
    findFirst: async (args: { where: { id: string } }) => (args.where.id === db.artifact.id ? withVersions() : null),
    findUnique: async (args: { where: { id: string } }) =>
      args.where.id === db.artifact.id ? { title: db.artifact.title, type: db.artifact.type, language: db.artifact.language } : null,
    update: async (args: { where: { id: string }; data: { currentVersion: number } }) => {
      Object.assign(db.artifact, args.data, { updatedAt: new Date() });
      return withVersions();
    },
  },
  artifactVersion: {
    create: async (args: { data: { artifactId: string; version: number; content: string; origin?: string } }) => {
      if (db.versions.some((v) => v.version === args.data.version)) throw Object.assign(new Error("unique"), { code: "P2002" });
      const row = { id: `v${args.data.version}`, origin: null, ...args.data, createdAt: new Date() };
      db.versions.push(row);
      return row;
    },
    // The fold's compare-and-swap, as Postgres would run it.
    updateMany: async (args: { where: { artifactId: string; version: number; content: string }; data: { content: string } }) => {
      const hit = db.versions.filter(
        (v) => v.artifactId === args.where.artifactId && v.version === args.where.version && v.content === args.where.content
      );
      for (const v of hit) v.content = args.data.content;
      return { count: hit.length };
    },
    findMany: async (args: { where: { artifactId: string } }) =>
      db.versions.filter((v) => v.artifactId === args.where.artifactId).map((v) => ({ version: v.version, createdAt: v.createdAt })),
    findUnique: async (args: { where: { artifactId_version: { artifactId: string; version: number } } }) =>
      db.versions.find(
        (v) => v.artifactId === args.where.artifactId_version.artifactId && v.version === args.where.artifactId_version.version
      ) ?? null,
  },
  share: {
    findMany: async (args: { where: Record<string, unknown> }) => {
      shareQueries.push(args.where);
      const where = args.where;
      return db.shares
        .filter(
          (s) =>
            s.userId === where.userId &&
            s.artifactId === where.artifactId &&
            s.kind === where.kind &&
            (where.revokedAt === null ? s.revokedAt === null : true)
        )
        .map((s) => ({ snapshotAt: s.snapshotAt }));
    },
  },
  $transaction: async (arg: unknown): Promise<unknown> =>
    typeof arg === "function" ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[]),
};

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so these cases skip there rather than failing: the
// store and the resolver both reach Prisma.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const storeTest = canMockModules ? test : test.skip;

if (canMockModules) mock.module("@/lib/prisma", { namedExports: { prisma, prismaUnguarded: prisma } });

const secondsAgo = (s: number) => new Date(Date.now() - s * 1_000);

/** One design, its versions made `ago` seconds back by a person editing. */
function seed(versions: Array<{ body: string; ago: number; origin?: string }>) {
  db.versions = versions.map((v, i) => ({
    id: `v${i + 1}`,
    artifactId: ARTIFACT_ID,
    version: i + 1,
    content: v.body,
    origin: v.origin ?? "edit",
    createdAt: secondsAgo(v.ago),
  }));
  db.artifact.currentVersion = versions.length;
  db.shares = [];
  shareQueries.length = 0;
}

function share(snapshotAt: Date, standing: Partial<Pick<ShareRow, "revokedAt" | "takenDownAt">> = {}): Share {
  const row: ShareRow = {
    id: `s${db.shares.length + 1}`,
    userId: OWNER,
    kind: "ARTIFACT",
    artifactId: ARTIFACT_ID,
    snapshotAt,
    revokedAt: null,
    takenDownAt: null,
    ...standing,
  };
  db.shares.push(row);
  return { ...row, conversationId: null, token: `token-${row.id}`, title: "Sign in", views: 0, takenDownBy: null, takedownReason: null, createdAt: snapshotAt } as Share;
}

async function edit(doc: DesignDocument, x: number) {
  const { commitTransaction, loadOwnedDesignArtifact } = await import("@/lib/design/store");
  const artifact = await loadOwnedDesignArtifact(ARTIFACT_ID, OWNER);
  assert.ok(artifact);
  const outcome = await commitTransaction(
    artifact,
    transaction([{ op: "updateNode", nodeId: "screen", patch: { x } }], { baseRevision: doc.revision }),
    "edit",
    OWNER
  );
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.message);
  return outcome;
}

async function linkShows(link: Share) {
  const { getSharedArtifactSnapshot } = await import("@/lib/share");
  const snapshot = await getSharedArtifactSnapshot(link);
  assert.ok(snapshot);
  return { version: snapshot.version, content: snapshot.content };
}

const bodyOf = (version: number) => db.versions.find((v) => v.version === version)?.content;

storeTest("without a link, a quick run of edits still folds into one checkpoint", async () => {
  const doc = signInDocument();
  const original = serializeDesignDocument(doc);
  seed([{ body: original, ago: 5 }]);

  const outcome = await edit(doc, 40);
  assert.equal(outcome.artifact.currentVersion, 1, "folded, as before");
  assert.equal(db.versions.length, 1);
  assert.notEqual(bodyOf(1), original, "the checkpoint holds the edit");
});

storeTest("an edit made seconds after sharing never reaches the link (B1)", async () => {
  const doc = signInDocument();
  const shared = serializeDesignDocument(doc);
  seed([{ body: shared, ago: 10 }]);
  const link = share(secondsAgo(5));
  assert.deepEqual(await linkShows(link), { version: 1, content: shared });

  // Inside the checkpoint window, where the old store rewrote v1 in place.
  const first = await edit(doc, 40);
  assert.equal(first.artifact.currentVersion, 2, "the edit got a checkpoint of its own");
  assert.equal(bodyOf(1), shared, "the shared version is untouched");
  assert.deepEqual(await linkShows(link), { version: 1, content: shared }, "the link still shows what was shared");

  // The run carries on in the new checkpoint, which the link cannot see.
  const second = await edit(first.document, 80);
  assert.equal(second.artifact.currentVersion, 2, "folded into v2");
  assert.equal(db.versions.length, 2);
  assert.equal(bodyOf(2), serializeDesignDocument(second.document));
  assert.deepEqual(await linkShows(link), { version: 1, content: shared });

  // Scoped to the signed-in owner, like every other read of their links.
  assert.deepEqual(shareQueries[0], { userId: OWNER, kind: "ARTIFACT", artifactId: ARTIFACT_ID, revokedAt: null });
});

storeTest("a link frozen at an older version leaves the newest checkpoint free to fold", async () => {
  const doc = signInDocument();
  const v1 = serializeDesignDocument(doc);
  const moved = run(doc, [{ op: "updateNode", nodeId: "screen", patch: { x: 10 } }]).document;
  seed([
    { body: v1, ago: 20 },
    { body: serializeDesignDocument(moved), ago: 10 },
  ]);
  const link = share(secondsAgo(15));

  const outcome = await edit(moved, 60);
  assert.equal(outcome.artifact.currentVersion, 2, "folded into v2, which the link cannot see");
  assert.equal(db.versions.length, 2);
  assert.deepEqual(await linkShows(link), { version: 1, content: v1 });
});

storeTest("a revoked link does not hold a checkpoint; a taken-down one does", async () => {
  const doc = signInDocument();
  const original = serializeDesignDocument(doc);

  seed([{ body: original, ago: 10 }]);
  share(secondsAgo(5), { revokedAt: secondsAgo(2) });
  const afterRevoke = await edit(doc, 40);
  assert.equal(afterRevoke.artifact.currentVersion, 1, "a revoked link never serves again, so the run folds");

  // An admin restore brings a taken-down link back with its old snapshot.
  seed([{ body: original, ago: 10 }]);
  const link = share(secondsAgo(5), { takenDownAt: secondsAgo(2) });
  const afterTakedown = await edit(doc, 40);
  assert.equal(afterTakedown.artifact.currentVersion, 2);
  assert.equal(bodyOf(1), original);
  assert.deepEqual(await linkShows(link), { version: 1, content: original });
});

storeTest("an edit that takes a new checkpoint anyway never asks about links", async () => {
  const doc = signInDocument();
  // Juno's output is never folded into, so no share lookup is needed.
  seed([{ body: serializeDesignDocument(doc), ago: 5, origin: "generated" }]);
  share(secondsAgo(2));
  const outcome = await edit(doc, 40);
  assert.equal(outcome.artifact.currentVersion, 2);
  assert.equal(shareQueries.length, 0);
});
