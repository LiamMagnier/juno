import test from "node:test";
import assert from "node:assert/strict";
import { createResearchEngine } from "@/lib/research/engine";
import { parsePlan, type ResearchObjective } from "@/lib/research/domain";
import {
  draftResearchPlan,
  parsePlannerOutput,
  planShallowness,
  plannedResearch,
  type PlannerOutput,
} from "@/lib/research/planner";
import { dedupeQueries, isNearDuplicateQuery, restatesGoal } from "@/lib/research/query-dedupe";
import { assessSource, rankByPolicy } from "@/lib/research/source-policy";
import { scoreSource, sourceTypeOf } from "@/lib/research/claim-analysis";
import { MAX_LEADS_PER_ROUND, entityOf, extractLeads } from "@/lib/research/leads";
import { auditGaps } from "@/lib/research/gap-audit";
import { chatReportContract, reportWriterContract } from "@/lib/research/corpus.prompt";
import { buildResearchCorpus } from "@/lib/research/corpus";
import { REPORT_SECTION_ORDER, reportSections } from "@/lib/research/report-structure";
import { parseReport } from "@/components/research/report-structure";
import { questionViews } from "@/lib/research/view";
import { memoryStore } from "./fixtures/research-store";
import { SCENARIO_GOAL, scenarioDeps, scenarioPlan } from "./fixtures/research-protocol-scenario";

/*
 * The owner's Deep Research protocol (docs/research/PROTOCOL_UPGRADE.md), one
 * stage at a time, then end to end on a scripted offline run.
 */

// ── Stage 1: decomposition ──────────────────────────────────────────────────

const GOAL = "Should we use GitHub Copilot or Cursor for our engineering team?";

function paraphrasePlan(): PlannerOutput {
  return {
    title: "Copilot or Cursor",
    approach: "",
    questions: [
      { question: "Should we use GitHub Copilot or Cursor for the engineering team?", rationale: "", evidence: { minSources: 2, primary: false } },
      { question: "Is GitHub Copilot or Cursor better for an engineering team?", rationale: "", evidence: { minSources: 2, primary: false } },
    ],
    clarifications: [],
    sources: [],
    queries: ["GitHub Copilot or Cursor engineering team", "Cursor or GitHub Copilot for engineering teams", "use Copilot or Cursor team"],
    scope: { breadth: "broad", freshness: "any", primarySources: false, quick: false },
    language: "en",
  };
}

test("stage 1: a vector carries its metrics, primary sources and claims to verify through parse and plan", () => {
  const parsed = parsePlannerOutput(
    JSON.stringify({
      ...scenarioPlan(),
      questions: scenarioPlan().questions.map((q) => ({
        question: q.question,
        rationale: q.rationale,
        evidence: q.evidence,
        metrics: q.vector!.metrics,
        primarySources: q.vector!.sources,
        verify: q.vector!.verify,
      })),
    })
  );
  assert.ok(parsed);
  assert.equal(parsed.questions.length, 5, "4 to 6 vectors survive the parse");
  assert.deepEqual(parsed.questions[1]!.vector, {
    metrics: ["premium requests per month", "rate limit tier"],
    sources: ["usage limits documentation"],
    verify: ["unlimited completions claim"],
  });
  const planned = plannedResearch(parsed, { goal: SCENARIO_GOAL });
  assert.equal(planned.objectives.length, 5);
  assert.ok(planned.objectives.every((objective) => objective.vector?.metrics.length), "every objective keeps its vector");
  // Stored and read back through the tolerant plan parser.
  const roundTrip = parsePlan({ queries: planned.queries, objectives: planned.objectives });
  assert.deepEqual(roundTrip.objectives[3]!.vector, planned.objectives[3]!.vector);
});

