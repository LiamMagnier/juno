import test from 'node:test';
import assert from 'node:assert/strict';
import { structuralValidation } from '../work/session.js';
import { WorkPlan } from '../work/plan.js';

/*
 * What a run tells the user when it refuses to call itself done.
 *
 * `structuralValidation` decides whether a Work run may report success, and
 * `terminalOutcome` interpolates its `unmet` list straight into the sentence
 * the user reads:
 *
 *   The deliverable does not yet answer the goal: <unmet joined>
 *
 * That makes the wording of `unmet` load-bearing rather than cosmetic. It used
 * to carry each failing check's `claim`, and a claim is written as the thing
 * that is true when the check *passes* — so a real run that stopped with every
 * step still open told its user:
 *
 *   The deliverable does not yet answer the goal: Every planned step reached
 *   a conclusion.
 *
 * which states the opposite of what happened and names nothing to act on. The
 * tests below are about that sentence being true and specific, which no test
 * covered before.
 */

const STEPS = [
  { id: 'a', title: 'Read the invoices' },
  { id: 'b', title: 'Reconcile them' },
];

function planWith(...mutate: Array<(plan: WorkPlan) => void>): WorkPlan {
  const plan = new WorkPlan(STEPS);
  for (const step of mutate) step(plan);
  return plan;
}

test('a satisfied run reports nothing unmet', () => {
  const plan = planWith(
    (p) => p.complete('a'),
    (p) => p.complete('b'),
  );
  const result = structuralValidation({
    goal: 'Reconcile the invoices',
    plan,
    answer: 'Both invoices reconcile.',
    artifacts: [],
  });
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.unmet, []);
});

test('an unmet check reports what went wrong, not the claim that would have passed', () => {
  // The exact shape of the reported run: the model answered in prose without
  // advancing a single step, so every step is still open.
  const result = structuralValidation({
    goal: 'clean my GitHub & add readme on projects that doesn’t have',
    plan: planWith(),
    answer: 'What I need from you: what does "clean my GitHub" mean?',
    artifacts: [],
  });

  assert.equal(result.satisfied, false);

  const sentence = `The deliverable does not yet answer the goal: ${result.unmet.join(' ')}`;

  // The regression, stated as the assertion it needs to be: the success
  // wording must never appear as the reason for a failure.
  assert.ok(
    !sentence.includes('Every planned step reached a conclusion.'),
    `the failure sentence asserts the check passed: ${sentence}`,
  );
  // And it must name the steps that are actually outstanding, because that is
  // the only part a person can do anything with.
  assert.ok(sentence.includes('Still open:'), sentence);
  assert.ok(sentence.includes('Read the invoices'), sentence);
  assert.ok(sentence.includes('Reconcile them'), sentence);
});

test('a run that produced nothing says so', () => {
  const result = structuralValidation({
    goal: 'Write the summary',
    plan: planWith(
      (p) => p.complete('a'),
      (p) => p.complete('b'),
    ),
    answer: '   ',
    artifacts: [],
  });
  assert.equal(result.satisfied, false);
  assert.ok(
    result.unmet.some((entry) => entry.includes('No artifact and no written answer')),
    result.unmet.join(' | '),
  );
});

test('every unmet entry is evidence rather than a restated claim', () => {
  // A structural guarantee rather than a wording check: whatever checks exist,
  // no entry in `unmet` may be one of the `claim` strings, because those read
  // as successes.
  const result = structuralValidation({
    goal: 'Do the thing',
    plan: planWith(),
    answer: '',
    artifacts: [],
  });
  assert.equal(result.satisfied, false);
  const claims = new Set(result.checks.map((check) => check.claim));
  for (const entry of result.unmet) {
    assert.ok(!claims.has(entry), `"${entry}" is a claim, not evidence`);
  }
  // Each unmet entry corresponds to a failing check's evidence.
  const failedEvidence = new Set(
    result.checks.filter((check) => !check.satisfied).map((check) => check.evidence),
  );
  for (const entry of result.unmet) {
    assert.ok(failedEvidence.has(entry), `"${entry}" is not any failing check's evidence`);
  }
});
