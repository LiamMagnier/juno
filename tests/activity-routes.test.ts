import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActivityCountsHandler, createActivityListHandler, type ActivityDeps } from "@/lib/activity/handler";
import type { ActivityDb } from "@/lib/activity/store";
import {
  ACTIVITY_SETTLED_WINDOW_MS,
  classifyCode,
  classifyResearch,
  classifyWork,
  decodeCursor,
  encodeCursor,
  type ActivityItem,
  type ActivityPage,
} from "@/lib/activity/model";
import { WORK_STATUSES } from "@/lib/work/domain";

/*
 * THE ACTIVITY ROUTES (G70), driven for real against an in-memory database.
 *
 * The stand-in evaluates the Prisma `where` subset the store writes (equality,
 * in, lt/lte/gt/gte, AND/OR, one relation hop) and REFUSES any query whose
 * top level does not name a `userId`. So the ownership test is not "the source
 * mentions userId": a store that forgot the scope on any query would throw
 * here, and one that scoped to the wrong account would return the wrong rows.
 */

const NOW = new Date("2026-10-18T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      if (!(cond as Row[]).every((part) => matches(row, part))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(cond as Row[]).some((part) => matches(row, part))) return false;
      continue;
    }
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (typeof cond === "object" && !Array.isArray(cond)) {
      const ops = cond as Row;
      const isOps = Object.keys(ops).every((op) => ["in", "lt", "lte", "gt", "gte"].includes(op));
      if (!isOps) {
        // A relation hop: `run: { userId, sessionId: { in } }`.
        if (!matches(value as Row, ops)) return false;
        continue;
      }
      const cmp = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number | string));
      if ("in" in ops && !(ops.in as unknown[]).includes(value)) return false;
      if ("lt" in ops && !(cmp(value) < cmp(ops.lt))) return false;
      if ("lte" in ops && !(cmp(value) <= cmp(ops.lte))) return false;
      if ("gt" in ops && !(cmp(value) > cmp(ops.gt))) return false;
      if ("gte" in ops && !(cmp(value) >= cmp(ops.gte))) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function order(rows: Row[], orderBy: unknown): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const [field, dir] = Object.entries(key)[0];
      const av = a[field] instanceof Date ? (a[field] as Date).getTime() : (a[field] as string | number);
      const bv = b[field] instanceof Date ? (b[field] as Date).getTime() : (b[field] as string | number);
      if (av === bv) continue;
      const lt = av < bv ? -1 : 1;
      return dir === "desc" ? -lt : lt;
    }
    return 0;
  });
}

interface Queried {
  model: string;
  where: Row;
}

function table(model: string, rows: Row[], log: Queried[]) {
  const guard = (args: Row) => {
    const where = args.where as Row;
    if (!where || typeof where.userId !== "string") throw new Error(`${model} query without a userId scope`);
    log.push({ model, where });
    return where;
  };
  return {
    async findMany(args: Row) {
      const where = guard(args);
      const found = order(rows.filter((row) => matches(row, where)), args.orderBy);
      return typeof args.take === "number" ? found.slice(0, args.take) : found;
    },
    async groupBy(args: Row) {
      const where = guard(args);
      const by = args.by as string[];
      const groups = new Map<string, Row>();
      for (const row of rows.filter((r) => matches(r, where))) {
        const key = by.map((field) => String(row[field])).join("|");
        const group = groups.get(key) ?? { ...Object.fromEntries(by.map((field) => [field, row[field]])), _count: { _all: 0 } };
        (group._count as { _all: number })._all += 1;
        groups.set(key, group);
      }
      return [...groups.values()];
    },
  };
}

interface World {
  work: Row[];
  code: Row[];
  research: Row[];
  runs: Row[];
  approvals: Row[];
  agents?: Row[];
}

function db(world: World, log: Queried[] = []): ActivityDb {
  return {
    workSession: table("workSession", world.work, log),
    codeTask: table("codeTask", world.code, log),
    researchRun: table("researchRun", world.research, log),
    workRun: table("workRun", world.runs, log),
    workApproval: table("workApproval", world.approvals, log),
    agent: table("agent", world.agents ?? [], log),
  } as unknown as ActivityDb;
}

function work(id: string, userId: string, status: string, at: Date, extra: Row = {}): Row {
  return { id, userId, title: `Task ${id}`, status, needsAttention: false, conversationId: null, agentId: null, createdAt: ago(3 * HOUR), lastActivityAt: at, deletedAt: null, archived: false, ...extra };
}
function code(id: string, userId: string, status: string, at: Date, extra: Row = {}): Row {
  return { id, userId, title: `Code ${id}`, status, conversationId: `conv-${id}`, createdAt: ago(2 * HOUR), updatedAt: at, ...extra };
}
function research(id: string, userId: string, state: string, at: Date): Row {
  return { id, userId, goal: `Research ${id}`, state, conversationId: null, agentId: null, createdAt: ago(HOUR), startedAt: ago(50 * MIN), updatedAt: at };
}

