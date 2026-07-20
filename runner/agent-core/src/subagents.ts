import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  PermissionMode,
  Usage,
  UserContent,
  ToolSpec,
} from './types.js';
import type { ProviderAdapter } from './providers/types.js';
import type { ToolContext, ToolDefinition } from './tools/types.js';
import { PermissionEngine, classifyRisk } from './permissions.js';
import { runAgentLoop } from './loop.js';
import type { UsageReporter } from './usage.js';

const execFileAsync = promisify(execFile);

// MARK: Domain model

export type SubagentRole =
  | 'explorer'
  | 'architect'
  | 'builder'
  | 'reviewer'
  | 'tester'
  | 'designer'
  | 'refactorer'
  | 'docs';

export type SubagentStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type SubagentIsolation = 'shared_read_only' | 'git_worktree';

export interface SubagentSpec {
  title: string;
  prompt: string;
  role: SubagentRole;
  writes: boolean;
  dependencies: string[];
  context?: string;
  model?: string;
}

/** The durable, surface-facing snapshot of one child task. */
export interface SubagentPublicState {
  id: string;
  title: string;
  role: SubagentRole;
  model: string;
  isolation: SubagentIsolation;
  writes: boolean;
  status: SubagentStatus;
  currentActivity: string;
  usage: Usage;
  error?: string;
  /** The child's final report (capped). */
  summary?: string;
  filesChanged?: string[];
  conflictedFiles?: string[];
  commandsExecuted?: string[];
  warnings?: string[];
  worktreeBranch?: string;
  /** Whether its worktree changes were applied to the parent checkout. */
  applied?: boolean;
  startedAt?: string;
  completedAt?: string;
}

export interface SubagentConfig {
  /** false disables delegation entirely (no tools exposed). */
  enabled?: boolean;
  maxConcurrent?: number;      // clamped to 1…3
  maxPerTurn?: number;         // default 4
  maxStepsPerChild?: number;   // default 15
  childTokenBudget?: number | null; // default 400k (input+output)
  turnTokenBudget?: number | null;  // default 1M across all children of a turn
  /** Ask-before-spawning hook. Omitted = spawn without asking (headless). */
  confirmDelegation?: (specs: SubagentSpec[]) => Promise<boolean>;
}

/** What the manager needs from its owning session — a narrow seam so the
 *  manager stays free of the session's persistence concerns. */
export interface SubagentHost {
  readonly cwd: string;
  readonly model: string;
  readonly mode: PermissionMode;
  readonly provider: ProviderAdapter;
  readonly tools: ToolDefinition[];
  readonly env?: NodeJS.ProcessEnv;
  readonly usageReporter?: UsageReporter;
  emit(event: AgentEvent): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Snapshot an absolute path before the manager applies imported changes. */
  snapshotForUndo(absPath: string): void;
}

// MARK: Role capability profiles

const ROLES: SubagentRole[] = [
  'explorer', 'architect', 'builder', 'reviewer', 'tester', 'designer', 'refactorer', 'docs',
];

function roleAllowsWrites(role: SubagentRole): boolean {
  return role === 'builder' || role === 'designer' || role === 'refactorer'
    || role === 'tester' || role === 'docs';
}

function roleAllowsCommands(role: SubagentRole): boolean {
  return role !== 'explorer' && role !== 'architect';
}

/** The LOOSEST mode a child of this role may run under. */
function roleModeCeiling(role: SubagentRole): PermissionMode {
  if (role === 'explorer' || role === 'architect') return 'plan';
  return 'auto-edit';
}

const MODE_RANK: Record<PermissionMode, number> = { plan: 0, ask: 1, 'auto-edit': 2, full: 3 };

export function stricterMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

const ROLE_PROMPTS: Record<SubagentRole, string> = {
  explorer:
    'Role: EXPLORER. Investigate, never modify. Map the code that answers the question, cite exact files and lines, and report what you found — including what you could NOT find.',
  architect:
    'Role: ARCHITECT. Prioritize system design over line-level edits. Map the existing structure, weigh trade-offs explicitly, and propose small structural plans.',
  builder:
    'Role: BUILDER. Ship working code. Read enough context to be correct, make focused edits, and verify with builds or tests when commands are available.',
  reviewer:
    'Role: REVIEWER. Read carefully and critique: correctness bugs first, then security, then clarity. Point to exact files and lines with concrete failure scenarios.',
  tester:
    'Role: TESTER. Find and close coverage gaps. Write focused tests that document real behavior and run them to prove they pass. Report pass/fail honestly.',
  designer:
    'Role: DESIGNER. Focus on UI code: layout, spacing, typography, tokens and interaction states. Respect the project\'s design system.',
  refactorer:
    'Role: REFACTORER. Improve structure without changing behavior. Preserve public APIs and keep each change mechanically verifiable.',
  docs:
    'Role: DOCS. Write and update documentation. Verify claims against the actual code before writing them down.',
};

// MARK: Orchestration tool specs (root session only)

export const SUBAGENT_TOOL_NAMES = new Set([
  'delegate_tasks',
  'await_subagents',
  'inspect_subagent',
  'cancel_subagent',
]);

export function isOrchestrationTool(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name);
}

