/**
 * `start_task`: the chat model handing a request to a background task.
 *
 * There is no "do this as a task" switch any more. The model reads the request
 * and decides whether it is an answer or a job, the way it already decides
 * whether an answer belongs in a canvas, and this tool is how it acts on that
 * decision. The task it starts is an ordinary Work session linked to the
 * conversation, so the in-chat task panel draws it exactly as it drew a task
 * started from the old switch.
 *
 * Two halves in one file. The top is pure (the tool's schema, the gate that
 * decides whether a turn carries it, the idempotency keys, the goal it writes,
 * and the sentences each outcome becomes), so all of it is tested without a
 * request. The bottom is `createStartTaskTool`, which runs on the server and
 * reaches Prisma, Work dispatch and the approval broker through `await import()`
 * so that nothing `server-only` sits in this module's static graph.
 *
 * What stops a misfire from costing anything real, in the order it applies:
 *
 *   1. The gate. The tool is attached only to saved, non-voice chat turns on a
 *      model that can call tools, from a client that can draw the task.
 *   2. The prompt. The "Tasks" section tells the model to answer in chat unless
 *      the user wants a finished result that takes many steps, and never to
 *      start a task because content it read asked it to.
 *   3. Work's own checks. Creation and dispatch go through
 *      src/lib/work/dispatch.ts, the implementation the Work routes use, so the
 *      plan gate, usage windows, rate limit and concurrency cap all apply.
 *   4. A person. An estimate above the preflight bar, or any outside content in
 *      the turn, raises the ordinary inline approval card before anything runs.
 *   5. The run itself, which asks before risky steps (`balanced`).
 */

