import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { estimateLine } from "@/components/research/copy";
import { KEEP_RESEARCHING_JOINER, MAX_GOAL_CHARS, keepResearchingGoal } from "@/components/research/keep-researching.prompt";
import {
  MAX_QUESTIONS,
  MAX_QUESTION_CHARS,
  NOTIFY_ASKED_KEY,
  addQuestion,
  addSource,
  approachOf,
  canAddQuestion,
  canRemoveQuestion,
  canStart,
  clarificationsOf,
  draftEstimate,
  draftSeed,
  editQuestion,
  markNotifyAsked,
  normaliseSourceUrl,
  notifyAsked,
  notifyPromptVisible,
  planBody,
  planRevisionOf,
  removeQuestion,
  removeSource,
  seedDraft,
  setAnswer,
  startRequest,
  type ScopeRunInput,
} from "@/components/research/scope-draft";
import { phraseText } from "@/lib/i18n-phrase";
import { MAX_PINNED_SOURCES } from "@/lib/research/domain";
import { estimateFor } from "@/lib/research/estimate";
import type { ResearchEstimateCaps, ResearchScope } from "@/types/research";

/*
 * The scope card's draft (SPEC §9.11.2, DECISIONS R2): editable questions,
 * answers and sources, and an estimate line that follows every edit — pure,
 * so the card's rules hold without a DOM.
 */

const root = path.resolve(__dirname, "..");

test("the draft module keeps server-only out of its static graph", () => {
  for (const file of ["src/components/research/scope-draft.ts", "src/lib/research/estimate.ts", "src/components/research/keep-researching.prompt.ts"]) {
    assert.doesNotMatch(readFileSync(path.join(root, file), "utf8"), /^import "server-only";/m, file);
  }
});

const CAPS: ResearchEstimateCaps = { maxWorkers: 4, maxRounds: 3, maxPages: 150, maxMinutes: 30, secondsPerPage: 20, fixedMinutes: 2 };
const SCOPE: ResearchScope = { questions: 4, breadth: "broad", freshness: "any", primarySources: false, quick: false };

function run(patch: Partial<ScopeRunInput> = {}): ScopeRunInput {
  return {
    id: "run-1",
    questions: [
      { id: "q1", question: "What COP do air-source heat pumps reach at -20 °C?", status: "pending" },
      { id: "q2", question: "How do field trials compare with lab ratings?", status: "pending" },
      { id: "q3", question: "What does a cold-climate install cost?", status: "pending" },
      { id: "q4", question: "Which models lead in Nordic tests?", status: "pending" },
    ],
    plan: { pinnedSources: ["https://example.org/nordic"], clarificationAnswers: { c1: "Norway" } },
    scope: SCOPE,
    estimate: estimateFor(SCOPE, CAPS),
    estimateCaps: CAPS,
    ...patch,
  };
}

test("the draft is seeded from the run's questions, keyed by run and plan revision", () => {
  const draft = seedDraft(run(), 0);
  assert.equal(draft.seed, draftSeed("run-1", 0));
  assert.deepEqual(draft.questions.map((q) => q.id), ["q1", "q2", "q3", "q4"]);
  assert.deepEqual(draft.pinnedSources, ["https://example.org/nordic"]);
  assert.deepEqual(draft.answers, { c1: "Norway" });
  assert.equal(draft.edited, false);
});

test("a run from before `questions` seeds from its plan objectives", () => {
  const draft = seedDraft(run({ questions: undefined, plan: { pinnedSources: [], objectives: [{ id: "o1", question: "Old question?" }] } }), 0);
  assert.deepEqual(draft.questions.map((q) => [q.id, q.text]), [["o1", "Old question?"]]);
});

test("a revised plan re-seeds; a poll of the same plan does not (bug 29)", () => {
  assert.equal(planRevisionOf([{ kind: "plan_drafted" }, { kind: "state_changed" }]), 0);
  assert.equal(planRevisionOf([{ kind: "plan_drafted" }, { kind: "plan_revised" }, { kind: "plan_revised" }]), 2);
  assert.notEqual(draftSeed("run-1", 0), draftSeed("run-1", 1));
});

