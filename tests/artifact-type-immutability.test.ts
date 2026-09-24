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
/** The current version's origin, as the re-emit guard reads it. */
let currentOrigin: string | null = "generated";

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
    // A read that includes relations (the held path reads the row back) gets
    // the full row; the plain lookup by identifier gets the bare one.
    findUnique: async (args?: { include?: unknown }) => (existing && args?.include ? row({}) : existing),
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
    findUnique: async () => ({ origin: currentOrigin, content: "<p>current</p>" }),
  },
  artifactProposal: {
    updateMany: (args: Record<string, unknown>) => {
      calls.push({ op: "proposal.updateMany", args });
      return Promise.resolve({ count: 0 });
    },
    create: (args: Record<string, unknown>) => {
      calls.push({ op: "proposal.create", args });
      return Promise.resolve({});
    },
  },
  // Both forms: a batch (the store's older callers) and an interactive
  // transaction, which runs its callback against this same stand-in.
  $transaction: (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg),
};

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so the suite skips there rather than failing: every
// test loads the store, and the store reaches Prisma.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const storeTest = canMockModules ? test : test.skip;

if (canMockModules) mock.module("@/lib/prisma", { namedExports: { prisma } });
const load = () => import("@/lib/artifacts-store");

storeTest("a same-type re-emission appends a version and never writes the type", async () => {
  const { persistArtifacts } = await load();
  calls.length = 0;
  currentOrigin = "generated";
  existing = { id: "ck-old-artifact-abc123", identifier: "screen", type: "HTML", currentVersion: 3, messageId: "m1", title: "Screen" };
  const out = await persistArtifacts("c1", "m2", [{ identifier: "screen", type: "HTML", title: "Screen", content: "<p>v4</p>" }]);
  assert.equal(out.length, 1);
  const update = calls.find((c) => c.op === "update");
  assert.ok(update);
  assert.equal("type" in (update.args.data as object), false);
  assert.equal((calls.find((c) => c.op === "version.create")?.args.data as { version: number }).version, 4);
});

storeTest("a re-emission with a new type makes a new artifact and retires the old handle", async () => {
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

storeTest("the retired handle is the identifier plus the last six characters of the id", async () => {
  const { retiredIdentifier } = await load();
  assert.equal(retiredIdentifier("sign-in", "clx0000000000000000zz9k2q"), "sign-in~zz9k2q");
});

storeTest("an unfinished block is never stored, even by a caller that skipped verification (X-07)", async () => {
  const { persistArtifacts } = await load();
  calls.length = 0;
  existing = { id: "ck-old-artifact-abc123", identifier: "screen", type: "HTML", currentVersion: 3, messageId: "m1", title: "Screen" };
  // What `parseArtifacts` hands back for a reply that stopped inside the block:
  // the research audit passes this straight through, with no verifier between.
  const out = await persistArtifacts("c1", "m2", [
    { identifier: "screen", type: "HTML", title: "Screen", content: "<p>half a pa", incomplete: true },
  ]);
  assert.deepEqual(out, []);
  assert.deepEqual(calls, [], "no update, no create, no version: v3 stays current");
});

// The re-emit guard (tests/artifact-reemit-guard.test.ts has the rules and the
// database suite). Here only its effect on the writes, with no database.

storeTest("a same-type re-emission over a person's edit is held: no version, no write to the row", async () => {
  const { persistArtifacts } = await load();
  calls.length = 0;
  currentOrigin = "edit";
  existing = { id: "ck-old-artifact-abc123", identifier: "screen", type: "HTML", currentVersion: 3, messageId: "m1", title: "Screen" };
  const out = await persistArtifacts(
    "c1",
    "m2",
    [{ identifier: "screen", type: "HTML", title: "Screen", content: "<p>v4</p>" }],
    { heldIds: new Map([["screen", "planned-proposal-id"]]), taint: "untrusted-input" }
  );
  assert.equal(out.length, 1, "the row goes back as it is");
  assert.deepEqual(
    calls.map((c) => c.op),
    ["proposal.updateMany", "proposal.create"],
    "an older suggestion is superseded and the new one written; nothing else"
  );
  const created = calls.find((c) => c.op === "proposal.create")?.args.data as Record<string, unknown>;
  assert.equal(created.id, "planned-proposal-id", "the id the saved message already names");
  assert.equal(created.artifactId, "ck-old-artifact-abc123");
  assert.equal(created.baseVersion, 3);
  assert.equal(created.messageId, "m2");
  assert.equal(created.taint, "untrusted-input");
  assert.deepEqual(created.payload, { content: "<p>v4</p>", title: "Screen", language: null });
  assert.equal(created.summary, "You edited this after Juno's last version");
});

storeTest("with the guard switched off, a re-emission over an edit appends as before", async () => {
  const { persistArtifacts } = await load();
  calls.length = 0;
  currentOrigin = "edit";
  existing = { id: "ck-old-artifact-abc123", identifier: "screen", type: "HTML", currentVersion: 3, messageId: "m1", title: "Screen" };
  const before = process.env.JUNO_AI_REEMIT_GUARD;
  process.env.JUNO_AI_REEMIT_GUARD = "0";
  try {
    await persistArtifacts("c1", "m2", [{ identifier: "screen", type: "HTML", title: "Screen", content: "<p>v4</p>" }]);
  } finally {
    if (before === undefined) delete process.env.JUNO_AI_REEMIT_GUARD;
    else process.env.JUNO_AI_REEMIT_GUARD = before;
  }
  assert.equal((calls.find((c) => c.op === "version.create")?.args.data as { version: number }).version, 4);
  assert.equal(calls.some((c) => c.op.startsWith("proposal.")), false);
});

storeTest("a trashed row with the identifier is retired, and the re-emission makes a new artifact", async () => {
  const { persistArtifacts } = await load();
  calls.length = 0;
  currentOrigin = "generated";
  existing = {
    id: "ck-old-artifact-abc123",
    identifier: "screen",
    type: "HTML",
    currentVersion: 3,
    messageId: "m1",
    title: "Screen",
    deletedAt: new Date("2026-09-20T10:00:00Z"),
  };
  const out = await persistArtifacts("c1", "m2", [{ identifier: "screen", type: "HTML", title: "Screen", content: "<p>new</p>" }]);
  assert.equal(out.length, 2);
  assert.deepEqual(calls.find((c) => c.op === "update")?.args.data, { identifier: "screen~abc123" });
  assert.equal((calls.find((c) => c.op === "create")?.args.data as Record<string, unknown>).identifier, "screen");
  assert.equal(calls.some((c) => c.op === "version.create"), false, "the trashed row gains no version");
});
