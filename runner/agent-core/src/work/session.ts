/**
 * `WorkAgentSession` — the driver for one Juno Work run.
 *
 * `AgentSession` in agent.ts is shaped for Code: a turn is short, the user is
 * watching, and the interesting output is a diff. A Work run is shaped the
 * other way. It outlives the tab that started it, it pauses for a person and
 * resumes hours later on a different executor, everything it touches has to be
 * attributable to a source and an action, and it finishes by proving its
 * deliverable answers the goal rather than by asserting that it does.
 *
 * Those are different drivers over the same engine, so this is a second driver
 * and emphatically not a second loop. `runAgentLoop` is used verbatim: the
 * pause/resume design, the budget enforcement and the question suspension are
 * all expressed through the seams it already has (`signal`, `onStep`,
 * `executeToolCall`), because a forked loop is a place where cancellation
 * semantics drift apart and nobody notices until a Stop stops one of them.
 *
 * Resumability rests on one property of that loop: an aborted step still
 * pushes a `tool_result` for every `tool_call` it emitted, marked cancelled.
 * The transcript is therefore always well-formed at the moment of a pause, and
 * resuming is calling `runAgentLoop` again with the same `messages` array and
 * a fresh AbortController. Without that property a paused run would resume
 * into a transcript with an unanswered tool call, which every provider rejects.
 */

import crypto from 'node:crypto';
import { runAgentLoop } from '../loop.js';
import type { ProviderAdapter, ReasoningEffort } from '../providers/types.js';
import type { ChatMessage, ToolSpec, UserContent } from '../types.js';
import type { ToolContext } from '../tools/types.js';
import {
  WorkBudgetGuard,
  withBudget,
  type Clock,
  type WorkBudgetState,
  type WorkModelPricing,
} from './budget.js';
import {
  injectionAuditIntent,
  scanUntrusted,
  summariseVerdict,
  wrapUntrusted,
  UNTRUSTED_CONTENT_RULE,
} from './injection.js';
import { WorkPlan, isTerminalStepStatus, planDiffIsEmpty, type WorkPlanState } from './plan.js';
import { candidatesForIntent, evaluateTier, tierPromptSection } from './tier.js';
import {
  APPROVAL_TTL_MS,
  canonicalJson,
  approvalAsksUnder,
  type WorkPermissionPolicy,
  type BudgetUsage,
  type WorkActionRecord,
  type WorkApprovalAnswer,
  type WorkApprovalRequest,
  type WorkArtifactRef,
  type WorkAuditIntent,
  type WorkBudget,
  type WorkCitation,
  type WorkDecision,
  type WorkEmittedEvent,
  type WorkEvent,
  type WorkQuestion,
  type WorkReport,
  type WorkRiskLevel,
  type WorkTerminalReason,
  type WorkToolDefinition,
  type WorkValidationCheck,
  type WorkValidationResult,
} from './types.js';

/**
 * Steps per run before the loop gives up on its own.
 *
 * Higher than Code's 60 because a Work run legitimately spans research, draft
 * and revision in one go, and lower than unbounded because a run that has
 * reached 200 steps has a problem the budget was not written to catch.
 */
export const MAX_STEPS_PER_RUN = 200;

/**
 * How often the run's ceilings are checked while it is busy.
 *
 * They used to be checked in exactly one place — `AgentLoopOptions.onStep`,
 * which fires when a provider request comes back — so a run that was inside a
 * request or inside a tool call was, for as long as that lasted, a run with no
 * ceilings at all. That is not a corner: a 20-minute runtime limit could not
 * stop a turn that never returned, and the executor renews its lease while it
 * waits, so nothing else was going to stop it either. `WorkBudgetGuard.check`
 * already says of itself that it is safe to call at any point; this is the
 * timer that finally takes it up on that.
 *
 * Five seconds is chosen against the thing being measured. The ceilings are
 * minutes and dollars, so five seconds of overshoot is noise, and one cheap
 * arithmetic check every five seconds is not worth optimising.
 */
export const BUDGET_CHECK_INTERVAL_MS = 5_000;

/**
 * The tool the model calls to ask the user something.
 *
 * A tool rather than a side channel because the loop already has exactly the
 * right semantics for it: `executeToolCall` is awaited, so a question that
 * takes an hour to answer suspends the run for an hour without any of the
 * machinery a separate suspension mechanism would need, and the answer arrives
 * back in the transcript as a tool result the model must read.
 */
export const WORK_ASK_TOOL_NAME = 'ask_user';

/**
 * The tool the model calls to move the plan along.
 *
 * **Why this exists.** `WorkSession.startStep`, `finishStep` and `revisePlan`
 * were written to be driven from somewhere, emit exactly the right events
 * (`step_started`, `step_finished`, `plan_updated`), and were called by nothing
 * — not by a tool, not by the runner, not by anything in the repository. So a
 * cloud run's plan sat at three pending steps for its whole life, and
 * `structuralValidation`'s first check ("Every planned step reached a
 * conclusion") could never pass. Every cloud Work run therefore ended `failed`
 * no matter what the model did, and the user was told the deliverable did not
 * answer the goal when the real answer was that nothing could ever mark the
 * work done.
 *
 * One tool with a status argument rather than three, because the model has to
 * pick the step id either way and three names is three chances to call the
 * wrong one. `revise` is deliberately not exposed here: re-planning is a
 * bigger act than progressing, and the fixed scaffold the cloud runner
 * installs is not the model's to rewrite mid-run.
 */
export const WORK_PLAN_TOOL_NAME = 'update_plan';

