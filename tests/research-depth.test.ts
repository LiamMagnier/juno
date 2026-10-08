import assert from "node:assert/strict";
import test from "node:test";

import { buildResearchCorpus } from "@/lib/research/corpus";
import {
  footprintOf,
  hardness,
  MAX_EXTRA_ROUNDS,
  newFigureCount,
  nextExtension,
  saturated,
  type DepthSignals,
} from "@/lib/research/depth";
import { MAX_RESEARCH_ROUNDS, parsePlan, planBudget } from "@/lib/research/domain";
import { createResearchEngine } from "@/lib/research/engine";
import type { RunWorkerInput, WorkerResult } from "@/lib/research/agents/protocol";
import { envelopeFor, plannerOutput, reworkDeps } from "./fixtures/research-deps";
import { memoryStore } from "./fixtures/research-store";

/*
 * Scale: adaptive depth (more rounds and pages for hard questions, bounded,
 * paid for within the usage window's room), early stop when a round finds
 * nothing new, and found-versus-read in the methodology.
 */

const HARD: DepthSignals = {
  vectors: 5,
  conflicts: 1,
  missingFigures: 7,
  unverified: 0,
  leads: 1,
  roundFindings: 6,
  newClaims: 5,
  newFigures: 4,
  findings: 12,
  round: 2,
};
const ENVELOPE = { rounds: 2, pages: 40, workerTokens: 900_000 };
const NOW = new Date("2026-10-08T00:00:00.000Z");

test("hardness: many vectors, conflicts, missing figures, unverified claims and leads add up", () => {
  assert.deepEqual(hardness(HARD), { score: 4, hard: true, reasons: ["5 vectors", "1 conflicting figure", "7 figures still missing"] });
  assert.equal(hardness({ ...HARD, vectors: 3, conflicts: 0, missingFigures: 2 }).hard, false);
});

test("saturation: a round with no new pages, or no new figures and few new pages, ends the run's rounds", () => {
  assert.equal(saturated({ ...HARD, round: 1, newClaims: 0 }), false, "the first round is never saturated");
  assert.equal(saturated({ ...HARD, roundFindings: 0 }), true);
  assert.equal(saturated({ ...HARD, newClaims: 1, findings: 30 }), true);
  assert.equal(saturated({ ...HARD, newFigures: 0, newClaims: 2, roundFindings: 6 }), true);
  assert.equal(saturated(HARD), false);
  assert.equal(newFigureCount(["Pro is $20 per month", "Team is $40 per month"], ["Pro costs $20/mo"]), 1);
  assert.equal(newFigureCount(["Pro is $20 per month"], ["Pro costs $20 per month"]), 0);
});

test("nextExtension: one round at a time, at most MAX_EXTRA_ROUNDS, pages +50% at most, never past the engine's caps", () => {
  const first = nextExtension({ signals: HARD, envelope: ENVELOPE, current: null, maxRounds: MAX_RESEARCH_ROUNDS, maxPages: 250, now: NOW });
  assert.deepEqual(first && { ...first, at: "" }, { extraRounds: 1, extraPages: 12, extraTokens: 450_000, reasons: hardness(HARD).reasons, at: "" });
  const second = nextExtension({ signals: HARD, envelope: ENVELOPE, current: first, maxRounds: MAX_RESEARCH_ROUNDS, maxPages: 250, now: NOW });
  assert.equal(second?.extraRounds, 2);
  assert.equal(second?.extraPages, 20, "capped at +50% of the envelope's 40 pages");
  assert.equal(nextExtension({ signals: HARD, envelope: ENVELOPE, current: second, maxRounds: MAX_RESEARCH_ROUNDS, maxPages: 250, now: NOW }), null);
  assert.equal(MAX_EXTRA_ROUNDS, 2);
  // The engine's round cap and the run page cap bind too.
  assert.equal(nextExtension({ signals: HARD, envelope: { ...ENVELOPE, rounds: 6 }, current: null, maxRounds: 6, maxPages: 250, now: NOW }), null);
  assert.equal(nextExtension({ signals: HARD, envelope: { ...ENVELOPE, pages: 240 }, current: null, maxRounds: 6, maxPages: 250, now: NOW })?.extraPages, 10);
  // Not hard, or saturated: no extension.
  assert.equal(nextExtension({ signals: { ...HARD, conflicts: 0, missingFigures: 0 }, envelope: ENVELOPE, current: null, maxRounds: 6, maxPages: 250, now: NOW }), null);
  assert.equal(nextExtension({ signals: { ...HARD, roundFindings: 0 }, envelope: ENVELOPE, current: null, maxRounds: 6, maxPages: 250, now: NOW }), null);
});