test("stage 1: a decomposition passes the shallowness check; a paraphrase plan fails it with named reasons", () => {
  assert.deepEqual(planShallowness(scenarioPlan(), SCENARIO_GOAL), []);
  const reasons = planShallowness(paraphrasePlan(), GOAL);
  assert.ok(reasons.some((r) => /Only 2 vectors/.test(r)));
  assert.ok(reasons.some((r) => /restate the request/.test(r)));
  assert.ok(reasons.some((r) => /concrete metric/.test(r)));
  assert.ok(reasons.some((r) => /search the request itself/.test(r)));
  // A one-fact question or a quick scope is never judged.
  assert.deepEqual(planShallowness({ ...paraphrasePlan(), scope: { ...paraphrasePlan().scope, quick: true } }, GOAL), []);
  assert.deepEqual(planShallowness(paraphrasePlan(), "ethanol boiling?"), []);
});

test("stage 1: a shallow plan gets the one retry, told what to fix; the better plan wins and calls stay at two", async () => {
  const prompts: string[] = [];
  const replies = [JSON.stringify(paraphrasePlan()), JSON.stringify({ ...scenarioPlan(), questions: scenarioPlan().questions.map((q) => ({ ...q, metrics: q.vector!.metrics, primarySources: q.vector!.sources, verify: q.vector!.verify })) })];
  const drafted = await draftResearchPlan(
    { goal: GOAL, constraints: [], pinnedSources: [], dateLine: "Today is Thursday, 8 October 2026 (UTC)." },
    async (request) => {
      prompts.push(request.prompt);
      return { text: replies[prompts.length - 1]!, costMicroUsd: 100 };
    }
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /did not follow the decomposition rules/);
  assert.match(prompts[1]!, /restate the request/);
  assert.ok(drafted.ok);
  if (!drafted.ok) return;
  assert.equal(drafted.output.questions.length, 5);
  assert.equal(drafted.costMicroUsd, 200);
});

test("stage 1: plannedResearch drops goal paraphrases and gives an unsearched vector a record-shaped query", () => {
  const planned = plannedResearch(scenarioPlan(), { goal: SCENARIO_GOAL });
  assert.ok(!planned.queries.some((q) => /for our engineering team/i.test(q)), `paraphrase kept: ${planned.queries.join(" | ")}`);
  assert.ok(planned.queries.every((q) => !restatesGoal(q, SCENARIO_GOAL)));
  // The terms vector had no planner query: it is searched by its record and metric, not its question.
  const terms = planned.queries.find((q) => /trust center/i.test(q));
  assert.ok(terms, `a terms query: ${planned.queries.join(" | ")}`);
  assert.match(terms!, /data retention days/);
  assert.equal(dedupeQueries(planned.queries).length, planned.queries.length, "no near-duplicates");
});

test("stage 1: the vectors reach the UIs through the existing rationale field", () => {
  const planned = plannedResearch(scenarioPlan(), { goal: SCENARIO_GOAL });
  const views = questionViews({ ...parsePlan({}), objectives: planned.objectives }, "investigating");
  assert.equal(views.length, 5);
  assert.match(views[1]!.rationale ?? "", /Figures: premium requests per month; rate limit tier\. Verify: unlimited completions claim\./);
  assert.deepEqual(Object.keys(views[1]!).sort(), ["id", "question", "rationale", "status"], "no new wire field");
});

// ── Stage 2: source policy ──────────────────────────────────────────────────

test("stage 2: first-party docs, pricing, changelogs and repositories are primary; marketplaces and affiliate listicles are aggregators", () => {
  const tier = (url: string, title = "", text = "") => assessSource({ url, title, text }).tier;
  assert.equal(tier("https://docs.github.com/en/copilot/plans"), "primary");
  assert.equal(tier("https://cursor.com/pricing"), "primary");
  assert.equal(tier("https://cursor.com/changelog"), "primary");
  assert.equal(tier("https://github.com/org/repo/issues/12"), "primary");
  assert.equal(tier("https://www.sec.gov/Archives/edgar/data/1/10k.htm"), "official");
  assert.equal(tier("https://www.g2.com/compare/a-vs-b"), "aggregator");
  assert.equal(tier("https://blog.example.net/x", "Top 10 Best AI Coding Assistants in 2026"), "aggregator");
  assert.equal(tier("https://site.example.com/review", "A review", "This post contains affiliate links."), "aggregator");
  assert.equal(tier("https://cursor.com/blog/best-ai-tools", "12 best AI tools for developers"), "aggregator", "a vendor's own listicle is marketing, not the record");
  assert.equal(tier("https://www.reuters.com/tech/story"), "reputable");
  assert.equal(tier("https://www.reddit.com/r/x/comments/1"), "community");
});

