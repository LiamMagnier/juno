import "server-only";
import type { FastMode } from "@/lib/pricing";
import { applySemanticEditReply, resolveArtifactOps } from "@/lib/artifact-ops";
import { isSemanticArtifactType } from "@/lib/work/deliverables/semantic";
import { SemanticError } from "@/lib/work/deliverables/semantic/shared";
import { loadOpsTarget } from "./semantic";
import type { TurnModel } from "./model";
import { classifyProviderError } from "@/lib/provider-error";
import { recordProviderRateLimit } from "@/lib/router/provider-pressure";
import { completionStateFor, recordRoutingOutcome } from "@/lib/router/telemetry-store";
import { createAlevrSearchTurn } from "@/lib/search/alevr/turn";
import type { Plan } from "@prisma/client";
import type { EffectiveBudget } from "@/lib/spend-ceiling";
import { PLANS } from "@/lib/plans";
import { isAutoModelId } from "@/lib/auto-model";
import { PROVIDERS } from "@/lib/providers";
import { buildDynamicContext } from "@/lib/anthropic";
import { finishReasonTitle } from "@/lib/finish-reason";
import { registerGeneration, wasGenerationAbortedForShutdown, wasGenerationStopped } from "@/lib/generation-cancel";
import { streamChat, providerErrorMessage } from "@/lib/llm";
import { memoryReceiptDetail } from "@/lib/memory-lifecycle";
import { saveAutoMemories, forgetStatements } from "@/lib/memory";
import { ArtifactVersionConflictError, persistArtifacts, persistTargetedArtifactEdit } from "@/lib/artifacts-store";
import { UNTRUSTED_INPUT_TAINT } from "@/lib/artifact-proposals";
import {
  applyArtifactPatch,
  ArtifactPatchError,
  buildArtifactEditMessage,
  parseArtifactPatch,
  type ArtifactSourceForEdit,
} from "@/lib/artifact-edit";
import { holdArtifactBodies, parseForgets, parseMemories } from "@/lib/message-content";
import { ChatArtifactVerificationError } from "@/lib/chat-artifact-verification";
import { serializeMessage } from "@/lib/serializers";
import { prisma } from "@/lib/prisma";
import { releaseSpend, reserveSpend, modelRatesMicroUsdPerToken, type billingPeriodFor, type checkBudget } from "@/lib/spend";
import { encodeChunk, createSseSender, SSE_HEADERS } from "@/lib/chat-stream";
import { createStreamLog, shouldLogStream, type StreamLog } from "@/lib/chat/stream-log";
import { appendChatStreamEvents } from "@/lib/chat-stream-log-store";
import { coerceTitleSource } from "@/lib/title-ownership";
import { buildUsage } from "@/lib/chat-usage";
import { createStallWatchdog, stallDetail, stallMessageFor, trackToolActivity } from "@/lib/chat-stall";
import { createStreamBudgetGuard } from "@/lib/chat-budget-guard";
import { refundMessage, type consumeMessage } from "@/lib/usage";
import {
  DurableReceiptLeaseLostError,
  appendFinishWarning,
  classifyErrorFinishReason,
  effectiveReasoningEffort,
  plural,
} from "@/lib/chat-responses";
import { contextActivityDetail, promptChars, type AttachmentKnowledge, type ProjectKnowledge } from "@/lib/chat/context-assembly";
import { CHAT_SKILL_REFUSAL_MESSAGES, narrowRuntimeToolsForSkill, skillAppliedActivity } from "@/lib/chat/skills";
import { contextActivityRows, type TurnContext } from "@/lib/chat/context-resolution";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import {
  INTERNAL_ERROR_FAILURE_CODE,
  PERSISTENCE_FAILED_FAILURE_CODE,
  resolveTerminalState,
  terminalFailureCode,
} from "@/lib/chat/terminal-state";
import { chatRuntimeToolAllowlist } from "@/lib/chat/tool-policy";
import type { ChatRequestBody } from "@/lib/chat/request";
import type { RoomTurnSetup } from "@/lib/agents/room-store";
import type { ActiveConnector } from "@/lib/mcp";
import type { ModelInfo } from "@/lib/models";
import { SHUTDOWN_USER_MESSAGE } from "@/lib/shutdown";
import type { ClientArtifact, ReasoningEffort, StreamChunk } from "@/types/chat";
import type { MessageForModel } from "@/types/llm";
import type { legacyChatClientForOrigin } from "@/lib/chat-origin";
import type { buildSystemPromptSections } from "@/lib/anthropic";
import { createToolActivity, planTurnHolds, prepareChatArtifactOutput } from "./activity";
import { createApprovalRequester, type TurnApprovals } from "./approvals";
import { createDurableReceipt, RESEARCH_HANDOFF_FINISH } from "./durable-receipt";
import type { TurnMemory } from "./memory";
import { streamDeterministicSmokeResponse, streamResearchNotice } from "./model-streams";
import { createAssistantTurnWriter } from "./persist";
import { resolveResearchStage } from "./research-stage";
import { pumpTurnStream, sendReasoningAndSearch, sendSelectedModel } from "./run-stream";
import type { TurnSkill } from "./skills";
import { recordTurnSpend } from "./spend";
import { buildNativeTools, type TurnTools } from "./tools";
import type { CrossTurn } from "./cross";
import { emptyTurnOutcome, type TurnOutcome } from "./finalize";
import type { TurnTraceFinish, TurnTraceRecorder } from "./trace";
import { traceUsage } from "./trace";
import type { TurnUser } from "./types";
import { recordToolFees } from "@/lib/tools/metering";
import { recordSpend } from "@/lib/spend";

