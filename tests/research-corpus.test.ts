import test from "node:test";
import assert from "node:assert/strict";
import { buildResearchCorpus, corpusFindings } from "@/lib/research/corpus";
import { parsePlan } from "@/lib/research/domain";

/*
 * What the writer is shown decides what the report can say. The lead's
 * contradictions were written to the plan and drawn in the evidence panel —
 * and never handed to the writer, whose only inputs were the goal, the
 * constraints, the numbered pages and the findings. These pin that the
 * team's own review reaches the corpus, numbered the way the findings are.
 */

const sources = [
  { id: "src_a", url: "https://a.example/one", title: "Source A", snapshot: "The figure was 42 percent in 2025." },
  { id: "src_b", url: "https://b.example/two", title: "Source B", snapshot: "The figure was 38 percent in 2025." },
];

test("what the lead flagged reaches the writer, numbered like the findings", () => {
  const plan = parsePlan({
    queries: ["adoption rate"],
    constraints: [],
    pinnedSources: [],
    objectives: [
      {
        id: "objective-1",
        question: "What was the adoption rate in 2025?",
        importance: 1,
        status: "partially_covered",
        evidenceRequirements: [],
        childObjectiveIds: [],
      },
    ],
    conflicts: [
      {
        id: "lead-r1-1",
        kind: "contradictory_evidence",
        sourceIds: ["src_a", "src_b"],
        description: "A says 42 percent, B says 38 percent for the same year.",
        severity: "medium",
        resolved: false,
      },
      // A conflict none of whose sources made the corpus cannot be cited by a
      // number, so it is left out rather than pointed at the wrong page.
      { id: "lead-r1-2", kind: "contradictory_evidence", sourceIds: ["src_missing"], description: "Never made the corpus.", severity: "medium", resolved: false },
      { id: "lead-r1-3", kind: "contradictory_evidence", sourceIds: ["src_a"], description: "Settled already.", severity: "low", resolved: true },
    ],
    rounds: [
      {
        round: 1,
        delegations: [],
        pagesRead: 0,
        toolCalls: 0,
        tokens: 0,
        claims: 0,
        newClaims: 0,
        startedAt: "2026-09-17T00:00:00.000Z",
        openQuestions: ["Which registry reported 42 percent?"],
      },
    ],
  });
  const corpus = buildResearchCorpus("adoption of the standard", plan, sources, corpusFindings(plan, sources, []));
  assert.match(corpus, /# Evidence State/);
  assert.match(corpus, /A says 42 percent, B says 38 percent for the same year\. \[1\]\[2\]/);
  assert.doesNotMatch(corpus, /Never made the corpus/);
  assert.doesNotMatch(corpus, /Settled already/);
  assert.match(corpus, /What was the adoption rate in 2025\? \(partially covered\)/);
  assert.match(corpus, /Which registry reported 42 percent\?/);
  // The team's review sits above the numbered pages, where the report is built from.
  assert.ok(corpus.indexOf("# Evidence State") < corpus.indexOf("# Numbered Source Material"));
});

test("a plan with nothing flagged adds no evidence state", () => {
  const plan = parsePlan({
    queries: ["q"],
    constraints: [],
    pinnedSources: [],
    objectives: [{ id: "objective-1", question: "Q?", importance: 1, status: "covered", evidenceRequirements: [], childObjectiveIds: [] }],
  });
  const corpus = buildResearchCorpus("goal", plan, sources);
  assert.doesNotMatch(corpus, /Evidence State/);
  assert.match(corpus, /\[1\] Source A/);
  assert.match(corpus, /\[2\] Source B/);
});