export function orchestrationToolSpecs(): ToolSpec[] {
  return [
    {
      name: 'delegate_tasks',
      description:
        'Split independent work across focused child agents that run concurrently. Returns immediately with task ids; use await_subagents to collect results. Each child starts with a FRESH context and sees only the prompt/context you provide.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short imperative title' },
                prompt: { type: 'string', description: 'Complete, self-contained instructions' },
                role: { type: 'string', enum: ROLES },
                writes: { type: 'boolean', description: 'true when the task must modify files (requires git; runs in an isolated worktree)' },
                dependencies: { type: 'array', items: { type: 'string' } },
                context: { type: 'string' },
                model: { type: 'string' },
              },
              required: ['title', 'prompt', 'role'],
            },
          },
        },
        required: ['tasks'],
      },
    },
    {
      name: 'await_subagents',
      description:
        'Wait for delegated tasks to finish and return their structured summaries (never full transcripts). Empty ids = every task of this turn.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          timeout_s: { type: 'number' },
        },
      },
    },
    {
      name: 'inspect_subagent',
      description: 'Snapshot one delegated task: status, current activity, usage, and result when finished.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'cancel_subagent',
      description: 'Cancel one delegated task safely.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ];
}

/** The delegation section appended to the ROOT system prompt when enabled. */
export function delegationPromptSection(): string {
  return `
# Delegation (subagents)
You can split genuinely independent work across child agents with delegate_tasks / await_subagents / inspect_subagent / cancel_subagent.
- Delegate ONLY meaningfully independent parts (frontend + backend + tests, separate investigations, implementation + independent review, competing debugging hypotheses). Never delegate one-line fixes, edits to the same small file, or strictly sequential work.
- At most 4 agents per turn, at most 3 running at once. Children cannot spawn further agents.
- Each child starts with a FRESH context — its prompt must be fully self-contained.
- Writing agents work in isolated git worktrees; their changes come back for review/import — never claim delegated work is applied until it is.
- After delegating, call await_subagents, then RECONCILE the summaries yourself: surface conflicts between findings, name failed tasks, report only tests that actually ran, and finish with ONE coherent summary — never paste child reports verbatim.`;
}

// MARK: Internal task state

interface WorktreeInfo {
  branch: string;
  dir: string;
  baseCommit: string;
}

interface SubagentTask {
  id: string;
  spec: SubagentSpec;
  model: string;
  isolation: SubagentIsolation;
  mode: PermissionMode;
  status: SubagentStatus;
  currentActivity: string;
  usage: Usage;
  error?: string;
  summary?: string;
  filesRead: string[];
  filesChanged: string[];
  conflictedFiles: string[];
  commandsExecuted: string[];
  warnings: string[];
  worktree?: WorktreeInfo;
  applied?: boolean;
  turnIndex: number;
  aborter: AbortController;
  startedAt?: number;
  completedAt?: number;
  done: Promise<void>;
  finish: () => void;
}

function isTerminal(status: SubagentStatus): boolean {
  return status === 'completed' || status === 'failed'
    || status === 'cancelled' || status === 'interrupted';
}

function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return slug || 'task';
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Byte-exact git output (binary-safe); empty buffer on failure. */
async function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
    });
    return stdout as unknown as Buffer;
  } catch {
    return Buffer.alloc(0);
  }
}

// MARK: Manager

/**
 * Owns the child tasks of one root AgentSession: creation, concurrency,
 * dependencies, budgets, worktree isolation, cancellation, result collection,
 * and permission-gated import of writing children's changes. Children run the
 * SAME `runAgentLoop` as the root — never a second copy of the loop — with a
 * fresh in-memory transcript and a filtered tool set. Depth is one by
 * construction: children execute through this manager's own executor, which
 * hard-rejects orchestration tools.
 */
export class SubagentManager {
  private host: SubagentHost;
  private config: Required<Omit<SubagentConfig, 'confirmDelegation'>> &
    Pick<SubagentConfig, 'confirmDelegation'>;
  private tasks = new Map<string, SubagentTask>();
  private order: string[] = [];
  private currentTurn = -1;
  private spawnedThisTurn = 0;
  private turnUsage: Usage = { inputTokens: 0, outputTokens: 0 };

