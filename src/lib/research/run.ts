import "server-only";
import { recordSpend } from "@/lib/spend";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  createResearchEngine,
  type ResearchDeps,
  type ResearchEngine,
  type ResearchRunRow,
  type ResearchStore,
} from "@/lib/research/engine";
import {
  MAX_PLAN_QUERIES,
  isResearchEventKind,
  isResearchState,
  isTerminalResearchState,
  parsePlan,
  planIsConfirmed,
  stageForState,
  type ResearchEventDTO,
  type ResearchEventKind,
  type ResearchState,
} from "@/lib/research/domain";
import { fetchResearchPage, planResearchQueries, searchTheWeb, writeResearchReport } from "@/lib/research/tools";

/**
 * The durable research job, wired to Postgres and to the real search backend.
 *
 * The state machine itself is `@/lib/research/engine` and knows nothing about
 * either; this module is the only place that names Prisma, Tavily or a model.
 * The split is what lets `tests/research-run.test.ts` exercise every transition
 * — including a cancel landing between two searches, and a budget that runs out
 * mid-run — with no database and no network, which is where those bugs are.
 *
 * `server-only` lives here rather than on the engine because the package throws
 * the moment a plain Node process imports it, and the tests are plain Node.
 */

// ---------------------------------------------------------------------------
// The Prisma store
// ---------------------------------------------------------------------------