export function updatePlanToolSpec(): ToolSpec {
  return {
    name: WORK_PLAN_TOOL_NAME,
    description:
      'Record progress against the plan. Call it with status "active" before you begin a step, and again with "done", "skipped" or "failed" when you stop working on it. The plan is what the user watches, and a run whose steps never move is reported as having done nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        stepId: {
          type: 'string',
          description: 'The id of the step, exactly as given in the plan.',
        },
        status: {
          type: 'string',
          enum: ['active', 'done', 'skipped', 'failed'],
          description: 'What is now true of the step.',
        },
        reason: {
          type: 'string',
          description:
            'Why, when the status is "skipped" or "failed". A step that stops without one is reported as unexplained.',
        },
      },
      required: ['stepId', 'status'],
    },
  };
}

/**
 * The tool the model calls to replace the scaffold with a plan for *this* task.
 *
 * The comment above says re-planning "is not the model's to rewrite mid-run",
 * and that was the right instinct aimed at the wrong thing. What it protected
 * was a plan the cloud runner hard-codes identically for every task ever
 * submitted — `Understand what is being asked` / `Do the work` / `Check the
 * result against the request`. Those three lines are what a user watching a
 * fourteen-second failure saw, and they say nothing about their task that was
 * not already true of every other task in the product. For a surface whose
 * whole premise is "show me the plan before you touch anything", a plan that
 * cannot mention the goal is the largest thing missing.
 *
 * So the scaffold becomes a seed rather than a cage, and the model is asked to
 * replace it once, up front, before it acts. Deliberately NOT the same tool as
 * `update_plan`: writing the plan and marking a step done are different acts
 * with different blast radii, and folding them together is how a model that
 * meant to tick a box rewrites the list instead.
 *
 * Bounded by `MAX_PLAN_WRITES` for the reason the original comment gives. A
 * model that may rewrite the plan whenever it likes can hide a step it failed
 * by re-planning it away, and `structuralValidation`'s "every planned step
 * reached a conclusion" would pass over work nobody did. Two writes is enough
 * for "here is the plan" plus one genuine mid-run correction, and not enough to
 * launder a failure.
 */
export const WORK_WRITE_PLAN_TOOL_NAME = 'write_plan';

/** How many times one run may (re)write its plan. See the comment above. */
const MAX_PLAN_WRITES = 2;

export function writePlanToolSpec(): ToolSpec {
  return {
    name: WORK_WRITE_PLAN_TOOL_NAME,
    description:
      'Replace the plan with the real steps for this task. Call this ONCE, before you do anything else, as soon as you understand the goal — the placeholder plan you were given is generic and says nothing about this task. Write the steps you actually intend to take, in order, each one a concrete piece of work a person could check. You may call it a second time if what you learn genuinely changes the shape of the job; you may not call it to remove a step that did not go well.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          description: 'The steps, in the order you intend to do them.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description:
                  'One short line naming a concrete piece of work, in the user\'s own terms rather than in tool names. "Find the repositories with no README" — not "call list_repos".',
              },
            },
            required: ['title'],
          },
        },
      },
      required: ['steps'],
    },
  };
}

export function askUserToolSpec(): ToolSpec {
  return {
    name: WORK_ASK_TOOL_NAME,
    description:
      'Ask the user one question and wait for the answer. Use this when the task cannot be completed correctly without a decision only the user can make. Do not use it to confirm work you can verify yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in one sentence.' },
        why: {
          type: 'string',
          description: 'Why the run cannot proceed without an answer.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Offered answers, when the answer is a choice.',
        },
      },
      required: ['question', 'why'],
    },
  };
}

export interface WorkSessionCallbacks {
  onEvent(event: WorkEmittedEvent): void;
  /** Suspends the run until the user answers. */
  askQuestion(question: WorkQuestion): Promise<string>;
  /** Suspends the run until the user decides. */
  requestApproval(request: WorkApprovalRequest): Promise<WorkApprovalAnswer>;
  /** Audit records the runtime wants written; the runner has no database. */
  onAudit?(intent: WorkAuditIntent): void;
  /** Called whenever the run's resumable state changed. */
  onCheckpoint?(checkpoint: WorkCheckpoint): void;
  /**
   * Called when the loop is about to wait and try a step again.
   *
   * Operator-facing on purpose, and deliberately NOT an emitted event. The
   * transcript's vocabulary is a generated cross-language contract — the Swift
   * side decodes `JunoWorkDegradationKind` as a plain string enum with no
   * unknown-case fallback — so a new kind invented here would throw inside
   * every iOS and macOS build already in the field the first time a run was
   * throttled. Saying it in the transcript is worth doing and is a change that
   * ships with a native release, not ahead of one.
   */
  onProviderRetry?(info: {
    attempt: number;
    of: number;
    delayMs: number;
    kind: string;
    reason: string;
  }): void;
}

/**
 * A run-specific check of the deliverable against the goal.
 *
 * The default is structural (see `structuralValidation`) and deliberately
 * cheap. A deployment that wants a model to read the deliverable against the
 * goal supplies one here; the session treats both identically, including the
 * part where a failed validation stops the run being reported as complete.
 */
export type WorkValidator = (input: {
  goal: string;
  plan: WorkPlan;
  answer: string;
  artifacts: readonly WorkArtifactRef[];
}) => Promise<WorkValidationResult> | WorkValidationResult;

