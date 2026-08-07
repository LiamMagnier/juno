import test from 'node:test';
import assert from 'node:assert/strict';
import { goalValidator } from '../work/judge.js';
import { WorkPlan } from '../work/plan.js';
import type { ProviderAdapter, ProviderStreamEvent } from '../providers/types.js';

/*
 * The check that reads a deliverable against its goal.
 *
 * `structuralValidation` is handed the goal and does not read it, so a run that
 * ticked its own boxes and returned a paragraph about something else was
 * reported as finished. This closes that — but a judge that fails borderline
 * work is worse than no judge, because the run has already been done and paid
 * for and the only remedy offered is to run it again.
 *
 * So the calibration *is* the feature, and it is what these tests are about:
 * fail only the plainly-unrelated, pass anything arguable, and never turn a
 * provider hiccup into a failed run.
 */

const STEPS = [
  { id: 'a', title: 'Read the invoices' },
  { id: 'b', title: 'Reconcile them' },
];

function donePlan(): WorkPlan {
  const plan = new WorkPlan(STEPS);
  plan.complete('a');
  plan.complete('b');
  return plan;
}

/** A provider that replies with one fixed line, or misbehaves on demand. */
function stubProvider(behaviour: { reply?: string; throws?: boolean; hangs?: boolean }): ProviderAdapter {
  return {
    id: 'stub',
    name: 'Stub',
    defaultModel: 'stub-1',
    models: () => ['stub-1'],
    capabilities: () => ({
      tools: true,
      vision: false,
      computerUse: false,
      reasoningLevels: [],
      maxContext: 100_000,
      streaming: true,
      mcp: false,
    }),
    async *stream(req): AsyncGenerator<ProviderStreamEvent> {
      if (behaviour.throws) throw new Error('provider is down');
      if (behaviour.hangs) {
        await new Promise((resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      yield { type: 'text_delta', text: behaviour.reply ?? '' };
    },
  };
}

function validatorWith(behaviour: Parameters<typeof stubProvider>[0], timeoutMs?: number) {
  return goalValidator({
    provider: stubProvider(behaviour),
    model: 'stub-1',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const RUN = {
  goal: 'Reconcile the Q3 invoices',
  answer: 'All 64 invoices reconcile except three, listed below.',
  artifacts: [],
};

test('a result that addresses the goal passes, and is reported as judged', async () => {
  const result = await validatorWith({ reply: 'YES — reconciles the invoices and lists exceptions' })({
    ...RUN,
    plan: donePlan(),
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.judged, true);
  assert.deepEqual(result.unmet, []);
});

test('a result about something else fails, and says what was missing', async () => {
  const result = await validatorWith({ reply: 'NO — asked to reconcile invoices, answered about France' })({
    ...RUN,
    answer: 'The capital of France is Paris.',
    plan: donePlan(),
  });
  assert.equal(result.satisfied, false);
  assert.equal(result.judged, true);
  assert.ok(result.unmet.join(' ').includes('invoices'), result.unmet.join(' | '));
});

test('a run that failed its own record is not sent to the judge at all', async () => {
  // Spending a model call to second-guess a failure already decided would
  // delay it and change nothing. The provider here throws, so if it were
  // called the result would differ.
  const result = await validatorWith({ throws: true })({
    ...RUN,
    plan: new WorkPlan(STEPS), // nothing completed
  });
  assert.equal(result.satisfied, false);
  assert.equal(result.judged, false);
  assert.ok(result.unmet.join(' ').includes('without starting the plan'), result.unmet.join(' | '));
});

test('a provider that is down does not fail the run, but does not claim judgement', async () => {
  // The structural checks already passed. Turning a transient hiccup into a
  // failed run destroys work that is probably fine; asserting it was judged
  // would launder a broken check into a stronger claim than was earned.
  const result = await validatorWith({ throws: true })({ ...RUN, plan: donePlan() });
  assert.equal(result.satisfied, true);
  assert.equal(result.judged, false);
  assert.ok(
    result.checks.some((check) => check.evidence.includes('could not be made')),
    'the transcript should record that the check did not happen'
  );
});

test('an unreadable reply is not guessed in either direction', async () => {
  const result = await validatorWith({ reply: 'I think it probably does address it, roughly.' })({
    ...RUN,
    plan: donePlan(),
  });
  assert.equal(result.satisfied, true, 'must not fail a run over a formatting slip');
  assert.equal(result.judged, false, 'must not claim judgement it could not read');
});

test('a stuck judge is bounded and passes rather than hanging the run', async () => {
  const result = await validatorWith({ hangs: true }, 30)({ ...RUN, plan: donePlan() });
  assert.equal(result.satisfied, true);
  assert.equal(result.judged, false);
});

test('"NO" inside a YES explanation does not flip the verdict', async () => {
  // The verdict is prefix-anchored precisely so prose cannot invert it.
  const result = await validatorWith({ reply: 'YES — no exceptions were left unexplained' })({
    ...RUN,
    plan: donePlan(),
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.judged, true);
});

test('the judge only ever adds to the structural checks, never replaces them', async () => {
  const structuralOnly = await validatorWith({ throws: true })({ ...RUN, plan: donePlan() });
  const judged = await validatorWith({ reply: 'YES — fine' })({ ...RUN, plan: donePlan() });
  // Every structural check survives in both, so a passing judge cannot hide a
  // structural problem and a failing one cannot erase the evidence.
  assert.ok(structuralOnly.checks.length >= 4);
  assert.ok(judged.checks.length >= 5);
});