const ME = "user-me";
const THEM = "user-them";
const asMe: ActivityDeps["authenticate"] = async () => ({ user: { id: ME } });
const signedOut: ActivityDeps["authenticate"] = async () => ({ user: null });

function sampleWorld(): World {
  return {
    work: [
      work("w-approve", ME, "waiting_approval", ago(1 * MIN), { needsAttention: true }),
      work("w-run", ME, "running", ago(2 * MIN), { conversationId: "chat-1" }),
      work("w-done", ME, "completed", ago(3 * HOUR)),
      work("w-old-done", ME, "completed", ago(ACTIVITY_SETTLED_WINDOW_MS + HOUR)),
      work("w-failed", ME, "failed", ago(4 * HOUR)),
      work("w-cancelled", ME, "cancelled", ago(5 * MIN)),
      work("w-draft", ME, "draft", ago(5 * MIN)),
      work("w-archived", ME, "running", ago(5 * MIN), { archived: true }),
      work("w-deleted", ME, "running", ago(5 * MIN), { deletedAt: ago(MIN) }),
      work("w-theirs", THEM, "waiting_approval", ago(30 * 1000), { needsAttention: true }),
    ],
    code: [
      code("c-approve", ME, "awaiting_approval", ago(6 * MIN)),
      code("c-queued", ME, "queued", ago(7 * MIN)),
      code("c-done", ME, "done", ago(8 * MIN)),
      code("c-failed-old", ME, "failed", ago(2 * ACTIVITY_SETTLED_WINDOW_MS)),
      code("c-theirs", THEM, "running", ago(MIN)),
    ],
    research: [
      research("r-plan", ME, "awaiting_plan_confirmation", ago(9 * MIN)),
      research("r-going", ME, "investigating", ago(10 * MIN)),
      research("r-theirs", THEM, "investigating", ago(MIN)),
    ],
    runs: [
      { id: "run-1", userId: ME, sessionId: "w-run", status: "running", attempt: 1 },
      { id: "run-theirs", userId: THEM, sessionId: "w-run", status: "running", attempt: 2 },
    ],
    approvals: [
      { userId: ME, decision: "pending", expiresAt: new Date(NOW.getTime() + 10 * MIN), createdAt: ago(MIN), summary: "Send the invoice to Sam?", run: { userId: ME, sessionId: "w-approve" } },
    ],
  };
}

async function list(world: World, query = "", authenticate = asMe, log: Queried[] = []) {
  const GET = createActivityListHandler({ authenticate, db: db(world, log), now: () => NOW });
  return GET(new Request(`https://alevr.test/api/activity${query}`));
}

test("signed out is a 401 and reads nothing", async () => {
  const log: Queried[] = [];
  const res = await list(sampleWorld(), "", signedOut, log);
  assert.equal(res.status, 401);
  assert.equal(log.length, 0);
  const counts = await createActivityCountsHandler({ authenticate: signedOut, db: db(sampleWorld(), log), now: () => NOW })();
  assert.equal(counts.status, 401);
  assert.equal(log.length, 0);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
});

test("lists only the caller's live items, each query scoped to them", async () => {
  const log: Queried[] = [];
  const res = await list(sampleWorld(), "", asMe, log);
  assert.equal(res.status, 200);
  const page = (await res.json()) as ActivityPage;
  const ids = page.items.map((item) => item.id);
  assert.deepEqual(ids, [
    "work:w-approve",
    "work:w-run",
    "code:c-approve",
    "code:c-queued",
    "code:c-done",
    "research:r-plan",
    "research:r-going",
    "work:w-done",
    "work:w-failed",
  ]);
  for (const id of ids) assert.ok(!id.includes("theirs"), `${id} belongs to another account`);
  // Every query named this account, and nothing else.
  assert.ok(log.length > 0);
  for (const q of log) assert.equal(q.where.userId, ME, `${q.model} scoped to ${String(q.where.userId)}`);
  // A constant number of queries for the page: 3 lists, 3 counts, 2 enrichments.
  assert.equal(log.length, 8);
});

test("rows say what they need, link to the existing surfaces, and carry stop", async () => {
  const page = (await (await list(sampleWorld())).json()) as ActivityPage;
  const byId = new Map(page.items.map((item) => [item.id, item]));
  const approve = byId.get("work:w-approve") as ActivityItem;
  assert.equal(approve.state, "needs_you");
  assert.equal(approve.need, "approval");
  assert.equal(approve.needSummary, "Send the invoice to Sam?");
  assert.equal(approve.href, "/work/w-approve");

  const running = byId.get("work:w-run") as ActivityItem;
  assert.equal(running.state, "running");
  // The caller's run, never the other account's newer attempt on the same id.
  assert.equal(running.runId, "run-1");
  assert.equal(running.canStop, true);

  assert.equal(byId.get("code:c-approve")?.href, "/code/conv-c-approve");
  assert.equal(byId.get("code:c-done")?.state, "ready");
  assert.equal(byId.get("code:c-done")?.canStop, false);
  assert.equal(byId.get("research:r-plan")?.need, "plan");
  assert.equal(byId.get("research:r-plan")?.href, "/research/r-plan");
  assert.equal(byId.get("work:w-failed")?.state, "blocked");
});

