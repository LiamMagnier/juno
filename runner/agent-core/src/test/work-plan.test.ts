import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkPlan, planDiffIsEmpty } from '../work/plan.js';

/*
 * The plan a Work run shows the user, and the progress accounting that decides
 * when the run has stopped getting anywhere.
 *
 * The regressions these exist to catch are the ones a user experiences rather
 * than reads in a log: a completed step quietly reopening because the model
 * restated its plan, a plan that flickers because a no-op revision bumped its
 * version, two steps showing a spinner at once, and — the expensive one — a
 * run that loops until its entire budget is gone and then reports that it cost
 * the maximum and produced nothing.
 */

const STEPS = [
  { id: 'a', title: 'Collect the invoices' },
  { id: 'b', title: 'Reconcile against the ledger' },
  { id: 'c', title: 'Write the summary' },
];

test('a new plan starts at version 1 with everything pending', () => {
  const plan = new WorkPlan(STEPS);
  const snapshot = plan.snapshot();
  assert.equal(snapshot.version, 1);
  assert.deepEqual(
    snapshot.steps.map((s) => s.status),
    ['pending', 'pending', 'pending'],
  );
});

test('duplicate step ids are refused rather than deduplicated', () => {
  // A deduplicated plan has ids that do not address uniquely, and every later
  // transition would hit an arbitrary one of the duplicates.
  assert.throws(
    () => new WorkPlan([...STEPS, { id: 'a', title: 'Collect the invoices again' }]),
    /Duplicate plan step id: a/,
  );
});

test('only one step is ever active', () => {
  const plan = new WorkPlan(STEPS);
  plan.start('a');
  plan.start('b');
  const statuses = new Map(plan.snapshot().steps.map((s) => [s.id, s.status]));
  assert.equal(statuses.get('b'), 'active');
  // Back to pending, not done: nothing said the first step finished, and two
  // spinners leave the user unable to tell which step the run is on.
  assert.equal(statuses.get('a'), 'pending');
});

test('skipping and failing require a reason, and it reaches the snapshot', () => {
  const plan = new WorkPlan(STEPS);
  plan.skip('b', 'The ledger export was empty.');
  plan.fail('c', 'The template file could not be opened.');
  const steps = new Map(plan.snapshot().steps.map((s) => [s.id, s]));
  assert.equal(steps.get('b')?.reason, 'The ledger export was empty.');
  assert.equal(steps.get('c')?.status, 'failed');
});

test('revise reports what moved instead of a fresh list', () => {
  const plan = new WorkPlan(STEPS);
  plan.complete('a');
  const diff = plan.revise([
    { id: 'a', title: 'Collect the invoices' },
    { id: 'b', title: 'Reconcile against the general ledger' },
    { id: 'd', title: 'Check the VAT treatment' },
    { id: 'c', title: 'Write the summary' },
  ]);

  assert.equal(diff.fromVersion, 1);
  assert.equal(diff.toVersion, 2);
  assert.deepEqual(
    diff.added.map((s) => s.id),
    ['d'],
  );
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.retitled, [
    { id: 'b', from: 'Reconcile against the ledger', to: 'Reconcile against the general ledger' },
  ]);
  assert.equal(diff.unchanged, 2);
});

test('a revision that re-lists a finished step does not reopen it', () => {
  // The model restating its plan must not undo work the user watched finish.
  const plan = new WorkPlan(STEPS);
  plan.complete('a');
  plan.revise(STEPS);
  const a = plan.snapshot().steps.find((s) => s.id === 'a');
  assert.equal(a?.status, 'done');
});

test('a revision that changes nothing does not bump the version', () => {
  // A version bump with an empty diff makes the plan flash for no reason.
  const plan = new WorkPlan(STEPS);
  const diff = plan.revise(STEPS);
  assert.ok(planDiffIsEmpty(diff));
  assert.equal(diff.fromVersion, diff.toVersion);
  assert.equal(plan.version, 1);
});

test('removed steps are reported, and reordering is reported separately', () => {
  const plan = new WorkPlan(STEPS);
  const diff = plan.revise([
    { id: 'c', title: 'Write the summary' },
    { id: 'a', title: 'Collect the invoices' },
  ]);
  assert.deepEqual(
    diff.removed.map((s) => s.id),
    ['b'],
  );
  assert.equal(diff.reordered, true);
});

test('an explicit status in a revision is honoured, and reported as a change', () => {
  const plan = new WorkPlan(STEPS);
  const diff = plan.revise([
    { id: 'a', title: 'Collect the invoices' },
    { id: 'b', title: 'Reconcile against the ledger', status: 'skipped', reason: 'Nothing to do.' },
    { id: 'c', title: 'Write the summary' },
  ]);
  assert.deepEqual(diff.statusChanged, [
    { id: 'b', from: 'pending', to: 'skipped', reason: 'Nothing to do.' },
  ]);
});

