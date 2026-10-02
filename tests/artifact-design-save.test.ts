/**
 * The generic artifact save validates a design body (audit
 * docs/rework/audit/artifacts.md, B2; Rec 5).
 *
 * `POST /api/artifacts/[id]` is how restore and the Mac and iPhone Save write
 * a whole design, and it used to store any text for one. A body the editor
 * cannot parse then opened as "This design can't be opened" everywhere. The
 * check is `checkDesignDocumentSave` (src/lib/design/document-save.ts), which
 * applies `parseStoredDesignDocument` — the parser every design read uses —
 * and `storableContent` (src/lib/artifact-content.ts) stores what passes in
 * its canonical serialization. The check is read directly first, then through
 * the real handler with the write path (src/lib/artifact-writes.ts), Prisma
 * and the session stood in. The same promise runs against Postgres in
 * tests/artifact-ownership-lifecycle.integration.test.ts.
 *
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/artifact-design-save.test.ts
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { checkDesignDocumentSave } from "@/lib/design/document-save";
import { parseStoredDesignDocument, serializeDesignDocument } from "@/lib/design/migrations";
import { DESIGN_SCHEMA_VERSION } from "@/lib/design/types";
import { signInDocument } from "./design-fixtures";

const validBody = () => serializeDesignDocument(signInDocument());

/** The parts of a stored document's JSON these cases change. */
type RawDocument = { schemaVersion: number; nodes: Record<string, { x: unknown; width: unknown; children: string[] }> };

