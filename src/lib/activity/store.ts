import {
  ACTIVITY_SETTLED_WINDOW_MS,
  CODE_OPEN_STATUSES,
  CODE_SETTLED_STATUSES,
  RESEARCH_OPEN_STATUSES,
  RESEARCH_SETTLED_STATUSES,
  WORK_OPEN_STATUSES,
  WORK_SETTLED_STATUSES,
  activityHref,
  activityTitle,
  afterCursor,
  canStop,
  classifyCode,
  classifyResearch,
  classifyWork,
  compareActivity,
  emptyCounts,
  encodeCursor,
  type ActivityCounts,
  type ActivityCursor,
  type ActivityItem,
  type ActivityKind,
  type ActivityPage,
  type Classified,
} from "@/lib/activity/model";

/*
 * THE ACTIVITY READ: a constant number of queries, whatever the page holds.
 *
 * Three list queries (one per source table, each a keyset page in the same
 * order), three group-bys for the counts, and two lookups that enrich the page
 * (the pending approval's sentence for Work tasks waiting on one, and the
 * executing run a stop addresses). Never a query per row.
 *
 * Every query is scoped by `userId` first, which is also the leading column of
 * the index each one walks:
 *   WorkSession  (userId, status, lastActivityAt) and (userId, needsAttention, lastActivityAt)
 *   CodeTask     (userId, status)
 *   ResearchRun  (userId, state, createdAt)
 *   WorkRun      unique (sessionId, attempt), filtered by userId
 *   WorkApproval (userId, decision, expiresAt)
 * The status filters are closed lists, so each source reads its open rows plus
 * the last day's settled ones, not the account's history.
 *
 * The database is passed in rather than imported. The route hands it the
 * ownership-guarded Prisma client; the tests hand it a stand-in that refuses
 * any query without the caller's `userId`, which is how "owner-scoped" is
 * checked rather than asserted.
 */

/* The narrow slice of Prisma this module calls. Args are Prisma-shaped objects. */
type Args = Record<string, unknown>;
interface Delegate<Row> {
  findMany(args: Args): Promise<Row[]>;
}
interface GroupDelegate<Row, Group> extends Delegate<Row> {
  groupBy(args: Args): Promise<Group[]>;
}

