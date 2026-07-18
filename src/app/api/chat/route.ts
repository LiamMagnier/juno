import { NextResponse, after } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan, consumeMessage, refundMessage } from "@/lib/usage";
import { canUseModel, PLANS } from "@/lib/plans";
import { isModelId, getModel, DEFAULT_MODEL, MODEL_LIST, type ModelInfo } from "@/lib/models";
import { isProviderConfigured, configuredProviders, PROVIDERS } from "@/lib/providers";
import { isOwnerEmail } from "@/lib/owner";
import { buildSystemPrompt, buildDynamicContext } from "@/lib/anthropic";
import { finishReasonDetail, finishReasonTitle } from "@/lib/finish-reason";
import { registerGeneration, wasGenerationStopped } from "@/lib/generation-cancel";
import { streamChat, providerErrorMessage } from "@/lib/llm";
import { getMemoryProfile, saveAutoMemories, extractConversationMemory, maybeConsolidate, utilityModelCandidates } from "@/lib/memory";
import { persistArtifacts } from "@/lib/artifacts-store";
import { parseArtifacts, parseMemories } from "@/lib/message-content";
import {
  formatClarificationModelMessage,
  formatClarificationVisibleMessage,
  markClarificationWizardSubmitted,
} from "@/lib/clarification-wizard";
import {
  formatPreflightClarificationModelMessage,
  formatPreflightClarificationVisibleMessage,
} from "@/lib/preflight-clarification";
import { serializeMessage } from "@/lib/serializers";
import { appendReasoningDelta } from "@/lib/reasoning-parts";
import { encryptMessageText, decryptMessageText } from "@/lib/message-crypto";
import { checkBudget, recordSpend, budgetExceededMessage, modelRatesMicroUsdPerToken } from "@/lib/spend";
import { runDeepResearch } from "@/lib/deep-research";
import { isWebSearchConfigured } from "@/lib/web-search";
import { encodeChunk, SSE_HEADERS } from "@/lib/chat-stream";
import { truncate, formatUsd, currentPeriod } from "@/lib/utils";
import { coerceTitleSource } from "@/lib/title-ownership";
import { DEFAULT_PERSONALITY } from "@/lib/personalities";
import { normalizeUsage, estimateCostUsd, supportsFastMode } from "@/lib/pricing";
import { clampReasoningEffort, REASONING_TIERS } from "@/lib/model-metrics";
import { MAX_ATTACHMENTS } from "@/lib/uploads";
import { getActiveConnectors } from "@/lib/mcp";
import { quickScreen, moderateUserMessages } from "@/lib/moderation-ai";
import { recordFlag } from "@/lib/moderation";
import { effectiveModerationTexts, moderationMessagePreview } from "@/lib/chat-moderation";
import {
  classifyFirstSubmissionRecovery,
  classifyReceiptlessFirstSubmission,
  FIRST_SUBMISSION_RECEIPT_HEARTBEAT_MS,
  firstSubmissionLeaseHeartbeatOwnsReceipt,
  firstSubmissionLeaseExpiresAt,
  hashFirstSubmission,
  type FirstSubmissionRecovery,
} from "@/lib/chat-first-submission";
import { findFirstSubmissionReceipt } from "@/lib/chat-first-submission-receipt";
import {
  chatOriginSchema,
  clientIdempotencyKeySchema,
  clientSubmissionMetadataIssue,
  legacyChatClientForOrigin,
} from "@/lib/chat-origin";
import type { StreamChunk, ClientSource, ClientActivityEvent, ChatFinishReason, ReasoningEffort } from "@/types/chat";
import type { MessageForModel } from "@/types/llm";

export const runtime = "nodejs";
// Self-hosted (a plain `next start` Node process on the VM) has NO per-request
// function timeout — the generation runs until the model finishes thinking.
// `maxDuration` is a Vercel-only directive that `next start` ignores, so we no
// longer set it: that is what removes the old 300s wall. The only remaining
// ceiling is nginx's proxy_read_timeout (3600s in deploy/nginx.conf.template),
// which the 15s SSE heartbeat below keeps resetting so it effectively never
// fires. Keep RECOVERY_WINDOW_MS in use-chat.ts in sync with that nginx value.

const HISTORY_LIMIT = 24;
// When a conversation outgrows HISTORY_LIMIT, drop the oldest messages in
// blocks of this size instead of one per turn. A per-turn sliding window
// changes the prompt prefix on every request, which defeats provider-side
// implicit prompt caching (Zhipu/DeepSeek/Moonshot/OpenAI all cache on
// stable prefixes) — chunked truncation keeps the prefix byte-identical for
// HISTORY_STEP consecutive turns at the cost of a slightly larger window.
const HISTORY_STEP = 8;

const WEB_SEARCH_NUDGE =
  "Web search is ENABLED for this message. You have a live web search tool that returns current, real-world results with citations — use it to answer with up-to-date information and cite your sources. Do NOT claim you lack internet access, real-time data, or the ability to browse; you can search right now.";

const SELECTION_ANCHOR_NUDGE =
  'Selection anchors: when a user message contains a [Selection from artifact "…"] block, treat the quoted text or element as a precise anchor into that artifact. For a modify request, change ONLY that region, keep the rest of the artifact byte-identical where possible, and re-emit the COMPLETE artifact under the same identifier. For a question about the selection, answer directly and do not re-emit the artifact unless asked.';

const clarificationAnswerValueSchema = z.union([z.string().max(1000), z.array(z.string().max(500)).max(12), z.boolean()]);
const clarificationAnswerSchema = z.object({
  id: z.string().trim().min(1).max(80),
  question: z.string().trim().max(500).optional(),
  value: clarificationAnswerValueSchema.optional(),
  skipped: z.boolean().optional(),
});
const clarificationSchema = z.object({
  messageId: z.string().cuid(),
  blockId: z.string().trim().min(3).max(120),
  originalUserMessage: z.string().max(50_000),
  answers: z.array(clarificationAnswerSchema).max(10),
  skippedQuestions: z.array(z.string().trim().max(500)).max(10),
});
const preflightClarificationAnswerSchema = z.object({
  questionId: z.string().trim().min(1).max(80),
  question: z.string().trim().max(500).optional(),
  source: z.enum(["option", "else", "skip"]),
  value: clarificationAnswerValueSchema.optional(),
});
const preflightClarificationSchema = z.object({
  originalUserMessage: z.string().max(50_000),
  answers: z.array(preflightClarificationAnswerSchema).max(10),
  skipped: z.boolean().optional(),
});

const bodySchema = z
  .object({
    conversationId: z.string().cuid().optional(),
    projectId: z.string().cuid().optional(),
    message: z.string().max(50_000).optional(),
    clarification: clarificationSchema.optional(),
    preflightClarification: preflightClarificationSchema.optional(),
    attachmentIds: z.array(z.string().cuid()).max(MAX_ATTACHMENTS).optional(),
    model: z.string().optional(),
    regenerate: z.boolean().optional(),
    voiceMode: z.boolean().optional(),
    canvasEnabled: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    // Premium "fast mode" (Anthropic speed:"fast" / OpenAI service_tier:
    // "priority"). Honored only on models that support it (supportsFastMode).
    fastMode: z.boolean().optional(),
    // Durable creation metadata used by native clients and Juno Quick. The
    // legacy `client` field below remains for spend-ledger compatibility.
    origin: chatOriginSchema.optional(),
    // These keys are paired intentionally: the request key deduplicates a new
    // conversation while the message key deduplicates its first persisted turn.
    clientRequestId: clientIdempotencyKeySchema.optional(),
    clientMessageId: clientIdempotencyKeySchema.optional(),
    // Deep research mode: plan → search → read → cited report (saved chats only;
    // ignored in private mode, where the toggle is hidden client-side).
    deepResearch: z.boolean().optional(),
    // Built from REASONING_TIERS, never repeated literals: this enum listed only
    // low|medium|high|max while reasoningOptions() advertised "minimal" (gpt-5,
    // gpt-5-mini, the Gemini flash line, glm-5.2) and "xhigh" (every GPT-5.2+,
    // every Claude Opus 4.7+/Sonnet, grok multi-agent, glm-5.2) — 26 models whose
    // top tier 400'd here, inside Juno, before any provider was called. Per-model
    // support is NOT this schema's job; it is enforced by effectiveReasoningEffort
    // -> clampReasoningEffort below, which coerces to what the model accepts.
    reasoningEffort: z.enum(REASONING_TIERS).optional(),
    connectors: z.array(z.string()).max(5).optional(),
    generationId: z.string().trim().min(8).max(120).optional(),
    privateMode: z.boolean().optional(),
    // Which surface sent the request — tags the spend ledger so admin can split
    // website vs native-app spending. Defaults to "web".
    client: z.enum(["web", "app"]).optional(),
    privateHistory: z
      .array(
        z.object({
          role: z.enum(["USER", "ASSISTANT"]),
          content: z.string().max(50_000),
        })
      )
      .max(HISTORY_LIMIT)
      .optional(),
  })
  .superRefine((input, ctx) => {
    const issue = clientSubmissionMetadataIssue({
      origin: input.origin,
      conversationId: input.conversationId,
      regenerate: input.regenerate,
      privateMode: input.privateMode,
      clarificationReply: input.clarification !== undefined,
      clientRequestId: input.clientRequestId,
      clientMessageId: input.clientMessageId,
    });
    if (issue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [issue.path],
        message: issue.message,
      });
    }
  });

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Normalize a generation's token usage and build the "Token usage recorded"
 * detail line + an estimated cost. `totalInput` reconciles per-provider
 * conventions (Anthropic input excludes cache; OpenAI prompt_tokens includes it)
 * so the displayed numbers mean the same thing everywhere.
 */