/*
 * Pipeline stage — runTurn: the saved turn's generation, from the spend hold
 * to the terminal frame.
 *
 * Generation + persistence is detached from the request lifecycle: req.signal
 * is never passed to the model, so navigating away drops the browser stream
 * without losing the saved answer. The explicit cancel endpoint (and the
 * durable cancel poll) abort it. Every frame goes to the resumable stream log,
 * so a reconnecting client resumes THIS turn instead of regenerating it.
 *
 * Inputs are what the earlier stages resolved (SavedTurnPlan); nothing here
 * re-decides a permission. Moved out of the route with the stream loop, the
 * preamble rows, the research leg, the native tools and the receipt lease
 * delegated to their own modules.
 */

export interface SavedTurnPlan {
  req: Request;
  user: TurnUser;
  input: ChatRequestBody;
  plan: Plan;
  period: ReturnType<typeof billingPeriodFor>;
  effective: EffectiveBudget;
  budget: Awaited<ReturnType<typeof checkBudget>>;
  legacyClient: ReturnType<typeof legacyChatClientForOrigin>;
  doneArtifacts: (rows: ClientArtifact[]) => ClientArtifact[];
  deterministicSmokeProviderEnabled: boolean;
  toolDetailEnabled: boolean;
  generationId: string;
  durableGenerationId: string | null;
  conversation: { id: string; projectId: string | null; title: string; titleSource: string | null };
  conversationModelId: string;
  userMessageId: string | null;
  staleAssistantId: string | null;
  artifactEditTarget: (ArtifactSourceForEdit & { id: string }) | null;
  contextAttachmentIds: string[];
  clarificationVisibleContent: string | null;
  preflightVisibleContent: string | null;
  consumed: NonNullable<Awaited<ReturnType<typeof consumeMessage>>>;
  roomSetup: RoomTurnSetup | null;
  roomTurnId: string | null;
  roomMessageId: string | null;
  modelInfo: ModelInfo;
  modelId: string;
  requestedId: string;
  requestedEffort: ReasoningEffort | undefined;
  autoReasoningEffort: ReasoningEffort | null | undefined;
  routingNote: string | null;
  routingWarning: string | null;
  routingReceipt: TurnModel["routingReceipt"];
  routingTelemetryBase: TurnModel["routingTelemetryBase"];
  turnContext: TurnContext;
  activeConnectors: ActiveConnector[];
  memory: TurnMemory;
  projectContext: string;
  attachmentContext: string;
  projectKnowledge: ProjectKnowledge | null;
  attachmentKnowledge: AttachmentKnowledge | null;
  allAttachments: readonly unknown[];
  attachmentToolToggles: { documents: boolean; code: boolean; images: boolean };
  modelHistory: MessageForModel[];
  turnHistory: MessageForModel[];
  researchActive: boolean;
  researchRequested: boolean;
  useWebSearch: boolean;
  useAlevrSearch: boolean;
  /** The serving tier (pricing.ts FastMode), resolved by turn/capabilities.ts. */
  useFastMode: FastMode;
  useProMode: boolean;
  skill: TurnSkill;
  untrustedContentInTurn: boolean;
  approvals: TurnApprovals;
  tools: TurnTools;
  system: string;
  baseSystemSections: ReturnType<typeof buildSystemPromptSections>;
  trace: TurnTraceRecorder;
  /** Conversations messaging each other (src/lib/cross-conversation), when on for this conversation. */
  crossConversation?: CrossTurn | null;
}

