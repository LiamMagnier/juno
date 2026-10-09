/**
 * The `workflow` tool (SPEC §3.4): the orchestrator writes a short JavaScript
 * program that fans work out to child agents — `agent()`, `parallel()`,
 * `pipeline()`, `phase()`, `log()` — and the engine runs it in a locked-down
 * process under a HARD token / cost budget shared by every child it starts.
 *
 * The script vocabulary and the `meta` block ({name, description, whenToUse,
 * phases[{title, detail, model}]}) match Claude Code workflows and DeepSeek
 * Harness's workflow-ptc (MIT), so a script written for either runs here.
 * What dsh lacks and this adds is the budget: every child's every request is
 * charged to the run's ledger, the first request past the line stops all of
 * them, and the script ends with `stopReason: 'budget'`.
 *
 * Isolation (see workflow-guest.ts): a separate `node --permission` process
 * (no filesystem, no child processes, no workers, empty environment), a vm
 * context with code generation from strings disabled, hooks created inside
 * that context. The host kills the process on Stop, on the budget and at the
 * wall-clock limit.
 */

import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import type { Usage } from '../types.js';
import type { EffortLevel } from '../contracts/code-v2.js';
import { EFFORT_LEVEL_VALUES } from '../contracts/code-v2.js';
import { BudgetLedger, type BudgetSnapshot } from './budget.js';
import { WORKFLOW_GUEST_SOURCE } from './workflow-guest.js';
import { schemaProblem, type JsonSchema } from './output-schema.js';

export interface WorkflowPhase {
  title: string;
  detail?: string;
  provider?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowPhase[];
}

export interface WorkflowAgentRequest {
  prompt: string;
  label: string;
  phase?: string;
  schema?: JsonSchema;
  model?: string;
  provider?: string;
  effort?: EffortLevel;
  /** A subagent role (explorer, builder, reviewer…). */
  role?: string;
  /** `worktree`: the child may write, in its own git worktree. */
  isolation?: 'worktree' | 'none';
}

export interface WorkflowChildResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  error?: string;
  usage: Usage;
}

/** How the run starts a child; the subagent manager implements it. */
export interface WorkflowChildPort {
  start(request: WorkflowAgentRequest, context: { signal: AbortSignal; budget: BudgetLedger; seq: number }): Promise<WorkflowChildResult>;
}

export interface WorkflowLimits {
  maxConcurrentAgents: number;
  maxTotalAgents: number;
  maxItemsPerCall: number;
  syncTimeoutMs: number;
  wallClockMs: number;
}

export const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxConcurrentAgents: 6,
  maxTotalAgents: 40,
  maxItemsPerCall: 64,
  syncTimeoutMs: 2_000,
  wallClockMs: 30 * 60_000,
};

export type WorkflowStopReason = 'completed' | 'error' | 'budget' | 'aborted' | 'timeout';

export interface WorkflowAgentRecord {
  seq: number;
  label: string;
  phase?: string;
  outcome: 'running' | 'completed' | 'failed';
  tokens: number;
}

export interface WorkflowRunResult {
  stopReason: WorkflowStopReason;
  value: unknown;
  error?: string;
  agentsStarted: number;
  agents: WorkflowAgentRecord[];
  phases: string[];
  logs: string[];
  budget: BudgetSnapshot;
}

export type WorkflowProgress =
  | { type: 'phase'; title: string }
  | { type: 'log'; message: string }
  | { type: 'agent_start'; seq: number; label: string; phase?: string }
  | { type: 'agent_end'; seq: number; label: string; phase?: string; outcome: 'completed' | 'failed'; tokens: number };

export class WorkflowInputError extends Error {}

