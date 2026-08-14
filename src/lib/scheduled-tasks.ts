import { Prisma, type Plan, type ScheduledTask, type ScheduledTaskRun } from "@prisma/client";
import { computeNextRunAt } from "@/lib/scheduled-task-cadence";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { getUserPlan } from "@/lib/usage";
import { PLANS, canUseModel } from "@/lib/plans";
import { getModel, isModelId, resolveModel, MODEL_LIST, type ModelInfo } from "@/lib/models";
import { isProviderConfigured, PROVIDERS } from "@/lib/providers";
import { streamChat, providerErrorMessage } from "@/lib/llm";
import { encryptMessageText } from "@/lib/message-crypto";
import {
  checkBudget,
  recordSpend,
  budgetExceededMessage,
  modelRequestCost,
  modelRatesMicroUsdPerToken,
} from "@/lib/spend";
import { estimateGenerationCostUsd } from "@/lib/pricing";
import type { ClientSource } from "@/types/chat";
import type { MessageForModel } from "@/types/llm";

/*
 * Scheduled tasks — "Juno runs a prompt for you on a schedule, results land in
 * a task thread." Two halves:
 *
 *   computeNextRunAt  pure cadence math in the task's IANA timezone, shared by
 *                     the API routes (initial/recomputed schedules) and the
 *                     worker (post-run advance + claim bump).
 *   executeTask       one full run: budget gate → model call (same streamChat
 *                     path as the chat route, stream collected instead of
 *                     forwarded) → encrypted messages in the results thread →
 *                     spend ledger → ScheduledTaskRun row → schedule advance.
 *
 * Like message-crypto.ts this module carries no "server-only" guard of its own
 * (its import chain does): the worker (scripts/scheduled-task-runner.ts) loads
 * it from plain Node under NODE_OPTIONS=--conditions=react-server, the same
 * arrangement the crypto:rotate script uses.
 */

// ---------------------------------------------------------------------------
// Plan policy
// ---------------------------------------------------------------------------

/** How many scheduled tasks a plan may keep. FREE gets the locked upsell. */
export function taskLimitForPlan(plan: Plan): number {
  if (plan === "FREE") return 0;
  if (plan === "PRO") return 3;
  return 10; // MAX and above (incl. OWNER)
}

// ---------------------------------------------------------------------------
// Cadence math (pure — lives in scheduled-task-cadence.ts, re-exported here so
// routes and the worker keep a single import site for the whole feature)
// ---------------------------------------------------------------------------

export {
  DEFAULT_TASK_TIMEZONE,
  computeNextRunAt,
  isValidTimezone,
  onceRunInstant,
} from "@/lib/scheduled-task-cadence";
export type { TaskScheduleInput } from "@/lib/scheduled-task-cadence";

// ---------------------------------------------------------------------------
// API serialization (shared by /api/tasks and /api/tasks/[id])
// ---------------------------------------------------------------------------

export type TaskWithLatestRun = ScheduledTask & { runs: ScheduledTaskRun[] };

