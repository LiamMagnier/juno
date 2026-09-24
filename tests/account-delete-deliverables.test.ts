import assert from "node:assert/strict";
import test, { mock } from "node:test";

/*
 * DELETING AN ACCOUNT DELETES THE FILES WORK MADE FOR IT.
 *
 * Account deletion purged attachments, their thumbnails and the avatar, then
 * dropped the user row. Every Work deliverable version (the documents, decks,
 * sheets and sites a task produced) is an object in storage too, named only by
 * `WorkArtifactVersion.storageKey`. The row cascaded away with the account and
 * the bytes stayed in the bucket with nothing left pointing at them (X-26 in
 * docs/design/artifacts-design/00-AUDIT-OVERVIEW.md). Earlier attachment
 * versions and an unfinished import's uploads were orphaned the same way.
 *
 * These drive the real `deleteAccountPermanently` with the database and object
 * storage stood in: the rule is "read every key, purge every object, and only
 * then drop the row", and a stub can record that order where a real bucket
 * cannot.
 */

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so the suite skips there rather than failing.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

type Row = { storageKey: string };

interface World {
  attachments: Row[];
  attachmentVersions: Row[];
  deliverableVersions: Row[];
  importObjects: Row[];
  /** Keys whose delete throws, as an S3 outage would. */
  failing: Set<string>;
}

let world: World;
/** Everything the stubs saw, in order: "delete:<key>", "user.delete", and each query. */
let events: string[];
let queries: Record<string, unknown>;

function reset(partial: Partial<World> = {}) {
  world = { attachments: [], attachmentVersions: [], deliverableVersions: [], importObjects: [], failing: new Set(), ...partial };
  events = [];
  queries = {};
}
reset();

const findMany = (name: keyof Omit<World, "failing">) => async (args: unknown) => {
  queries[name] = args;
  events.push(`query:${name}`);
  return world[name];
};