test("stage 2: the score puts the vendor's pricing page above an affiliate roundup, and the hit list is re-ranked", () => {
  const pricing = scoreSource({ url: "https://cursor.com/pricing", title: "Pricing | Cursor", text: "Teams costs $40 per user per month." });
  const roundup = scoreSource({ url: "https://bestaitools.example.net/top-10", title: "Top 10 Best AI Coding Assistants in 2026", text: "We may earn a commission." });
  assert.ok(pricing.composite > roundup.composite * 1.8, `${pricing.composite} vs ${roundup.composite}`);
  assert.ok(pricing.authority >= 0.85 && roundup.authority <= 0.25);
  assert.equal(sourceTypeOf({ url: "https://docs.github.com/copilot", text: "" }), "primary");
  assert.equal(sourceTypeOf({ url: "https://www.g2.com/products/x", text: "official dataset methodology" }), "general");
  const ranked = rankByPolicy([
    { url: "https://www.g2.com/compare/x", title: "x", snippet: "" },
    { url: "https://blog.example.net/a", title: "Top 7 best tools", snippet: "" },
    { url: "https://cursor.com/pricing", title: "Pricing", snippet: "" },
  ]);
  assert.equal(ranked[0]!.url, "https://cursor.com/pricing");
  assert.equal(ranked[2]!.assessment.tier, "aggregator");
});

// ── Stage 3: dedupe and multi-hop leads ─────────────────────────────────────

test("stage 3: near-duplicate queries are caught; a query that names a new record is not", () => {
  assert.ok(isNearDuplicateQuery("GitHub Copilot business pricing", "pricing of github copilot business"));
  assert.ok(isNearDuplicateQuery("copilot business plan pricing", "copilot business plan pricing 2026"), "a year adds nothing");
  assert.ok(isNearDuplicateQuery("Cursor rate limits", "cursor rate limit"), "plural");
  assert.ok(!isNearDuplicateQuery("adoption rate standard", "adoption rate standard registry"), "naming a record is a new search");
  assert.ok(!isNearDuplicateQuery("Cursor pricing", "Cursor Ultra plan rate limits"));
  assert.deepEqual(
    dedupeQueries(["copilot seat price docs", "docs copilot seat prices", "copilot enterprise audit logs retention"], ["Copilot seat price docs 2025"]),
    ["copilot enterprise audit logs retention"]
  );
});

test("stage 3: a finding that reveals a deprecation, a new tier or a rate limit opens a specific micro-query", () => {
  const leads = extractLeads({
    round: 1,
    goal: SCENARIO_GOAL,
    issued: ["Cursor pricing business plan per seat"],
    findings: [
      { objectiveId: "objective-2", url: "https://cursor.com/pricing", round: 1, claim: "Cursor introduced a new Ultra plan with higher rate limits in 2025.", quote: "new Ultra plan" },
      { objectiveId: "objective-3", url: "https://docs.github.com/x", round: 1, claim: "GitHub Copilot will deprecate GPT-4o on 2026-11-01.", quote: "deprecate" },
      { objectiveId: "objective-1", url: "https://docs.github.com/x", round: 1, claim: "Copilot Business costs $19 per user per month.", quote: "$19" },
      { objectiveId: "objective-3", url: "https://docs.github.com/x", round: 0, claim: "An old deprecation of Codex in 2023.", quote: "deprecation" },
    ],
  });
  assert.equal(leads.length, 2, JSON.stringify(leads));
  assert.match(leads[0]!.query, /^Cursor Ultra plan tier limits pricing 2025$/);
  assert.equal(leads[0]!.signal, "new tier");
  assert.match(leads[1]!.query, /GitHub Copilot .*deprecation/);
  assert.match(leads[1]!.query, /2026/);
  // Already-issued leads and the cap.
  const again = extractLeads({ round: 1, goal: SCENARIO_GOAL, issued: leads.map((l) => l.query), findings: [] , suggested: Array.from({ length: 20 }, (_, i) => ({ objectiveId: `objective-${i}`, query: `specific record query number ${i} x` })) });
  assert.equal(again.length, MAX_LEADS_PER_ROUND);
  assert.equal(entityOf("The Copilot Enterprise plan adds knowledge bases.", "https://x.com"), "Copilot Enterprise");
});

