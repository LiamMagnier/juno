/**
 * An artifact's type never changes (audit M11; merge plan §2.6, R0).
 *
 * `persistArtifacts` runs against a stand-in Prisma client so the rule is
 * checked without a database: a same-type re-emission appends a version and
 * never writes `type`; a different type retires the old row under
 * `{identifier}~{id tail}` and makes a new artifact that takes the identifier.
 *
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/artifact-type-immutability.test.ts
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

type Call = { op: string; args: Record<string, unknown> };
const calls: Call[] = [];
let existing: Record<string, unknown> | null = null;

function row(data: Record<string, unknown>) {
  const now = new Date("2026-09-24T10:00:00Z");
  return {
    id: "ck-new-artifact-000001",
    conversationId: "c1",
    messageId: null,
    identifier: "screen",
    title: "Screen",
    type: "HTML",
    language: null,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
    versions: [{ version: 1, content: "x", origin: "generated", createdAt: now }],
    ...existing,
    ...data,
  };
}

const prisma = {
  conversation: {
    // The owner and project of the conversation the artifacts are made in.
    findFirst: async () => ({ userId: "u1", projectId: null }),
    findUnique: async () => ({ userId: "u1", projectId: null }),
  },
  artifact: {
    findFirst: async (args: { include?: unknown; select?: unknown }) => (args.include ? row({}) : existing),
    update: (args: Record<string, unknown>) => {
      calls.push({ op: "update", args });
      return Promise.resolve(row((args.data as Record<string, unknown>) ?? {}));
    },
    create: (args: Record<string, unknown>) => {
      calls.push({ op: "create", args });
      const data = args.data as Record<string, unknown>;
      return Promise.resolve({ ...row({}), ...data, id: "ck-new-artifact-000001", createdAt: new Date(), updatedAt: new Date(), versions: [{ version: 1, content: "x", origin: "generated", createdAt: new Date() }] });
    },
  },
  artifactDraft: {
    findFirst: async () => null,
  },
  // Juno's append first holds a page that follows latest; nothing is published here.
  artifactPublication: {
    updateMany: async () => ({ count: 0 }),
  },
  artifactVersion: {
    // The head was Juno's own, so the re-emit guard lets the re-emit append.
    findUnique: async () => ({ origin: "generated", content: "x" }),
    create: (args: Record<string, unknown>) => {
      calls.push({ op: "version.create", args });
      return Promise.resolve({});
    },
  },
  // lockArtifact's row lock: the existing row, as `SELECT … FOR UPDATE` returns it.
  $queryRaw: async () => (existing ? [{ ...existing, userId: "u1", deletedAt: null }] : []),
  $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
};

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so the suite skips there rather than failing: every
// test loads the store, and the store reaches Prisma.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const storeTest = canMockModules ? test : test.skip;

if (canMockModules) mock.module("@/lib/prisma", { namedExports: { prisma, prismaUnguarded: prisma } });
const load = () => import("@/lib/artifacts-store");

storeTest("a same-type re-emission appends a version and never writes the type", async () => {
  const { persistArtifacts } = await load();
  calls.length = 0;
  existing = { id: "ck-old-artifact-abc123", identifier: "screen", type: "HTML", currentVersion: 3, messageId: "m1", title: "Screen", deletedAt: null };
  const out = await persistArtifacts("c1", "m2", [{ identifier: "screen", type: "HTML", title: "Screen", content: "<p>v4</p>" }]);
  assert.equal(out.length, 1);
  const update = calls.find((c) => c.op === "update");
  assert.ok(update);
  assert.equal("type" in (update.args.data as object), false);
  assert.equal((update.args.data as { currentVersion: number }).currentVersion, 4);
  assert.equal((calls.find((c) => c.op === "version.create")?.args.data as { version: number }).version, 4);
});

storeTest("a re-emission with a new type makes a new artifact and retires the old handle", async () => {
  const { persistArtifacts } = await load();
  calls.length = 0;
  existing = { id: "ck-old-artifact-abc123", identifier: "screen", type: "DESIGN", currentVersion: 3, messageId: "m1", title: "Screen", deletedAt: null };
  const out = await persistArtifacts("c1", "m2", [{ identifier: "screen", type: "HTML", title: "Screen", content: "<p>page</p>" }]);
  assert.equal(out.length, 2, "both rows go back to the client");
  const update = calls.find((c) => c.op === "update");
  assert.deepEqual(update?.args.where, { id: "ck-old-artifact-abc123", userId: "u1" });
  assert.deepEqual(update?.args.data, { identifier: "screen~abc123" });
  const create = calls.find((c) => c.op === "create")?.args.data as Record<string, unknown>;
  assert.equal(create.identifier, "screen");
  assert.equal(create.type, "HTML");
  assert.equal(create.currentVersion, 1);
  assert.equal(create.messageId, "m2");
  assert.equal(create.userId, "u1", "the new row has its own owner");
  assert.equal(calls.some((c) => c.op === "version.create"), false, "the old row gains no version of the new type");
});

storeTest("the retired handle is the identifier plus the last six characters of the id", async () => {
  const { retiredIdentifier } = await load();
  assert.equal(retiredIdentifier("sign-in", "clx0000000000000000zz9k2q"), "sign-in~zz9k2q");
});

storeTest("an unfinished block is never stored, even by a caller that skipped verification (X-07)", async () => {
  const { persistArtifacts } = await load();
  calls.length = 0;
  existing = { id: "ck-old-artifact-abc123", identifier: "screen", type: "HTML", currentVersion: 3, messageId: "m1", title: "Screen", deletedAt: null };
  // What `parseArtifacts` hands back for a reply that stopped inside the block:
  // the research audit passes this straight through, with no verifier between.
  const out = await persistArtifacts("c1", "m2", [
    { identifier: "screen", type: "HTML", title: "Screen", content: "<p>half a pa", incomplete: true },
  ]);
  assert.deepEqual(out, []);
  assert.deepEqual(calls, [], "no update, no create, no version: v3 stays current");
});