/** Validates the meta block; a normalized copy, or a thrown WorkflowInputError naming every problem. */
export function validateWorkflowMeta(value: unknown): WorkflowMeta {
  const problems: string[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowInputError('meta must be an object with name and description');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!['name', 'description', 'whenToUse', 'phases'].includes(key)) problems.push(`meta.${key} is not a recognized field`);
  }
  if (typeof record.name !== 'string' || !record.name.trim()) problems.push('meta.name must be a non-empty string');
  if (typeof record.description !== 'string' || !record.description.trim()) problems.push('meta.description must be a non-empty string');
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') problems.push('meta.whenToUse must be a string');
  const phases: WorkflowPhase[] = [];
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) problems.push('meta.phases must be an array');
    else
      record.phases.forEach((raw, index) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          problems.push(`meta.phases[${index}] must be an object`);
          return;
        }
        const phase = raw as Record<string, unknown>;
        for (const key of Object.keys(phase)) {
          if (!['title', 'detail', 'provider', 'model'].includes(key)) problems.push(`meta.phases[${index}].${key} is not a recognized field`);
        }
        if (typeof phase.title !== 'string' || !phase.title) problems.push(`meta.phases[${index}].title must be a non-empty string`);
        for (const key of ['detail', 'provider', 'model'] as const) {
          if (phase[key] !== undefined && typeof phase[key] !== 'string') problems.push(`meta.phases[${index}].${key} must be a string`);
        }
        phases.push({
          title: String(phase.title ?? ''),
          ...(typeof phase.detail === 'string' ? { detail: phase.detail } : {}),
          ...(typeof phase.provider === 'string' ? { provider: phase.provider } : {}),
          ...(typeof phase.model === 'string' ? { model: phase.model } : {}),
        });
      });
  }
  if (problems.length > 0) throw new WorkflowInputError(`invalid meta: ${problems.join('; ')}`);
  return {
    name: String(record.name).trim(),
    description: String(record.description).trim(),
    ...(typeof record.whenToUse === 'string' ? { whenToUse: record.whenToUse } : {}),
    ...(record.phases !== undefined ? { phases } : {}),
  };
}

const AGENT_OPTIONS = new Set(['label', 'phase', 'schema', 'model', 'provider', 'effort', 'role', 'agentType', 'isolation']);

/** Reads `agent(prompt, opts)`'s options; throws a message for the script. */
export function readAgentOptions(prompt: string, raw: unknown, currentPhase: string | undefined): WorkflowAgentRequest {
  const firstLine = prompt.split('\n')[0] ?? prompt;
  const base: WorkflowAgentRequest = {
    prompt,
    label: firstLine.length <= 48 ? firstLine : `${firstLine.slice(0, 47)}…`,
    ...(currentPhase ? { phase: currentPhase } : {}),
  };
  if (raw === null || raw === undefined) return base;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new WorkflowInputError('agent() options must be an object');
  const opts = raw as Record<string, unknown>;
  for (const key of Object.keys(opts)) {
    if (!AGENT_OPTIONS.has(key)) {
      throw new WorkflowInputError(`agent() option "${key}" is not supported (label, phase, schema, model, provider, effort, role, isolation)`);
    }
  }
  for (const key of ['label', 'phase', 'model', 'provider', 'role', 'agentType'] as const) {
    if (opts[key] !== undefined && typeof opts[key] !== 'string') throw new WorkflowInputError(`agent() option "${key}" must be a string`);
  }
  if (opts.effort !== undefined && !(EFFORT_LEVEL_VALUES as readonly unknown[]).includes(opts.effort)) {
    throw new WorkflowInputError(`agent() option "effort" must be one of ${EFFORT_LEVEL_VALUES.join(', ')}`);
  }
  if (opts.isolation !== undefined && opts.isolation !== 'worktree' && opts.isolation !== 'none') {
    throw new WorkflowInputError('agent() option "isolation" must be "worktree" or "none"');
  }
  if (opts.schema !== undefined) {
    const problem = schemaProblem(opts.schema);
    if (problem) throw new WorkflowInputError(`agent() schema: ${problem}`);
  }
  return {
    ...base,
    ...(typeof opts.label === 'string' ? { label: opts.label } : {}),
    ...(typeof opts.phase === 'string' ? { phase: opts.phase } : {}),
    ...(opts.schema !== undefined ? { schema: opts.schema as JsonSchema } : {}),
    ...(typeof opts.model === 'string' ? { model: opts.model } : {}),
    ...(typeof opts.provider === 'string' ? { provider: opts.provider } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort as EffortLevel } : {}),
    ...(typeof opts.role === 'string' ? { role: opts.role } : typeof opts.agentType === 'string' ? { role: opts.agentType } : {}),
    ...(opts.isolation !== undefined ? { isolation: opts.isolation as 'worktree' | 'none' } : {}),
  };
}

function permissionFlags(): string[] {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has('--permission')) return ['--permission'];
  if (flags.has('--experimental-permission')) return ['--experimental-permission'];
  return [];
}