interface PrismaResearchRun {
  id: string;
  userId: string;
  conversationId: string | null;
  goal: string;
  state: string;
  plan: unknown;
  queries: string[];
  costMicroUsd: bigint;
  budgetMicroUsd: bigint | null;
  error: string | null;
  report: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

function toRunRow(row: PrismaResearchRun): ResearchRunRow {
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    goal: row.goal,
    state: row.state,
    plan: row.plan,
    queries: row.queries,
    costMicroUsd: row.costMicroUsd,
    budgetMicroUsd: row.budgetMicroUsd,
    error: row.error,
    report: row.report,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

const TERMINAL_PATCH = (to: ResearchState) =>
  isTerminalResearchState(to) ? { finishedAt: new Date() } : {};

export function createPrismaResearchStore(): ResearchStore {
  return {
    async createRun({ userId, goal, conversationId, budgetMicroUsd, plan }) {
      const created = await prisma.researchRun.create({
        data: {
          userId,
          conversationId,
          goal,
          state: "accepted",
          plan: { ...plan } as unknown as object,
          budgetMicroUsd,
          startedAt: new Date(),
        },
      });
      return toRunRow(created);
    },

    async loadRun(runId, userId) {
      const row = await prisma.researchRun.findFirst({ where: { id: runId, userId } });
      return row ? toRunRow(row) : null;
    },

    async moveState({ runId, userId, from, to, patch }) {
      // `updateMany` rather than `update`, because the state condition has to be
      // re-evaluated by Postgres against the committed row. Exactly one caller
      // sees a count of 1; everybody else gets 0 and knows they lost.
      const moved = await prisma.researchRun.updateMany({
        where: { id: runId, userId, state: { in: [...from] } },
        data: {
          state: to,
          ...TERMINAL_PATCH(to),
          ...(patch?.plan ? { plan: { ...patch.plan } as unknown as object } : {}),
          ...(patch && "error" in patch ? { error: patch.error ?? null } : {}),
          ...(patch && "report" in patch && patch.report !== undefined
            ? { report: patch.report }
            : {}),
        },
      });
      if (moved.count === 0) return null;
      const row = await prisma.researchRun.findFirst({ where: { id: runId, userId } });
      return row ? toRunRow(row) : null;
    },

    async savePlan({ runId, userId, plan }) {
      const saved = await prisma.researchRun.updateMany({
        where: { id: runId, userId },
        data: { plan: { ...plan } as unknown as object },
      });
      if (saved.count === 0) return null;
      const row = await prisma.researchRun.findFirst({ where: { id: runId, userId } });
      return row ? toRunRow(row) : null;
    },

    async recordQueries({ runId, userId, queries }) {
      await prisma.researchRun.updateMany({
        where: { id: runId, userId },
        data: { queries: queries.slice(0, MAX_PLAN_QUERIES) },
      });
    },

    /**
     * Appends events, allocating `seq` so the sequence is monotonic and has no
     * holes.
     *
     * `ResearchRun` has no `lastSeq` counter — the schema is landed and shared —
     * so the allocation is `max(seq) + 1` read inside the transaction. Two
     * things make that safe. The `update` above it takes the run's row lock, so
     * a second appender waits and then reads a maximum that already includes
     * this batch; and `@@unique([runId, seq])` is the backstop for the case the
     * lock cannot cover — a deployment mid-rollout, a connection pool reset —
     * where the loser retries and reads the new maximum.
     *
     * A hole matters more here than a duplicate. The client's cursor cannot tell
     * a hole from an event that has not arrived yet, so it waits for one that is
     * never coming and the panel stops updating for the rest of the run.
     */
    async appendEvents({ runId, userId, events }) {
      if (events.length === 0) {
        const top = await prisma.researchEvent.aggregate({
          where: { runId, userId },
          _max: { seq: true },
        });
        return { lastSeq: top._max.seq ?? 0, appended: [] };
      }
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          return await prisma.$transaction(async (tx) => {
            await tx.researchRun.update({
              where: { id: runId, userId },
              data: { updatedAt: new Date() },
              select: { id: true },
            });
            const top = await tx.researchEvent.aggregate({
              where: { runId, userId },
              _max: { seq: true },
            });
            const firstSeq = (top._max.seq ?? 0) + 1;
            const rows = events.map((event, index) => ({
              runId,
              userId,
              seq: firstSeq + index,
              kind: event.kind,
              payload: (event.payload ?? {}) as object,
            }));
            await tx.researchEvent.createMany({ data: rows });
            return {
              lastSeq: firstSeq + events.length - 1,
              appended: rows.map((row) => ({ seq: row.seq, kind: row.kind as ResearchEventKind })),
            };
          });
        } catch (e) {
          lastError = e;
        }
      }
      // Losing an event is not worth failing the step over: the run's state is
      // the source of truth and the transcript is a narration of it. Say so
      // loudly, then carry on.
      console.error("[research] event append failed", { runId, error: lastError });
      const top = await prisma.researchEvent.aggregate({
        where: { runId, userId },
        _max: { seq: true },
      });
      return { lastSeq: top._max.seq ?? 0, appended: [] };
    },

    async readEvents({ runId, userId, after, limit }) {
      return prisma.researchEvent.findMany({
        where: { runId, userId, seq: { gt: after } },
        orderBy: { seq: "asc" },
        take: limit,
        select: { id: true, seq: true, kind: true, payload: true, createdAt: true },
      });
    },

    async progress(runId, userId) {
      const [run, sourceCount, readCount, passageCount] = await Promise.all([
        prisma.researchRun.findFirst({
          where: { id: runId, userId },
          select: { plan: true, queries: true, report: true },
        }),
        prisma.researchSource.count({ where: { runId, userId } }),
        prisma.researchSource.count({ where: { runId, userId, snapshot: { not: null } } }),
        prisma.researchPassage.count({ where: { userId, source: { runId } } }),
      ]);
      return {
        planConfirmed: planIsConfirmed(parsePlan(run?.plan)),
        queryCount: run?.queries.length ?? 0,
        sourceCount,
        readCount,
        passageCount,
        hasReport: !!run?.report,
      };
    },

    async upsertSource({ runId, userId, url, title, contentHash, snapshot, authority }) {
      // No unique index on (runId, url) to upsert against, so this is a read
      // then a write. The race it leaves is two rows for one URL, which costs a
      // duplicate line in the sources list — acceptable, and far cheaper than
      // adding an index to a landed schema.
      const existing = await prisma.researchSource.findFirst({
        where: { runId, userId, url },
        select: { id: true },
      });
      if (existing) {
        await prisma.researchSource.updateMany({
          where: { id: existing.id, userId },
          data: {
            title: title.slice(0, 500),
            ...(contentHash !== undefined ? { contentHash } : {}),
            ...(snapshot !== undefined ? { snapshot } : {}),
            ...(authority !== undefined ? { authority } : {}),
          },
        });
        return { id: existing.id, created: false };
      }
      const created = await prisma.researchSource.create({
        data: {
          runId,
          userId,
          url,
          title: (title || url).slice(0, 500),
          contentHash: contentHash ?? null,
          snapshot: snapshot ?? null,
          authority: authority ?? null,
        },
        select: { id: true },
      });
      return { id: created.id, created: true };
    },

    async savePassages({ userId, sourceId, passages }) {
      if (passages.length === 0) return 0;
      // Replace rather than append: a re-read of the same source after steering
      // must not leave the old snapshot's passages behind, still linked to
      // claims, still citable, and no longer matching the stored text.
      await prisma.researchPassage.deleteMany({ where: { sourceId, userId } });
      const created = await prisma.researchPassage.createMany({
        data: passages.map((passage) => ({
          userId,
          sourceId,
          text: passage.text,
          locator: passage.locator ?? null,
          ordinal: passage.ordinal,
        })),
      });
      return created.count;
    },

    async listSources(runId, userId) {
      return prisma.researchSource.findMany({
        where: { runId, userId },
        orderBy: { fetchedAt: "asc" },
        select: {
          id: true,
          url: true,
          title: true,
          contentHash: true,
          snapshot: true,
          publishedAt: true,
          authority: true,
          fetchedAt: true,
        },
      });
    },

    async addSpend({ runId, userId, microUsd, kind }) {
      const updated = await prisma.researchRun.updateMany({
        where: { id: runId, userId },
        data: { costMicroUsd: { increment: BigInt(microUsd) } },
      });
      if (updated.count === 0) return BigInt(0);

      /*
       * The run row is the run's own odometer; the ledger is what the monthly
       * ceiling reads. Incrementing only the former is how Work spent for
       * months without moving a single account's budget, and search fees were
       * about to repeat it: the planner and the report call recordSpend
       * themselves, but a search vendor fee has no model behind it and so had
       * no writer.
       *
       * `kind: "research"` rather than "chat" so a research turn is separable
       * in the ledger. Fire-and-forget like every other recordSpend — a ledger
       * outage must not fail a run that has already paid the vendor.
       */
      if (kind === "search" && microUsd > 0) {
        await recordSpend({
          userId,
          model: "tavily-search",
          kind: "research",
          source: "web",
          costUsd: microUsd / 1_000_000,
        }).catch(() => {});
      }
      const row = await prisma.researchRun.findFirst({
        where: { id: runId, userId },
        select: { costMicroUsd: true },
      });
      return row?.costMicroUsd ?? BigInt(0);
    },
  };
}

