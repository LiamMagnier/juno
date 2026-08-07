import test from 'node:test';
import assert from 'node:assert/strict';
import { WORK_PLAN_TOOL_NAME, structuralValidation, updatePlanToolSpec } from '../work/session.js';
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
  // A run that got somewhere and then stopped, which is the case that keeps
  // the outstanding list. ("Never began at all" is a distinct failure with a
  // message of its own — see the next test.)
  const result = structuralValidation({
    goal: 'Reconcile the invoices',
    plan: planWith((p) => p.complete('a')),
    answer: 'Read the first invoice and stopped.',
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
  // And it must name the step that is actually outstanding, because that is
  // the only part a person can do anything with.
  assert.ok(sentence.includes('Still open:'), sentence);
  assert.ok(sentence.includes('Reconcile them'), sentence);
});

test('a run that never began says that, not "still open"', () => {
  // The exact reported failure: the model narrated an intention, called no
  // tool, and every step of the fixed three-step scaffold stayed pending.
  const result = structuralValidation({
    goal: 'Clean my GitHub and add readme to projects that doesn’t have',
    plan: planWith(),
    answer: 'First, I need to know your GitHub username. Let me fetch that information.',
    artifacts: [],
  });

  assert.equal(result.satisfied, false);
  const sentence = result.unmet.join(' ');
  assert.ok(sentence.includes('without starting the plan'), sentence);
  // The step list is what made the old message read as a problem with the
  // plan, which is a fixed scaffold identical on every run.
  assert.ok(!sentence.includes('Still open:'), sentence);
});

test('a run that got partway still lists what is outstanding', () => {
  const plan = planWith((p) => p.complete('a'));
  const result = structuralValidation({
    goal: 'Reconcile the invoices',
    plan,
    answer: 'Read the first invoice.',
    artifacts: [],
  });
  assert.equal(result.satisfied, false);
  const sentence = result.unmet.join(' ');
  // Partial progress is a different failure and keeps the specific list.
  assert.ok(sentence.includes('Still open:'), sentence);
  assert.ok(sentence.includes('Reconcile them'), sentence);
  assert.ok(!sentence.includes('without starting the plan'), sentence);
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

/*
 * The tool that lets a run finish at all.
 *
 * `startStep`/`finishStep` existed on the session, emitted the right events,
 * and were called by nothing anywhere in the repository. So a cloud run's plan
 * stayed at its fixed three pending steps for its whole life, the first
 * structural check could never pass, and *every* cloud Work run ended `failed`
 * regardless of what the model did — while telling the user the deliverable did
 * not answer the goal.
 */

test('the plan tool is offered to the model', () => {
  const spec = updatePlanToolSpec();
  assert.equal(spec.name, WORK_PLAN_TOOL_NAME);
  const props = spec.inputSchema.properties as Record<string, { enum?: string[] }>;
  // Every terminal step status the validator understands has to be reachable,
  // or a run can start a step and never legally leave it.
  assert.deepEqual(props.status?.enum, ['active', 'done', 'skipped', 'failed']);
  assert.deepEqual(spec.inputSchema.required, ['stepId', 'status']);
});

test('a plan whose steps are concluded passes the check the tool exists to satisfy', () => {
  // The end state the tool makes reachable. Before it, no code path could put
  // a cloud run's plan into this shape.
  const plan = planWith(
    (p) => p.complete('a'),
    (p) => p.skip('b', 'Nothing to reconcile.'),
  );
  const result = structuralValidation({
    goal: 'Reconcile the invoices',
    plan,
    answer: 'One invoice reconciled; Reconcile them was skipped, nothing to do.',
    artifacts: [],
  });
  assert.equal(result.satisfied, true, result.unmet.join(' | '));
});

test('a skipped step with no reason is still reported', () => {
  // The tool makes `reason` optional, so the check that catches a silent skip
  // has to keep working now that a model can produce one.
  const plan = planWith(
    (p) => p.complete('a'),
    (p) => p.skip('b', ''),
  );
  const result = structuralValidation({
    goal: 'Reconcile the invoices',
    plan,
    answer: 'Did the first, skipped Reconcile them.',
    artifacts: [],
  });
  assert.equal(result.satisfied, false);
  assert.ok(
    result.unmet.some((entry) => entry.includes('No reason recorded')),
    result.unmet.join(' | '),
  );
});