export function serializeTask(task: TaskWithLatestRun) {
  const run = task.runs[0] ?? null;
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    model: task.model,
    modelName: resolveModel(task.model)?.name ?? task.model,
    cadence: task.cadence,
    hour: task.hour,
    minute: task.minute,
    weekday: task.weekday,
    monthday: task.monthday,
    onDate: task.onDate,
    timezone: task.timezone,
    webSearch: task.webSearch,
    enabled: task.enabled,
    lastRunAt: task.lastRunAt?.toISOString() ?? null,
    nextRunAt: task.nextRunAt.toISOString(),
    conversationId: task.conversationId,
    createdAt: task.createdAt.toISOString(),
    latestRun: run
      ? {
          id: run.id,
          status: run.status,
          error: run.error,
          costMicroUsd: run.costMicroUsd,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/** Prisma include that pairs each task with its most recent run. */
export const LATEST_RUN_INCLUDE = {
  runs: { orderBy: { startedAt: "desc" as const }, take: 1 },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

// Safety ceiling per run — a hung provider stream must never wedge the worker.
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

export interface TaskRunOutcome {
  status: "done" | "error" | "budget";
  error?: string;
  costMicroUsd?: number;
}

/** Plan-aware model resolution, mirroring the chat route's fallback chain. */
function resolveTaskModel(taskModel: string, plan: Plan): ModelInfo | undefined {
  let model = isModelId(taskModel) ? getModel(taskModel) : undefined;
  if (
    !model ||
    model.comingSoon ||
    model.modality !== "chat" ||
    !isProviderConfigured(model.provider) ||
    !canUseModel(plan, model.id)
  ) {
    model = MODEL_LIST.find(
      (m) => m.modality === "chat" && !m.comingSoon && isProviderConfigured(m.provider) && canUseModel(plan, m.id)
    );
  }
  return model;
}

/**
 * Run one scheduled task end to end. Always advances lastRunAt/nextRunAt —
 * success, provider error, or budget skip — so a broken run can never wedge a
 * task into a re-run loop. Callers (the worker) own claiming/serialization.
 */
export async function executeTask(taskId: string): Promise<TaskRunOutcome> {
  // Unguarded by design: the worker calls this with a task id it claimed from a
  // cross-user scan, so this row IS what establishes the owner. Every query
  // after it scopes to task.userId.
  const task = await prismaUnguarded.scheduledTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`Scheduled task ${taskId} not found.`);

  const now = new Date();
  const nextRunAt = computeNextRunAt(task, now);
  const advance = (conversationId?: string) =>
    prisma.scheduledTask.update({
      where: { id: task.id, userId: task.userId },
      data: {
        lastRunAt: now,
        nextRunAt,
        // A one-off completes on its first attempt — success, provider error,
        // or budget skip alike — mirroring the recurring policy that a broken
        // run advances rather than loops. The run row says how it went.
        ...(task.cadence === "ONCE" ? { enabled: false } : {}),
        ...(conversationId ? { conversationId } : {}),
      },
    });
  const failRun = async (runId: string | null, error: string, status: "error" | "budget" = "error") => {
    if (runId) {
      await prisma.scheduledTaskRun.update({
        where: { id: runId },
        data: { status, error, finishedAt: new Date() },
      });
    } else {
      await prisma.scheduledTaskRun.create({
        data: { taskId: task.id, status, error, finishedAt: new Date() },
      });
    }
  };

  const plan = await getUserPlan(task.userId);

  // Tasks live under the same money meter as chat: over budget → skip the run
  // entirely (recorded as a "budget" run so the card explains the silence).
  const budget = await checkBudget(task.userId, plan);
  if (!budget.allowed) {
    await failRun(null, budgetExceededMessage(plan, budget.resetsAtMs), "budget");
    await advance();
    return { status: "budget" };
  }

  const model = resolveTaskModel(task.model, plan);
  if (!model) {
    const error = "No AI model is available for this plan and the configured providers.";
    await failRun(null, error);
    await advance();
    return { status: "error", error };
  }

  // Results thread, created lazily — and only once a result exists, so a
  // failed first run never leaves an empty chat in the sidebar. Title = task
  // name, so it reads like any other conversation. Recreated if deleted.
  const ensureConversation = async (): Promise<string> => {
    if (task.conversationId) {
      const existing = await prisma.conversation.findFirst({
        where: { id: task.conversationId, userId: task.userId },
        select: { id: true },
      });
      if (existing) return existing.id;
    }
    const conversation = await prisma.conversation.create({
      data: { userId: task.userId, title: task.name, titleSource: "manual", model: model.id },
    });
    return conversation.id;
  };

  const run = await prisma.scheduledTaskRun.create({ data: { taskId: task.id, status: "running" } });

  const today = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const system = `You are running the scheduled task "${task.name}". Today is ${today}. Produce the result directly.`;
  const history: MessageForModel[] = [{ role: "USER", content: task.prompt, attachments: [] }];
  // Web search rides the same native-provider path as chat; models/plans
  // without it silently run without (no error, no warning — it's a schedule).
  const useWebSearch = task.webSearch && PLANS[plan].webSearch && model.webSearch;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);

  let full = "";
  let reasoning = "";
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let totalTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let cacheWrite5mTokens: number | undefined;
  let cacheWrite1hTokens: number | undefined;
  let webSearchRequests: number | undefined;
  let xSearchRequests: number | undefined;
  const sources: ClientSource[] = [];
  const sourceUrls = new Set<string>();

  // Hard mid-stream budget ceiling, same projection as the chat route: abort
  // the provider stream the instant this run would overshoot the plan budget.
  const rates = modelRatesMicroUsdPerToken(model.id);
  const ceilingMicro = budget.remainingMicroUsd;
  let budgetHalted = false;
  const enforceStreamBudget = () => {
    if (ceilingMicro == null || budgetHalted) return;
    const inTok = promptTokens ?? Math.ceil((system.length + task.prompt.length) / 4);
    const outTok = completionTokens ?? Math.ceil((full.length + reasoning.length) / 4);
    if (inTok * rates.input + outTok * rates.output >= ceilingMicro) {
      budgetHalted = true;
      controller.abort();
    }
  };

  try {
    for await (const ev of streamChat({
      model,
      system,
      history,
      maxTokens: PLANS[plan].maxOutputTokens,
      signal: controller.signal,
      webSearch: useWebSearch,
      // One task = one stable prompt prefix (its system line + prompt).
      cacheKey: task.id,
    })) {
      if (ev.type === "text") {
        full += ev.text;
        enforceStreamBudget();
      } else if (ev.type === "reasoning") {
        reasoning += ev.text;
        enforceStreamBudget();
      } else if (ev.type === "sources") {
        for (const source of ev.sources) {
          if (!source.url || sourceUrls.has(source.url)) continue;
          sourceUrls.add(source.url);
          sources.push(source);
        }
      } else if (ev.type === "usage") {
        if (ev.input != null) promptTokens = ev.input;
        if (ev.output != null) completionTokens = ev.output;
        if (ev.reasoning != null) reasoningTokens = ev.reasoning;
        if (ev.total != null) totalTokens = ev.total;
        if (ev.cacheRead != null) cacheReadTokens = ev.cacheRead;
        if (ev.cacheWrite != null) cacheWriteTokens = ev.cacheWrite;
        if (ev.cacheWrite5m != null) cacheWrite5mTokens = ev.cacheWrite5m;
        if (ev.cacheWrite1h != null) cacheWrite1hTokens = ev.cacheWrite1h;
        if (ev.webSearchRequests != null) webSearchRequests = ev.webSearchRequests;
        if (ev.xSearchRequests != null) xSearchRequests = ev.xSearchRequests;
        enforceStreamBudget();
      }
    }
  } catch (err) {
    clearTimeout(timeout);
    // A budget halt with partial text is kept and billed (like a chat stop);
    // anything else — or a halt before any output — fails the run.
    if (!(budgetHalted && full.trim())) {
      const error = budgetHalted
        ? budgetExceededMessage(plan, budget.resetsAtMs)
        : providerErrorMessage(err, PROVIDERS[model.provider].label);
      await failRun(run.id, error, budgetHalted ? "budget" : "error");
      await advance();
      return { status: budgetHalted ? "budget" : "error", error };
    }
  } finally {
    clearTimeout(timeout);
  }

  if (!full.trim()) {
    const error = "The model returned an empty result.";
    await failRun(run.id, error);
    await advance();
    return { status: "error", error };
  }

  // Reconcile usage across providers and estimate the run's cost once
  // (same pipeline as chat: tokens + cache TTL rates + server-tool fees).
  const billed = estimateGenerationCostUsd(model, {
    promptTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    cacheWrite5m: cacheWrite5mTokens,
    cacheWrite1h: cacheWrite1hTokens,
    webSearchRequests,
    xSearchRequests,
    promptChars: system.length + task.prompt.length,
    completionChars: full.length,
    reasoningChars: reasoning.length,
  });
  const costUsd = billed.costUsd;
  const costMicroUsd =
    costUsd > 0
      ? Math.round(costUsd * 1_000_000)
      : modelRequestCost({
          modelId: model.id,
          promptTokens: billed.promptTokens || Math.ceil((system.length + task.prompt.length) / 4),
          completionTokens: billed.completionTokens || Math.ceil((full.length + reasoning.length) / 4),
        });

  // One exchange per run — prompt then result — encrypted like every chat write.
  const conversationId = await ensureConversation();
  await prisma.message.create({
    data: { conversationId, role: "USER", content: encryptMessageText(task.prompt) },
  });
  const assistant = await prisma.message.create({
    data: {
      conversationId,
      role: "ASSISTANT",
      content: encryptMessageText(full),
      ...(reasoning ? { reasoning: encryptMessageText(reasoning) } : {}),
      model: model.id,
      promptTokens: billed.promptTokens || null,
      completionTokens: billed.completionTokens || null,
      ...(sources.length ? { sources: sources as unknown as Prisma.InputJsonValue } : {}),
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId, userId: task.userId },
    data: { lastMessageAt: new Date(), model: model.id },
  });

  await recordSpend({
    userId: task.userId,
    model: model.id,
    kind: "task",
    promptTokens: billed.promptTokens || undefined,
    completionTokens: billed.completionTokens || undefined,
    reasoningTokens: reasoningTokens || undefined,
    totalTokens: totalTokens || undefined,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    cacheWrite5m: cacheWrite5mTokens,
    cacheWrite1h: cacheWrite1hTokens,
    webSearchRequests,
    xSearchRequests,
    costUsd: costUsd || undefined,
    promptChars: system.length + task.prompt.length,
    completionChars: full.length,
    reasoningChars: reasoning.length,
  });

  await prisma.scheduledTaskRun.update({
    where: { id: run.id },
    data: { status: "done", messageId: assistant.id, costMicroUsd, finishedAt: new Date() },
  });
  await advance(conversationId !== task.conversationId ? conversationId : undefined);
  return { status: "done", costMicroUsd };
}
