/**
 * Juno's own tool fees (SPEC §3.9).
 *
 * A fee is third-party money Juno spends on the user's behalf — a search
 * engine's per-query price, a sandbox's wall time — as opposed to the model's
 * tokens. Each is written to the ledger as its own `kind: "chat"` row with
 * model `juno-tool:<id>` (DECISIONS §4c), and the budget guard reads the
 * running total so a tool-heavy turn stops before it overspends.
 *
 * Pure: the ledger writer (`recordSpend`, server-only) and the month-to-date
 * grounding query arrive as arguments, so this module stays importable
 * offline and its rules are tested without a database.
 */

import type { CanonicalToolId } from "@/types/run";

type ToolFeeRow = { tool: CanonicalToolId; microUsd: number; calls: number };

export class ToolFeeAccumulator {
  private readonly byTool = new Map<CanonicalToolId, ToolFeeRow>();
  private sum = 0;
  private written = false;

  /**
   * One billed call. A zero or negative fee is not a call worth a ledger row
   * (a failed engine, a cached result), so it is ignored rather than counted.
   */
  add(tool: CanonicalToolId, microUsd: number): void {
    if (!Number.isFinite(microUsd) || microUsd <= 0) return;
    const amount = Math.round(microUsd);
    const row = this.byTool.get(tool) ?? { tool, microUsd: 0, calls: 0 };
    row.microUsd += amount;
    row.calls += 1;
    this.byTool.set(tool, row);
    this.sum += amount;
  }

  /** Read by the budget guard (SPEC §4.7). */
  total(): number {
    return this.sum;
  }

  /** One entry per tool that cost something, in first-billed order. */
  rows(): Array<{ tool: CanonicalToolId; microUsd: number; calls: number }> {
    return [...this.byTool.values()].map((row) => ({ ...row }));
  }

  /**
   * True exactly once: the caller that gets it writes the ledger rows. The
   * route writes them before the token row on a normal end and tries again in
   * its `finally` for a failed turn (RC-14); this is what keeps the second
   * attempt from billing the same searches twice.
   */
  claimWrite(): boolean {
    if (this.written) return false;
    this.written = true;
    return true;
  }
}

/** The four keyed engines chat `web_search` may use (SPEC §6.3). */
export type SearchEngineId = "tavily" | "serper" | "brave" | "exa";

/**
 * Price of one engine call, in micro-USD (entitlements gap §3.3, list prices
 * 2026-09-23). Exa is billed per request plus per result beyond ten, plus one
 * highlight per result: highlights are the only contents chat asks it for, so
 * its snippets are not empty.
 */
export function enginePriceMicroUsd(engine: SearchEngineId, results: number): number {
  const n = Math.max(0, Math.floor(Number.isFinite(results) ? results : 0));
  switch (engine) {
    case "tavily":
      return 8_000;
    case "serper":
      return n <= 10 ? 1_000 : 2_000;
    case "brave":
      return 5_000;
    case "exa":
      return 7_000 + 1_000 * Math.max(0, n - 10) + 1_000 * n;
  }
}

/** `run_code` sandbox time: env `RUN_CODE_MICRO_USD_PER_SECOND`, default 46 (E2B 2 vCPU + 4 GiB). */
export const RUN_CODE_MICRO_USD_PER_SECOND: number = (() => {
  const raw = Number(process.env.RUN_CODE_MICRO_USD_PER_SECOND);
  return Number.isFinite(raw) && raw > 0 ? raw : 46;
})();

/** One `run_code` call: the sandbox's own wall time, at least one second. */
export function runCodeFeeMicroUsd(sandboxMs: number, perSecond: number = RUN_CODE_MICRO_USD_PER_SECOND): number {
  const ms = Number.isFinite(sandboxMs) ? Math.max(1_000, sandboxMs) : 1_000;
  return Math.round((ms / 1_000) * perSecond);
}

// ── Ledger rows ─────────────────────────────────────────────────────────────

/** Every Juno tool fee row's model starts with this; nothing else does. */
export const JUNO_TOOL_MODEL_PREFIX = "juno-tool:";

export function junoToolSpendModel(tool: CanonicalToolId): string {
  return `${JUNO_TOOL_MODEL_PREFIX}${tool}`;
}

export function isJunoToolSpendModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith(JUNO_TOOL_MODEL_PREFIX);
}

/**
 * A ledger row counts as a REPLY on the usage views unless it is background
 * utility work or a Juno tool fee: a turn that searched three times is still
 * one reply. Its cost is the user's either way and stays in every total.
 */
export function countsAsReply(row: { kind?: string | null; model?: string | null }): boolean {
  return (row.kind || "chat") !== "utility" && !isJunoToolSpendModel(row.model);
}

/** The Prisma `where` fragment for the same rule, for the queries that count replies. */
export const REPLY_ROWS_WHERE = {
  kind: { not: "utility" },
  model: { not: { startsWith: JUNO_TOOL_MODEL_PREFIX } },
} as const;

/** How the usage views name the one group every `juno-tool:*` row folds into. */
export const TOOL_USAGE_COPY = {
  group: "Tools",
} as const;

/**
 * The model name a usage view shows for a ledger row: Juno's tool fees are
 * grouped under one "Tools" line instead of one per tool id, which is not a
 * model a person chose (SPEC §3.9 "Usage views").
 */
