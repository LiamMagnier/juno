/**
 * `GET /api/artifacts` — the list behind the Artifacts home and a project's
 * Sources tab.
 *
 *  - `?projectId=` scopes the list to the project in the query itself (X-21),
 *    still inside the user's own conversations, so a project whose artifacts
 *    are older than the account's latest 200 is not read short. It scopes by
 *    EFFECTIVE project (R1): the chat's for an artifact in a chat, the
 *    artifact's own for one whose chat was deleted (it sits in the anchor).
 *  - A design's JSON never rides along as a tile preview: every surface draws
 *    a design from its poster (X-20).
 *  - Live rows only; `?deleted=1` is Recently deleted, trashed rows only, each
 *    with the date the purge may take it (R1 §3B).
 *  - An anchored artifact says so, and never names the anchor as its chat.
 *
 * Runs the real handler against stand-in Prisma and session modules. The
 * stand-in applies the two `where` clauses the route relies on (ownership and
 * `deletedAt`), so "hides trashed rows" is a statement about the rows that
 * come back, not only about the query.
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
  conversationId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  conversation: { title: string; kind: string; userId: string };
};

const when = new Date("2026-09-24T10:00:00Z");
const row = (id: string, type: string, extra: Partial<Row> = {}): Row => ({
  id,
  identifier: id,
  title: id,
  type,
  language: null,
  currentVersion: 2,
  conversationId: "c1",
  createdAt: when,
  updatedAt: when,
  deletedAt: null,
  conversation: { title: "Chat", kind: "chat", userId: "u1" },
  ...extra,
});

let rows: Row[] = [];
const queries: Array<{ where: Record<string, unknown>; orderBy: unknown }> = [];
const previewIds: string[][] = [];

const prisma = {
  artifact: {
    findMany: async (args: { where: Record<string, unknown>; orderBy: unknown }) => {
      queries.push({ where: args.where, orderBy: args.orderBy });
      const owner = (args.where.conversation as { userId: string }).userId;
      const deleted = args.where.deletedAt;
      return rows.filter(
        (r) =>
          r.conversation.userId === owner &&
          (deleted === null ? r.deletedAt === null : deleted && typeof deleted === "object" ? r.deletedAt !== null : true)
      );
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

type Item = {
  id: string;
  type: string;
  preview: string | null;
  anchored: boolean;
  conversationTitle: string | null;
  deletedAt?: string;
  purgeAt?: string;
};

async function list(query = "") {
  const { GET } = await import("@/app/api/artifacts/route");
  const res = await GET(new Request(`http://juno.test/api/artifacts${query}`));
  return { status: res.status, body: (await res.json()) as { items: Item[] } };
}

/** What `artifactProjectWhere("proj_1")` must be, spelled out so a change to it is seen here. */
const PROJECT_SCOPE = {
  OR: [
    { conversation: { projectId: "proj_1", kind: { not: "anchor" } } },
    { projectId: "proj_1", conversation: { kind: "anchor" } },
  ],
};

routeTest("the whole account's list is scoped to the user's conversations, live rows only", async () => {
  rows = [row("page", "HTML")];
  queries.length = 0;
  const { status } = await list();
  assert.equal(status, 200);
  assert.deepEqual(queries[0].where, { conversation: { userId: "u1" }, deletedAt: null });
  assert.deepEqual(queries[0].orderBy, { updatedAt: "desc" });
});

routeTest("?projectId= scopes the query to the project by effective project, still the user's own (X-21, R1)", async () => {
  rows = [row("page", "HTML")];
  queries.length = 0;
  await list("?projectId=proj_1");
  assert.deepEqual(queries[0].where, { conversation: { userId: "u1" }, deletedAt: null, AND: [PROJECT_SCOPE] });

  // An empty value is no scope, not a scope to nothing.
  queries.length = 0;
  await list("?projectId=");
  assert.deepEqual(queries[0].where, { conversation: { userId: "u1" }, deletedAt: null });
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

routeTest("the list hides trashed rows, and a live item carries no trash keys", async () => {
  rows = [row("kept", "HTML"), row("binned", "HTML", { deletedAt: new Date("2026-09-20T08:00:00Z") })];
  const { body } = await list();
  assert.deepEqual(body.items.map((item) => item.id), ["kept"]);
  assert.equal("deletedAt" in body.items[0], false, "a live payload is what it was before R1, plus `anchored`");
  assert.equal("purgeAt" in body.items[0], false);
});

routeTest("?deleted=1 lists Recently deleted, newest deletion first, each with its purge date", async () => {
  rows = [row("kept", "HTML"), row("binned", "MARKDOWN", { deletedAt: new Date("2026-09-20T08:00:00Z") })];
  queries.length = 0;
  const { status, body } = await list("?deleted=1");
  assert.equal(status, 200);
  assert.deepEqual(queries[0].where, { conversation: { userId: "u1" }, deletedAt: { not: null } });
  assert.deepEqual(queries[0].orderBy, [{ deletedAt: "desc" }, { id: "asc" }]);
  assert.deepEqual(
    body.items.map((item) => [item.id, item.deletedAt, item.purgeAt]),
    [["binned", "2026-09-20T08:00:00.000Z", "2026-10-20T08:00:00.000Z"]],
    "30 days after it was trashed"
  );
});

routeTest("an artifact whose chat was deleted is anchored and names no chat", async () => {
  rows = [
    row("in-chat", "HTML"),
    row("kept-from-deleted-chat", "HTML", {
      conversationId: "anchor_u1",
      conversation: { title: "Your artifacts", kind: "anchor", userId: "u1" },
    }),
  ];
  const { body } = await list();
  const byId = Object.fromEntries(body.items.map((item) => [item.id, item]));
  assert.equal(byId["in-chat"].anchored, false);
  assert.equal(byId["in-chat"].conversationTitle, "Chat");
  assert.equal(byId["kept-from-deleted-chat"].anchored, true);
  assert.equal(byId["kept-from-deleted-chat"].conversationTitle, null, "never \"Your artifacts\"");
});