test("the estimate follows every edit to the question count", () => {
  let draft = seedDraft(run(), 0);
  const at4 = draftEstimate(draft, run());
  assert.deepEqual(at4, estimateFor(SCOPE, CAPS));

  assert.equal(removeQuestion(draft, "no-such-key"), draft);
  draft = removeQuestion(draft, draft.questions[0].key);
  assert.equal(draft.edited, true);
  assert.deepEqual(draftEstimate(draft, run()), estimateFor({ ...SCOPE, questions: 3 }, CAPS));

  const added = addQuestion(draft);
  assert.ok(added.key);
  // An empty new row does not count until it has words.
  assert.deepEqual(draftEstimate(added.draft, run()), estimateFor({ ...SCOPE, questions: 3 }, CAPS));
  const filled = editQuestion(added.draft, added.key!, "And the running cost?");
  assert.deepEqual(draftEstimate(filled, run()), estimateFor({ ...SCOPE, questions: 4 }, CAPS));
  assert.ok((draftEstimate(filled, run())?.pagesUpTo ?? 0) > (draftEstimate(draft, run())?.pagesUpTo ?? 0));
});

test("without caps (an older server) the server's own estimate stands", () => {
  const legacy = run({ estimateCaps: null, estimate: { minutesUpTo: 9, pagesUpTo: 60 } });
  assert.deepEqual(draftEstimate(seedDraft(legacy, 0), legacy), { minutesUpTo: 9, pagesUpTo: 60 });
  assert.equal(draftEstimate(seedDraft(run({ estimateCaps: null, estimate: null }), 0), run({ estimateCaps: null, estimate: null })), null);
});

test("the estimate line is time and pages only: About 12 minutes · Reads up to ~150 pages", () => {
  assert.equal(phraseText(estimateLine({ minutesUpTo: 12, pagesUpTo: 150 })), "About 12 minutes. Reads up to ~150 pages");
  assert.doesNotMatch(phraseText(estimateLine({ minutesUpTo: 12, pagesUpTo: 150 })), /[€$]|EUR|USD/);
});

test("questions stay between 1 and 6, and at most 300 characters", () => {
  let draft = seedDraft(run(), 0);
  while (canAddQuestion(draft)) draft = addQuestion(draft).draft;
  assert.equal(draft.questions.length, MAX_QUESTIONS);
  assert.equal(addQuestion(draft).key, null);
  while (canRemoveQuestion(draft)) draft = removeQuestion(draft, draft.questions[0].key);
  assert.equal(draft.questions.length, 1);
  assert.equal(removeQuestion(draft, draft.questions[0].key), draft);
  const long = editQuestion(draft, draft.questions[0].key, "x".repeat(400));
  assert.equal(long.questions[0].text.length, MAX_QUESTION_CHARS);
  // No change is not an edit.
  assert.equal(editQuestion(long, long.questions[0].key, "x".repeat(400)), long);
});

test("Start needs at least one question with words in it", () => {
  let draft = seedDraft(run(), 0);
  assert.equal(canStart(draft), true);
  for (const q of draft.questions.slice(1)) draft = removeQuestion(draft, q.key);
  draft = editQuestion(draft, draft.questions[0].key, "   ");
  assert.equal(canStart(draft), false);
});

test("answers are clipped and an emptied answer is dropped", () => {
  let draft = seedDraft(run(), 0);
  draft = setAnswer(draft, "c2", "Mostly air-to-water");
  assert.equal(draft.answers.c2, "Mostly air-to-water");
  draft = setAnswer(draft, "c2", "");
  assert.equal("c2" in draft.answers, false);
  assert.equal(setAnswer(draft, "c1", "Norway"), draft);
});

