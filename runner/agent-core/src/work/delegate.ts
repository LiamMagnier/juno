/**
 * Delegation for a Work run: one child agent, its own context window, the
 * parent's guards.
 *
 * `SubagentManager` in ../subagents.ts is the Code answer to this and it is not
 * reusable here, for one reason that is worth stating plainly rather than
 * discovering later. That manager gives its children their own permission
 * engine, their own risk classifier and their own approval requests, because
 * Code's gate is `PermissionEngine` and its unit of isolation is a git
 * worktree. A Work run's gate is nothing of the sort: it is the tier lattice,
 * the action/risk ladder with its always-confirm floor, the approval digest
 * pinned to the policy in force, the provenance record and the untrusted
 * envelope — all of them implemented once, inside
 * `WorkAgentSession.executeToolCall`. A child wired to a second gate would be a
 * second answer to "may this run send that email", and the tools module's own
 * warning applies exactly: a hole in one channel is the kind nobody notices.
 *
 * So a delegation here is not a second session. It is a second *transcript*
 * driven by the same loop, whose tool calls are executed by the parent's own
 * executor and whose provider requests are metered by the parent's own budget
 * guard. The child gets the one thing it is for — a context window that starts
 * empty and ends at its report — and gets nothing else the parent did not
 * already have.
 *
 * WHY ONE AT A TIME
 *
 * `delegate` blocks until the child is done, and a run may have only one child
 * running, because the two things a concurrent child would touch are both
 * single-threaded by construction. A Work run has ONE status: two children
 * asking for approval at once would need two `waiting_approval` states, and the
 * run has one. And the limits a run answers to are wall-clock as well as
 * monetary — the run's own ceilings, and behind them the account's rolling
 * window — so parallel children would multiply the spend rate per second of
 * that window without multiplying anything the reader asked for. The win being
 * bought here is the fresh context, not the concurrency.
 */

import { runAgentLoop } from '../loop.js';
import type { ProviderAdapter, ReasoningEffort } from '../providers/types.js';
import type { ChatMessage, ToolSpec, Usage, UserContent } from '../types.js';
import { UNTRUSTED_CONTENT_RULE } from './injection.js';
import { tierPromptSection } from './tier.js';
import type { WorkSubagentStatus, WorkToolDefinition } from './types.js';

/** The tool the model calls to hand one piece of work to a child agent. */
export const WORK_DELEGATE_TOOL_NAME = 'delegate';

/**
 * How many children one run may spawn.
 *
 * Not a spend control — the budget guard is, and the child's tokens go through
 * it exactly as the parent's do, so a cap here would be a second limit saying
 * something the first one already says better. It is a loop control: a model
 * that answers every difficulty by delegating it produces a run whose whole
 * record is agents briefing agents, and the sixth refusal is where it is told
 * to do the work itself.
 */
export const MAX_DELEGATIONS_PER_RUN = 6;

/**
 * Steps one child may take before it is stopped and made to report.
 *
 * Lower than the parent's cap by a lot. A child exists to answer one question
 * with a fresh context; a child on its fortieth step has either been given the
 * whole task or has lost the thread, and both are better handled by the parent
 * reading a short report than by the child carrying on alone.
 *
 * It is worth being explicit that these steps are the child's own: the child
 * runs its own loop, so they do not count against `MAX_STEPS_PER_RUN`, and a
 * run that delegates to its limit can take 200 + 6 * 30 = 380 steps in total
 * rather than 200. Every one of them is metered by the same budget guard, so
 * this is not a spending hole; it is the shape of the step backstop, and the
 * step backstop is the last one standing wherever the time and token ceilings
 * are gone.
 */
export const MAX_STEPS_PER_DELEGATION = 30;

/** Longest report a child may hand back, in characters. */
export const MAX_DELEGATION_REPORT_CHARS = 8_000;

/** Longest brief a parent may write for a child, in characters. */
const MAX_DELEGATION_PROMPT_CHARS = 20_000;

export interface DelegationTask {
  title: string;
  prompt: string;
  context?: string;
}

