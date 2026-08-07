import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUDGET_WARNING_FRACTION,
  WorkBudgetGuard,
  withBudget,
  type Clock,
  type WorkBudgetWarning,
} from '../work/budget.js';
import { NO_BUDGET, narrowestBudget, type WorkBudget } from '../work/types.js';

/*
 * Ceiling enforcement: tokens, spend and wall-clock runtime.
 *
 * Every test drives an injected clock rather than sleeping. A test that waits
 * out a real timeout either takes minutes or is flaky, and the case that most
 * needs covering — that time spent waiting for a person must not count against
 * the runtime ceiling — cannot be exercised at all without controlling time.
 *
 * The other thing pinned here is that the ceiling which stopped the run
 * survives into the terminal reason. Flattening runtime into "budget_exceeded"
 * sends a user to raise a spend limit that was never the problem.
 */

function fakeClock(start = 1_000): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

const TOKENS_ONLY: WorkBudget = { maxCostMicroUsd: 0, maxTokens: 100, maxRuntimeMs: 0 };

test('a guard with no ceilings never stops', () => {
  const guard = new WorkBudgetGuard({ budget: NO_BUDGET });
  guard.start();
  for (let i = 0; i < 50; i++) {
    assert.equal(guard.onStep({ inputTokens: 10_000, outputTokens: 10_000 }), undefined);
  }
  assert.equal(guard.outcome, null);
});

test('the token ceiling stops the loop and names itself', () => {
  const guard = new WorkBudgetGuard({ budget: TOKENS_ONLY });
  guard.start();
  assert.equal(guard.onStep({ inputTokens: 40, outputTokens: 10 }), undefined);
  assert.equal(guard.onStep({ inputTokens: 40, outputTokens: 20 }), 'stop');
  assert.equal(guard.outcome?.limit, 'tokens');
  assert.equal(guard.outcome?.terminalReason, 'budget_exceeded');
  assert.match(guard.outcome?.detail ?? '', /110 of 100 tokens/);
});

test('the step that trips the ceiling is still counted', () => {
  // Otherwise the last step of every stopped run is unaccounted for, and the
  // recorded usage does not add up to what the user was charged.
  const guard = new WorkBudgetGuard({ budget: TOKENS_ONLY });
  guard.start();
  guard.onStep({ inputTokens: 90, outputTokens: 0 });
  guard.onStep({ inputTokens: 30, outputTokens: 0 });
  assert.equal(guard.usage.tokens, 120);
});

test('provider input and output totals survive a checkpoint round-trip', () => {
  const guard = new WorkBudgetGuard({ budget: NO_BUDGET });
  guard.start();
  guard.onStep({ inputTokens: 37, outputTokens: 11 });
  guard.onStep({ inputTokens: 5, outputTokens: 2 });
  assert.deepEqual(
    { inputTokens: guard.usage.inputTokens, outputTokens: guard.usage.outputTokens },
    { inputTokens: 42, outputTokens: 13 },
  );

  const resumed = WorkBudgetGuard.fromJSON(guard.toJSON(), { budget: NO_BUDGET });
  assert.deepEqual(
    { inputTokens: resumed.usage.inputTokens, outputTokens: resumed.usage.outputTokens },
    { inputTokens: 42, outputTokens: 13 },
  );
});

test('cost is priced per step in integer micro-USD', () => {
  const guard = new WorkBudgetGuard({
    budget: { maxCostMicroUsd: 3_000_000, maxTokens: 0, maxRuntimeMs: 0 },
    pricing: { inputMicroUsdPerMillion: 3_000_000, outputMicroUsdPerMillion: 15_000_000 },
  });
  guard.start();
  // 100k input at $3/M + 10k output at $15/M = $0.30 + $0.15 = $0.45.
  guard.onStep({ inputTokens: 100_000, outputTokens: 10_000 });
  assert.equal(guard.usage.costMicroUsd, 450_000);
  const underCeiling = guard.outcome;
  assert.equal(underCeiling, null);

  guard.onStep({ inputTokens: 900_000, outputTokens: 0 });
  assert.equal(guard.usage.costMicroUsd, 3_150_000);
  assert.equal(guard.outcome?.limit, 'cost');
  assert.equal(guard.outcome?.terminalReason, 'budget_exceeded');
});

test('with no pricing, cost stays zero and only tokens can stop the run', () => {
  const guard = new WorkBudgetGuard({
    budget: { maxCostMicroUsd: 1, maxTokens: 0, maxRuntimeMs: 0 },
  });
  guard.start();
  guard.onStep({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(guard.usage.costMicroUsd, 0);
  assert.equal(guard.outcome, null);
});

test('the runtime ceiling reports timed_out, not budget_exceeded', () => {
  const clock = fakeClock();
  const guard = new WorkBudgetGuard({
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 60_000 },
    clock,
  });
  guard.start();
  clock.advance(59_000);
  assert.equal(guard.check(), null);
  clock.advance(2_000);
  assert.equal(guard.check()?.limit, 'runtime');
  assert.equal(guard.outcome?.terminalReason, 'timed_out');
});

test('runtime is caught by check() even when no tokens were spent', () => {
  // A run stuck in long tool calls burns runtime without a provider request,
  // so a check that only ran on token accounting would never fire for it.
  const clock = fakeClock();
  const guard = new WorkBudgetGuard({
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 10_000 },
    clock,
  });
  guard.start();
  clock.advance(11_000);
  assert.equal(guard.usage.tokens, 0);
  assert.equal(guard.check()?.limit, 'runtime');
});