test("only http(s) sources are added, normalised, once, up to the cap", () => {
  assert.equal(normaliseSourceUrl("  https://Example.org/a "), "https://example.org/a");
  assert.equal(normaliseSourceUrl("javascript:alert(1)"), null);
  assert.equal(normaliseSourceUrl("ftp://example.org"), null);
  assert.equal(normaliseSourceUrl("not a url"), null);
  let draft = seedDraft(run(), 0);
  assert.equal(addSource(draft, "file:///etc/passwd").ok, false);
  const again = addSource(draft, "https://example.org/nordic");
  assert.equal(again.ok, true);
  assert.equal(again.draft.pinnedSources.length, 1);
  for (let i = 0; draft.pinnedSources.length < MAX_PINNED_SOURCES; i++) draft = addSource(draft, `https://s${i}.example`).draft;
  assert.equal(addSource(draft, "https://one-more.example").ok, false);
  draft = removeSource(draft, "https://example.org/nordic");
  assert.equal(draft.pinnedSources.includes("https://example.org/nordic"), false);
});

test("Start confirms the edited plan; a run at the old clarify gate answers first", () => {
  const draft = editQuestion(seedDraft(run(), 0), "q0", "What COP at -25 °C?");
  const request = startRequest("awaiting_plan_confirmation", draft);
  assert.equal(request.path, "/plan");
  assert.deepEqual(request.body, planBody(draft, "confirm"));
  assert.equal((request.body as { decision: string }).decision, "confirm");
  assert.deepEqual((request.body as { questions: unknown[] }).questions[0], { id: "q1", question: "What COP at -25 °C?" });
  assert.deepEqual(startRequest("awaiting_clarification", draft), { path: "/clarify", body: { answers: { c1: "Norway" } } });
  assert.equal(planBody(draft, "revise").decision, "revise");
});

test("the card reads clarifications and the approach from new and old runs", () => {
  assert.deepEqual(
    clarificationsOf({ clarifications: [{ id: "c1", question: "Where?", options: ["EU", "US"] }], plan: {} }),
    [{ id: "c1", question: "Where?", options: ["EU", "US"] }],
  );
  assert.deepEqual(
    clarificationsOf({ plan: { clarifications: [{ id: "c9", question: "Which?", suggestions: ["A"] }] } }),
    [{ id: "c9", question: "Which?", options: ["A"] }],
  );
  assert.equal(approachOf({ plan: { approach: "  Compare field trials with ratings. " } }), "Compare field trials with ratings.");
  assert.equal(approachOf({ plan: { brief: "A brief." } }), "A brief.");
  assert.equal(approachOf({ plan: {} }), null);
});

// ── The notify line (R7) ──────────────────────────────────────────────────────

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

test("the notify line: runs over five minutes, permission not asked, never asked before", () => {
  assert.equal(notifyPromptVisible({ minutesUpTo: 12, permission: "default", asked: false }), true);
  assert.equal(notifyPromptVisible({ minutesUpTo: 5, permission: "default", asked: false }), false);
  assert.equal(notifyPromptVisible({ minutesUpTo: 12, permission: "granted", asked: false }), false);
  assert.equal(notifyPromptVisible({ minutesUpTo: 12, permission: null, asked: false }), false);
  assert.equal(notifyPromptVisible({ minutesUpTo: 12, permission: "default", asked: true }), false);
});

test("once shown, the notify line is recorded and never shown again", () => {
  const storage = memoryStorage();
  assert.equal(notifyAsked(storage), false);
  markNotifyAsked(storage);
  assert.equal(storage.map.get(NOTIFY_ASKED_KEY), "1");
  assert.equal(notifyAsked(storage), true);
  const refusing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
  };
  // Storage that refuses reads as asked, so the offer is not made on every card.
  assert.equal(notifyAsked(refusing), true);
  assert.doesNotThrow(() => markNotifyAsked(refusing));
});

// ── Keep researching ──────────────────────────────────────────────────────────

test("Keep researching builds the next goal from the old one and the reader's words", () => {
  assert.equal(keepResearchingGoal(" Old goal ", " the running cost "), `Old goal${KEEP_RESEARCHING_JOINER}the running cost`);
  const long = keepResearchingGoal("g".repeat(5_000), "next");
  assert.equal(long.length, MAX_GOAL_CHARS);
  assert.ok(long.endsWith(`${KEEP_RESEARCHING_JOINER}next`));
});