export function delegateToolSpec(): ToolSpec {
  return {
    name: WORK_DELEGATE_TOOL_NAME,
    description:
      'Hand one self-contained piece of work to a child agent with a fresh context window, and wait for its written report. ' +
      'Use it when a piece of the task would fill your own context with material you do not need afterwards — reading twenty pages to answer one question, or working a branch of the problem you may end up discarding. ' +
      'The child sees ONLY what you write here: it cannot read this conversation. It has the same tools and the same permissions you do, it cannot delegate further, and it cannot ask the user anything — bring any question back and ask it yourself. ' +
      'Everything it spends comes out of this task\'s budget, so delegate work worth a fresh context and do small things yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'A short line naming the task, in the user\'s terms. Shown to the user while the child works.',
        },
        prompt: {
          type: 'string',
          description:
            'Complete, self-contained instructions, including what "done" looks like and what to report back. The child has no other context.',
        },
        context: {
          type: 'string',
          description:
            'Facts the child needs that it cannot look up — what you have already established, decisions already made, ids and names it would otherwise have to re-derive.',
        },
      },
      required: ['title', 'prompt'],
    },
  };
}

/**
 * A validated task, or the sentence to hand back explaining why it is not one.
 *
 * Returns the refusal rather than throwing because every one of these is a
 * message the model reads and retries from, not an error the run should end on.
 */
export function parseDelegation(input: Record<string, unknown>): DelegationTask | string {
  const title = String(input.title ?? '').trim();
  const prompt = String(input.prompt ?? '').trim();
  const context = String(input.context ?? '').trim();
  if (!title) return 'A title is required: one short line naming the task.';
  if (!prompt) {
    return 'A prompt is required, and it has to stand alone — the child cannot see this conversation.';
  }
  if (prompt.length + context.length > MAX_DELEGATION_PROMPT_CHARS) {
    return `That brief is ${prompt.length + context.length} characters and the limit is ${MAX_DELEGATION_PROMPT_CHARS}. Delegate a narrower piece of work, or park the material in a cloud file and tell the child to read it.`;
  }
  return { title, prompt, ...(context ? { context } : {}) };
}

/**
 * What the child is told about itself.
 *
 * The run's goal is included even though the child is not working the goal, and
 * that is deliberate: a child told only "extract the table from this page" and
 * nothing about why will answer the letter of its brief and miss the column the
 * task turned on. It is told in as many words that the brief wins, so the goal
 * informs its judgement without becoming a second instruction it tries to
 * satisfy.
 *
 * `UNTRUSTED_CONTENT_RULE` is repeated here rather than assumed. The child reads
 * connector and web output through the same envelope the parent does — the
 * envelope is applied by the parent's executor, which is what runs its tool
 * calls — so a child that had never been told what the envelope means would be
 * the one context in the run where the rule is not in force.
 */
export function delegationSystemPrompt(goal: string, task: DelegationTask): string {
  return [
    'You are a child agent inside a Juno Work run. You have been given one piece of the task and nothing else: you cannot see the conversation that sent you, and nobody will read anything but your final report.',
    '',
    '# The task this run is doing',
    '',
    goal,
    '',
    '# Your piece of it',
    '',
    task.title,
    '',
    task.prompt,
    ...(task.context ? ['', '# What the coordinator already knows', '', task.context] : []),
    '',
    '# Operating rules',
    '',
    '- Your brief above is what you are doing. The goal is there so you can tell which details matter; where the two disagree, the brief wins.',
    '- You cannot delegate, you cannot ask the user a question, and you cannot change the run\'s plan. If you need a decision only a person can make, stop and say so in your report — the coordinator will ask.',
    '- Every tool call you make is made by the run itself: the same permissions, the same approvals, the same record. An action the run would have to ask about, you will have to wait for.',
    '- Cite the source of every fact you report. The coordinator will repeat what you say and cannot check it.',
    '- Finish with the report itself, in full. It is the only thing that leaves this context: say what you did, what you found, what you could not establish, and nothing about the process of finding out.',
    tierPromptSection(),
    '',
    UNTRUSTED_CONTENT_RULE,
  ].join('\n');
}

