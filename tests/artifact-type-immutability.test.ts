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
  artifact: {
    findUnique: async () => existing,
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
  artifactVersion: {
    create: (args: Record<string, unknown>) => {
      calls.push({ op: "version.create", args });
      return Promise.resolve({});
    },
  },
  $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
};

mock.module("@/lib/prisma", { namedExports: { prisma } });
const load = () => import("@/lib/artifacts-store");

test("a same-type re-emission appends a version and never writes the type", async () => {
  const { persistArtifacts } = await load();
  calls.length = 0;
  existing = { id: "ck-old-artifact-abc123", identifier: "screen", type: "HTML", currentVersion: 3, messageId: "m1", title: "Screen" };
  const out = await persistArtifacts("c1", "m2", [{ identifier: "screen", type: "HTML", title: "Screen", content: "<p>v4</p>" }]);
  assert.equal(out.length, 1);
  const update = calls.find((c) => c.op === "update");
  assert.ok(update);
  assert.equal("type" in (update.args.data as object), false);
  assert.equal((calls.find((c) => c.op === "version.create")?.args.data as { version: number }).version, 4);
});

test("a re-emission with a new type makes a new artifact and retires the old handle", async () => {
  const { persistArtifacts } = await load();
  calls.length = 0;
  existing = { id: "ck-old-artifact-abc123", identifier: "screen", type: "DESIGN", currentVersion: 3, messageId: "m1", title: "Screen" };
  const out = await persistArtifacts("c1", "m2", [{ identifier: "screen", type: "HTML", title: "Screen", content: "<p>page</p>" }]);
  assert.equal(out.length, 2, "both rows go back to the client");
  const update = calls.find((c) => c.op === "update");
  assert.deepEqual(update?.args.where, { id: "ck-old-artifact-abc123" });
  assert.deepEqual(update?.args.data, { identifier: "screen~abc123" });
  const create = calls.find((c) => c.op === "create")?.args.data as Record<string, unknown>;
  assert.equal(create.identifier, "screen");
  assert.equal(create.type, "HTML");
  assert.equal(create.currentVersion, 1);
  assert.equal(create.messageId, "m2");
  assert.equal(calls.some((c) => c.op === "version.create"), false, "the old row gains no version of the new type");
});

test("the retired handle is the identifier plus the last six characters of the id", async () => {
  const { retiredIdentifier } = await load();
  assert.equal(retiredIdentifier("sign-in", "clx0000000000000000zz9k2q"), "sign-in~zz9k2q");
});