// ── Stage 4: gap audit ──────────────────────────────────────────────────────

test("stage 4: the gap audit names missing figures, conflicting figures and stale figures, with targeted searches", () => {
  const objectives: ResearchObjective[] = [
    {
      id: "objective-1",
      question: "What does each cost per seat?",
      importance: 1,
      status: "open",
      evidenceRequirements: [],
      childObjectiveIds: [],
      vector: { metrics: ["price per seat per month", "annual discount percentage"], sources: ["official pricing page"], verify: ["free tier for students"] },
    },
  ];
  const result = auditGaps({
    objectives,
    subject: "Cursor",
    now: new Date("2026-10-08T00:00:00.000Z"),
    issued: ["Cursor price per seat per month official pricing page"],
    sources: [
      { id: "s1", url: "https://cursor.com/pricing", publishedAt: new Date("2023-01-01T00:00:00.000Z") },
      { id: "s2", url: "https://blog.example.net/cursor", publishedAt: null },
    ],
    findings: [
      { objectiveId: "objective-1", sourceId: "s1", url: "https://cursor.com/pricing", claim: "Cursor Teams price per seat is $40 per month.", quote: "$40" },
      { objectiveId: "objective-1", sourceId: "s2", url: "https://blog.example.net/cursor", claim: "Cursor Teams price per seat is $32 per month.", quote: "$32" },
    ],
  });
  const entry = result.entries[0]!;
  assert.deepEqual(entry.missingFigures, ["annual discount percentage"]);
  assert.deepEqual(entry.unverified, ["free tier for students"]);
  assert.equal(entry.conflicts.length, 1);
  assert.deepEqual(entry.conflicts[0]!.sourceIds, ["s1", "s2"]);
  assert.equal(entry.stale.length, 2, "2023 and undated figures on a pricing vector");
  assert.ok(result.hasGaps);
  assert.ok(result.queries.some((q) => /annual discount percentage official pricing page/.test(q)), result.queries.join(" | "));
  assert.ok(result.queries.some((q) => /changelog official/.test(q)));
  assert.ok(result.queries.some((q) => /2026/.test(q)), "the stale figure is searched in the current year");
  assert.ok(!result.queries.includes("Cursor price per seat per month official pricing page"), "never repeats an issued search");
});

test("stage 4: a vector whose figures are found, agree and are fresh has no gap", () => {
  const result = auditGaps({
    objectives: [{ id: "o", question: "Price?", importance: 1, status: "open", evidenceRequirements: [], childObjectiveIds: [], vector: { metrics: ["price per seat"], sources: [], verify: [] } }],
    subject: "Cursor",
    now: new Date("2026-10-08T00:00:00.000Z"),
    issued: [],
    sources: [{ id: "s1", url: "https://cursor.com/pricing", publishedAt: new Date("2026-07-01T00:00:00.000Z") }],
    findings: [{ objectiveId: "o", sourceId: "s1", url: "https://cursor.com/pricing", claim: "The price per seat is $40.", quote: "$40" }],
  });
  assert.equal(result.hasGaps, false);
  assert.deepEqual(result.queries, []);
});

