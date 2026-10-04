/**
 * One vocabulary for every budget a person can set (BRIEF §49).
 *
 * Four scopes already existed, each with its own words and its own store:
 *
 *   account  — `Settings.monthlySpendCapEur` + the plan, enforced by
 *              `checkBudget` / `checkUsageWindows` (src/lib/spend.ts);
 *   agent    — `Agent.budgetMicroUsd`, a weekly cap inside the account's
 *              weekly window (src/lib/agents/budget.ts);
 *   routine  — `WorkSchedule.maxCostMicroUsd`, the ceiling each firing runs
 *              under (src/lib/work/budget.ts `narrowestBudget`);
 *   run      — `WorkRun.maxCostMicroUsd` / `ResearchRun.budgetMicroUsd`,
 *              the hard ceiling one run's guard stops at.
 *
 * This module does not add a fifth store or re-implement any gate: the
 * enforcement stays where it was. It gives the four one shape — a
 * `BudgetLine` with a hard ceiling, current spend, what is held, and the
 * window — so every surface that shows a budget says the same sentence, and
 * so "which budget binds" is computed once (`bindingBudget`).
 *
 * Pure and client-safe. Money is integer micro-USD throughout, like the ledger.
 */

export const BUDGET_SCOPES = ["account", "agent", "routine", "run"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** The period a ceiling counts over. `per_run` resets with every run. */
export type BudgetWindow = "month" | "session" | "week" | "per_run";

export interface BudgetLine {
  scope: BudgetScope;
  /** Who it belongs to, for the sentence ("Scout", "Morning brief"). */
  subject: string;
  /** Hard ceiling, micro-USD. Null = this scope sets none (a narrower or wider one still applies). */
  ceilingMicroUsd: number | null;
  /** Settled spend inside the window. */
  spentMicroUsd: number;
  /** Held by work still running (reservations), counted against the ceiling. */
  heldMicroUsd: number;
  window: BudgetWindow;
  /** When the window frees up; null for per-run and for no-window scopes. */
  resetsAtMs: number | null;
}

export function budgetRemaining(line: BudgetLine): number | null {
  if (line.ceilingMicroUsd == null) return null;
  return Math.max(0, line.ceilingMicroUsd - line.spentMicroUsd - line.heldMicroUsd);
}

/** "Up to": at the ceiling exactly is spent (the agents rule, applied to every scope). */
export function budgetExhausted(line: BudgetLine): boolean {
  return line.ceilingMicroUsd != null && line.spentMicroUsd + line.heldMicroUsd >= line.ceilingMicroUsd;
}

/** 0..1 of the ceiling used, or null when there is no ceiling. */
export function budgetShare(line: BudgetLine): number | null {
  if (line.ceilingMicroUsd == null || line.ceilingMicroUsd <= 0) return null;
  return Math.min(1, (line.spentMicroUsd + line.heldMicroUsd) / line.ceilingMicroUsd);
}

/**
 * The line that stops work first: least room left. A scope with no ceiling
 * never binds. Ties go to the narrower scope (run < routine < agent < account),
 * because that is the sentence that names what the person can change.
 */
export function bindingBudget(lines: readonly BudgetLine[]): BudgetLine | null {
  // Narrower scopes sit later in BUDGET_SCOPES.
  const order = (s: BudgetScope) => BUDGET_SCOPES.indexOf(s);
  let best: BudgetLine | null = null;
  for (const line of lines) {
    const room = budgetRemaining(line);
    if (room == null) continue;
    const bestRoom = best ? budgetRemaining(best)! : Infinity;
    if (room < bestRoom || (room === bestRoom && best && order(line.scope) > order(best.scope))) best = line;
  }
  return best;
}

/** The smallest room left across lines, or null when none has a ceiling. */
export function remainingUnder(lines: readonly BudgetLine[]): number | null {
  const binding = bindingBudget(lines);
  return binding ? budgetRemaining(binding) : null;
}

export function formatMicroUsdAmount(microUsd: number): string {
  const usd = Math.max(0, microUsd) / 1_000_000;
  return `$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`;
}

const WINDOW_WORDS: Record<BudgetWindow, string> = {
  month: "this month",
  session: "in this 5-hour window",
  week: "this week",
  per_run: "per run",
};

/**
 * The one sentence: "$1.20 of $5.00 this week" / "$0.40 spent this month, no
 * ceiling of its own". Every budget surface uses this.
 */
export function describeBudgetLine(line: BudgetLine): string {
  const spent = formatMicroUsdAmount(line.spentMicroUsd + line.heldMicroUsd);
  if (line.ceilingMicroUsd == null) {
    return line.window === "per_run"
      ? "No ceiling of its own — the account's window applies"
      : `${spent} spent ${WINDOW_WORDS[line.window]}, no ceiling of its own`;
  }
  if (line.window === "per_run") {
    return `Each run stops at ${formatMicroUsdAmount(line.ceilingMicroUsd)}`;
  }
  return `${spent} of ${formatMicroUsdAmount(line.ceilingMicroUsd)} ${WINDOW_WORDS[line.window]}`;
}

// ── Adapters: each existing store's numbers, as a line ─────────────────────

export function accountBudgetLine(status: {
  budgetMicroUsd: number | null;
  spentMicroUsd: number;
  reservedMicroUsd: number;
  resetsAtMs: number | null;
}): BudgetLine {
  return {
    scope: "account",
    subject: "Your account",
    ceilingMicroUsd: status.budgetMicroUsd,
    spentMicroUsd: status.spentMicroUsd,
    heldMicroUsd: status.reservedMicroUsd,
    window: "month",
    resetsAtMs: status.resetsAtMs,
  };
}

export function agentBudgetLine(input: {
  name: string;
  capMicroUsd: number | null;
  spentMicroUsd: number;
  resetsAtMs: number | null;
}): BudgetLine {
  return {
    scope: "agent",
    subject: input.name,
    ceilingMicroUsd: input.capMicroUsd,
    spentMicroUsd: input.spentMicroUsd,
    heldMicroUsd: 0,
    window: "week",
    resetsAtMs: input.resetsAtMs,
  };
}

/**
 * A routine's ceiling is per firing (zero = none of its own); its spend is
 * what its runs cost this month, shown beside it so the ceiling is never read
 * without the number it is a ceiling on.
 */
export function routineBudgetLines(input: {
  name: string;
  maxCostMicroUsd: number;
  spentThisMonthMicroUsd: number;
}): { perRun: BudgetLine; month: BudgetLine } {
  return {
    perRun: {
      scope: "routine",
      subject: input.name,
      ceilingMicroUsd: input.maxCostMicroUsd > 0 ? input.maxCostMicroUsd : null,
      spentMicroUsd: 0,
      heldMicroUsd: 0,
      window: "per_run",
      resetsAtMs: null,
    },
    month: {
      scope: "routine",
      subject: input.name,
      ceilingMicroUsd: null,
      spentMicroUsd: input.spentThisMonthMicroUsd,
      heldMicroUsd: 0,
      window: "month",
      resetsAtMs: null,
    },
  };
}

export function runBudgetLine(input: { label: string; maxCostMicroUsd: number | null; costMicroUsd: number }): BudgetLine {
  return {
    scope: "run",
    subject: input.label,
    ceilingMicroUsd: input.maxCostMicroUsd && input.maxCostMicroUsd > 0 ? input.maxCostMicroUsd : null,
    spentMicroUsd: input.costMicroUsd,
    heldMicroUsd: 0,
    window: "per_run",
    resetsAtMs: null,
  };
}

/** A routine's spend line: what its runs cost this billing period. */
export function describeRoutineSpend(line: BudgetLine): string {
  return `Its runs have cost ${formatMicroUsdAmount(line.spentMicroUsd)} this billing period`;
}

/** A run's live line reads differently from a routine's ceiling: it has spend. */
export function describeRunLine(line: BudgetLine): string {
  if (line.ceilingMicroUsd == null) return `${formatMicroUsdAmount(line.spentMicroUsd)} so far, no ceiling of its own`;
  return `${formatMicroUsdAmount(line.spentMicroUsd)} of ${formatMicroUsdAmount(line.ceilingMicroUsd)} for this run`;
}
