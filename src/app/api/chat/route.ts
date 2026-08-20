import { NextResponse, after } from "next/server";
import { admitChatRequest } from "@/lib/chat-admission";
import { cheapestEligible, selectModel } from "@/lib/model-selection";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan, consumeMessage, refundMessage } from "@/lib/usage";
import { canUseModel, PLANS } from "@/lib/plans";
import { isModelId, getModel, DEFAULT_MODEL, MODEL_LIST, type ModelInfo } from "@/lib/models";
import { AUTO_MODEL_ID, isAutoModelId, pickAutoModel } from "@/lib/auto-model";
import { isProviderConfigured, configuredProviders, PROVIDERS, type Provider } from "@/lib/providers";
import { providerHealthy } from "@/lib/provider-health";
import { loadModelCapabilityMap, modelCanRoute } from "@/lib/model-capability";
import { isPlatformBudgetExceeded } from "@/lib/platform-budget";
import { isOwnerEmail } from "@/lib/owner";
import { buildSystemPrompt, buildDynamicContext } from "@/lib/anthropic";
import { finishReasonTitle } from "@/lib/finish-reason";
import { registerGeneration, wasGenerationStopped } from "@/lib/generation-cancel";
import { streamChat, providerErrorMessage } from "@/lib/llm";
import {
  getMemoryProfile,
  saveAutoMemories,
  extractConversationMemory,
  loadBackgroundProviderPolicy,
  maybeConsolidate,
} from "@/lib/memory";
import { memoryReceiptDetail } from "@/lib/memory-lifecycle";
import { ArtifactVersionConflictError, persistArtifacts, persistTargetedArtifactEdit } from "@/lib/artifacts-store";
import {
  applyArtifactPatch,
  ArtifactPatchError,
  buildArtifactEditMessage,
  buildArtifactEditPrompt,
  parseArtifactPatch,
  type ArtifactSourceForEdit,
} from "@/lib/artifact-edit";
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
import { encryptMessageText, decryptMessageText } from "@/lib/message-crypto";
import {
  checkBudget,
  recordSpend,
  reserveSpend,
  budgetExceededMessage,
  modelRatesMicroUsdPerToken,
} from "@/lib/spend";
import { runDeepResearch, type ResearchCorpusPage } from "@/lib/deep-research";
import { recordCitationAudit } from "@/lib/research/claims";
import { finalizeChatResearchRun } from "@/lib/research/run";
import { isWebSearchConfigured } from "@/lib/web-search";
import { createSseSender, encodeChunk, SSE_HEADERS, type SseSender } from "@/lib/chat-stream";
import { closeToolDetail, createToolDetailBudget, openToolDetail } from "@/lib/chat/tool-detail";
import { truncate, currentPeriod } from "@/lib/utils";
import { coerceTitleSource } from "@/lib/title-ownership";
import { DEFAULT_PERSONALITY } from "@/lib/personalities";
import { supportsFastMode } from "@/lib/pricing";
import { supportsProMode } from "@/lib/model-metrics";
import { buildUsage } from "@/lib/chat-usage";
import { logDebug } from "@/lib/logger";
import { createStallWatchdog, stallDetail, stallMessageFor } from "@/lib/chat-stall";
import { createStreamBudgetGuard } from "@/lib/chat-budget-guard";
import {
  AttachmentClaimError,
  DurableFirstSubmissionStartError,
  DurableReceiptLeaseLostError,
  appendFinishWarning,
  classifyErrorFinishReason,
  effectiveReasoningEffort,
  firstSubmissionRecoveryResponse,
  idempotencyKeyConflictResponse,
  plural,
  searchToolLabel,
  sourceHost,
} from "@/lib/chat-responses";
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
} from "@/lib/chat-first-submission";
import { findFirstSubmissionReceipt } from "@/lib/chat-first-submission-receipt";
import { legacyChatClientForOrigin } from "@/lib/chat-origin";
import {
  assistantTurnFields,
  assistantWriteMode,
  reasoningPartsColumn,
  versionSnapshot,
} from "@/lib/chat/assistant-turn";
import {
  applyHiddenUserContent,
  buildAttachmentContext,
  buildPrivateHistory,
  buildProjectContext,
  contextActivityDetail,
  historyWindowStart,
  HISTORY_LIMIT,
  promptChars,
  replaceLastUserTurn,
  type AttachmentKnowledge,
  type ProjectKnowledge,
} from "@/lib/chat/context-assembly";
import { retrieveAttachmentKnowledge, retrieveProjectKnowledge } from "@/lib/knowledge/retrieve";
import {
  codeSessionRefusal,
  emptySubmissionRefusal,
  privateAttachmentsRefusal,
  privateModeFeatureRefusal,
  type EntitlementRejection,
} from "@/lib/chat/entitlements";
import { postGenerationPlan } from "@/lib/chat/post-processing";
import { composeSystemPrompt } from "@/lib/chat/prompt-sections";
import { chatBodySchema } from "@/lib/chat/request";
import { isAttachmentParserPending, isAttachmentParserUnavailable } from "@/lib/attachment-context";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import {
  recoverFirstSubmission,
  type FirstSubmissionRecoveryPort,
} from "@/lib/chat/submission-recovery";
import {
  INTERNAL_ERROR_FAILURE_CODE,
  PERSISTENCE_FAILED_FAILURE_CODE,
  START_FAILED_FAILURE_CODE,
  resolveTerminalState,
  terminalFailureCode,
} from "@/lib/chat/terminal-state";
import type { ChatFinishReason, ClientActivityEvent, ClientToolDetail } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";

export const runtime = "nodejs";
// Self-hosted (a plain `next start` Node process on the VM) has NO per-request
// function timeout — the generation runs until the model finishes thinking.
// `maxDuration` is a Vercel-only directive that `next start` ignores, so we no
// longer set it: that is what removes the old 300s wall. The only remaining
// ceiling is nginx's proxy_read_timeout (3600s in deploy/nginx.conf.template),
// which the 15s SSE heartbeat below keeps resetting so it effectively never
// fires. Keep RECOVERY_WINDOW_MS in use-chat.ts in sync with that nginx value.

/**
 * What a deep-research turn is asked to produce: a short answer, then a long
 * document.
 *
 * The previous contract said "do not write the report directly in the chat" and
 * nothing else, so the whole turn was one artifact card and the conversation
 * itself said nothing. That is the wrong shape for the medium twice over: a
 * reader who asked a question got no answer in the place they asked it, and the
 * one artifact had to carry both the summary and the depth, so it opened on
 * neither. Every product that does this well — ChatGPT with canvas, Gemini with
 * its report pane, Claude with artifacts — answers in the thread and puts the
 * document beside it.
 *
 * So the contract is now explicitly two-part, and the brief half is specified
 * tightly: models left to "summarise briefly" reliably produce a preamble about
 * what the report contains rather than the finding itself, which is the one
 * thing the reader wanted in the thread.
 */
const RESEARCH_OUTPUT_CONTRACT = `# How to deliver this research

Produce TWO things, in this order, in a single reply.

## 1. The chat answer (before the artifact)
Answer the question directly, in 100–200 words of flowing prose.
- Lead with the finding itself — never with what the report contains. Do not write "This report examines…", "I researched…", or "Below you will find…".
- State the most important numbers, dates and names inline, with citations [n].
- If the evidence is genuinely contested or thin, say so in one clause rather than implying false confidence.
- No headings, no bullet lists, no title. Plain paragraphs only.
- This must stand on its own: a reader who never opens the report should still have a real answer.

## 2. The full report (the artifact)
Then output the complete, publication-grade report inside ONE artifact block:
<juno:artifact identifier="research-report" type="MARKDOWN" title="<a specific title naming the topic>" language="md">
…the entire report…
</juno:artifact>

The report is the long-form document described above: every section, every table, every citation. Do not abbreviate it because the chat answer already exists, and do not repeat the chat answer's wording as the report's opening — the report begins with its own title and executive summary.
Give the artifact a title naming the actual subject, not the words "Research Report".
Write nothing after the closing tag.`;

/**
 * A local-only provider for the authenticated browser gate.
 *
 * The browser suite must prove the real acceptance/persistence/SSE lifecycle
 * without making a release decision depend on a developer API key's quota or
 * billing state. This still runs through the normal chat route, database write,
 * durable receipt, and client stream; only the external model call is replaced.
 * The route enables it only in a non-production process when the test runner
 * opts in explicitly, so it cannot silently become a production fallback.
 */
async function* streamDeterministicSmokeResponse(prompt: string): AsyncGenerator<LlmEvent> {
  const requestedToken = prompt.match(/\bJUNO_[A-Z0-9_]+\b/g)?.at(-1);
  const answer = requestedToken ?? "JUNO_E2E_SMOKE_OK";
  const midpoint = Math.max(1, Math.floor(answer.length / 2));
  yield { type: "text", text: answer.slice(0, midpoint) };
  await Promise.resolve();
  yield { type: "text", text: answer.slice(midpoint) };
  yield { type: "usage", input: Math.max(1, Math.ceil(prompt.length / 4)), output: answer.length };
  yield { type: "finish", reason: "stop" };
}

/** Turns an entitlement verdict into the response it describes. */
function refuse(rejection: EntitlementRejection) {
  return NextResponse.json(rejection.body, { status: rejection.status });
}