export interface WorkSessionOptions {
  runId: string;
  /** What the user actually asked for, verbatim. Never a paraphrase. */
  goal: string;
  provider: ProviderAdapter;
  model: string;
  cwd: string;
  tools: readonly WorkToolDefinition[];
  /** The initial plan. Revised through `session.plan`. */
  plan: WorkPlan;
  budget: WorkBudget;
  callbacks: WorkSessionCallbacks;
  pricing?: WorkModelPricing;
  clock?: Clock;
  maxSteps?: number;
  /** Extra guidance appended to the built system prompt. */
  systemSuffix?: string;
  /**
   * How much thinking the user asked for, or absent for Instant.
   *
   * Handed to every provider request rather than turned into a sentence in the
   * system prompt. A sentence asking a model to think harder is not the control
   * the composer draws, and dressing one up as the other is how a preference
   * comes to look saved and have no effect. Providers that have no such
   * parameter drop it; see `ProviderRequest.reasoningEffort`.
   */
  reasoningEffort?: ReasoningEffort;
  /** Longest silence from the provider before a turn is judged dead, in ms. */
  providerSilenceMs?: number;
  /** How often the ceilings are re-checked while a turn is in flight, in ms. */
  budgetCheckIntervalMs?: number;
  /** The resolved permission policy; digested so approvals are pinned to it. */
  permissionPolicy?: Record<string, unknown>;
  /**
   * The approval mode this run is executed under, already narrowed against any
   * Mac's advertised floor by the dispatch that started it.
   *
   * Separate from `permissionPolicy` above, which is an opaque blob whose only
   * job is to be hashed: two runs under different modes must not share a
   * standing approval, and the digest is what stops them. This is the value the
   * gate reads. Defaults to `conservative` when absent, because a run whose mode
   * did not survive the wire should ask more, not less.
   */
  approvalMode?: WorkPermissionPolicy;
  validate?: WorkValidator;
  env?: NodeJS.ProcessEnv;
}

/** Everything needed to continue a paused run on another executor. */
export interface WorkCheckpoint {
  runId: string;
  version: 1;
  messages: ChatMessage[];
  plan: WorkPlanState;
  budget: WorkBudgetState;
  seq: number;
  actions: WorkActionRecord[];
  citations: WorkCitation[];
  decisions: WorkDecision[];
  artifacts: WorkArtifactRef[];
  uncertainties: string[];
}

