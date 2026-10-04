import "server-only";

/**
 * Routing telemetry: write one outcome per routed turn, mark it when the
 * reader's later actions say it failed, and read the aggregate the router
 * believes (BRIEF §26). The policy is in docs/rework/program/AUTO_ROUTER.md
 * ("Telemetry policy"); in short:
 *
 *   - no content, no prompt hash, no user id, no conversation id;
 *   - private chats write nothing;
 *   - `messageId` is the only link, kept 30 days for late signals, then nulled;
 *   - rows are deleted after 180 days;
 *   - the router reads aggregates only, with a minimum-sample guard and
 *     shrinkage toward priors (evidence.ts).
 *
 * Every write is best-effort: telemetry must never fail or slow a turn.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { evidenceKey, type EvidenceCell, type EvidenceTable } from "@/lib/router/evidence";
import { isTaskClass, type TaskClass } from "@/lib/router/task-class";

export const ROUTING_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ROUTING_ROW_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** The window the router learns from. */
export const ROUTING_EVIDENCE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const EVIDENCE_CACHE_MS = 5 * 60 * 1000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

export type CompletionState = "completed" | "partial" | "failed" | "stopped";

export interface RoutingOutcomeInput {
  messageId: string | null;
  routerVersion: number;
  auto: boolean;
  taskClass: TaskClass;
  complexity: string;
  modelId: string;
  provider: string;
  effort: string | null;
  latencyMs: number | null;
  firstTokenMs: number | null;
  toolRounds: number;
  retryCount: number;
  completionState: CompletionState;
  finishReason: string | null;
  costMicroUsd: number | null;
  expectedMicroUsd: number | null;
}

/** Map a turn's finish reason onto the four states the router learns from. */
export function completionStateFor(finishReason: string | null | undefined, persistedPartial: boolean): CompletionState {
  if (finishReason === "user_stopped") return "stopped";
  if (finishReason === "stop" || finishReason === "tool_calls" || !finishReason) return persistedPartial ? "partial" : "completed";
  return persistedPartial ? "partial" : "failed";
}

export async function recordRoutingOutcome(input: RoutingOutcomeInput): Promise<void> {
  try {
    const data = {
      ...input,
      latencyMs: clampInt(input.latencyMs),
      firstTokenMs: clampInt(input.firstTokenMs),
      costMicroUsd: clampInt(input.costMicroUsd),
      expectedMicroUsd: clampInt(input.expectedMicroUsd),
    };
    if (input.messageId) {
      // A regenerate overwrites the same message row; its new outcome replaces
      // the link on the old one (which keeps its regenerated mark).
      await prisma.routingOutcome.updateMany({ where: { messageId: input.messageId }, data: { messageId: null } });
    }
    await prisma.routingOutcome.create({ data });
  } catch (err) {
    console.warn("[router] telemetry write skipped", err instanceof Error ? err.message : err);
  }
}

export interface RoutingSignal {
  regenerated?: boolean;
  switchedModel?: boolean;
  edited?: boolean;
  feedback?: "UP" | "DOWN" | null;
}

/** The reader's later verdict on a turn. No-op when the turn has no outcome row. */
export async function markRoutingSignal(messageIds: string | string[], signal: RoutingSignal): Promise<void> {
  const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).filter(Boolean);
  if (ids.length === 0) return;
  const data: Prisma.RoutingOutcomeUpdateManyMutationInput = {};
  if (signal.regenerated) data.userRegenerated = true;
  if (signal.switchedModel) data.userSwitchedModel = true;
  if (signal.edited) data.userEdited = true;
  if (signal.feedback !== undefined) data.feedback = signal.feedback;
  if (Object.keys(data).length === 0) return;
  try {
    await prisma.routingOutcome.updateMany({ where: { messageId: { in: ids } }, data });
  } catch (err) {
    console.warn("[router] telemetry signal skipped", err instanceof Error ? err.message : err);
  }
}