/**
 * The assistant message a private turn reports.
 *
 * There is no row to serialise — nothing is stored — so the shape is built
 * here. It was built twice inside the branch, once for the completed turn and
 * once for a stopped one, and the two had to be kept identical by hand.
 */
function privateAssistantMessage(
  acc: GenerationAccumulator,
  model: string,
  usage: { totalInput: number; output: number; cost: number },
  finishReason: ChatFinishReason,
  activity: ClientActivityEvent[]
) {
  return {
    id: `private-${Date.now()}`,
    role: "ASSISTANT" as const,
    content: acc.text,
    reasoning: acc.reasoning || undefined,
    reasoningParts: acc.reasoningParts.length ? acc.reasoningParts : undefined,
    model,
    feedback: null,
    createdAt: new Date().toISOString(),
    attachments: [],
    sources: acc.sources.length ? acc.sources : undefined,
    activity,
    finishReason,
    promptTokens: usage.totalInput || undefined,
    completionTokens: usage.output || undefined,
    costUsd: usage.cost || undefined,
    ...cacheTokenFields(acc),
  };
}

/**
 * The prompt-cache split for a PRIVATE turn's `done` frame.
 *
 * Private mode stores nothing, so the accumulator is the only place these
 * counters ever exist and the frame is the only chance to report them. The
 * saved path deliberately does NOT use this any more: `Message` now has both
 * columns, so its frame is built from the persisted row via `serializeMessage`.
 * Spreading the accumulator over that would make the live frame right even when
 * the write went wrong — the failure would then surface only on reload, which
 * is precisely the bug this column set was added to fix.
 *
 * Absent when the provider reported nothing, so a client can tell "no cache"
 * apart from "this build/provider does not report it"; emitting 0 asserts a
 * miss that was never measured.
 */
function cacheTokenFields(acc: GenerationAccumulator): {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} {
  return {
    cacheReadTokens: acc.tokens.cacheReadTokens,
    cacheWriteTokens: acc.tokens.cacheWriteTokens,
  };
}

/**
 * One generation's connector transparency: which rows exist, what they may
 * carry, and how much of it in total.
 *
 * Built once per stream and used identically by BOTH streaming paths. The
 * private path currently passes `connectors: []` so no tool event can reach it
 * — it gets this code anyway rather than a comment saying it cannot happen,
 * because these two paths have drifted before and `stream-accumulator.ts`
 * exists because of it.
 *
 * ONE ROW PER CALL. The adapters emit two acts; this collapses them into a
 * single activity entry that is created when the model reaches for the tool and
 * COMPLETED IN PLACE when the connector answers. The entry object handed back
 * by `sendActivity` is the same object sitting in `activityLog`, which is what
 * gets persisted onto `Message.activity`, so mutating it and re-sending keeps
 * both the log's order and the completed payload. Pushing a second entry would
 * look right live and show every tool twice on reload.
 *
 * `createdAt` is deliberately not refreshed on completion: it is the instant
 * the call STARTED, and that is the only instant about this row that anything
 * measures from.
 *
 * A `result` whose `callId` has no open row is DROPPED, not turned into an
 * orphan row. An unpaired result is a bug in an adapter, and inventing a row
 * for it would hide that bug behind a plausible-looking panel entry.
 */
function createToolActivity(
  sender: Pick<SseSender, "send" | "sendActivity">,
  enabled: boolean
): {
  open(effect: { server: string; name: string; callId: string; args?: string }): void;
  close(effect: { server: string; name: string; callId: string; args?: string; result: string; ok: boolean; durationMs?: number }): void;
} {
  const budget = createToolDetailBudget();
  const rows = new Map<string, { entry: ClientActivityEvent; opened?: ClientToolDetail }>();

  return {
    open(effect) {
      const opened = enabled ? openToolDetail(effect, budget) : undefined;
      const entry = sender.sendActivity({
        kind: "tool",
        title: `Using ${effect.server}`,
        detail: effect.name,
        ...(opened ? { tool: opened } : {}),
      });
      // Tracked even when detail is disabled, so a later `result` is still
      // recognised as paired and silently dropped rather than half-handled.
      rows.set(effect.callId, { entry, opened });
    },
    close(effect) {
      const row = rows.get(effect.callId);
      if (!row) return;
      rows.delete(effect.callId);
      if (!enabled) return;
      row.entry.tool = closeToolDetail(row.opened, effect, budget);
      sender.send({ type: "activity", event: row.entry });
    },
  };
}

/**
 * The database side of idempotent submission recovery.
 *
 * Account-scoped by construction: the user id is bound once, here, rather than
 * repeated at four call sites — which is what makes a cross-account read
 * something you would have to go out of your way to write.
 */
function firstSubmissionRecoveryPort(userId: string): FirstSubmissionRecoveryPort {
  return {
    receiptForRequest: (clientRequestId) => findFirstSubmissionReceipt(userId, { clientRequestId }),
    receiptForMessage: (clientMessageId) =>
      prisma.chatFirstSubmissionReceipt.findUnique({
        where: { userId_clientMessageId: { userId, clientMessageId } },
        select: { conversationId: true },
      }),
    legacyConversation: (clientRequestId) =>
      prisma.conversation.findFirst({ where: { userId, clientRequestId }, select: { id: true } }),
    firstMessage: (conversationId) =>
      prisma.message.findFirst({
        where: { conversationId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, clientId: true },
      }),
  };
}

