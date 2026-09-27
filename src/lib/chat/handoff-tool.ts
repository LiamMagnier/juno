/**
 * `hand_off_to_teammate`: one agent giving a piece of work to another.
 *
 * The narrow handoff docs/design/AGENTS.md §8 leaves room for, and nothing
 * more. An agent in its own thread, asked by the person or agreeing when it
 * suggested it, gives a job to a named teammate. The job becomes a task of the
 * teammate's, in the teammate's thread, under the teammate's autonomy and
 * apps, exactly as if the person had pressed Start on the teammate's page
 * (`startAgentTask`). There are no rooms, no claims and no conversation
 * between agents: the work leaves this thread and reports back in the other.
 *
 * Two halves in one file, like task-tool.ts and for the same reason. The top is
 * pure (the declaration, the arguments, who the teammate is, the goal it is
 * given, the sentences each outcome becomes) and is tested without a request.
 * The bottom is `createHandoffTool`, which reaches Prisma, the agents store and
 * the approval broker through `await import()`, so nothing `server-only` sits
 * in this module's static graph.
 *
 * What keeps a handoff honest, in the order it applies:
 *
 *   1. The gate. The turn passes the one `start_task` passes (a saved,
 *      human-authored, non-private chat turn), in an agent's thread, on an
 *      account with at least one other active agent.
 *   2. The name. Resolved among the account's other active agents, exactly and
 *      ignoring case. A name two agents share is refused, never guessed at:
 *      agent names are not unique.
 *   3. A person, every time. A handoff always raises the approval card with the
 *      teammate, the title, the estimate and the whole brief, whatever the
 *      estimate. Work leaving this thread for one the person is not looking at
 *      is exactly what they should see before it happens.
 *   4. Work's own checks, through `startAgentTask`: the plan gate, the usage
 *      windows, the rate limit, the concurrency cap and the preflight.
 *   5. Bounds on repetition: one handoff per turn, one per message whatever
 *      retries (every key derives from it), and an hourly limit per account.
 *
 * A handoff cannot chain. The teammate's result arrives as a Work panel in its
 * own thread, never as a model turn, and a run never carries chat tools, so
 * nothing the teammate does can hand the work on again without a person
 * writing in its thread.
 */

import type { McpFunctionTool, ToolExecution } from "@/lib/mcp";
import type { NativeChatTool } from "@/lib/llm";
import type { ClientActionApproval } from "@/lib/action-approval";
import {
  LIVE_TASK_STATUSES,
  MAX_TASK_GOAL_CHARS,
  TASK_APPROVAL_CONNECTOR_ID,
  TASK_REFUSALS,
  TASK_TOOL_LABEL,
  approvalRefusalReason,
  composeTaskGoal,
  formatTaskEstimate,
  parseStartTaskArgs,
  taskRefusalFromResponse,
  type StartTaskArgs,
} from "@/lib/chat/task-tool";
import { agentTaskKeys } from "@/lib/agents/domain";

/** The tool's name on the wire, and the name the approval receipt records. */
export const HAND_OFF_TOOL_ID = "hand_off_to_teammate";

/** Handoffs one account may start in an hour. Each is a task, so this sits above Work's own limits, not in place of them. */
export const HANDOFF_RATE_LIMIT = { limit: 20, windowSec: 60 * 60 } as const;

/**
 * The declaration the model sees. The same four keys `start_task` uses, for
 * the same provider reasons; when to call it is the agent block's job
 * (src/lib/agents/prompt.ts), which names the teammates.
 */
export const HAND_OFF_TOOL: McpFunctionTool = {
  type: "function",
  function: {
    name: HAND_OFF_TOOL_ID,
    description:
      "Hand a piece of work to one of your teammates, another of the user's agents. It runs as them, in their own thread, with their apps and autonomy, and they report back there, not in this conversation. The user approves every handoff before it starts. Use it only when the user asks you to pass work to a teammate or agrees when you suggest it. It returns whether the work was handed off.",
    parameters: {
      type: "object",
      properties: {
        teammate: {
          type: "string",
          description: "The teammate's name, exactly as it appears under Your teammates.",
        },
        title: {
          type: "string",
          description:
            "A short name for the work, at most 60 characters, naming the outcome in sentence case. Example: \"Draft replies to the supplier emails\".",
        },
        goal: {
          type: "string",
          description:
            "A self-contained brief for your teammate: what the user wants, every relevant detail from this conversation (names, links, numbers, preferences), constraints, and what done looks like. Your teammate cannot read this conversation, so include everything it needs.",
        },
        deliverable: {
          type: "string",
          description: "Optional. What exists when the work is done, in a few words.",
        },
      },
      required: ["teammate", "title", "goal"],
    },
  },
};