test('a run that moves no step and makes nothing is stopped as stalled', () => {
  const plan = new WorkPlan(STEPS, { stallThreshold: 3 });
  // Distinct inputs, so this is the stall detector and not the repeat one.
  assert.equal(plan.observeToolCall('search', { q: 'one' }).state, 'progressing');
  assert.equal(plan.observeToolCall('search', { q: 'two' }).state, 'progressing');
  const verdict = plan.observeToolCall('search', { q: 'three' });
  assert.equal(verdict.state, 'stalled');
  assert.match(
    verdict.state === 'stalled' ? verdict.reason : '',
    /3 tool calls in a row moved no plan step and produced no artifact/,
  );
});

test('a step transition clears the stall counter', () => {
  const plan = new WorkPlan(STEPS, { stallThreshold: 3 });
  plan.observeToolCall('search', { q: 'one' });
  plan.observeToolCall('search', { q: 'two' });
  plan.complete('a');
  assert.equal(plan.observeToolCall('search', { q: 'three' }).state, 'progressing');
});

test('a new artifact clears the stall counter even inside one step', () => {
  // A run can legitimately produce three drafts inside a single step, and a
  // detector that only watched step transitions would kill it.
  const plan = new WorkPlan(STEPS, { stallThreshold: 2 });
  plan.observeToolCall('draft', { n: 1 });
  plan.recordArtifact('artifact-1@1');
  assert.equal(plan.observeToolCall('draft', { n: 2 }).state, 'progressing');
});

test('an answered question clears the stall counter', () => {
  // Otherwise the run that asked instead of guessing is the one that dies.
  const plan = new WorkPlan(STEPS, { stallThreshold: 2 });
  plan.observeToolCall('search', { q: 'one' });
  plan.recordAnswer('q1');
  assert.equal(plan.observeToolCall('search', { q: 'two' }).state, 'progressing');
});

test('the same call with the same arguments trips the repeat detector', () => {
  const plan = new WorkPlan(STEPS, { repetitionThreshold: 3, stallThreshold: 100 });
  const call = { path: 'ledger.csv', sheet: 'Q3' };
  for (let i = 0; i < 3; i++) {
    assert.equal(plan.observeToolCall('read_sheet', call).state, 'progressing');
  }
  const verdict = plan.observeToolCall('read_sheet', call);
  assert.equal(verdict.state, 'repeating');
  assert.equal(verdict.state === 'repeating' ? verdict.repetitions : 0, 4);
});

test('argument order does not make the same call look new', () => {
  // Without canonical serialisation the model can loop forever simply by
  // emitting its arguments in a different order each time.
  const plan = new WorkPlan(STEPS, { repetitionThreshold: 1, stallThreshold: 100 });
  plan.observeToolCall('fetch', { url: 'https://x.test', depth: 2 });
  const verdict = plan.observeToolCall('fetch', { depth: 2, url: 'https://x.test' });
  assert.equal(verdict.state, 'repeating');
});

test('the same call in two productive phases is not a loop', () => {
  const plan = new WorkPlan(STEPS, { repetitionThreshold: 1, stallThreshold: 100 });
  plan.observeToolCall('read_file', { path: 'notes.md' });
  plan.complete('a');
  assert.equal(plan.observeToolCall('read_file', { path: 'notes.md' }).state, 'progressing');
});

test('a checkpoint round-trip preserves the stall position, not just the steps', () => {
  // A resumed run that forgets it was mid-stall gets a fresh allowance every
  // time someone resumes it, which turns resume into a way around the check.
  const plan = new WorkPlan(STEPS, { stallThreshold: 3 });
  plan.start('a');
  plan.observeToolCall('search', { q: 'one' });
  plan.observeToolCall('search', { q: 'two' });

  // No options passed: the threshold comes back with the state, so a resumed
  // run behaves like the run it is continuing rather than like a fresh one.
  const restored = WorkPlan.fromJSON(plan.toJSON());
  assert.deepEqual(restored.snapshot(), plan.snapshot());
  assert.equal(restored.observeToolCall('search', { q: 'three' }).state, 'stalled');
});

test('a tightened threshold overrides what the checkpoint recorded', () => {
  const plan = new WorkPlan(STEPS, { stallThreshold: 10 });
  plan.observeToolCall('search', { q: 'one' });
  const restored = WorkPlan.fromJSON(plan.toJSON(), { stallThreshold: 2 });
  assert.equal(restored.observeToolCall('search', { q: 'two' }).state, 'stalled');
});

test('a checkpoint never carries raw tool arguments', () => {
  // The signature table is hashed: a checkpoint is not a place for a run's
  // search queries, recipients or document bodies to accumulate.
  const plan = new WorkPlan(STEPS);
  plan.observeToolCall('send_draft', { to: 'finance@example.test', body: 'secret figures' });
  const serialised = JSON.stringify(plan.toJSON());
  assert.ok(!serialised.includes('finance@example.test'));
  assert.ok(!serialised.includes('secret figures'));
});

test('outstanding lists exactly the steps that never concluded', () => {
  const plan = new WorkPlan(STEPS);
  plan.complete('a');
  plan.skip('b', 'Nothing to reconcile.');
  assert.deepEqual(
    plan.outstanding().map((s) => s.id),
    ['c'],
  );
});
