import "server-only";
import { privateSourceOptionsFor, searchPrivateSources } from "@/lib/research/private-retrieval";
import type { PrivateSourceOption } from "@/lib/research/private-sources";
import { Prisma } from "@prisma/client";
import { recordSpend } from "@/lib/spend";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getModelMetrics } from "@/lib/model-metrics";
import type { ModelInfo } from "@/lib/models";
import {
  createResearchEngine,
  type ResearchDeps,
  type ResearchEngine,
  type ResearchRunRow,
  type ResearchStore,
} from "@/lib/research/engine";
import {
  MAX_PLAN_QUERIES,
  PLANNER_OUTPUT_TOKENS,
  PLANNER_PROMPT_CHARS,
  SYSTEM_PROMPT_CHARS,
  modelCallEstimateMicroUsd,
  RESEARCH_TERMINAL_STATES,
  RESEARCH_WORKER_LEASE_MS,
  RESEARCH_WORKING_STATES,
  isResearchEventKind,
  isResearchState,
  isTerminalResearchState,
  parsePlan,
  planIsConfirmed,
  stageForState,
  transitionAllowed,
  type ResearchEventDTO,
  type ResearchEventKind,
  type ResearchConflict,
  type ResearchCoverageEntry,
  type ResearchClarification,
  type ResearchEffort,
  type ResearchModelRates,
  type ResearchObjective,
  type ResearchState,
  type ResearchTerminalState,
} from "@/lib/research/domain";
import {
  assistResearchAudit,
  draftResearchPlanWithModel,
  expandResearchQueries,
  fetchResearchPage,
  clarifyResearchGoal,
  planResearchQueries,
  researchModelCompletion,
  searchTheWeb,
  writeResearchReport,
} from "@/lib/research/tools";
import { recordCitationAudit } from "@/lib/research/claims";
import {
  configuredResearchModel,
  researchLeadModel,
  researchRunModels,
  researchWorkerModel,
  runResearchWorker,
} from "@/lib/research/agents/worker";
import { reviewResearchRound } from "@/lib/research/agents/lead";
import { canonicalUrl } from "@/lib/search/url-safety";
import { searchProviderStatus } from "@/lib/search/search-engine";
import { getUserPlan } from "@/lib/usage";
import { checkBudget, checkUsageWindows, eurPerUsd } from "@/lib/spend";
import { MODEL_LIST } from "@/lib/models";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import {
  RESEARCH_PLAN_CAPS,
  researchBudgetFor,
  targetClaimsFor,
  type ResearchBudgetRefusal,
  type ResearchEnvelope,
} from "@/lib/research/envelope";
import { researchRoster } from "@/lib/research/search-metering";
import { parseWorkspaceConfig, type WorkspaceConfig } from "@/lib/projects/workspace-config";
import { buildCompletionWrite } from "@/lib/research/completion-core";
import { finalizeResearchRun } from "@/lib/research/completion";
import { researchWebOwner } from "@/lib/research/lease-core";
import { researchGoalContext, type ContextTurn } from "@/lib/research/planner";
import { citationOrder } from "@/lib/research/report-structure";
import {
  PHASE_EVENT_KINDS,
  RECENTLY_FINISHED_MS,
  clarificationViews,
  countsOf,
  dtoEffort,
  estimateOf,
  emergingAnswersOf,
  latestFindingsOf,
  pagesReadOf,
  phaseDetailFor,
  questionViews,
  researchPhaseFor,
  revisingOf,
  runModelsOf,
  runTitleOf,
  summaryOf,
  workingMsOf,
  activeWorkingMs,
  type LatestPhaseEvent,
} from "@/lib/research/view";
import type { ResearchPlan } from "@/lib/research/domain";
import type { ResearchRunSummary, ResearchRunViewAdditions, ResearchScope } from "@/types/research";

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
  reportRevision?: number;
  workerLeaseOwner?: string | null;
  workerLeaseUntil?: Date | null;
  lastHeartbeatAt?: Date | null;
  assistantMessageId?: string | null;
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
    reportRevision: row.reportRevision,
    workerLeaseOwner: row.workerLeaseOwner,
    workerLeaseUntil: row.workerLeaseUntil,
    lastHeartbeatAt: row.lastHeartbeatAt,
    assistantMessageId: row.assistantMessageId ?? null,
  };
}

const TERMINAL_PATCH = (to: ResearchState) =>
  isTerminalResearchState(to)
    ? { finishedAt: new Date(), workerLeaseOwner: null, workerLeaseUntil: null }
    : {};