export function usageModelLabel(model: string | null | undefined): string {
  if (isJunoToolSpendModel(model)) return TOOL_USAGE_COPY.group;
  return model?.trim() || "unknown";
}

/** What one fee row hands `recordSpend` (a structural subset of `RecordSpendInput`). */
export interface ToolFeeSpendRow {
  userId: string;
  model: string;
  kind: "chat";
  source: "web" | "app";
  promptTokens: 0;
  completionTokens: 0;
  costUsd: number;
}

export function toolFeeSpendRows(
  fees: ToolFeeAccumulator,
  ctx: { userId: string; source: "web" | "app" },
): ToolFeeSpendRow[] {
  return fees.rows().map((row) => ({
    userId: ctx.userId,
    model: junoToolSpendModel(row.tool),
    kind: "chat" as const,
    source: ctx.source,
    promptTokens: 0 as const,
    completionTokens: 0 as const,
    costUsd: row.microUsd / 1e6,
  }));
}

/**
 * Writes the turn's fee rows once (SPEC §3.9 "Ledger rows"). The route calls it
 * before the token row, which carries the reservation `ref` so the hold
 * settles once, and again in its `finally` so a turn that failed after a paid
 * search still bills it (RC-14); the second call writes nothing. Private chats
 * bill the same way: billing is not a trace of content.
 *
 * The fee is never passed as `toolFeesUsd`, which would override the provider's
 * own search fee on the token row.
 */
export async function recordToolFees(
  fees: ToolFeeAccumulator,
  record: (row: ToolFeeSpendRow) => Promise<unknown>,
  ctx: { userId: string; source: "web" | "app" },
): Promise<number> {
  const rows = toolFeeSpendRows(fees, ctx);
  if (rows.length === 0 || !fees.claimWrite()) return 0;
  for (const row of rows) {
    try {
      await record(row);
    } catch {
      // recordSpend never throws by contract; a writer that does must not take
      // the turn's own settlement down with it.
    }
  }
  return rows.length;
}

// ── Gemini grounding (SPEC §3.9 "Gemini free quota") ────────────────────────

/** Grounded queries a deployment gets free per calendar month. */
export const GEMINI_FREE_GROUNDING_QUERIES_PER_MONTH = 5_000;
/** Price per grounded query beyond the free quota ($14 / 1,000). */
export const GEMINI_GROUNDING_USD_PER_QUERY = 0.014;
/** How long the month-to-date sum is trusted in one process. */
export const GROUNDING_QUOTA_TTL_MS = 5 * 60_000;

/**
 * The turn's grounded queries split into free and billable against the
 * deployment's monthly quota. `monthToDate` null means unknown, which is read
 * as the quota already spent: an unreadable counter must not make searches
 * free. Only `billable` reaches `recordSpend` as `webSearchRequests` and the
 * budget guard; `total` is stored as `groundingQueries`.
 */
export function splitGroundingQueries(input: {
  monthToDate: number | null;
  queries: number;
  freeQuota?: number;
}): { free: number; billable: number; total: number } {
  const total = Math.max(0, Math.floor(Number.isFinite(input.queries) ? input.queries : 0));
  if (input.monthToDate === null || !Number.isFinite(input.monthToDate)) return { free: 0, billable: total, total };
  const quota = input.freeQuota ?? GEMINI_FREE_GROUNDING_QUERIES_PER_MONTH;
  const left = Math.max(0, quota - Math.max(0, input.monthToDate));
  const free = Math.min(total, left);
  return { free, billable: total - free, total };
}

/**
 * The grounding fields of the turn's token row: the BILLABLE count as
 * `webSearchRequests` (what `recordSpend` re-prices from and the budget guard
 * reads) and the total as `groundingQueries` (what the month-to-date sum
 * reads). A turn that grounded nothing sets neither.
 */
export function groundingSpendFields(split: { billable: number; total: number }): {
  webSearchRequests?: number;
  groundingQueries?: number;
} {
  if (split.total <= 0) return {};
  return {
    ...(split.billable > 0 ? { webSearchRequests: split.billable } : {}),
    groundingQueries: split.total,
  };
}

/** The first instant of the calendar month (UTC) that `now` falls in. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The deployment's month-to-date grounded queries, cached per process for
 * `GROUNDING_QUOTA_TTL_MS`. `load(since)` is the route's
 * `SUM("groundingQueries")` since the start of the month; a failure is null
 * (quota treated as spent) and is not cached, so the next turn tries again.
 */
export function createGroundingQuotaReader(
  load: (since: Date) => Promise<number>,
  opts: { ttlMs?: number; now?: () => number } = {},
): { monthToDate(): Promise<number | null>; note(queries: number): void } {
  const ttl = opts.ttlMs ?? GROUNDING_QUOTA_TTL_MS;
  const clock = opts.now ?? Date.now;
  let cached: { value: number; at: number; month: number } | null = null;
  return {
    async monthToDate() {
      const nowMs = clock();
      const month = startOfMonthUtc(new Date(nowMs)).getTime();
      if (cached && cached.month === month && nowMs - cached.at < ttl) return cached.value;
      try {
        const value = await load(new Date(month));
        cached = { value: Math.max(0, Number.isFinite(value) ? value : 0), at: nowMs, month };
        return cached.value;
      } catch {
        return null;
      }
    },
    /** Counts this process's own queries into the cached sum until the next refresh. */
    note(queries: number) {
      if (cached && Number.isFinite(queries) && queries > 0) cached.value += Math.floor(queries);
    },
  };
}