export async function runTurn(turn: SavedTurnPlan): Promise<{
  response: Response;
  /** The detached generation; settles when the turn is persisted (or failed). */
  generation: Promise<void>;
  outcome: TurnOutcome;
}> {
  const {
    req,
    user,
    input,
    plan,
    period,
    effective,
    budget,
    legacyClient,
    doneArtifacts,
    deterministicSmokeProviderEnabled,
    toolDetailEnabled,
    generationId,
    durableGenerationId,
    conversation,
    conversationModelId,
    userMessageId,
    staleAssistantId,
    artifactEditTarget,
    contextAttachmentIds,
    clarificationVisibleContent,
    preflightVisibleContent,
    consumed,
    roomSetup,
    roomTurnId,
    roomMessageId,
    modelInfo,
    modelId,
    requestedId,
    requestedEffort,
    autoReasoningEffort,
    routingNote,
    routingWarning,
    routingReceipt,
    routingTelemetryBase,
    turnContext,
    activeConnectors,
    memory: { memoryEnabled, memoryProfile },
    projectContext,
    attachmentContext,
    projectKnowledge,
    attachmentKnowledge,
    allAttachments,
    attachmentToolToggles,
    modelHistory,
    turnHistory,
    researchActive,
    researchRequested,
    useWebSearch,
    useAlevrSearch,
    useFastMode,
    useProMode,
    skill: { skillOutcome, appliedSkill },
    untrustedContentInTurn,
    approvals: { taskToolOn, agentConfigToolsOn, agentContext },
    tools: { toolProviderSessions },
    system,
    baseSystemSections,
    trace,
  } = turn;
  const conversationId = conversation.id;
  const convoTitle = conversation.title;
  const convoTitleSource = coerceTitleSource(conversation.titleSource);
  const outcome = emptyTurnOutcome();
  const receipt = createDurableReceipt({ userId: user.id, durableGenerationId, generationId });
  await receipt.markRunning();
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
  await reserveSpend({ userId: user.id, kind: "chat", ref: generationId, plan, period, budget: effective });
  const generationController = new AbortController();
  const unregisterGeneration = registerGeneration(generationId, {
    userId: user.id,
    controller: generationController,
    model: modelId,
    conversationId,
  });
  /*
   * This generation's resumable frame log (docs/JUNO.md §5.8).
   *
   * Every stateful frame the sender emits is appended under a monotonic `seq`
   * and goes out carrying that seq as its SSE `id:`, so a browser whose stream
   * drops reconnects to GET /api/chat/stream/{generationId}?after={seq} and
   * keeps rendering THIS turn. What it replaces: 12 seconds of polling the
   * conversation and then a "Try again" that regenerates — a second charge for
   * an answer that was already being written.
   *
   * Guarded by source, not by position in this function: the private path
   * builds its sender with no log at all, and `shouldLogStream` is the second
   * lock, so a private turn that ever reached this branch would still write
   * nothing. Writes are batched off the critical path and a failed one
   * disables the log for the rest of the generation — see chat/stream-log.ts
   * for why half a log is worse than none.
   */
  const streamLog: StreamLog | undefined = shouldLogStream(input)
    ? createStreamLog({
        generationId,
        write: appendChatStreamEvents,
        onDisabled: (reason, error) => {
          // Once per generation: the log disables itself on the first failure,
          // so this cannot become a per-frame error loop. No payload is
          // logged — the rows carry transcript text.
          console.error("[chat] stream log disabled", {
            generationId,
            reason,
            message: error instanceof Error ? error.message : error ? String(error) : null,
          });
        },
      })
    : undefined;

  // Generation + persistence is detached from the request lifecycle: we do not
  // pass req.signal to the model, so navigating away can drop the browser stream
  // without losing the saved answer. The explicit cancel endpoint aborts it.
  let generationHeartbeat: ReturnType<typeof setInterval> | null = null;
  const stopGenerationTimers = () => {
    if (generationHeartbeat) clearInterval(generationHeartbeat);
    generationHeartbeat = null;
    receipt.stop();
  };
  const generate = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    // Once the client disconnects the controller is closed; swallow the enqueue
    // error so generation and persistence keep running regardless.
    const { send, sendActivity, activityLog } = createSseSender(controller, { log: streamLog });
    const toolActivity = createToolActivity({ send, sendActivity }, toolDetailEnabled);
    // One accumulator for text, reasoning, sources, usage and served speed —
    // the same one the private branch folds its stream into.
    const acc = new GenerationAccumulator({ requestedFastMode: useFastMode });
    /** The trace's terminal record, set by whichever branch ends the turn. */
    let traceEnd: TurnTraceFinish | null = null;
    let targetedArtifactContent: string | null = null;
    let spendRecorded = false;

    const { persistAssistantTurn, sealActivity } = createAssistantTurnWriter({
      user,
      conversationId,
      staleAssistantId,
      modelId,
      acc,
      activityLog,
      roomTurnId,
      routingReceipt,
    });
    /** Routing telemetry for this turn, filled by whichever terminal path runs. */
    const turnStartedAt = Date.now();
    let turnOutcome: {
      messageId: string | null;
      finishReason: string | null;
      persistedPartial: boolean;
      costMicroUsd: number | null;
    } | null = null;

    send({
      type: "meta",
      conversationId,
      userMessageId,
      title: convoTitle,
      titleSource: convoTitleSource,
      generationId,
      // The client only attempts a resume when this says the frames are
      // being kept. Absent — private chats, an older server — means a
      // dropped stream falls back to polling the conversation.
      ...(streamLog ? { resumable: true as const } : {}),
      ...(durableGenerationId ? { receiptState: "running" as const } : {}),
    });
    // Heartbeat: models with hidden reasoning can stream nothing for minutes;
    // periodic pings keep proxies from dropping the idle SSE connection. The
    // same tick renews a durable receipt's lease (durable-receipt.ts).
    generationHeartbeat = setInterval(() => {
      send({ type: "ping" });
      receipt.heartbeat(() => generationController.abort());
    }, 15_000);
    receipt.startCancelPoll();

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
    // What became of each token the message named — the durable receipt
    // (`contextReceipt`) and a warning for each one that did not make it,
    // "Stripe isn't connected" included.
    for (const row of contextActivityRows(turnContext.receipt())) sendActivity(row);
    if (artifactEditTarget) {
      sendActivity({
        kind: "tool",
        title: "Editing existing canvas",
        detail: `${artifactEditTarget.title} · v${artifactEditTarget.version}`,
      });
    }
    sendSelectedModel(sendActivity, { modelInfo, routingNote, routingWarning });
    // A refused skill is not an error (see `skillOutcome` above), but the
    // composer showed it armed, so the reader is owed the reason it did not
    // run. The audit row above is the security log's copy; this is theirs,
    // and it is saved with the turn's activity like every other row here.
    if (skillOutcome && !skillOutcome.applied) {
      sendActivity({
        kind: "warning",
        title: "Skill not applied",
        detail: CHAT_SKILL_REFUSAL_MESSAGES[skillOutcome.reason],
      });
    }
    // The success twin of the refusal row: the composer showed the skill
    // armed, so the run has to say which one actually shaped the answer.
    // Version rides the detail line so a reloaded message still names it.
    if (skillOutcome?.applied) {
      sendActivity(skillAppliedActivity(skillOutcome.application));
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
      autoReasoningEffort !== undefined ? autoReasoningEffort ?? undefined : requestedEffort
    );
    sendReasoningAndSearch(sendActivity, {
      reasoningEffort,
      auto: isAutoModelId(requestedId),
      webSearch: useWebSearch,
      alevrSearch: useAlevrSearch,
      modelInfo,
    });
    /*
     * Alevr Search's tools for this turn, bound to its ledger, taint, limits and
     * sources (`src/lib/search/alevr/turn.ts`). A skill that names its tools
     * keeps the family only when it asked for web search or page reading.
     */
    const alevrSearchTurn =
      useAlevrSearch && narrowRuntimeToolsForSkill(["web_search", "web_fetch"], appliedSkill).length > 0
        ? createAlevrSearchTurn({
            userId: user.id,
            conversationId,
            private: false,
            effort: reasoningEffort,
            voice: !!input.voiceMode,
            userTexts: input.message ? [input.message] : [],
            staticContent: untrustedContentInTurn,
          })
        : null;

    // Web research parks at the editable plan; only a ready corpus may be
    // synthesized. Planning spend is recorded inside runDeepResearch.
    const { synthesisSystem, researchCostUsd, researchNotice, handoffRunId } = await resolveResearchStage({
      user,
      input,
      plan,
      modelInfo,
      requestedId,
      reasoningEffort,
      conversationId,
      legacyClient,
      system,
      modelHistory,
      researchActive,
      researchRequested,
      // SPEC §9.6.1: a client that follows background runs gets one. Not on
      // a regenerate — the answer being replaced has to be superseded by an
      // answer, so that turn keeps the in-chat path.
      researchHandsOff: researchActive && !staleAssistantId && (input.clientFeatures?.includes("research_background") ?? false),
      acc,
      send,
      sendActivity,
      signal: generationController.signal,
      outcome,
    });

    // Hard mid-stream budget ceiling (see the private path for rationale):
    // abort the provider stream the instant this generation's running cost
    // would take the user past their remaining plan budget.
    const synthesisPromptChars = () => promptChars(synthesisSystem, turnHistory);
    let budgetHalted = false;
    const budgetGuard = createStreamBudgetGuard({
      ceilingMicroUsd: budget.remainingMicroUsd,
      rates: modelRatesMicroUsdPerToken(modelId),
      inputChars: synthesisPromptChars(),
      usage: () => ({
        promptTokens: acc.tokens.promptTokens,
        completionTokens: acc.tokens.completionTokens,
        cacheReadTokens: acc.tokens.cacheReadTokens,
        promptTokensIncludeCacheRead: modelInfo.provider !== "anthropic",
        outputChars: acc.text.length,
        reasoningChars: acc.reasoning.length,
      }),
      onHalt: () => {
        budgetHalted = true;
        sendActivity({ kind: "warning", title: "Usage limit reached", detail: "Stopped to stay within your plan’s budget." });
        generationController.abort();
      },
    });
    const enforceStreamBudget = () => researchNotice ? false : budgetGuard.enforce();

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
    const toolWatch = trackToolActivity(stallWatchdog);

    const requestApproval = createApprovalRequester(stallWatchdog, send, sendActivity, trace.noteApproval);
    const nativeTools = await buildNativeTools({
      user,
      input,
      conversationId,
      conversation,
      userMessageId,
      approvals: { taskToolOn, agentConfigToolsOn, agentContext },
      appliedSkill,
      conversationModelId,
      requestedEffort,
      contextAttachmentIds,
      activeConnectors,
      untrustedContentInTurn,
      allAttachments,
      generationId,
      requestApproval,
      send,
      sendActivity,
      roomSetup,
      roomMessageId,
      clarificationVisibleContent,
      preflightVisibleContent,
      crossConversation: turn.crossConversation ?? null,
    });

    try {
      /*
       * THE TURN BECAME A RESEARCH RUN (SPEC §9.6.1).
       *
       * The run is already being driven off this request, and the engine's
       * own completion writes the report message and sends the "ready"
       * notification. So this request writes no assistant row and ends on
       * the terminal `handoff` frame (no `done` follows, §2.3 rule 6); the
       * client follows the run. Returning from inside the `try` runs the
       * `finally` below, which closes the stream log and releases the spend
       * hold this turn never used. Nothing here is tied to the request any
       * more: an app that closes now leaves the run running.
       */
      if (handoffRunId) {
        if (!(await receipt.markCompleted(null, RESEARCH_HANDOFF_FINISH))) {
          receipt.leaseLost = true;
          throw new DurableReceiptLeaseLostError();
        }
        send({ type: "handoff", to: "research", runId: handoffRunId, userMessageId });
        traceEnd = { finishReason: "stop", outcome: "completed" };
        console.info("[chat] research handed off", { generationId, conversationId, runId: handoffRunId });
        return;
      }
      const modelStream = researchNotice
        ? streamResearchNotice(researchNotice)
        : deterministicSmokeProviderEnabled
        ? streamDeterministicSmokeResponse(
            input.message?.trim() ?? [...modelHistory].reverse().find((message) => message.role === "USER")?.content ?? ""
          )
        : streamChat({
        model: modelInfo,
        system: synthesisSystem,
        systemStablePrefix: baseSystemSections.stable,
        history: turnHistory,
        maxTokens: PLANS[plan].maxOutputTokens,
        // Not tied to req.signal: route changes can drop the browser stream
        // without killing generation; the explicit cancel endpoint aborts this.
        signal: generationController.signal,
        reasoningEffort,
        webSearch: useWebSearch,
        connectors: activeConnectors,
        // The hosted browser tool only when the user switched web access on.
        // Same toggle that adds the untrusted-content rule above, so a page
        // the tool reads always arrives under a rule that governs it. The
        // two attachment tools ride the attachments this turn is carrying —
        // see `attachmentToolToggles`.
        // A skill narrows this list and can never widen it: the filter runs
        // over what the turn already had. A skill that declares no tools —
        // the common shape, since `allowed-tools` is experimental in the spec
        // and most authors omit it — narrows nothing, because a skill is not
        // a way to take capabilities away from a conversation the reader
        // configured. See `narrowRuntimeToolsForSkill`.
        allowedTools: narrowRuntimeToolsForSkill(
          chatRuntimeToolAllowlist({
            webSearch: useWebSearch,
            ...attachmentToolToggles,
          }),
          appliedSkill
        ),
        dynamicContext: buildDynamicContext(input.timeZone),
        // One conversation = one stable prompt prefix (system + history).
        cacheKey: conversationId,
        fastMode: useFastMode,
        proMode: useProMode,
        requestContext: {
          requestId: req.headers.get("x-juno-request-id"),
          generationId,
          conversationId,
        },
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
          onApprovalRequest: requestApproval,
        },
        // `start_task` and `hand_off_to_teammate`, when this turn may carry
        // them (`taskToolOn` and the agent context's `handoff` above).
        nativeTools: nativeTools.length > 0 ? nativeTools : undefined,
        // The execution and skill tools this turn was granted
        // (`executionEntitlements` above), run behind the runtime broker.
        toolSpecs:
          (toolProviderSessions?.specs.length ?? 0) + (alevrSearchTurn?.specs.length ?? 0) > 0
            ? [...(toolProviderSessions?.specs ?? []), ...(alevrSearchTurn?.specs ?? [])]
            : undefined,
      });
      await pumpTurnStream(modelStream, {
        acc,
        stallWatchdog,
        toolWatch,
        toolActivity,
        send,
        sendActivity,
        enforceStreamBudget,
        writing: artifactEditTarget
          ? { title: "Preparing targeted changes", detail: "Building an exact source patch" }
          : { title: "Writing the answer", detail: "Streaming response text" },
        forwardDeltas: !artifactEditTarget,
        onEffect: trace.observe,
        drainSources: alevrSearchTurn ? () => alevrSearchTurn.drainSources() : undefined,
      });
      toolWatch.releaseAll();
      // The provider is done. Everything below is Juno's own persistence, and
      // the watchdog only measures provider silence — leaving it armed made a
      // slow database look like a stalled model on a generation that had
      // already succeeded.
      stallWatchdog.stop();

      if (artifactEditTarget && isSemanticArtifactType(artifactEditTarget.type)) {
        // A workbook, document or deck takes operations, applied by the
        // engine to the selected version; a failure is the same refusal a
        // bad patch is.
        let edited: ReturnType<typeof applySemanticEditReply>;
        try {
          edited = applySemanticEditReply(artifactEditTarget, acc.text, { author: user.name ?? undefined });
        } catch (error) {
          throw new ArtifactPatchError(error instanceof SemanticError ? error.message : "The edit could not be applied.");
        }
        targetedArtifactContent = edited.content;
        acc.replaceText(
          buildArtifactEditMessage(artifactEditTarget, targetedArtifactContent, edited.summary ?? edited.changes.join("; "))
        );
      } else if (artifactEditTarget) {
        const patch = parseArtifactPatch(acc.text);
        targetedArtifactContent = applyArtifactPatch(artifactEditTarget.content, patch);
        // Replaces the persisted text but NOT the emitted-character count the
        // accumulator holds: the model wrote the patch, not the whole
        // artifact, and billing the rebuilt text inflates the receipt.
        acc.replaceText(buildArtifactEditMessage(artifactEditTarget, targetedArtifactContent, patch.summary));
      } else {
        // Operations on an existing workbook, document or deck in an ordinary
        // turn: applied to its current version and rewritten into the
        // artifact tag, so verification, the re-emit guard and versioning
        // below treat the result like any other revision.
        const resolvedOps = await resolveArtifactOps(
          acc.text,
          (identifier) => loadOpsTarget(conversationId, identifier, user.id),
          { author: user.name ?? undefined }
        );
        if (resolvedOps) {
          acc.replaceText(resolvedOps.text);
          for (const applied of resolvedOps.applied) {
            sendActivity({ kind: "artifact", title: `Edited ${applied.title}`, detail: applied.changes.slice(0, 3).join(" · ") });
          }
          for (const failed of resolvedOps.failed) {
            sendActivity({ kind: "artifact", title: "Edit not applied", detail: failed.reason });
          }
        }
      }

      const preparedArtifacts = prepareChatArtifactOutput(acc.text, sendActivity);
      if (preparedArtifacts) {
        acc.replaceText(preparedArtifacts.text);
        if (artifactEditTarget) {
          if (preparedArtifacts.result.report.refused.length > 0) {
            throw new ChatArtifactVerificationError(preparedArtifacts.result.report);
          }
          const verifiedTarget = preparedArtifacts.result.artifacts.find(
            (artifact) => artifact.identifier === artifactEditTarget.identifier
          );
          if (!verifiedTarget) throw new ChatArtifactVerificationError(preparedArtifacts.result.report);
          targetedArtifactContent = verifiedTarget.content;
        }
      }

      const finishReason = acc.finishReason;
      // Reconcile token usage across providers and estimate the $ cost once.
      // The prompt-character floor covers a provider that under-reports input.
      const usage = buildUsage(
        modelInfo,
        researchNotice ? { input: 0, output: 0, promptChars: 0, completionChars: 0 } : acc.rawUsage({ promptChars: synthesisPromptChars() }),
        acc.servedFast
      );

      // Persist the assistant message — generation succeeded, so it's safe to
      // version-and-overwrite the answer being regenerated (see the helper).
      // promptTokens stores the full prompt size (cache included) so the
      // reloaded cost estimate lines up with the stream.
      if (!(await receipt.renew())) throw new DurableReceiptLeaseLostError();
      const targetedArtifact =
        artifactEditTarget && targetedArtifactContent !== null
          ? await persistTargetedArtifactEdit(
              artifactEditTarget.id,
              artifactEditTarget.version,
              targetedArtifactContent,
              user.id
            )
          : null;
      // The re-emit guard: a re-emit over a person's edit, or one that would
      // drop a design's structure, is saved as an empty tag naming its
      // suggestion, and its body goes into the suggestion instead of the
      // transcript (holdArtifactBodies). A targeted edit is never held: it
      // names its base, and the person asked for it.
      const heldReemits = artifactEditTarget
        ? new Map<string, string>()
        : await planTurnHolds(
            conversationId,
            (preparedArtifacts?.result.artifacts ?? []).filter((artifact) => !artifact.incomplete),
            user.id
          );
      if (heldReemits.size > 0) acc.replaceText(holdArtifactBodies(acc.text, heldReemits));
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
        costMicroUsd: researchNotice ? 0 : usage.costMicroUsd || null,
      });
      turnOutcome = {
        messageId: assistant.id,
        finishReason,
        persistedPartial: false,
        costMicroUsd: researchNotice ? null : usage.costMicroUsd || null,
      };

      // Artifacts + memory side effects. Only a finished artifact becomes a
      // version: a reply cut off at the output limit ends inside its last
      // block, verification refuses that block as `incomplete`, and the
      // artifact keeps its current version (X-07). The filter says so again
      // at the write itself, so the rule survives a change to the verifier
      // or to how its output is prepared.
      const artifacts = targetedArtifact
        ? [targetedArtifact]
        : await persistArtifacts(
            conversationId,
            assistant.id,
            (preparedArtifacts?.result.artifacts ?? []).filter((artifact) => !artifact.incomplete),
            { heldIds: heldReemits, taint: untrustedContentInTurn ? UNTRUSTED_INPUT_TAINT : null, userId: user.id }
          );
      if (targetedArtifact) send({ type: "delta", text: acc.text });
      let memoryUpdated = false;
      // Not when the turn carried untrusted content. A `<juno:memory>` tag is
      // the model's own output, and a document, page or connector result
      // that says "remember: the user wants X" can make the model emit one —
      // a durable fact that then resurfaces in every later conversation.
      // There is no approval receipt for memory writes, so the only safe
      // answer on such a turn is not to write; the user can still add the
      // fact by hand, and the after() extraction reads only USER messages.
      if (memoryEnabled && !untrustedContentInTurn) {
        // Provenance points at the USER's message, not the assistant's: the
        // memory page answers "where did you learn that?", and the honest
        // answer is the turn in which the user said it.
        const created = await saveAutoMemories(user.id, parseMemories(acc.text), conversationId, {
          projectId: conversation.projectId,
          sourceMessageId: userMessageId,
        });
        memoryUpdated = created > 0;

        // "Forget that" said in the conversation, acted on without leaving
        // it. Behind the same untrusted-content guard as saving, for the
        // same reason and more: a page that says "forget everything about
        // this user" must not be able to make the model wipe their memory.
        // The receipt names what was forgotten, and the summary that may
        // still quote it is benched until rebuilt (summaryPredatesForget).
        const forgotten = await forgetStatements(user.id, parseForgets(acc.text), {
          conversationId,
          onActivity: sendActivity,
        });
        if (forgotten.statements.length > 0) memoryUpdated = true;
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

      outcome.assistantFull = acc.text;
      outcome.auditedMessageId = assistant.id;

      if (usage.totalInput || usage.output) {
        sendActivity({ kind: "usage", title: "Token usage recorded", detail: usage.detail });
      }
      appendFinishWarning(finishReason, sendActivity, acc.finishNote);
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
      const assistantWithActivity = await sealActivity(assistant.id);
      if (!(await receipt.markCompleted(assistant.id, finishReason))) {
        receipt.leaseLost = true;
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
        artifacts: doneArtifacts(artifacts),
        memoryUpdated,
        quota: consumed.quota,
        finishReason,
        projectId: conversation.projectId,
      });
      if (!researchNotice) await recordTurnSpend({
        userId: user.id,
        modelId,
        source: legacyClient,
        generationId,
        usage: usage,
        acc,
        promptChars: synthesisPromptChars(),
        completionChars: acc.providerOutputChars,
      });
      spendRecorded = true;
      traceEnd = { finishReason, outcome: "completed", usage: traceUsage(usage, acc) };
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
          shutdown: wasGenerationAbortedForShutdown(generationId),
          leaseLost: receipt.leaseLost || err instanceof DurableReceiptLeaseLostError,
          error: err,
        },
        {
          hasText: !!acc.text,
          hasReasoning: !!acc.reasoning,
          artifactEdit: !!artifactEditTarget,
        }
      );
      const reason = terminal.finishReason;
      const cancellation = {
        userStopped: wasGenerationStopped(generationId),
        budgetHalted,
        stalled: stallWatchdog.stalled,
        shutdown: wasGenerationAbortedForShutdown(generationId),
        leaseLost: receipt.leaseLost || err instanceof DurableReceiptLeaseLostError,
      };
      // Overwritten below if the partial answer is saved.
      turnOutcome = { messageId: null, finishReason: reason, persistedPartial: false, costMicroUsd: null };
      if (classifyProviderError(err).class === "rate_limit") recordProviderRateLimit(modelInfo.provider);
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
            researchNotice ? { input: 0, output: 0, promptChars: 0, completionChars: 0 } : acc.rawUsage({ promptChars: synthesisPromptChars() }),
            acc.servedFast
          );
          const preparedArtifacts = prepareChatArtifactOutput(acc.text, sendActivity);
          if (preparedArtifacts) acc.replaceText(preparedArtifacts.text);
          // Held exactly as on the success path: a finished block before the
          // Stop is a re-emit like any other.
          const heldReemits = await planTurnHolds(
            conversationId,
            (preparedArtifacts?.result.artifacts ?? []).filter((artifact) => !artifact.incomplete),
            user.id
          );
          if (heldReemits.size > 0) acc.replaceText(holdArtifactBodies(acc.text, heldReemits));
          // Same version-preserving persistence as the success path — a
          // partial answer still supersedes (never destroys) the previous one.
          if (!(await receipt.renew())) throw new DurableReceiptLeaseLostError();
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
            costMicroUsd: researchNotice ? 0 : partialUsage.costMicroUsd || null,
          });
          turnOutcome = {
            messageId: assistant.id,
            finishReason: reason,
            persistedPartial: true,
            costMicroUsd: researchNotice ? null : partialUsage.costMicroUsd || null,
          };
          // Only finished artifacts, as on the success path. A Stop inside a
          // block leaves it unfinished: the partial answer is still saved,
          // and the artifact keeps its current version (X-07).
          const artifacts = await persistArtifacts(
            conversationId,
            assistant.id,
            (preparedArtifacts?.result.artifacts ?? []).filter((artifact) => !artifact.incomplete),
            { heldIds: heldReemits, taint: untrustedContentInTurn ? UNTRUSTED_INPUT_TAINT : null, userId: user.id }
          );
          await prisma.conversation.updateMany({
            where: { id: conversationId, userId: user.id },
            data: { lastMessageAt: new Date(), model: conversationModelId },
          });
          const assistantWithActivity = await sealActivity(assistant.id);
          outcome.assistantFull = acc.text;
          outcome.auditedMessageId = assistant.id;
          outcome.researchGenerationPartial = true;
          if (!(await receipt.markCompleted(assistant.id, reason))) {
            receipt.leaseLost = true;
            throw new DurableReceiptLeaseLostError();
          }
          send({
            type: "done",
            // Read back off the persisted row, same as the success path.
            message: { ...(await serializeMessage(assistantWithActivity)), finishReason: reason, costUsd: partialUsage.cost + researchCostUsd || undefined },
            artifacts: doneArtifacts(artifacts),
            memoryUpdated: false,
            quota: consumed.quota,
            finishReason: reason,
            title: convoTitle,
            projectId: conversation.projectId,
          });
          if (!spendRecorded && !researchNotice) {
            await recordTurnSpend({
              userId: user.id,
              modelId,
              source: legacyClient,
              generationId,
              usage: partialUsage,
              acc,
              promptChars: synthesisPromptChars(),
              completionChars: acc.providerOutputChars,
            });
            spendRecorded = true;
          }
          traceEnd = { finishReason: reason, outcome: "partial", usage: traceUsage(partialUsage, acc), cancellation };
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
            receipt.leaseLost || persistErr instanceof DurableReceiptLeaseLostError,
            PERSISTENCE_FAILED_FAILURE_CODE
          );
          await receipt.markFailed("error", failureCode);
          traceEnd = { finishReason: "error", outcome: "failed", failureCode, error: persistErr, cancellation };
          send({
            type: "error",
            message: providerErrorMessage(persistErr, { model: modelInfo.name, provider: PROVIDERS[modelInfo.provider].label }),
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
                : err instanceof ChatArtifactVerificationError
                  ? "The edited canvas failed verification, so nothing was changed. Fix the source and try again."
                : stallWatchdog.stalled
                  ? stallMessageFor(stallWatchdog)
                  : wasGenerationAbortedForShutdown(generationId)
                    ? SHUTDOWN_USER_MESSAGE
                    : providerErrorMessage(err, { model: modelInfo.name, provider: PROVIDERS[modelInfo.provider].label });
        sendActivity({
          kind: "warning",
          title: finishReasonTitle(reason),
          detail: message,
        });
        const failureCode = terminal.failureCode;
        await receipt.markFailed(reason, failureCode);
        traceEnd = {
          finishReason: reason,
          outcome: reason === "user_stopped" ? "stopped" : "failed",
          failureCode,
          error: err,
          cancellation,
        };
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
      // Auto's feedback loop: one content-free row per saved-chat turn
      // (src/lib/router/telemetry-store.ts). Research notices are not model
      // turns; the smoke provider is not a model at all.
      if (turnOutcome && !researchNotice && !deterministicSmokeProviderEnabled) {
        const outcome = turnOutcome;
        void recordRoutingOutcome({
          ...routingTelemetryBase,
          messageId: outcome.messageId,
          effort: (autoReasoningEffort !== undefined ? autoReasoningEffort : requestedEffort) ?? null,
          latencyMs: Date.now() - turnStartedAt,
          firstTokenMs: null,
          toolRounds: acc.currentRound,
          retryCount: 0,
          completionState: completionStateFor(outcome.finishReason, outcome.persistedPartial),
          finishReason: outcome.finishReason,
          costMicroUsd: outcome.costMicroUsd,
        });
      }
      // Paid search engines this turn called, billed once whatever the turn's
      // ending (a failed turn that searched still searched).
      if (alevrSearchTurn) {
        await recordToolFees(alevrSearchTurn.fees, recordSpend, { userId: user.id, source: legacyClient }).catch(() => 0);
      }
      trace.finish(traceEnd ?? { finishReason: "error", outcome: "failed", failureCode: INTERNAL_ERROR_FAILURE_CODE });
      toolWatch.releaseAll();
      stallWatchdog.stop();
      stopGenerationTimers();
      // The execution and skill providers' sessions, best-effort.
      await toolProviderSessions?.close().catch(() => undefined);
      /*
       * RELEASE THE HOLD THIS TURN NEVER SPENT.
       *
       * `reserveSpend` opens a hold before the model is called and
       * `recordSpend` settles it — and `recordSpend` is the ONLY thing that
       * ever did. So a turn that ended without one (a stream aborted before
       * its first token, a provider that failed outright, a research notice,
       * which records no spend by design) left its hold open against the
       * account until the hourly sweep found it. Production was carrying ten
       * of them when this was written.
       *
       * A hold is an over-statement of what the account has spent, so while
       * it sits there the budget gate refuses work the user has room for.
       * That is the actual cost of the leak; the sweep was only ever the
       * cleanup.
       *
       * Guarded by `spendRecorded` rather than left unconditional so a
       * normal turn pays nothing extra: a settled reservation would find no
       * `open` row and return false anyway, but it would still cost the
       * round trip to discover that. Failure is swallowed — the answer has
       * already been delivered, and the sweep remains the backstop.
       */
      if (!spendRecorded) {
        await releaseSpend(user.id, generationId).catch(() => {});
      }
      // After the terminal frame, before the registry entry goes: a client
      // that reconnects between the two must find the `done`/`error` in the
      // log rather than tail a generation this process no longer has.
      await streamLog?.close();
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
        stopGenerationTimers();
        const finishReason = classifyErrorFinishReason(error);
        const failureCode = terminalFailureCode(receipt.leaseLost, INTERNAL_ERROR_FAILURE_CODE);
        await receipt.markFailed(finishReason, failureCode);
        trace.finish({ finishReason, outcome: "failed", failureCode, error });
        /*
         * A throw before generate()'s own try (the research leg, building the
         * native tools) skips that try's `finally`, which is what releases the
         * spend hold and closes the tool providers' sessions. Nothing was
         * recorded on this path, so the hold is released here; leaving it
         * open over-stated the account's spend until the hourly sweep.
         */
        await releaseSpend(user.id, generationId).catch(() => {});
        await toolProviderSessions?.close().catch(() => undefined);
        const quota = await refundMessage(user.id, plan).catch(() => consumed.quota);
        const message = providerErrorMessage(error, { model: modelInfo.name, provider: PROVIDERS[modelInfo.provider].label });
        // This path bypasses the sender, so the frame is logged by hand. A
        // reconnecting client would otherwise tail a log whose last frame is
        // mid-answer and wait out the terminal grace before giving up.
        const terminal: StreamChunk = {
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
        };
        const terminalSeq = streamLog?.record(terminal) ?? undefined;
        try {
          controller.enqueue(encodeChunk(terminal, terminalSeq));
        } catch {
          /* client disconnected */
        }
        await streamLog?.close();
        unregisterGeneration();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return { response: new Response(stream, { headers: SSE_HEADERS }), generation: genPromise!, outcome };
}