if (!canMockModules) {
  test("account deletion suite needs --experimental-test-module-mocks", { skip: true }, () => {});
} else {
  mock.module("@/lib/prisma", {
    namedExports: {
      prisma: {
        subscription: { findUnique: async () => null },
        attachment: { findMany: findMany("attachments") },
        attachmentVersion: { findMany: findMany("attachmentVersions") },
        workArtifactVersion: { findMany: findMany("deliverableVersions") },
        importObject: { findMany: findMany("importObjects") },
        user: {
          delete: async (args: unknown) => {
            queries.userDelete = args;
            events.push("user.delete");
            return {};
          },
        },
      },
    },
  });
  mock.module("@/lib/env", { namedExports: { isStripeConfigured: () => false } });
  mock.module("@/lib/stripe", {
    namedExports: {
      getStripe: () => {
        throw new Error("billing is not configured in this test");
      },
    },
  });
  mock.module("@/lib/storage", {
    namedExports: {
      deleteObject: async (key: string) => {
        events.push(`delete:${key}`);
        if (world.failing.has(key)) throw new Error("SlowDown: storage is unavailable");
      },
    },
  });
  mock.module("@/lib/attachments/thumbnail", {
    namedExports: { thumbnailObjectKey: (key: string) => `${key}.thumb.jpg` },
  });

  const load = () => import("../src/app/api/account/delete-account");
  const user = { id: "user-1", email: "ada@example.test", image: "/api/files/uploads/user-1/avatar.png" };
  const deleted = () => events.filter((event) => event.startsWith("delete:")).map((event) => event.slice("delete:".length));

  test("every deliverable version's object is purged before the account row goes", async () => {
    reset({
      attachments: [{ storageKey: "uploads/user-1/a-notes.pdf" }],
      deliverableVersions: [
        { storageKey: "uploads/user-1/v1-q3-report.docx" },
        { storageKey: "uploads/user-1/v2-q3-report.docx" },
        { storageKey: "uploads/user-1/v1-launch-deck.pptx" },
      ],
    });
    const { deleteAccountPermanently } = await load();
    const report = await deleteAccountPermanently(user);

    for (const { storageKey } of world.deliverableVersions) {
      assert.ok(deleted().includes(storageKey), `${storageKey} is purged`);
    }
    // Deliverables have no thumbnails; only attachments do.
    assert.ok(!deleted().some((key) => key.endsWith(".docx.thumb.jpg") || key.endsWith(".pptx.thumb.jpg")));
    assert.ok(deleted().includes("uploads/user-1/a-notes.pdf.thumb.jpg"));
    assert.ok(deleted().includes("uploads/user-1/avatar.png"));

    // Keys are read, then objects purged, then the row dropped. After the row
    // goes the cascade has erased every record of these keys.
    const userDelete = events.indexOf("user.delete");
    assert.equal(userDelete, events.length - 1, "the account row is the last thing to go");
    assert.ok(events.slice(0, userDelete).every((event) => event.startsWith("query:") || event.startsWith("delete:")));

    assert.equal(report.deliverableVersionCount, 3);
    assert.equal(report.attachmentCount, 1);
    assert.equal(report.failedObjects, 0);
    assert.equal(report.purgedObjects, deleted().length);
  });

  test("the deliverable query is scoped to the account, soft-deleted deliverables included", async () => {
    reset();
    const { deleteAccountPermanently } = await load();
    await deleteAccountPermanently(user);
    // A version row has no owner column; the scope must go through its artifact.
    assert.deepEqual(queries.deliverableVersions, {
      where: { artifact: { userId: "user-1" } },
      select: { storageKey: true },
    });
    assert.deepEqual(queries.attachmentVersions, {
      where: { attachment: { userId: "user-1" } },
      select: { storageKey: true },
    });
    assert.deepEqual(queries.importObjects, {
      where: { userId: "user-1", status: { not: "deleted" } },
      select: { storageKey: true },
    });
    assert.deepEqual(queries.userDelete, { where: { id: "user-1" } });
  });

  test("earlier attachment versions and unfinished imports are purged, each object once", async () => {
    reset({
      attachments: [{ storageKey: "uploads/user-1/current.pdf" }],
      attachmentVersions: [
        // The snapshot of the current bytes shares the attachment's key.
        { storageKey: "uploads/user-1/current.pdf" },
        { storageKey: "uploads/user-1/earlier.pdf" },
      ],
      importObjects: [
        { storageKey: "uploads/user-1/imports/run-1/staged.png" },
        // Attached already: the same key as an attachment.
        { storageKey: "uploads/user-1/current.pdf" },
      ],
    });
    const { deleteAccountPermanently } = await load();
    await deleteAccountPermanently({ id: "user-1", email: null, image: null });

    const keys = deleted();
    assert.equal(new Set(keys).size, keys.length, "no object is deleted twice");
    assert.deepEqual(
      [...keys].sort(),
      [
        "uploads/user-1/current.pdf",
        "uploads/user-1/current.pdf.thumb.jpg",
        "uploads/user-1/earlier.pdf",
        "uploads/user-1/earlier.pdf.thumb.jpg",
        "uploads/user-1/imports/run-1/staged.png",
      ].sort()
    );
  });

  test("a storage failure is logged and counted, and never keeps the account alive", async () => {
    reset({
      deliverableVersions: [
        { storageKey: "uploads/user-1/v1-budget.xlsx" },
        { storageKey: "uploads/user-1/v1-site.zip" },
        { storageKey: "uploads/user-1/v2-site.zip" },
      ],
      failing: new Set(["uploads/user-1/v1-site.zip", "uploads/user-1/v2-site.zip"]),
    });
    const logged: unknown[][] = [];
    const error = mock.method(console, "error", (...args: unknown[]) => {
      logged.push(args);
    });
    try {
      const { deleteAccountPermanently } = await load();
      const report = await deleteAccountPermanently({ id: "user-1" });

      assert.ok(events.includes("user.delete"), "the account is deleted anyway");
      assert.equal(report.failedObjects, 2);
      assert.equal(report.purgedObjects, 1);
      // Every key was still attempted: one failure does not stop the rest.
      assert.equal(deleted().length, 3);

      assert.equal(logged.length, 1, "one line for the outage, not one per object");
      const line = logged[0].map(String).join(" ");
      assert.match(line, /2 of 3 stored objects could not be purged/);
      assert.match(line, /storage is unavailable/);
      assert.doesNotMatch(line, /site\.zip|budget\.xlsx/, "the keys carry file names and stay out of the log");
    } finally {
      error.mock.restore();
    }
  });

  test("when the keys cannot be read, nothing is deleted and the account stays for a retry", async () => {
    reset();
    const { prisma } = (await import("@/lib/prisma")) as unknown as {
      prisma: { workArtifactVersion: { findMany: (args: unknown) => Promise<Row[]> } };
    };
    const original = prisma.workArtifactVersion.findMany;
    prisma.workArtifactVersion.findMany = async () => {
      throw new Error("connection reset");
    };
    try {
      const { deleteAccountPermanently } = await load();
      await assert.rejects(deleteAccountPermanently(user), /connection reset/);
      assert.ok(!events.includes("user.delete"), "the row, the only record of the keys, is kept");
      assert.deepEqual(deleted(), []);
    } finally {
      prisma.workArtifactVersion.findMany = original;
    }
  });
}
