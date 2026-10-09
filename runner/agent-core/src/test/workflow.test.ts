import test from 'node:test';
import assert from 'node:assert/strict';
import { BudgetLedger } from '../harness/budget.js';
import {
  readAgentOptions,
  runWorkflow,
  validateWorkflowMeta,
  type WorkflowChildPort,
  type WorkflowProgress,
} from '../harness/workflow.js';

const meta = { name: 'demo', description: 'test workflow' };

function port(
  answer: (prompt: string, opts: { schema?: unknown; seq: number }) => { text: string; structured?: unknown; tokens?: number; ok?: boolean; delayMs?: number },
): WorkflowChildPort & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async start(request, ctx) {
      prompts.push(request.prompt);
      const result = answer(request.prompt, { ...(request.schema ? { schema: request.schema } : {}), seq: ctx.seq });
      if (result.delayMs) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, result.delayMs);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      const tokens = result.tokens ?? 10;
      ctx.budget.charge({ inputTokens: tokens, outputTokens: 0 });
      return {
        ok: result.ok ?? true,
        text: result.text,
        ...(result.structured === undefined ? {} : { structured: result.structured }),
        usage: { inputTokens: tokens, outputTokens: 0 },
      };
    },
  };
}

test('workflow runs agent/parallel/pipeline/phase/log and returns JSON', async () => {
  const progress: WorkflowProgress[] = [];
  const children = port((prompt) => ({ text: `done:${prompt}` }));
  const result = await runWorkflow({
    meta,
    script: `
      phase('Explore');
      log('starting');
      const [a, b] = await parallel([() => agent('one'), () => agent('two')]);
      const piped = await pipeline(args.items, (x) => agent('p-' + x), (prev) => prev.toUpperCase());
      return { a, b, piped };
    `,
    args: { items: ['x', 'y'] },
    budget: new BudgetLedger({ maxTokens: 1_000 }),
    children,
    signal: new AbortController().signal,
    onProgress: (p) => progress.push(p),
  });
  assert.equal(result.stopReason, 'completed', result.error);
  assert.deepEqual(result.value, { a: 'done:one', b: 'done:two', piped: ['DONE:P-X', 'DONE:P-Y'] });
  assert.equal(result.agentsStarted, 4);
  assert.deepEqual(result.phases, ['Explore']);
  assert.deepEqual(result.logs, ['starting']);
  assert.ok(progress.some((p) => p.type === 'agent_start' && p.phase === 'Explore'));
  assert.equal(result.budget.tokens, 40);
});

test('structured agents return the schema value; a failed child is null inside parallel', async () => {
  const children = port((prompt) =>
    prompt === 'bad' ? { text: '', ok: false } : { text: '{"n":1}', structured: { n: 1 } },
  );
  const result = await runWorkflow({
    meta,
    script: `return await parallel([() => agent('good', { schema: { type: 'object' } }), () => agent('bad')]);`,
    budget: new BudgetLedger(),
    children,
    signal: new AbortController().signal,
  });
  assert.equal(result.stopReason, 'completed', result.error);
  assert.deepEqual(result.value, [{ n: 1 }, null]);
});

test('the hard budget stops every child and the script, even inside parallel', async () => {
  const children = port((_prompt, { seq }) => (seq === 1 ? { text: 'first', tokens: 600 } : { text: 'slow', tokens: 600, delayMs: 50 }));
  const result = await runWorkflow({
    meta,
    script: `
      await agent('a');
      const rest = await parallel([() => agent('b'), () => agent('c'), () => agent('d')]);
      return rest;
    `,
    budget: new BudgetLedger({ maxTokens: 1_000 }),
    children,
    signal: new AbortController().signal,
  });
  assert.equal(result.stopReason, 'budget');
  assert.match(result.error ?? '', /token budget/);
  assert.ok(result.budget.exhausted);
  // Exhausted after the second child's charge: the rest never start.
  assert.ok(result.agentsStarted <= 4);
});

test('the script cannot reach the filesystem, require, process or the host Function', async () => {
  const children = port(() => ({ text: 'x' }));
  const probes = [
    `return typeof require + ',' + typeof process + ',' + typeof fetch;`,
    `return agent.constructor('return process')();`,
    `return (async () => {}).constructor('return 1')();`,
    `return eval('1 + 1');`,
  ];
  const results = [];
  for (const script of probes) {
    results.push(
      await runWorkflow({ meta, script, budget: new BudgetLedger(), children, signal: new AbortController().signal }),
    );
  }
  assert.equal(results[0]!.value, 'undefined,undefined,undefined');
  for (const result of results.slice(1)) {
    assert.equal(result.stopReason, 'error');
    assert.match(result.error ?? '', /Code generation from strings disallowed|EvalError/);
  }
});

test('Stop kills the guest, and an infinite loop hits the sync slice limit', async () => {
  const controller = new AbortController();
  const children = port(() => ({ text: 'slow', delayMs: 5_000 }));
  const pending = runWorkflow({ meta, script: `return await agent('wait');`, budget: new BudgetLedger(), children, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const stopped = await pending;
  assert.equal(stopped.stopReason, 'aborted');

  const looped = await runWorkflow({
    meta,
    script: `while (true) {}`,
    limits: { syncTimeoutMs: 100 },
    budget: new BudgetLedger(),
    children,
    signal: new AbortController().signal,
  });
  assert.equal(looped.stopReason, 'error');
  assert.match(looped.error ?? '', /timed out/i);
});

test('meta and agent options are validated by name', () => {
  assert.throws(() => validateWorkflowMeta({ name: 'x' }), /meta.description/);
  assert.throws(() => validateWorkflowMeta({ name: 'x', description: 'y', bogus: 1 }), /meta.bogus/);
  assert.deepEqual(validateWorkflowMeta({ name: 'x', description: 'y', phases: [{ title: 'P', model: 'sonnet' }] }).phases, [
    { title: 'P', model: 'sonnet' },
  ]);
  assert.throws(() => readAgentOptions('p', { temperature: 1 }, undefined), /not supported/);
  assert.throws(() => readAgentOptions('p', { effort: 'extreme' }, undefined), /effort/);
  const request = readAgentOptions('Review the API\nmore', { agentType: 'reviewer', effort: 'high' }, 'Review');
  assert.equal(request.label, 'Review the API');
  assert.equal(request.role, 'reviewer');
  assert.equal(request.phase, 'Review');
});