/** A valid document with one change made to its parsed JSON. */
function mutated(change: (doc: RawDocument) => void): string {
  const doc = JSON.parse(validBody()) as RawDocument;
  change(doc);
  return JSON.stringify(doc);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

test("a document the editor can open passes, however it is formatted", () => {
  const check = checkDesignDocumentSave(validBody());
  assert.equal(check.ok, true);
  assert.deepEqual(check.ok && check.document, parseStoredDesignDocument(validBody()), "the parsed document comes back");
  // What a native codec may write: its own key order and whitespace.
  assert.equal(checkDesignDocumentSave(JSON.stringify(JSON.parse(validBody()), null, 2)).ok, true);
});

test("text that is not JSON is refused with a reason", () => {
  const check = checkDesignDocumentSave("<svg>not a design</svg>");
  assert.equal(check.ok, false);
  assert.match(!check.ok ? check.error : "", /^This design can't be saved: .*not valid JSON/);
});

test("the compact authoring form is not a stored document", () => {
  const compact = JSON.stringify({ name: "Sign in", nodes: [{ type: "frame", name: "Screen", width: 375, height: 812 }] });
  const check = checkDesignDocumentSave(compact);
  assert.equal(check.ok, false);
  assert.match(!check.ok ? check.error : "", /no schemaVersion/);
});

test("a document from a newer schema is refused rather than stored half-understood", () => {
  const check = checkDesignDocumentSave(mutated((doc) => (doc.schemaVersion = DESIGN_SCHEMA_VERSION + 1)));
  assert.equal(check.ok, false);
  assert.match(!check.ok ? check.error : "", /newer version of Alevr/);
});

test("a field of the wrong shape and a broken hierarchy are refused with their issues", () => {
  const shape = checkDesignDocumentSave(mutated((doc) => (doc.nodes.screen.width = "wide")));
  assert.equal(shape.ok, false);
  assert.ok(!shape.ok && shape.issues.some((issue) => issue.startsWith("nodes.screen.width")), "the issue names the field");

  const orphan = checkDesignDocumentSave(mutated((doc) => doc.nodes.screen.children.push("ghost")));
  assert.equal(orphan.ok, false);
  assert.match(!orphan.ok ? orphan.error : "", /hierarchy is invalid/);
  assert.ok(!orphan.ok && orphan.issues.some((issue) => issue.includes("ghost")));
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

const OWNER = "user-owner";
type VersionRow = { version: number; content: string; origin: string | null; createdAt: Date };
type ArtifactRow = {
  id: string;
  userId: string;
  conversationId: string | null;
  messageId: string | null;
  identifier: string;
  title: string;
  type: string;
  language: string | null;
  currentVersion: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  versions: VersionRow[];
};

let row: ArtifactRow;
/** What reached the one write path, in order. */
const saved: Array<{ content: string; origin: string; baseVersion: number | null }> = [];

function seed(type: string, body: string) {
  const now = new Date("2026-09-30T10:00:00Z");
  row = {
    id: "art-1",
    userId: OWNER,
    conversationId: "c1",
    messageId: null,
    identifier: "screen",
    title: "Screen",
    type,
    language: null,
    currentVersion: 1,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    versions: [{ version: 1, content: body, origin: "generated", createdAt: now }],
  };
  saved.length = 0;
}

// Owned through the artifact's own owner (src/lib/artifact-access.ts), trash excluded.
const prisma = {
  artifact: {
    findFirst: async (args: { where: { id?: string; userId?: string; deletedAt?: unknown } }) =>
      args.where.id === row.id && args.where.userId === OWNER && args.where.deletedAt === null && !row.deletedAt
        ? { ...row, versions: [...row.versions], proposals: [] }
        : null,
  },
};

class ArtifactNotFoundError extends Error {}
class ArtifactVersionConflictError extends Error {}

/** The write path's contract: check the base, append a NEW version, never rewrite one. */
async function saveArtifactVersion(input: { artifactId: string; userId: string; content: string; origin: string; baseVersion?: number | null }) {
  if (input.artifactId !== row.id || input.userId !== OWNER) throw new ArtifactNotFoundError();
  if (input.baseVersion != null && input.baseVersion !== row.currentVersion) throw new ArtifactVersionConflictError();
  saved.push({ content: input.content, origin: input.origin, baseVersion: input.baseVersion ?? null });
  const next = row.currentVersion + 1;
  row.versions.push({ version: next, content: input.content, origin: input.origin, createdAt: new Date() });
  row.currentVersion = next;
  return next;
}

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so the route cases skip there rather than failing.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const routeTest = canMockModules ? test : test.skip;

if (canMockModules) {
  mock.module("@/lib/prisma", { namedExports: { prisma, prismaUnguarded: prisma } });
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => ({ id: OWNER, email: "owner@example.com" }) } });
  mock.module("@/lib/artifact-writes", {
    namedExports: { saveArtifactVersion, ArtifactNotFoundError, ArtifactVersionConflictError },
  });
  mock.module("@/lib/artifact-trash", { namedExports: { purgeTrashedArtifact: async () => ({ ok: false }), trashArtifact: async () => null } });
  mock.module("@/lib/artifact-rate-limit", { namedExports: { artifactWriteLimited: async () => null } });
}

async function save(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/artifacts/[id]/route");
  const res = await POST(
    new Request("http://juno.test/api/artifacts/art-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "art-1" }) }
  );
  return {
    status: res.status,
    body: (await res.json()) as { error?: string; code?: string; issues?: string[]; artifact?: { currentVersion: number } },
  };
}

routeTest("a design body that is not a document is refused with 422, names its issues, and stores nothing", async () => {
  seed("DESIGN", validBody());
  const res = await save({ content: '{"name":"Sign in","nodes":[]}', baseVersion: 1 });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "invalid_design");
  assert.match(res.body.error ?? "", /^This design can't be saved: /);
  assert.ok(Array.isArray(res.body.issues));
  assert.equal(saved.length, 0);
  assert.equal(row.currentVersion, 1);

  const broken = await save({ content: mutated((doc) => (doc.nodes.screen.width = "wide")), baseVersion: 1 });
  assert.equal(broken.status, 422);
  assert.ok(broken.body.issues?.some((issue) => issue.startsWith("nodes.screen.width")));
  assert.equal(saved.length, 0);
});

routeTest("a valid design saves as a new version, in the form every design read produces", async () => {
  seed("DESIGN", validBody());
  // What a native codec may write: its own key order and whitespace.
  const edited = JSON.stringify(JSON.parse(mutated((doc) => (doc.nodes.screen.x = 40))), null, 2);
  const res = await save({ content: edited, baseVersion: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.artifact?.currentVersion, 2);
  assert.equal(saved[0]?.content, serializeDesignDocument(parseStoredDesignDocument(edited)), "stored canonical, never as arbitrary text");
  assert.deepEqual(parseStoredDesignDocument(saved[0].content), parseStoredDesignDocument(edited), "the same document");

  // Restore goes through the same route with an older body.
  const restored = await save({ content: row.versions[0].content, baseVersion: 2, origin: "restore" });
  assert.equal(restored.status, 200);
  assert.equal(saved[1]?.origin, "restore");
  assert.equal(row.versions.length, 3, "a restore is a new version; nothing is rewritten");
});

routeTest("other artifact types are not held to the design check", async () => {
  seed("HTML", "<p>v1</p>");
  const res = await save({ content: "{not json and not a design", baseVersion: 1 });
  assert.equal(res.status, 200);
  assert.equal(saved[0]?.content, "{not json and not a design");
});
