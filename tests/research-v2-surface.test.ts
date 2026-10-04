import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emergingAnswersOf } from "@/lib/research/view";
import { followUpSuggestions, recoveryLine } from "@/components/research/next-steps";
import type { ResearchEventDTO } from "@/lib/research/domain";

/*
 * RESEARCH_V2 §3: what the reader sees that ChatGPT and Claude do not —
 * the interim answer under each question, the engine's recoveries in its
 * own words, and follow-ups drawn from what the run left open.
 */

const at = (s: number) => new Date(Date.UTC(2026, 9, 4, 9, 0, s));
const SOURCES = [
  { id: "s1", url: "https://www.sintef.no/a", title: "SINTEF field trial" },
  { id: "s2", url: "https://www.iea.org/b", title: "IEA" },
];

test("emerging answers: the strongest note per question — confidence, then newest — in the plan's order", () => {
  const answers = emergingAnswersOf(
    [
      { objectiveId: "q2", sourceId: "s2", claim: "Costs fell.", confidence: 0.4, createdAt: at(1), url: "" },
      { objectiveId: "q1", sourceId: "s1", claim: "COP above 2 at -20C.", confidence: 0.9, createdAt: at(2), url: "" },
      { objectiveId: "q1", sourceId: "s2", claim: "A weaker note.", confidence: 0.5, createdAt: at(5), url: "" },
      { objectiveId: "q2", sourceId: "s1", claim: "Costs fell  40%\nagainst oil.", confidence: 0.4, createdAt: at(9), url: "" },
      { objectiveId: "q9", sourceId: "s1", claim: "A question the plan no longer has.", confidence: 1, createdAt: at(9), url: "" },
    ],
    SOURCES,
    [{ id: "q1" }, { id: "q2" }, { id: "q3" }]
  );
  assert.deepEqual(answers, [
    { questionId: "q1", claim: "COP above 2 at -20C.", url: SOURCES[0].url, title: "SINTEF field trial", sources: 2 },
    { questionId: "q2", claim: "Costs fell 40% against oil.", url: SOURCES[0].url, title: "SINTEF field trial", sources: 2 },
  ]);
});

test("follow-ups: thin first, then partial, then unanswered, then open disagreements; three at most, never a covered question", () => {
  const suggestions = followUpSuggestions({
    state: "completed",
    questions: [
      { id: "q1", question: "Covered?", status: "covered" },
      { id: "q2", question: "Partly answered?", status: "partial" },
      { id: "q3", question: "Barely answered?", status: "thin" },
    ],
    plan: {
      conflicts: [
        { id: "k1", kind: "contradictory_evidence", sourceIds: [], description: "The IEA and the US put costs far apart.", severity: "medium", resolved: false },
        { id: "k2", kind: "contradictory_evidence", sourceIds: [], description: "Resolved already", severity: "low", resolved: true },
      ],
    } as never,
  });
  assert.deepEqual(
    suggestions.map((s) => [s.why, s.text]),
    [
      ["thin", "Barely answered?"],
      ["partial", "Partly answered?"],
      ["conflict", "Settle where the sources disagree: The IEA and the US put costs far apart"],
    ]
  );
  assert.equal(followUpSuggestions({ state: "completed", questions: [{ id: "q", question: "Done", status: "covered" }], plan: { conflicts: [] } as never }).length, 0);
});

const ev = (seq: number, kind: ResearchEventDTO["kind"], payload: Record<string, unknown> = {}): ResearchEventDTO => ({
  id: `e${seq}`,
  seq,
  kind,
  payload,
  createdAt: at(seq).toISOString(),
});

test("the recovery line: the newest recovery while it is recent news, never a page that failed to load, never once the run stops", () => {
  const events = [
    ev(1, "run_started"),
    ev(2, "error", { scope: "planning", recoverable: true, message: "The first plan did not hold together. Asking another model." }),
  ];
  assert.equal(recoveryLine(events, true), "The first plan did not hold together. Asking another model.");
  assert.equal(recoveryLine(events, false), null);
  assert.equal(recoveryLine([ev(1, "error", { url: "https://x.test", message: "403", recoverable: true })], true), null);
  const later = [...events, ...[3, 4, 5, 6, 7, 8].map((n) => ev(n, "query_issued"))];
  assert.equal(recoveryLine(later, true), null, "superseded by newer work");
});

test("the composer seed arms research for one send, and only where research is allowed", () => {
  const composer = readFileSync("src/components/chat/composer.tsx", "utf8");
  const seed = composer.slice(composer.indexOf("const researchSeedAllowed"), composer.indexOf('window.removeEventListener("juno:composer-seed"'));
  assert.match(seed, /planAllowsResearch && researchAvailable/);
  assert.match(seed, /if \(armResearch && researchSeedAllowedRef\.current\) setResearch\(true\)/);
  const recap = readFileSync("src/components/research/research-recap.tsx", "utf8");
  assert.match(recap, /new CustomEvent\("juno:composer-seed", \{ detail: \{ text, research: true \} \}\)/);
});

test("the research surface draws dot rules, not hairlines", () => {
  const css = readFileSync("src/components/research/research.css", "utf8");
  assert.doesNotMatch(css, /border(-(top|bottom|block|inline-start))?:\s*1px solid var\(--rf-(line|hair)\)/);
  assert.match(css, /--rf-rule-x: radial-gradient/);
});
