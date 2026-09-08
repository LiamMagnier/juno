import test from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, parseStructuredPlan, plannerSystemPrompt } from "@/lib/research/plan-format";
import { parsePlan } from "@/lib/research/domain";

/*
 * The structured planner contract: the plan a person approves is sub-questions
 * with evidence requirements, not a bag of search strings. These tests pin the
 * parser's tolerance (fences, preamble, missing fields) and its bounds.
 */

const REPLY = `Here is the plan you asked for:
\`\`\`json
{
  "approach": "We will start from the vendors' own pricing pages and filings, then weigh independent benchmarks against them, treating press coverage as a pointer rather than evidence.",
  "objectives": [
    {
      "question": "What does each vendor charge per million tokens in September 2026?",
      "rationale": "Every comparison downstream depends on the current list price.",
      "importance": 1,
      "evidence": [
        { "description": "List prices from each vendor's own pricing page", "sourceTypes": ["official"], "independentSources": 1, "requiresPrimary": true, "freshness": "within 3 months" }
      ],
      "queries": ["Anthropic Claude API pricing per million tokens September 2026", "OpenAI GPT API pricing per million tokens 2026"]
    },
    {
      "question": "How do independent benchmarks rank the models on reasoning tasks?",
      "rationale": "Price only matters relative to capability.",
      "importance": 0.8,
      "evidence": [
        { "description": "Third-party benchmark results with methodology", "sourceTypes": ["reputable secondary", "nonsense"], "independentSources": 3, "requiresPrimary": false }
      ],
      "queries": ["independent LLM reasoning benchmark results 2026 Claude GPT Gemini", "Anthropic Claude API pricing per million tokens September 2026"]
    }
  ],
  "steps": ["Collect list prices from each vendor's own pricing page.", "Gather independent benchmark results and their methodology", "short"],
  "successCriteria": ["A price table per vendor", "A capability ranking with its source"],
  "risks": ["Benchmarks may be stale by a model generation"]
}
\`\`\`
Let me know if you want changes.`;

test("extractJsonObject finds the balanced object behind fences and preamble", () => {
  const json = extractJsonObject(REPLY);
  assert.ok(json);
  assert.ok(json.startsWith("{"));
  assert.ok(json.endsWith("}"));
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject('{"unterminated": "yes'), null);
});

test("a structured reply becomes objectives with evidence contracts and per-question searches", () => {
  const plan = parseStructuredPlan(REPLY, { maxQueries: 16 });
  assert.ok(plan);
  assert.equal(plan.objectives.length, 2);
  assert.equal(plan.objectives[0].id, "objective-1");
  assert.equal(plan.objectives[0].importance, 1);
  assert.equal(plan.objectives[0].rationale, "Every comparison downstream depends on the current list price.");
  const requirement = plan.objectives[0].evidenceRequirements[0];
  assert.equal(requirement.requiresPrimarySource, true);
  assert.equal(requirement.freshnessRule, "within 3 months");
  assert.deepEqual(requirement.preferredSourceTypes, ["official"]);
  // Unknown source types are dropped; the known one is normalised.
  assert.deepEqual(plan.objectives[1].evidenceRequirements[0].preferredSourceTypes, ["reputable_secondary"]);
  assert.equal(plan.objectives[1].evidenceRequirements[0].minimumIndependentSources, 3);
  // Queries are flattened in objective order and deduplicated.
  assert.deepEqual(plan.queries, [
    "Anthropic Claude API pricing per million tokens September 2026",
    "OpenAI GPT API pricing per million tokens 2026",
    "independent LLM reasoning benchmark results 2026 Claude GPT Gemini",
  ]);
  // Steps keep sentence shape: a fragment is dropped, a missing period is added.
  assert.deepEqual(plan.steps, [
    "Collect list prices from each vendor's own pricing page.",
    "Gather independent benchmark results and their methodology.",
  ]);
  assert.equal(plan.successCriteria.length, 2);
  assert.equal(plan.risks.length, 1);
  assert.ok(plan.approach?.startsWith("We will start"));
});

test("an objective with no evidence block still gets a real evidence contract", () => {
  const plan = parseStructuredPlan(
    JSON.stringify({ objectives: [{ question: "What changed in the 2026 rules?", queries: [] }] }),
    { maxQueries: 16 }
  );
  assert.ok(plan);
  assert.equal(plan.objectives[0].evidenceRequirements.length, 1);
  assert.equal(plan.objectives[0].evidenceRequirements[0].minimumIndependentSources, 2);
  // A question with no search of its own is searched as itself.
  assert.deepEqual(plan.queries, ["What changed in the 2026 rules"]);
});

test("a reply that is not the structured shape is rejected, never guessed at", () => {
  assert.equal(parseStructuredPlan("## PLAN\nDo things\n## QUERIES\nthing one", { maxQueries: 16 }), null);
  assert.equal(parseStructuredPlan('{"objectives": "nope"}', { maxQueries: 16 }), null);
  assert.equal(parseStructuredPlan('{"objectives": [{"question": "x"}]}', { maxQueries: 16 }), null);
});

test("the query cap holds however many searches the planner wrote", () => {
  const objectives = Array.from({ length: 8 }, (_, i) => ({
    question: `Sub-question number ${i + 1} about the subject?`,
    queries: Array.from({ length: 4 }, (_, j) => `search ${i + 1}-${j + 1} about the subject`),
  }));
  const plan = parseStructuredPlan(JSON.stringify({ objectives }), { maxQueries: 6 });
  assert.ok(plan);
  assert.equal(plan.queries.length, 6);
  assert.equal(plan.objectives.length, 8);
});

test("the structured fields survive a round trip through the stored plan", () => {
  const plan = parseStructuredPlan(REPLY, { maxQueries: 16 });
  assert.ok(plan);
  const stored = parsePlan({
    queries: plan.queries,
    steps: plan.steps,
    objectives: plan.objectives,
    approach: plan.approach,
    successCriteria: plan.successCriteria,
    risks: plan.risks,
    brief: "A brief.",
    constraints: [],
    pinnedSources: [],
  });
  assert.equal(stored.approach, plan.approach);
  assert.deepEqual(stored.successCriteria, plan.successCriteria);
  assert.deepEqual(stored.risks, plan.risks);
  assert.equal(stored.brief, "A brief.");
  assert.equal(stored.objectives[0].rationale, plan.objectives[0].rationale);
  assert.equal(stored.objectives[0].evidenceRequirements[0].freshnessRule, "within 3 months");
});

test("the planner prompt scales its asks with the tier", () => {
  assert.match(plannerSystemPrompt("quick", []), /Plan 2 to 3 objectives/);
  assert.match(plannerSystemPrompt("deep", ["https://example.org"]), /Plan 5 to 8 objectives/);
  assert.match(plannerSystemPrompt(undefined, []), /Plan 3 to 5 objectives/);
  assert.match(plannerSystemPrompt("deep", ["https://example.org"]), /https:\/\/example\.org/);
});
