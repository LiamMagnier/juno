/**
 * `GET /api/artifacts` — the list behind the Artifacts home and a project's
 * Sources tab.
 *
 *  - The list is the user's own artifacts by the artifact's own owner
 *    (PRODUCT_REFOUNDATION §10): one whose chat was deleted, or that never had
 *    one, is listed like any other, and a trashed one is not (unless the
 *    Recently deleted view asks for them).
 *  - `?projectId=` scopes the list to the project in the query itself (X-21),
 *    still inside the user's own artifacts, so a project whose artifacts are
 *    older than the account's latest 200 is not read short.
 *  - A design's JSON never rides along as a tile preview: every surface draws
 *    a design from its poster (X-20).
 *
 * Runs the real handler against stand-in Prisma and session modules.
 *
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/artifacts-list-route.test.ts
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = {
  id: string;
  identifier: string;
  title: string;
  type: string;
  language: string | null;
  currentVersion: number;
  conversationId: string | null;
  projectId: string | null;
  derivedFromId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  conversation: { title: string; projectId: string | null } | null;
};

const when = new Date("2026-09-24T10:00:00Z");
const row = (id: string, type: string): Row => ({
  id,
  identifier: id,
  title: id,
  type,
  language: null,
  currentVersion: 2,
  conversationId: "c1",
  projectId: null,
  derivedFromId: null,
  deletedAt: null,
  createdAt: when,
  updatedAt: when,
  conversation: { title: "Chat", projectId: null },
});

let rows: Row[] = [];
const wheres: unknown[] = [];
const previewIds: string[][] = [];

const prisma = {
  artifact: {
    findMany: async (args: { where: unknown }) => {
      wheres.push(args.where);
      return rows;
    },
  },
  // Called as a tagged template; the ids arrive inside `Prisma.join`'s Sql.
  $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const joined = values.find((v): v is { values: unknown[] } => typeof v === "object" && v !== null && "values" in v);
    const ids = (joined?.values ?? []).map(String);
    previewIds.push(ids);
    return ids.map((artifactId) => ({ artifactId, preview: `head of ${artifactId}` }));
  },
};

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so the suite skips there rather than failing.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const routeTest = canMockModules ? test : test.skip;

if (canMockModules) {
  mock.module("@/lib/prisma", { namedExports: { prisma } });
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => ({ id: "u1", email: "a@example.com" }) } });
}

async function list(query = "") {
  const { GET } = await import("@/app/api/artifacts/route");
  const res = await GET(new Request(`http://juno.test/api/artifacts${query}`));
  return { status: res.status, body: (await res.json()) as { items: Array<{ id: string; type: string; preview: string | null }> } };
}

routeTest("the whole account's list is scoped to the user's own live artifacts", async () => {
  rows = [row("page", "HTML")];
  wheres.length = 0;
  const { status } = await list();
  assert.equal(status, 200);
  assert.deepEqual(wheres[0], { userId: "u1", deletedAt: null });
});

routeTest("?projectId= scopes the query to the project, still the user's own (X-21)", async () => {
  rows = [row("page", "HTML")];
  wheres.length = 0;
  await list("?projectId=proj_1");
  assert.deepEqual(wheres[0], {
    OR: [{ projectId: "proj_1" }, { projectId: null, conversation: { projectId: "proj_1" } }],
    userId: "u1",
    deletedAt: null,
  });

  // An empty value is no scope, not a scope to nothing.
  wheres.length = 0;
  await list("?projectId=");
  assert.deepEqual(wheres[0], { userId: "u1", deletedAt: null });
});

routeTest("an artifact with no chat is listed, with no chat title", async () => {
  rows = [{ ...row("design-1", "DESIGN"), conversationId: null, conversation: null, projectId: "proj_1" }];
  const { body } = await list();
  const item = body.items[0] as unknown as { conversationId: string | null; conversationTitle: string | null; projectId: string | null };
  assert.equal(item.conversationId, null);
  assert.equal(item.conversationTitle, null);
  assert.equal(item.projectId, "proj_1");
});

routeTest("?deleted=1 lists Recently deleted, each with the day it may be purged", async () => {
  const trashedAt = new Date("2026-09-20T10:00:00Z");
  rows = [{ ...row("old", "HTML"), deletedAt: trashedAt }];
  wheres.length = 0;
  const { body } = await list("?deleted=1");
  assert.deepEqual(wheres[0], { userId: "u1", deletedAt: { not: null } });
  const item = body.items[0] as unknown as { deletedAt: string; purgeAt: string };
  assert.equal(item.deletedAt, trashedAt.toISOString());
  assert.equal(item.purgeAt, "2026-10-20T10:00:00.000Z");
});

routeTest("a design is listed without its JSON as a preview (X-20)", async () => {
  rows = [row("page", "HTML"), row("screen", "DESIGN")];
  previewIds.length = 0;
  const { body } = await list();
  assert.deepEqual(previewIds[0], ["page"], "the preview query never reads a design's body");
  const byId = Object.fromEntries(body.items.map((item) => [item.id, item]));
  assert.equal(byId.page.preview, "head of page");
  assert.equal(byId.screen.preview, null);
  assert.equal(byId.screen.type, "DESIGN");
});

routeTest("an account of nothing but designs runs no preview query at all", async () => {
  rows = [row("screen", "DESIGN")];
  previewIds.length = 0;
  const { body } = await list();
  assert.equal(previewIds.length, 0);
  assert.equal(body.items[0].preview, null);
});