export function createPrismaResearchStore(): ResearchStore {
  return {
    async createRun({ userId, goal, conversationId, budgetMicroUsd, plan }) {
      // The crew member whose thread started it, like `WorkSession.agentId`:
      // research asked for in a member's thread is that member's.
      const owner = conversationId
        ? await prisma.agent
            .findFirst({ where: { userId, conversationId, deletedAt: null }, select: { id: true } })
            .catch(() => null)
        : null;
      const created = await prisma.researchRun.create({
        data: {
          userId,
          conversationId,
          agentId: owner?.id ?? null,
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

    async claimRun({ runId, userId, workerId, leaseMs }) {
      const now = new Date();
      const boundedLeaseMs = Math.max(30_000, Math.min(10 * 60_000, leaseMs ?? RESEARCH_WORKER_LEASE_MS));
      const leaseUntil = new Date(now.getTime() + boundedLeaseMs);
      const claimed = await prisma.researchRun.updateMany({
        where: {
          id: runId,
          userId,
          state: { in: ["accepted", ...RESEARCH_WORKING_STATES] },
          OR: [
            { workerLeaseUntil: null },
            { workerLeaseUntil: { lte: now } },
            { workerLeaseOwner: workerId },
          ],
        },
        data: {
          workerLeaseOwner: workerId,
          workerLeaseUntil: leaseUntil,
          lastHeartbeatAt: now,
        },
      });
      if (claimed.count === 0) return null;
      const row = await prisma.researchRun.findFirst({ where: { id: runId, userId } });
      return row ? toRunRow(row) : null;
    },

    async releaseRun({ runId, userId, workerId }) {
      // Conditional on the owner: a release never frees a lease another
      // driver has since taken (B1).
      await prisma.researchRun.updateMany({
        where: { id: runId, userId, workerLeaseOwner: workerId },
        data: { workerLeaseOwner: null, workerLeaseUntil: null },
      });
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
          // The envelope's ceiling, frozen on the row at confirmation (§9.2).
          ...(patch && patch.budgetMicroUsd !== undefined ? { budgetMicroUsd: patch.budgetMicroUsd } : {}),
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

    async upsertSource({
      runId,
      userId,
      url,
      title,
      publishedAt,
      contentHash,
      snapshot,
      authority,
      freshness,
      directness,
      independence,
      composite,
      sourceType,
    }) {
      const canonical = canonicalUrl(url);
      // The database also owns this invariant through @@unique(runId,
      // canonicalUrl). Checking first keeps the normal path cheap; the unique
      // index prevents concurrent workers from creating duplicate corpus rows.
      const existing = await prisma.researchSource.findFirst({
        where: { runId, userId, canonicalUrl: canonical },
        select: { id: true, snapshot: true },
      });
      if (existing) {
        /**
         * A snapshot never shrinks.
         *
         * SEARCH upserts every hit with whatever body the engine returned, and a
         * run re-searches on each follow-up round — so a source the READ stage
         * had opened properly was overwritten, round after round, by the few
         * hundred characters of lede the search API had originally handed back.
         * The corpus, the passages and every citation checked against them then
         * degraded silently between rounds, and the run reported the same source
         * count throughout.
         *
         * `contentHash` moves with it or not at all: the hash attests to the
         * snapshot, and keeping one while replacing the other would put a hash
         * over text it was not computed from.
         */
        // `!= null` rather than `!== undefined`: an explicit null means "no text",
        // and under the never-shrink rule that must not clear a snapshot either.
        const keepsMoreText = snapshot != null && snapshot.length > (existing.snapshot?.length ?? 0);
        await prisma.researchSource.updateMany({
          where: { id: existing.id, userId },
          data: {
            title: title.slice(0, 500),
            ...(publishedAt !== undefined ? { publishedAt } : {}),
            ...(keepsMoreText && contentHash !== undefined ? { contentHash } : {}),
            ...(keepsMoreText ? { snapshot } : {}),
            ...(authority !== undefined ? { authority } : {}),
            ...(freshness !== undefined ? { freshness } : {}),
            ...(directness !== undefined ? { directness } : {}),
            ...(independence !== undefined ? { independence } : {}),
            ...(composite !== undefined ? { composite } : {}),
            ...(sourceType !== undefined ? { sourceType } : {}),
          },
        });
        return { id: existing.id, created: false };
      }
      const created = await prisma.researchSource.create({
        data: {
          runId,
          userId,
          url,
          canonicalUrl: canonical,
          title: (title || url).slice(0, 500),
          publishedAt: publishedAt ?? null,
          contentHash: contentHash ?? null,
          snapshot: snapshot ?? null,
          authority: authority ?? null,
          freshness: freshness ?? null,
          directness: directness ?? null,
          independence: independence ?? null,
          composite: composite ?? null,
          sourceType: sourceType ?? null,
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
          freshness: true,
          directness: true,
          independence: true,
          composite: true,
          sourceType: true,
          fetchedAt: true,
        },
      });
    },

    async findSourceByUrl(runId, userId, url) {
      // One indexed row by the same key `upsertSource` dedupes on, instead of
      // the whole corpus scanned for it — see `ResearchStore.findSourceByUrl`.
      return prisma.researchSource.findFirst({
        where: { runId, userId, canonicalUrl: canonicalUrl(url) },
        select: {
          id: true,
          url: true,
          title: true,
          contentHash: true,
          snapshot: true,
          publishedAt: true,
          authority: true,
          freshness: true,
          directness: true,
          independence: true,
          composite: true,
          sourceType: true,
          fetchedAt: true,
        },
      });
    },

    async listSourceUrls(runId, userId) {
      // `length()` is not something a Prisma select can ask for, and selecting
      // the snapshot to measure it is the load this method exists to avoid.
      // Scoped by userId in the WHERE itself: a raw query goes around the
      // ownership guard the model operations carry.
      return prisma.$queryRaw<Array<{ url: string; snapshotChars: number }>>(
        Prisma.sql`SELECT "url", COALESCE(length("snapshot"), 0)::int AS "snapshotChars" FROM "ResearchSource" WHERE "runId" = ${runId} AND "userId" = ${userId}`
      );
    },

    async addFinding({ runId, userId, workerId, round, objectiveId, sourceId, url, claim, quote, locator, confidence }) {
      const created = await prisma.researchFinding.create({
        data: {
          runId,
          userId,
          workerId: workerId.slice(0, 40),
          round,
          objectiveId,
          sourceId,
          claim: claim.slice(0, 600),
          quote: quote.slice(0, 800),
          locator,
          confidence,
        },
        select: { id: true },
      });
      void url;
      return { id: created.id };
    },

    async listFindings(runId, userId) {
      const rows = await prisma.researchFinding.findMany({
        where: { runId, userId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          workerId: true,
          round: true,
          objectiveId: true,
          sourceId: true,
          claim: true,
          quote: true,
          locator: true,
          confidence: true,
          createdAt: true,
          source: { select: { url: true } },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        workerId: row.workerId,
        round: row.round,
        objectiveId: row.objectiveId,
        sourceId: row.sourceId,
        url: row.source?.url ?? "",
        claim: row.claim,
        quote: row.quote,
        locator: row.locator,
        confidence: row.confidence,
        createdAt: row.createdAt,
      }));
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
          model: "deep-search",
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
 * A model's price in the unit the engine's estimates are computed in.
 *
 * Micro-USD per token equals USD per million tokens, so the catalogue's figure
 * is the rate as it stands. The engine reserves each round of workers at
 * these rates rather than at the reference ceiling, which would price a cheap
 * worker three or four times over and refuse whole rounds on an ordinary
 * budget. Undefined when no model is configured, in which case the engine
 * falls back to reserving the vendor fees alone.
 */
function ratesOf(model: ModelInfo | null): ResearchModelRates | undefined {
  if (!model) return undefined;
  const metrics = getModelMetrics(model);
  return { inputMicroUsdPerToken: metrics.inputUsdPerMTok, outputMicroUsdPerToken: metrics.outputUsdPerMTok };
}

function researchModelRates(): ResearchDeps["modelRates"] {
  const worker = ratesOf(researchWorkerModel());
  const lead = ratesOf(researchLeadModel());
  return { ...(worker ? { worker } : {}), ...(lead ? { lead } : {}) };
}

// ---------------------------------------------------------------------------
// Sizing, planning and completion, bound to the account (SPEC §9.2–§9.6)
// ---------------------------------------------------------------------------

/** The judge runs on the workers' model; its rates price the audit's reservation. */
const REFERENCE_RATES: ResearchModelRates = { inputMicroUsdPerToken: 3, outputMicroUsdPerToken: 15 };

/** Results per query the roster is priced at: the middle of the breadth table. */
const ROSTER_RESULTS_PER_QUERY = 20;

/**
 * Whether the account's five-hour or weekly window is spent (RESEARCH_V2 §6):
 * the engine asks at each round boundary, and a spent window ends the rounds.
 * Unmetered accounts (enforcement off) have no window and are never spent.
 */
async function researchWindowSpent(input: { userId: string }): Promise<boolean> {
  const plan = await getUserPlan(input.userId);
  const status = await checkUsageWindows(input.userId, plan);
  return !status.capDisabled && !status.allowed;
}

/** Start of the requester's local calendar day, else the UTC day (§9.2 starts per day). */
export function startOfLocalDay(now: Date, timeZone?: string | null): Date {
  try {
    if (!timeZone) throw new Error("no zone");
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value])
    );
    const localNow = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const offset = localNow - Math.floor(now.getTime() / 1000) * 1000;
    return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offset);
  } catch {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}

/** Runs going at once, not counting plans parked at the gate, other than `excludeRunId`. */
async function liveRunCount(userId: string, excludeRunId?: string): Promise<number> {
  return prisma.researchRun.count({
    where: {
      userId,
      state: { in: ["accepted", ...RESEARCH_WORKING_STATES, "paused"] },
      ...(excludeRunId ? { id: { not: excludeRunId } } : {}),
    },
  });
}

async function startsSince(userId: string, since: Date, excludeRunId?: string): Promise<number> {
  return prisma.researchRun.count({
    where: { userId, createdAt: { gte: since }, ...(excludeRunId ? { id: { not: excludeRunId } } : {}) },
  });
}

/**
 * The envelope for a run (§9.2): the plan's caps, what is left of the month,
 * the lead the plan's class allows (the chat's own model when it qualifies),
 * the keyed engines' prices, and how many runs are going and have started
 * today. `researchBudgetFor` does the arithmetic; this gathers the facts.
 */
export async function sizeResearchRun(input: {
  run: ResearchRunRow;
  plan: ResearchPlan;
  scope: ResearchScope;
  purpose: "preview" | "confirm";
}): Promise<ResearchEnvelope | ResearchBudgetRefusal> {
  const userPlan = await getUserPlan(input.run.userId);
  // One decision for every stage: the person's chosen model runs the whole
  // run, and the envelope records which models will work (and why, when the
  // researchers cannot run on the chosen one).
  const models = researchRunModels({ plan: userPlan, preferred: input.plan.preferredLead ?? null });
  const lead = models.lead;
  if (!lead) return { refused: true, reason: "not_configured", params: {} };
  const stepDown = models.stepDown;
  const now = new Date();
  const [budget, windows, liveRuns, startsToday] = await Promise.all([
    checkBudget(input.run.userId, userPlan, undefined, undefined, { reap: false }),
    checkUsageWindows(input.run.userId, userPlan),
    liveRunCount(input.run.userId, input.run.id),
    startsSince(input.run.userId, startOfLocalDay(now, input.plan.timeZone), input.run.id),
  ]);
  const worker = ratesOf(models.worker) ?? REFERENCE_RATES;
  // The citation judge runs on the lead when the person chose it, else on the
  // researchers' model, as it always has.
  const judge = models.chosen ? ratesOf(lead) ?? REFERENCE_RATES : worker;
  const stepDownRates = stepDown ? ratesOf(stepDown) : undefined;
  return researchBudgetFor({
    scope: input.scope,
    plan: userPlan,
    remaining: {
      monthMicroUsd: budget.capDisabled ? null : budget.remainingMicroUsd,
      monthBudgetMicroUsd: budget.budgetMicroUsd,
      resetsAtMs: budget.resetsAtMs,
      // The usage windows are the run's money limit (RESEARCH_V2 §6).
      windowMicroUsd: windows.capDisabled ? null : windows.allowed ? windows.remainingMicroUsd : 0,
      windowResetsAtMs: windows.resetsAtMs,
    },
    rates: { worker, lead: ratesOf(lead) ?? REFERENCE_RATES, judge },
    roster: researchRoster(searchProviderStatus().keyed, ROSTER_RESULTS_PER_QUERY),
    liveRuns,
    startsToday,
    eurPerUsd: eurPerUsd(),
    leadModel: lead.id,
    stepDown: stepDown && stepDownRates && stepDown.id !== lead.id ? { leadModel: stepDown.id, rates: stepDownRates } : null,
    models: { workerModel: models.worker?.id ?? null, workerNote: models.workerNote, chosen: models.chosen },
  });
}

/**
 * The structured planner on the run's lead: the frozen envelope's when there
 * is one (a revision), else the lead the account's plan allows (§9.5.1).
 */
const draftPlanForRun: NonNullable<ResearchDeps["draftPlan"]> = async (input) => {
  let leadModel = input.leadModel ?? null;
  if (!leadModel) {
    // Not sized yet: the same decision sizing will make, so the plan is drafted
    // by the model the person chose rather than by whichever the plan class
    // would have picked.
    const userPlan = await getUserPlan(input.userId).catch(() => null);
    leadModel = userPlan ? researchRunModels({ plan: userPlan, preferred: input.preferredLead ?? null }).lead?.id ?? null : null;
  }
  return draftResearchPlanWithModel({ ...input, leadModel });
};

/**
 * Time the run spent working, from its own event log (`activeWorkingMs`):
 * startedAt to the finish (or now), with the plan gate, pauses and every
 * stretch nobody was driving it left out. Falls back to the plan's clock only
 * when the log cannot be read.
 */
export async function runWorkingMs(run: ResearchRunRow, plan: ResearchPlan, now: Date): Promise<number> {
  const end = run.finishedAt ?? now;
  try {
    const [stamps, moves] = await Promise.all([
      prisma.researchEvent.findMany({
        where: { runId: run.id, userId: run.userId },
        orderBy: { seq: "asc" },
        select: { seq: true, createdAt: true },
      }),
      prisma.researchEvent.findMany({
        where: { runId: run.id, userId: run.userId, kind: "state_changed" },
        select: { seq: true, payload: true },
      }),
    ]);
    if (stamps.length === 0) return workingMsOf(run, plan, now);
    const moved = new Map<number, string>();
    for (const move of moves) {
      const payload = move.payload && typeof move.payload === "object" && !Array.isArray(move.payload) ? (move.payload as Record<string, unknown>) : {};
      if (typeof payload.state === "string") moved.set(move.seq, payload.state);
    }
    return activeWorkingMs({
      startedAt: run.startedAt ?? run.createdAt,
      end,
      events: stamps.map((stamp) => ({ at: stamp.createdAt, state: moved.get(stamp.seq) ?? null })),
    });
  } catch (error) {
    console.error("[research] working time from events failed", { runId: run.id, error });
    return workingMsOf(run, plan, now);
  }
}

/**
 * The web completion (§9.6.3): the summary and the report renumbered so
 * `[1]` is the first source cited, the research fact, and the one
 * transaction that writes the message, its artifact and the run's pointer.
 */
async function completeResearchRun(input: {
  run: ResearchRunRow;
  plan: ResearchPlan;
  report: string;
  sources: Array<{ id: string; url: string; title: string; snapshot: string | null }>;
  to: "completed" | "partially_completed";
  error: string | null;
}): Promise<{ messageId: string | null; raced: boolean; sourceOrder?: string[] }> {
  const now = new Date();
  const { write, sourceOrder } = buildCompletionWrite({
    runId: input.run.id,
    userId: input.run.userId,
    conversationId: input.run.conversationId,
    title: input.plan.title ?? runTitleOf(input.plan, input.run.goal) ?? "Research report",
    summary: input.plan.summary ?? "",
    report: input.report,
    corpus: input.sources.map((source) => ({ id: source.id, title: source.title, url: source.url, snapshot: source.snapshot })),
    to: input.to,
    from: [input.run.state],
    error: input.error,
    // The model that wrote it, as recorded; never a guess at the strongest one.
    leadModel: input.plan.writtenBy || input.plan.envelope?.leadModel || "",
    workedMs: await runWorkingMs({ ...input.run, finishedAt: now }, input.plan, now),
    pages: pagesReadOf(input.plan),
  });
  const result = await finalizeResearchRun(write);
  return { messageId: result.messageId, raced: !!result.raced, sourceOrder };
}

/**
 * The checks before a run starts (§9.2): live runs and starts today against
 * the plan's caps, and room in the month for one planner call. Entitlement
 * (plan, deployment, surface) is `researchEntitlement`'s, checked first.
 */
export async function researchStartCheck(input: {
  userId: string;
  plan: import("@prisma/client").Plan;
  timeZone?: string | null;
  now?: Date;
}): Promise<{ ok: true } | ResearchBudgetRefusal> {
  const caps = RESEARCH_PLAN_CAPS[input.plan];
  if (!caps.entitled) return { refused: true, reason: "plan", params: {} };
  const now = input.now ?? new Date();
  const [live, started, budget, windows] = await Promise.all([
    liveRunCount(input.userId),
    startsSince(input.userId, startOfLocalDay(now, input.timeZone)),
    checkBudget(input.userId, input.plan, undefined, undefined, { reap: false }),
    checkUsageWindows(input.userId, input.plan),
  ]);
  if (live >= caps.liveRuns) return { refused: true, reason: "live_runs", params: { limit: caps.liveRuns } };
  if (caps.startsPerDay !== null && started >= caps.startsPerDay) {
    return { refused: true, reason: "daily_starts", params: { limit: caps.startsPerDay } };
  }
  const lead = ratesOf(researchLeadModel({ plan: input.plan })) ?? REFERENCE_RATES;
  const plannerCall = modelCallEstimateMicroUsd(PLANNER_PROMPT_CHARS + SYSTEM_PROMPT_CHARS, PLANNER_OUTPUT_TOKENS, lead);
  // A spent five-hour or weekly window refuses a start, with when it frees up (§6).
  if (!windows.capDisabled && (!windows.allowed || (windows.remainingMicroUsd !== null && windows.remainingMicroUsd < plannerCall))) {
    return {
      refused: true,
      reason: "budget",
      params: { limit: "window", ...(windows.resetsAtMs ? { resetsOn: new Date(windows.resetsAtMs).toISOString() } : {}) },
    };
  }
  if (!budget.capDisabled && budget.remainingMicroUsd !== null && budget.remainingMicroUsd < plannerCall) {
    return {
      refused: true,
      reason: "budget",
      params: {
        ...(budget.resetsAtMs ? { resetsOn: new Date(budget.resetsAtMs).toISOString().slice(0, 10) } : {}),
      },
    };
  }
  return { ok: true };
}

/**
 * The facts `researchEntitlement` needs about a person and where they are
 * asking from (§9.1): lockdown, the explicit content language, and the
 * workspace of the conversation's project, when it has one.
 */
export async function researchAccountFacts(userId: string, conversationId?: string | null): Promise<{
  lockdown: boolean;
  responseLanguage: string | null;
  workspace: WorkspaceConfig | null;
}> {
  const [settings, conversation] = await Promise.all([
    prisma.settings.findUnique({ where: { userId }, select: { lockdownMode: true, responseLanguage: true } }),
    conversationId
      ? prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { projectId: true } })
      : Promise.resolve(null),
  ]);
  const workspaceRow = conversation?.projectId
    ? await prisma.projectWorkspace.findFirst({ where: { projectId: conversation.projectId, userId }, select: { config: true } })
    : null;
  const language = settings?.responseLanguage?.trim();
  return {
    lockdown: settings?.lockdownMode ?? false,
    responseLanguage: language && language !== "auto" ? language : null,
    workspace: workspaceRow ? parseWorkspaceConfig(workspaceRow.config) : null,
  };
}

/**
 * `plan.context` for a run started in a conversation (B20): the last six
 * turns before the request, oldest first, each cut to 600 characters, at
 * most 4,000 in all, wrapped as untrusted reference. The goal stays the
 * person's own words; this is only what "it" and "that" refer to.
 */
export async function conversationContextFor(conversationId: string | null | undefined, userId: string): Promise<string | null> {
  if (!conversationId) return null;
  const rows = await prisma.message.findMany({
    where: { conversationId, conversation: { userId } },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { role: true, content: true },
  });
  const turns: ContextTurn[] = rows
    .reverse()
    .filter((row) => row.role === "USER" || row.role === "ASSISTANT")
    .map((row) => ({ role: row.role as ContextTurn["role"], content: decryptMessageTextSafe(row.content) ?? "" }));
  return researchGoalContext(turns);
}

/**
 * The one engine the app uses. Memoised because the deps are stateless and
 * building a new closure per request would make the module-level store a lie.
 */
export function researchEngine(): ResearchEngine {
  if (engine) return engine;
  const deps: ResearchDeps = {
    store: createPrismaResearchStore(),
    clarify: clarifyResearchGoal,
    plan: planResearchQueries,
    draftPlan: draftPlanForRun,
    sizeRun: sizeResearchRun,
    windowSpent: researchWindowSpent,
    complete: completeResearchRun,
    search: searchTheWeb,
    fetchPage: fetchResearchPage,
    privateSourceOptions: privateSourceOptionsFor,
    searchPrivate: searchPrivateSources,
    expandQueries: expandResearchQueries,
    runWorker: runResearchWorker,
    reviewRound: reviewResearchRound,
    auditAssist: assistResearchAudit,
    modelRates: researchModelRates(),
    synthesize: writeResearchReport,
    validateReport: async ({ userId, runId, goal, plan, report, sources }) => {
      // A run on the person's chosen model checks its citations on that model.
      const judgeModel = plan.envelope?.chosen ? configuredResearchModel(plan.envelope.leadModel) : null;
      const audit = await recordCitationAudit({
        userId,
        runId,
        goal,
        report,
        ...(judgeModel
          ? {
              complete: (request: { system: string; prompt: string; maxTokens: number }) =>
                researchModelCompletion({ userId, model: judgeModel, label: "citation", ...request }),
            }
          : {}),
        // The run's own judge budget and claim count (B22); older runs keep
        // the audit-wide caps.
        maxJudgeCalls: plan.envelope?.judgeCalls,
        maxClaims: plan.scope ? targetClaimsFor(plan.scope.questions) : undefined,
        today: plan.today,
        sources: sources.map((source) => ({
          sourceId: source.id,
          url: source.url,
          title: source.title,
          body: source.snapshot ?? "",
          publishedAt: source.publishedAt,
          truncated: !source.snapshot,
        })),
      });
      if (!audit) return null;
      return {
        report: audit.report,
        repaired: audit.repaired,
        // What the judge calls really cost, straight through to the engine's
        // ledger. `recordCitationAudit` returns null only on paths that stop
        // before any judge call is made (no claims, or a run/message the caller
        // does not own), so a null here is genuinely a free audit rather than a
        // spend being dropped.
        costMicroUsd: audit.costMicroUsd,
        summary: {
          claims: audit.claims,
          supported: audit.supported,
          partiallySupported: audit.partiallySupported,
          unsupported: audit.unsupported,
          contradicted: audit.contradicted,
          unverified: audit.unverified,
          duplicateSources: audit.duplicateSources,
        },
      };
    },
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
    // The native path plans and sizes like every run (§9.6.4): one structured
    // call, and an envelope from its scope with `confirmation: "auto"`.
    draftPlan: draftPlanForRun,
    sizeRun: sizeResearchRun,
    windowSpent: researchWindowSpent,
    search: searchTheWeb,
    fetchPage: fetchResearchPage,
    privateSourceOptions: privateSourceOptionsFor,
    searchPrivate: searchPrivateSources,
    expandQueries: expandResearchQueries,
    runWorker: runResearchWorker,
    reviewRound: reviewResearchRound,
    auditAssist: assistResearchAudit,
    modelRates: researchModelRates(),
    hash: hashSnapshot,
    now: () => new Date(),
  });
}

// ---------------------------------------------------------------------------
// What the API routes read
// ---------------------------------------------------------------------------

/**
 * The run as the API returns it. The rework's additions (`title`, `scope`,
 * `phase`, `counts`…) are declared once in `src/types/research.ts` and are all
 * optional: a run written before them has none, and until the engine writes
 * them nothing here fills them in.
 */
export interface ResearchRunView extends ResearchRunViewAdditions {
  id: string;
  conversationId: string | null;
  goal: string;
  state: string;
  stage: string;
  plan: {
    /** The plan a person reads at the gate. Empty on runs drafted before steps
     *  existed — the gate falls back to `queries`. See `ResearchPlan.steps`. */
    steps: string[];
    queries: string[];
    constraints: string[];
    pinnedSources: string[];
    confirmed: boolean;
    clarifications: ResearchClarification[];
    clarificationAnswers: Record<string, string>;
    /** The planner's reasoning for the gate — see `ResearchPlan`. Empty when absent. */
    brief: string;
    approach: string;
    successCriteria: string[];
    risks: string[];
    objectives: ResearchObjective[];
    coverage: ResearchCoverageEntry[];
    conflicts: ResearchConflict[];
    followUpRound: number;
    /**
     * The sources the run reads: the web and the person's own (files, project,
     * library, memory, connectors) — what was offered and what is switched
     * on. Absent on runs planned before own sources, which read the web only.
     */
    sources?: { web: boolean; enabled: string[]; options: PrivateSourceOption[] };
    /**
     * The tier the run was started at. The plan gate is where a person
     * authorises the spend, and until this rode the wire the gate could not
     * say how big a team or how long a run it was asking them to approve —
     * the tier copy existed but only the composer's tooltip could reach it.
     * Null on runs older than tiers.
     */
    effort: ResearchEffort | null;
  };
  auditSummary: {
    claims: number;
    supported: number;
    partiallySupported: number;
    unsupported: number;
    contradicted: number;
    unverified: number;
    duplicateSources: number;
  } | null;
  reportRevision: number;
  /** Serialised as strings: BigInt does not survive JSON.stringify. */
  costMicroUsd: string;
  budgetMicroUsd: string | null;
  error: string | null;
  report: string | null;
  live: boolean;
  createdAt: string;
  finishedAt: string | null;
  /**
   * The corpus, with the weights it was gathered under.
   *
   * `listSources` has always selected the four score dimensions, the composite
   * and the classification, and this view dropped every one of them — so the
   * panel could list a run's sources but had nothing to draw a weighted graph
   * with: no way to size a node by how much the run trusted it, no way to
   * colour a regulator's own filing differently from a forum post, and no way
   * to date either — `publishedAt` went the same way, so not even the freshness
   * the run had already computed could be explained. They are carried through
   * as stored, with no recomputation on this path.
   *
   * NULL IS NOT ZERO in any of these. A source gathered before the scoring
   * columns landed, or one a legacy path wrote, has no score — which is a
   * different fact from "scored, and scored badly", and a renderer that folds
   * the two together would draw a confident nothing. Anything consuming these
   * has to treat null as unknown; the scores are recomputed at read time in the
   * citation inspector (`loadCitationAuditForMessage`) precisely because that
   * surface needs a number and this one must not invent one.
   */
  sources: Array<{
    id: string;
    url: string;
    title: string;
    read: boolean;
    contentHash: string | null;
    fetchedAt: string;
    /** As claimed by the source; distinct from the date of the event described. */
    publishedAt: string | null;
    /** 0..1, as scored when the source was gathered. Null when never scored. */
    authority: number | null;
    freshness: number | null;
    directness: number | null;
    independence: number | null;
    /** The weighted roll-up of the four above — the size of a node in the graph. */
    composite: number | null;
    /** official | primary | reputable_secondary | general | user_generated | unknown */
    sourceType: string | null;
  }>;
}

interface ViewSourceRow {
  id: string;
  url: string;
  title: string;
  read: boolean;
  contentHash: string | null;
  fetchedAt: Date;
  publishedAt: Date | null;
  authority: number | null;
  freshness: number | null;
  directness: number | null;
  independence: number | null;
  composite: number | null;
  sourceType: string | null;
}

/**
 * The run's sources for the view: every column the panel reads, and whether
 * the page was read as `snapshot IS NOT NULL` — the snapshot itself is never
 * loaded (research-UI bug 14). Scoped by userId in the WHERE: a raw query
 * goes around the ownership guard the model operations carry.
 */
async function listSourcesForView(runId: string, userId: string): Promise<ViewSourceRow[]> {
  return prisma.$queryRaw<ViewSourceRow[]>(
    Prisma.sql`SELECT "id", "url", "title", ("snapshot" IS NOT NULL) AS "read", "contentHash", "fetchedAt", "publishedAt",
      "authority", "freshness", "directness", "independence", "composite", "sourceType"
      FROM "ResearchSource" WHERE "runId" = ${runId} AND "userId" = ${userId} ORDER BY "fetchedAt" ASC`
  );
}

/**
 * `GET /api/research?conversationId=` and `?live=1` (§9.4): one summary per
 * run, newest first, at most 20. `live` is the account's live runs plus the
 * ones that finished in the last ten minutes — what the completion watcher
 * needs, in one fetch instead of a poll per conversation.
 */
export async function listResearchRunSummaries(input: {
  userId: string;
  conversationId?: string | null;
  live?: boolean;
  limit?: number;
}): Promise<Array<ResearchRunSummary & { goal: string; stage: string; costMicroUsd: string; sourceCount: number }>> {
  const recent = new Date(Date.now() - RECENTLY_FINISHED_MS);
  const rows = await prisma.researchRun.findMany({
    where: {
      userId: input.userId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.live
        ? { OR: [{ state: { notIn: [...RESEARCH_TERMINAL_STATES] } }, { finishedAt: { gte: recent } }] }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(20, Math.max(1, input.limit ?? 20)),
    select: {
      id: true,
      goal: true,
      state: true,
      plan: true,
      conversationId: true,
      costMicroUsd: true,
      createdAt: true,
      finishedAt: true,
      assistantMessageId: true,
      _count: { select: { sources: true } },
    },
  });
  // Whether a partially completed run delivered a report: asked only of those
  // rows, and without loading a report — the watcher polls this every 20 s.
  const partial = rows.filter((row) => row.state === "partially_completed").map((row) => row.id);
  const withReport = new Set(
    partial.length
      ? (
          await prisma.researchRun.findMany({
            where: { id: { in: partial }, userId: input.userId, report: { not: null } },
            select: { id: true },
          })
        ).map((row) => row.id)
      : []
  );
  // The latest telling event, only for runs still investigating — the one
  // state whose phase (searching or reading) the row alone cannot say.
  const investigating = rows.filter((row) => row.state === "investigating").map((row) => row.id);
  const latestByRun = new Map<string, LatestPhaseEvent>();
  await Promise.all(
    investigating.map(async (runId) => {
      const event = await prisma.researchEvent.findFirst({
        where: { runId, userId: input.userId, kind: { in: [...PHASE_EVENT_KINDS] } },
        orderBy: { seq: "desc" },
        select: { kind: true, payload: true },
      });
      if (event) {
        latestByRun.set(runId, {
          kind: event.kind,
          payload: event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? (event.payload as Record<string, unknown>) : {},
        });
      }
    })
  );
  return rows.map((row) => {
    const state = isResearchState(row.state) ? row.state : "failed";
    return {
      ...summaryOf({
        id: row.id,
        conversationId: row.conversationId,
        state,
        plan: parsePlan(row.plan),
        goal: row.goal,
        createdAt: row.createdAt,
        finishedAt: row.finishedAt,
        assistantMessageId: row.assistantMessageId,
        hasReport: withReport.has(row.id),
        latest: latestByRun.get(row.id) ?? null,
      }),
      // The pre-rework row's fields, kept so an older client's list still reads.
      goal: row.goal,
      stage: stageForState(state),
      costMicroUsd: row.costMicroUsd.toString(),
      sourceCount: row._count.sources,
    };
  });
}

/**
 * A run and everything since a cursor, in one round trip.
 *
 * One query rather than two endpoints because the state and the events have to
 * agree: a client that reads events at t and state at t+1 renders a finished
 * run that is still showing a live stage, which is the exact confusion the
 * stage list exists to remove.
 *
 * `lastSeq` is what the caller sends back as `after` next time, and it is the
 * last row OF THIS PAGE. It used to be max(seq) over the whole run, which is a
 * cursor that skips: the page is capped (200 at the route, 500 here), so any
 * run that emitted more than one page's worth handed back a cursor past events
 * the caller had never been given, and 201..max were lost silently — no gap, no
 * error, just a timeline missing its middle. `readEvents` selects `seq > after`
 * ascending, so the last row that actually arrived is the only value that
 * cannot lose anything.
 *
 * `maxSeq` is where the run has really got to, and exists so the caller can
 * tell "caught up" from "one page behind": `lastSeq < maxSeq` means fetch the
 * next page now rather than waiting out a poll interval. Splitting the two is
 * the whole fix — one number cannot be both a cursor and a total.
 */
export async function readResearchRun(input: {
  runId: string;
  userId: string;
  after?: number;
  limit?: number;
}): Promise<{
  run: ResearchRunView;
  events: ResearchEventDTO[];
  lastSeq: number;
  maxSeq: number;
} | null> {
  const store = createPrismaResearchStore();
  const run = await store.loadRun(input.runId, input.userId);
  if (!run) return null;
  // The notes behind "What we know so far" (RESEARCH_V2 §3): live runs only —
  // a finished run has its report — strongest first, claims only, bounded.
  const live = !isTerminalResearchState(run.state);
  const [events, sources, auditEvent, latestEvent, phaseEvent, findings, notes] = await Promise.all([
    store.readEvents({
      runId: run.id,
      userId: run.userId,
      after: Math.max(0, input.after ?? 0),
      limit: Math.min(500, Math.max(1, input.limit ?? 200)),
    }),
    // Whether each source was read, without loading a single snapshot
    // (research-UI bug 14): the poll used to pull every page body on every
    // tick to compute one boolean per row.
    listSourcesForView(run.id, run.userId),
    // The caller's cursor may be past the audit event. Read the latest audit
    // independently so a reconnect still shows the durable verification
    // receipt instead of silently dropping it from the run header.
    prisma.researchEvent.findFirst({
      where: { runId: run.id, userId: run.userId, kind: "citation_audit" },
      orderBy: { seq: "desc" },
      select: { payload: true },
    }),
    prisma.researchEvent.aggregate({
      where: { runId: run.id, userId: run.userId },
      _max: { seq: true },
    }),
    prisma.researchEvent.findFirst({
      where: { runId: run.id, userId: run.userId, kind: { in: [...PHASE_EVENT_KINDS] } },
      orderBy: { seq: "desc" },
      select: { kind: true, payload: true },
    }),
    prisma.researchFinding.findMany({
      where: { runId: run.id, userId: run.userId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, workerId: true, round: true, objectiveId: true, sourceId: true, claim: true, quote: true, locator: true, confidence: true, createdAt: true, source: { select: { url: true } } },
    }),
    live
      ? prisma.researchFinding.findMany({
          where: { runId: run.id, userId: run.userId, objectiveId: { not: null } },
          orderBy: [{ confidence: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
          take: 80,
          select: { objectiveId: true, sourceId: true, claim: true, confidence: true, createdAt: true, source: { select: { url: true } } },
        })
      : Promise.resolve([]),
  ]);
  const plan = parsePlan(run.plan);
  const state = isResearchState(run.state) ? run.state : "failed";
  const now = new Date();
  const latest: LatestPhaseEvent | null = phaseEvent
    ? {
        kind: phaseEvent.kind,
        payload:
          phaseEvent.payload && typeof phaseEvent.payload === "object" && !Array.isArray(phaseEvent.payload)
            ? (phaseEvent.payload as Record<string, unknown>)
            : {},
      }
    : null;
  const phase = researchPhaseFor(state, latest, !!run.report?.trim());
  const readCount = sources.filter((source) => source.read).length;
  const cited = run.report ? citationOrder([run.report]).filter((n) => n >= 1 && n <= readCount).length : 0;
  const recorded = runModelsOf(plan, (id) => MODEL_LIST.find((model) => model.id === id)?.name ?? id);
  const workingMs = await runWorkingMs(run, plan, now);
  const additions: ResearchRunViewAdditions = {
    title: runTitleOf(plan, run.goal),
    scope: plan.scope ?? null,
    estimate: estimateOf(plan),
    estimateCaps: state === "awaiting_plan_confirmation" ? plan.estimateCaps ?? null : null,
    language: plan.language ?? null,
    questions: questionViews(plan, state),
    clarifications: clarificationViews(plan),
    counts: countsOf({ plan, sources, cited }),
    phase,
    phaseDetail: phaseDetailFor(phase, latest),
    workingMs,
    assistantMessageId: run.assistantMessageId ?? null,
    // "Written by" is the recorded writer only; older runs show no model.
    leadModel: recorded.leadModel,
    models: recorded.models,
    latestFindings: latestFindingsOf(
      findings.map((finding) => ({ ...finding, url: finding.source?.url ?? "" })),
      sources
    ),
    ...(live
      ? {
          emergingAnswers: emergingAnswersOf(
            notes.map((note) => ({ ...note, url: note.source?.url ?? "" })),
            sources,
            plan.objectives
          ),
        }
      : {}),
    plannedBy: plan.plannedBy ?? null,
    ...(plan.digest ? { digest: true } : {}),
    spend: {
      microUsd: run.costMicroUsd.toString(),
      ceilingMicroUsd: run.budgetMicroUsd === null ? null : run.budgetMicroUsd.toString(),
    },
    steering: plan.steering ?? [],
    revising: revisingOf(plan, now),
    finishRequested: !!plan.finishRequestedAt,
  };
  const auditPayload = auditEvent?.payload;
  const auditSummary =
    auditPayload && typeof auditPayload === "object" && !Array.isArray(auditPayload)
      ? {
          claims: Number((auditPayload as Record<string, unknown>).claims ?? 0),
          supported: Number((auditPayload as Record<string, unknown>).supported ?? 0),
          partiallySupported: Number((auditPayload as Record<string, unknown>).partiallySupported ?? 0),
          unsupported: Number((auditPayload as Record<string, unknown>).unsupported ?? 0),
          contradicted: Number((auditPayload as Record<string, unknown>).contradicted ?? 0),
          unverified: Number((auditPayload as Record<string, unknown>).unverified ?? 0),
          duplicateSources: Number((auditPayload as Record<string, unknown>).duplicateSources ?? 0),
        }
      : null;
  return {
    run: {
      ...additions,
      id: run.id,
      conversationId: run.conversationId,
      goal: run.goal,
      state,
      stage: stageForState(state),
      plan: {
        // The plan a person reads at the gate. `?? []` rather than omitted, so
        // a client never has to distinguish "no steps" from "field missing".
        steps: plan.steps ?? [],
        queries: plan.queries,
        constraints: plan.constraints,
        pinnedSources: plan.pinnedSources,
        confirmed: planIsConfirmed(plan),
        // What the run asked before it planned, and what came back. `?? []`
        // and `?? {}` for the same reason as steps: a client never has to
        // distinguish "asked nothing" from "field missing".
        clarifications: plan.clarifications ?? [],
        clarificationAnswers: plan.clarificationAnswers ?? {},
        // The planner's reasoning, for the gate and the plan tab. Empty
        // strings and lists rather than absent, for the same reason as steps.
        brief: plan.brief ?? "",
        approach: plan.approach ?? "",
        successCriteria: plan.successCriteria ?? [],
        risks: plan.risks ?? [],
        objectives: plan.objectives,
        coverage: plan.coverage ?? [],
        conflicts: plan.conflicts ?? [],
        followUpRound: plan.followUpRound ?? 0,
        ...(plan.sources
          ? { sources: { web: plan.sources.web, enabled: plan.sources.enabled, options: plan.sources.options } }
          : {}),
        // Null for every run sized by scope (§9.4): the stored tier exists only
        // for the previous build, and no web component ever shows a depth.
        effort: dtoEffort(plan),
      },
      auditSummary,
      reportRevision: run.reportRevision ?? 0,
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
        read: source.read,
        contentHash: source.contentHash,
        fetchedAt: source.fetchedAt.toISOString(),
        publishedAt: source.publishedAt?.toISOString() ?? null,
        authority: source.authority ?? null,
        freshness: source.freshness ?? null,
        directness: source.directness ?? null,
        independence: source.independence ?? null,
        composite: source.composite ?? null,
        sourceType: source.sourceType ?? null,
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
    // An empty page returns the caller's own cursor rather than 0: a poll that
    // found nothing new must not rewind the client to the start of the run.
    lastSeq: events.length > 0 ? events[events.length - 1].seq : Math.max(0, input.after ?? 0),
    maxSeq: latestEvent._max.seq ?? 0,
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
  workerId?: string;
}): void {
  const driver = input.engine ?? researchEngine();
  void driver
    .drive({
      runId: input.runId,
      userId: input.userId,
      // Stable per run (B1): a nudge after a gate reclaims a lease its own
      // earlier drive held, instead of waiting two minutes for it to lapse.
      workerId: input.workerId ?? researchWebOwner(input.runId),
    })
    .catch((e: unknown) => {
      console.error("[research] background drive failed", { runId: input.runId, error: e });
    });
}

/**
 * Reruns the planner for a `revise` at the scope card (§9.4), in the
 * background: the card shows `revising` until the new plan lands.
 */
export function reviseResearchPlanInBackground(input: { runId: string; userId: string }): void {
  void researchEngine()
    .revisePlan({ runId: input.runId, userId: input.userId })
    .catch((e: unknown) => {
      console.error("[research] background revision failed", { runId: input.runId, error: e });
    });
}

/**
 * The chat adapter writes the report through the user's selected model, so the
 * durable job cannot use its normal synthesis stage. Once that stream has been
 * audited, close the original run through the same transition/event contract as
 * every standalone report. A canceled run can never be revived by this late
 * callback.
 */
export async function finalizeChatResearchRun(input: {
  runId: string;
  userId: string;
  report: string;
  partial?: boolean;
  error?: string | null;
  /** The chat model that streamed the report, recorded for "Written by". */
  writtenBy?: string | null;
}): Promise<ResearchRunRow | null> {
  const store = createPrismaResearchStore();
  let run = await store.loadRun(input.runId, input.userId);
  if (!run || isTerminalResearchState(run.state)) return run;
  const target: ResearchTerminalState = input.partial ? "partially_completed" : "completed";
  if (run.state === "synthesizing") {
    const validating = await store.moveState({
      runId: input.runId,
      userId: input.userId,
      from: ["synthesizing"],
      to: "validating_citations",
      patch: { report: input.report },
    });
    if (!validating) return store.loadRun(input.runId, input.userId);
    await store.appendEvents({
      runId: input.runId,
      userId: input.userId,
      events: [
        { kind: "state_changed", payload: { from: "synthesizing", state: "validating_citations" } },
      ],
    });
    run = validating;
  }
  if (!isResearchState(run.state) || !transitionAllowed(run.state, target)) return run;
  const ended = await store.moveState({
    runId: input.runId,
    userId: input.userId,
    from: [run.state as ResearchState],
    to: target,
    patch: {
      report: input.report,
      error: input.error ?? null,
      ...(input.writtenBy ? { plan: { ...parsePlan(run.plan), writtenBy: input.writtenBy } } : {}),
    },
  });
  if (!ended) return store.loadRun(input.runId, input.userId);
  await store.appendEvents({
    runId: input.runId,
    userId: input.userId,
    events: [
      { kind: "state_changed", payload: { from: run.state, state: target } },
      {
        kind: "run_finished",
        payload: { state: target, reason: input.partial ? "citation_audit_degraded" : "completed" },
      },
    ],
  });
  return ended;
}