// ---------------------------------------------------------------------------
// Keys, arguments, the teammate and the goal
// ---------------------------------------------------------------------------

/**
 * One handoff per user message, whatever happens to the stream.
 *
 * `task` is the key `startAgentTask` namespaces by the teammate's id; the
 * approval call id is the message's alone, so a retry that names a different
 * teammate meets the receipt the first one raised and is refused as changed
 * arguments rather than asking the person a second question.
 */
export function handoffIdempotencyKeys(userMessageId: string): { task: string; approval: string } {
  return { task: `handoff:${userMessageId}`, approval: `agent-handoff-approval:${userMessageId}` };
}

export interface HandoffArgs extends StartTaskArgs {
  teammate: string;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** The model's arguments, trimmed and bounded like a task's, or null without a teammate, a title and a goal. */
export function parseHandoffArgs(args: Record<string, unknown>): HandoffArgs | null {
  const teammate = typeof args.teammate === "string" ? oneLine(args.teammate).replace(/^@/, "") : "";
  const task = parseStartTaskArgs(args);
  if (!teammate || !task) return null;
  return { teammate, ...task };
}

/** An agent as the resolver needs it. */
export interface HandoffCandidate {
  id: string;
  name: string;
  status: string;
}

export type TeammateResolution<T extends HandoffCandidate> =
  | { kind: "found"; teammate: T }
  | { kind: "refused"; outcome: Extract<HandoffOutcome, { status: "not_handed_off" }> };

/** "A", "A and B", "A, B and C", each quoted, because the model has to pass one back exactly. */
function nameList(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length <= 1 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * Which of the account's agents the model means.
 *
 * `candidates` is every agent the account keeps (retired ones excluded by the
 * caller), the handing agent included, so each refusal can say what actually
 * went wrong. Matched on the whole name, ignoring case and spacing, never on a
 * prefix: "Al" is not "Alice". Only active teammates can take work; a paused
 * one is named as paused, and the handing agent as itself.
 */
export function resolveTeammate<T extends HandoffCandidate>(
  wanted: string,
  candidates: readonly T[],
  selfId: string
): TeammateResolution<T> {
  const key = oneLine(wanted).toLocaleLowerCase();
  const same = (agent: T) => oneLine(agent.name).toLocaleLowerCase() === key;
  const teammates = candidates.filter((agent) => agent.id !== selfId);
  const active = teammates.filter((agent) => agent.status === "active");
  const matches = active.filter(same);
  if (matches.length === 1) return { kind: "found", teammate: matches[0] };
  const refused = (reason: string, message: string): TeammateResolution<T> => ({
    kind: "refused",
    outcome: { status: "not_handed_off", reason, message },
  });
  if (matches.length > 1) {
    return refused(
      "ambiguous_teammate",
      `More than one teammate is called "${matches[0].name}", so it is not clear which one should take this. Ask the user to rename one of them on its page first. Nothing was handed off.`
    );
  }
  const paused = teammates.find(same);
  if (paused) {
    return refused(
      "teammate_paused",
      `${paused.name} is paused, so it cannot take new work until the user resumes it from its page. Nothing was handed off.`
    );
  }
  if (candidates.some((agent) => agent.id === selfId && same(agent))) {
    return refused("self", "That is you, so there is nobody to hand this to. Nothing was handed off.");
  }
  const names = [...new Set(active.map((agent) => oneLine(agent.name)))];
  return refused(
    "unknown_teammate",
    names.length > 0
      ? `There is no active teammate called "${oneLine(wanted)}". Your teammates are ${nameList(names)}. Nothing was handed off.`
      : "You have no active teammates to hand this to. Nothing was handed off."
  );
}

/**
 * The goal the teammate's task is created with.
 *
 * It opens by saying where the work came from, so the teammate reads the
 * request in the right light: the person's words were addressed to another
 * agent. The rest is a task's goal (`composeTaskGoal`): the person's own words
 * first, then the brief the handing agent wrote, then the deliverable, all
 * inside `MAX_TASK_GOAL_CHARS` so the approval card shows every word the
 * teammate will be told. The brief gives way first, as it does for a task.
 */
export function composeHandoffGoal(input: {
  from: string;
  to: string;
  request: string;
  brief: string;
  deliverable: string | null;
}): string {
  const lead = `${oneLine(input.from)} handed this to ${oneLine(input.to)}.`;
  const assemble = (brief: string) =>
    `${lead}\n\n${composeTaskGoal({ request: input.request, brief, deliverable: input.deliverable })}`;
  const brief = input.brief.trim();
  let goal = assemble(brief);
  const over = goal.length - MAX_TASK_GOAL_CHARS;
  if (over > 0 && brief) goal = assemble(clip(brief, Math.max(1, brief.length - over)));
  return clip(goal, MAX_TASK_GOAL_CHARS);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type HandoffOutcome =
  | {
      status: "handed_off";
      teammate: string;
      title: string;
      /** This message's handoff already existed; nothing new was started. */
      replay: boolean;
    }
  | { status: "not_handed_off"; reason: string; message: string };

/** The tool's own refusals. Refusals about a particular teammate name it, and are built where they arise. */
export const HANDOFF_REFUSALS = {
  invalid_arguments: "A handoff needs a teammate, a title and a goal. Nothing was handed off.",
  declined: "The user declined this handoff, so nothing was handed off.",
  approval_expired: "The request to hand this off expired before it was answered, so nothing was handed off.",
  approval_blocked: "Your approval settings do not allow this handoff, so nothing was handed off.",
  approval_failed: "The approval for this handoff could not be used, so nothing was handed off.",
  stopped: "The reply was stopped before the handoff, so nothing was handed off.",
  already_tried: "This message already tried to hand work off and it did not go through. Nothing new was handed off.",
  agent_paused: "This agent is paused. Resume it before handing work to a teammate. Nothing was handed off.",
  rate_limited: "There have been too many handoffs in the last hour, so nothing was handed off.",
  internal_error: "Juno could not hand this off because of a problem on its side. Nothing was handed off.",
} as const;

export type HandoffRefusalReason = keyof typeof HANDOFF_REFUSALS;

export function handoffRefusal(reason: HandoffRefusalReason): Extract<HandoffOutcome, { status: "not_handed_off" }> {
  return { status: "not_handed_off", reason, message: HANDOFF_REFUSALS[reason] };
}

/** The refusal for a teammate whose thread already has a task going. It follows one task at a time, as every thread does. */
export function teammateBusy(name: string, title: string): Extract<HandoffOutcome, { status: "not_handed_off" }> {
  return {
    status: "not_handed_off",
    reason: "teammate_busy",
    message: `${name} is already working on "${title}". Let that finish before handing it more. Nothing was handed off.`,
  };
}

/** A refusal from Work's dispatch or `startAgentTask`, in the route's own words (`taskRefusalFromResponse`). */
export function handoffRefusalFromResponse(
  status: number,
  body: Record<string, unknown>
): Extract<HandoffOutcome, { status: "not_handed_off" }> {
  const refusal = taskRefusalFromResponse(status, body);
  return {
    status: "not_handed_off",
    reason: refusal.reason,
    message: refusal.message === TASK_REFUSALS.internal_error ? HANDOFF_REFUSALS.internal_error : refusal.message,
  };
}

/**
 * One outcome, as JSON for the model and a sentence for the panel. The model's
 * copy repeats the instruction that matters at that moment: who has it now, and
 * where the result will appear, which is not here.
 */
export function describeHandoffOutcome(outcome: HandoffOutcome): ToolExecution {
  if (outcome.status === "handed_off") {
    return {
      text: JSON.stringify({
        status: "handed_off",
        teammate: outcome.teammate,
        title: outcome.title,
        ...(outcome.replay ? { note: "This message's handoff had already started. Nothing new was started." } : {}),
        instruction: `Reply with one short sentence saying that ${outcome.teammate} has it and will report back in ${outcome.teammate}'s own thread. Do not do the work yourself, restate a plan or predict the result.`,
      }),
      body: outcome.replay
        ? `Already handed "${outcome.title}" to ${outcome.teammate}.`
        : `Handed "${outcome.title}" to ${outcome.teammate}.`,
      ok: true,
    };
  }
  return {
    text: JSON.stringify({
      status: "not_handed_off",
      reason: outcome.reason,
      message: outcome.message,
      instruction: "Tell the user in one sentence why it was not handed off, then offer what you can do here instead.",
    }),
    body: outcome.message,
    ok: false,
  };
}

/**
 * What the approval receipt binds and the card shows: who takes it, what it is
 * called, what it may cost, and the whole goal the teammate will be told.
 */
export function handoffApprovalArgs(input: {
  teammate: string;
  title: string;
  goal: string;
  estimatedCostMicroUsd: number;
}): Record<string, unknown> {
  return {
    teammate: input.teammate,
    title: input.title,
    estimate: `about ${formatTaskEstimate(input.estimatedCostMicroUsd)}`,
    goal: input.goal,
  };
}

/**
 * Whether an approval is a handoff: Juno's own connector id and this tool's
 * name together, as `isTaskApproval` tests a task. The card repeats the test on
 * the same literals rather than importing it, for the reason task-tool.ts gives.
 */
export function isHandoffApproval(approval: Pick<ClientActionApproval, "connectorId" | "toolName">): boolean {
  return approval.connectorId === TASK_APPROVAL_CONNECTOR_ID && approval.toolName === HAND_OFF_TOOL_ID;
}

/** The activity row's wording for this tool, before and after it answers. */
export function handoffActivityTitle(phase: "call" | "result", ok?: boolean): string {
  if (phase === "call") return "Handing off to a teammate";
  return ok ? "Handed off" : "Not handed off";
}

/** "To Atlas: Draft the replies", out of the raw argument JSON an adapter reports, for the activity row. */
export function handoffDetailFromArgs(rawArgs: string | undefined): string | null {
  if (!rawArgs) return null;
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const args = parseHandoffArgs(parsed as Record<string, unknown>);
    return args ? `To ${args.teammate}: ${args.title}` : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The server half
// ---------------------------------------------------------------------------

export interface HandoffToolContext {
  user: { id: string; email?: string | null; name?: string | null };
  conversation: { id: string; projectId: string | null };
  /** The agent whose thread this is: the one handing the work over. */
  fromAgent: { id: string; name: string; status?: string };
  /** The persisted user turn this reply answers. Every key derives from it. */
  userMessageId: string;
  /** The user's own words this turn, as the transcript shows them. */
  userRequest: string;
  /** Text Juno did not author is in this turn's context. The card says so. */
  untrustedContent: boolean;
  /** The generation id: with the approval call id, the broker's idempotency key. */
  generationId: string;
  onApprovalRequest?: (approval: ClientActionApproval) => void;
}

/**
 * The tool, bound to one turn.
 *
 * Serialised like `start_task`, and spent once a handoff reached the person:
 * after that every call in the turn answers with what became of the first,
 * whether it started or was declined, so one reply can never put two handoffs
 * in front of the person. A call refused before anything was created (a wrong
 * name, a busy teammate) can be made again with the right one.
 */
export function createHandoffTool(ctx: HandoffToolContext): NativeChatTool {
  let spent: HandoffOutcome | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const run = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecution> => {
    if (spent) {
      return describeHandoffOutcome(spent.status === "handed_off" ? { ...spent, replay: true } : handoffRefusal("already_tried"));
    }
    let result: { outcome: HandoffOutcome; spent: boolean };
    try {
      result = await handOff(ctx, args, signal);
    } catch (err) {
      console.error("[chat:handoff] hand_off_to_teammate failed", {
        conversationId: ctx.conversation.id,
        error: err instanceof Error ? err.message : String(err),
      });
      result = { outcome: handoffRefusal("internal_error"), spent: true };
    }
    if (result.spent) spent = result.outcome;
    console.info("[chat:handoff] hand_off_to_teammate", {
      conversationId: ctx.conversation.id,
      status: result.outcome.status,
      ...(result.outcome.status === "not_handed_off" ? { reason: result.outcome.reason } : {}),
    });
    return describeHandoffOutcome(result.outcome);
  };

  return {
    tool: HAND_OFF_TOOL,
    label: TASK_TOOL_LABEL,
    access: "write",
    execute(args, signal) {
      const next = queue.then(() => run(args, signal));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/** `spent` says whether the person was asked, or the work was handed off: either way the turn has had its handoff. */
async function handOff(
  ctx: HandoffToolContext,
  rawArgs: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ outcome: HandoffOutcome; spent: boolean }> {
  const early = (outcome: HandoffOutcome) => ({ outcome, spent: false });
  const args = parseHandoffArgs(rawArgs);
  if (!args) return early(handoffRefusal("invalid_arguments"));
  if (signal?.aborted) return early(handoffRefusal("stopped"));
  if (ctx.fromAgent.status && ctx.fromAgent.status !== "active") {
    return early(handoffRefusal("agent_paused"));
  }

  const [{ prisma }, agents, dispatch, approvals, { rateLimit }] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/agents/store"),
    import("@/lib/work/dispatch"),
    import("@/lib/action-approval-store"),
    import("@/lib/rate-limit"),
  ]);
  const { user } = ctx;
  const fromAgentRow = await prisma.agent.findFirst({
    where: { id: ctx.fromAgent.id, userId: user.id, deletedAt: null },
    select: { status: true },
  });
  if (!fromAgentRow || fromAgentRow.status !== "active") {
    return early(handoffRefusal("agent_paused"));
  }

  const roster = await prisma.agent.findMany({
    where: { userId: user.id, deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, status: true },
  });
  const resolved = resolveTeammate(args.teammate, roster, ctx.fromAgent.id);
  if (resolved.kind === "refused") return early(resolved.outcome);
  const target = await agents.findAgent(user.id, resolved.teammate.id);
  if (!target) return early(handoffRefusal("internal_error"));

  const keys = handoffIdempotencyKeys(ctx.userMessageId);
  const taskKeys = agentTaskKeys(target.id, keys.task);
  const ownSessionId = dispatch.sessionIdForKey(user, taskKeys.session);

  // This message already handed this off, was declined, and its draft was put
  // away then. Asked before anything is created, as `start_task` asks, so a
  // resumed turn answers rather than asking the person again.
  const previous = await prisma.workSession.findFirst({
    where: { id: ownSessionId, userId: user.id },
    select: { deletedAt: true },
  });
  if (previous?.deletedAt) return { outcome: handoffRefusal("already_tried"), spent: true };

  // One task at a time in the teammate's thread, as in any thread: a second
  // would hide the first from the person reading it. This message's own task is
  // excluded, so a retry recognises it instead of calling it busy.
  if (target.conversationId) {
    const live = await prisma.workSession.findFirst({
      where: {
        userId: user.id,
        conversationId: target.conversationId,
        deletedAt: null,
        status: { in: [...LIVE_TASK_STATUSES] },
        id: { not: ownSessionId },
      },
      orderBy: { createdAt: "desc" },
      select: { title: true },
    });
    if (live) return early(teammateBusy(target.name, live.title));
  }

  const limit = await rateLimit({ key: `agents:handoff:${user.id}`, ...HANDOFF_RATE_LIMIT });
  if (!limit.success) return early(handoffRefusal("rate_limited"));

  const input = {
    title: args.title,
    goal: composeHandoffGoal({
      from: ctx.fromAgent.name,
      to: target.name,
      request: ctx.userRequest,
      brief: args.goal,
      deliverable: args.deliverable,
    }),
    idempotencyKey: keys.task,
  };

  /*
   * Asked first, always: `askFirst` stops at the estimate with the draft made,
   * and the answer lands on the same key. A replay finds this message's run
   * already going and answers `started` without asking again.
   */
  const first = await agents.startAgentTask(user, target, { ...input, askFirst: true });
  if (first.kind === "refused") return early(handoffRefusalFromResponse(first.status, first.body));
  if (first.kind === "started") {
    return { outcome: { status: "handed_off", teammate: target.name, title: args.title, replay: first.replay }, spent: true };
  }

  const draftId = first.sessionId;
  const notHandedOff = async (outcome: Extract<HandoffOutcome, { status: "not_handed_off" }>) => {
    await agents.discardAgentTaskDraft(user.id, draftId);
    return { outcome, spent: true };
  };

  const authorization = await approvals.authorizeExternalAction({
    userId: user.id,
    surface: "chat",
    sessionId: ctx.generationId,
    conversationId: ctx.conversation.id,
    projectId: ctx.conversation.projectId,
    connectorId: TASK_APPROVAL_CONNECTOR_ID,
    connectorLabel: TASK_TOOL_LABEL,
    toolName: HAND_OFF_TOOL_ID,
    functionName: HAND_OFF_TOOL_ID,
    args: handoffApprovalArgs({
      teammate: target.name,
      title: input.title,
      goal: input.goal,
      estimatedCostMicroUsd: first.estimatedCostMicroUsd,
    }),
    callId: keys.approval,
    provenance: {
      source: "chat_model",
      sourceKind: "agent_handoff",
      derivedFromUntrusted: ctx.untrustedContent,
    },
    signal,
    onApprovalRequest: ctx.onApprovalRequest,
  });
  if (authorization.kind === "refused") {
    if (signal?.aborted) return notHandedOff(handoffRefusal("stopped"));
    return notHandedOff(handoffRefusal(approvalRefusalReason(authorization.reason)));
  }
  // An answer already spent on an earlier attempt at this message, which got
  // no run (a run would have answered `started` above): starting now would
  // reuse a one-time approval.
  if (authorization.kind === "replay") return notHandedOff(handoffRefusal("already_tried"));

  // The consumed receipt sits at `executing` until it is settled, and every
  // way out below settles it.
  const receiptId = authorization.receiptId;
  const settle = async (ok: boolean, result: string) => {
    if (!receiptId) return;
    await approvals.completeExternalAction({ userId: user.id, receiptId, ok, result }).catch(() => undefined);
  };
  if (signal?.aborted) {
    await settle(false, HANDOFF_REFUSALS.stopped);
    return notHandedOff(handoffRefusal("stopped"));
  }

  let replay = false;
  try {
    // Only ever reached after a person said yes to the card, estimate included.
    const second = await agents.startAgentTask(user, target, { ...input, confirmExpensive: true });
    if (second.kind !== "started") {
      const refusal =
        second.kind === "refused" ? handoffRefusalFromResponse(second.status, second.body) : handoffRefusal("internal_error");
      await settle(false, refusal.message);
      return notHandedOff(refusal);
    }
    replay = second.replay;
  } catch (err) {
    // A throw can land after the run was written, and then the work was handed
    // off whatever the error says. The database decides, as it does for a task.
    const run = await prisma.workRun
      .findFirst({ where: { userId: user.id, sessionId: draftId, idempotencyKey: taskKeys.run }, select: { id: true } })
      .catch(() => null);
    if (!run) {
      await settle(false, HANDOFF_REFUSALS.internal_error);
      await agents.discardAgentTaskDraft(user.id, draftId);
      throw err;
    }
    console.error("[chat:handoff] the task started, then a later step failed", {
      conversationId: ctx.conversation.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await settle(true, `Handed off as task ${draftId}.`);

  // Both logs say it, each from its own side. The handoff is not a message in
  // either thread: the task's panel in the teammate's thread is the record.
  await Promise.all([
    agents.recordAgentEvent({
      userId: user.id,
      agentId: ctx.fromAgent.id,
      kind: "handed_off",
      title: `Handed ${args.title} to ${target.name}`,
      detail: { toAgentId: target.id },
      sessionId: draftId,
    }),
    agents.recordAgentEvent({
      userId: user.id,
      agentId: target.id,
      kind: "handoff_received",
      title: `Took ${args.title} from ${ctx.fromAgent.name}`,
      detail: { fromAgentId: ctx.fromAgent.id },
      sessionId: draftId,
    }),
  ]);
  return {
    outcome: { status: "handed_off", teammate: target.name, title: args.title, replay },
    spent: true,
  };
}
