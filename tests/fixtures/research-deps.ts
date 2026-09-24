import type { ResearchDeps, ResearchStore } from "@/lib/research/engine";
import type { PlannerOutput } from "@/lib/research/planner";
import type { ResearchEnvelope } from "@/types/research";

/**
 * Engine deps for the rework's research tests (lease, writer, planner,
 * audit cap): every farmed-out call succeeds cheaply and at once, the
 * structured planner answers with `plannerOutput`, and the writer returns a
 * report the B6 check accepts. A test overrides the one call it is about.
 */

export const USABLE_REPORT = `# Heat pumps in cold climates\n\n## Bottom line\nThey keep working below freezing [1].\n\n## Key findings\n${"Field trials recorded seasonal efficiency above two and a half in Nordic homes [1]. ".repeat(6).trim()}`;

export function plannerOutput(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    title: "Heat pumps in cold climates",
    approach: "Field trials first, then manufacturer data, then the regulators.",
    questions: [
      { question: "How do heat pumps perform below freezing?", rationale: "The core claim.", evidence: { minSources: 2, primary: true } },
      { question: "What do they cost to run in Nordic winters?", rationale: "The cost side.", evidence: { minSources: 2, primary: false } },
      { question: "Where do field trials and vendors disagree?", rationale: "Conflicts.", evidence: { minSources: 2, primary: false } },
    ],
    clarifications: [],
    sources: ["field trials", "regulator data"],
    queries: ["heat pump field trial cold climate", "heat pump running cost nordic winter"],
    scope: { breadth: "broad", freshness: "any", primarySources: true, quick: false },
    language: "en",
    ...overrides,
  };
}

/** One question, focused, nothing to ask: the tiny scope that skips the card (R2). */
export const TINY_PLAN = plannerOutput({
  questions: [{ question: "What is the rated COP of the Daikin Altherma 3 at -7C?", rationale: "The question.", evidence: { minSources: 1, primary: true } }],
  queries: ["daikin altherma 3 cop -7c"],
  scope: { breadth: "focused", freshness: "any", primarySources: false, quick: true },
});

export function envelopeFor(overrides: Partial<ResearchEnvelope> = {}): ResearchEnvelope {
  const caps = { maxWorkers: 8, maxRounds: 3, maxPages: 250, maxMinutes: 30, secondsPerPage: 9, fixedMinutes: 2 };
  return {
    v: 1,
    ceilingMicroUsd: 5_000_000,
    reserve: { writerMicroUsd: 400_000, auditMicroUsd: 100_000 },
    workers: 3,
    rounds: 2,
    toolCallsPerWorker: 12,
    pages: 24,
    resultsPerQuery: 12,
    engines: ["tavily"],
    workerTokens: 900_000,
    wallClockMs: 30 * 60_000,
    workerWallClockMs: 8 * 60_000,
    judgeCalls: 18,
    leadModel: "lead-model",
    limitedBy: "scope",
    estimate: { minutesUpTo: 9, pagesUpTo: 24 },
    caps,
    ...overrides,
  };
}

export function reworkDeps(store: ResearchStore, over: Partial<ResearchDeps> = {}): ResearchDeps {
  return {
    store,
    async plan() {
      throw new Error("the rework engine plans through draftPlan");
    },
    async draftPlan() {
      return { ok: true, output: plannerOutput(), costMicroUsd: 2_000 };
    },
    async search({ query }) {
      return {
        hits: [{ url: `https://example.com/${encodeURIComponent(query)}`, title: query, snippet: "…" }],
        costMicroUsd: 1_000,
      };
    },
    async fetchPage({ url }) {
      return { title: `Page at ${url}`, text: `${"a".repeat(200)}\n\n${"b".repeat(200)}`, costMicroUsd: 500 };
    },
    async synthesize() {
      return { report: USABLE_REPORT, costMicroUsd: 10_000 };
    },
    hash: (text) => `h${text.length}`,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    ...over,
  };
}