export interface DelegationDeps {
  provider: ProviderAdapter;
  model: string;
  /** The run's goal, for the child's orientation. Never a paraphrase. */
  goal: string;
  /** The run's toolset, unnarrowed. See the module note on the second gate. */
  tools: readonly WorkToolDefinition[];
  /**
   * The parent's executor, already wrapped to refuse the tools a child may not
   * call. Routing through it is the whole design: the child's calls are gated,
   * recorded, enveloped and approved exactly as the parent's are.
   */
  executeToolCall(call: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }): Promise<UserContent | UserContent[]>;
  /**
   * The parent's budget seam — `withBudget(guard)`, the same guard object.
   *
   * This is the line that makes delegation safe to offer at all. A child
   * metered anywhere else would be a way to spend outside every limit a run
   * answers to — its own ceilings and the account's window behind them — and
   * spending is the one thing a person cannot see being exceeded.
   */
  onStep(usage: Usage): void | 'stop';
  /** The parent's abort signal: a Stop or a ceiling ends the child too. */
  signal: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  silenceTimeoutMs?: number;
  maxSteps?: number;
  /** Progress, as the run's own transcript records it. */
  onStatus(update: { status: WorkSubagentStatus; summary?: string }): void;
}

export interface DelegationOutcome {
  status: WorkSubagentStatus;
  /** What goes back to the model as the tool result. */
  report: string;
  isError: boolean;
}

/**
 * Run one child to completion and return what it has to say.
 *
 * Never throws. A child that fails is a fact the parent has to read and work
 * around — a research branch that came back empty is often exactly the answer —
 * and turning it into an exception would end a run over a question that was
 * only ever worth one paragraph of the report.
 */
export async function runDelegation(
  task: DelegationTask,
  deps: DelegationDeps,
): Promise<DelegationOutcome> {
  deps.onStatus({ status: 'running' });

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Begin. Report when you are done.' }],
    },
  ];

  try {
    const result = await runAgentLoop({
      provider: deps.provider,
      model: deps.model,
      system: delegationSystemPrompt(deps.goal, task),
      messages,
      tools: deps.tools.map((tool) => tool.spec),
      signal: deps.signal,
      maxSteps: deps.maxSteps ?? MAX_STEPS_PER_DELEGATION,
      ...(deps.reasoningEffort ? { reasoningEffort: deps.reasoningEffort } : {}),
      ...(deps.silenceTimeoutMs === undefined ? {} : { silenceTimeoutMs: deps.silenceTimeoutMs }),
      executeToolCall: (call) => deps.executeToolCall(call),
      onStep: deps.onStep,
    });

    // An aborted child is not a failed one, and the difference is which
    // sentence the reader gets. The parent was stopped, paused or had its
    // ceiling reached; the child stopped because of that, and reporting it as a
    // failure would send somebody looking at the child.
    if (deps.signal.aborted) {
      const summary = 'The run stopped while this was working, so it did not finish.';
      deps.onStatus({ status: 'cancelled', summary });
      return { status: 'cancelled', report: summary, isError: true };
    }

    const finalText = result.finalText.trim();
    if (result.stopReason === 'max_steps') {
      const summary =
        `It reached its ${deps.maxSteps ?? MAX_STEPS_PER_DELEGATION}-step limit without finishing. What it had at that point:\n` +
        (finalText || '(nothing written)');
      deps.onStatus({ status: 'failed', summary: cap(summary) });
      return { status: 'failed', report: cap(summary), isError: true };
    }
    if (!finalText) {
      const summary = 'It finished without writing a report, so there is nothing to take from it.';
      deps.onStatus({ status: 'failed', summary });
      return { status: 'failed', report: summary, isError: true };
    }

    const report = cap(finalText);
    deps.onStatus({ status: 'completed', summary: report });
    return { status: 'completed', report, isError: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const summary = `It stopped with an error: ${detail}`;
    deps.onStatus({ status: 'failed', summary: cap(summary) });
    return { status: 'failed', report: cap(summary), isError: true };
  }
}

/**
 * Trims a report to what the parent's context can afford to take.
 *
 * Cut at the end rather than the middle. A child is told to write its report
 * last and in full, so the front of what it wrote is the report and the tail is
 * whatever ran long; taking the middle out would leave two halves that read as
 * one continuous passage and are not.
 */
function cap(text: string): string {
  if (text.length <= MAX_DELEGATION_REPORT_CHARS) return text;
  return (
    `${text.slice(0, MAX_DELEGATION_REPORT_CHARS)}\n\n[Cut off here: the report was ${text.length} characters. ` +
    'Do not describe the rest as though you have read it.]'
  );
}