// ---------------------------------------------------------------------------
// The production engine
// ---------------------------------------------------------------------------

/**
 * SHA-256 of the fetched text, truncated.
 *
 * The point of the column is that a report stays auditable after the page it
 * cites has changed: two runs that hashed the same bytes agree, and a source
 * whose live page no longer matches its snapshot is visibly a different
 * document. Truncated because it is an equality check between rows in one run,
 * not a signature, and a shorter string keeps the duplicate-detection query in
 * `resolving_conflicts` cheap.
 */
function hashSnapshot(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

let engine: ResearchEngine | null = null;

/**
 * The one engine the app uses. Memoised because the deps are stateless and
 * building a new closure per request would make the module-level store a lie.
 */
export function researchEngine(): ResearchEngine {
  if (engine) return engine;
  const deps: ResearchDeps = {
    store: createPrismaResearchStore(),
    plan: planResearchQueries,
    search: searchTheWeb,
    fetchPage: fetchResearchPage,
    synthesize: writeResearchReport,
    hash: hashSnapshot,
    now: () => new Date(),
  };
  engine = createResearchEngine(deps);
  return engine;
}

/**
 * The engine with no writer attached.
 *
 * The chat route streams the report through the user's OWN selected model,
 * on the same delta path as any other turn, so the job must stop once the
 * corpus is assembled and hand it over rather than write a second report
 * nobody reads. `drive({ until: "synthesizing" })` is the other half of this.
 */
export function gatheringOnlyEngine(): ResearchEngine {
  return createResearchEngine({
    store: createPrismaResearchStore(),
    plan: planResearchQueries,
    search: searchTheWeb,
    fetchPage: fetchResearchPage,
    hash: hashSnapshot,
    now: () => new Date(),
  });
}

// ---------------------------------------------------------------------------
// What the API routes read
// ---------------------------------------------------------------------------

export interface ResearchRunView {
  id: string;
  conversationId: string | null;
  goal: string;
  state: string;
  stage: string;
  plan: { queries: string[]; constraints: string[]; pinnedSources: string[]; confirmed: boolean };
  /** Serialised as strings: BigInt does not survive JSON.stringify. */
  costMicroUsd: string;
  budgetMicroUsd: string | null;
  error: string | null;
  report: string | null;
  live: boolean;
  createdAt: string;
  finishedAt: string | null;
  sources: Array<{
    id: string;
    url: string;
    title: string;
    read: boolean;
    contentHash: string | null;
    fetchedAt: string;
  }>;
}

/**
 * A run and everything since a cursor, in one round trip.
 *
 * One query rather than two endpoints because the state and the events have to
 * agree: a client that reads events at t and state at t+1 renders a finished
 * run that is still showing a live stage, which is the exact confusion the
 * stage list exists to remove. `lastSeq` is what the caller sends back as
 * `after` next time.
 */
export async function readResearchRun(input: {
  runId: string;
  userId: string;
  after?: number;
  limit?: number;
}): Promise<{ run: ResearchRunView; events: ResearchEventDTO[]; lastSeq: number } | null> {
  const store = createPrismaResearchStore();
  const run = await store.loadRun(input.runId, input.userId);
  if (!run) return null;
  const [events, sources] = await Promise.all([
    store.readEvents({
      runId: run.id,
      userId: run.userId,
      after: Math.max(0, input.after ?? 0),
      limit: Math.min(500, Math.max(1, input.limit ?? 200)),
    }),
    store.listSources(run.id, run.userId),
  ]);
  const plan = parsePlan(run.plan);
  const state = isResearchState(run.state) ? run.state : "failed";
  return {
    run: {
      id: run.id,
      conversationId: run.conversationId,
      goal: run.goal,
      state,
      stage: stageForState(state),
      plan: {
        queries: plan.queries,
        constraints: plan.constraints,
        pinnedSources: plan.pinnedSources,
        confirmed: planIsConfirmed(plan),
      },
      costMicroUsd: run.costMicroUsd.toString(),
      budgetMicroUsd: run.budgetMicroUsd === null ? null : run.budgetMicroUsd.toString(),
      error: run.error,
      report: run.report,
      live: !isTerminalResearchState(state),
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      sources: sources.map((source) => ({
        id: source.id,
        url: source.url,
        title: source.title,
        read: !!source.snapshot,
        contentHash: source.contentHash,
        fetchedAt: source.fetchedAt.toISOString(),
      })),
    },
    events: events.map((event) => ({
      id: event.id,
      seq: event.seq,
      kind: (isResearchEventKind(event.kind) ? event.kind : "error") as ResearchEventKind,
      payload:
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {},
      createdAt: event.createdAt.toISOString(),
    })),
    lastSeq: events.length > 0 ? events[events.length - 1].seq : Math.max(0, input.after ?? 0),
  };
}

/**
 * Drives a run to completion in the background, and never throws at its caller.
 *
 * A route that awaited this would be back to the in-request pipeline this slice
 * removed — the whole point is that the row survives the request. The run's
 * state is durable at every step, so a process killed mid-drive leaves a run
 * that the next Resume (or the next call to this function) picks up exactly
 * where the persisted rows say it got to.
 */
export function driveResearchInBackground(input: {
  runId: string;
  userId: string;
  engine?: ResearchEngine;
}): void {
  const driver = input.engine ?? researchEngine();
  void driver
    .drive({ runId: input.runId, userId: input.userId })
    .catch((e: unknown) => {
      console.error("[research] background drive failed", { runId: input.runId, error: e });
    });
}