export type WorkRunResult =
  | { state: 'paused'; usage: BudgetUsage; checkpoint: WorkCheckpoint }
  | {
      state: 'finished';
      terminalReason: WorkTerminalReason;
      detail: string;
      usage: BudgetUsage;
      report: WorkReport;
    };

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export class WorkAgentSession {
  readonly runId: string;
  readonly goal: string;
  readonly plan: WorkPlan;
  private readonly options: WorkSessionOptions;
  private readonly toolsByName: Map<string, WorkToolDefinition>;
  private readonly tools: readonly WorkToolDefinition[];
  private readonly budget: WorkBudgetGuard;
  private readonly clock: Clock;
  private readonly policyDigest: string;
  private messages: ChatMessage[] = [];
  private seq = 0;
  private aborter: AbortController | null = null;
  private actions: WorkActionRecord[] = [];
  private citations: WorkCitation[] = [];
  private decisions: WorkDecision[] = [];
  private artifacts: WorkArtifactRef[] = [];
  private uncertainties: string[] = [];
  private grantedAlways = new Set<string>();
  private finalText = '';
  /** Set when the user paused; distinguishes a pause from a cancel. */
  private pausedReason: string | null = null;
  private cancelledReason: string | null = null;
  /** Set when the plan reported no progress; carries the sentence to report. */
  private haltReason: string | null = null;
  /** How many times this run has written its plan. See `MAX_PLAN_WRITES`. */
  private planWrites = 0;
  private started = false;

  constructor(options: WorkSessionOptions) {
    this.options = options;
    this.runId = options.runId;
    this.goal = options.goal;
    this.plan = options.plan;
    this.tools = options.tools;
    this.toolsByName = new Map(options.tools.map((tool) => [tool.spec.name, tool]));
    this.clock = options.clock ?? { now: () => Date.now() };
    this.policyDigest = sha256(canonicalJson(options.permissionPolicy ?? {}));
    this.budget = new WorkBudgetGuard({
      budget: options.budget,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.pricing ? { pricing: options.pricing } : {}),
      onWarning: (warning) =>
        this.emit({ kind: 'budget_warning', limit: warning.limit, detail: warning.detail }),
    });
  }

  /**
   * Continue a run from a checkpoint.
   *
   * The plan's progress counters and the budget's spend come back with it. A
   * resumed run that forgets either is a run that gets a fresh stall allowance
   * and a fresh budget every time someone resumes it, which turns pause/resume
   * into a way around both.
   */
  static restore(
    checkpoint: WorkCheckpoint,
    // The plan comes from the checkpoint, never from the options: asking a
    // caller for both invites them to supply a plan that is then silently
    // discarded, and the run would resume against a plan the user never saw.
    options: Omit<WorkSessionOptions, 'plan'>,
  ): WorkAgentSession {
    const session = new WorkAgentSession({
      ...options,
      plan: WorkPlan.fromJSON(checkpoint.plan),
    });
    session.messages = [...checkpoint.messages];
    session.seq = checkpoint.seq;
    session.actions = [...checkpoint.actions];
    session.citations = [...checkpoint.citations];
    session.decisions = [...checkpoint.decisions];
    session.artifacts = [...checkpoint.artifacts];
    session.uncertainties = [...checkpoint.uncertainties];
    session.started = true;
    session.budget.restore(checkpoint.budget);
    return session;
  }

  get usage(): BudgetUsage {
    return this.budget.usage;
  }

  checkpoint(): WorkCheckpoint {
    return {
      runId: this.runId,
      version: 1,
      // A shallow copy is a real snapshot here: the loop only ever appends to
      // the transcript, so the messages already in it are never rewritten. A
      // shared reference would let the run keep growing a checkpoint someone
      // is in the middle of serialising.
      messages: [...this.messages],
      plan: this.plan.toJSON(),
      budget: this.budget.toJSON(),
      seq: this.seq,
      actions: [...this.actions],
      citations: [...this.citations],
      decisions: [...this.decisions],
      artifacts: [...this.artifacts],
      uncertainties: [...this.uncertainties],
    };
  }

  /**
   * Stop the run at the next safe point, keeping it resumable.
   *
   * Aborting is what makes this prompt rather than polite: the loop's abort
   * path answers every outstanding tool call with a cancelled result, so the
   * transcript is well-formed the instant it stops.
   */
  pause(reason = 'Paused by the user.'): void {
    this.pausedReason = reason;
    this.aborter?.abort();
  }

  /** Stop the run for good. Not resumable. */
  cancel(reason = 'Stopped by the user.'): void {
    this.cancelledReason = reason;
    this.aborter?.abort();
  }

  /**
   * Record a decision the run made that a user might have made differently.
   * Part of the report; never inferred from the transcript afterwards.
   */
  recordDecision(decision: WorkDecision): void {
    this.decisions.push(decision);
  }

  /** Record something the run could not establish. Reported verbatim. */
  recordUncertainty(text: string): void {
    if (!this.uncertainties.includes(text)) this.uncertainties.push(text);
  }

  recordArtifact(artifact: WorkArtifactRef): void {
    const index = this.artifacts.findIndex((a) => a.id === artifact.id);
    if (index === -1) {
      this.artifacts.push(artifact);
      this.emit({ kind: 'artifact_created', artifact });
    } else {
      this.artifacts[index] = artifact;
      this.emit({ kind: 'artifact_updated', artifact });
    }
    this.plan.recordArtifact(`${artifact.id}@${artifact.version}`);
  }

  recordCitation(citation: WorkCitation): void {
    this.citations.push(citation);
    this.emit({ kind: 'source_cited', citation });
  }

  /** Revise the plan and publish what changed. */
  revisePlan(steps: Parameters<WorkPlan['revise']>[0]): void {
    const diff = this.plan.revise(steps);
    if (planDiffIsEmpty(diff)) return;
    this.emit({ kind: 'plan_updated', plan: this.plan.snapshot(), diff });
  }

  startStep(id: string): void {
    if (!this.plan.start(id)) return;
    const step = this.plan.step(id);
    if (step) this.emit({ kind: 'step_started', stepId: id, title: step.title });
  }

  finishStep(id: string, status: 'done' | 'skipped' | 'failed', reason?: string): void {
    const changed =
      status === 'done'
        ? this.plan.complete(id)
        : status === 'skipped'
          ? this.plan.skip(id, reason ?? 'No reason recorded.')
          : this.plan.fail(id, reason ?? 'No reason recorded.');
    if (!changed) return;
    const step = this.plan.step(id);
    this.emit({
      kind: 'step_finished',
      stepId: id,
      title: step?.title ?? id,
      status,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  /** Run until the model finishes, a ceiling is hit, or the user intervenes. */
  async run(): Promise<WorkRunResult> {
    if (!this.started) {
      this.started = true;
      this.messages.push({ role: 'user', content: [{ type: 'text', text: this.goal }] });
      this.emit({
        kind: 'run_started',
        runId: this.runId,
        goal: this.goal,
        model: this.options.model,
      });
      this.emit({ kind: 'plan_created', plan: this.plan.snapshot() });
    } else {
      this.emit({ kind: 'resumed' });
    }
    return this.drive();
  }

  private async drive(): Promise<WorkRunResult> {
    this.pausedReason = null;
    this.cancelledReason = null;
    this.haltReason = null;
    this.aborter = new AbortController();
    this.budget.start();

    // The ceilings, on a clock of their own. `onStep` below still records what
    // each request cost — that is where the tokens are — but it is not the only
    // thing that can end a run any more, because it never runs at all while a
    // turn is stuck.
    const ceilings = setInterval(
      () => {
        if (this.budget.check()) this.aborter?.abort();
      },
      this.options.budgetCheckIntervalMs ?? BUDGET_CHECK_INTERVAL_MS,
    );

    let loopError: string | null = null;
    try {
      const result = await runAgentLoop({
        provider: this.options.provider,
        model: this.options.model,
        // A builder, not a string: the prompt renders the plan, and the plan is
        // now something the model rewrites on its first turn. See the field's
        // note in AgentLoopOptions for what a frozen prompt did.
        system: () => this.buildSystemPrompt(),
        messages: this.messages,
        tools: [
          ...this.tools.map((tool) => tool.spec),
          askUserToolSpec(),
          updatePlanToolSpec(),
          writePlanToolSpec(),
        ],
        signal: this.aborter.signal,
        maxSteps: this.options.maxSteps ?? MAX_STEPS_PER_RUN,
        ...(this.options.reasoningEffort
          ? { reasoningEffort: this.options.reasoningEffort }
          : {}),
        ...(this.options.providerSilenceMs === undefined
          ? {}
          : { silenceTimeoutMs: this.options.providerSilenceMs }),
        onAssistantMessage: (text) => this.emit({ kind: 'assistant_message', text }),
        onStep: withBudget(this.budget),
        executeToolCall: (call) => this.executeToolCall(call),
        onMessagesChanged: () => this.options.callbacks.onCheckpoint?.(this.checkpoint()),
        onProviderRetry: (info) => this.options.callbacks.onProviderRetry?.(info),
      });
      this.finalText = result.finalText || this.finalText;
    } catch (err) {
      loopError = err instanceof Error ? err.message : String(err);
      this.emit({ kind: 'error', message: loopError });
    } finally {
      clearInterval(ceilings);
    }

    this.budget.suspend();

    if (this.pausedReason !== null) {
      this.emit({ kind: 'paused', reason: this.pausedReason });
      const checkpoint = this.checkpoint();
      this.options.callbacks.onCheckpoint?.(checkpoint);
      return { state: 'paused', usage: this.budget.usage, checkpoint };
    }

    const validation = await this.validate();
    this.emit({ kind: 'validation_result', result: validation });

    const { terminalReason, detail } = this.terminalOutcome(loopError, validation);
    const report = this.buildReport(validation);
    const usage = this.budget.usage;
    this.emit({ kind: 'run_finished', terminalReason, detail, usage, report });
    return { state: 'finished', terminalReason, detail, usage, report };
  }

  /**
   * Which of the several ways a run can end actually happened.
   *
   * Ordered by authority rather than by when it was noticed. A cancelled run
   * that also hit its budget is cancelled — the user's decision is the cause,
   * and reporting it as budget_exceeded would send them to raise a limit that
   * had nothing to do with it.
   */
  private terminalOutcome(
    loopError: string | null,
    validation: WorkValidationResult,
  ): { terminalReason: WorkTerminalReason; detail: string } {
    if (this.cancelledReason !== null) {
      return { terminalReason: 'cancelled', detail: this.cancelledReason };
    }
    if (loopError !== null) {
      return { terminalReason: 'failed', detail: loopError };
    }
    const budgetOutcome = this.budget.outcome;
    if (budgetOutcome) {
      return { terminalReason: budgetOutcome.terminalReason, detail: budgetOutcome.detail };
    }
    if (this.haltReason !== null) {
      // Not budget_exceeded: nothing was over a ceiling, and telling the user
      // it was sends them to raise a limit that was never the problem.
      return { terminalReason: 'failed', detail: this.haltReason };
    }
    if (!validation.satisfied) {
      return {
        terminalReason: 'failed',
        detail: `The deliverable does not yet answer the goal: ${validation.unmet.join(' ')}`,
      };
    }
    // What "done" is allowed to claim depends on what actually checked.
    //
    // `structuralValidation` — the default, and the only validator the cloud
    // deployment installs, because `WorkSessionOptions.validate` is never set —
    // takes `goal` and does not read it. It checks that every step reached a
    // terminal status, that skips and failures carry a reason, that something
    // was produced, and that nothing unfinished went unmentioned. All of that
    // is about the *record* of the run, not about whether the answer is right.
    //
    // Saying "The deliverable answers the goal" on that evidence is the same
    // defect as the one `unmet` used to have in the other direction: a sentence
    // asserting something nothing verified. It was unreachable until the plan
    // tool was wired, because no cloud run could satisfy the first check at
    // all — so wiring the tool is what made this claim start being made.
    //
    // A deployment that supplies a real validator has earned the stronger
    // sentence; one that has not says what it actually knows.
    return {
      terminalReason: 'completed',
      detail: validation.judged
        ? 'The deliverable answers the goal.'
        : 'Every step finished and the run produced a result. Juno has not judged whether it is correct.',
    };
  }

  private async validate(): Promise<WorkValidationResult> {
    const input = {
      goal: this.goal,
      plan: this.plan,
      answer: this.finalText,
      artifacts: this.artifacts,
    };
    if (!this.options.validate) return structuralValidation(input);
    try {
      return await this.options.validate(input);
    } catch (err) {
      // A validator that throws must not be read as a pass. The whole point of
      // the pass is that completion is asserted only when something checked.
      return {
        satisfied: false,
        checks: [
          {
            claim: 'The deliverable was checked against the goal.',
            satisfied: false,
            evidence: `The check itself failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        unmet: ['The deliverable could not be checked against the goal.'],
      };
    }
  }

  private buildReport(verification: WorkValidationResult): WorkReport {
    return {
      goal: this.goal,
      plan: this.plan.snapshot(),
      actions: [...this.actions],
      citations: [...this.citations],
      decisions: [...this.decisions],
      uncertainties: [...this.uncertainties],
      verification,
      artifacts: [...this.artifacts],
      answer: this.finalText,
    };
  }

  private emit(event: WorkEvent): void {
    this.seq += 1;
    this.options.callbacks.onEvent({
      ...event,
      seq: this.seq,
      at: new Date(this.clock.now()).toISOString(),
    } as WorkEmittedEvent);
  }

  private toolResult(callId: string, content: string, isError = false): UserContent {
    return { type: 'tool_result', toolCallId: callId, content, isError };
  }

  private async executeToolCall(call: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }): Promise<UserContent> {
    if (call.name === WORK_ASK_TOOL_NAME) return this.handleQuestion(call);
    if (call.name === WORK_PLAN_TOOL_NAME) return this.handlePlanUpdate(call);
    if (call.name === WORK_WRITE_PLAN_TOOL_NAME) return this.handlePlanWrite(call);

    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      return this.toolResult(call.id, `Unknown tool: ${call.name}`, true);
    }

    // Progress accounting runs before the tier check so that a run looping on
    // refusals is caught by the same detector as one looping on successes.
    const verdict = this.plan.observeToolCall(call.name, call.input);
    if (verdict.state !== 'progressing') {
      this.haltReason = verdict.reason;
      this.emit({ kind: 'tool_denied', callId: call.id, tool: call.name, reason: verdict.reason });
      this.aborter?.abort();
      return this.toolResult(call.id, `Stopping: ${verdict.reason}`, true);
    }

    const intent = tool.intentFor(call.input);
    const decision = evaluateTier({
      intent,
      chosen: call.name,
      candidates: candidatesForIntent(this.tools, intent),
    });
    if (!decision.allowed) {
      this.options.callbacks.onAudit?.(decision.audit);
      this.emit({ kind: 'tool_denied', callId: call.id, tool: call.name, reason: decision.reason });
      return this.toolResult(call.id, decision.reason, true);
    }

    const action = tool.actionFor(call.input);
    const risk = tool.riskFor(call.input);
    const provenance = tool.provenanceFor(call.input);

    // The mode decides, above the floor. `approvalAsksUnder` checks the floor
    // first and separately, so Skip cannot reach past it — the four things Juno
    // cannot take back still ask under every mode.
    if (
      approvalAsksUnder(action, risk, this.options.approvalMode ?? 'conservative') &&
      !this.grantedAlways.has(action)
    ) {
      const answer = await this.gateApproval(call, tool, action, risk);
      if (answer !== 'allowed' && answer !== 'allowed_always') {
        const reason =
          answer === 'expired'
            ? 'The approval request expired before it was answered.'
            : 'The user declined this action.';
        this.emit({ kind: 'tool_denied', callId: call.id, tool: call.name, reason });
        return this.toolResult(call.id, reason, true);
      }
      // `allowed_always` never covers the always-confirm list: those are the
      // actions Juno cannot undo, and a standing grant for "send a message" is
      // a standing grant to send every future message.
      if (answer === 'allowed_always' && risk !== 'irreversible' && risk !== 'sensitive') {
        this.grantedAlways.add(action);
      }
    }

    this.emit({
      kind: 'tool_started',
      callId: call.id,
      tool: call.name,
      intent,
      tier: tool.tier,
      risk,
      summary: tool.summarize(call.input),
      provenance,
    });

    const ctx: ToolContext = {
      cwd: this.options.cwd,
      ...(this.options.env ? { env: this.options.env } : {}),
    };
    const startedAt = this.clock.now();
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

    this.actions.push({
      callId: call.id,
      tool: call.name,
      intent,
      provenance,
      isError,
      at: new Date(startedAt).toISOString(),
    });

    let content = output;
    let injection: ReturnType<typeof summariseVerdict> | undefined;
    if (provenance.trust === 'untrusted') {
      const scanned = scanUntrusted(output);
      injection = summariseVerdict(scanned);
      if (scanned.detected) {
        this.options.callbacks.onAudit?.(injectionAuditIntent(provenance.source, scanned));
      }
      // The content goes through unchanged inside the envelope. Stripping the
      // matched span here would hand the model text that reads as coherent
      // with a hole in it, and would hide from the user that anything was in
      // it at all; the envelope plus the system-prompt rule is the mitigation,
      // and the grant and the egress policy are the containment.
      content = wrapUntrusted(provenance.source, output);
    }

    this.emit({
      kind: 'tool_finished',
      callId: call.id,
      tool: call.name,
      isError,
      durationMs: this.clock.now() - startedAt,
      provenance,
      ...(injection ? { injection } : {}),
    });
    return this.toolResult(call.id, content, isError);
  }

  private async handleQuestion(call: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }): Promise<UserContent> {
    const question: WorkQuestion = {
      id: call.id,
      question: String(call.input.question ?? '').trim(),
      why: String(call.input.why ?? '').trim(),
      ...(Array.isArray(call.input.options)
        ? { options: call.input.options.map((option) => String(option)) }
        : {}),
    };
    if (!question.question) {
      return this.toolResult(call.id, 'A question is required.', true);
    }
    this.emit({ kind: 'question_asked', question });
    // The clock stops: a run must not spend its runtime ceiling waiting for a
    // person, or asking before acting becomes the thing that kills it.
    this.budget.suspend();
    try {
      const answer = await this.options.callbacks.askQuestion(question);
      this.emit({ kind: 'question_answered', questionId: question.id, answer });
      this.plan.recordAnswer(question.id);
      return this.toolResult(call.id, answer);
    } finally {
      this.budget.start();
    }
  }

  /**
   * Moves one step of the plan, from the model's own call.
   *
   * Not routed through `observeToolCall`. That accounting exists to catch a run
   * looping on the same tool without getting anywhere, and marking a step done
   * *is* getting somewhere — counting it as a call since progress would make
   * the stall detector fire on the one tool that proves the run is advancing.
   *
   * An unknown step id is refused rather than ignored: the model has to be told
   * it addressed a step that does not exist, or it carries on believing the
   * plan moved and reports work the transcript never recorded.
   */
  /**
   * Replaces the seeded plan with one written for this task.
   *
   * Ids are generated here rather than taken from the model. A model that
   * supplies its own would have to keep them stable across a second write to
   * keep `update_plan` working, and there is nothing it gains from choosing
   * them — whereas a collision or a renamed id silently breaks every subsequent
   * status call. Positional ids are stable by construction.
   */
  private handlePlanWrite(call: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }): UserContent {
    if (this.planWrites >= MAX_PLAN_WRITES) {
      return this.toolResult(
        call.id,
        `The plan has already been written ${this.planWrites} times, which is the limit. Record progress against the steps you have with ${WORK_PLAN_TOOL_NAME}, and say in your report what you would have changed.`,
        true,
      );
    }

    const raw = call.input.steps;
    if (!Array.isArray(raw) || raw.length === 0) {
      return this.toolResult(call.id, 'A non-empty "steps" array is required.', true);
    }

    const steps = raw.flatMap((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const title = String((entry as { title?: unknown }).title ?? '').trim();
      if (!title) return [];
      return [{ id: `s${index + 1}`, title }];
    });
    if (steps.length === 0) {
      return this.toolResult(call.id, 'Every step needs a non-empty "title".', true);
    }

    this.planWrites += 1;
    this.revisePlan(steps);
    const listed = steps.map((step) => `${step.id}: ${step.title}`).join('\n');
    return this.toolResult(
      call.id,
      `The plan is now:\n${listed}\n\nUse these ids with ${WORK_PLAN_TOOL_NAME} as you go.`,
    );
  }

  private handlePlanUpdate(call: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }): UserContent {
    const stepId = String(call.input.stepId ?? '').trim();
    const status = String(call.input.status ?? '').trim();
    const reason = String(call.input.reason ?? '').trim();

    if (!stepId) return this.toolResult(call.id, 'A stepId is required.', true);
    if (!this.plan.step(stepId)) {
      const known = this.plan
        .snapshot()
        .steps.map((step) => step.id)
        .join(', ');
      return this.toolResult(
        call.id,
        `No step with id "${stepId}". The plan's steps are: ${known}.`,
        true,
      );
    }

    if (status === 'active') {
      this.startStep(stepId);
      return this.toolResult(call.id, `Step "${stepId}" is now active.`);
    }
    if (status === 'done' || status === 'skipped' || status === 'failed') {
      // A step can be concluded without having been started — a model that
      // does the work and then records it is describing what happened, and
      // refusing that would teach it to narrate the ceremony instead.
      this.finishStep(stepId, status, reason || undefined);
      return this.toolResult(call.id, `Step "${stepId}" is ${status}.`);
    }
    return this.toolResult(
      call.id,
      `Unknown status "${status}". Use active, done, skipped or failed.`,
      true,
    );
  }

  /**
   * Put one action in front of the user and wait.
   *
   * The request carries `digestInput` as well as `actionDigest` so the
   * executor recomputes the digest at the moment of acting rather than
   * trusting the one it was handed back. An approval travels to a phone and
   * returns; without the recomputation, an answer to one action is
   * indistinguishable from an answer replayed against another.
   */
  private async gateApproval(
    call: { id: string; name: string; input: Record<string, unknown> },
    tool: WorkToolDefinition,
    action: string,
    risk: WorkRiskLevel,
  ): Promise<WorkApprovalAnswer> {
    const digestInput = canonicalJson({ action, tool: call.name, input: call.input });
    const request: WorkApprovalRequest = {
      id: `${this.runId}:${call.id}`,
      callId: call.id,
      action,
      tool: call.name,
      risk,
      summary: tool.summarize(call.input),
      detail: { intent: tool.intentFor(call.input), tier: tool.tier },
      digestInput,
      actionDigest: sha256(digestInput),
      policyDigest: this.policyDigest,
      expiresAt: new Date(this.clock.now() + APPROVAL_TTL_MS).toISOString(),
    };
    this.emit({ kind: 'approval_requested', request });
    this.budget.suspend();
    try {
      const decision = await this.options.callbacks.requestApproval(request);
      this.emit({ kind: 'approval_resolved', requestId: request.id, decision });
      return decision;
    } finally {
      this.budget.start();
    }
  }

  private buildSystemPrompt(): string {
    /*
     * The id is in the line, and it has to be.
     *
     * This used to render `1. Title [pending]`, which names everything about a
     * step except the one thing `update_plan` requires. The id reached the model
     * exactly once, in the tool_result of `write_plan`, so concluding a step
     * thirty turns later meant remembering a token from a single message far
     * back in the transcript — and getting it wrong returns "No step with id".
     * A step nothing can conclude is a step that stays `pending`, and a plan
     * with a pending step fails `structuralValidation`.
     */
    const steps = this.plan
      .snapshot()
      .steps.map((step) => `- ${step.id}: ${step.title} [${step.status}]`)
      .join('\n');
    return [
      'You are Juno, doing a piece of long-running work on the user\'s behalf. The user is not necessarily watching.',
      '',
      '# Goal',
      '',
      this.goal,
      '',
      '# Plan',
      '',
      steps,
      '',
      this.planWrites === 0
        ? 'That plan is a placeholder. It is the same three lines every task in this product starts with and it says nothing about yours.'
        : '',
      '',
      '# Operating rules',
      '',
      ...(this.planWrites === 0
        ? [
            `- FIRST, before any other tool: call ${WORK_WRITE_PLAN_TOOL_NAME} with the real steps for this goal. Name concrete pieces of work in the user's own terms, not tool names. This is what the user reads to decide whether you understood them, and it is the only chance to be corrected before anything is touched.`,
          ]
        : []),
      `- Work the plan in order, and record it with ${WORK_PLAN_TOOL_NAME}: "active" before a step, then "done", "skipped" or "failed" when you leave it. The plan is what the user watches, and a run whose steps never move is reported as having done nothing regardless of what it wrote.`,
      '- Say what you are doing before you do it, and what you found afterwards.',
      `- When only the user can decide something, call ${WORK_ASK_TOOL_NAME} rather than guessing. Guessing produces a deliverable that is confidently wrong.`,
      '- Cite the source of every fact that came from a tool, a connector or the web.',
      '- Report what you could not establish. An unmentioned gap reads as an answer.',
      '- Report the plan you followed, what you did, what you relied on, the choices you made and what you are unsure of. Do not narrate your intermediate reasoning; it is neither checkable nor stable, and the user needs the evidence rather than the story.',
      tierPromptSection(),
      '',
      UNTRUSTED_CONTENT_RULE,
      ...(this.options.systemSuffix ? ['', this.options.systemSuffix] : []),
    ].join('\n');
  }
}

/**
 * The default final check: does the run's own record support calling this done?
 *
 * Structural on purpose. It cannot judge whether a document is any good, and a
 * check that claimed to would be worse than none. What it can do is catch the
 * specific failure that makes a Work run untrustworthy — a run that reports
 * success while a step it planned never happened, or was skipped for a reason
 * nobody was told, or produced nothing at all. Every one of those reads to the
 * user as "done", and a user who is told "done" does not re-read the output.
 */
export function structuralValidation(input: {
  goal: string;
  plan: WorkPlan;
  answer: string;
  artifacts: readonly WorkArtifactRef[];
}): WorkValidationResult {
  const checks: WorkValidationCheck[] = [];
  const snapshot = input.plan.snapshot();

  const outstanding = snapshot.steps.filter((step) => !isTerminalStepStatus(step.status));
  // "Never began" and "got partway" are the same check and not the same
  // failure, and saying so is the difference between a message a person can act
  // on and a list they cannot.
  //
  // A run whose every step is still `pending` did not stall halfway — the model
  // answered without touching the plan at all, which in practice means it
  // narrated an intention ("let me fetch that information") and called no tool.
  // Reporting that as "Still open: <every step>" points the reader at their
  // plan, which is not where the problem is.
  //
  // (That last clause used to read "the plan is a fixed three-step scaffold and
  // identical on every run", which `write_plan` made false. The distinction the
  // check draws survives the change — a model that wrote a real plan and then
  // touched none of it has still narrated instead of working — but the reason
  // is now that the plan is not the problem, rather than that the plan is
  // boilerplate.)
  const untouched = snapshot.steps.length > 0 && snapshot.steps.every((step) => step.status === 'pending');
  checks.push({
    claim: 'Every planned step reached a conclusion.',
    satisfied: outstanding.length === 0,
    evidence:
      outstanding.length === 0
        ? `All ${snapshot.steps.length} steps are done, skipped or failed.`
        : untouched
          ? 'Juno answered without starting the plan: no step was begun, so nothing was actually done.'
          : `Still open: ${outstanding.map((step) => step.title).join('; ')}.`,
  });

  const unexplained = snapshot.steps.filter(
    (step) =>
      (step.status === 'skipped' || step.status === 'failed') && !(step.reason ?? '').trim(),
  );
  checks.push({
    claim: 'Every step that was skipped or failed says why.',
    satisfied: unexplained.length === 0,
    evidence:
      unexplained.length === 0
        ? 'No unexplained skips or failures.'
        : `No reason recorded for: ${unexplained.map((step) => step.title).join('; ')}.`,
  });

  const answer = input.answer.trim();
  checks.push({
    claim: 'The run produced something to hand back.',
    satisfied: input.artifacts.length > 0 || answer.length > 0,
    evidence:
      input.artifacts.length > 0
        ? `${input.artifacts.length} artifact(s) produced.`
        : answer.length > 0
          ? 'A written answer was produced.'
          : 'No artifact and no written answer.',
  });

  /*
   * The check that used to be here demanded the step's ENTIRE TITLE, verbatim,
   * as a lowercase substring of the final answer. It was catching something
   * real — a run that skipped a third of the plan and wrote a summary that
   * never mentions it — and it was tenable only because of an assumption stated
   * a few lines above and no longer true: "the plan is a fixed three-step
   * scaffold and identical on every run". Against `Understand what is being
   * asked` a substring test is coarse but survivable.
   *
   * `write_plan` ended that. The model now writes its own titles, and it is
   * told to write concrete ones — "Find the repositories with no README" — the
   * kind of sentence a summary paraphrases and never quotes. So a skipped step
   * failed this check essentially always, and a failed step did too. With
   * `outstanding` above requiring every step to reach a terminal status, the
   * three terminal statuses came to mean: `done` passes, `skipped` fails the
   * run, `failed` fails the run. A model that wrote six steps and honestly
   * concluded that two were unnecessary had no reachable passing state, and the
   * only winning move was to claim it had done work it had not done. A check
   * that makes honesty the losing option is worse than no check.
   *
   * What replaces it keeps the intent and drops the impossible test. A step
   * that did not succeed must carry a reason — enforced immediately above, and
   * `update_plan` already asks for one — and that reason travels with the step
   * into `buildReport` and onto the plan panel, where the reader sees it beside
   * the step itself rather than buried in prose. The record is what guarantees
   * nothing vanished; the summary's wording is the model's business.
   */
  const concluded = snapshot.steps.filter(
    (step) => step.status === 'skipped' || step.status === 'failed',
  );
  checks.push({
    claim: 'Every step that did not succeed is accounted for.',
    // Always satisfied when every such step has a reason, which `unexplained`
    // above has already established. Kept as a visible check rather than
    // deleted so the report still states the fact for the reader.
    satisfied: true,
    evidence:
      concluded.length === 0
        ? 'Every step succeeded.'
        : `${concluded.length} step${concluded.length === 1 ? '' : 's'} did not succeed, each with a stated reason.`,
  });

  // `unmet` carries the *evidence*, not the claim.
  //
  // A claim is written as the thing that is true when the check passes —
  // "Every planned step reached a conclusion." — and `terminalOutcome`
  // interpolates this list after "The deliverable does not yet answer the
  // goal:". Mapping claims therefore printed the success sentence as the
  // reason for the failure, and a user watching a run die read:
  //
  //   The deliverable does not yet answer the goal: Every planned step
  //   reached a conclusion.
  //
  // — which asserts the opposite of what happened and names nothing they can
  // act on. Every `evidence` string on a failing branch is already written as
  // a statement of what went wrong ("Still open: …", "No artifact and no
  // written answer."), so the sentence becomes true and specific by using it.
  const failed = checks.filter((check) => !check.satisfied);
  // `judged: false` — see the field's note. This function is handed the goal
  // and does not read it.
  return {
    satisfied: failed.length === 0,
    checks,
    unmet: failed.map((check) => check.evidence),
    judged: false,
  };
}
