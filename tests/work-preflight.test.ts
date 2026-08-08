import test from "node:test";
import assert from "node:assert/strict";
import {
  appendClarifications,
  derivePreflightQuestions,
  recommendedOption,
  splitClarifications,
  type WorkPreflightQuestion,
} from "@/components/work/clarify/preflight";
import { inferCapabilities } from "@/lib/work/inference";
import type { WorkCapability } from "@/lib/work/domain";
import { estimateWorkRunCost, WORK_PREFLIGHT_CONFIRMATION_MICRO_USD } from "@/lib/work/preflight-cost";

/*
 * The Work composer's pre-flight questions.
 *
 * Worth unit-testing for the reason `work-inference.test.ts` gives about the
 * function it covers: this is a pure reading of the user's own prose that runs
 * before anything is created, and the failures that matter are all failures of
 * judgement rather than of plumbing — a card that interrupts somebody who was
 * clear, or one that stays silent in front of the twenty minutes it exists to
 * protect. Neither is visible in a screenshot of a working composer.
 *
 * The tests are paired throughout: every rule gets a sentence it must fire on
 * and a sentence it must not.
 */

const CONNECTORS = [
  { id: "github", label: "GitHub" },
  { id: "apple-mail", label: "Apple Mail" },
  { id: "apple-calendar", label: "Apple Calendar" },
];

/** Runs the composer's own reading, so the tests cannot drift from what it does. */
function ask(
  goal: string,
  options: { selected?: string[]; connectors?: typeof CONNECTORS } = {}
): WorkPreflightQuestion[] {
  return derivePreflightQuestions({
    goal,
    inferred: inferCapabilities(goal).capabilities as readonly WorkCapability[],
    connectors: options.connectors ?? CONNECTORS,
    selectedConnectorIds: options.selected ?? [],
  });
}

const ids = (questions: readonly WorkPreflightQuestion[]) => questions.map((q) => q.id);

// ---------------------------------------------------------------------------
// Silence is the common case
// ---------------------------------------------------------------------------

test("a task that commits to nothing in particular is not interrupted", () => {
  assert.deepEqual(ids(ask("Summarise this idea for me")), []);
  assert.deepEqual(ids(ask("Write a one-page brief on our Q3 pricing change")), []);
  assert.deepEqual(ids(ask("Tidy up my Downloads folder")), []);
});

test("an empty or near-empty field asks nothing", () => {
  assert.deepEqual(ids(ask("")), []);
  assert.deepEqual(ids(ask("   ")), []);
});

test("no more than three questions, however much a goal matches", () => {
  const questions = ask(
    "Reply to every email in my inbox and post the summary to my calendar, then research the latest guidance"
  );
  assert.ok(questions.length <= 3, `asked ${questions.length}`);
});

// ---------------------------------------------------------------------------
// The connector question — the only answer that changes a permission
// ---------------------------------------------------------------------------

test("an app named in the goal but switched off is offered, and carries its grant", () => {
  const [question, ...rest] = ask("Clean my GitHub and add a readme to the repos without one");
  assert.equal(rest.length, 0);
  assert.equal(question.id, "reach_github");
  assert.equal(question.grantsConnectorId, "github");
  // The recommendation is the one that switches it on: a task that names an app
  // and cannot reach it is a run that narrates its way through a plan it can
  // never start.
  assert.match(recommendedOption(question).label, /^Yes/);
});

test("an app already switched on is not asked about", () => {
  assert.deepEqual(ids(ask("Clean my GitHub", { selected: ["github"] })), []);
});

test("the words people actually use count as naming the app", () => {
  // "inbox" is Apple Mail and contains neither of its words; matching on the
  // label alone would miss the commonest phrasing of the commonest case.
  assert.ok(ids(ask("Sort through my inbox")).includes("reach_apple-mail"));
  assert.ok(ids(ask("Find a gap in my calendar next week")).includes("reach_apple-calendar"));
});

test("an app the account has not connected is never offered", () => {
  assert.deepEqual(ids(ask("Post this to Slack", { connectors: [] })), []);
});

// ---------------------------------------------------------------------------
// Sending — the answer no later run can take back
// ---------------------------------------------------------------------------

test("a task that would send something is asked whether to send it", () => {
  assert.ok(ids(ask("Reply to the invoice email from Acme")).includes("send_or_draft"));
  const question = ask("Reply to the invoice email from Acme").find((q) => q.id === "send_or_draft");
  assert.ok(question);
  assert.equal(recommendedOption(question).label, "Leave it as a draft for you to send");
});