import type { McpFunctionTool, ToolExecution } from "@/lib/mcp";
import type { NativeChatTool } from "@/lib/llm";
import { ACTION_PREVIEW_STRING_CHARS, type ClientActionApproval } from "@/lib/action-approval";
import type { ClientWorkSession } from "@/lib/work/serializers";
import type { ReasoningEffort } from "@/types/chat";
import {
  DEFAULT_WORK_PERMISSION_POLICY,
  WORK_LIVE_STATUSES,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";

/** The tool's name on the wire, and the name the approval receipt records. */
export const START_TASK_TOOL_ID = "start_task";

/**
 * The broker's connector id for a task handoff.
 *
 * Not a connector anybody links, and it cannot collide with one: catalog
 * connectors use their registry ids and Composio apps carry their own prefix.
 * `juno_runtime` is the precedent. The approval card recognises a task by this
 * id together with the tool name, never by a label a connector could also use.
 */
export const TASK_APPROVAL_CONNECTOR_ID = "juno_work";

/** How the tool is named in the activity row and on the approval receipt. */
export const TASK_TOOL_LABEL = "Juno";

/** Longest title kept. The schema asks for 60; this leaves room for a model that overshoots a little. */
const MAX_TITLE_CHARS = 80;
/**
 * The most a task's goal holds: what an approval card shows whole
 * (`ACTION_PREVIEW_STRING_CHARS`), well inside `createSessionSchema`'s own
 * bound. When a person is asked first, the card is how they check what the
 * task will be told, and a goal longer than the card would carry text past its
 * cut that nobody read. That tail is exactly where an instruction planted in a
 * page the model read would sit.
 */
export const MAX_TASK_GOAL_CHARS = ACTION_PREVIEW_STRING_CHARS;
/** The user's own words, bounded so the brief keeps most of the goal's room. */
const MAX_REQUEST_CHARS = 2_000;
const MAX_DELIVERABLE_CHARS = 300;
/** `createSessionSchema`'s connector bound. More than that is narrowed, never refused. */
const MAX_TASK_CONNECTORS = 32;

/**
 * The declaration the model sees.
 *
 * Only `type`, `properties`, `description` and `required`: Gemini rejects
 * `additionalProperties`, and length limits are enforced here rather than
 * trusted to a provider's schema support. When to call it is the system
 * prompt's job (`# Tasks` in system-prompt.ts); the description says what it
 * does and what each field is for.
 */
export const START_TASK_TOOL: McpFunctionTool = {
  type: "function",
  function: {
    name: START_TASK_TOOL_ID,
    description:
      "Start a background task that works on the user's request on its own for minutes, then reports back in this conversation. It can research many sources, run code, use the files and connected apps from this message, and produce documents. Use it only for requests that need a finished result built over many steps, as described in the Tasks section of your instructions. It returns whether the task started.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "A short name for the task, at most 60 characters, naming the outcome in sentence case. Example: \"Competitor pricing spreadsheet\".",
        },
        goal: {
          type: "string",
          description:
            "A self-contained brief for the task: what the user wants, every relevant detail from this conversation (names, links, numbers, preferences), constraints, and what done looks like. The task cannot read this conversation, so include everything it needs.",
        },
        deliverable: {
          type: "string",
          description:
            "Optional. What exists when the task is done, in a few words. Example: \"a spreadsheet of 20 vendors with prices\" or \"draft replies in Gmail\".",
        },
      },
      required: ["title", "goal"],
    },
  },
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Everything the chat route knows that decides whether a turn may carry the tool. */
export interface TaskToolGate {
  /** The client said it can draw a task the model starts (`workHandoff`). */
  workHandoff: boolean | undefined;
  privateMode: boolean;
  voiceMode: boolean;
  regenerate: boolean;
  /**
   * The persisted user turn this reply answers. Null on a regenerate and on any
   * path that wrote no user message, and the task's idempotency keys are
   * derived from it, so without one there is nothing to key a task to.
   */
  userMessageId: string | null;
  researchActive: boolean;
  artifactEdit: boolean;
  /** `Conversation.kind`. A workspaceless Code conversation reaches the chat route too. */
  conversationKind: string | null | undefined;
  /** `ModelInfo.agenticTools` of the model answering this turn. */
  agenticTools: boolean;
  /**
   * Whether function tools reach the model on this turn at all. Gemini 2.5 and
   * earlier drop them when search grounding is on, and a prompt describing a
   * tool the model was never given invites it to pretend.
   */
  functionToolsReachModel: boolean;
  /** An applied skill that lists its tools and leaves this one out narrows it away. */
  skillPermits: boolean;
  lockdown: boolean;
  /** The plan includes at least one model that can drive a Work run. */
  planHasWorkModel: boolean;
}

/**
 * Whether this turn carries `start_task`. Every condition has to hold.
 *
 * An opt-in client first, because a native build that predates model-started
 * tasks would start runs it has nowhere to draw. Private and voice turns never:
 * a private turn persists nothing a task could hang off, and a voice reply
 * cannot show a task panel. A regenerate reuses the user message of the answer
 * it replaces, which already had its chance. Research and canvas edits are
 * their own flows with their own output contract.
 */
export function chatTaskToolEnabled(gate: TaskToolGate): boolean {
  return (
    gate.workHandoff === true &&
    !gate.privateMode &&
    !gate.voiceMode &&
    !gate.regenerate &&
    typeof gate.userMessageId === "string" &&
    gate.userMessageId.length > 0 &&
    !gate.researchActive &&
    !gate.artifactEdit &&
    gate.conversationKind === "chat" &&
    gate.agenticTools &&
    gate.functionToolsReachModel &&
    gate.skillPermits &&
    !gate.lockdown &&
    gate.planHasWorkModel
  );
}

// ---------------------------------------------------------------------------
// Keys, arguments and the goal
// ---------------------------------------------------------------------------

export interface TaskIdempotencyKeys {
  /** `createSessionSchema.idempotencyKey`: the session this message may create. */
  session: string;
  /** `startRunSchema.idempotencyKey`: the run that session may start. */
  run: string;
  /** The approval broker's call id, so a resumed generation finds its receipt. */
  approval: string;
}