  constructor(host: SubagentHost, config: SubagentConfig = {}) {
    this.host = host;
    this.config = {
      enabled: config.enabled ?? true,
      maxConcurrent: Math.max(1, Math.min(3, config.maxConcurrent ?? 3)),
      maxPerTurn: Math.max(1, Math.min(4, config.maxPerTurn ?? 4)),
      maxStepsPerChild: config.maxStepsPerChild ?? 15,
      childTokenBudget: config.childTokenBudget === undefined ? 400_000 : config.childTokenBudget,
      turnTokenBudget: config.turnTokenBudget === undefined ? 1_000_000 : config.turnTokenBudget,
      confirmDelegation: config.confirmDelegation,
    };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Child usage aggregated for the current parent turn. */
  get turnSubagentUsage(): Usage {
    return { ...this.turnUsage };
  }

  /** Called by the session at each prompt start: a fresh turn's aggregates
   *  must never inherit the previous turn's child usage. */
  beginTurn(turnIndex: number): void {
    if (turnIndex !== this.currentTurn) {
      this.currentTurn = turnIndex;
      this.spawnedThisTurn = 0;
      this.turnUsage = { inputTokens: 0, outputTokens: 0 };
    }
  }

  /** Resolves when no task is active — the session drains this before
   *  finishing a turn so a headless driver (cloud runner) can never exit,
   *  commit, or push while children still run. */
  async drainActive(): Promise<void> {
    while (this.hasActiveTasks()) {
      const pending = [...this.tasks.values()].filter((t) => !isTerminal(t.status));
      await Promise.all(pending.map((t) => t.done));
    }
  }

  hasActiveTasks(): boolean {
    return [...this.tasks.values()].some((t) => !isTerminal(t.status));
  }

  states(): SubagentPublicState[] {
    return this.order.map((id) => this.publicState(this.tasks.get(id)!));
  }

  /** Root Stop: cancel every child stream, command, and queued task. */
  cancelAll(reason = 'Cancelled'): void {
    for (const task of this.tasks.values()) {
      if (isTerminal(task.status)) continue;
      task.error = task.error ?? reason;
      if (task.status === 'queued') {
        this.settle(task, 'cancelled');
      } else {
        task.aborter.abort();
      }
    }
  }

  /** Process shutdown: running children cannot survive — mark honestly. */
  markAllInterrupted(): void {
    for (const task of this.tasks.values()) {
      if (isTerminal(task.status)) continue;
      task.error = task.error ?? 'The process quit while this agent ran.';
      if (task.status === 'queued') {
        this.settle(task, 'interrupted');
      } else {
        task.status = 'interrupted';
        task.aborter.abort();
        this.emitUpdate(task);
      }
    }
  }

  // MARK: Tool-call entry (root executor routes orchestration names here)

  async handleToolCall(
    turnIndex: number,
    call: { id: string; name: string; input: Record<string, unknown> },
  ): Promise<UserContent> {
    const respond = (content: string, isError = false): UserContent => ({
      type: 'tool_result',
      toolCallId: call.id,
      content,
      isError,
    });
    if (turnIndex !== this.currentTurn) {
      this.currentTurn = turnIndex;
      this.spawnedThisTurn = 0;
      this.turnUsage = { inputTokens: 0, outputTokens: 0 };
    }
    switch (call.name) {
      case 'delegate_tasks':
        return this.delegate(turnIndex, call.input, respond);
      case 'await_subagents':
        return this.awaitTasks(call.input, respond);
      case 'inspect_subagent':
        return Promise.resolve(this.inspect(call.input, respond));
      case 'cancel_subagent':
        return Promise.resolve(this.cancelOne(call.input, respond));
      default:
        return Promise.resolve(respond(`Unknown orchestration tool: ${call.name}`, true));
    }
  }

  // MARK: delegate_tasks

  private async delegate(
    turnIndex: number,
    input: Record<string, unknown>,
    respond: (content: string, isError?: boolean) => UserContent,
  ): Promise<UserContent> {
    if (!this.config.enabled) {
      return respond('Subagent delegation is disabled for this session.', true);
    }
    if (this.turnBudgetExhausted()) {
      return respond(
        'The delegation token budget for this turn is exhausted — no further agents can be spawned. Finish the remaining work yourself and tell the user the budget limited delegation.',
        true,
      );
    }
    const raw = input.tasks;
    if (!Array.isArray(raw) || raw.length === 0) {
      return respond("delegate_tasks needs a non-empty 'tasks' array.", true);
    }
    const remaining = this.config.maxPerTurn - this.spawnedThisTurn;
    if (raw.length > remaining) {
      return respond(
        `Too many tasks: at most ${this.config.maxPerTurn} subagents per turn (${remaining} still available). Delegate fewer, larger tasks.`,
        true,
      );
    }

    const specs: SubagentSpec[] = [];
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i] as Record<string, unknown>;
      const title = String(entry.title ?? '').trim();
      const prompt = String(entry.prompt ?? '').trim();
      const role = String(entry.role ?? '') as SubagentRole;
      if (!title || !prompt) return respond(`Task ${i + 1} is missing a title or prompt.`, true);
      if (!ROLES.includes(role)) {
        return respond(`Task ${i + 1} ('${title}') has an unknown role '${String(entry.role)}'.`, true);
      }
      const writes = Boolean(entry.writes);
      if (writes && !roleAllowsWrites(role)) {
        return respond(
          `Task ${i + 1} ('${title}') wants writes, but the '${role}' role is read-only. Use builder/designer/refactorer/tester/docs for writing work.`,
          true,
        );
      }
      specs.push({
        title,
        prompt,
        role,
        writes,
        dependencies: Array.isArray(entry.dependencies) ? entry.dependencies.map(String) : [],
        context: entry.context === undefined ? undefined : String(entry.context),
        model: entry.model === undefined ? undefined : String(entry.model),
      });
    }

    if (specs.some((s) => s.writes)) {
      if (this.host.mode === 'plan') {
        return respond('Plan mode is read-only, so children cannot write either.', true);
      }
      const isRepo = await git(this.host.cwd, ['rev-parse', '--is-inside-work-tree'])
        .then(() => true)
        .catch(() => false);
      if (!isRepo) {
        return respond(
          'This workspace is not a git repository, so parallel WRITING agents are unavailable (no worktree isolation). Delegate read-only investigations instead and make the edits yourself as the sole writer.',
          true,
        );
      }
    }

    if (this.config.confirmDelegation) {
      const approved = await this.config.confirmDelegation(specs).catch(() => false);
      if (!approved) {
        return respond('The user declined the delegation plan. Handle the work yourself.', true);
      }
    }