test("a reader who already said draft is not asked again", () => {
  assert.ok(!ids(ask("Draft a reply to the invoice email from Acme")).includes("send_or_draft"));
});

test("nothing to send from means nothing to ask about", () => {
  // No connected app is named and none is inferred, so the only thing this
  // could produce is a draft either way.
  assert.ok(!ids(ask("Post a summary of the release notes", { connectors: [] })).includes("send_or_draft"));
});

// ---------------------------------------------------------------------------
// Breadth and recency — spending the ceiling well
// ---------------------------------------------------------------------------

test("a task whose size is all of something is asked how far to get", () => {
  assert.ok(ids(ask("Reply to all my unread emails")).includes("breadth"));
  assert.ok(ids(ask("Rename every invoice in the folder")).includes("breadth"));
});

test("a recurring task is not mistaken for a large one", () => {
  // "every morning" is background_continuation — a task that repeats, not one
  // that is big — and "how much should one run get through" is a question about
  // nothing there.
  assert.ok(!ids(ask("Every morning, summarise what changed overnight")).includes("breadth"));
  assert.ok(!ids(ask("Check the deploy every hour")).includes("breadth"));
});

test("research with no date in it is asked how far back to look", () => {
  assert.ok(ids(ask("Look up the latest pricing for the vendors we shortlisted")).includes("recency"));
});

test("research that already names a window is left alone", () => {
  assert.ok(!ids(ask("Research what changed in the EU rules since 2024")).includes("recency"));
  assert.ok(!ids(ask("Research what shipped in the last six months")).includes("recency"));
});

// ---------------------------------------------------------------------------
// What accepting does to the goal
// ---------------------------------------------------------------------------

const answersFor = (questions: readonly WorkPreflightQuestion[]) =>
  questions.map((question) => ({
    questionId: question.id,
    question: question.question,
    source: "option" as const,
    value: recommendedOption(question).label,
  }));

test("the sentence the reader wrote survives accepting, verbatim and first", () => {
  const goal = "Reply to every email in my inbox about the invoice";
  const next = appendClarifications(goal, answersFor(ask(goal)));
  assert.ok(next.startsWith(goal), next);
  assert.equal(splitClarifications(next).body, goal);
});

test("accepting does not leave the same questions on the screen", () => {
  const goal = "Reply to every email in my inbox about the invoice";
  const questions = ask(goal);
  const next = appendClarifications(goal, answersFor(questions));
  const grants = questions.flatMap((q) => (q.grantsConnectorId ? [q.grantsConnectorId] : []));
  assert.deepEqual(ids(ask(next, { selected: grants })), []);
});

test("a second round appends to the block rather than opening another", () => {
  const goal = "Reply to every email in my inbox";
  const once = appendClarifications(goal, answersFor(ask(goal)));
  const twice = appendClarifications(once, [
    { questionId: "later", question: "Anything else?", source: "option", value: "No" },
  ]);
  assert.equal((twice.match(/Clarifications:/g) ?? []).length, 1);
  assert.ok(twice.trimEnd().endsWith("- Anything else?: No"), twice);
});

test("nothing to add leaves the goal untouched", () => {
  assert.equal(appendClarifications("Do the thing", []), "Do the thing");
});

test("the Work cost preflight is deterministic and asks before an expensive run", () => {
  const short = estimateWorkRunCost({ modelId: "deepseek:deepseek-v4-flash", goalChars: 20 });
  const long = estimateWorkRunCost({
    modelId: "anthropic:claude-opus-5",
    goalChars: 20_000,
    attachmentChars: 80_000,
  });

  assert.deepEqual(short, estimateWorkRunCost({ modelId: "deepseek:deepseek-v4-flash", goalChars: 20 }));
  assert.equal(short.requiresConfirmation, short.estimatedCostMicroUsd >= WORK_PREFLIGHT_CONFIRMATION_MICRO_USD);
  assert.ok(long.estimatedCostMicroUsd > short.estimatedCostMicroUsd);
  assert.equal(long.requiresConfirmation, true);
});

test("a goal with no block splits into itself", () => {
  assert.deepEqual(splitClarifications("Do the thing"), { body: "Do the thing", block: "" });
});

test("every question opens on exactly one recommendation", () => {
  const goals = [
    "Clean my GitHub",
    "Reply to every email in my inbox",
    "Look up the latest guidance on this",
    "Rename all my invoices",
  ];
  for (const goal of goals) {
    for (const question of ask(goal)) {
      const recommended = question.options.filter((option) => option.recommended === true);
      assert.equal(recommended.length, 1, `${question.id} in "${goal}"`);
      assert.ok(question.options.length >= 2, `${question.id} needs a real choice`);
    }
  }
});