// ── Stage 5: report structure ───────────────────────────────────────────────

test("stage 5: the writer contract asks for verdict, matrix, deep dives, gotchas and traceability, in markers both readers parse", () => {
  const contract = reportWriterContract({ goal: SCENARIO_GOAL, questions: [{ id: "objective-1", question: "What does it cost?" }] });
  const order = ["bottom-line", "matrix", "question:objective-1", "gotchas", "conflicts", "gaps", "method"].map((key) => contract.indexOf(`juno:section=${key} `));
  assert.ok(order.every((at) => at > 0), "every section marker is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in the protocol's order");
  assert.match(contract, /decision matrix/);
  assert.match(contract, /traceab/);
  // Table cells are audited directly now (tableClaims), so the contract asks
  // for in-cell citations instead of repeating every figure in prose.
  assert.match(contract, /Tables are citation-checked cell by cell/);
  assert.doesNotMatch(contract, /must also be stated, cited, in the prose/);
  assert.ok(REPORT_SECTION_ORDER.includes("matrix") && REPORT_SECTION_ORDER.includes("gotchas"));

  const report = [
    "# T",
    "<!-- juno:section=bottom-line -->",
    "## Executive verdict",
    "Copilot [1].",
    "<!-- juno:section=matrix -->",
    "## Comparative matrix",
    "| Option | Price |\n|---|---|\n| Copilot | $19 [1] |",
    "<!-- juno:section=gotchas -->",
    "## Nuances and gotchas",
    "Premium requests cap at 300 [1].",
  ].join("\n");
  assert.deepEqual(reportSections(report).map((s) => s.kind), ["bottom-line", "matrix", "gotchas"]);
  assert.deepEqual(parseReport(report).sections.map((s) => s.kind), ["bottom-line", "matrix", "gotchas"]);
  assert.match(chatReportContract(SCENARIO_GOAL), /Executive Verdict & Decision Matrix[\s\S]*Comparative Matrix[\s\S]*Vector Deep Dives[\s\S]*Nuances & Gotchas[\s\S]*Methodology & Source Traceability[\s\S]*## Sources/);
});

test("stage 5: each source in the corpus carries its kind, domain and date; the vectors and gap audit reach the writer", () => {
  const planned = plannedResearch(scenarioPlan(), { goal: SCENARIO_GOAL });
  const plan = {
    ...parsePlan({}),
    objectives: planned.objectives,
    gapAudit: { at: "", pass: 1, queries: [], entries: [{ objectiveId: planned.objectives[0]!.id, missingFigures: ["annual discount"], unverified: [], conflicts: [], stale: [] }] },
  };
  const corpus = buildResearchCorpus(SCENARIO_GOAL, plan, [
    { id: "a", url: "https://cursor.com/pricing", title: "Pricing", snapshot: "Teams $40.", publishedAt: new Date("2026-07-15T00:00:00.000Z") },
    { id: "b", url: "https://www.g2.com/compare/x", title: "Compare", snapshot: "Cursor $20.", publishedAt: null },
  ]);
  assert.match(corpus, /\[1\] Pricing\nhttps:\/\/cursor\.com\/pricing\n\(primary record · cursor\.com · published 2026-07-15\)/);
  assert.match(corpus, /\[2\] Compare\n[^\n]+\n\(aggregator\/affiliate[^)]*· g2\.com · undated\)/);
  assert.match(corpus, /Investigative Vectors[\s\S]*figures: business plan price per seat per month/);
  assert.match(corpus, /gap audit[\s\S]*missing figures: annual discount/);
});

// ── End to end, offline ─────────────────────────────────────────────────────

