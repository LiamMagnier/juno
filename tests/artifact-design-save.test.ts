/**
 * The generic artifact save validates a design body (audit
 * docs/rework/audit/artifacts.md, B2; Rec 5).
 *
 * `POST /api/artifacts/[id]` is how restore and the Mac and iPhone Save write
 * a whole design, and it used to store any text for one. A body the editor
 * cannot parse then opened as "This design can't be opened" everywhere. The
 * check is `checkDesignDocumentSave` (src/lib/design/document-save.ts), which
 * applies `parseStoredDesignDocument` — the parser every design read uses — so
 * it is checked directly first, then through the real handler against
 * stand-in Prisma and session modules.
 *
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/artifact-design-save.test.ts
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { checkDesignDocumentSave } from "@/lib/design/document-save";
import { serializeDesignDocument } from "@/lib/design/migrations";
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
  assert.deepEqual(checkDesignDocumentSave(validBody()), { ok: true });
  // What a native codec may write: its own key order and whitespace.
  assert.deepEqual(checkDesignDocumentSave(JSON.stringify(JSON.parse(validBody()), null, 2)), { ok: true });
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
  assert.match(!check.ok ? check.error : "", /newer version of Juno/);
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
type VersionRow = { id: string; artifactId: string; version: number; content: string; origin: string | null; createdAt: Date };
type ArtifactRow = {
  id: string;
  conversationId: string;
  messageId: string | null;
  identifier: string;
  title: string;
  type: string;
  language: string | null;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
  versions: VersionRow[];
};

let row: ArtifactRow;
const created: VersionRow[] = [];

function seed(type: string, body: string) {
  const now = new Date("2026-09-30T10:00:00Z");
  row = {
    id: "art-1",
    conversationId: "c1",
    messageId: null,
    identifier: "screen",
    title: "Screen",
    type,
    language: null,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
    versions: [{ id: "v1", artifactId: "art-1", version: 1, content: body, origin: "generated", createdAt: now }],
  };
  created.length = 0;
}

const prisma = {
  artifact: {
    findFirst: async (args: { where: { id: string; conversation?: { userId?: string } } }) =>
      args.where.id === row.id && args.where.conversation?.userId === OWNER ? { ...row, versions: [...row.versions] } : null,
    update: async (args: { data: { currentVersion: number } }) => {
      row.currentVersion = args.data.currentVersion;
      return { ...row, versions: [...row.versions] };
    },
  },
  artifactVersion: {
    create: async (args: { data: { artifactId: string; version: number; content: string; origin: string } }) => {
      const version = { id: `v${args.data.version}`, ...args.data, createdAt: new Date() };
      created.push(version);
      row.versions.push(version);
      return version;
    },
  },
  $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
};

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so the route cases skip there rather than failing.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const routeTest = canMockModules ? test : test.skip;

if (canMockModules) {
  mock.module("@/lib/prisma", { namedExports: { prisma } });
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => ({ id: OWNER, email: "owner@example.com" }) } });
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
  return { status: res.status, body: (await res.json()) as { error?: string; issues?: string[]; artifact?: { currentVersion: number } } };
}

routeTest("a design body that is not a document is refused with 400 and stores nothing", async () => {
  seed("DESIGN", validBody());
  const res = await save({ content: '{"name":"Sign in","nodes":[]}', baseVersion: 1 });
  assert.equal(res.status, 400);
  assert.match(res.body.error ?? "", /^This design can't be saved: /);
  assert.ok(Array.isArray(res.body.issues));
  assert.equal(created.length, 0);
  assert.equal(row.currentVersion, 1);

  const broken = await save({ content: mutated((doc) => (doc.nodes.screen.width = "wide")), baseVersion: 1 });
  assert.equal(broken.status, 400);
  assert.ok(broken.body.issues?.some((issue) => issue.startsWith("nodes.screen.width")));
  assert.equal(created.length, 0);
});

routeTest("a valid design saves exactly as before, byte for byte", async () => {
  seed("DESIGN", validBody());
  const edited = JSON.stringify(JSON.parse(mutated((doc) => (doc.nodes.screen.x = 40))), null, 2);
  const res = await save({ content: edited, baseVersion: 1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.artifact?.currentVersion, 2);
  assert.equal(created[0]?.content, edited, "stored as sent, not re-serialized");

  // Restore goes through the same route with an older body.
  const restored = await save({ content: row.versions[0].content, baseVersion: 2, origin: "restore" });
  assert.equal(restored.status, 200);
  assert.equal(created[1]?.origin, "restore");
});

routeTest("other artifact types are not held to the design check", async () => {
  seed("HTML", "<p>v1</p>");
  const res = await save({ content: "{not json and not a design", baseVersion: 1 });
  assert.equal(res.status, 200);
  assert.equal(created[0]?.content, "{not json and not a design");
});