    // Create tasks; same-batch dependencies may reference titles.
    const created: SubagentTask[] = [];
    const idByTitle = new Map<string, string>();
    for (const spec of specs) {
      const id = randomUUID().slice(0, 8);
      const task: SubagentTask = {
        id,
        spec,
        model: spec.model ?? this.host.model,
        isolation: spec.writes ? 'git_worktree' : 'shared_read_only',
        mode: stricterMode(this.host.mode, roleModeCeiling(spec.role)),
        status: 'queued',
        currentActivity: 'Waiting to start',
        usage: { inputTokens: 0, outputTokens: 0 },
        filesRead: [],
        filesChanged: [],
        conflictedFiles: [],
        commandsExecuted: [],
        warnings: [],
        turnIndex,
        aborter: new AbortController(),
        done: Promise.resolve(),
        finish: () => {},
      };
      task.done = new Promise<void>((resolve) => {
        task.finish = resolve;
      });
      idByTitle.set(spec.title.toLowerCase(), id);
      created.push(task);
    }
    // Resolve dependency references against known ids + this batch's titles.
    const knownIds = new Set([...this.tasks.keys(), ...created.map((t) => t.id)]);
    for (const task of created) {
      const resolved: string[] = [];
      for (const reference of task.spec.dependencies) {
        if (knownIds.has(reference)) {
          resolved.push(reference);
        } else {
          const mapped = idByTitle.get(reference.toLowerCase());
          if (!mapped || mapped === task.id) {
            return respond(
              `Task '${task.spec.title}' depends on '${reference}', which matches no known task id or batch title.`,
              true,
            );
          }
          resolved.push(mapped);
        }
      }
      task.spec.dependencies = resolved;
    }

    // Reject cyclic same-batch dependencies — they would queue forever.
    {
      const batch = new Set(created.map((t) => t.id));
      const indegree = new Map<string, number>();
      const edges = new Map<string, string[]>();
      for (const task of created) {
        indegree.set(task.id, (indegree.get(task.id) ?? 0));
        for (const dep of task.spec.dependencies) {
          if (!batch.has(dep)) continue;
          indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
          edges.set(dep, [...(edges.get(dep) ?? []), task.id]);
        }
      }
      const frontier = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
      let resolved = 0;
      while (frontier.length > 0) {
        const id = frontier.pop()!;
        resolved += 1;
        for (const next of edges.get(id) ?? []) {
          const n = (indegree.get(next) ?? 1) - 1;
          indegree.set(next, n);
          if (n === 0) frontier.push(next);
        }
      }
      if (resolved < created.length) {
        return respond("The tasks' dependencies form a cycle — nothing could ever start. Break the cycle and delegate again.", true);
      }
    }

    this.spawnedThisTurn += created.length;
    for (const task of created) {
      this.tasks.set(task.id, task);
      this.order.push(task.id);
      this.emitUpdate(task);
    }
    this.startEligible();