/**
 * One task per user message, whatever happens to the stream.
 *
 * Keyed on the message rather than the tool call. A model that calls the tool
 * twice in one reply, a provider that retries a round, and a durable first
 * submission resumed after a crash all answer the same message, and each lands
 * on the session and run the first call made instead of starting another.
 */
export function taskIdempotencyKeys(userMessageId: string): TaskIdempotencyKeys {
  return {
    session: `chat-task:${userMessageId}`,
    run: `chat-task-run:${userMessageId}`,
    approval: `chat-task-approval:${userMessageId}`,
  };
}

export interface StartTaskArgs {
  title: string;
  goal: string;
  deliverable: string | null;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Cut at a word boundary where one is close, so a title never ends mid-word. */
function clipTitle(value: string): string {
  if (value.length <= MAX_TITLE_CHARS) return value;
  const cut = value.slice(0, MAX_TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return (space > MAX_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** The model's arguments, trimmed and bounded, or null when the two required fields are not both there. */
export function parseStartTaskArgs(args: Record<string, unknown>): StartTaskArgs | null {
  const title = typeof args.title === "string" ? clipTitle(oneLine(args.title)) : "";
  const goal = typeof args.goal === "string" ? args.goal.trim() : "";
  if (!title || !goal) return null;
  const deliverable = typeof args.deliverable === "string" ? oneLine(args.deliverable) : "";
  return { title, goal, deliverable: deliverable ? clip(deliverable, MAX_DELIVERABLE_CHARS) : null };
}

/**
 * The goal the task is created with.
 *
 * `WorkSession.goal` is documented as the user's own request, and the run reads
 * it as such, so the user's words lead and the model's brief follows. The brief
 * is what carries the conversation's context, which the task cannot see. When
 * the model's brief is just the message again it is not repeated.
 *
 * A skill the message was sent under leads the goal as `/slug`, which is how
 * the Work runner is told to apply a skill (`parseSkillInvocation`), so the task
 * works under the same skill the chat turn did.
 *
 * The whole goal fits `MAX_TASK_GOAL_CHARS`, and the brief is what gives way:
 * the request and the deliverable are bounded first, and the brief takes the
 * room they leave, so a long message never pushes the brief out entirely.
 */
export function composeTaskGoal(input: {
  request: string;
  brief: string;
  deliverable: string | null;
  skillSlug?: string | null;
}): string {
  const request = clip(input.request.trim(), MAX_REQUEST_CHARS);
  const invocation = input.skillSlug ? `/${input.skillSlug} ` : "";
  const assemble = (brief: string) =>
    invocation +
    [
      request ? `Request: ${request}` : "",
      brief ? `Brief: ${brief}` : "",
      input.deliverable ? `Deliverable: ${input.deliverable}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

  let brief = input.brief.trim();
  if (oneLine(brief) === oneLine(request)) brief = "";
  if (brief) {
    // Everything but the brief's own text, measured with a one-character
    // stand-in so the "Brief: " label and its separator are counted.
    const room = MAX_TASK_GOAL_CHARS - (assemble("x").length - 1);
    brief = room > 1 ? clip(brief, room) : "";
  }
  return clip(assemble(brief), MAX_TASK_GOAL_CHARS);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type TaskOutcome =
  | {
      status: "started";
      title: string;
      /** Where it runs, in the dispatch's own words ("Runs in the cloud."). */
      where: string | null;
      /** This message's task already existed; nothing new was started. */
      replay: boolean;
    }
  | { status: "not_started"; reason: string; message: string };

/**
 * The tool's own refusals: the ones no Work route produces.
 *
 * Every other refusal is the route's own sentence, carried through untouched by
 * `taskRefusalFromResponse`, so the model tells the user what the Work page
 * would have told them.
 */
export const TASK_REFUSALS = {
  invalid_arguments: "The task needs a title and a goal. Nothing was started.",
  declined: "The request to start this task was declined, so nothing was started.",
  approval_expired: "The request to start this task expired before it was answered, so nothing was started.",
  approval_blocked: "Your approval settings do not allow starting this task, so nothing was started.",
  approval_failed: "The approval for this task could not be used, so nothing was started.",
  stopped: "The reply was stopped before the task started, so nothing was started.",
  already_tried: "This message already tried to start a task and it did not start. Nothing new was started.",
  internal_error: "Juno could not start the task because of a problem on its side. Nothing was started.",
} as const;

export type TaskRefusalReason = keyof typeof TASK_REFUSALS;

export function taskRefusal(reason: TaskRefusalReason): Extract<TaskOutcome, { status: "not_started" }> {
  return { status: "not_started", reason, message: TASK_REFUSALS[reason] };
}

/**
 * The refusal the model is given for a live task already on this conversation.
 *
 * Separate from the table above because it names the task: "a task is already
 * running" with no name is a sentence the user has to go and look up.
 */
export function taskAlreadyRunning(title: string): Extract<TaskOutcome, { status: "not_started" }> {
  return {
    status: "not_started",
    reason: "task_already_running",
    message: `A task from this conversation is already running: "${title}". Let it finish or stop it before starting another. Nothing new was started.`,
  };
}

const STATUS_REASONS: Record<number, string> = {
  400: "invalid_input",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  503: "unavailable",
};

/**
 * A Work dispatch refusal, as the model is told it.
 *
 * Three body shapes reach here and all three are read rather than guessed at:
 * `{ error: code, message }` for most refusals, `{ error: { code, message } }`
 * for a Mac relay refusal, and a bare `{ error: sentence }` for the rate limit
 * and the 404s. A code-shaped `error` becomes the reason; a sentence-shaped one
 * becomes the message.
 */
export function taskRefusalFromResponse(
  status: number,
  body: Record<string, unknown>
): Extract<TaskOutcome, { status: "not_started" }> {
  const error = body.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const nested = error as { code?: unknown; message?: unknown };
    return {
      status: "not_started",
      reason: typeof nested.code === "string" ? nested.code : STATUS_REASONS[status] ?? "refused",
      message: typeof nested.message === "string" ? nested.message : TASK_REFUSALS.internal_error,
    };
  }
  const code = typeof error === "string" && /^[a-z][a-z0-9_]*$/.test(error) ? error : null;
  const sentence = typeof error === "string" && !code ? error : null;
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : sentence;
  return {
    status: "not_started",
    reason: code ?? STATUS_REASONS[status] ?? "refused",
    message: message ?? TASK_REFUSALS.internal_error,
  };
}

/**
 * One outcome, described twice, the way every tool result is: JSON for the
 * model, and a plain sentence for the thought-process panel.
 *
 * The model's copy repeats the one instruction that matters at that moment,
 * because the tool result is the last thing it reads before it writes: after a
 * start, say so in one sentence and stop; after a refusal, say why and offer
 * what the chat can do instead.
 */
export function describeTaskOutcome(outcome: TaskOutcome): ToolExecution {
  if (outcome.status === "started") {
    return {
      text: JSON.stringify({
        status: "started",
        title: outcome.title,
        ...(outcome.where ? { runs: outcome.where } : {}),
        ...(outcome.replay ? { note: "This message's task was already started. Nothing new was started." } : {}),
        instruction:
          "The task is running in the background and the user can already see its progress card under your reply. Reply with one short sentence saying what you started. Do not do the work yourself, restate a plan or predict the result.",
      }),
      body: outcome.replay ? `Already started "${outcome.title}".` : `Started "${outcome.title}".`,
      ok: true,
    };
  }
  return {
    text: JSON.stringify({
      status: "not_started",
      reason: outcome.reason,
      message: outcome.message,
      instruction:
        "Tell the user in one sentence why the task did not start, then offer what you can do in this chat instead.",
    }),
    body: outcome.message,
    ok: false,
  };
}

/** A cost estimate the way a person reads it: "$0.62", never "$0.6" or "0.62 USD". */
export function formatTaskEstimate(estimatedCostMicroUsd: number): string {
  return `$${(Math.max(0, estimatedCostMicroUsd) / 1_000_000).toFixed(2)}`;
}

/**
 * What the approval receipt binds and the card shows.
 *
 * The goal is the whole goal the task will be created with, not the model's
 * brief alone: a person approving a task started from content Juno read has to
 * see exactly what the task will be told. `composeTaskGoal` keeps it short
 * enough that the card shows it uncut.
 */
export function taskApprovalArgs(input: {
  title: string;
  goal: string;
  estimatedCostMicroUsd: number;
}): Record<string, unknown> {
  return {
    title: input.title,
    estimate: `about ${formatTaskEstimate(input.estimatedCostMicroUsd)}`,
    goal: input.goal,
  };
}

/**
 * Whether an approval is a task handoff. By connector id and tool name
 * together, for the reason `TASK_APPROVAL_CONNECTOR_ID` gives. The approval card
 * repeats this test on the same two literals rather than importing it, because
 * this module's server half must stay out of the client bundle.
 */
export function isTaskApproval(approval: Pick<ClientActionApproval, "connectorId" | "toolName">): boolean {
  return approval.connectorId === TASK_APPROVAL_CONNECTOR_ID && approval.toolName === START_TASK_TOOL_ID;
}

/** The activity row's wording for this tool, before and after it answers. */
export function taskActivityTitle(phase: "call" | "result", ok?: boolean): string {
  if (phase === "call") return "Starting a task";
  return ok ? "Started a task" : "Task not started";
}

/** The task's title out of the raw argument JSON an adapter reports, for the activity row. */
export function taskTitleFromArgs(rawArgs: string | undefined): string | null {
  if (!rawArgs) return null;
  try {
    const parsed = JSON.parse(rawArgs) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parseStartTaskArgs(parsed as Record<string, unknown>)?.title ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The server half
// ---------------------------------------------------------------------------

/**
 * The statuses of a task that is still going. `draft` is left out on purpose: a
 * draft costs nothing, holds no executor and is never drawn in the chat, so it
 * is not a task "already running".
 */
export const LIVE_TASK_STATUSES: readonly string[] = WORK_LIVE_STATUSES.filter((status) => status !== "draft");

export interface StartTaskToolContext {
  user: { id: string; email?: string | null };
  conversation: { id: string; projectId: string | null };
  /** The persisted user turn this reply answers. Every key derives from it. */
  userMessageId: string;
  /** The user's own words this turn, as the transcript shows them. */
  userRequest: string;
  /** The skill this message was sent under, when one applied. */
  skillSlug: string | null;
  /** The conversation's model selection: an explicit id or the Auto sentinel. */
  model: string;
  reasoningEffort: ReasoningEffort | undefined;
  /** This turn's attachments. Earlier turns' files are not granted. */
  attachmentIds: readonly string[];
  /** The connected apps enabled for this message, after workspace narrowing. */
  connectorIds: readonly string[];
  /** Text Juno did not author is in this turn's context. A task then always asks first. */
  untrustedContent: boolean;
  /**
   * The agent whose thread this is, when it is one (docs/design/AGENTS.md).
   * The task is stamped with it, and runs under the autonomy the person gave
   * that agent instead of the default a model-started task otherwise gets —
   * a mode somebody chose on the agent's page is a decision, not a default.
   */
  agent?: { id: string; approvalMode: WorkPermissionPolicy } | null;
  /** The generation id: with the approval call id, the broker's idempotency key. */
  generationId: string;
  onApprovalRequest?: (approval: ClientActionApproval) => void;
  /** Called once per turn, with the session as it stands after its run was dispatched. */
  onStarted?: (session: ClientWorkSession) => void;
}

/**
 * The tool, bound to one turn.
 *
 * Calls are serialised and a started task is remembered, so a second call in
 * the same reply (a model that asks twice, or two calls in one round) answers
 * with the first task rather than racing it. A call refused before anything was
 * created (bad arguments, a task already running) can be made again. One that
 * created a draft and was then refused or declined cannot: its draft is put
 * away, and the retry answers `already_tried` rather than asking the person a
 * second time about the same message.
 */
export function createStartTaskTool(ctx: StartTaskToolContext): NativeChatTool {
  let started: Extract<TaskOutcome, { status: "started" }> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const run = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecution> => {
    if (started) return describeTaskOutcome({ ...started, replay: true });
    let outcome: TaskOutcome;
    try {
      outcome = await startTask(ctx, args, signal);
    } catch (err) {
      console.error("[chat:task] start_task failed", {
        conversationId: ctx.conversation.id,
        error: err instanceof Error ? err.message : String(err),
      });
      outcome = taskRefusal("internal_error");
    }
    if (outcome.status === "started") started = outcome;
    // Logged rather than audited: `WorkAuditKind` is mirrored to the native
    // clients (contracts/work), and a new member would be a contract change.
    console.info("[chat:task] start_task", {
      conversationId: ctx.conversation.id,
      status: outcome.status,
      ...(outcome.status === "not_started" ? { reason: outcome.reason } : {}),
    });
    return describeTaskOutcome(outcome);
  };

  return {
    tool: START_TASK_TOOL,
    label: TASK_TOOL_LABEL,
    access: "write",
    execute(args, signal) {
      const next = queue.then(() => run(args, signal));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

async function startTask(
  ctx: StartTaskToolContext,
  rawArgs: Record<string, unknown>,
  signal?: AbortSignal
): Promise<TaskOutcome> {
  const args = parseStartTaskArgs(rawArgs);
  if (!args) return taskRefusal("invalid_arguments");
  if (signal?.aborted) return taskRefusal("stopped");

  const [{ prisma }, dispatch, protocol, serializers, store] = await Promise.all([
    import("@/lib/prisma"),
    import("@/lib/work/dispatch"),
    import("@/app/api/work/protocol"),
    import("@/lib/work/serializers"),
    import("@/lib/action-approval-store"),
  ]);
  const { user } = ctx;
  const keys = taskIdempotencyKeys(ctx.userMessageId);
  const ownSessionId = dispatch.sessionIdForKey(user, keys.session);

  /*
   * One live task per conversation. The chat follows a single task at a time
   * (use-conversation-work.ts), so a second one would hide the first, and a
   * user who asks for more while a task runs almost always means the running
   * one. This message's own task is excluded so a retry recognises it.
   */
  const live = await prisma.workSession.findFirst({
    where: {
      userId: user.id,
      conversationId: ctx.conversation.id,
      deletedAt: null,
      status: { in: [...LIVE_TASK_STATUSES] },
      id: { not: ownSessionId },
    },
    orderBy: { createdAt: "desc" },
    select: { title: true },
  });
  if (live) return taskAlreadyRunning(live.title);

  // This message already tried and was refused or declined, and its draft was
  // put away then. Asked before the create, which would otherwise replay onto
  // the put-away row and rewrite its file and app grants on the way to the
  // same answer (or answer a failed rewrite with a sentence about saving it).
  const previous = await prisma.workSession.findFirst({
    where: { id: ownSessionId, userId: user.id },
    select: { deletedAt: true },
  });
  if (previous?.deletedAt) return taskRefusal("already_tried");

  // Built through the route's own schema, so the task is bounded exactly like
  // one a person creates.
  const requestedTarget = ctx.agent ? "cloud" : "automatic";
  const createBody = protocol.createSessionSchema.safeParse({
    goal: composeTaskGoal({
      request: ctx.userRequest,
      brief: args.goal,
      deliverable: args.deliverable,
      skillSlug: ctx.skillSlug,
    }),
    title: args.title,
    requestedTarget,
    ...(ctx.conversation.projectId ? { projectId: ctx.conversation.projectId } : {}),
    conversationId: ctx.conversation.id,
    model: ctx.model,
    ...(ctx.reasoningEffort ? { reasoningEffort: ctx.reasoningEffort } : {}),
    // Asks before risky steps. The user never picked a mode for a task the
    // model started, so it gets the default a person composing one gets —
    // unless this is an agent's thread, where they picked one for the agent.
    permissionPolicy: ctx.agent?.approvalMode ?? DEFAULT_WORK_PERMISSION_POLICY,
    attachmentIds: [...new Set(ctx.attachmentIds)],
    connectorIds: [...new Set(ctx.connectorIds)].slice(0, MAX_TASK_CONNECTORS),
    idempotencyKey: keys.session,
  });
  if (!createBody.success) return taskRefusal("invalid_arguments");

  /**
   * Drops the draft this call created when the task did not start. The model
   * says why in the reply, and a draft nobody asked for would otherwise sit in
   * the Work list. Only ever a draft: a session that has a run is never touched.
   */
  const discardDraft = async () => {
    await prisma.workSession
      .updateMany({
        where: { id: ownSessionId, userId: user.id, status: "draft", deletedAt: null },
        data: { deletedAt: new Date() },
      })
      .catch(() => undefined);
  };
  const notStarted = async (outcome: Extract<TaskOutcome, { status: "not_started" }>) => {
    await discardDraft();
    return outcome;
  };

  const created = await dispatch.createWorkSessionForUser(user, createBody.data);
  if (!created.session) return notStarted(taskRefusalFromResponse(created.status, created.body));
  const session = created.session;
  // The same question as `previous` above, for a retry that raced this one.
  if (session.deletedAt) return taskRefusal("already_tried");
  // Stamped before anything runs, so no reader ever sees an agent's task as an
  // anonymous one. Conditional on the column still being empty: a replayed
  // create lands on the session the first call already stamped.
  if (ctx.agent) {
    await prisma.workSession.updateMany({
      where: { id: session.id, userId: user.id, agentId: null },
      data: { agentId: ctx.agent.id },
    });
  }

  /*
   * The approval this start consumed, until it is settled. A consumed receipt
   * sits at `executing`, and every way out of this function below has to move
   * it on, or the approvals list shows a start that never finished either way.
   */
  let receiptId: string | null = null;
  const settleReceipt = async (ok: boolean, result: string) => {
    if (!receiptId) return;
    const id = receiptId;
    receiptId = null;
    await store.completeExternalAction({ userId: user.id, receiptId: id, ok, result }).catch(() => undefined);
  };

  let alreadyStarted = false;
  let where: string | null = null;
  try {
    const runBody = protocol.startRunSchema.parse({
      origin: "manual",
      requestedTarget,
      idempotencyKey: keys.run,
    });

    // The refusals a person could meet before a run is written (plan, usage
    // window, executor, model, the concurrency cap) and the estimate, before
    // anybody is asked anything: a card for a task that would be refused anyway
    // is a question with no right answer.
    const preflight = await dispatch.startWorkRunForUser(user, session, runBody, { preflightOnly: true });
    // This message's run already exists (a retried turn, or a second call), so
    // there is nothing to ask and nothing to start: the task is the one it has.
    alreadyStarted = preflight.run !== null;

    if (!alreadyStarted) {
      const estimate = preflight.preflight;
      if (!estimate || preflight.status >= 400) {
        return notStarted(taskRefusalFromResponse(preflight.status, preflight.body));
      }

      if (ctx.untrustedContent || estimate.requiresConfirmation) {
        const authorization = await store.authorizeExternalAction({
          userId: user.id,
          surface: "chat",
          sessionId: ctx.generationId,
          conversationId: ctx.conversation.id,
          projectId: ctx.conversation.projectId,
          connectorId: TASK_APPROVAL_CONNECTOR_ID,
          connectorLabel: TASK_TOOL_LABEL,
          toolName: START_TASK_TOOL_ID,
          functionName: START_TASK_TOOL_ID,
          args: taskApprovalArgs({
            title: session.title,
            goal: session.goal,
            estimatedCostMicroUsd: estimate.estimatedCostMicroUsd,
          }),
          callId: keys.approval,
          provenance: {
            source: "chat_model",
            sourceKind: "task_handoff",
            derivedFromUntrusted: ctx.untrustedContent,
          },
          signal,
          onApprovalRequest: ctx.onApprovalRequest,
        });
        if (authorization.kind === "refused") {
          if (signal?.aborted) return notStarted(taskRefusal("stopped"));
          return notStarted(taskRefusal(approvalRefusalReason(authorization.reason)));
        }
        // A replayed receipt is an answer already spent on an earlier start of
        // this message. Reaching here, that start has no run (a run would have
        // been found above), so it was refused after the person said yes, and
        // dispatching now would start a task on a one-time approval that is
        // already used.
        if (authorization.kind === "replay") return notStarted(taskRefusal("already_tried"));
        receiptId = authorization.receiptId;
      }

      if (signal?.aborted) {
        await settleReceipt(false, TASK_REFUSALS.stopped);
        return notStarted(taskRefusal("stopped"));
      }

      const dispatched = await dispatch.startWorkRunForUser(user, session, {
        ...runBody,
        // Only ever reached after a person said yes to the estimate on the card.
        ...(estimate.requiresConfirmation ? { confirmExpensive: true } : {}),
      });
      const refusal = dispatched.run ? null : taskRefusalFromResponse(dispatched.status, dispatched.body);
      await settleReceipt(refusal === null, refusal ? refusal.message : `Started task ${session.id}.`);
      if (refusal) return notStarted(refusal);
      const selection = dispatched.body.selection as { explanation?: unknown } | undefined;
      where = typeof selection?.explanation === "string" ? selection.explanation : null;
    }
  } catch (err) {
    /*
     * A throw can land after the run was written: recording its inputs is the
     * step after the create. Whether the task started is then a fact in the
     * database, not in the error, and telling the model "nothing was started"
     * about a run that is spending would be the one wrong answer here.
     */
    const run = await prisma.workRun
      .findFirst({ where: { userId: user.id, sessionId: session.id, idempotencyKey: keys.run }, select: { id: true } })
      .catch(() => null);
    if (!run) {
      await settleReceipt(false, TASK_REFUSALS.internal_error);
      await discardDraft();
      throw err;
    }
    await settleReceipt(true, `Started task ${session.id}.`);
    console.error("[chat:task] the task started, then a later step failed", {
      conversationId: ctx.conversation.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Read back after dispatch, so the client adopts the session as queued rather
  // than as the draft `createWorkSession` returned. Only a row that has left
  // `draft` is announced; otherwise the discovery poll finds it a moment later.
  const current = await prisma.workSession
    .findFirst({ where: { id: session.id, userId: user.id } })
    .catch(() => null);
  if (current && current.status !== "draft") ctx.onStarted?.(serializers.serializeSession(current));
  return { status: "started", title: current?.title ?? session.title, where, replay: alreadyStarted };
}

/**
 * Which of the tool's own refusals a broker refusal is.
 *
 * The broker answers with a sentence rather than a code (`Action denied.`,
 * `Action expired.`, a blocked reason), so it is read for the three outcomes a
 * person can tell apart. Anything else is the approval not going through for a
 * reason on Juno's side, which the model should not dress up as the user's
 * choice.
 */
export function approvalRefusalReason(brokerReason: string): TaskRefusalReason {
  const reason = brokerReason.toLowerCase();
  if (reason.includes("denied")) return "declined";
  if (reason.includes("expired")) return "approval_expired";
  if (reason.includes("blocked")) return "approval_blocked";
  return "approval_failed";
}