test("planBudget adds the recorded extension to the envelope's rounds, pages and tokens; the clock stays", () => {
  const envelope = envelopeFor({ rounds: 2, pages: 40, workerTokens: 900_000 });
  const plan = parsePlan({ queries: [], objectives: [], envelope, depth: { extraRounds: 1, extraPages: 12, extraTokens: 450_000, reasons: ["5 vectors"], at: "x" } });
  const budget = planBudget(plan);
  assert.equal(budget.rounds, 3);
  assert.equal(budget.pages, 52);
  assert.equal(budget.tokens, 1_350_000);
  assert.equal(budget.wallClockMs, envelope.wallClockMs);
  // A tampered plan cannot buy more than the ceilings.
  const tampered = parsePlan({ queries: [], objectives: [], envelope, depth: { extraRounds: 40, extraPages: 9_999, extraTokens: 1e12, reasons: [], at: "" } });
  assert.equal(tampered.depth?.extraRounds, 2);
  assert.equal(tampered.depth?.extraPages, 250);
});

test("the methodology gets found-versus-read from the run's own numbers", () => {
  const plan = parsePlan({
    queries: [],
    objectives: [],
    seedPagesRead: 14,
    issuedQueries: ["a b", "c d"],
    workerQueries: ["e f", "A B"],
    rounds: [{ round: 1, delegations: [], pagesRead: 9, toolCalls: 1, tokens: 1, claims: 1, newClaims: 1, startedAt: "", finishedAt: "" }],
    depth: { extraRounds: 1, extraPages: 12, extraTokens: 1, reasons: ["5 vectors", "1 conflicting figure"], at: "" },
  });
  const footprint = footprintOf(plan, 180, 31);
  assert.deepEqual(footprint, { found: 180, read: 23, citable: 31, searches: 3, rounds: 1, extended: { rounds: 1, reasons: ["5 vectors", "1 conflicting figure"] } });
  const corpus = buildResearchCorpus("goal", plan, [], [], { footprint });
  assert.match(corpus, /# Research Footprint[^\n]*found[^\n]*read in full\)\n- Sources found: 180\n- Pages read in full: 23\n/);
  assert.match(corpus, /Research rounds: 1 \(1 added for a hard question: 5 vectors, 1 conflicting figure\)/);
});

// ── End to end ──────────────────────────────────────────────────────────────

function hardRunDeps(store: ReturnType<typeof memoryStore>["store"], opts: { ceilingMicroUsd?: number; newEachRound?: boolean } = {}) {
  const rounds: number[] = [];
  const vectors = Array.from({ length: 5 }, (_, i) => ({
    question: `Vector ${i + 1}: what is the figure for dimension ${i + 1}?`,
    rationale: "One dimension.",
    evidence: { minSources: 2, primary: true },
    vector: { metrics: [`dimension ${i + 1} throughput limit`, `dimension ${i + 1} renewal price`], sources: ["official documentation"], verify: [] },
  }));
  const deps = reworkDeps(store, {
    async draftPlan() {
      return { ok: true, output: plannerOutput({ questions: vectors, queries: ["dimension figures documentation"] }), costMicroUsd: 2_000 };
    },
    async sizeRun() {
      return envelopeFor({ rounds: 2, pages: 40, workers: 5, ceilingMicroUsd: opts.ceilingMicroUsd ?? 50_000_000 });
    },
    async search({ query }) {
      return { hits: [{ url: `https://docs.example/${encodeURIComponent(query)}`, title: query, snippet: "…" }], costMicroUsd: 1_000 };
    },
    async fetchPage({ url }) {
      const n = url.length;
      return { title: url, text: `Measured value ${n} units recorded on the page. ${"Context sentence. ".repeat(20)}`, costMicroUsd: 500 };
    },
    async runWorker(input: RunWorkerInput): Promise<WorkerResult> {
      const { delegation, round } = input.brief;
      rounds.push(round);
      // Distinct words per round, so the near-duplicate guard lets each round search anew.
      const tag = opts.newEachRound === false ? "same" : ["", "alpha", "bravo", "charlie", "delta", "echo", "foxtrot"][round];
      const found = await input.tools.search(`${delegation.objectiveId} evidence ${tag} ${["", "north", "south", "east", "west", "centre"][Number(delegation.workerId.split("-")[1])]}`);
      const hit = found.result.hits[0];
      if (hit) {
        const page = await input.tools.openPage(hit.url);
        if (page.result.ok) {
          const figure = 100 + round * 10 + Number(delegation.workerId.split("-")[1]);
          await input.tools.noteFinding({ claim: `The measured value is ${figure} units.`, quote: "Measured value", url: hit.url });
        }
      }
      return { summary: "done", openQuestions: [], followUps: [], tokens: 1_000, costMicroUsd: 1_000, reason: "done", toolCalls: 3, elapsedMs: 5 };
    },
    async reviewRound(input) {
      const coverage = Object.fromEntries(input.objectives.map((objective) => [objective.id, 0.85]));
      return { coverage, gaps: [], contradictions: [], decision: "synthesize", reason: "Looks covered.", costMicroUsd: 1_000 };
    },
  });
  return { deps, rounds };
}

test("end to end: a hard question that keeps finding new facts gets extra rounds, bounded, recorded and explained", async () => {
  const { store, events } = memoryStore();
  const { deps } = hardRunDeps(store);
  const engine = createResearchEngine(deps);
  const run = await engine.start({ userId: "u", goal: "What are the limits and prices across all five dimensions?", confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.state, "completed", String(done?.error));
  const plan = parsePlan(done?.plan);
  assert.equal(plan.envelope?.rounds, 2);
  assert.equal(plan.depth?.extraRounds, MAX_EXTRA_ROUNDS, JSON.stringify(plan.rounds?.map((r) => r.review)));
  assert.equal(plan.rounds?.length, 2 + MAX_EXTRA_ROUNDS, "the extension ran, and stopped at its ceiling");
  assert.ok((plan.depth?.extraPages ?? 0) <= 20);
  const extended = events.filter((event) => event.kind === "round_reviewed" && (event.payload as { extended?: unknown }).extended);
  assert.equal(extended.length, MAX_EXTRA_ROUNDS);
  assert.match(String((extended[0]!.payload as { reason?: string }).reason), /Depth extended for a hard question \(5 vectors/);
});

test("end to end: no extension once the usage window is spent (the window, not a per-run price, is the limit)", async () => {
  const { store } = memoryStore();
  const { deps } = hardRunDeps(store);
  let asked = 0;
  const engine = createResearchEngine({
    ...deps,
    // Round 1 and round 2 start inside the window; it is spent by the time
    // round 2 is reviewed, which is when the extension would be decided.
    async windowSpent() {
      asked += 1;
      return asked >= 3;
    },
  });
  const run = await engine.start({ userId: "u", goal: "What are the limits and prices across all five dimensions?", confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  const plan = parsePlan(done?.plan);
  assert.equal(done?.state, "completed", String(done?.error));
  assert.equal(plan.depth, undefined);
  assert.equal(plan.rounds?.length, 2);
  assert.ok(plan.windowSpentAt, "the spent window stays recorded on the plan");
});

test("end to end: a round that found nothing new stops the rounds early, extension or not", async () => {
  const { store } = memoryStore();
  const { deps } = hardRunDeps(store, { newEachRound: false });
  const engine = createResearchEngine(deps);
  const run = await engine.start({ userId: "u", goal: "What are the limits and prices across all five dimensions?", confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  const plan = parsePlan(done?.plan);
  assert.equal(plan.depth, undefined, "a saturated round buys no extension");
  assert.ok((plan.rounds?.length ?? 0) <= 2);
});