    const lines = created.map(
      (t) =>
        `${t.id} · ${t.spec.title} · role=${t.spec.role} · ${t.spec.writes ? 'writes (worktree)' : 'read-only'} · ${t.status}`,
    );
    return respond(
      `Created ${created.length} subagent task(s) — up to ${this.config.maxConcurrent} run concurrently:\n${lines.join('\n')}\nUse await_subagents to collect their structured results.`,
    );
  }

  // MARK: Scheduling

  private runningCount(): number {
    return [...this.tasks.values()].filter(
      (t) => t.status === 'running' || t.status === 'preparing' || t.status === 'waiting_approval',
    ).length;
  }

  private turnBudgetExhausted(): boolean {
    const limit = this.config.turnTokenBudget;
    if (limit === null) return false;
    return this.turnUsage.inputTokens + this.turnUsage.outputTokens >= limit;
  }

  private startEligible(): void {
    for (const id of this.order) {
      const task = this.tasks.get(id)!;
      if (task.status !== 'queued') continue;
      if (this.runningCount() >= this.config.maxConcurrent) break;
      if (this.turnBudgetExhausted()) {
        task.error = 'Not started — the delegation token budget for this turn was reached.';
        this.settle(task, 'failed');
        continue;
      }
      const deps = task.spec.dependencies.map((d) => this.tasks.get(d)).filter(Boolean) as SubagentTask[];
      const failedDep = deps.find((d) => isTerminal(d.status) && d.status !== 'completed');
      if (failedDep) {
        task.error = `Dependency '${failedDep.spec.title}' ${failedDep.status}.`;
        this.settle(task, 'cancelled');
        continue;
      }
      if (!deps.every((d) => d.status === 'completed')) continue;
      void this.run(task);
    }
  }

  private settle(task: SubagentTask, status: SubagentStatus): void {
    task.status = status;
    task.completedAt = Date.now();
    task.currentActivity = status;
    this.emitUpdate(task);
    task.finish();
    // A settled task frees a slot / unblocks or fails dependents.
    queueMicrotask(() => this.startEligible());
  }

  // MARK: Child execution

  private async run(task: SubagentTask): Promise<void> {
    task.status = 'preparing';
    task.currentActivity = 'Preparing';
    this.emitUpdate(task);

    let cwd = this.host.cwd;
    if (task.isolation === 'git_worktree') {
      try {
        task.worktree = await this.createWorktree(task);
        cwd = task.worktree.dir;
      } catch (err) {
        task.error = `Worktree setup failed: ${err instanceof Error ? err.message : String(err)}`;
        this.settle(task, 'failed');
        return;
      }
    }
    if (task.aborter.signal.aborted) {
      // markAllInterrupted may have flipped the status from another turn of
      // the event loop — the cast defeats TS's single-flow narrowing.
      const interrupted = (task.status as SubagentStatus) === 'interrupted';
      this.settle(task, interrupted ? 'interrupted' : 'cancelled');
      return;
    }

    task.status = 'running';
    task.startedAt = Date.now();
    task.currentActivity = 'Thinking';
    this.emitUpdate(task);

    const tools = this.childTools(task);
    const toolsByName = new Map(tools.map((t) => [t.spec.name, t]));
    const permissions = new PermissionEngine(cwd);
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: this.childTaskTurn(task) }] },
    ];
    const ctx: ToolContext = { cwd, env: this.host.env };
    let budgetExhausted = false;

    const result = await runAgentLoop({
      provider: this.host.provider,
      model: task.model,
      system: this.childSystemPrompt(task, cwd),
      messages,
      tools: tools.map((t) => t.spec),
      signal: task.aborter.signal,
      maxSteps: this.config.maxStepsPerChild,
      executeToolCall: async (call) => {
        // Structural no-nesting guard on top of the tool-set guard.
        if (isOrchestrationTool(call.name)) {
          return {
            type: 'tool_result',
            toolCallId: call.id,
            content: 'Subagents cannot delegate work to further agents.',
            isError: true,
          };
        }
        return this.executeChildTool(task, toolsByName, permissions, ctx, call);
      },
      onStep: (stepUsage) => {
        task.usage = {
          inputTokens: task.usage.inputTokens + stepUsage.inputTokens,
          outputTokens: task.usage.outputTokens + stepUsage.outputTokens,
        };
        this.turnUsage = {
          inputTokens: this.turnUsage.inputTokens + stepUsage.inputTokens,
          outputTokens: this.turnUsage.outputTokens + stepUsage.outputTokens,
        };
        const budget = this.config.childTokenBudget;
        if (budget !== null && task.usage.inputTokens + task.usage.outputTokens >= budget) {
          budgetExhausted = true;
          return 'stop';
        }
      },
    }).catch((err) => {
      task.error = err instanceof Error ? err.message : String(err);
      return null;
    });

    // Children are REAL model calls: record their tokens under their own model
    // (the parent turn's single reservation already happened — children never
    // reserve; a zero-token child records nothing).
    if (this.host.usageReporter && (task.usage.inputTokens > 0 || task.usage.outputTokens > 0)) {
      await this.host.usageReporter.record(task.model, task.usage).catch(() => {});
    }

    if (budgetExhausted) {
      task.error = 'Stopped: this agent reached its token budget.';
      task.summary = result?.finalText || undefined;
      await this.removeWorktreeIfClean(task);
      this.settle(task, 'failed');
      return;
    }
    if (task.aborter.signal.aborted) {
      const interrupted = (task.status as SubagentStatus) === 'interrupted';
      await this.removeWorktreeIfClean(task);
      this.settle(task, interrupted ? 'interrupted' : 'cancelled');
      return;
    }
    if (result === null) {
      await this.removeWorktreeIfClean(task);
      this.settle(task, 'failed');
      return;
    }
    if (result.stopReason === 'max_steps') {
      task.error = `Stopped after ${this.config.maxStepsPerChild} steps without finishing.`;
      task.summary = result.finalText || undefined;
      await this.removeWorktreeIfClean(task);
      this.settle(task, 'failed');
      return;
    }

    task.summary = result.finalText || '(the agent produced no report)';
    if (task.isolation === 'git_worktree') {
      await this.importWorktreeChanges(task);
    }
    this.settle(task, 'completed');
  }

  private async executeChildTool(
    task: SubagentTask,
    toolsByName: Map<string, ToolDefinition>,
    permissions: PermissionEngine,
    ctx: ToolContext,
    call: { id: string; name: string; input: Record<string, unknown> },
  ): Promise<UserContent> {
    const tool = toolsByName.get(call.name);
    if (!tool) {
      return { type: 'tool_result', toolCallId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
    }
    const { risk, reason } = classifyRisk(tool, call.input);
    const outcome = permissions.decide(task.mode, call.name, risk);

    if (outcome === 'deny') {
      const why = task.mode === 'plan'
        ? 'Denied: this agent is read-only.'
        : 'Denied by project permission rules.';
      this.host.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason: why, agentId: task.id });
      return { type: 'tool_result', toolCallId: call.id, content: why, isError: true };
    }
    if (outcome === 'ask') {
      const request: ApprovalRequest = {
        callId: call.id,
        toolName: call.name,
        input: call.input,
        risk,
        summary: `${tool.summarize(call.input)}${risk === 'sensitive' ? ` — SENSITIVE (${reason})` : ''}`,
        agentId: task.id,
        agentLabel: `${task.spec.role} · ${task.spec.title}`,
      };
      task.status = 'waiting_approval';
      task.currentActivity = 'Waiting for approval';
      this.emitUpdate(task);
      this.host.emit({ type: 'approval_requested', request });
      const decision = await this.host.requestApproval(request);
      this.host.emit({ type: 'approval_resolved', callId: call.id, decision, agentId: task.id });
      if (!isTerminal(task.status)) {
        task.status = 'running';
        this.emitUpdate(task);
      }
      if (decision === 'deny') {
        const msg = 'The user declined this action.';
        task.warnings.push(`Denied: ${tool.summarize(call.input)}`);
        this.host.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason: msg, agentId: task.id });
        return { type: 'tool_result', toolCallId: call.id, content: msg, isError: true };
      }
      // The task may have been cancelled while the approval sat open — an
      // approval granted after Stop must never execute anything.
      if (task.aborter.signal.aborted || isTerminal(task.status)) {
        return { type: 'tool_result', toolCallId: call.id, content: 'Cancelled.', isError: true };
      }
    }

    // Worktree containment for edit tools: the child edits ITS worktree only.
    // Absolute paths (or ../ escapes) pointing outside are denied outright —
    // isolation is structural, not advisory.
    if (tool.kind === 'edit') {
      const targets = tool.mutatedPaths?.(call.input, ctx) ?? [];
      const rootPrefix = fs.realpathSync(ctx.cwd) + path.sep;
      for (const target of targets) {
        const resolved = path.resolve(ctx.cwd, target);
        // realpath the deepest EXISTING ancestor so symlinks cannot escape.
        let probe = resolved;
        while (!fs.existsSync(probe)) probe = path.dirname(probe);
        const real = fs.realpathSync(probe) + (probe === resolved ? '' : resolved.slice(probe.length));
        if (real !== rootPrefix.slice(0, -1) && !real.startsWith(rootPrefix)) {
          const msg = `Denied: ${target} is outside this agent's isolated worktree.`;
          this.host.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason: msg, agentId: task.id });
          return { type: 'tool_result', toolCallId: call.id, content: msg, isError: true };
        }
      }
    }

    task.currentActivity = tool.summarize(call.input).slice(0, 120);
    if (tool.kind === 'command') task.commandsExecuted.push(task.currentActivity);
    if (tool.kind === 'read' && call.name === 'read_file' && task.filesRead.length < 200) {
      task.filesRead.push(String(call.input.path ?? ''));
    }
    this.host.emit({ type: 'tool_started', callId: call.id, name: call.name, input: call.input, risk, agentId: task.id });
    this.emitUpdate(task);
    const started = Date.now();
    let output: string;
    let isError = false;
    try {
      const result = await tool.execute(call.input, ctx);
      output = result.output;
      isError = result.isError ?? false;
    } catch (err) {
      output = `Tool crashed: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    this.host.emit({
      type: 'tool_finished',
      callId: call.id,
      name: call.name,
      output: output.length > 2000 ? output.slice(0, 2000) + '…' : output,
      isError,
      durationMs: Date.now() - started,
      agentId: task.id,
    });
    return { type: 'tool_result', toolCallId: call.id, content: output, isError };
  }

  private childTools(task: SubagentTask): ToolDefinition[] {
    return this.host.tools.filter((tool) => {
      if (tool.kind === 'read') return true;
      if (tool.kind === 'edit') {
        return task.isolation === 'git_worktree' && task.spec.writes && roleAllowsWrites(task.spec.role);
      }
      // command
      return roleAllowsCommands(task.spec.role) && task.mode !== 'plan';
    });
  }

  private childSystemPrompt(task: SubagentTask, cwd: string): string {
    const isolation =
      task.isolation === 'git_worktree'
        ? `# Isolation: git worktree\nYou work in an isolated git worktree on branch \`${task.worktree?.branch ?? 'juno/agent'}\` (directory: ${cwd}). Your edits apply inside the worktree only; they are reviewed/imported afterwards. Do NOT commit, push, or switch branches.`
        : '# Isolation: read-only\nYou are reading the user\'s live checkout. You have NO write tools — describe proposed changes in your report instead.';
    return `You are a Juno SUBAGENT — a focused child agent handling one delegated task inside the user's repository. Work only on your assigned task; a coordinator agent integrates results.

Working directory: ${cwd}

${ROLE_PROMPTS[task.spec.role]}

${isolation}

# Boundaries
- You are a subagent: you CANNOT delegate work or spawn further agents.
- You have no access to the coordinator's conversation.
- When done, end with a concise structured report: what you did or found (exact file paths), commands you ran with their real results, test outcomes (never fabricate), warnings, and open questions. The coordinator reads ONLY this report.`;
  }

  private childTaskTurn(task: SubagentTask): string {
    const parts = [`# Task: ${task.spec.title}\n\n${task.spec.prompt}`];
    if (task.spec.context) parts.push(`# Context from the coordinator\n${task.spec.context}`);
    const depSummaries = task.spec.dependencies
      .map((id) => this.tasks.get(id))
      .filter((dep): dep is SubagentTask => Boolean(dep?.summary))
      .map((dep) => `## ${dep.spec.title} (${dep.spec.role})\n${(dep.summary ?? '').slice(0, 4000)}`);
    if (depSummaries.length > 0) {
      parts.push(`# Results from tasks you depended on\n${depSummaries.join('\n\n---\n\n')}`);
    }
    parts.push('Begin now. Remember: report concisely when done.');
    return parts.join('\n\n');
  }

  // MARK: Worktrees

  private async createWorktree(task: SubagentTask): Promise<WorktreeInfo> {
    const baseCommit = (await git(this.host.cwd, ['rev-parse', 'HEAD'])).trim();
    const branch = `juno/agent/${task.id}-${slugify(task.spec.title)}`;
    const dir = path.join(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'juno-worktrees-')),
      task.id,
    );
    await git(this.host.cwd, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
    return { branch, dir, baseCommit };
  }

  /** Drops the worktree + branch only when the child left NO changes in it —
   *  dirty worktrees are preserved for manual recovery. */
  private async removeWorktreeIfClean(task: SubagentTask): Promise<void> {
    const worktree = task.worktree;
    if (!worktree) return;
    const dirty = await git(worktree.dir, ['status', '--porcelain'])
      .then((out) => out.trim().length > 0)
      .catch(() => true);
    const committed = await git(worktree.dir, ['diff', '--name-only', worktree.baseCommit])
      .then((out) => out.trim().length > 0)
      .catch(() => true);
    if (!dirty && !committed) await this.removeWorktree(task);
  }

  private async removeWorktree(task: SubagentTask): Promise<void> {
    if (!task.worktree) return;
    await git(this.host.cwd, ['worktree', 'remove', '--force', task.worktree.dir]).catch(() => {});
    await git(this.host.cwd, ['branch', '-D', task.worktree.branch]).catch(() => {});
    await git(this.host.cwd, ['worktree', 'prune']).catch(() => {});
    task.worktree = undefined;
  }

  /**
   * Converts the finished writer's worktree diff into an explicit,
   * permission-gated import into the parent checkout: `ask` mode asks the
   * user; conflicts with the live checkout escalate to a SENSITIVE approval
   * that no mode auto-allows. Denied imports preserve the worktree and report
   * the branch. Applied paths are checkpoint-snapshotted first, so the
   * existing undo machinery covers them.
   */
  private async importWorktreeChanges(task: SubagentTask): Promise<void> {
    const worktree = task.worktree;
    if (!worktree) return;
    // -z: NUL-delimited records so quoted/special-char paths parse exactly.
    const nameStatus = await git(worktree.dir, ['diff', '--name-status', '-z', worktree.baseCommit]).catch(() => '');
    const untracked = await git(worktree.dir, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => '');
    const entries: Array<{ file: string; deleted: boolean }> = [];
    {
      const tokens = nameStatus.split('\0').filter((t) => t.length > 0);
      let i = 0;
      while (i < tokens.length) {
        const status = tokens[i++];
        if (status.startsWith('R') || status.startsWith('C')) {
          const from = tokens[i++];
          const to = tokens[i++];
          if (status.startsWith('R') && from) entries.push({ file: from, deleted: true });
          if (to) entries.push({ file: to, deleted: false });
        } else {
          const file = tokens[i++];
          if (file) entries.push({ file, deleted: status.startsWith('D') });
        }
      }
    }
    for (const file of untracked.split('\0')) {
      if (file) entries.push({ file, deleted: false });
    }

    // Buffers end to end: binary files must round-trip byte-exact.
    const changes: Array<{ file: string; content: Buffer | null; conflicted: boolean }> = [];
    for (const { file, deleted } of entries) {
      if (!file || changes.some((c) => c.file === file)) continue;
      const workPath = path.join(worktree.dir, file);
      const exists = fs.existsSync(workPath);
      const content = deleted || !exists ? null : fs.readFileSync(workPath);
      const base = await gitBuffer(worktree.dir, ['show', `${worktree.baseCommit}:${file}`]);
      const mainPath = path.join(this.host.cwd, file);
      const main = fs.existsSync(mainPath) ? fs.readFileSync(mainPath) : Buffer.alloc(0);
      if (content !== null && content.equals(main)) continue; // already identical
      if (content === null && !fs.existsSync(mainPath)) continue; // deleting a ghost
      changes.push({ file, content, conflicted: !main.equals(base) });
    }
    if (changes.length === 0) {
      await this.removeWorktree(task);
      return;
    }

    task.filesChanged = changes.map((c) => c.file);
    task.conflictedFiles = changes.filter((c) => c.conflicted).map((c) => c.file);
    this.emitUpdate(task);

    // One explicit gate for the whole import. Conflicts force a SENSITIVE
    // approval (never auto-allowed); clean imports classify as an edit.
    const conflicted = task.conflictedFiles.length > 0;
    const risk = conflicted ? 'sensitive' : 'edit';
    const permissions = new PermissionEngine(this.host.cwd);
    const outcome = permissions.decide(this.host.mode, 'apply_subagent_changes', risk);
    let allowed = outcome === 'allow';
    if (outcome === 'ask') {
      const request: ApprovalRequest = {
        callId: `apply-${task.id}`,
        toolName: 'apply_subagent_changes',
        input: { files: task.filesChanged, conflicted: task.conflictedFiles },
        risk,
        summary:
          `Apply ${changes.length} file(s) from agent '${task.spec.title}' to the checkout` +
          (conflicted ? ` — CONFLICTS with your local changes in: ${task.conflictedFiles.join(', ')}` : ''),
        agentId: task.id,
        agentLabel: `${task.spec.role} · ${task.spec.title}`,
      };
      this.host.emit({ type: 'approval_requested', request });
      const decision = await this.host.requestApproval(request);
      this.host.emit({ type: 'approval_resolved', callId: request.callId, decision, agentId: task.id });
      allowed = decision !== 'deny';
    }
    if (!allowed) {
      task.warnings.push(
        `Changes NOT applied (declined). They remain on branch ${worktree.branch}.`,
      );
      this.emitUpdate(task);
      return; // worktree preserved for manual review
    }

    for (const change of changes) {
      const target = path.join(this.host.cwd, change.file);
      this.host.snapshotForUndo(target);
      if (change.content === null) {
        fs.rmSync(target, { force: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, change.content);
      }
    }
    task.applied = true;
    this.emitUpdate(task);
    await this.removeWorktree(task);
  }

  // MARK: await / inspect / cancel

  private async awaitTasks(
    input: Record<string, unknown>,
    respond: (content: string, isError?: boolean) => UserContent,
  ): Promise<UserContent> {
    const requested = Array.isArray(input.ids) ? input.ids.map(String) : [];
    const rawTimeout = Number(input.timeout_s);
    const timeoutMs = Math.min(1800, Math.max(5, Number.isFinite(rawTimeout) ? rawTimeout : 600)) * 1000;
    let targets: SubagentTask[];
    if (requested.length === 0) {
      const turnTasks = [...this.tasks.values()].filter((t) => t.turnIndex === this.currentTurn);
      targets = turnTasks.length > 0 ? turnTasks : [...this.tasks.values()];
    } else {
      const unknown = requested.filter((id) => !this.tasks.has(id));
      if (unknown.length > 0) return respond(`Unknown task id(s): ${unknown.join(', ')}`, true);
      targets = requested.map((id) => this.tasks.get(id)!);
    }
    if (targets.length === 0) return respond('No subagent tasks have been delegated yet.');

    const pending = targets.filter((t) => !isTerminal(t.status));
    let timedOut = false;
    if (pending.length > 0) {
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), timeoutMs).unref?.();
      });
      const all = Promise.all(pending.map((t) => t.done)).then(() => 'done' as const);
      timedOut = (await Promise.race([all, timeout])) === 'timeout';
    }

    const payload = {
      agents: targets.map((t) => this.summaryEntry(t)),
      note: 'Writing agents\' changes are imported through an explicit review gate — report un-applied changes as proposals on their branch, never as applied work.',
    };
    let body = JSON.stringify(payload, null, 1);
    if (timedOut) {
      body += `\n\nNote: timed out after ${Math.round(timeoutMs / 1000)}s — tasks not marked completed are STILL RUNNING. You may await again, inspect, or cancel them.`;
    }
    return respond(body);
  }

  private summaryEntry(task: SubagentTask): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      id: task.id,
      title: task.spec.title,
      role: task.spec.role,
      status: task.status,
      tokens: { input: task.usage.inputTokens, output: task.usage.outputTokens },
    };
    if (task.summary) entry.summary = task.summary.slice(0, 3000);
    if (task.filesChanged.length > 0) {
      entry[task.applied ? 'files_changed_applied' : 'files_changed_pending_review'] = task.filesChanged;
    }
    if (task.conflictedFiles.length > 0) entry.conflicted_files = task.conflictedFiles;
    if (task.commandsExecuted.length > 0) entry.commands = task.commandsExecuted.slice(-12);
    if (task.warnings.length > 0) entry.warnings = task.warnings;
    if (task.worktree) entry.worktree_branch = task.worktree.branch;
    if (task.error) entry.error = task.error;
    return entry;
  }

  private inspect(
    input: Record<string, unknown>,
    respond: (content: string, isError?: boolean) => UserContent,
  ): UserContent {
    const task = this.tasks.get(String(input.id ?? ''));
    if (!task) return respond('Unknown task id.', true);
    const lines = [
      `id: ${task.id}`,
      `title: ${task.spec.title}`,
      `role: ${task.spec.role} · model: ${task.model} · isolation: ${task.isolation}`,
      `status: ${task.status}`,
      `activity: ${task.currentActivity}`,
      `tokens: in ${task.usage.inputTokens} · out ${task.usage.outputTokens}`,
    ];
    if (task.error) lines.push(`error: ${task.error}`);
    if (task.summary) lines.push(`result:\n${task.summary.slice(0, 3000)}`);
    return respond(lines.join('\n'));
  }

  private cancelOne(
    input: Record<string, unknown>,
    respond: (content: string, isError?: boolean) => UserContent,
  ): UserContent {
    const task = this.tasks.get(String(input.id ?? ''));
    if (!task) return respond('Unknown task id.', true);
    if (isTerminal(task.status)) return respond(`Task ${task.id} already ${task.status}.`);
    this.cancel(task.id, 'Cancelled by the coordinator');
    return respond(`Cancelling task ${task.id} ('${task.spec.title}').`);
  }

  cancel(taskId: string, reason: string): void {
    const task = this.tasks.get(taskId);
    if (!task || isTerminal(task.status)) return;
    task.error = task.error ?? reason;
    if (task.status === 'queued') {
      this.settle(task, 'cancelled');
    } else {
      task.aborter.abort();
    }
  }

  private publicState(task: SubagentTask): SubagentPublicState {
    return {
      id: task.id,
      title: task.spec.title,
      role: task.spec.role,
      model: task.model,
      isolation: task.isolation,
      writes: task.spec.writes,
      status: task.status,
      currentActivity: task.currentActivity,
      usage: { ...task.usage },
      error: task.error,
      summary: task.summary?.slice(0, 3000),
      filesChanged: task.filesChanged.length > 0 ? [...task.filesChanged] : undefined,
      conflictedFiles: task.conflictedFiles.length > 0 ? [...task.conflictedFiles] : undefined,
      commandsExecuted: task.commandsExecuted.length > 0 ? task.commandsExecuted.slice(-20) : undefined,
      warnings: task.warnings.length > 0 ? [...task.warnings] : undefined,
      worktreeBranch: task.worktree?.branch,
      applied: task.applied,
      startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : undefined,
      completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : undefined,
    };
  }

  private emitUpdate(task: SubagentTask): void {
    this.host.emit({ type: 'subagent_update', agent: this.publicState(task) });
  }
}