test('time spent waiting for a person does not count against the ceiling', () => {
  // Otherwise the runtime limit kills precisely the runs that asked before
  // acting, and the next run learns not to ask.
  const clock = fakeClock();
  const guard = new WorkBudgetGuard({
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 60_000 },
    clock,
  });
  guard.start();
  clock.advance(30_000);
  guard.suspend();
  clock.advance(10 * 60_000);
  guard.start();
  assert.equal(guard.usage.runtimeMs, 30_000);
  assert.equal(guard.check(), null);
  clock.advance(31_000);
  assert.equal(guard.check()?.limit, 'runtime');
});

test('start is idempotent and does not restart the stopwatch', () => {
  const clock = fakeClock();
  const guard = new WorkBudgetGuard({ budget: NO_BUDGET, clock });
  guard.start();
  clock.advance(5_000);
  guard.start();
  clock.advance(5_000);
  assert.equal(guard.usage.runtimeMs, 10_000);
});

test('the outcome is sticky once a ceiling is hit', () => {
  // The terminal reason recorded on the run must not change because a later
  // check happened to find a different limit also breached.
  const clock = fakeClock();
  const guard = new WorkBudgetGuard({
    budget: { maxCostMicroUsd: 0, maxTokens: 10, maxRuntimeMs: 1_000 },
    clock,
  });
  guard.start();
  guard.onStep({ inputTokens: 20, outputTokens: 0 });
  assert.equal(guard.outcome?.limit, 'tokens');
  clock.advance(10_000);
  assert.equal(guard.check()?.limit, 'tokens');
});

test('a warning fires once per limit at the threshold', () => {
  const warnings: WorkBudgetWarning[] = [];
  const guard = new WorkBudgetGuard({
    budget: { maxCostMicroUsd: 0, maxTokens: 1_000, maxRuntimeMs: 0 },
    onWarning: (warning) => warnings.push(warning),
  });
  guard.start();
  guard.onStep({ inputTokens: 700, outputTokens: 0 });
  assert.equal(warnings.length, 0);
  guard.onStep({ inputTokens: 150, outputTokens: 0 });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.limit, 'tokens');
  assert.ok((warnings[0]?.fraction ?? 0) >= BUDGET_WARNING_FRACTION);
  // Repeated warnings about the same limit are noise the user learns to skip.
  guard.onStep({ inputTokens: 50, outputTokens: 0 });
  assert.equal(warnings.length, 1);
});

test('a checkpoint round-trip preserves spend, elapsed time and the warning', () => {
  // A resumed run that forgets what it spent gets a fresh budget every time
  // someone resumes it, which turns pause/resume into a way around the limit.
  const clock = fakeClock();
  const warnings: WorkBudgetWarning[] = [];
  const options = {
    budget: { maxCostMicroUsd: 0, maxTokens: 1_000, maxRuntimeMs: 100_000 },
    clock,
    onWarning: (warning: WorkBudgetWarning) => warnings.push(warning),
  };
  const guard = new WorkBudgetGuard(options);
  guard.start();
  guard.onStep({ inputTokens: 850, outputTokens: 0 });
  clock.advance(20_000);
  const state = guard.toJSON();
  assert.equal(warnings.length, 1);

  const resumed = WorkBudgetGuard.fromJSON(state, options);
  assert.equal(resumed.usage.tokens, 850);
  assert.equal(resumed.usage.runtimeMs, 20_000);
  resumed.start();
  resumed.onStep({ inputTokens: 50, outputTokens: 0 });
  assert.equal(warnings.length, 1, 'the same 80% must not be announced again');
  assert.equal(resumed.onStep({ inputTokens: 200, outputTokens: 0 }), 'stop');
});

test('withBudget composes, and the ceiling cannot be overridden by the inner hook', () => {
  const guard = new WorkBudgetGuard({ budget: TOKENS_ONLY });
  guard.start();
  const seen: number[] = [];
  const onStep = withBudget(guard, (usage) => {
    seen.push(usage.inputTokens);
  });
  assert.equal(onStep({ inputTokens: 10, outputTokens: 0 }), undefined);
  assert.equal(onStep({ inputTokens: 200, outputTokens: 0 }), 'stop');
  assert.deepEqual(seen, [10, 200]);
});

test('withBudget honours an inner hook that wants to stop', () => {
  const guard = new WorkBudgetGuard({ budget: NO_BUDGET });
  guard.start();
  const onStep = withBudget(guard, () => 'stop');
  assert.equal(onStep({ inputTokens: 1, outputTokens: 1 }), 'stop');
  assert.equal(guard.usage.tokens, 2, 'the step is recorded even when the inner hook stops');
});

test('narrowest budget treats zero as unlimited, not as a ceiling of zero', () => {
  // A naive Math.min lets an unset session budget clamp a schedule's real one
  // to zero and stop every run instantly.
  const narrowed = narrowestBudget(
    { maxCostMicroUsd: 0, maxTokens: 500, maxRuntimeMs: 0 },
    { maxCostMicroUsd: 2_000_000, maxTokens: 0, maxRuntimeMs: 60_000 },
  );
  assert.deepEqual(narrowed, {
    maxCostMicroUsd: 2_000_000,
    maxTokens: 500,
    maxRuntimeMs: 60_000,
  });
});