test("counts cover the whole account window, not just the page", async () => {
  const res = await list(sampleWorld(), "?limit=2");
  const page = (await res.json()) as ActivityPage;
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.counts, { needs_you: 3, running: 3, ready: 2, blocked: 1 });

  const counts = await createActivityCountsHandler({ authenticate: asMe, db: db(sampleWorld()), now: () => NOW })();
  assert.deepEqual(((await counts.json()) as { counts: unknown }).counts, page.counts);
});

test("keyset pages walk every item exactly once, including ties across kinds", async () => {
  const world = sampleWorld();
  // Three items changing at the very same millisecond, one per kind.
  const tie = ago(20 * MIN);
  world.work.push(work("w-tie", ME, "running", tie));
  world.code.push(code("c-tie", ME, "running", tie));
  world.research.push(research("r-tie", ME, "planning", tie));

  const all = ((await (await list(world, "?limit=100")).json()) as ActivityPage).items.map((item) => item.id);
  const walked: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i += 1) {
    const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
    const page = (await (await list(world, query)).json()) as ActivityPage;
    walked.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(walked, all);
  assert.equal(new Set(walked).size, walked.length);
});

test("bad input is a 400, never a silent default", async () => {
  for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?cursor=not!a!cursor", `?cursor=${btoa("[1,\"nope\",\"x\"]")}`]) {
    const res = await list(sampleWorld(), query);
    assert.equal(res.status, 400, query);
  }
});

test("a cursor round-trips and rejects foreign shapes", () => {
  const item = { updatedAt: NOW.toISOString(), kind: "code" as const, sourceId: "cl123" };
  assert.deepEqual(decodeCursor(encodeCursor(item)), { t: NOW.getTime(), kind: "code", id: "cl123" });
  assert.equal(decodeCursor(""), null);
  assert.equal(decodeCursor(btoa("{}")), null);
});

test("classification: every Work status lands in one state or is left out on purpose", () => {
  const leftOut = new Set(["draft", "cancelled"]);
  for (const status of WORK_STATUSES) {
    const classified = classifyWork(status, false);
    if (leftOut.has(status)) assert.equal(classified, null, status);
    else assert.ok(classified, status);
  }
  // The flag wins in any status.
  assert.equal(classifyWork("running", true)?.state, "needs_you");
  assert.equal(classifyWork("host_offline", false)?.need, "host");
  assert.equal(classifyCode("cancelled"), null);
  assert.equal(classifyCode("teleporting"), null);
  assert.equal(classifyResearch("awaiting_user_input")?.need, "question");
  assert.equal(classifyResearch("cancelled"), null);
});

test("the route files bind the real session and the guarded client", () => {
  for (const file of ["../src/app/api/activity/route.ts", "../src/app/api/activity/counts/route.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /authenticate: requireUser/);
    assert.match(source, /from "@\/lib\/prisma"/);
    assert.doesNotMatch(source, /prismaUnguarded/);
  }
});

test("a row an agent owns carries that agent's face in the item's state, from the caller's crew only", async () => {
  const world = sampleWorld();
  world.work.push(work("w-agent", ME, "waiting_input", ago(30 * 1000), { agentId: "agent-1", needsAttention: true }));
  world.research.push({ ...research("r-agent", ME, "investigating", ago(40 * 1000)), agentId: "agent-2" });
  world.agents = [
    { id: "agent-1", userId: ME, name: "Maren", avatar: { shape: "orb", tone: "teal", eyes: "round", mark: "ring" } },
    // Another account's agent under the id this account's run points at: never read.
    { id: "agent-2", userId: THEM, name: "Not yours", avatar: {} },
  ];
  const log: Queried[] = [];
  const page = (await (await list(world, "", asMe, log)).json()) as ActivityPage;
  const byId = new Map(page.items.map((i) => [i.id, i]));
  assert.deepEqual(byId.get("work:w-agent")?.agent, {
    id: "agent-1",
    name: "Maren",
    avatar: { shape: "orb", tone: "teal", eyes: "round", mark: "ring" },
    state: "waiting",
  });
  assert.equal(byId.get("research:r-agent")?.agent, null);
  assert.equal(byId.get("work:w-run")?.agent, null);
  // One agent read for the whole page, scoped to the caller.
  const agentQueries = log.filter((q) => q.model === "agent");
  assert.equal(agentQueries.length, 1);
  assert.equal(agentQueries[0].where.userId, ME);
});