let guestProbe: boolean | undefined;
/**
 * Whether this host can start the isolated guest at all. Some sandboxes and
 * emulated containers (linux/amd64 under emulation on Apple silicon) refuse
 * `node --permission` on start-up, reading /proc paths the permission model
 * blocks. Callers and tests use this to say so plainly instead of failing late.
 */
export function workflowGuestAvailable(nodePath: string = process.execPath): boolean {
  if (guestProbe !== undefined) return guestProbe;
  const result = spawnSync(nodePath, [...permissionFlags(), '-e', 'process.stdout.write("ok")'], { env: {}, encoding: 'utf8', timeout: 10_000 });
  guestProbe = result.status === 0 && result.stdout === 'ok';
  return guestProbe;
}

export interface RunWorkflowInput {
  meta: WorkflowMeta;
  script: string;
  args?: unknown;
  limits?: Partial<WorkflowLimits>;
  /** The run's ledger; exhausting it stops every child and the script. */
  budget: BudgetLedger;
  children: WorkflowChildPort;
  signal: AbortSignal;
  onProgress?: (progress: WorkflowProgress) => void;
  /** The node binary that runs the guest (defaults to this process's). */
  nodePath?: string;
}

export async function runWorkflow(input: RunWorkflowInput): Promise<WorkflowRunResult> {
  const limits: WorkflowLimits = { ...DEFAULT_WORKFLOW_LIMITS, ...input.limits };
  const phases: string[] = [];
  const logs: string[] = [];
  const agents: WorkflowAgentRecord[] = [];
  let currentPhase: string | undefined;
  let started = 0;
  let active = 0;
  const waiters: Array<() => void> = [];
  const runAbort = new AbortController();
  let stop: WorkflowStopReason | null = null;
  const halt = (reason: WorkflowStopReason) => {
    if (stop === null) stop = reason;
    runAbort.abort();
  };
  const onAbort = () => halt('aborted');
  input.signal.addEventListener('abort', onAbort, { once: true });
  if (input.signal.aborted) halt('aborted');
  const unsubscribe = input.budget.onExhausted(() => halt('budget'));
  const wall = setTimeout(() => halt('timeout'), limits.wallClockMs);
  wall.unref?.();

  const child = spawn(input.nodePath ?? process.execPath, [...permissionFlags(), '-e', WORKFLOW_GUEST_SOURCE], {
    env: {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 8_000) stderr += chunk.toString('utf8');
  });
  const send = (message: unknown) => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  runAbort.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });

  const acquire = async () => {
    if (active < limits.maxConcurrentAgents) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = () => {
    active -= 1;
    waiters.shift()?.();
  };

  const handleAgent = async (callId: string, prompt: string, opts: unknown) => {
    const reply = (body: { ok: boolean; value?: unknown; error?: string; fatal?: boolean }) =>
      send({ type: 'agent_result', callId, ...body });
    let request: WorkflowAgentRequest;
    try {
      request = readAgentOptions(prompt, opts, currentPhase);
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error), fatal: true });
      return;
    }
    if (input.budget.exhausted) {
      reply({ ok: false, error: `budget: ${input.budget.reason ?? 'exhausted'}`, fatal: true });
      return;
    }
    if (started >= limits.maxTotalAgents) {
      reply({ ok: false, error: `this run reached its cap of ${limits.maxTotalAgents} agents`, fatal: true });
      return;
    }
    started += 1;
    const seq = started;
    const record: WorkflowAgentRecord = { seq, label: request.label, ...(request.phase ? { phase: request.phase } : {}), outcome: 'running', tokens: 0 };
    agents.push(record);
    await acquire();
    try {
      if (runAbort.signal.aborted) {
        record.outcome = 'failed';
        reply({ ok: false, error: stop === 'budget' ? 'budget exhausted' : 'the run stopped', fatal: true });
        return;
      }
      input.onProgress?.({ type: 'agent_start', seq, label: request.label, ...(request.phase ? { phase: request.phase } : {}) });
      let result: WorkflowChildResult;
      try {
        result = await input.children.start(request, { signal: runAbort.signal, budget: input.budget, seq });
      } catch (error) {
        result = { ok: false, text: '', error: error instanceof Error ? error.message : String(error), usage: { inputTokens: 0, outputTokens: 0 } };
      }
      record.tokens = result.usage.inputTokens + result.usage.outputTokens;
      record.outcome = result.ok ? 'completed' : 'failed';
      input.onProgress?.({
        type: 'agent_end',
        seq,
        label: request.label,
        ...(request.phase ? { phase: request.phase } : {}),
        outcome: record.outcome,
        tokens: record.tokens,
      });
      if (runAbort.signal.aborted) {
        reply({ ok: false, error: stop === 'budget' ? `budget: ${input.budget.reason ?? 'exhausted'}` : 'the run stopped', fatal: true });
      } else if (result.ok) {
        reply({ ok: true, value: request.schema ? result.structured ?? null : result.text });
      } else {
        reply({ ok: false, error: result.error ?? 'the agent did not finish' });
      }
    } finally {
      release();
    }
  };

  const outcome = await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    let settled = false;
    const finish = (value: { ok: boolean; value?: unknown; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (message.type) {
        case 'agent':
          void handleAgent(String(message.callId), String(message.prompt ?? ''), message.opts);
          break;
        case 'phase': {
          const title = String(message.title ?? '').slice(0, 200);
          currentPhase = title;
          phases.push(title);
          input.onProgress?.({ type: 'phase', title });
          break;
        }
        case 'log': {
          const text = String(message.message ?? '').slice(0, 2_000);
          if (logs.length < 200) logs.push(text);
          input.onProgress?.({ type: 'log', message: text });
          break;
        }
        case 'done':
          finish({
            ok: message.ok === true,
            value: message.value,
            ...(typeof message.error === 'string' ? { error: message.error } : {}),
          });
          break;
      }
    });
    child.on('exit', (code, signal) => {
      finish({
        ok: false,
        error: stop !== null ? `the workflow was stopped (${stop})` : `the workflow process exited (${signal ?? code})${stderr ? `: ${stderr.trim().slice(0, 1_000)}` : ''}`,
      });
    });
    child.on('error', (error) => finish({ ok: false, error: `the workflow process could not start: ${error.message}` }));
    send({ type: 'init', meta: input.meta, body: input.script, args: input.args, limits: { syncTimeoutMs: limits.syncTimeoutMs } });
  });

  // Whatever is still running belongs to a script that has ended.
  if (!runAbort.signal.aborted) runAbort.abort();
  clearTimeout(wall);
  unsubscribe();
  input.signal.removeEventListener('abort', onAbort);
  child.kill('SIGKILL');

  const stopReason: WorkflowStopReason = (stop as WorkflowStopReason | null) ?? (outcome.ok ? "completed" : "error");
  return {
    stopReason,
    value: outcome.ok ? outcome.value ?? null : null,
    ...(outcome.ok
      ? {}
      : { error: stopReason === 'budget' ? `Stopped: ${input.budget.reason ?? 'the budget was reached'}.` : outcome.error ?? 'the workflow failed' }),
    agentsStarted: started,
    agents,
    phases,
    logs,
    budget: input.budget.snapshot(),
  };
}