/** Null the link after 30 days, delete after 180. Returns what it changed. */
export async function pruneRoutingOutcomes(now = new Date()): Promise<{ unlinked: number; deleted: number }> {
  const unlinked = await prisma.routingOutcome.updateMany({
    where: { messageId: { not: null }, createdAt: { lt: new Date(now.getTime() - ROUTING_LINK_TTL_MS) } },
    data: { messageId: null },
  });
  const deleted = await prisma.routingOutcome.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - ROUTING_ROW_TTL_MS) } },
  });
  return { unlinked: unlinked.count, deleted: deleted.count };
}

interface AggregateRow {
  modelId: string;
  taskClass: string;
  n: bigint;
  successes: bigint;
  toolRoundsSum: bigint | null;
  retriesSum: bigint | null;
  latencyMsSum: bigint | null;
  latencyN: bigint;
  costSum: bigint | null;
  costN: bigint;
}

/**
 * The aggregate, straight from SQL. Success is computed with the same rule as
 * `outcomeSucceeded` (pinned by tests/router-telemetry.integration.test.ts).
 */
export async function aggregateRoutingEvidence(since: Date): Promise<Map<string, EvidenceCell>> {
  const rows = await prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT "modelId", "taskClass",
      COUNT(*) AS n,
      COUNT(*) FILTER (
        WHERE "completionState" = 'completed' AND NOT "userRegenerated" AND NOT "userSwitchedModel"
          AND NOT "userEdited" AND ("feedback" IS NULL OR "feedback" <> 'DOWN')
      ) AS successes,
      SUM("toolRounds") AS "toolRoundsSum",
      SUM("retryCount") AS "retriesSum",
      SUM("latencyMs") AS "latencyMsSum",
      COUNT("latencyMs") AS "latencyN",
      SUM("costMicroUsd") AS "costSum",
      COUNT("costMicroUsd") AS "costN"
    FROM "RoutingOutcome"
    WHERE "createdAt" >= ${since}
    GROUP BY "modelId", "taskClass"
  `);
  const table = new Map<string, EvidenceCell>();
  for (const r of rows) {
    if (!isTaskClass(r.taskClass)) continue;
    table.set(evidenceKey(r.modelId, r.taskClass), {
      modelId: r.modelId,
      taskClass: r.taskClass,
      n: Number(r.n),
      successes: Number(r.successes),
      toolRoundsSum: Number(r.toolRoundsSum ?? 0),
      retriesSum: Number(r.retriesSum ?? 0),
      latencyMsSum: Number(r.latencyMsSum ?? 0),
      latencyN: Number(r.latencyN),
      costMicroUsdSum: Number(r.costSum ?? 0),
      costN: Number(r.costN),
    });
  }
  return table;
}

let cache: { at: number; table: EvidenceTable } | null = null;
let inflight: Promise<EvidenceTable> | null = null;
let lastPrune = 0;

/**
 * The evidence table the router reads, cached for five minutes per process.
 * A failed read returns the last good table (or none): routing falls back to
 * priors, never fails.
 */
export async function loadRoutingEvidence(now = Date.now()): Promise<EvidenceTable> {
  if (cache && now - cache.at < EVIDENCE_CACHE_MS) return cache.table;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const table = await aggregateRoutingEvidence(new Date(now - ROUTING_EVIDENCE_WINDOW_MS));
      cache = { at: now, table };
      if (now - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = now;
        void pruneRoutingOutcomes(new Date(now)).catch(() => undefined);
      }
      return table;
    } catch (err) {
      console.warn("[router] evidence read failed; routing on priors", err instanceof Error ? err.message : err);
      return cache?.table ?? new Map();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test seam. */
export function __resetRoutingEvidenceCache(): void {
  cache = null;
  inflight = null;
  lastPrune = 0;
}

function clampInt(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(2_147_483_647, Math.round(n)));
}