test("end to end: vectors as questions, paraphrase dropped, primary records read first, a second round chases leads, duplicates refused", async () => {
  const { store, events } = memoryStore();
  const { deps, trace } = scenarioDeps(store);
  const engine = createResearchEngine(deps);
  const run = await engine.start({ userId: "u", goal: SCENARIO_GOAL, confirmation: "auto", effort: "standard" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.state, "completed", String(done?.error));
  const plan = parsePlan(done?.plan);

  assert.equal(plan.objectives.length, 5, "the vectors are the run's questions");
  assert.ok(!trace.searches.some((s) => /for our engineering team/i.test(s.query)), "the goal paraphrase was never searched");

  // Workers see the primary record first even though the engine ranked the roundups on top.
  assert.ok(trace.firstHitTiers.length > 0 && trace.firstHitTiers.every((tier) => tier === "primary record"), trace.firstHitTiers.join(","));
  // The seed read never opened an aggregator while primary pages were unread.
  const firstAggregator = trace.fetched.findIndex((url) => /g2\.com|bestaitools/.test(url));
  const lastPrimaryBeforeIt = trace.fetched.slice(0, firstAggregator < 0 ? undefined : firstAggregator);
  assert.ok(firstAggregator < 0 || lastPrimaryBeforeIt.length >= 4, `fetch order: ${trace.fetched.join(", ")}`);

  // The worker's verbatim repeat of a seed search was refused and not billed,
  // and so was every other repeat (round-2 workers re-running round-1 searches).
  assert.ok(trace.refusedSearches.includes("GitHub Copilot pricing business plan per seat"));
  const ran = new Set(trace.searches.map((s) => s.query.toLowerCase()));
  assert.ok(trace.refusedSearches.every((query) => ran.has(query.toLowerCase())), "only repeats are refused");

  // The lead said "synthesize" after round 1; the leads (Cursor's new Ultra plan) forced round 2.
  assert.equal(plan.rounds?.length, 2, JSON.stringify(plan.rounds?.map((r) => r.review)));
  assert.ok(plan.rounds![0]!.leads?.some((lead) => /Cursor.*(plan|rate)/i.test(lead)), JSON.stringify(plan.rounds![0]!.leads));
  assert.equal(plan.rounds![0]!.review?.decision, "continue", "recorded as continue so a resumed run keeps the round");
  const secondRound = trace.workerBriefs.filter((brief) => brief.round === 2);
  assert.ok(secondRound.some((brief) => /run these first: Cursor Ultra plan/.test(brief.whatToFind)), JSON.stringify(secondRound));
  assert.ok(trace.searches.some((s) => s.by.startsWith("w2-") && /Ultra plan/.test(s.query)), "round 2 ran the micro-query");
  assert.ok(trace.reviews[0]!.leads?.length, "the lead was shown the leads");
  assert.ok(events.some((e) => e.kind === "round_reviewed" && Array.isArray((e.payload as { leads?: unknown }).leads)));
  // And the round-2 lead stays bounded: the run did not go past its envelope's rounds.
  assert.ok((plan.rounds?.length ?? 0) <= 2);
  assert.ok(plan.gapAudit && plan.gapAudit.entries.length === 5, "the gap audit ran before writing");
});

test("end to end: with nothing to chase, a run the lead calls done after round one still stops at one round", async () => {
  const { store } = memoryStore();
  const { deps } = scenarioDeps(store);
  const engine = createResearchEngine({
    ...deps,
    async runWorker(input) {
      // A worker that finds nothing new: no leads, and no vector metrics to miss.
      void input;
      return { summary: "", openQuestions: [], followUps: [], tokens: 0, costMicroUsd: 0, reason: "done", toolCalls: 1, elapsedMs: 1 };
    },
    async draftPlan() {
      const plan = scenarioPlan();
      return { ok: true, output: { ...plan, questions: plan.questions.map(({ vector: _vector, ...q }) => q) }, costMicroUsd: 1_000 };
    },
  });
  const run = await engine.start({ userId: "u", goal: SCENARIO_GOAL, confirmation: "auto", effort: "standard" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.state, "completed");
  assert.equal(parsePlan(done?.plan).rounds?.length, 1, "a forced round needs a lead or an audit gap");
});