async function handleChat(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Admission: body size, JSON validity, schema, per-field limits — in that
  // order, and before anything touches the database or a provider. Extracted
  // whole into `chat-admission.ts` so the rules can be characterised without a
  // request, a session or a network.
  const rawBody = await req.text().catch(() => null);
  const admission = admitChatRequest(rawBody, (value) => chatBodySchema.safeParse(value));
  if (!admission.ok) {
    return NextResponse.json(admission.body, { status: admission.status });
  }
  const input = admission.input;
  const deterministicSmokeProviderEnabled =
    process.env.JUNO_E2E_SMOKE_PROVIDER === "1" && process.env.NODE_ENV !== "production" && !input.privateMode;

  // Valid durable retries are recovered here, before rate limiting; a legacy
  // caller without both keys falls through and keeps the historical order.
  let firstSubmissionHash: string | null = null;
  let legacyOrphanConversationId: string | null = null;
  if (input.clientRequestId && input.clientMessageId) {
    firstSubmissionHash = hashFirstSubmission(input);
    const verdict = await recoverFirstSubmission(firstSubmissionRecoveryPort(user.id), {
      clientRequestId: input.clientRequestId,
      clientMessageId: input.clientMessageId,
      requestHash: firstSubmissionHash,
    });
    if (verdict.kind === "recovered") return firstSubmissionRecoveryResponse(verdict.recovery);
    if (verdict.kind === "conflict") {
      return idempotencyKeyConflictResponse(verdict.conversationId, verdict.legacyReceiptMissing);
    }
    legacyOrphanConversationId = verdict.legacyOrphanConversationId;
  }

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `chat:${user.id}`, limit: 30, windowSec: 60 });
    if (!limit.success) {
      return NextResponse.json({ error: "You're sending messages too quickly. Please slow down." }, { status: 429 });
    }
  }

  const legacyClient = legacyChatClientForOrigin(input);

  const admissible = privateAttachmentsRefusal(input) ?? emptySubmissionRefusal(input);
  if (admissible) return refuse(admissible);

  // Build private model history once, before moderation, so the policy screen
  // sees the exact user turns the provider will receive (including preflight
  // clarification content replacing the last private user turn).
  const basePrivateHistory = input.privateMode
    ? buildPrivateHistory(input.privateHistory, HISTORY_LIMIT)
    : [];
  const privateHistory: MessageForModel[] =
    input.privateMode && (input.clarification || input.preflightClarification)
      ? replaceLastUserTurn(
          basePrivateHistory,
          input.clarification
            ? formatClarificationModelMessage(input.clarification)
            : formatPreflightClarificationModelMessage(input.preflightClarification!)
        )
      : basePrivateHistory;

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
  // "juno:auto" is a routing sentinel: classify the prompt and pick the cheapest
  // chat model that can handle it (vision / web-search constraints applied).
  const settings = await prisma.settings.findUnique({ where: { userId: user.id } });

  /*
   * Whether the thought-process panel receives connector ARGUMENTS and RESULTS
   * rather than only the tool's name.
   *
   * Read ONCE, here, before the stream, and passed into the emitter as a
   * boolean. It is never a client-side filter: data that must not be shown is
   * data that must not be SENT.
   *
   * Lockdown is a hard override. It already means "a hard network/tool stop",
   * and it must not be the mode in which Juno gets chattier about what its
   * connectors returned.
   */
  const toolDetailEnabled = !settings?.lockdownMode;

  const requestedId =
    input.model && isModelId(input.model)
      ? input.model
      : settings?.defaultModel && isModelId(settings.defaultModel)
        ? settings.defaultModel
        : DEFAULT_MODEL;

  let modelInfo: ModelInfo | undefined;
  /** When Auto routes, override the client's thinking slider with the pick. */
  let autoReasoningEffort: import("@/types/chat").ReasoningEffort | null | undefined;
  /**
   * Why this model, in one line, streamed to the user as an activity event.
   *
   * "Auto" previously logged its reasoning server-side and told the user
   * nothing — so a router that picked badly, or a reroute off a dead provider,
   * was indistinguishable from the product being slow or dumb. Routing you can
   * see is the point of routing you can trust.
   */
  let routingNote: string | null = null;
  /** Set when the model actually used is NOT the one that was asked for. */
  let routingWarning: string | null = null;
  if (isAutoModelId(requestedId)) {
    const routingMessage =
      input.preflightClarification
        ? formatPreflightClarificationModelMessage(input.preflightClarification)
        : input.clarification
          ? formatClarificationModelMessage(input.clarification)
          : input.message?.trim() ||
            (input.privateMode
              ? [...privateHistory].reverse().find((m) => m.role === "USER")?.content ?? ""
              : "");
    let hasImages = false;
    if ((input.attachmentIds?.length ?? 0) > 0) {
      const imageHit = await prisma.attachment.findFirst({
        where: { id: { in: input.attachmentIds! }, userId: user.id, kind: "IMAGE", deletedAt: null },
        select: { id: true },
      });
      hasImages = !!imageHit;
    }
    try {
      const pick = pickAutoModel({
        message: routingMessage,
        plan,
        hasImages,
        wantsWebSearch: !!input.webSearch,
      });
      modelInfo = pick.model;
      autoReasoningEffort = pick.reasoningEffort;
      routingNote = `Auto picked ${pick.model.name} — ${pick.complexity.level} prompt${
        pick.complexity.reasons.length ? ` (${pick.complexity.reasons.slice(0, 2).join(", ")})` : ""
      }`;
      logDebug("chat.auto", {
        level: pick.complexity.level,
        minIntelligence: pick.complexity.minIntelligence,
        reasons: pick.complexity.reasons,
        picked: modelInfo.id,
        reasoning: pick.reasoningEffort ?? "instant",
        candidates: pick.candidatesConsidered,
      });
    } catch (err) {
      console.error("[chat:auto] routing failed", err);
      modelInfo = undefined;
    }
  } else {
    modelInfo = getModel(requestedId);
  }

  let eligible: (model: ModelInfo) => boolean;
  if (deterministicSmokeProviderEnabled) {
    // Keep the requested model's identity in receipts and UI diagnostics while
    // replacing only the external generation call below. This makes the E2E
    // fixture exercise the same selected-model serialization as production.
    modelInfo = modelInfo ?? getModel(DEFAULT_MODEL);
    routingNote = "Deterministic browser smoke provider";
    eligible = () => true;
  } else {
    // Capability evidence is short-lived and model-specific. Loading it once
    // keeps every fallback decision in this request on the same snapshot: a
    // model cannot pass the explicit-selection check and fail the platform
    // budget degradation check because two probes changed between them.
    const capabilityProbes = await loadModelCapabilityMap(MODEL_LIST.map((model) => model.id));

    // Eligibility and fallback now live in `lib/model-selection.ts`. The rules
    // decide what a turn costs, and inline here they were reachable only by
    // standing up a request with auth, quota and a database behind it.
    //
    // `pickAutoModel` does not consult provider health, so Auto lands in the same
    // reroute branch as an explicit selection on a dead provider.
    eligible = (m: ModelInfo) =>
      m.modality === "chat" &&
      !m.comingSoon &&
      !isAutoModelId(m.id) &&
      isProviderConfigured(m.provider) &&
      canUseModel(plan, m.id) &&
      modelCanRoute(m, capabilityProbes);

    const selection = selectModel<ModelInfo>({
      requestedId,
      requested: modelInfo && !isAutoModelId(modelInfo.id) ? modelInfo : null,
      catalogue: MODEL_LIST,
      isEligible: eligible,
      isProviderHealthy: (provider) => providerHealthy(provider as Provider),
    });
    if (selection.reason === "rerouted_unhealthy_provider") {
      console.warn("[chat] rerouting off an unhealthy provider", {
        from: modelInfo?.id,
        to: selection.model?.id,
        provider: modelInfo?.provider,
      });
    }
    modelInfo = selection.model ?? undefined;
    routingWarning = selection.warning ?? routingWarning;
  }
  // Platform-wide daily spend ceiling (off unless PLATFORM_DAILY_BUDGET_USD is
  // set). Degrade to the cheapest capable model rather than refusing: a slower
  // answer beats a 500, and it keeps the product usable while an operator
  // decides what to do. Per-user budgets are enforced separately by checkBudget.
  if (!deterministicSmokeProviderEnabled && modelInfo && (await isPlatformBudgetExceeded())) {
    const cheapest =
      cheapestEligible(MODEL_LIST, eligible, (p) => providerHealthy(p as Provider));
    if (cheapest && cheapest.cost < modelInfo.cost) {
      console.warn("[chat] platform budget exceeded — degrading model", {
        from: modelInfo.id,
        to: cheapest.id,
      });
      routingWarning = `Answered with ${cheapest.name} to stay within today's capacity.`;
      modelInfo = cheapest;
    }
  }

  if (!modelInfo) {
    const msg =
      configuredProviders().length === 0
        ? "No AI model providers are configured. Add at least one provider API key (e.g. ANTHROPIC_API_KEY)."
        : "No AI model is available for your plan. Upgrade, or configure a provider with a model your plan allows.";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
  const modelId = modelInfo.id;
  // Persist the user's *selection* on the conversation (keep Auto sticky). The
  // concrete `modelId` is what every generation / message version records.
  const conversationModelId = isAutoModelId(requestedId) ? AUTO_MODEL_ID : modelId;

  // Linked tool connectors (GitHub/Figma…) the user enabled for this message.
  // Never honored in private mode — they'd send the message to a third party.
  const activeConnectors =
    !input.privateMode && input.connectors?.length ? await getActiveConnectors(user.id, input.connectors) : [];

  if (input.privateMode) {
    const unavailable = privateModeFeatureRefusal(input);
    if (unavailable) return refuse(unavailable);

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
    const useProMode = !!input.proMode && supportsProMode(modelInfo);
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
      // Private mode still reaches provider-side web search, whose results are
      // outside content like any other.
      untrustedContent: useWebSearch,
    });
    // Same composition the saved path uses. The two used to be hand-written
    // expressions that happened to agree.
    const system = composeSystemPrompt({ base: baseSystem, webSearch: useWebSearch, canvasOn: false });
    const generationId = input.generationId ?? crypto.randomUUID();
  /*
     * Hold this turn's estimated cost against the ceiling for as long as it runs.
     *
     * `checkBudget` above is read-then-act: it reads SETTLED spend, and the
     * ledger is only written when a turn ENDS, so the window in which two turns
     * can both be admitted is the whole duration of every in-flight generation.
     * The hold closes it — `checkBudget` subtracts open reservations, so the next
     * turn sees this one coming.
     *
     * Deliberately NOT a second gate. This turn was already admitted, and
     * refusing it here would mean unwinding an accepted durable receipt; a
     * refused hold simply means no headroom was taken and nothing to settle. The
     * hold is settled by `recordSpend` below, which is the one place every
     * streaming path passes through.
     */
    await reserveSpend({ userId: user.id, kind: "chat", ref: generationId, plan });
    const generationController = new AbortController();
    const unregisterGeneration = registerGeneration(generationId, {
      userId: user.id,
      controller: generationController,
      model: modelId,
      conversationId: "private",
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const { send, sendActivity, activityLog } = createSseSender(controller);
        // Identical to the saved path's. This branch passes `connectors: []`,
        // so no tool event can reach it today — it gets the same code rather
        // than a comment claiming that, because the two paths have drifted
        // before.
        const toolActivity = createToolActivity({ send, sendActivity }, toolDetailEnabled);
        // One accumulator for text, reasoning, sources, usage and served speed
        // — the same one the saved path folds its stream into.
        const acc = new GenerationAccumulator({ requestedFastMode: useFastMode });
        let spendRecorded = false;
        const privatePromptChars = () => promptChars(system, privateHistory);

        send({ type: "meta", conversationId: "private", userMessageId: null, title: "Private chat", generationId });
        // Heartbeat: models with hidden reasoning can stream nothing for
        // minutes; periodic pings keep proxies from dropping the idle SSE.
        const heartbeat = setInterval(() => send({ type: "ping" }), 15_000);
        // The try starts HERE, immediately after the interval exists, not 60
        // lines further down at the streaming loop. Everything between — model
        // resolution, the budget guard's setup, the activity preamble — used to
        // run unprotected, and the `finally` that clears this interval and calls
        // unregisterGeneration lives inside the try. A throw in that window
        // leaked a 15s timer for the life of the process and left the
        // generation registered forever. The normal path has an equivalent
        // top-level handler on its stream; this branch had none.
        //
        // Declared out here because the catch below reads it to tell a
        // budget-triggered abort from a real failure.
        let budgetHalted = false;
        // Same reason: the catch reads `stalled` to tell a wedged provider from
        // a user Stop. Nothing else bounds a stream that goes quiet — the SDK
        // timeout is cleared once headers arrive, and Juno's own 15s SSE
        // heartbeat keeps nginx's read timer from ever expiring.
        const stallWatchdog = createStallWatchdog(() => {
          sendActivity({
            kind: "warning",
            title: "Model stopped responding",
            detail: stallDetail(PROVIDERS[modelInfo.provider].label, stallWatchdog),
          });
          generationController.abort();
        });
        try {
          sendActivity({
            kind: "context",
            title: "Reading private context",
            detail: `${plural(privateHistory.length, "message")} · not stored`,
          });
          sendActivity({
            kind: "model",
            title: "Selected model",
            detail: routingNote ?? `${PROVIDERS[modelInfo.provider].label} · ${modelInfo.name}`,
          });
          if (routingWarning) {
            sendActivity({ kind: "warning", title: "Model changed", detail: routingWarning });
          }
          if (activeConnectors.length) {
            // Private chats reach no connector. An approval receipt is a durable
            // security record — it names the connector, the tool, and redacted
            // arguments — and writing one is exactly the persistence a private
            // chat promises not to do. Rather than persist it anyway or run the
            // call unbrokered, private mode declines the capability and says so.
            // (`streamChat` also refuses tools without an audit identity, so this
            // is the honest label on a refusal that already happens, not a new
            // restriction.)
            sendActivity({
              kind: "warning",
              title: "Connected tools are off in private chat",
              detail: `${activeConnectors.map((c) => c.label).join(" · ")} — approving an action would have to be recorded.`,
            });
          }
          const reasoningEffort = effectiveReasoningEffort(
            modelInfo,
            autoReasoningEffort !== undefined ? autoReasoningEffort ?? undefined : input.reasoningEffort
          );
          if (reasoningEffort) {
            sendActivity({
              kind: "reasoning",
              title: isAutoModelId(requestedId) ? "Auto thinking" : "Reasoning mode enabled",
              detail: `${reasoningEffort[0].toUpperCase()}${reasoningEffort.slice(1)} effort`,
            });
          } else if (isAutoModelId(requestedId)) {
            sendActivity({
              kind: "reasoning",
              title: "Auto thinking",
              detail: "Instant — no extra reasoning for this prompt",
            });
          }
          if (useWebSearch) {
            sendActivity({
              kind: "search",
              title: "Preparing web search",
              detail: searchToolLabel(modelInfo.provider),
            });
          }

          // Hard mid-stream budget ceiling: the instant the running cost of THIS
          // generation would push the user past their remaining plan budget, abort
          // the provider stream so they cannot be billed a cent beyond it.
          const budgetGuard = createStreamBudgetGuard({
            ceilingMicroUsd: budget.remainingMicroUsd,
            rates: modelRatesMicroUsdPerToken(modelId),
            inputChars: privatePromptChars(),
            usage: () => ({
              promptTokens: acc.tokens.promptTokens,
              completionTokens: acc.tokens.completionTokens,
              outputChars: acc.text.length,
              reasoningChars: acc.reasoning.length,
            }),
            onHalt: () => {
              budgetHalted = true;
              sendActivity({ kind: "warning", title: "Usage limit reached", detail: "Stopped to stay within your plan’s budget." });
              generationController.abort();
            },
          });
          const enforceStreamBudget = () => budgetGuard.enforce();

          for await (const ev of streamChat({
            model: modelInfo,
            system,
            history: privateHistory,
            maxTokens: PLANS[plan].maxOutputTokens,
            signal: generationController.signal,
            reasoningEffort,
            webSearch: useWebSearch,
            // Deliberately empty — see the warning above. Passing them would only
            // reach `streamChat`'s "connectors without an audit identity" branch,
            // which logs the same refusal as an internal bug.
            connectors: [],
            dynamicContext: buildDynamicContext(),
            // Private chats have no stable conversation id; group the cache by
            // user (their system prompt is the shared prefix).
            cacheKey: `private-${user.id}`,
            fastMode: useFastMode,
            proMode: useProMode,
          })) {
            stallWatchdog.touch();
            const effect = acc.apply(ev);
            if (effect.kind === "text") {
              if (effect.startedWriting) {
                sendActivity({ kind: "write", title: "Writing the private answer", detail: "Streaming response text" });
              }
              send({ type: "delta", text: effect.text });
              enforceStreamBudget();
            } else if (effect.kind === "tool_call") {
              toolActivity.open(effect);
            } else if (effect.kind === "tool_result") {
              toolActivity.close(effect);
            } else if (effect.kind === "reasoning") {
              // `part` rides the SSE so the panel can build steps AS THEY
              // ARRIVE, from the same boundaries the API gave the adapter.
              send({ type: "reasoning", text: effect.text, part: effect.part });
              enforceStreamBudget();
            } else if (effect.kind === "sources") {
              for (const source of effect.added) {
                sendActivity({
                  kind: "visit",
                  title: "Visited source",
                  detail: truncate(source.title && source.title !== source.url ? source.title : sourceHost(source.url), 96),
                  url: source.url,
                });
              }
              if (effect.all.length) send({ type: "sources", sources: effect.all });
            } else if (effect.kind === "usage") {
              enforceStreamBudget();
            }
          }
          // Provider done — stop measuring silence before Juno's own work. See
          // the same call on the persisted path.
          stallWatchdog.stop();

          const finishReason = acc.finishReason;
          const usage = buildUsage(modelInfo, acc.rawUsage({ promptChars: privatePromptChars() }), acc.servedFast);
          if (usage.totalInput || usage.output) {
            sendActivity({ kind: "usage", title: "Token usage recorded", detail: usage.detail });
          }
          appendFinishWarning(finishReason, sendActivity);
          sendActivity({
            kind: "done",
            title: finishReason === "stop" ? "Finished private response" : finishReasonTitle(finishReason),
            detail: acc.sources.length ? plural(acc.sources.length, "source") : "Not saved",
          });

          send({
            type: "done",
            message: privateAssistantMessage(acc, modelId, usage, finishReason, activityLog),
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
            ref: generationId,
            promptTokens: usage.totalInput || undefined,
            completionTokens: usage.output || undefined,
            reasoningTokens: acc.tokens.reasoningTokens || undefined,
            totalTokens: acc.tokens.totalTokens || undefined,
            cacheRead: acc.tokens.cacheReadTokens,
            cacheWrite: acc.tokens.cacheWriteTokens,
            cacheWrite5m: acc.tokens.cacheWrite5mTokens,
            cacheWrite1h: acc.tokens.cacheWrite1hTokens,
            webSearchRequests: acc.tokens.webSearchRequests,
            xSearchRequests: acc.tokens.xSearchRequests,
            costUsd: usage.cost || undefined,
            promptChars: privatePromptChars(),
            completionChars: acc.text.length,
            reasoningChars: acc.reasoning.length,
            fastMode: acc.servedFast,
          });
          spendRecorded = true;
          console.info("[chat] private generation complete", {
            generationId,
            provider: modelInfo.provider,
            model: modelInfo.providerModel,
            finishReason,
            promptTokens: acc.tokens.promptTokens ?? null,
            completionTokens: acc.tokens.completionTokens ?? null,
            cacheReadTokens: acc.tokens.cacheReadTokens ?? null,
            cacheWriteTokens: acc.tokens.cacheWriteTokens ?? null,
            webSearchRequests: acc.tokens.webSearchRequests ?? null,
          });
        } catch (err) {
          // One terminal-state model, shared with the saved path. A stall must
          // be classified BEFORE the stop cases: aborting the controller makes
          // the SDK throw its own user-abort error, so without that ordering a
          // wedged provider is recorded and shown as though the user had
          // pressed Stop. A budget-triggered abort saves the partial answer and
          // bills it, exactly like a user-initiated stop.
          const terminal = resolveTerminalState(
            {
              stalled: stallWatchdog.stalled,
              budgetHalted,
              userStopped: wasGenerationStopped(generationId),
              leaseLost: false,
              error: err,
            },
            { hasText: !!acc.text, hasReasoning: !!acc.reasoning, artifactEdit: false }
          );
          const reason = terminal.finishReason;
          console.error("[chat] private generation error", {
            generationId,
            provider: modelInfo.provider,
            model: modelInfo.providerModel,
            finishReason: reason,
            message: err instanceof Error ? err.message : String(err),
          });
          if (terminal.persistsPartial) {
            appendFinishWarning(reason, sendActivity);
            const partialUsage = buildUsage(
              modelInfo,
              acc.rawUsage({ promptChars: privatePromptChars() }),
              acc.servedFast
            );
            send({
              type: "done",
              message: privateAssistantMessage(acc, modelId, partialUsage, reason, activityLog),
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
                ref: generationId,
                promptTokens: partialUsage.totalInput || undefined,
                completionTokens: partialUsage.output || undefined,
                reasoningTokens: acc.tokens.reasoningTokens || undefined,
                totalTokens: acc.tokens.totalTokens || undefined,
                cacheRead: acc.tokens.cacheReadTokens,
                cacheWrite: acc.tokens.cacheWriteTokens,
                cacheWrite5m: acc.tokens.cacheWrite5mTokens,
                cacheWrite1h: acc.tokens.cacheWrite1hTokens,
                webSearchRequests: acc.tokens.webSearchRequests,
                xSearchRequests: acc.tokens.xSearchRequests,
                costUsd: partialUsage.cost || undefined,
                promptChars: privatePromptChars(),
                completionChars: acc.text.length,
                reasoningChars: acc.reasoning.length,
                fastMode: acc.servedFast,
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
            const quota = terminal.refunds
              ? await refundMessage(user.id, plan).catch(() => consumed.quota)
              : consumed.quota;
            const message = stallWatchdog.stalled
              ? stallMessageFor(stallWatchdog)
              : reason === "user_stopped"
                ? "Generation stopped before any output."
                : providerErrorMessage(err, PROVIDERS[modelInfo.provider].label);
            sendActivity({
              kind: "warning",
              title: finishReasonTitle(reason),
              detail: message,
            });
            send({ type: "error", message, quota, finishReason: reason });
          }
        } finally {
          stallWatchdog.stop();
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
    if (postGenerationPlan({ moderate, memoryEnabled: false, producedAnswer: false }).moderates) {
      // redactPreview stays — private content must never reach a flag preview
      // (tests/chat-moderation.test.ts pins this). The .catch does not: without
      // it a moderation failure here is an unhandled rejection, where the saved
      // path has always swallowed its own.
      after(() =>
        moderateUserMessages({ userId: user.id, texts: moderationTexts, redactPreview: true }).catch(() => {})
      );
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
  // Refused here so no client path can bill a Code session against chat models
  // or append chat-generated messages to it. The rule, and why a workspaceless
  // Code conversation is the exception, is stated in chat/entitlements.
  const codeSession = codeSessionRefusal(conversation);
  if (codeSession) return refuse(codeSession);
  let artifactEditTarget: (ArtifactSourceForEdit & { id: string }) | null = null;
  if (input.artifactEdit) {
    if (!conversation) {
      return NextResponse.json({ error: "Open the saved canvas before editing a selection." }, { status: 400 });
    }
    const artifact = await prisma.artifact.findFirst({
      where: {
        id: input.artifactEdit.artifactId,
        identifier: input.artifactEdit.identifier,
        conversationId: conversation.id,
        conversation: { userId: user.id },
      },
      include: {
        versions: { where: { version: input.artifactEdit.baseVersion }, take: 1 },
      },
    });
    if (!artifact) {
      return NextResponse.json({ error: "The selected canvas could not be found in this chat." }, { status: 404 });
    }
    if (artifact.currentVersion !== input.artifactEdit.baseVersion || !artifact.versions[0]) {
      return NextResponse.json(
        { error: "This canvas changed after you made the selection. Select the part again before editing it." },
        { status: 409 }
      );
    }
    artifactEditTarget = {
      id: artifact.id,
      identifier: artifact.identifier,
      title: artifact.title,
      type: artifact.type,
      language: artifact.language,
      version: artifact.currentVersion,
      content: artifact.versions[0].content,
    };
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
              model: conversationModelId,
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
            where: { id: { in: attachmentIds }, userId: user.id, messageId: null, deletedAt: null },
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
        model: conversationModelId,
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
            where: { id: { in: attachmentIds }, userId: user.id, messageId: null, deletedAt: null },
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
  // regenerated. `historyWindowStart` anchors the window to blocks so the
  // prompt prefix stays cache-stable across turns — see chat/context-assembly.
  const totalMessages = await prisma.message.count({ where: { conversationId: conversation.id } });
  const recent = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    include: { attachments: { where: { deletedAt: null } } },
    skip: historyWindowStart(totalMessages),
  });
  const history = recent
    .filter((m) => m.id !== staleAssistantId)
    .map((m) => ({ ...m, content: decryptMessageText(m.content) }));
  const modelHistory = applyHiddenUserContent(
    history,
    userMessageId,
    clarificationModelContent ?? preflightClarificationModelContent
  );

  const memoryEnabled = settings?.memoryEnabled ?? true;
  // The consolidated summary carries settled account-wide memory; `recent` is
  // the individually-selected entries on top of it — ranked against what the
  // user just asked, scoped to this conversation's project, and cut to a token
  // budget. `used` names them, which is what the memory receipt below reports.
  const latestUserMessage = [...modelHistory].reverse().find((m) => m.role === "USER")?.content;
  const memoryProfile = memoryEnabled
    ? await getMemoryProfile(user.id, { projectId: conversation.projectId, query: latestUserMessage })
    : { summary: null, recent: [], used: [], usedTokens: 0, droppedForBudget: 0 };

  // Project context: instructions + reference file contents injected into the system prompt.
  //
  // Reference files go in wholesale, which is correct while a project holds a
  // handful of them and stops being correct the moment it holds a library. So
  // where a project's documents have been indexed (lib/knowledge), the relevant
  // extracts are retrieved for THIS question and the wholesale dump of those
  // files is dropped — the prompt then grows with the question rather than with
  // the library, and every extract carries the page it came from.
  //
  // The boundary is deliberately narrow. `retrieveProjectKnowledge` returns
  // null after one indexed lookup when the project has nothing indexed, and
  // `buildProjectContext` called without a knowledge argument is byte-identical
  // to what it produced before any of this existed. Retrieval failing, or the
  // background-provider policy permitting no embedding provider, both degrade
  // to that same prior behaviour rather than to a dead turn.
  const projectRow = conversation.projectId
    ? await prisma.project.findUnique({
        where: { id: conversation.projectId },
        select: { name: true, instructions: true, files: { select: { fileName: true, extractedText: true } } },
      })
    : null;
  const knowledgeQuery =
    [...modelHistory].reverse().find((m) => m.role === "USER")?.content ?? input.message?.trim() ?? "";
  let projectKnowledge: ProjectKnowledge | null = null;
  if (conversation.projectId && projectRow) {
    if (knowledgeQuery) {
      try {
        const retrieved = await retrieveProjectKnowledge({
          userId: user.id,
          projectId: conversation.projectId,
          query: knowledgeQuery,
          policy: await loadBackgroundProviderPolicy(user.id),
          // Embedding the question is background work on the user's content, so
          // it answers to the same provider policy as everything else — and
          // `same_provider` means the provider they picked for this turn.
          conversationProvider: modelInfo.provider,
        });
        if (retrieved && retrieved.passages.length > 0) {
          projectKnowledge = {
            passages: retrieved.passages,
            indexedFileNames: retrieved.indexedFileNames,
            degraded: retrieved.mode === "lexical",
          };
        }
      } catch (error) {
        console.error("[chat] project knowledge retrieval failed", {
          conversationId: conversation.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const projectContext = buildProjectContext(projectRow, projectKnowledge);

  // A file attached directly to a conversation may have no project at all.
  // Retrieve its indexed passages by the durable attachment → document join so
  // provider choice no longer decides whether a PDF can be understood. Files
  // still in the parser queue are named explicitly below; a filename-only
  // placeholder is not an honest answer to a user who just uploaded a file.
  const directAttachments = modelHistory
    .flatMap((message) => message.attachments)
    .filter((attachment) => attachment.projectId == null && !attachment.deletedAt);
  let attachmentKnowledge: AttachmentKnowledge | null = null;
  if (directAttachments.length > 0 && knowledgeQuery) {
    try {
      const retrieved = await retrieveAttachmentKnowledge({
        userId: user.id,
        attachmentIds: directAttachments.map((attachment) => attachment.id),
        query: knowledgeQuery,
        policy: await loadBackgroundProviderPolicy(user.id),
        conversationProvider: modelInfo.provider,
      });
      const pendingFiles = directAttachments
        .filter((attachment) => isAttachmentParserPending(attachment.parserState))
        .map((attachment) => ({ fileName: attachment.fileName, state: attachment.parserState }));
      const unavailableFiles = directAttachments
        .filter((attachment) => isAttachmentParserUnavailable(attachment.parserState))
        .map((attachment) => ({ fileName: attachment.fileName, state: attachment.parserState }));
      if (retrieved || pendingFiles.length > 0 || unavailableFiles.length > 0) {
        attachmentKnowledge = {
          passages: retrieved?.passages ?? [],
          indexedFileNames: retrieved?.indexedFileNames ?? [],
          degraded: retrieved?.mode === "lexical",
          pendingFiles,
          unavailableFiles,
        };
      }
    } catch (error) {
      console.error("[chat] attachment knowledge retrieval failed", {
        conversationId: conversation.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const attachmentContext = buildAttachmentContext(attachmentKnowledge);
  const promptContext = [projectContext, attachmentContext].filter(Boolean).join("\n\n");

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
  const useProMode = !!input.proMode && supportsProMode(modelInfo);

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
    projectContext: promptContext,
    // Any of these can put text Juno did not author into context: a connector
    // tool result, provider-side web search, or a fetched research page.
    // (Deep research also carries the rule in its own system append, since that
    // corpus is assembled separately.)
    untrustedContent:
      activeConnectors.length > 0 ||
      useWebSearch ||
      researchActive ||
      !!projectKnowledge ||
      !!attachmentKnowledge,
  });
  const targetedArtifactEditPrompt =
    artifactEditTarget && input.artifactEdit
      ? buildArtifactEditPrompt(artifactEditTarget, input.artifactEdit)
      : null;
  const system = composeSystemPrompt({
    base: baseSystem,
    webSearch: useWebSearch,
    targetedArtifactEditPrompt,
    canvasOn,
  });
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
  /*
   * Hold this turn's estimated cost against the ceiling for as long as it runs.
   *
   * `checkBudget` above is read-then-act: it reads SETTLED spend, and the
   * ledger is only written when a turn ENDS, so the window in which two turns
   * can both be admitted is the whole duration of every in-flight generation.
   * The hold closes it — `checkBudget` subtracts open reservations, so the next
   * turn sees this one coming.
   *
   * Deliberately NOT a second gate. This turn was already admitted, and
   * refusing it here would mean unwinding an accepted durable receipt; a
   * refused hold simply means no headroom was taken and nothing to settle. The
   * hold is settled by `recordSpend` below, which is the one place every
   * streaming path passes through.
   */
  await reserveSpend({ userId: user.id, kind: "chat", ref: generationId, plan });
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
  // The chat route no longer picks the background model itself. It used to hand
  // `utilityModelCandidates()[0]` to maybeConsolidate, which then treated that
  // model's provider as the one to match `same_provider` against — the worker
  // vouching for itself. Choosing the model is runUtilityPrompt's job, after
  // the background-provider policy has narrowed the field; this route's only
  // contribution is naming the provider the user chose for the conversation.
  /*
   * Set only on a deep-research turn that produced an answer. The citation audit
   * (§8.3) runs in `after`, not inline: it re-reads every cited passage with a
   * utility model, which is far too slow to hold the stream open for, and the
   * report is already correct-or-not by the time it is written — checking it
   * later changes what the reader is TOLD about it, not what it says.
   */
  let citationAuditInput: {
    goal: string;
    corpus: ResearchCorpusPage[];
    conversationProvider: string | null;
    runId: string | null;
  } | null = null;
  let auditedMessageId: string | null = null;
  let researchGenerationPartial = false;


  // Generation + persistence is detached from the request lifecycle: we do not
  // pass req.signal to the model, so navigating away can drop the browser stream
  // without losing the saved answer. The explicit cancel endpoint aborts it.
  let generationHeartbeat: ReturnType<typeof setInterval> | null = null;
  let lastReceiptLeaseHeartbeat = Date.now();
  const generate = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
      // Once the client disconnects the controller is closed; swallow the enqueue
      // error so generation and persistence keep running regardless.
      const { send, sendActivity, activityLog } = createSseSender(controller);
      const toolActivity = createToolActivity({ send, sendActivity }, toolDetailEnabled);
      // One accumulator for text, reasoning, sources, usage and served speed —
      // the same one the private branch folds its stream into.
      const acc = new GenerationAccumulator({ requestedFastMode: useFastMode });
      let targetedArtifactContent: string | null = null;
      let spendRecorded = false;

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
        /**
         * The provider-reported prompt-cache split. Taken from the accumulator
         * rather than from `buildUsage`, which clamps every absent bucket to 0
         * for display arithmetic — persisting that would write "cache miss" for
         * providers that simply never report the split.
         */
        cacheReadTokens?: number | null;
        cacheWriteTokens?: number | null;
        /** Exact generation cost (tokens + cache + tool fees), micro-USD. */
        costMicroUsd?: number | null;
      }) => {
        // The stale row can vanish mid-generation — deleted from another tab,
        // or with the whole conversation — and when it does this appends
        // rather than failing. See chat/assistant-turn for the write rules.
        const stale = staleAssistantId
          ? await prisma.message.findUnique({ where: { id: staleAssistantId } })
          : null;
        const mode = assistantWriteMode(staleAssistantId, !!stale);
        const parts = reasoningPartsColumn(data.reasoningParts, encryptMessageText, mode);
        const base = {
          ...assistantTurnFields({ ...data, model: modelId }, encryptMessageText),
          activity: activityLog as unknown as Prisma.InputJsonValue,
        };
        const sources = acc.sources;
        // Metadata for the pager rides along on the done chunk.
        const include = {
          attachments: { where: { deletedAt: null } },
          versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
        };
        if (mode === "supersede" && stale) {
          // Snapshot the answer being replaced BEFORE overwriting it — a
          // regenerate must never lose what the user already had. Atomic with
          // the overwrite so a crash can't leave a duplicate version behind.
          const [, , updated] = await prisma.$transaction([
            prisma.messageVersion.create({
              data: versionSnapshot({
                ...stale,
                sources: stale.sources as unknown as Prisma.InputJsonValue | null,
              }),
            }),
            prisma.artifact.deleteMany({ where: { messageId: stale.id } }),
            prisma.message.update({
              where: { id: stale.id },
              data: {
                ...base,
                reasoning: data.reasoning ? encryptMessageText(data.reasoning) : null,
                // CLEAR, never skip — see reasoningPartsColumn. A regenerate can
                // swap a part-emitting model for one that sends none, and leaving
                // the old array behind shows the PREVIOUS answer's steps above the
                // new one's reasoning.
                reasoningParts:
                  parts.action === "set"
                    ? (parts.values as unknown as Prisma.InputJsonValue)
                    : Prisma.DbNull,
                feedback: null, // a fresh answer starts with clean feedback
                sources: sources.length ? (sources as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
                createdAt: new Date(), // the timestamp reflects the current version
              },
              include,
            }),
          ]);
          return updated;
        }
        return prisma.message.create({
          data: {
            conversationId,
            role: "ASSISTANT",
            ...base,
            ...(data.reasoning ? { reasoning: encryptMessageText(data.reasoning) } : {}),
            ...(parts.action === "set"
              ? { reasoningParts: parts.values as unknown as Prisma.InputJsonValue }
              : {}),
            ...(sources.length ? { sources: sources as unknown as Prisma.InputJsonValue } : {}),
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

      sendActivity({
        kind: "context",
        title: input.regenerate ? "Rebuilding the conversation context" : "Reading the conversation context",
        detail: contextActivityDetail({
          messages: modelHistory.length,
          attachments: modelHistory.reduce((sum, msg) => sum + msg.attachments.length, 0),
          memories: memoryEnabled ? memoryProfile.recent.length : 0,
          hasProjectContext: !!projectContext,
          hasAttachmentContext: !!attachmentContext,
          documentPassages: (projectKnowledge?.passages.length ?? 0) + (attachmentKnowledge?.passages.length ?? 0),
        }),
      });
      // The memory receipt. A count ("3 memories") tells the user nothing they
      // can act on; naming the facts is what lets them notice a wrong one and
      // say so. Only sent when memory actually contributed — an empty line
      // every turn would train people to stop reading the trail.
      if (memoryEnabled && memoryProfile.used.length > 0) {
        sendActivity({
          kind: "context",
          title: "Remembered about you",
          detail: memoryReceiptDetail({
            selected: memoryProfile.used,
            droppedForBudget: memoryProfile.droppedForBudget,
          }),
          memoryReceipt: memoryProfile.used.map((memory) => ({
            id: memory.id,
            content: memory.content,
            category: memory.category,
            sourceRef: memory.sourceRef,
            sourceMessageId: memory.sourceMessageId,
          })),
        });
      }
      if (artifactEditTarget) {
        sendActivity({
          kind: "tool",
          title: "Editing existing canvas",
          detail: `${artifactEditTarget.title} · v${artifactEditTarget.version}`,
        });
      }
      sendActivity({
        kind: "model",
        title: "Selected model",
        detail: routingNote ?? `${PROVIDERS[modelInfo.provider].label} · ${modelInfo.name}`,
      });
      if (routingWarning) {
        sendActivity({ kind: "warning", title: "Model changed", detail: routingWarning });
      }
      if (activeConnectors.length) {
        sendActivity({
          kind: "tool",
          title: "Connected tools ready",
          detail: activeConnectors.map((c) => c.label).join(" · "),
        });
      }
      const reasoningEffort = effectiveReasoningEffort(
        modelInfo,
        autoReasoningEffort !== undefined ? autoReasoningEffort ?? undefined : input.reasoningEffort
      );
      if (reasoningEffort) {
        sendActivity({
          kind: "reasoning",
          title: isAutoModelId(requestedId) ? "Auto thinking" : "Reasoning mode enabled",
          detail: `${reasoningEffort[0].toUpperCase()}${reasoningEffort.slice(1)} effort`,
        });
      } else if (isAutoModelId(requestedId)) {
        sendActivity({
          kind: "reasoning",
          title: "Auto thinking",
          detail: "Instant — no extra reasoning for this prompt",
        });
      }
      if (useWebSearch) {
        sendActivity({
          kind: "search",
          title: "Preparing web search",
          detail: searchToolLabel(modelInfo.provider),
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
          // The corpus is gathered by a durable ResearchRun attached to this
          // conversation, so the panel can reopen it — paused, resumed or
          // steered — long after this turn has finished streaming.
          conversationId,
          client: legacyClient,
          signal: generationController.signal,
          sendActivity,
        });
        researchCostUsd = research.costUsd;
        if (research.ok) {
          synthesisSystem = `${system}\n\n${research.context}\n\n${RESEARCH_OUTPUT_CONTRACT}`;
          // Sources are known up front (unlike native search, which streams
          // them): publish the numbered list now so citations resolve as the
          // report streams. Order must match the corpus numbering exactly, so
          // the accumulator is seeded rather than told about them later.
          acc.seedSources(research.sources);
          if (acc.sources.length) send({ type: "sources", sources: acc.sources });
          // Held for the post-response audit. `corpus` is the text the model was
          // actually shown, which is the only thing a citation can honestly be
          // checked against — a re-fetch would be checking a page that may have
          // changed since the report was written.
          citationAuditInput = {
            goal: researchPrompt,
            corpus: research.corpus,
            conversationProvider: modelInfo.provider,
            runId: research.runId,
          };
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
      const synthesisPromptChars = () => promptChars(synthesisSystem, modelHistory);
      let budgetHalted = false;
      const budgetGuard = createStreamBudgetGuard({
        ceilingMicroUsd: budget.remainingMicroUsd,
        rates: modelRatesMicroUsdPerToken(modelId),
        inputChars: synthesisPromptChars(),
        usage: () => ({
          promptTokens: acc.tokens.promptTokens,
          completionTokens: acc.tokens.completionTokens,
          outputChars: acc.text.length,
          reasoningChars: acc.reasoning.length,
        }),
        onHalt: () => {
          budgetHalted = true;
          sendActivity({ kind: "warning", title: "Usage limit reached", detail: "Stopped to stay within your plan’s budget." });
          generationController.abort();
        },
      });
      const enforceStreamBudget = () => budgetGuard.enforce();

      // Declared outside the try because the catch reads `stalled` to tell a
      // wedged provider from a user Stop — aborting makes the SDK throw its
      // own user-abort error, which isAbortLike matches.
      const stallWatchdog = createStallWatchdog(() => {
        sendActivity({
          kind: "warning",
          title: "Model stopped responding",
          detail: stallDetail(PROVIDERS[modelInfo.provider].label, stallWatchdog),
        });
        generationController.abort();
      });

      try {
        const modelStream = deterministicSmokeProviderEnabled
          ? streamDeterministicSmokeResponse(
              input.message?.trim() ?? [...modelHistory].reverse().find((message) => message.role === "USER")?.content ?? ""
            )
          : streamChat({
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
          proMode: useProMode,
          audit: {
            userId: user.id,
            conversationId,
            surface: "chat",
            // The generation id, not a fresh value: with the provider's own call
            // id it forms the broker's idempotency key, so a reconnected or
            // resumed generation recognises an action it already asked about
            // instead of asking twice and executing twice.
            sessionId: generationId,
            projectId: conversation.projectId,
            onApprovalRequest: (approval) => {
              sendActivity({
                kind: "tool",
                title: `${approval.connectorLabel} needs approval`,
                detail: approval.preview,
              });
              send({ type: "approval", approval });
            },
          },
        });
        for await (const ev of modelStream) {
          stallWatchdog.touch();
          const effect = acc.apply(ev);
          if (effect.kind === "text") {
            if (effect.startedWriting) {
              sendActivity({
                kind: "write",
                title: artifactEditTarget ? "Preparing targeted changes" : "Writing the answer",
                detail: artifactEditTarget ? "Building an exact source patch" : "Streaming response text",
              });
            }
            // Patch protocol output is server-internal. The client receives a
            // normal same-identifier artifact only after every source anchor is
            // validated and the version is saved.
            if (!artifactEditTarget) send({ type: "delta", text: effect.text });
            enforceStreamBudget();
          } else if (effect.kind === "tool_call") {
            toolActivity.open(effect);
          } else if (effect.kind === "tool_result") {
            // Deliberately NOT followed by enforceStreamBudget(): that guard
            // projects micro-USD from token counts, and a tool payload spends
            // no tokens. The bound that applies here is the run's character
            // budget, already charged inside closeToolDetail.
            toolActivity.close(effect);
          } else if (effect.kind === "reasoning") {
            send({ type: "reasoning", text: effect.text, part: effect.part });
            enforceStreamBudget();
          } else if (effect.kind === "sources") {
            for (const source of effect.added) {
              sendActivity({
                kind: "visit",
                title: "Visited source",
                detail: truncate(source.title && source.title !== source.url ? source.title : sourceHost(source.url), 96),
                url: source.url,
              });
            }
            if (effect.all.length) send({ type: "sources", sources: effect.all });
          } else if (effect.kind === "usage") {
            enforceStreamBudget();
          }
        }
        // The provider is done. Everything below is Juno's own persistence, and
        // the watchdog only measures provider silence — leaving it armed made a
        // slow database look like a stalled model on a generation that had
        // already succeeded.
        stallWatchdog.stop();

        if (artifactEditTarget) {
          const patch = parseArtifactPatch(acc.text);
          targetedArtifactContent = applyArtifactPatch(artifactEditTarget.content, patch);
          // Replaces the persisted text but NOT the emitted-character count the
          // accumulator holds: the model wrote the patch, not the whole
          // artifact, and billing the rebuilt text inflates the receipt.
          acc.replaceText(buildArtifactEditMessage(artifactEditTarget, targetedArtifactContent, patch.summary));
        }

        const finishReason = acc.finishReason;
        // Reconcile token usage across providers and estimate the $ cost once.
        // The prompt-character floor covers a provider that under-reports input.
        const usage = buildUsage(
          modelInfo,
          acc.rawUsage({ promptChars: synthesisPromptChars() }),
          acc.servedFast
        );

        // Persist the assistant message — generation succeeded, so it's safe to
        // version-and-overwrite the answer being regenerated (see the helper).
        // promptTokens stores the full prompt size (cache included) so the
        // reloaded cost estimate lines up with the stream.
        if (!(await renewDurableReceiptLease())) throw new DurableReceiptLeaseLostError();
        const targetedArtifact =
          artifactEditTarget && targetedArtifactContent !== null
            ? await persistTargetedArtifactEdit(
                artifactEditTarget.id,
                artifactEditTarget.version,
                targetedArtifactContent
              )
            : null;
        const assistant = await persistAssistantTurn({
          content: acc.text,
          reasoning: acc.reasoning,
          reasoningParts: acc.reasoningParts,
          promptTokens: usage.totalInput || acc.tokens.promptTokens || null,
          completionTokens: usage.output || acc.tokens.completionTokens || null,
          // Straight off the accumulator, undefined and all: `usage.cacheRead`
          // is already `Math.max(0, … ?? 0)` and cannot tell "no cache" from
          // "this provider does not report cache".
          cacheReadTokens: acc.tokens.cacheReadTokens,
          cacheWriteTokens: acc.tokens.cacheWriteTokens,
          costMicroUsd: usage.costMicroUsd || null,
        });

        // Artifacts + memory side effects.
        const artifacts = targetedArtifact
          ? [targetedArtifact]
          : await persistArtifacts(conversationId, assistant.id, parseArtifacts(acc.text));
        if (targetedArtifact) send({ type: "delta", text: acc.text });
        let memoryUpdated = false;
        if (memoryEnabled) {
          // Provenance points at the USER's message, not the assistant's: the
          // memory page answers "where did you learn that?", and the honest
          // answer is the turn in which the user said it.
          const created = await saveAutoMemories(user.id, parseMemories(acc.text), conversationId, {
            projectId: conversation.projectId,
            sourceMessageId: userMessageId,
          });
          memoryUpdated = created > 0;
        }

        // Touch the conversation after the assistant message has been persisted.
        // Keep Auto as the sticky selection when the user chose Auto.
        await prisma.conversation.updateMany({
          where: { id: conversationId, userId: user.id },
          data: {
            lastMessageAt: new Date(),
            model: conversationModelId,
          },
        });

        assistantFull = acc.text;
        auditedMessageId = assistant.id;

        if (usage.totalInput || usage.output) {
          sendActivity({ kind: "usage", title: "Token usage recorded", detail: usage.detail });
        }
        appendFinishWarning(finishReason, sendActivity);
        sendActivity({
          kind: "done",
          // Was hardcoded "Finished response" for every finish reason, so a turn
          // cut short by the token limit reported the same title as one that
          // completed. The private path already had this right; a saved chat and
          // the identical private chat should not describe themselves
          // differently.
          title: finishReason === "stop" ? "Finished response" : finishReasonTitle(finishReason),
          detail: acc.sources.length ? plural(acc.sources.length, "source") : undefined,
        });
        const assistantWithActivity = await prisma.message.update({
          where: { id: assistant.id },
          data: { activity: activityLog as unknown as Prisma.InputJsonValue },
          include: {
            attachments: { where: { deletedAt: null } },
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
          // The cache split is NOT spread in from the accumulator here: it is
          // now a column, and `serializeMessage` reads it back off the row that
          // was just written. Same numbers live and on reload, from one source.
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
          ref: generationId,
          promptTokens: usage.totalInput || undefined,
          completionTokens: usage.output || undefined,
          reasoningTokens: acc.tokens.reasoningTokens || undefined,
          totalTokens: acc.tokens.totalTokens || undefined,
          cacheRead: acc.tokens.cacheReadTokens,
          cacheWrite: acc.tokens.cacheWriteTokens,
          cacheWrite5m: acc.tokens.cacheWrite5mTokens,
          cacheWrite1h: acc.tokens.cacheWrite1hTokens,
          webSearchRequests: acc.tokens.webSearchRequests,
          xSearchRequests: acc.tokens.xSearchRequests,
          costUsd: usage.cost || undefined,
          promptChars: synthesisPromptChars(),
          completionChars: acc.providerOutputChars,
          reasoningChars: acc.reasoning.length,
          fastMode: acc.servedFast,
        });
        spendRecorded = true;
        console.info("[chat] generation complete", {
          generationId,
          conversationId,
          provider: modelInfo.provider,
          model: modelInfo.providerModel,
          finishReason,
          promptTokens: acc.tokens.promptTokens ?? null,
          completionTokens: acc.tokens.completionTokens ?? null,
          // Prompt-cache instrumentation (read = hit, write = Anthropic-only creation).
          cacheReadTokens: acc.tokens.cacheReadTokens ?? null,
          cacheWriteTokens: acc.tokens.cacheWriteTokens ?? null,
          webSearchRequests: acc.tokens.webSearchRequests ?? null,
        });
      } catch (err) {
        // One terminal-state model, shared with the private path. The stall
        // check comes before the stop cases for the reason recorded there.
        const terminal = resolveTerminalState(
          {
            stalled: stallWatchdog.stalled,
            budgetHalted,
            userStopped: wasGenerationStopped(generationId),
            leaseLost: durableReceiptLeaseLost || err instanceof DurableReceiptLeaseLostError,
            error: err,
          },
          {
            hasText: !!acc.text,
            hasReasoning: !!acc.reasoning,
            artifactEdit: !!artifactEditTarget,
          }
        );
        const reason = terminal.finishReason;
        console.error("[chat] generation error", {
          generationId,
          conversationId,
          provider: modelInfo.provider,
          model: modelInfo.providerModel,
          finishReason: reason,
          message: err instanceof Error ? err.message : String(err),
        });

        if (terminal.persistsPartial) {
          try {
            appendFinishWarning(reason, sendActivity);
            const partialUsage = buildUsage(
              modelInfo,
              acc.rawUsage({ promptChars: synthesisPromptChars() }),
              acc.servedFast
            );
            // Same version-preserving persistence as the success path — a
            // partial answer still supersedes (never destroys) the previous one.
            if (!(await renewDurableReceiptLease())) throw new DurableReceiptLeaseLostError();
            const assistant = await persistAssistantTurn({
              content: acc.text,
              reasoning: acc.reasoning,
              reasoningParts: acc.reasoningParts,
              promptTokens: partialUsage.totalInput || acc.tokens.promptTokens || null,
              completionTokens: partialUsage.output || acc.tokens.completionTokens || null,
              // A stopped turn still consumed (and may have written) cache, so
              // the split is persisted on the partial exactly as on the whole.
              cacheReadTokens: acc.tokens.cacheReadTokens,
              cacheWriteTokens: acc.tokens.cacheWriteTokens,
              costMicroUsd: partialUsage.costMicroUsd || null,
            });
            const artifacts = await persistArtifacts(conversationId, assistant.id, parseArtifacts(acc.text));
            await prisma.conversation.updateMany({
              where: { id: conversationId, userId: user.id },
              data: { lastMessageAt: new Date(), model: conversationModelId },
            });
            const assistantWithActivity = await prisma.message.update({
              where: { id: assistant.id },
              data: { activity: activityLog as unknown as Prisma.InputJsonValue },
              include: {
                attachments: { where: { deletedAt: null } },
                versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" } },
              },
            });
            assistantFull = acc.text;
            auditedMessageId = assistant.id;
            researchGenerationPartial = true;
            if (!(await markDurableReceiptCompleted(assistant.id, reason))) {
              durableReceiptLeaseLost = true;
              throw new DurableReceiptLeaseLostError();
            }
            send({
              type: "done",
              // Read back off the persisted row, same as the success path.
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
                ref: generationId,
                promptTokens: partialUsage.totalInput || undefined,
                completionTokens: partialUsage.output || undefined,
                reasoningTokens: acc.tokens.reasoningTokens || undefined,
                totalTokens: acc.tokens.totalTokens || undefined,
                cacheRead: acc.tokens.cacheReadTokens,
                cacheWrite: acc.tokens.cacheWriteTokens,
                cacheWrite5m: acc.tokens.cacheWrite5mTokens,
                cacheWrite1h: acc.tokens.cacheWrite1hTokens,
                webSearchRequests: acc.tokens.webSearchRequests,
                xSearchRequests: acc.tokens.xSearchRequests,
                costUsd: partialUsage.cost || undefined,
                promptChars: synthesisPromptChars(),
                completionChars: acc.providerOutputChars,
                reasoningChars: acc.reasoning.length,
                fastMode: acc.servedFast,
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
            const failureCode = terminalFailureCode(
              durableReceiptLeaseLost || persistErr instanceof DurableReceiptLeaseLostError,
              PERSISTENCE_FAILED_FAILURE_CODE
            );
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
          // and report the corrected quota so the UI doesn't go stale. A user who
          // stopped their own generation keeps the charge — see terminal-state.
          const quota = terminal.refunds
            ? await refundMessage(user.id, plan).catch(() => consumed.quota)
            : consumed.quota;
          const message =
            reason === "user_stopped"
              ? artifactEditTarget
                ? "Canvas editing stopped before any change was applied."
                : "Generation stopped before any output."
              : err instanceof ArtifactVersionConflictError
                ? "This canvas changed while the edit was being prepared. Select the part again and retry."
                : err instanceof ArtifactPatchError
                  ? `${err.message} Nothing in the canvas was changed.`
                  : stallWatchdog.stalled
                    ? stallMessageFor(stallWatchdog)
                    : providerErrorMessage(err, PROVIDERS[modelInfo.provider].label);
          sendActivity({
            kind: "warning",
            title: finishReasonTitle(reason),
            detail: message,
          });
          const failureCode = terminal.failureCode;
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
        stallWatchdog.stop();
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
        const failureCode = terminalFailureCode(durableReceiptLeaseLost, INTERNAL_ERROR_FAILURE_CODE);
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
    // Moderation is decided before the answer is known and memory work after:
    // a policy violation must be caught even when the model errored, while
    // memory must not record a turn the user never got. See
    // chat/post-processing, where both rules live with their reasons.
    if (postGenerationPlan({ moderate, memoryEnabled, producedAnswer: false }).moderates) {
      await moderateUserMessages({ userId: user.id, texts: moderationTexts }).catch(() => {});
    }

    await genPromise?.catch(() => {});

    /*
     * Citation audit (§8.3): extract the report's load-bearing claims, link each
     * to the passages it cites, and re-read those passages to decide whether
     * they genuinely support it. Anything they do not is marked unsupported —
     * never dropped, and never left looking cited.
     *
     * Deliberately before the memory work: this is what the reader is waiting to
     * see under the answer, and memory extraction is invisible to them.
     * `.catch` because a failed audit must leave the answer intact — the footer
     * simply shows nothing, which is what it shows for every ordinary reply.
     */
    if (citationAuditInput && auditedMessageId && assistantFull) {
      const input: NonNullable<typeof citationAuditInput> = citationAuditInput;
      const audit = await recordCitationAudit({
        userId: user.id,
        conversationId: conversation.id,
        messageId: auditedMessageId,
        runId: input.runId ?? undefined,
        goal: input.goal,
        report: assistantFull,
        sources: input.corpus,
        conversationProvider: input.conversationProvider,
      }).catch((err) => {
        console.error("[chat] citation audit failed", {
          conversationId: conversation.id,
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      if (audit && auditedMessageId && audit.repaired && audit.report !== assistantFull) {
        // The stream has already ended, but reloads must show the audited
        // report. The durable revision row preserves what was initially
        // delivered and the message remains encrypted at rest.
        await prisma.message.update({
          where: { id: auditedMessageId },
          data: { content: encryptMessageText(audit.report) },
        }).catch((err) => {
          console.error("[chat] could not persist repaired research report", {
            messageId: auditedMessageId,
            message: err instanceof Error ? err.message : String(err),
          });
        });
        /*
         * …and the artifact, which is where the report is actually READ.
         *
         * The audit's repairs are character splices into the delivered text, and
         * that text is now mostly the report inside a `juno:artifact` block. The
         * message row was being rewritten and the artifact row was not, so a
         * claim the audit had labelled "the cited evidence is insufficient" was
         * corrected in the chat transcript while the canvas beside it kept
         * showing the unqualified original — the audited copy visible in the one
         * place nobody reads it, and the unaudited copy in the one place they do.
         *
         * `persistArtifacts` appends a version rather than overwriting, so the
         * delivered draft stays in the artifact's history exactly as the run's
         * own `reportRevision` keeps it in the run.
         */
        await persistArtifacts(conversationId, auditedMessageId, parseArtifacts(audit.report)).catch((err) => {
          console.error("[chat] could not persist the audited research artifact", {
            messageId: auditedMessageId,
            message: err instanceof Error ? err.message : String(err),
          });
        });
        assistantFull = audit.report;
      }
      if (input.runId) {
        await finalizeChatResearchRun({
          runId: input.runId,
          userId: user.id,
          report: audit?.report ?? assistantFull,
          partial: !audit || researchGenerationPartial,
        }).catch((err) => {
          console.error("[chat] could not finalize research run", {
            runId: input.runId,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    const postWork = postGenerationPlan({ moderate, memoryEnabled, producedAnswer: !!assistantFull });
    if (postWork.extractsMemory) {
      // Incremental extraction: distill this conversation's unprocessed user
      // messages into memory facts (advances its high-water mark).
      await extractConversationMemory({ userId: user.id, conversationId: conversation.id }).catch(() => {});
    }
    if (postWork.consolidates) {
      // Periodically re-summarize so the memory stays tidy and deduped.
      // The provider of the model the user chose for THIS turn, so
      // `same_provider` has the conversation to match against. It used to get
      // `cheapModel` — the background worker itself — which under that policy
      // amounted to asking the worker whether it was allowed to do the work.
      await maybeConsolidate(user.id, modelInfo.provider).catch(() => {});
    }
  });

  return new Response(stream, { headers: SSE_HEADERS });
  } catch (error) {
    if (!durableGenerationId || !userMessageId || !conversation) throw error;
    const failureCode = START_FAILED_FAILURE_CODE;
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
