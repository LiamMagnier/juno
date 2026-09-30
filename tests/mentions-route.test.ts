/**
 * GET /api/mentions — the "@" palette of every composer.
 *
 * Runs the real handler against stand-in Prisma, session, rate-limit and
 * connector-registry modules. What it pins:
 *
 *  - every query names the signed-in account (directly, or through the
 *    conversation an artifact lives in), so no row of another account can be
 *    returned — the stand-in store holds two accounts and answers only what
 *    the where clause asks for;
 *  - results are ranked across kinds, capped per kind, and filtered by kind;
 *  - app rows carry needs-connection and the approval preview;
 *  - `ids=` does exact lookups, still owner-scoped;
 *  - the route is rate-limited and signed-in only.
 *
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/mentions-route.test.ts
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Where = Record<string, unknown>;
const when = (day: number) => new Date(Date.UTC(2026, 8, day));
const ME = "u1";
const OTHER = "u2";

// A tiny evaluator for the where shapes the search writes: equality,
// `{ in }`, `{ contains, mode }`, `{ startsWith }`, `{ not }`, OR, NOT, and a
// relation filter on `conversation`. Anything else fails loudly, so the test
// cannot pass by ignoring a clause.
function matches(row: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === "OR") return (condition as Where[]).some((branch) => matches(row, branch));
    if (key === "NOT") return !matches(row, condition as Where);
    const value = row[key];
    if (condition === null || typeof condition !== "object" || condition instanceof Date) return value === condition;
    const c = condition as Record<string, unknown>;
    if ("in" in c) return (c.in as unknown[]).includes(value);
    if ("contains" in c) return String(value ?? "").toLowerCase().includes(String(c.contains).toLowerCase());
    if ("startsWith" in c) return String(value ?? "").startsWith(String(c.startsWith));
    if ("not" in c) return c.not === null ? value !== null && value !== undefined : value !== c.not;
    if (key === "conversation") return matches(row.conversation as Record<string, unknown>, c);
    throw new Error(`the stand-in store does not understand ${key}: ${JSON.stringify(condition)}`);
  });
}

const tables: Record<string, Array<Record<string, unknown>>> = {
  agent: [
    { id: "cmira000000001", userId: ME, name: "Mira", role: "Revenue analyst", avatar: { shape: "orb", tone: "teal", eyes: "soft", mark: "none" }, status: "active", deletedAt: null, sortOrder: 0, createdAt: when(1), updatedAt: when(2) },
    { id: "cmiles00000001", userId: ME, name: "Miles", role: "", avatar: {}, status: "paused", deletedAt: null, sortOrder: 1, createdAt: when(1), updatedAt: when(3) },
    { id: "cmirror0000001", userId: OTHER, name: "Mirror", role: "", avatar: {}, status: "active", deletedAt: null, sortOrder: 0, createdAt: when(1), updatedAt: when(3) },
  ],
  attachment: [
    { id: "cfile000000001", userId: ME, fileName: "Mira interview.pdf", mimeType: "application/pdf", size: 1200, createdAt: when(5), deletedAt: null, libraryRemovedAt: null },
    { id: "cfile000000002", userId: ME, fileName: "Hidden mira.pdf", mimeType: "application/pdf", size: 1, createdAt: when(6), deletedAt: null, libraryRemovedAt: when(7) },
    { id: "cfile000000003", userId: OTHER, fileName: "Mira payroll.xlsx", mimeType: "text/csv", size: 1, createdAt: when(6), deletedAt: null, libraryRemovedAt: null },
  ],
  project: [
    { id: "cproj000000001", userId: ME, name: "Admiral launch", updatedAt: when(4) },
    { id: "cproj000000002", userId: OTHER, name: "Mira's secrets", updatedAt: when(9) },
  ],
  workSkill: [
    { id: "cskill00000001", userId: ME, slug: "mira-voice", name: "Write like Mira", description: "House tone", enabled: true, deletedAt: null, kind: "skill", updatedAt: when(2) },
    { id: "cskill00000002", userId: ME, slug: "mira-assistant", name: "Mira assistant", description: "", enabled: true, deletedAt: null, kind: "assistant", updatedAt: when(2) },
  ],
  conversation: [
    { id: "cchat000000001", userId: ME, kind: "chat", title: "Mira onboarding", lastMessageAt: when(8), archivedAt: null, projectId: null },
    { id: "cchat000000002", userId: ME, kind: "code", title: "Mira refactor", lastMessageAt: when(9), archivedAt: null, projectId: null },
    { id: "cchat000000003", userId: ME, kind: "chat", title: "Mira draft (current)", lastMessageAt: when(9), archivedAt: null, projectId: null },
    { id: "cchat000000004", userId: OTHER, kind: "chat", title: "Mira gossip", lastMessageAt: when(9), archivedAt: null, projectId: null },
  ],
  artifact: [
    { id: "cart0000000001", title: "Mira memo", type: "MARKDOWN", updatedAt: when(3), conversation: { userId: ME, title: "Mira onboarding" } },
    { id: "cart0000000002", title: "Mira leak", type: "HTML", updatedAt: when(9), conversation: { userId: OTHER, title: "Mira gossip" } },
  ],
  connection: [
    { userId: ME, provider: "github", accountLabel: "octocat", scope: null, createdAt: when(1) },
    { userId: ME, provider: "composio:slack", accountLabel: "Slack", scope: "composio:active", createdAt: when(2) },
    { userId: OTHER, provider: "figma", accountLabel: "theirs", scope: null, createdAt: when(1) },
  ],
  userMcpServer: [{ id: "cserver0000001", userId: OTHER, name: "Their server", enabled: true, url: "https://x", createdAt: when(1) }],
  settings: [{ userId: ME, actionApprovalPolicy: "ask_for_any_change", lockdownMode: false, blockedConnectors: [] }],
};

const wheres: Record<string, Where[]> = {};
function select(row: Record<string, unknown>, shape?: Record<string, unknown>): Record<string, unknown> {
  if (!shape) return row;
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) =>
      value && typeof value === "object" && "select" in (value as object)
        ? [key, select(row[key] as Record<string, unknown>, (value as { select: Record<string, unknown> }).select) as unknown]
        : [key, row[key]]
    )
  );
}
function table(name: string) {
  return {
    findMany: async (args: { where?: Where; take?: number; select?: Record<string, unknown> }) => {
      (wheres[name] ??= []).push(args.where ?? {});
      return tables[name]
        .filter((row) => matches(row, args.where))
        .slice(0, args.take ?? Infinity)
        .map((row) => select(row, args.select));
    },
    findUnique: async (args: { where: Where; select?: Record<string, unknown> }) => {
      (wheres[name] ??= []).push(args.where);
      const row = tables[name].find((candidate) => matches(candidate, args.where));
      return row ? select(row, args.select) : null;
    },
  };
}
const prisma = Object.fromEntries(Object.keys(tables).map((name) => [name, table(name)]));

let signedIn: { id: string; email: string } | null = { id: ME, email: "me@example.invalid" };
let allowed = true;
const rateKeys: string[] = [];

const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const routeTest = canMockModules ? test : test.skip;

if (canMockModules) {
  mock.module("@/lib/prisma", { namedExports: { prisma } });
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });
  mock.module("@/lib/rate-limit", {
    namedExports: {
      rateLimit: async (options: { key: string }) => {
        rateKeys.push(options.key);
        return { success: allowed, remaining: allowed ? 1 : 0, resetAt: new Date(Date.now() + 30_000) };
      },
    },
  });
}

// The real connector registry and env, with only the answers this test needs
// replaced: two configured apps, and Composio switched on. Inside a test
// because reading the real modules first needs an await, and the route is
// imported only after this has run.
routeTest("stand in for the connector registry", async () => {
  const registry = [
    { id: "github", kind: "oauth_app", label: "GitHub", description: "Repositories" },
    { id: "figma", kind: "oauth_app", label: "Figma", description: "Design files" },
  ];
  const connectors = await import("@/lib/connectors");
  mock.module("@/lib/connectors", {
    namedExports: {
      ...connectors,
      listConnectors: () => registry,
      getConnector: (id: string) => registry.find((def) => def.id === id),
      isConnectorConfigured: () => true,
    },
  });
  const env = await import("@/lib/env");
  mock.module("@/lib/env", { namedExports: { ...env, isComposioConfigured: () => true } });
});

async function get(query: string) {
  const { GET } = await import("@/app/api/mentions/route");
  const res = await GET(new Request(`http://juno.test/api/mentions${query}`));
  return { status: res.status, headers: res.headers, body: (await res.json()) as { items: Array<Record<string, unknown>>; error?: string } };
}

routeTest("every query names the signed-in account, so another account's rows never come back", async () => {
  for (const key of Object.keys(wheres)) delete wheres[key];
  const { status, body } = await get("?q=mir");
  assert.equal(status, 200);
  const ids = body.items.map((item) => item.id);
  for (const foreign of ["cmirror0000001", "cfile000000003", "cproj000000002", "cchat000000004", "cart0000000002"]) {
    assert.ok(!ids.includes(foreign), `${foreign} belongs to someone else`);
  }
  for (const [name, list] of Object.entries(wheres)) {
    for (const where of list) {
      const scoped = where.userId === ME || (where.conversation as Where | undefined)?.userId === ME;
      assert.ok(scoped, `${name} query ${JSON.stringify(where)} names the account`);
    }
  }
});

routeTest("a query ranks across kinds: exact and prefix names first, crew before files on a tie", async () => {
  const { body } = await get("?q=mira");
  const labels = body.items.map((item) => `${item.kind}:${item.label}`);
  assert.equal(labels[0], "crew:Mira", "the exact name");
  // Prefix matches, in palette kind order.
  assert.deepEqual(labels.slice(1, 4), ["file:Mira interview.pdf", "chat:Mira draft (current)", "chat:Mira onboarding"].slice(0, 3));
  assert.ok(!labels.includes("chat:Mira refactor"), "a Code session is not a chat to name");
  assert.ok(!labels.includes("file:Hidden mira.pdf"), "a file taken out of the Library is not offered");
  assert.ok(!labels.some((label) => label.startsWith("skill:Mira assistant")), "an assistant is not a skill");
  assert.ok(labels.includes("skill:Write like Mira"));
  assert.ok(labels.includes("artifact:Mira memo"));
});

routeTest("the chat being written in is left out, and kinds filter the result", async () => {
  const { body } = await get("?q=mira&kinds=chat&conversationId=cchat000000003");
  assert.deepEqual(body.items.map((item) => item.id), ["cchat000000001"]);
});

routeTest("rows carry what a client draws: icon keys, a crew face, a file's type", async () => {
  const { body } = await get("?q=mi&kinds=crew,file");
  const mira = body.items.find((item) => item.id === "cmira000000001")!;
  assert.equal(mira.icon, "crew");
  assert.deepEqual(mira.avatar, { shape: "orb", tone: "teal", eyes: "soft", mark: "none" });
  assert.equal(mira.subtitle, "Revenue analyst");
  const miles = body.items.find((item) => item.id === "cmiles00000001")!;
  assert.equal(miles.paused, true);
  const file = body.items.find((item) => item.kind === "file")!;
  assert.deepEqual([file.icon, file.subtitle], ["file:pdf", "PDF"]);
});

routeTest("app rows say whether they need connecting and what they will ask first", async () => {
  const { body } = await get("?kinds=app");
  const byId = new Map(body.items.map((item) => [item.id, item]));
  assert.deepEqual([...byId.keys()].sort(), ["composio:slack", "figma", "github"], "another account's server and connection are not listed");
  assert.equal(byId.get("github")!.connected, true);
  assert.equal(byId.get("figma")!.needsConnection, true, "connected by the other account only");
  assert.equal(byId.get("figma")!.connectHref, "/api/connectors/figma/connect");
  const approval = byId.get("composio:slack")!.approval as { sends: string; summary: string };
  assert.equal(approval.sends, "ask");
  assert.equal(approval.summary, "Sending, posting or changing anything in Slack will ask you first.");
});

routeTest("an empty query lists the most recent few of each kind, capped", async () => {
  const { body } = await get("?limit=1");
  const perKind = new Map<string, number>();
  for (const item of body.items) perKind.set(String(item.kind), (perKind.get(String(item.kind)) ?? 0) + 1);
  for (const count of perKind.values()) assert.equal(count, 1);
  assert.equal(body.items[0].kind, "crew", "palette order");
});

routeTest("ids= looks up exact tokens, still only the account's own", async () => {
  const { body } = await get("?ids=crew:cmira000000001,crew:cmirror0000001,app:figma,project:cproj000000002");
  assert.deepEqual(
    body.items.map((item) => item.id).sort(),
    ["cmira000000001", "figma"],
    "someone else's crew member and project are simply absent"
  );
});

routeTest("rate-limited per account; signed-out callers are refused; bad input is a 400", async () => {
  rateKeys.length = 0;
  allowed = false;
  const limited = await get("?q=m");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
  assert.deepEqual(rateKeys, [`mentions:${ME}`]);
  allowed = true;

  signedIn = null;
  assert.equal((await get("?q=m")).status, 401);
  signedIn = { id: ME, email: "me@example.invalid" };

  assert.equal((await get(`?q=${"x".repeat(101)}`)).status, 400);
  assert.equal((await get("?limit=50")).status, 400);
});

routeTest("a row's label is the token label the chat request accepts, however long or odd the name", async () => {
  const longName = `Zebra ${"quarterly board pack ".repeat(12)}\nfinal.pdf`;
  tables.attachment.push({
    id: "cfile000000009",
    userId: ME,
    fileName: longName,
    mimeType: "application/pdf",
    size: 1,
    createdAt: when(9),
    deletedAt: null,
    libraryRemovedAt: null,
  });
  try {
    const { body } = await get("?q=zebra&kinds=file");
    const [row] = body.items;
    assert.equal(row.id, "cfile000000009");
    const label = String(row.label);
    assert.ok(label.length <= 120, "bounded to a token label");
    assert.ok(!label.includes("\n"), "one line");
    const { mentionToToken } = await import("@/lib/mentions/types");
    const { chatBodySchema } = await import("@/lib/chat/request");
    const message = `Summarise ${label}`;
    const token = mentionToToken(row as never, { start: message.indexOf(label), end: message.indexOf(label) + label.length });
    assert.equal(chatBodySchema.safeParse({ message, context: [token] }).success, true, "inserting the row never refuses the send");
  } finally {
    tables.attachment.pop();
  }
});