function buildUsage(
  model: ModelInfo,
  raw: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  fastMode = false
): { detail: string; cost: number; totalInput: number; output: number } {
  const n = normalizeUsage(model.provider, raw);
  const cost = estimateCostUsd(model, raw, fastMode);
  const cached = n.cacheRead + n.cacheWrite;
  const detail = [
    n.totalInput ? `${n.totalInput.toLocaleString()} input${cached ? ` (${cached.toLocaleString()} cached)` : ""}` : null,
    n.output ? `${n.output.toLocaleString()} output` : null,
    cost > 0 ? `~${formatUsd(cost)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { detail, cost, totalInput: n.totalInput, output: n.output };
}

function searchToolLabel(provider: ModelInfo["provider"]) {
  if (provider === "anthropic") return "Claude web search";
  if (provider === "google") return "Google Search grounding";
  if (provider === "xai") return "Grok Live Search";
  return "native web search";
}

function sourceHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function effectiveReasoningEffort(model: ModelInfo, requested?: ReasoningEffort): ReasoningEffort | undefined {
  // Coerce to a tier the model actually supports (e.g. "max" -> "high" on Gemini),
  // so we never send an unsupported effort to the provider.
  return clampReasoningEffort(model, requested ?? null) ?? undefined;
}

function isAbortLike(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string };
  return e?.name === "AbortError" || e?.code === "ABORT_ERR" || /aborted|aborterror|cancelled|canceled/i.test(e?.message ?? "");
}

function classifyErrorFinishReason(err: unknown): ChatFinishReason {
  if (isAbortLike(err)) return "user_stopped";
  const message = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
  if (/network|socket|econn|etimedout|timeout|terminated|fetch failed|connection/i.test(message)) return "network_error";
  if (/context.*(length|window)|maximum context|context_length_exceeded/i.test(message)) return "model_context_window_exceeded";
  if (/sensitive|safety|content.?filter/i.test(message)) return "sensitive";
  return "error";
}

function generationFailureCode(reason: ChatFinishReason): string {
  switch (reason) {
    case "user_stopped":
      return "GENERATION_STOPPED_BEFORE_OUTPUT";
    case "network_error":
      return "GENERATION_NETWORK_ERROR";
    case "model_context_window_exceeded":
      return "GENERATION_CONTEXT_LIMIT";
    case "sensitive":
      return "GENERATION_SENSITIVE_CONTENT";
    default:
      return "GENERATION_FAILED";
  }
}

function appendFinishWarning(
  reason: ChatFinishReason,
  sendActivity: (event: Omit<ClientActivityEvent, "id" | "createdAt">) => ClientActivityEvent
) {
  if (reason === "stop") return;
  sendActivity({
    kind: "warning",
    title: finishReasonTitle(reason),
    detail: finishReasonDetail(reason),
  });
}

function alreadySubmittedResponse(input: {
  conversationId: string;
  userMessageId: string;
  generationId: string;
  receiptState: "accepted" | "running" | "completed" | "failed";
  finishReason: string | null;
  failureCode: string | null;
}) {
  return NextResponse.json(
    {
      error: "request_already_submitted",
      code: "REQUEST_ALREADY_SUBMITTED",
      message: "This message was already accepted. Open the existing conversation instead of submitting it again.",
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
      generationId: input.generationId,
      receiptState: input.receiptState,
      finishReason: input.finishReason,
      failureCode: input.failureCode,
      retryable: false,
    },
    { status: 409 }
  );
}

function firstSubmissionInProgressResponse(input: { generationId: string }) {
  return NextResponse.json(
    {
      error: "request_in_progress",
      code: "REQUEST_IN_PROGRESS",
      message: "This first submission is still being accepted. Retry with the same identifiers.",
      generationId: input.generationId,
      receiptState: "claimed",
      retryable: true,
    },
    { status: 409 }
  );
}

function firstSubmissionRecoveryResponse(recovery: FirstSubmissionRecovery) {
  if (recovery.kind === "conflict") return idempotencyKeyConflictResponse(recovery.conversationId);
  if (recovery.kind === "in_progress") {
    return firstSubmissionInProgressResponse({ generationId: recovery.generationId });
  }
  return alreadySubmittedResponse({
    conversationId: recovery.conversationId,
    userMessageId: recovery.userMessageId,
    generationId: recovery.generationId,
    receiptState: recovery.state,
    finishReason: recovery.finishReason,
    failureCode: recovery.failureCode,
  });
}

function idempotencyKeyConflictResponse(conversationId: string, legacyReceiptMissing = false) {
  return NextResponse.json(
    {
      error: "idempotency_key_reused",
      code: "IDEMPOTENCY_KEY_REUSED",
      message: legacyReceiptMissing
        ? "This request predates durable body receipts, so the server cannot prove that the retry body is identical. Use a new submission identifier."
        : "This idempotency key is already bound to a different first submission.",
      conversationId,
      retryable: false,
    },
    { status: 409 }
  );
}

class AttachmentClaimError extends Error {
  constructor() {
    super("One or more attachments are unavailable or already belong to another message.");
    this.name = "AttachmentClaimError";
  }
}

class DurableFirstSubmissionStartError extends Error {
  readonly generationId: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly failureCode = "GENERATION_START_FAILED";

  constructor(
    cause: unknown,
    ids: { generationId: string; conversationId: string; userMessageId: string }
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DurableFirstSubmissionStartError";
    this.generationId = ids.generationId;
    this.conversationId = ids.conversationId;
    this.userMessageId = ids.userMessageId;
    this.cause = cause;
  }
}

class DurableReceiptLeaseLostError extends Error {
  constructor() {
    super("The durable generation lease is no longer owned by this process.");
    this.name = "DurableReceiptLeaseLostError";
  }
}

async function handleChat(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Parse the body once. Valid durable retries are recovered below before rate
  // limiting; invalid/legacy requests preserve the historical rate-limit order.
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  let firstSubmissionHash: string | null = null;
  let legacyOrphanConversationId: string | null = null;
  if (parsed.success && parsed.data.clientRequestId && parsed.data.clientMessageId) {
    const durableInput = parsed.data;
    const clientRequestId = durableInput.clientRequestId!;
    const clientMessageId = durableInput.clientMessageId!;
    firstSubmissionHash = hashFirstSubmission(durableInput);
    const existingReceipt = await findFirstSubmissionReceipt(user.id, { clientRequestId });
    if (existingReceipt) {
      return firstSubmissionRecoveryResponse(
        classifyFirstSubmissionRecovery(existingReceipt, clientMessageId, firstSubmissionHash)
      );
    }
    const reusedMessageKey = await prisma.chatFirstSubmissionReceipt.findUnique({
      where: {
        userId_clientMessageId: {
          userId: user.id,
          clientMessageId,
        },
      },
      select: { conversationId: true },
    });
    if (reusedMessageKey) return idempotencyKeyConflictResponse(reusedMessageKey.conversationId);

    // Compatibility for a narrow rollout window where Conversation/Message
    // keys were written before durable receipts existed. Completed rows are
    // adopted into the ledger before rate limiting; a conversation with no
    // first message is finished later by the atomic acceptance transaction.
    const legacyConversation = await prisma.conversation.findFirst({
      where: { userId: user.id, clientRequestId },
      select: { id: true },
    });
    if (legacyConversation) {
      const firstMessage = await prisma.message.findFirst({
        where: { conversationId: legacyConversation.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, clientId: true },
      });
      if (classifyReceiptlessFirstSubmission(firstMessage) === "ambiguous") {
        return idempotencyKeyConflictResponse(legacyConversation.id, true);
      }
      legacyOrphanConversationId = legacyConversation.id;
    }
  }

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `chat:${user.id}`, limit: 30, windowSec: 60 });
    if (!limit.success) {
      return NextResponse.json({ error: "You're sending messages too quickly. Please slow down." }, { status: 429 });
    }
  }

  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const input = parsed.data;
  const legacyClient = legacyChatClientForOrigin(input);

  // Uploads use the persistent account attachment store. Until an explicitly
  // ephemeral upload path exists, accepting them in private mode would make the
  // no-history promise misleading even though the chat branch ignores the IDs.
  if (input.privateMode && (input.attachmentIds?.length ?? 0) > 0) {
    return NextResponse.json(
      {
        error: "private_attachments_unsupported",
        code: "PRIVATE_ATTACHMENTS_UNSUPPORTED",
        message: "Attachments are not available in private chat.",
      },
      { status: 400 }
    );
  }

  if (!input.regenerate && !input.message?.trim() && !input.clarification && (input.attachmentIds?.length ?? 0) === 0) {
    return NextResponse.json({ error: "Message cannot be empty." }, { status: 400 });
  }

  // Build private model history once, before moderation, so the policy screen
  // sees the exact user turns the provider will receive (including preflight
  // clarification content replacing the last private user turn).
  const privateHistory: MessageForModel[] = input.privateMode
    ? (input.privateHistory ?? [])
        .filter((message) => message.content.trim())
        .slice(-HISTORY_LIMIT)
        .map((message) => ({ role: message.role, content: message.content.trim(), attachments: [] }))
    : [];
  if (input.privateMode && (input.clarification || input.preflightClarification)) {
    let lastUserIndex = -1;
    for (let i = privateHistory.length - 1; i >= 0; i--) {
      if (privateHistory[i].role === "USER") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex >= 0) {
      privateHistory[lastUserIndex] = {
        ...privateHistory[lastUserIndex],
        content: input.clarification
          ? formatClarificationModelMessage(input.clarification)
          : formatPreflightClarificationModelMessage(input.preflightClarification!),
      };
    }
  }

  const moderationTexts = effectiveModerationTexts({
    message: input.message,
    preflightClarification: input.preflightClarification,
    privateHistory,
    privateMode: input.privateMode,
    regenerate: input.regenerate,
  });
  const moderate = !isOwnerEmail(user.email) && moderationTexts.length > 0;

  // Synchronous pre-filter for the worst, unambiguous content: catch and ban it
  // BEFORE generating any reply. Subtler cases are handled fire-and-forget after
  // the response so moderation never adds latency.
  if (moderate) {
    for (const moderationText of moderationTexts) {
      const urgent = quickScreen(moderationText);
      if (urgent && (urgent.severity === "high" || urgent.severity === "critical")) {
        await recordFlag({
          userId: user.id,
          severity: urgent.severity,
          category: urgent.category,
          detail: urgent.detail,
          source: "auto",
          messagePreview: moderationMessagePreview(moderationText, !!input.privateMode),
        });
        return NextResponse.json(
          { error: "policy_violation", message: "This request violates our Acceptable Use policy." },
          { status: 403 }
        );
      }
    }
  }

  const plan = await getUserPlan(user.id);

  // Resolve the model: requested → user default → app default, then ensure the
  // provider is configured and the plan allows it, falling back if not.
  const settings = await prisma.settings.findUnique({ where: { userId: user.id } });
  const requestedId =
    input.model && isModelId(input.model)
      ? input.model
      : settings?.defaultModel && isModelId(settings.defaultModel)
        ? settings.defaultModel
        : DEFAULT_MODEL;

  let modelInfo: ModelInfo | undefined = getModel(requestedId);
  if (!modelInfo || modelInfo.comingSoon || !isProviderConfigured(modelInfo.provider) || !canUseModel(plan, modelInfo.id)) {
    // Fallback must stay plan-aware: only pick a configured model the plan allows.
    modelInfo = MODEL_LIST.find((m) => !m.comingSoon && isProviderConfigured(m.provider) && canUseModel(plan, m.id));
  }
  if (!modelInfo) {
    const msg =
      configuredProviders().length === 0
        ? "No AI model providers are configured. Add at least one provider API key (e.g. ANTHROPIC_API_KEY)."
        : "No AI model is available for your plan. Upgrade, or configure a provider with a model your plan allows.";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
  const modelId = modelInfo.id;

  // Linked tool connectors (GitHub/Figma…) the user enabled for this message.
  // Never honored in private mode — they'd send the message to a third party.
  const activeConnectors =
    !input.privateMode && input.connectors?.length ? await getActiveConnectors(user.id, input.connectors) : [];

  if (input.privateMode) {
    if (input.regenerate) return NextResponse.json({ error: "Regenerate is not available in private chat." }, { status: 400 });

    const budget = await checkBudget(user.id, plan);
    if (!budget.allowed) {
      return NextResponse.json({ error: "budget_exceeded", message: budgetExceededMessage(plan, budget.resetsAtMs) }, { status: 402 });
    }

    const consumed = await consumeMessage(user.id, plan);
    if (!consumed.allowed) {
      return NextResponse.json(
        { error: "You've reached your monthly message limit. Upgrade your plan to keep chatting.", code: "QUOTA_EXCEEDED" },
        { status: 402 }
      );
    }

    const useWebSearch = !!input.webSearch && PLANS[plan].webSearch && modelInfo.webSearch;
    const useFastMode = !!input.fastMode && supportsFastMode(modelInfo);
    const baseSystem = buildSystemPrompt({
      userName: user.name,
      customInstructions: settings?.customInstructions ?? "",
      personality: settings?.personality ?? DEFAULT_PERSONALITY,
      responseLanguage: settings?.responseLanguage ?? "auto",
      memories: [],
      memoryEnabled: false,
      canvas: false,
      voiceMode: input.voiceMode,
      projectContext: "",
    });
    const system = useWebSearch ? `${baseSystem}\n\n${WEB_SEARCH_NUDGE}` : baseSystem;
    const generationId = input.generationId ?? crypto.randomUUID();
    const generationController = new AbortController();
    const unregisterGeneration = registerGeneration(generationId, {
      userId: user.id,
      controller: generationController,
      model: modelId,
      conversationId: "private",
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (chunk: StreamChunk) => {
          try {
            controller.enqueue(encodeChunk(chunk));
          } catch {
            /* client disconnected */
          }
        };
        const activityLog: ClientActivityEvent[] = [];
        const sourceUrls = new Set<string>();
        let activityCounter = 0;
        let full = "";
        let reasoning = "";
        // Parallel to `reasoning`, not a replacement for it: the flat text is
        // what every provider has and what the disclosure renders; these are the
        // boundaries only some providers send. Empty stays empty — see
        // lib/reasoning-parts.
        let reasoningParts: string[] = [];
        let lastReasoningPart: number | null = null;
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let cacheReadTokens: number | undefined;
        let cacheWriteTokens: number | undefined;
        // Which speed actually served (fast adapters may fall back to standard);
        // defaults to the requested value and is refined from the usage stream.
        let servedFast = useFastMode;
        let writingStarted = false;
        let finishReason: ChatFinishReason = "stop";
        let spendRecorded = false;
        const webSources: ClientSource[] = [];

        const sendActivity = (event: Omit<ClientActivityEvent, "id" | "createdAt">) => {
          const entry: ClientActivityEvent = {
            ...event,
            id: `activity-${Date.now()}-${activityCounter++}`,
            createdAt: new Date().toISOString(),
          };
          activityLog.push(entry);
          send({ type: "activity", event: entry });
          return entry;
        };

        send({ type: "meta", conversationId: "private", userMessageId: null, title: "Private chat", generationId });
        // Heartbeat: models with hidden reasoning can stream nothing for
        // minutes; periodic pings keep proxies from dropping the idle SSE.
        const heartbeat = setInterval(() => send({ type: "ping" }), 15_000);
        sendActivity({
          kind: "context",
          title: "Reading private context",
          detail: `${plural(privateHistory.length, "message")} · not stored`,
        });
        sendActivity({
          kind: "model",
          title: "Selected model",
          detail: `${PROVIDERS[modelInfo.provider].label} · ${modelInfo.name}`,
        });
        if (activeConnectors.length) {
          sendActivity({
            kind: "tool",
            title: "Connected tools ready",
            detail: activeConnectors.map((c) => c.label).join(" · "),
          });
        }
        const reasoningEffort = effectiveReasoningEffort(modelInfo, input.reasoningEffort);
        if (reasoningEffort) {
          sendActivity({
            kind: "reasoning",
            title: "Reasoning mode enabled",
            detail: `${reasoningEffort[0].toUpperCase()}${reasoningEffort.slice(1)} effort`,
          });
        }
        if (useWebSearch) {
          sendActivity({
            kind: "search",
            title: "Preparing web search",
            detail: searchToolLabel(modelInfo.provider),
          });
        } else if (input.webSearch) {
          sendActivity({
            kind: "warning",
            title: "Web search was skipped",
            detail: "This plan or model cannot use native web search.",
          });
        }

        // Hard mid-stream budget ceiling: the instant the running cost of THIS
        // generation would push the user past their remaining plan budget, abort
        // the provider stream so they cannot be billed a cent beyond it.
        const budgetRates = modelRatesMicroUsdPerToken(modelId);
        const budgetCeilingMicro = budget.remainingMicroUsd;
        const inputCharsForBudget = system.length + privateHistory.reduce((sum, m) => sum + m.content.length, 0);
        let budgetHalted = false;
        const enforceStreamBudget = () => {
          if (budgetCeilingMicro == null || budgetHalted) return;
          const inTok = promptTokens ?? Math.ceil(inputCharsForBudget / 4);
          const outTok = completionTokens ?? Math.ceil((full.length + reasoning.length) / 4);
          const projected = inTok * budgetRates.input + outTok * budgetRates.output;
          if (projected >= budgetCeilingMicro) {
            budgetHalted = true;
            sendActivity({ kind: "warning", title: "Usage limit reached", detail: "Stopped to stay within your plan’s budget." });
            generationController.abort();
          }
        };

        try {
          for await (const ev of streamChat({
            model: modelInfo,
            system,
            history: privateHistory,
            maxTokens: PLANS[plan].maxOutputTokens,
            signal: generationController.signal,
            reasoningEffort,
            webSearch: useWebSearch,
            connectors: activeConnectors,
            dynamicContext: buildDynamicContext(),
            // Private chats have no stable conversation id; group the cache by
            // user (their system prompt is the shared prefix).
            cacheKey: `private-${user.id}`,
            fastMode: useFastMode,
          })) {
            if (ev.type === "text") {
              if (!writingStarted) {
                writingStarted = true;
                sendActivity({ kind: "write", title: "Writing the private answer", detail: "Streaming response text" });
              }
              full += ev.text;
              send({ type: "delta", text: ev.text });
              enforceStreamBudget();
            } else if (ev.type === "tool") {
              if (ev.phase === "call") sendActivity({ kind: "tool", title: `Using ${ev.server}`, detail: ev.name });
            } else if (ev.type === "reasoning") {
              ({
                text: reasoning,
                parts: reasoningParts,
                lastPart: lastReasoningPart,
              } = appendReasoningDelta({ text: reasoning, parts: reasoningParts, lastPart: lastReasoningPart }, ev.text, ev.part));
              // `part` rides the SSE so the panel can build steps AS THEY
              // ARRIVE, from the same boundaries the API gave the adapter.
              send({ type: "reasoning", text: ev.text, part: ev.part });
              enforceStreamBudget();
            } else if (ev.type === "sources") {
              for (const source of ev.sources) {
                if (!source.url || sourceUrls.has(source.url)) continue;
                sourceUrls.add(source.url);
                webSources.push(source);
                sendActivity({
                  kind: "visit",
                  title: "Visited source",
                  detail: truncate(source.title && source.title !== source.url ? source.title : sourceHost(source.url), 96),
                  url: source.url,
                });
              }
              if (webSources.length) send({ type: "sources", sources: webSources });
            } else if (ev.type === "usage") {
              if (ev.input != null) promptTokens = ev.input;
              if (ev.output != null) completionTokens = ev.output;
              if (ev.cacheRead != null) cacheReadTokens = ev.cacheRead;
              if (ev.cacheWrite != null) cacheWriteTokens = ev.cacheWrite;
              if (ev.fast != null) servedFast = ev.fast;
              enforceStreamBudget();
            } else if (ev.type === "finish") {
              finishReason = ev.reason;
            }
          }

          const usage = buildUsage(modelInfo, { input: promptTokens, output: completionTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens }, servedFast);
          if (promptTokens != null || completionTokens != null) {
            sendActivity({ kind: "usage", title: "Token usage recorded", detail: usage.detail });
          }
          appendFinishWarning(finishReason, sendActivity);
          sendActivity({
            kind: "done",
            title: finishReason === "stop" ? "Finished private response" : finishReasonTitle(finishReason),
            detail: webSources.length ? plural(webSources.length, "source") : "Not saved",
          });

          send({
            type: "done",
            message: {
              id: `private-${Date.now()}`,
              role: "ASSISTANT",
              content: full,
              reasoning: reasoning || undefined,
              reasoningParts: reasoningParts.length ? reasoningParts : undefined,
              model: modelId,
              feedback: null,
              createdAt: new Date().toISOString(),
              attachments: [],
              sources: webSources.length ? webSources : undefined,
              activity: activityLog,
              finishReason,
              promptTokens: usage.totalInput || undefined,
              completionTokens: usage.output || undefined,
              costUsd: usage.cost || undefined,
            },
            artifacts: [],
            memoryUpdated: false,
            quota: consumed.quota,
            finishReason,
          });
          await recordSpend({
            userId: user.id,
            model: modelId,
            kind: "chat",
            source: legacyClient,
            promptTokens: usage.totalInput || undefined,
            completionTokens: usage.output || undefined,
            costUsd: usage.cost || undefined,
            promptChars: system.length + privateHistory.reduce((sum, m) => sum + m.content.length, 0),
            completionChars: full.length + reasoning.length,
          });
          spendRecorded = true;
          console.info("[chat] private generation complete", {
            generationId,
            provider: modelInfo.provider,
            model: modelInfo.providerModel,
            finishReason,
            promptTokens: promptTokens ?? null,
            completionTokens: completionTokens ?? null,
            cacheReadTokens: cacheReadTokens ?? null,
            cacheWriteTokens: cacheWriteTokens ?? null,
          });
        } catch (err) {
          // A budget-triggered abort saves the partial answer + bills it, exactly
          // like a user-initiated stop; the "usage limit" warning was already sent.
          const reason = budgetHalted
            ? "user_stopped"
            : wasGenerationStopped(generationId)
              ? "user_stopped"
              : classifyErrorFinishReason(err);
          console.error("[chat] private generation error", {
            generationId,
            provider: modelInfo.provider,
            model: modelInfo.providerModel,
            finishReason: reason,
            message: err instanceof Error ? err.message : String(err),
          });
          if ((reason === "user_stopped" || reason === "network_error") && (full || reasoning)) {
            appendFinishWarning(reason, sendActivity);
            const partialUsage = buildUsage(modelInfo, { input: promptTokens, output: completionTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens }, servedFast);
            send({
              type: "done",
              message: {
                id: `private-${Date.now()}`,
                role: "ASSISTANT",
                content: full,
                reasoning: reasoning || undefined,
                reasoningParts: reasoningParts.length ? reasoningParts : undefined,
                model: modelId,
                feedback: null,
                createdAt: new Date().toISOString(),
                attachments: [],
                sources: webSources.length ? webSources : undefined,
                activity: activityLog,
                finishReason: reason,
                promptTokens: partialUsage.totalInput || undefined,
                completionTokens: partialUsage.output || undefined,
                costUsd: partialUsage.cost || undefined,
              },
              artifacts: [],
              memoryUpdated: false,
              quota: consumed.quota,
              finishReason: reason,
            });
            if (!spendRecorded) {
              await recordSpend({
                userId: user.id,
                model: modelId,
                kind: "chat",
                source: legacyClient,
                promptTokens: partialUsage.totalInput || undefined,
                completionTokens: partialUsage.output || undefined,
                costUsd: partialUsage.cost || undefined,
                promptChars: system.length + privateHistory.reduce((sum, m) => sum + m.content.length, 0),
                completionChars: full.length + reasoning.length,
              });
              spendRecorded = true;
            }
            console.info("[chat] private partial generation complete", {
              generationId,
              provider: modelInfo.provider,
              model: modelInfo.providerModel,
              finishReason: reason,
            });
          } else {
            const quota = reason === "user_stopped" ? consumed.quota : await refundMessage(user.id, plan).catch(() => consumed.quota);
            const message = reason === "user_stopped" ? "Generation stopped before any output." : providerErrorMessage(err, PROVIDERS[modelInfo.provider].label);
            sendActivity({
              kind: "warning",
              title: finishReasonTitle(reason),
              detail: message,
            });
            send({ type: "error", message, quota, finishReason: reason });
          }
        } finally {
          clearInterval(heartbeat);
          unregisterGeneration();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });

    // Fire-and-forget moderation of the private message (never stored, but the
    // policy still applies). Runs after the response settles so it adds no latency.
    if (moderate) {
      after(() => moderateUserMessages({ userId: user.id, texts: moderationTexts, redactPreview: true }));
    }

    return new Response(stream, { headers: SSE_HEADERS });
  }

  const budget = await checkBudget(user.id, plan);
  if (!budget.allowed) {
    return NextResponse.json({ error: "budget_exceeded", message: budgetExceededMessage(plan, budget.resetsAtMs) }, { status: 402 });
  }

  const durableFirstSubmission = !!(
    input.clientRequestId &&
    input.clientMessageId &&
    firstSubmissionHash
  );
  const connectorSelection = input.connectors === undefined ? undefined : [...new Set(input.connectors)];
  const preflightVisibleContent = input.preflightClarification
    ? formatPreflightClarificationVisibleMessage(input.preflightClarification)
    : null;

  // Project ownership is resolved before acceptance. A deletion racing the
  // transaction is still enforced by the Conversation foreign key.
  let newConversationProjectId: string | null = null;
  if (!input.conversationId && input.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, userId: user.id },
      select: { id: true },
    });
    newConversationProjectId = project?.id ?? null;
  }

  let conversation = input.conversationId
    ? await prisma.conversation.findFirst({ where: { id: input.conversationId, userId: user.id } })
    : legacyOrphanConversationId
      ? await prisma.conversation.findFirst({ where: { id: legacyOrphanConversationId, userId: user.id } })
      : null;
  if (input.conversationId && !conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  // Juno Code sessions never run through the chat pipeline: their prompts are
  // remote tasks executed on the user's Mac (POST /api/code/tasks + the task
  // event stream). Refuse here so no client path can ever bill a code session
  // against chat models or append chat-generated messages to it.
  if (conversation?.kind === "code") {
    return NextResponse.json(
      { error: "This is a Juno Code session — prompts run on your Mac via /api/code/tasks, not /api/chat." },
      { status: 409 }
    );
  }
  let userMessageId: string | null = null;
  let staleAssistantId: string | null = null;
  let clarificationModelContent: string | null = null;
  let clarificationVisibleContent: string | null = null;
  let clarificationAssistantRollback: { id: string; content: string } | null = null;
  let preflightClarificationModelContent: string | null = null;
  let durableGenerationId: string | null = null;
  let consumed: Awaited<ReturnType<typeof consumeMessage>> | null = null;

  if (durableFirstSubmission) {
    const clientRequestId = input.clientRequestId!;
    const clientMessageId = input.clientMessageId!;
    const requestHash = firstSubmissionHash!;
    const proposedGenerationId = crypto.randomUUID();
    try {
      const acceptance = await prisma.$transaction(async (tx) => {
        let acceptedConversation = conversation;

        // A pre-receipt deployment could have committed the Conversation but
        // not its first Message. Lock and finish that orphan using the same
        // atomic acceptance boundary as a brand-new request.
        if (acceptedConversation) {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "Conversation"
            WHERE "id" = ${acceptedConversation.id}
              AND "userId" = ${user.id}
              AND "clientRequestId" = ${clientRequestId}
            FOR UPDATE
          `;
          if (locked.length !== 1) return { kind: "missing" as const };

          const receipt = await tx.chatFirstSubmissionReceipt.findUnique({
            where: { userId_clientRequestId: { userId: user.id, clientRequestId } },
          });
          if (receipt) {
            return {
              kind: "recovery" as const,
              recovery: classifyFirstSubmissionRecovery(receipt, clientMessageId, requestHash),
            };
          }

          const firstMessage = await tx.message.findFirst({
            where: { conversationId: acceptedConversation.id },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, clientId: true },
          });
          if (classifyReceiptlessFirstSubmission(firstMessage) === "ambiguous") {
            return { kind: "legacy_ambiguous" as const, conversationId: acceptedConversation.id };
          }
        }

        const period = currentPeriod();
        const monthlyLimit = PLANS[plan].monthlyMessages;
        await tx.usage.upsert({
          where: { userId_period: { userId: user.id, period } },
          create: { userId: user.id, period, messageCount: 0 },
          update: {},
        });
        let quota: Awaited<ReturnType<typeof consumeMessage>>;
        if (monthlyLimit == null) {
          const updated = await tx.usage.update({
            where: { userId_period: { userId: user.id, period } },
            data: { messageCount: { increment: 1 } },
          });
          quota = {
            allowed: true,
            quota: { plan, used: updated.messageCount, limit: null, remaining: null },
          };
        } else {
          const incremented = await tx.usage.updateMany({
            where: { userId: user.id, period, messageCount: { lt: monthlyLimit } },
            data: { messageCount: { increment: 1 } },
          });
          const row = await tx.usage.findUnique({
            where: { userId_period: { userId: user.id, period } },
          });
          const used = row?.messageCount ?? monthlyLimit;
          quota = incremented.count === 0
            ? { allowed: false, quota: { plan, used, limit: monthlyLimit, remaining: 0 } }
            : {
                allowed: true,
                quota: { plan, used, limit: monthlyLimit, remaining: Math.max(0, monthlyLimit - used) },
              };
        }
        if (!quota.allowed) return { kind: "quota" as const, quota: quota.quota };

        if (!acceptedConversation) {
          acceptedConversation = await tx.conversation.create({
            data: {
              userId: user.id,
              origin: input.origin ?? null,
              clientRequestId,
              model: modelId,
              title: truncate(input.message ?? "New chat", 48),
              titleSource: "default",
              projectId: newConversationProjectId,
              activeConnectors: connectorSelection ?? [],
            },
          });
        }

        const message = await tx.message.create({
          data: {
            conversationId: acceptedConversation.id,
            clientId: clientMessageId,
            role: "USER",
            content: encryptMessageText(preflightVisibleContent ?? input.message?.trim() ?? ""),
          },
        });

        const attachmentIds = [...new Set(input.attachmentIds ?? [])];
        if (attachmentIds.length > 0) {
          const claimed = await tx.attachment.updateMany({
            where: { id: { in: attachmentIds }, userId: user.id, messageId: null },
            data: { messageId: message.id, conversationId: acceptedConversation.id },
          });
          if (claimed.count !== attachmentIds.length) throw new AttachmentClaimError();
        }

        const receipt = await tx.chatFirstSubmissionReceipt.create({
          data: {
            userId: user.id,
            clientRequestId,
            clientMessageId,
            requestHash,
            generationId: proposedGenerationId,
            state: "accepted",
            conversationId: acceptedConversation.id,
            userMessageId: message.id,
            leaseExpiresAt: firstSubmissionLeaseExpiresAt(),
          },
        });

        return {
          kind: "accepted" as const,
          conversation: acceptedConversation,
          message,
          receipt,
          consumed: quota,
        };
      });

      if (acceptance.kind === "quota") {
        return NextResponse.json(
          { error: "You've reached your monthly message limit. Upgrade your plan to keep chatting.", code: "QUOTA_EXCEEDED" },
          { status: 402 }
        );
      }
      if (acceptance.kind === "missing") {
        return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      if (acceptance.kind === "legacy_ambiguous") {
        return idempotencyKeyConflictResponse(acceptance.conversationId, true);
      }
      if (acceptance.kind === "recovery") {
        return firstSubmissionRecoveryResponse(acceptance.recovery);
      }

      conversation = acceptance.conversation;
      userMessageId = acceptance.message.id;
      durableGenerationId = acceptance.receipt.generationId;
      consumed = acceptance.consumed;
      if (input.preflightClarification) {
        preflightClarificationModelContent = formatPreflightClarificationModelMessage(input.preflightClarification);
      }
    } catch (error) {
      if (error instanceof AttachmentClaimError) {
        return NextResponse.json(
          {
            error: "attachment_claim_failed",
            code: "ATTACHMENT_CLAIM_FAILED",
            message: error.message,
          },
          { status: 409 }
        );
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await findFirstSubmissionReceipt(user.id, { clientRequestId });
        if (winner) {
          return firstSubmissionRecoveryResponse(
            classifyFirstSubmissionRecovery(winner, clientMessageId, requestHash)
          );
        }
        const reusedMessageKey = await prisma.chatFirstSubmissionReceipt.findUnique({
          where: { userId_clientMessageId: { userId: user.id, clientMessageId } },
          select: { conversationId: true },
        });
        if (reusedMessageKey) return idempotencyKeyConflictResponse(reusedMessageKey.conversationId);
      }
      throw error;
    }
  }

  // Legacy and in-conversation callers retain their existing creation path.
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        userId: user.id,
        origin: input.origin ?? null,
        clientRequestId: null,
        model: modelId,
        title: truncate(input.message ?? "New chat", 48),
        titleSource: "default",
        projectId: newConversationProjectId,
        activeConnectors: connectorSelection ?? [],
      },
    });
  } else if (
    !durableFirstSubmission &&
    connectorSelection !== undefined &&
    (conversation.activeConnectors.length !== connectorSelection.length ||
      !conversation.activeConnectors.every((connector) => connectorSelection.includes(connector)))
  ) {
    await prisma.conversation.updateMany({
      where: { id: conversation.id, userId: user.id },
      data: { activeConnectors: connectorSelection },
    });
    conversation = { ...conversation, activeConnectors: connectorSelection };
  }

  if (input.regenerate) {
    // Identify the trailing assistant message to replace — but DON'T delete it yet.
    // We only delete it once the new answer streams successfully, so a failed
    // generation never destroys the user's previous good answer.
    const last = await prisma.message.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
    });
    if (last?.role === "ASSISTANT") staleAssistantId = last.id;
  } else if (!durableFirstSubmission) {
    if (input.clarification) {
      const assistantMessage = await prisma.message.findFirst({
        where: { id: input.clarification.messageId, conversationId: conversation.id, role: "ASSISTANT" },
        select: { id: true, content: true, createdAt: true },
      });
      if (!assistantMessage) {
        return NextResponse.json({ error: "Clarification card was not found." }, { status: 404 });
      }

      const previousUser = await prisma.message.findFirst({
        where: { conversationId: conversation.id, role: "USER", createdAt: { lt: assistantMessage.createdAt } },
        orderBy: { createdAt: "desc" },
        select: { content: true },
      });
      const assistantContent = decryptMessageText(assistantMessage.content);
      const originalUserMessage =
        decryptMessageText(previousUser?.content ?? null)?.trim() || input.clarification.originalUserMessage.trim();
      const clarificationPayload = {
        ...input.clarification,
        originalUserMessage,
      };
      const submittedContent = markClarificationWizardSubmitted(
        assistantContent,
        input.clarification.blockId,
        input.clarification.answers
      );
      if (!submittedContent) {
        return NextResponse.json({ error: "Clarification card is no longer available." }, { status: 409 });
      }
      await prisma.message.update({
        where: { id: assistantMessage.id },
        data: { content: encryptMessageText(submittedContent) },
      });
      clarificationAssistantRollback = { id: assistantMessage.id, content: assistantContent };
      clarificationVisibleContent = formatClarificationVisibleMessage(clarificationPayload);
      clarificationModelContent = formatClarificationModelMessage(clarificationPayload);
    }

    // Append the user's message and link any pre-uploaded attachments. When
    // preflight clarification answers exist, persist them appended to the
    // original message so they survive regenerate/reload/follow-up turns —
    // the model-directed format below is transient (one generation only).
    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const message = await tx.message.create({
          data: {
            conversationId: conversation.id,
            clientId: null,
            role: "USER",
            content: encryptMessageText(
              clarificationVisibleContent ?? preflightVisibleContent ?? input.message?.trim() ?? ""
            ),
          },
        });

        const attachmentIds = [...new Set(input.attachmentIds ?? [])];
        if (attachmentIds.length > 0) {
          const claimed = await tx.attachment.updateMany({
            where: { id: { in: attachmentIds }, userId: user.id, messageId: null },
            data: { messageId: message.id, conversationId: conversation.id },
          });
          // Invalid, cross-account, or concurrently claimed IDs must fail the
          // whole submission rather than silently disappearing from the prompt.
          if (claimed.count !== attachmentIds.length) throw new AttachmentClaimError();
        }

        return message;
      });
    } catch (error) {
      if (error instanceof AttachmentClaimError) {
        if (clarificationAssistantRollback) {
          await prisma.message
            .update({
              where: { id: clarificationAssistantRollback.id },
              data: { content: encryptMessageText(clarificationAssistantRollback.content) },
            })
            .catch(() => {});
        }
        return NextResponse.json(
          {
            error: "attachment_claim_failed",
            code: "ATTACHMENT_CLAIM_FAILED",
            message: error.message,
          },
          { status: 409 }
        );
      }
      throw error;
    }
    userMessageId = created.id;
    if (input.preflightClarification) {
      preflightClarificationModelContent = formatPreflightClarificationModelMessage(input.preflightClarification);
    }

  }

  // Durable first submissions consumed quota inside their acceptance
  // transaction. Every legacy caller retains the existing quota path.
  if (!consumed) {
    consumed = await consumeMessage(user.id, plan);
    if (!consumed.allowed) {
      if (userMessageId) await prisma.message.delete({ where: { id: userMessageId } }).catch(() => {});
      if (clarificationAssistantRollback) {
        await prisma.message
          .update({
            where: { id: clarificationAssistantRollback.id },
            data: { content: encryptMessageText(clarificationAssistantRollback.content) },
          })
          .catch(() => {});
      }
      return NextResponse.json(
        { error: "You've reached your monthly message limit. Upgrade your plan to keep chatting.", code: "QUOTA_EXCEEDED" },
        { status: 402 }
      );
    }
  }

  try {
  // Build context from the most recent messages, excluding the answer being
  // regenerated. The window start is anchored to HISTORY_STEP blocks (see
  // HISTORY_STEP above) so the prompt prefix stays cache-stable across turns;
  // the window holds between HISTORY_LIMIT and HISTORY_LIMIT+HISTORY_STEP-1
  // messages.
  const totalMessages = await prisma.message.count({ where: { conversationId: conversation.id } });
  const windowStart =
    totalMessages > HISTORY_LIMIT ? Math.floor((totalMessages - HISTORY_LIMIT) / HISTORY_STEP) * HISTORY_STEP : 0;
  const recent = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    include: { attachments: true },
    skip: windowStart,
  });
  const history = recent
    .filter((m) => m.id !== staleAssistantId)
    .map((m) => ({ ...m, content: decryptMessageText(m.content) }));
  const hiddenUserContent = clarificationModelContent ?? preflightClarificationModelContent;
  const modelHistory =
    hiddenUserContent && userMessageId
      ? history.map((message) => (message.id === userMessageId ? { ...message, content: hiddenUserContent } : message))
      : history;

  const memoryEnabled = settings?.memoryEnabled ?? true;
  // Prefer the consolidated summary (deduped, sectioned); fall back to the raw
  // list when no summary exists yet. `recent` holds entries newer than the summary.
  const memoryProfile = memoryEnabled ? await getMemoryProfile(user.id) : { summary: null, recent: [] };

  // Project context: instructions + reference file contents injected into the system prompt.
  let projectContext = "";
  if (conversation.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: conversation.projectId },
      select: { name: true, instructions: true, files: { select: { fileName: true, extractedText: true } } },
    });
    if (project) {
      const sections = [`# Project: ${project.name}`];
      if (project.instructions.trim()) sections.push(`## Project instructions\n${project.instructions.trim()}`);
      const fileTexts = project.files.filter((f) => f.extractedText?.trim());
      if (fileTexts.length) {
        sections.push("## Project reference files");
        for (const f of fileTexts) sections.push(`### ${f.fileName}\n${f.extractedText!.slice(0, 50_000)}`);
      }
      projectContext = sections.join("\n\n");
    }
  }

  // Deep research: Tavily plan → search → read before synthesis. It replaces
  // native web search for this turn — the researched corpus IS the live web
  // data — so the two are never both active. Voice turns stay conversational.
  const researchRequested = !!input.deepResearch && !input.voiceMode;
  const researchActive = researchRequested && PLANS[plan].webSearch && isWebSearchConfigured();
  // Native web search: the model searches via its own tool/grounding while it
  // streams (Gemini Google Search, Claude web_search, Grok Live Search). We
  // collect the sources it returns from the stream below — no third-party search.
  const useWebSearch = !researchActive && !!input.webSearch && PLANS[plan].webSearch && modelInfo.webSearch;
  const useFastMode = !!input.fastMode && supportsFastMode(modelInfo);
  const webSources: ClientSource[] = [];

  const canvasOn = !input.voiceMode && (input.canvasEnabled ?? true);
  const baseSystem = buildSystemPrompt({
    userName: user.name,
    customInstructions: settings?.customInstructions ?? "",
    personality: settings?.personality ?? DEFAULT_PERSONALITY,
    responseLanguage: settings?.responseLanguage ?? "auto",
    memories: memoryProfile.recent,
    memorySummary: memoryProfile.summary ?? undefined,
    memoryEnabled,
    canvas: canvasOn,
    voiceMode: input.voiceMode,
    projectContext,
  });
  const system = [baseSystem, useWebSearch ? WEB_SEARCH_NUDGE : null, canvasOn ? SELECTION_ANCHOR_NUDGE : null]
    .filter(Boolean)
    .join("\n\n");
  const conversationId = conversation.id;
  const convoTitle = conversation.title;
  const convoTitleSource = coerceTitleSource(conversation.titleSource);
  const generationId = durableGenerationId ?? input.generationId ?? crypto.randomUUID();
  if (durableGenerationId) {
    const now = new Date();
    const markedRunning = await prisma.chatFirstSubmissionReceipt.updateMany({
      where: {
        userId: user.id,
        generationId: durableGenerationId,
        state: "accepted",
        leaseExpiresAt: { gt: now },
      },
      data: {
        state: "running",
        failureCode: null,
        finishReason: null,
        leaseExpiresAt: firstSubmissionLeaseExpiresAt(),
      },
    });
    if (markedRunning.count !== 1) {
      throw new Error("Durable first-submission receipt could not enter the running state.");
    }
  }
  const generationController = new AbortController();
  const unregisterGeneration = registerGeneration(generationId, {
    userId: user.id,
    controller: generationController,
    model: modelId,
    conversationId,
  });
  let durableReceiptLeaseLost = false;
  const renewDurableReceiptLease = async (): Promise<boolean> => {
    if (!durableGenerationId) return true;
    const now = new Date();
    try {
      const renewed = await prisma.chatFirstSubmissionReceipt.updateMany({
        where: {
          userId: user.id,
          generationId: durableGenerationId,
          state: "running",
          leaseExpiresAt: { gt: now },
        },
        data: { leaseExpiresAt: firstSubmissionLeaseExpiresAt(now.getTime()) },
      });
      const ownsReceipt = firstSubmissionLeaseHeartbeatOwnsReceipt(renewed.count);
      if (!ownsReceipt) durableReceiptLeaseLost = true;
      return ownsReceipt;
    } catch (error) {
      durableReceiptLeaseLost = true;
      console.error("[chat] durable receipt lease renewal failed", {
        generationId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
  const markDurableReceiptCompleted = async (assistantMessageId: string, finishReason: ChatFinishReason) => {
    if (!durableGenerationId) return true;
    const now = new Date();
    try {
      const updated = await prisma.chatFirstSubmissionReceipt.updateMany({
        where: {
          userId: user.id,
          generationId: durableGenerationId,
          state: "running",
          leaseExpiresAt: { gt: now },
        },
        data: {
          state: "completed",
          assistantMessageId,
          finishReason,
          failureCode: null,
          completedAt: new Date(),
          leaseExpiresAt: null,
        },
      });
      return firstSubmissionLeaseHeartbeatOwnsReceipt(updated.count);
    } catch (error) {
      console.error("[chat] durable receipt completion failed", {
        generationId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
  const markDurableReceiptFailed = async (finishReason: ChatFinishReason, failureCode: string) => {
    if (!durableGenerationId) return;
    try {
      const updated = await prisma.chatFirstSubmissionReceipt.updateMany({
        where: {
          userId: user.id,
          generationId: durableGenerationId,
          state: { in: ["accepted", "running"] },
        },
        data: {
          state: "failed",
          finishReason,
          failureCode,
          completedAt: new Date(),
          leaseExpiresAt: null,
        },
      });
      if (updated.count !== 1) console.error("[chat] durable receipt failure row missing", { generationId });
    } catch (error) {
      console.error("[chat] durable receipt failure update failed", {
        generationId,
        failureCode,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  let assistantFull = ""; // captured for background memory extraction
  // Background memory work runs on the same speed-ranked utility models the
  // rest of the app uses, not on whichever FREE model happens to be listed first.
  const cheapModel =
    utilityModelCandidates()[0] ?? MODEL_LIST.find((m) => isProviderConfigured(m.provider)) ?? modelInfo;

  // Generation + persistence is detached from the request lifecycle: we do not
  // pass req.signal to the model, so navigating away can drop the browser stream
  // without losing the saved answer. The explicit cancel endpoint aborts it.
  let generationHeartbeat: ReturnType<typeof setInterval> | null = null;
  let lastReceiptLeaseHeartbeat = Date.now();
  const generate = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
      // Once the client disconnects the controller is closed; swallow the enqueue
      // error so generation and persistence keep running regardless.
      const send = (chunk: StreamChunk) => {
        try {
          controller.enqueue(encodeChunk(chunk));
        } catch {
          /* client disconnected — keep going so the answer is still saved */
        }
      };
      const activityLog: ClientActivityEvent[] = [];
      const sourceUrls = new Set<string>();
      let activityCounter = 0;
      let full = "";
      let reasoning = "";
      // See the private branch: flat text for everyone, boundaries only from
      // providers that actually send them.
      let reasoningParts: string[] = [];
      let lastReasoningPart: number | null = null;
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      let cacheReadTokens: number | undefined;
      let cacheWriteTokens: number | undefined;
      // Which speed actually served (fast adapters may fall back to standard);
      // defaults to the requested value and is refined from the usage stream.
      let servedFast = useFastMode;
      let writingStarted = false;
      let finishReason: ChatFinishReason = "stop";
      let spendRecorded = false;

      const sendActivity = (event: Omit<ClientActivityEvent, "id" | "createdAt">) => {
        const entry: ClientActivityEvent = {
          ...event,
          id: `activity-${Date.now()}-${activityCounter++}`,
          createdAt: new Date().toISOString(),
        };
        activityLog.push(entry);
        send({ type: "activity", event: entry });
        return entry;
      };

      /**
       * Persist the assistant's answer. A normal turn appends a new Message row.
       * A regenerate PRESERVES the previous answer instead of destroying it: the
       * old row's content is snapshotted into an immutable MessageVersion
       * (ciphertext copied verbatim — the crypto is row-independent, see
       * message-crypto.ts), its artifacts are dropped, and the Message row is
       * then overwritten in place. The Message row is therefore always the
       * CURRENT version; MessageVersion rows are append-only, read-only history
       * rendered by the client's "‹ 2/3 ›" pager. Which version the user was
       * VIEWING never changes the result: the prompt excludes the answer being
       * regenerated entirely, so regeneration is deterministic in its inputs and
       * versions simply accumulate oldest-first.
       */
      const persistAssistantTurn = async (data: {
        content: string;
        reasoning: string;
        /** Empty for every provider that streams unbroken prose. Persisted as
         *  NULL in that case, so "no steps" survives a reload as a fact. */
        reasoningParts: string[];
        promptTokens: number | null;
        completionTokens: number | null;
      }) => {
        // Each part is encrypted individually, exactly like `reasoning` — same
        // message-crypto path, same key. The array shape stays in plaintext
        // because the count of steps is not the secret; their contents are.
        const encryptedParts = data.reasoningParts.length
          ? (data.reasoningParts.map(encryptMessageText) as unknown as Prisma.InputJsonValue)
          : null;
        const base = {
          content: encryptMessageText(data.content),
          model: modelId,
          promptTokens: data.promptTokens,
          completionTokens: data.completionTokens,
          activity: activityLog as unknown as Prisma.InputJsonValue,
        };
        // Metadata for the pager rides along on the done chunk.
        const include = {
          attachments: true,
          versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
        };
        if (staleAssistantId) {
          const stale = await prisma.message.findUnique({ where: { id: staleAssistantId } });
          if (stale) {
            // Snapshot the answer being replaced BEFORE overwriting it — a
            // regenerate must never lose what the user already had. Atomic with
            // the overwrite so a crash can't leave a duplicate version behind.
            const [, , updated] = await prisma.$transaction([
              prisma.messageVersion.create({
                data: {
                  messageId: stale.id,
                  content: stale.content, // already encrypted — copied verbatim
                  reasoning: stale.reasoning,
                  model: stale.model,
                  promptTokens: stale.promptTokens,
                  completionTokens: stale.completionTokens,
                  ...(stale.sources !== null ? { sources: stale.sources as unknown as Prisma.InputJsonValue } : {}),
                },
              }),
              prisma.artifact.deleteMany({ where: { messageId: stale.id } }),
              prisma.message.update({
                where: { id: stale.id },
                data: {
                  ...base,
                  reasoning: data.reasoning ? encryptMessageText(data.reasoning) : null,
                  // MUST clear, not skip. A regenerate can swap a part-emitting
                  // model for one that sends none; leaving the old array behind
                  // would show the PREVIOUS answer's steps above the new one's
                  // reasoning — the exact fabrication this work exists to avoid.
                  reasoningParts: encryptedParts ?? Prisma.DbNull,
                  feedback: null, // a fresh answer starts with clean feedback
                  sources: webSources.length ? (webSources as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
                  createdAt: new Date(), // the timestamp reflects the current version
                },
                include,
              }),
            ]);
            return updated;
          }
          // The stale row vanished mid-generation (deleted elsewhere) — append instead.
        }
        return prisma.message.create({
          data: {
            conversationId,
            role: "ASSISTANT",
            ...base,
            ...(data.reasoning ? { reasoning: encryptMessageText(data.reasoning) } : {}),
            ...(encryptedParts ? { reasoningParts: encryptedParts } : {}),
            ...(webSources.length ? { sources: webSources as unknown as Prisma.InputJsonValue } : {}),
          },
          include,
        });
      };

      send({
        type: "meta",
        conversationId,
        userMessageId,
        title: convoTitle,
        titleSource: convoTitleSource,
        generationId,
        ...(durableGenerationId ? { receiptState: "running" as const } : {}),
      });
      // Heartbeat: models with hidden reasoning can stream nothing for minutes;
      // periodic pings keep proxies from dropping the idle SSE connection.
      generationHeartbeat = setInterval(() => {
        send({ type: "ping" });
        const now = Date.now();
        if (!durableGenerationId || now - lastReceiptLeaseHeartbeat < FIRST_SUBMISSION_RECEIPT_HEARTBEAT_MS) return;
        lastReceiptLeaseHeartbeat = now;
        void prisma.chatFirstSubmissionReceipt
          .updateMany({
            where: {
              userId: user.id,
              generationId: durableGenerationId,
              state: "running",
              leaseExpiresAt: { gt: new Date(now) },
            },
            data: { leaseExpiresAt: firstSubmissionLeaseExpiresAt(now) },
          })
          .then((updated) => {
            // A status lookup may have expired the lease while this process was
            // suspended. Do not keep spending against a terminal receipt.
            if (!firstSubmissionLeaseHeartbeatOwnsReceipt(updated.count)) {
              durableReceiptLeaseLost = true;
              generationController.abort();
            }
          })
          .catch((error) => {
            console.error("[chat] durable receipt lease heartbeat failed", {
              generationId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
      }, 15_000);

      const attachmentCount = modelHistory.reduce((sum, msg) => sum + msg.attachments.length, 0);
      const contextDetails = [plural(modelHistory.length, "message")];
      if (attachmentCount) contextDetails.push(plural(attachmentCount, "attachment"));
      if (memoryEnabled && memoryProfile.recent.length)
        contextDetails.push(plural(memoryProfile.recent.length, "memory", "memories"));
      if (projectContext) contextDetails.push("project context");
      sendActivity({
        kind: "context",
        title: input.regenerate ? "Rebuilding the conversation context" : "Reading the conversation context",
        detail: contextDetails.join(" · "),
      });
      sendActivity({
        kind: "model",
        title: "Selected model",
        detail: `${PROVIDERS[modelInfo.provider].label} · ${modelInfo.name}`,
      });
      if (activeConnectors.length) {
        sendActivity({
          kind: "tool",
          title: "Connected tools ready",
          detail: activeConnectors.map((c) => c.label).join(" · "),
        });
      }
      const reasoningEffort = effectiveReasoningEffort(modelInfo, input.reasoningEffort);
      if (reasoningEffort) {
        sendActivity({
          kind: "reasoning",
          title: "Reasoning mode enabled",
          detail: `${reasoningEffort[0].toUpperCase()}${reasoningEffort.slice(1)} effort`,
        });
      }
      if (useWebSearch) {
        sendActivity({
          kind: "search",
          title: "Preparing web search",
          detail: searchToolLabel(modelInfo.provider),
        });
      } else if (input.webSearch && !researchActive) {
        sendActivity({
          kind: "warning",
          title: "Web search was skipped",
          detail: "This plan or model cannot use native web search.",
        });
      }

      // Deep research runs BEFORE synthesis: plan + search + read, streaming
      // progress into the same activity timeline. The corpus rides in as a
      // system-prompt section for THIS turn only (the next turn rebuilds the
      // system prompt without it, restoring the cache-stable prefix). Any
      // failure degrades to plain chat — never to a dead turn. Planning spend
      // is recorded inside runDeepResearch; synthesis is billed below as usual.
      let synthesisSystem = system;
      let researchCostUsd = 0;
      if (researchActive) {
        const researchPrompt =
          [...modelHistory].reverse().find((m) => m.role === "USER")?.content ?? input.message?.trim() ?? "";
        const research = await runDeepResearch({
          userId: user.id,
          prompt: researchPrompt,
          selectedModel: modelInfo,
          client: legacyClient,
          signal: generationController.signal,
          sendActivity,
        });
        researchCostUsd = research.costUsd;
        if (research.ok) {
          synthesisSystem = `${system}\n\n${research.context}`;
          // Sources are known up front (unlike native search, which streams
          // them): publish the numbered list now so citations resolve as the
          // report streams. Order must match the corpus numbering exactly.
          for (const source of research.sources) {
            if (!source.url || sourceUrls.has(source.url)) continue;
            sourceUrls.add(source.url);
            webSources.push(source);
          }
          if (webSources.length) send({ type: "sources", sources: webSources });
        } else {
          sendActivity({
            kind: "warning",
            title: "Web search unavailable",
            detail: "Answering from model knowledge instead.",
          });
        }
      } else if (researchRequested) {
        sendActivity({
          kind: "warning",
          title: "Deep research was skipped",
          detail: "Deep research isn't available on this plan right now.",
        });
      }

      // Hard mid-stream budget ceiling (see the private path for rationale):
      // abort the provider stream the instant this generation's running cost
      // would take the user past their remaining plan budget.
      const budgetRates = modelRatesMicroUsdPerToken(modelId);
      const budgetCeilingMicro = budget.remainingMicroUsd;
      const inputCharsForBudget = synthesisSystem.length + modelHistory.reduce((sum, m) => sum + m.content.length, 0);
      let budgetHalted = false;
      const enforceStreamBudget = () => {
        if (budgetCeilingMicro == null || budgetHalted) return;
        const inTok = promptTokens ?? Math.ceil(inputCharsForBudget / 4);
        const outTok = completionTokens ?? Math.ceil((full.length + reasoning.length) / 4);
        const projected = inTok * budgetRates.input + outTok * budgetRates.output;
        if (projected >= budgetCeilingMicro) {
          budgetHalted = true;
          sendActivity({ kind: "warning", title: "Usage limit reached", detail: "Stopped to stay within your plan’s budget." });
          generationController.abort();
        }
      };

      try {
        for await (const ev of streamChat({
          model: modelInfo,
          system: synthesisSystem,
          history: modelHistory,
          maxTokens: PLANS[plan].maxOutputTokens,
          // Not tied to req.signal: route changes can drop the browser stream
          // without killing generation; the explicit cancel endpoint aborts this.
          signal: generationController.signal,
          reasoningEffort,
          webSearch: useWebSearch,
          connectors: activeConnectors,
          dynamicContext: buildDynamicContext(),
          // One conversation = one stable prompt prefix (system + history).
          cacheKey: conversationId,
          fastMode: useFastMode,
        })) {
          if (ev.type === "text") {
            if (!writingStarted) {
              writingStarted = true;
              sendActivity({ kind: "write", title: "Writing the answer", detail: "Streaming response text" });
            }
            full += ev.text;
            send({ type: "delta", text: ev.text });
            enforceStreamBudget();
          } else if (ev.type === "tool") {
            if (ev.phase === "call") sendActivity({ kind: "tool", title: `Using ${ev.server}`, detail: ev.name });
          } else if (ev.type === "reasoning") {
            ({
              text: reasoning,
              parts: reasoningParts,
              lastPart: lastReasoningPart,
            } = appendReasoningDelta({ text: reasoning, parts: reasoningParts, lastPart: lastReasoningPart }, ev.text, ev.part));
            send({ type: "reasoning", text: ev.text, part: ev.part });
            enforceStreamBudget();
          } else if (ev.type === "sources") {
            for (const source of ev.sources) {
              if (!source.url || sourceUrls.has(source.url)) continue;
              sourceUrls.add(source.url);
              webSources.push(source);
              sendActivity({
                kind: "visit",
                title: "Visited source",
                detail: truncate(source.title && source.title !== source.url ? source.title : sourceHost(source.url), 96),
                url: source.url,
              });
            }
            if (webSources.length) send({ type: "sources", sources: webSources });
          } else if (ev.type === "usage") {
            if (ev.input != null) promptTokens = ev.input;
            if (ev.output != null) completionTokens = ev.output;
            if (ev.cacheRead != null) cacheReadTokens = ev.cacheRead;
            if (ev.cacheWrite != null) cacheWriteTokens = ev.cacheWrite;
            if (ev.fast != null) servedFast = ev.fast;
            enforceStreamBudget();
          } else if (ev.type === "finish") {
            finishReason = ev.reason;
          }
        }

        // Reconcile token usage across providers and estimate the $ cost once.
        const usage = buildUsage(modelInfo, { input: promptTokens, output: completionTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens }, servedFast);

        // Persist the assistant message — generation succeeded, so it's safe to
        // version-and-overwrite the answer being regenerated (see the helper).
        // promptTokens stores the full prompt size (cache included) so the
        // reloaded cost estimate lines up with the stream.
        if (!(await renewDurableReceiptLease())) throw new DurableReceiptLeaseLostError();
        const assistant = await persistAssistantTurn({
          content: full,
          reasoning,
          reasoningParts,
          promptTokens: usage.totalInput || promptTokens || null,
          completionTokens: usage.output || completionTokens || null,
        });

        // Artifacts + memory side effects.
        const artifacts = await persistArtifacts(conversationId, assistant.id, parseArtifacts(full));
        let memoryUpdated = false;
        if (memoryEnabled) {
          const created = await saveAutoMemories(user.id, parseMemories(full), conversationId);
          memoryUpdated = created > 0;
        }

        // Touch the conversation after the assistant message has been persisted.
        await prisma.conversation.updateMany({
          where: { id: conversationId, userId: user.id },
          data: {
            lastMessageAt: new Date(),
            model: modelId,
          },
        });

        assistantFull = full;

        if (promptTokens != null || completionTokens != null) {
          sendActivity({ kind: "usage", title: "Token usage recorded", detail: usage.detail });
        }
        appendFinishWarning(finishReason, sendActivity);
        sendActivity({
          kind: "done",
          title: "Finished response",
          detail: webSources.length ? plural(webSources.length, "source") : undefined,
        });
        const assistantWithActivity = await prisma.message.update({
          where: { id: assistant.id },
          data: { activity: activityLog as unknown as Prisma.InputJsonValue },
          include: {
            attachments: true,
            versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" } },
          },
        });
        if (!(await markDurableReceiptCompleted(assistant.id, finishReason))) {
          durableReceiptLeaseLost = true;
          throw new DurableReceiptLeaseLostError();
        }

        send({
          type: "done",
          // The visible cost covers the WHOLE research run: planning (billed
          // inside runDeepResearch) + this synthesis. Zero for normal chat.
          message: { ...(await serializeMessage(assistantWithActivity)), finishReason, costUsd: usage.cost + researchCostUsd || undefined },
          artifacts,
          memoryUpdated,
          quota: consumed.quota,
          finishReason,
          projectId: conversation.projectId,
        });
        await recordSpend({
          userId: user.id,
          model: modelId,
          kind: "chat",
          source: legacyClient,
          promptTokens: usage.totalInput || undefined,
          completionTokens: usage.output || undefined,
          costUsd: usage.cost || undefined,
          promptChars: synthesisSystem.length + modelHistory.reduce((sum, m) => sum + m.content.length, 0),
          completionChars: full.length + reasoning.length,
        });
        spendRecorded = true;
        console.info("[chat] generation complete", {
          generationId,
          conversationId,
          provider: modelInfo.provider,
          model: modelInfo.providerModel,
          finishReason,
          promptTokens: promptTokens ?? null,
          completionTokens: completionTokens ?? null,
          // Prompt-cache instrumentation (read = hit, write = Anthropic-only creation).
          cacheReadTokens: cacheReadTokens ?? null,
          cacheWriteTokens: cacheWriteTokens ?? null,
        });
      } catch (err) {
        const reason = budgetHalted
          ? "user_stopped"
          : wasGenerationStopped(generationId)
            ? "user_stopped"
            : classifyErrorFinishReason(err);
        const terminalFailureCode =
          durableReceiptLeaseLost || err instanceof DurableReceiptLeaseLostError
            ? "GENERATION_LEASE_EXPIRED"
            : generationFailureCode(reason);
        console.error("[chat] generation error", {
          generationId,
          conversationId,
          provider: modelInfo.provider,
          model: modelInfo.providerModel,
          finishReason: reason,
          message: err instanceof Error ? err.message : String(err),
        });

        if ((reason === "user_stopped" || reason === "network_error") && (full || reasoning)) {
          try {
            appendFinishWarning(reason, sendActivity);
            const partialUsage = buildUsage(modelInfo, { input: promptTokens, output: completionTokens, cacheRead: cacheReadTokens, cacheWrite: cacheWriteTokens }, servedFast);
            // Same version-preserving persistence as the success path — a
            // partial answer still supersedes (never destroys) the previous one.
            if (!(await renewDurableReceiptLease())) throw new DurableReceiptLeaseLostError();
            const assistant = await persistAssistantTurn({
              content: full,
              reasoning,
              reasoningParts,
              promptTokens: partialUsage.totalInput || promptTokens || null,
              completionTokens: partialUsage.output || completionTokens || null,
            });
            const artifacts = await persistArtifacts(conversationId, assistant.id, parseArtifacts(full));
            await prisma.conversation.updateMany({ where: { id: conversationId, userId: user.id }, data: { lastMessageAt: new Date(), model: modelId } });
            const assistantWithActivity = await prisma.message.update({
              where: { id: assistant.id },
              data: { activity: activityLog as unknown as Prisma.InputJsonValue },
              include: {
                attachments: true,
                versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" } },
              },
            });
            assistantFull = full;
            if (!(await markDurableReceiptCompleted(assistant.id, reason))) {
              durableReceiptLeaseLost = true;
              throw new DurableReceiptLeaseLostError();
            }
            send({
              type: "done",
              message: { ...(await serializeMessage(assistantWithActivity)), finishReason: reason, costUsd: partialUsage.cost + researchCostUsd || undefined },
              artifacts,
              memoryUpdated: false,
              quota: consumed.quota,
              finishReason: reason,
              title: convoTitle,
              projectId: conversation.projectId,
            });
            if (!spendRecorded) {
              await recordSpend({
                userId: user.id,
                model: modelId,
                kind: "chat",
                source: legacyClient,
                promptTokens: partialUsage.totalInput || undefined,
                completionTokens: partialUsage.output || undefined,
                costUsd: partialUsage.cost || undefined,
                promptChars: synthesisSystem.length + modelHistory.reduce((sum, m) => sum + m.content.length, 0),
                completionChars: full.length + reasoning.length,
              });
              spendRecorded = true;
            }
            console.info("[chat] partial generation persisted", {
              generationId,
              conversationId,
              provider: modelInfo.provider,
              model: modelInfo.providerModel,
              finishReason: reason,
            });
          } catch (persistErr) {
            console.error("[chat] failed to persist partial generation", {
              generationId,
              conversationId,
              message: persistErr instanceof Error ? persistErr.message : String(persistErr),
            });
            const quota = await refundMessage(user.id, plan).catch(() => consumed.quota);
            const failureCode =
              durableReceiptLeaseLost || persistErr instanceof DurableReceiptLeaseLostError
                ? "GENERATION_LEASE_EXPIRED"
                : "GENERATION_PERSISTENCE_FAILED";
            await markDurableReceiptFailed("error", failureCode);
            send({
              type: "error",
              message: providerErrorMessage(persistErr, PROVIDERS[modelInfo.provider].label),
              quota,
              finishReason: "error",
              ...(durableGenerationId
                ? {
                    conversationId,
                    userMessageId: userMessageId!,
                    generationId,
                    receiptState: "failed" as const,
                    failureCode,
                  }
                : {}),
            });
          }
        } else {
          // Generation failed before useful output, so refund the consumed message
          // and report the corrected quota so the UI doesn't go stale.
          const quota = reason === "user_stopped" ? consumed.quota : await refundMessage(user.id, plan).catch(() => consumed.quota);
          const message = reason === "user_stopped" ? "Generation stopped before any output." : providerErrorMessage(err, PROVIDERS[modelInfo.provider].label);
          sendActivity({
            kind: "warning",
            title: finishReasonTitle(reason),
            detail: message,
          });
          const failureCode = terminalFailureCode;
          await markDurableReceiptFailed(reason, failureCode);
          send({
            type: "error",
            message,
            quota,
            finishReason: reason,
            ...(durableGenerationId
              ? {
                  conversationId,
                  userMessageId: userMessageId!,
                  generationId,
                  receiptState: "failed" as const,
                  failureCode,
                }
              : {}),
          });
        }
      } finally {
        if (generationHeartbeat) clearInterval(generationHeartbeat);
        generationHeartbeat = null;
        unregisterGeneration();
        try {
          controller.close();
        } catch {
          /* already closed because the client disconnected */
        }
      }
  };

  // Start generating as soon as the response body is read, and keep a handle so
  // we can await it (below) even after the client disconnects.
  let genPromise: Promise<void> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      genPromise = generate(controller).catch(async (error) => {
        if (generationHeartbeat) clearInterval(generationHeartbeat);
        generationHeartbeat = null;
        const finishReason = classifyErrorFinishReason(error);
        const failureCode = durableReceiptLeaseLost
          ? "GENERATION_LEASE_EXPIRED"
          : "GENERATION_INTERNAL_ERROR";
        await markDurableReceiptFailed(finishReason, failureCode);
        const quota = await refundMessage(user.id, plan).catch(() => consumed.quota);
        const message = providerErrorMessage(error, PROVIDERS[modelInfo.provider].label);
        try {
          controller.enqueue(
            encodeChunk({
              type: "error",
              message,
              quota,
              finishReason,
              ...(durableGenerationId
                ? {
                    conversationId,
                    userMessageId: userMessageId!,
                    generationId,
                    receiptState: "failed" as const,
                    failureCode,
                  }
                : {}),
            })
          );
        } catch {
          /* client disconnected */
        }
        unregisterGeneration();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  // `after` runs once the response is settled — including when the client
  // disconnects. Awaiting genPromise keeps the serverless function alive until the
  // answer is fully generated and saved, then extracts durable memories.
  after(async () => {
    // Moderate the user's message independently of whether generation succeeded —
    // a violation must be caught even if the model errored. Fire-and-forget so it
    // never delays the reply.
    if (moderate) {
      await moderateUserMessages({ userId: user.id, texts: moderationTexts }).catch(() => {});
    }

    await genPromise?.catch(() => {});
    if (!assistantFull) return;

    // Incremental extraction: distill this conversation's unprocessed user
    // messages into memory facts (advances its high-water mark).
    if (memoryEnabled) {
      await extractConversationMemory({ userId: user.id, conversationId: conversation.id }).catch(() => {});
      // Periodically re-summarize so the memory stays tidy and deduped.
      await maybeConsolidate(user.id, cheapModel).catch(() => {});
    }
  });

  return new Response(stream, { headers: SSE_HEADERS });
  } catch (error) {
    if (!durableGenerationId || !userMessageId || !conversation) throw error;
    const failureCode = "GENERATION_START_FAILED";
    await prisma.chatFirstSubmissionReceipt
      .updateMany({
        where: {
          userId: user.id,
          generationId: durableGenerationId,
          state: { in: ["accepted", "running"] },
        },
        data: {
          state: "failed",
          finishReason: "error",
          failureCode,
          completedAt: new Date(),
          leaseExpiresAt: null,
        },
      })
      .catch(() => {});
    await refundMessage(user.id, plan).catch(() => {});
    throw new DurableFirstSubmissionStartError(error, {
      generationId: durableGenerationId,
      conversationId: conversation.id,
      userMessageId,
    });
  }
}

export async function POST(req: Request) {
  // Everything before the SSE stream starts (auth, quota, DB writes for the
  // conversation/message, system-prompt build) runs here. If any of it throws —
  // e.g. a production database missing a migration/column — we must return a
  // JSON { error } so the client shows the real reason instead of an opaque 500
  // rendered as a generic "Something went wrong.".
  try {
    return await handleChat(req);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unexpected server error.";
    console.error("[chat] request failed before streaming", { message: detail, stack: err instanceof Error ? err.stack : undefined });
    if (err instanceof DurableFirstSubmissionStartError) {
      return NextResponse.json(
        {
          error: `Couldn't start the chat: ${detail}`,
          code: err.failureCode,
          generationId: err.generationId,
          conversationId: err.conversationId,
          userMessageId: err.userMessageId,
          receiptState: "failed",
          failureCode: err.failureCode,
          retryable: false,
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: `Couldn't start the chat: ${detail}` }, { status: 500 });
  }
}