/** The tool spec the orchestrator sees. */
export const WORKFLOW_TOOL_SPEC = {
  name: 'workflow',
  description:
    'Run a multi-agent workflow: a short JavaScript program (an async function body) that fans work out to child agents and returns a JSON value. Hooks: agent(prompt, {label?, phase?, schema?, model?, effort?, role?, isolation?}) → the child\'s final text (or the structured value when schema is given; null when it fails inside parallel/pipeline); parallel([() => …]) runs thunks concurrently; pipeline(items, stage1, stage2…) runs per-item stage chains; phase(title) labels what follows; log(message) narrates; args holds the args you pass. No filesystem, network or require — only agents do work. Every child is charged to a hard token/cost budget; reaching it stops the whole run.',
  inputSchema: {
    type: 'object',
    properties: {
      meta: {
        type: 'object',
        description: '{name, description, whenToUse?, phases?: [{title, detail?, model?}]}',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          whenToUse: { type: 'string' },
          phases: { type: 'array', items: { type: 'object' } },
        },
        required: ['name', 'description'],
      },
      script: { type: 'string', description: 'The body of an async function. Use await; return a JSON value.' },
      args: { description: 'Any JSON value, available to the script as `args`.' },
      budget: {
        type: 'object',
        description: 'Optional tighter budget for this run: {maxTokens?, maxUsd?}. The session budget always applies too.',
        properties: { maxTokens: { type: 'number' }, maxUsd: { type: 'number' } },
      },
    },
    required: ['meta', 'script'],
  },
} as const;