export interface WorkSessionRow {
  id: string;
  title: string;
  status: string;
  needsAttention: boolean;
  conversationId: string | null;
  createdAt: Date;
  lastActivityAt: Date;
}
export interface CodeTaskRow {
  id: string;
  title: string;
  status: string;
  conversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface ResearchRunRow {
  id: string;
  goal: string;
  state: string;
  conversationId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  updatedAt: Date;
}

export interface ActivityDb {
  workSession: GroupDelegate<WorkSessionRow, { status: string; needsAttention: boolean; _count: { _all: number } }>;
  codeTask: GroupDelegate<CodeTaskRow, { status: string; _count: { _all: number } }>;
  researchRun: GroupDelegate<ResearchRunRow, { state: string; _count: { _all: number } }>;
  workRun: Delegate<{ id: string; sessionId: string }>;
  workApproval: Delegate<{ summary: string; run: { sessionId: string } }>;
}

export interface ActivityQuery {
  userId: string;
  limit: number;
  cursor: ActivityCursor | null;
  now: Date;
}

/* ── where clauses ───────────────────────────────────────────────────────── */

function workScope(userId: string, since: Date): Args {
  return {
    userId,
    deletedAt: null,
    archived: false,
    OR: [
      { status: { in: [...WORK_OPEN_STATUSES] } },
      // The flag wins in any status (classifyWork), so it is asked for directly.
      { needsAttention: true },
      { status: { in: [...WORK_SETTLED_STATUSES] }, lastActivityAt: { gte: since } },
    ],
  };
}

function codeScope(userId: string, since: Date): Args {
  return {
    userId,
    OR: [
      { status: { in: [...CODE_OPEN_STATUSES] } },
      { status: { in: [...CODE_SETTLED_STATUSES] }, updatedAt: { gte: since } },
    ],
  };
}

function researchScope(userId: string, since: Date): Args {
  return {
    userId,
    OR: [
      { state: { in: [...RESEARCH_OPEN_STATUSES] } },
      { state: { in: [...RESEARCH_SETTLED_STATUSES] }, updatedAt: { gte: since } },
    ],
  };
}

/** The keyset clause for one source after the cursor, on that source's change column. */
function keyset(kind: ActivityKind, field: string, cursor: ActivityCursor | null): Args | null {
  if (!cursor) return null;
  const { before, atOrBefore, idBelow } = afterCursor(kind, cursor);
  if (atOrBefore) return { [field]: { lte: before } };
  if (idBelow) return { OR: [{ [field]: { lt: before } }, { [field]: before, id: { lt: idBelow } }] };
  return { [field]: { lt: before } };
}

/** The keyset clause joins under AND, so `userId` stays at the top level where the guard reads it. */
function withKeyset(scope: Args, clause: Args | null): Args {
  return clause ? { ...scope, AND: [clause] } : scope;
}

/* ── the read ────────────────────────────────────────────────────────────── */

interface Candidate {
  item: ActivityItem;
}

function make(
  kind: ActivityKind,
  row: { id: string; status: string; conversationId: string | null },
  classified: Classified,
  title: string,
  startedAt: Date,
  updatedAt: Date
): ActivityItem {
  return {
    id: `${kind}:${row.id}`,
    kind,
    sourceId: row.id,
    title,
    state: classified.state,
    need: classified.need,
    status: row.status,
    needSummary: null,
    startedAt: startedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    href: activityHref(kind, row.id, row.conversationId),
    conversationId: row.conversationId,
    runId: null,
    canStop: canStop(kind, row.status),
  };
}

export async function readActivityCounts(db: ActivityDb, userId: string, now: Date): Promise<ActivityCounts> {
  const since = new Date(now.getTime() - ACTIVITY_SETTLED_WINDOW_MS);
  const [work, code, research] = await Promise.all([
    db.workSession.groupBy({ by: ["status", "needsAttention"], where: workScope(userId, since), _count: { _all: true } }),
    db.codeTask.groupBy({ by: ["status"], where: codeScope(userId, since), _count: { _all: true } }),
    db.researchRun.groupBy({ by: ["state"], where: researchScope(userId, since), _count: { _all: true } }),
  ]);
  const counts = emptyCounts();
  for (const row of work) {
    const c = classifyWork(row.status, row.needsAttention);
    if (c) counts[c.state] += row._count._all;
  }
  for (const row of code) {
    const c = classifyCode(row.status);
    if (c) counts[c.state] += row._count._all;
  }
  for (const row of research) {
    const c = classifyResearch(row.state);
    if (c) counts[c.state] += row._count._all;
  }
  return counts;
}

export async function readActivityPage(db: ActivityDb, query: ActivityQuery): Promise<ActivityPage> {
  const { userId, limit, cursor, now } = query;
  const since = new Date(now.getTime() - ACTIVITY_SETTLED_WINDOW_MS);
  const take = limit + 1;

  const [workRows, codeRows, researchRows, counts] = await Promise.all([
    db.workSession.findMany({
      where: withKeyset(workScope(userId, since), keyset("work", "lastActivityAt", cursor)),
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take,
      select: { id: true, title: true, status: true, needsAttention: true, conversationId: true, createdAt: true, lastActivityAt: true },
    }),
    db.codeTask.findMany({
      where: withKeyset(codeScope(userId, since), keyset("code", "updatedAt", cursor)),
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take,
      select: { id: true, title: true, status: true, conversationId: true, createdAt: true, updatedAt: true },
    }),
    db.researchRun.findMany({
      where: withKeyset(researchScope(userId, since), keyset("research", "updatedAt", cursor)),
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take,
      select: { id: true, goal: true, state: true, conversationId: true, createdAt: true, startedAt: true, updatedAt: true },
    }),
    readActivityCounts(db, userId, now),
  ]);

  const candidates: Candidate[] = [];
  for (const row of workRows) {
    const c = classifyWork(row.status, row.needsAttention);
    if (c) candidates.push({ item: make("work", row, c, activityTitle(row.title, "Task"), row.createdAt, row.lastActivityAt) });
  }
  for (const row of codeRows) {
    const c = classifyCode(row.status);
    if (c) candidates.push({ item: make("code", row, c, activityTitle(row.title, "Code task"), row.createdAt, row.updatedAt) });
  }
  for (const row of researchRows) {
    const c = classifyResearch(row.state);
    const shaped = { id: row.id, status: row.state, conversationId: row.conversationId };
    if (c) candidates.push({ item: make("research", shaped, c, activityTitle(row.goal, "Research"), row.startedAt ?? row.createdAt, row.updatedAt) });
  }

  candidates.sort((a, b) => compareActivity(a.item, b.item));
  const hasMore = candidates.length > limit;
  const items = candidates.slice(0, limit).map((candidate) => candidate.item);

  await enrichWork(db, userId, items, now);

  return {
    items,
    counts,
    nextCursor: hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null,
  };
}

/**
 * Two lookups for the Work rows on the page, both by the page's own ids: what
 * the pending approval says (so the row reads "Send the invoice to Sam?"
 * rather than "Needs approval"), and which run is executing (the id the
 * existing stop control takes).
 */
async function enrichWork(db: ActivityDb, userId: string, items: ActivityItem[], now: Date): Promise<void> {
  const waiting = items.filter((item) => item.kind === "work" && item.need === "approval").map((item) => item.sourceId);
  const stoppable = items.filter((item) => item.kind === "work" && item.canStop).map((item) => item.sourceId);
  if (waiting.length === 0 && stoppable.length === 0) return;

  const [approvals, runs] = await Promise.all([
    waiting.length === 0
      ? Promise.resolve([])
      : db.workApproval.findMany({
          where: { userId, decision: "pending", expiresAt: { gt: now }, run: { userId, sessionId: { in: waiting } } },
          orderBy: { createdAt: "desc" },
          select: { summary: true, run: { select: { sessionId: true } } },
        }),
    stoppable.length === 0
      ? Promise.resolve([])
      : db.workRun.findMany({
          where: { userId, sessionId: { in: stoppable }, status: { in: ["queued", "preparing", "running"] } },
          orderBy: { attempt: "desc" },
          select: { id: true, sessionId: true },
        }),
  ]);

  const summaryBySession = new Map<string, string>();
  for (const approval of approvals) {
    // Newest first, so the first one seen per session is the one on screen.
    if (!summaryBySession.has(approval.run.sessionId)) summaryBySession.set(approval.run.sessionId, approval.summary);
  }
  const runBySession = new Map<string, string>();
  for (const run of runs) {
    if (!runBySession.has(run.sessionId)) runBySession.set(run.sessionId, run.id);
  }
  for (const item of items) {
    if (item.kind !== "work") continue;
    const summary = summaryBySession.get(item.sourceId);
    if (summary) item.needSummary = activityTitle(summary, "");
    const runId = runBySession.get(item.sourceId);
    if (runId) item.runId = runId;
    // A stop with no run to address would be a button that cannot work.
    if (item.canStop && !runId) item.canStop = false;
  }
}
