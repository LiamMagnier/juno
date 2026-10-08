/**
 * A scripted, offline Deep Research run for the research protocol
 * (docs/research/PROTOCOL_UPGRADE.md): a planner that returns MECE vectors
 * (with one paraphrased query mixed in), a search backend whose results mix
 * primary records with SEO aggregators and affiliate listicles, pages with
 * real figures, a worker that follows the engine's labels and briefs, and a
 * lead that would stop after round one. Shared by tests/research-protocol.test.ts
 * and the trace script quoted in the doc — no network, no model, no database.
 */

import type { ResearchDeps } from "@/lib/research/engine";
import type { PlannerOutput } from "@/lib/research/planner";
import type { ReviewRoundInput, ReviewRoundOutput, RunWorkerInput, WorkerResult } from "@/lib/research/agents/protocol";
import type { memoryStore } from "./research-store";

export const SCENARIO_GOAL = "Should our 50-person engineering team standardise on GitHub Copilot or Cursor?";

export function scenarioPlan(): PlannerOutput {
  const vector = (question: string, metrics: string[], sources: string[], verify: string[] = []) => ({
    question,
    rationale: "Decides one dimension of the verdict.",
    evidence: { minSources: 2, primary: true, freshness: "within 12 months" },
    vector: { metrics, sources, verify },
  });
  return {
    title: "GitHub Copilot vs Cursor for a 50-person team",
    approach: "Vendor pricing and limits first, then measured performance, then terms.",
    questions: [
      vector("What does each cost per seat on business plans?", ["business plan price per seat per month", "annual discount"], ["official pricing page"]),
      vector("What usage limits and rate limits apply to premium requests?", ["premium requests per month", "rate limit tier"], ["usage limits documentation"], ["unlimited completions claim"]),
      vector("Which models and context windows does each expose?", ["context window tokens", "models available"], ["models documentation", "changelog"]),
      vector("What do privacy, IP indemnity and data retention terms say?", ["data retention days", "IP indemnity coverage"], ["trust center", "terms of service"]),
      vector("What do measured productivity studies and user issue trackers report?", ["measured task completion speedup"], ["GitHub issues", "published studies"], ["55% faster claim"]),
    ],
    clarifications: [],
    sources: ["vendor documentation", "pricing pages", "changelogs"],
    queries: [
      "GitHub Copilot pricing business plan per seat",
      "Cursor pricing business plan per seat",
      "GitHub Copilot or Cursor for our engineering team", // a paraphrase of the goal — must be dropped
      "Cursor rate limits premium requests documentation",
      "GitHub Copilot premium requests limits documentation",
    ],
    scope: { breadth: "broad", freshness: "recent", primarySources: true, quick: false },
    language: "en",
  };
}

/** Boilerplate that makes a fixture page the length of a real one (over the 2,000-character "read" bar). */
const CHROME = `\n\n${"Navigation, footer and related links. ".repeat(60)}`;

/** Pages the fake web serves, by URL. */
const PAGES: Record<string, { title: string; text: string; publishedAt?: Date }> = {
  "https://docs.github.com/en/copilot/about-github-copilot/plans-for-github-copilot": {
    title: "Plans for GitHub Copilot - GitHub Docs",
    text: `${"GitHub Copilot Business costs $19 per user per month. Copilot Enterprise costs $39 per user per month. ".repeat(6)}\n\nCopilot Business includes 300 premium requests per user per month. Additional premium requests are billed at $0.04 per request.`,
    publishedAt: new Date("2026-08-01T00:00:00.000Z"),
  },
  "https://cursor.com/pricing": {
    title: "Pricing | Cursor",
    text: `${"Cursor Teams costs $40 per user per month. ".repeat(6)}\n\nCursor introduced a new Ultra plan with higher rate limits for premium models in 2025. Teams includes 500 requests per user per month.`,
    publishedAt: new Date("2026-07-15T00:00:00.000Z"),
  },
  "https://www.g2.com/compare/github-copilot-vs-cursor": {
    title: "GitHub Copilot vs Cursor | G2",
    text: "Compare GitHub Copilot vs Cursor. Users rate Cursor 4.7 and Copilot 4.5. Cursor costs $20 per month.",
  },
  "https://bestaitools.example.net/top-10-ai-coding-assistants-2026": {
    title: "Top 10 Best AI Coding Assistants in 2026 (Tested)",
    text: "This post contains affiliate links and we may earn a commission. Cursor costs $16 per month. Copilot is 55% faster.",
  },
  "https://github.com/github/copilot-docs/issues/112": {
    title: "Premium request limits reached mid-sprint · Issue #112",
    text: `${"Users report hitting the premium request limit after the March 2026 change. ".repeat(5)}\n\nThe rate limit resets monthly.`,
    publishedAt: new Date("2026-04-02T00:00:00.000Z"),
  },
  "https://cursor.com/changelog": {
    title: "Changelog | Cursor",
    text: `${"Cursor 1.4 adds a 200,000 token context window for Max mode. ".repeat(5)}\n\nThe Ultra plan rate limits are 20x Pro.`,
    publishedAt: new Date("2026-08-20T00:00:00.000Z"),
  },
};

/** What a search returns: aggregator and affiliate pages first, the way an SEO-ranked engine does. */
function hitsFor(query: string) {
  const q = query.toLowerCase();
  const urls = [
    "https://bestaitools.example.net/top-10-ai-coding-assistants-2026",
    "https://www.g2.com/compare/github-copilot-vs-cursor",
    ...(q.includes("cursor") ? ["https://cursor.com/pricing", "https://cursor.com/changelog"] : []),
    ...(q.includes("copilot") || q.includes("github") ? ["https://docs.github.com/en/copilot/about-github-copilot/plans-for-github-copilot", "https://github.com/github/copilot-docs/issues/112"] : []),
  ];
  return urls.map((url) => ({ url, title: PAGES[url]!.title, snippet: PAGES[url]!.text.slice(0, 120), publishedAt: PAGES[url]!.publishedAt ?? null }));
}

export interface ScenarioTrace {
  searches: Array<{ query: string; by: string }>;
  fetched: string[];
  workerBriefs: Array<{ workerId: string; round: number; whatToFind: string }>;
  refusedSearches: string[];
  firstHitTiers: string[];
  reviews: ReviewRoundInput[];
}

/**
 * The deps for one scenario run, and the trace it records. `leadSays` is what
 * the scripted lead decides after every round.
 */
export function scenarioDeps(
  store: ReturnType<typeof memoryStore>["store"],
  opts: { leadSays?: ReviewRoundOutput["decision"] } = {}
): { deps: ResearchDeps; trace: ScenarioTrace } {
  const trace: ScenarioTrace = { searches: [], fetched: [], workerBriefs: [], refusedSearches: [], firstHitTiers: [], reviews: [] };
  const deps: ResearchDeps = {
    store,
    async plan() {
      throw new Error("the protocol scenario plans through draftPlan");
    },
    async draftPlan() {
      return { ok: true, output: scenarioPlan(), costMicroUsd: 2_000, plannedBy: "model" };
    },
    async search({ query }) {
      trace.searches.push({ query, by: "engine" });
      return { hits: hitsFor(query), costMicroUsd: 1_000 };
    },
    async fetchPage({ url }) {
      trace.fetched.push(url);
      const page = PAGES[url];
      if (!page) return { skipped: "empty" };
      return { title: page.title, text: page.text + CHROME, costMicroUsd: 500, ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}) };
    },
    async runWorker(input: RunWorkerInput): Promise<WorkerResult> {
      const { delegation, round } = input.brief;
      trace.workerBriefs.push({ workerId: delegation.workerId, round, whatToFind: delegation.whatToFind });
      let calls = 0;
      // Round 2 workers run the micro-queries they were briefed with; round 1
      // workers search the vector's primary record, and one of them also
      // re-runs a seed search verbatim (it must be refused, free).
      const micro = /run these first: ([^.]+)\./.exec(delegation.whatToFind)?.[1]?.split("; ") ?? [];
      const queries = round > 1 && micro.length ? micro.slice(0, 1) : [`${delegation.objective.split(" ").slice(2, 6).join(" ")} Cursor Copilot official docs`];
      if (round === 1 && delegation.workerId === "w1-1") queries.push("GitHub Copilot pricing business plan per seat");
      for (const query of queries) {
        calls += 1;
        const found = await input.tools.search(query);
        if (found.result.hits.length === 0) {
          trace.refusedSearches.push(query);
          continue;
        }
        trace.searches.push({ query, by: delegation.workerId });
        trace.firstHitTiers.push(found.result.hits[0]!.quality ?? "");
        // The primary record whose page best matches the brief.
        const words = new Set(delegation.whatToFind.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
        const fit = (url: string) => (PAGES[url]?.text ?? "").toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
        const primaries = found.result.hits.filter((hit) => hit.quality === "primary record");
        const target = [...primaries].sort((a, b) => fit(b.url) - fit(a.url))[0] ?? found.result.hits[0]!;
        calls += 1;
        const page = await input.tools.openPage(target.url);
        if (!page.result.ok) continue;
        const text = PAGES[target.url]?.text ?? "";
        // The figure-bearing sentence that best matches the brief.
        const brief = new Set(delegation.whatToFind.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
        const sentences = [...new Set(text.split(/(?<=\.)\s+/).map((s) => s.trim()))].filter((s) => /\$|\d/.test(s));
        const overlap = (s: string) => s.toLowerCase().split(/\W+/).filter((w) => brief.has(w)).length;
        const sentence = [...sentences].sort((a, b) => overlap(b) - overlap(a))[0] ?? text.split(". ")[0]!;
        calls += 1;
        await input.tools.noteFinding({ claim: sentence.trim(), quote: sentence.trim().slice(0, 80), url: target.url });
      }
      return { summary: `Worked ${delegation.objectiveId}.`, openQuestions: [], followUps: [], tokens: 1_000, costMicroUsd: 2_000, reason: "done", toolCalls: calls, elapsedMs: 5 };
    },
    async reviewRound(input: ReviewRoundInput): Promise<ReviewRoundOutput> {
      trace.reviews.push(input);
      const coverage = Object.fromEntries(input.objectives.map((objective) => [objective.id, 0.85]));
      return { coverage, gaps: [], contradictions: [], decision: opts.leadSays ?? "synthesize", reason: "Every vector has sourced evidence.", costMicroUsd: 1_000 };
    },
    async synthesize() {
      return {
        report: `# Copilot vs Cursor\n\n<!-- juno:section=bottom-line -->\n## Executive verdict\nCopilot Business is cheaper per seat [1].\n\n${"The evidence is drawn from vendor pricing pages. ".repeat(10)}`,
        costMicroUsd: 10_000,
      };
    },
    hash: (text) => `h${text.length}`,
    now: () => new Date("2026-10-08T10:00:00.000Z"),
  };
  return { deps, trace };
}
