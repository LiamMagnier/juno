import { NextResponse, after } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { refundMessage } from "@/lib/usage";
import { DurableFirstSubmissionStartError } from "@/lib/chat-responses";
import { appendVolatileTail, buildTurnContextTail } from "@/lib/chat/turn-context-tail";
import { REQUEST_ID_HEADER } from "@/lib/request-id";
import { DRAIN_RETRY_AFTER_SECONDS, DRAINING_RESPONSE, isDraining } from "@/lib/shutdown";
import { resolveTurnContext } from "@/lib/chat/turn/admission";
import { resolveAccount } from "@/lib/chat/turn/account";
import { resolveAssistantIdentity } from "@/lib/chat/turn/identity";
import { resolveModel } from "@/lib/chat/turn/model";
import { resolveTurnTokens } from "@/lib/chat/turn/context";
import { runPrivateTurn } from "@/lib/chat/turn/private-turn";
import { acceptTurn } from "@/lib/chat/turn/accept";
import { resolveHistory } from "@/lib/chat/turn/history";
import { resolveMemory } from "@/lib/chat/turn/memory";
import { resolveProjectContext } from "@/lib/chat/turn/project-context";
import { resolveCapabilities, turnCarriesUntrustedContent } from "@/lib/chat/turn/capabilities";
import { resolveSkills } from "@/lib/chat/turn/skills";
import { resolveApprovals } from "@/lib/chat/turn/approvals";
import { resolveTools } from "@/lib/chat/turn/tools";
import { composeTurnSystem } from "@/lib/chat/turn/prompt";
import { runTurn } from "@/lib/chat/turn/run-turn";
import { finalizeOutputs } from "@/lib/chat/turn/finalize";
import { failDurableReceiptAtStart } from "@/lib/chat/turn/durable-receipt";
import { createTurnTrace } from "@/lib/chat/turn/trace";
import { emitTurnTrace } from "@/lib/chat/turn/trace-sink";
import { isRefusal } from "@/lib/chat/turn/types";

export const runtime = "nodejs";
// Self-hosted (a plain `next start` Node process on the VM) has NO per-request
// function timeout — the generation runs until the model finishes thinking.
// `maxDuration` is a Vercel-only directive that `next start` ignores, so we no
// longer set it: that is what removes the old 300s wall. The only remaining
// ceiling is nginx's proxy_read_timeout (3600s in deploy/nginx.conf.template),
// which the 15s SSE heartbeat below keeps resetting so it effectively never
// fires. Keep RECOVERY_WINDOW_MS in use-chat.ts in sync with that nginx value.

/*
 * POST /api/chat — THE TURN ORCHESTRATOR.
 *
 * This route sequences the chat turn pipeline (src/lib/chat/turn/, described
 * in docs/rework/program/ORCHESTRATION.md) and owns nothing else. Each stage
 * returns its resolution or the Response that ends the request:
 *
 *   resolveTurnContext → resolveAccount → resolveAssistantIdentity →
 *   resolveModel → resolveTurnTokens → (private: runPrivateTurn) →
 *   acceptTurn → resolveHistory → resolveMemory ∥ resolveProjectContext →
 *   resolveCapabilities → resolveSkills → resolveApprovals → resolveTools →
 *   composeTurnSystem → runTurn → finalizeOutputs (after the response)
 *
 * Provider-specific code lives behind `streamChat` (src/lib/llm.ts); every
 * permission decision is a deterministic function of the account, the plan,
 * the model's verified capabilities and the project assistant — never of the
 * model's output. Behaviour is pinned by tests/chat-turn-pipeline.integration.test.ts.
 */
async function handleChat(req: Request) {
  // A process that has been told to stop takes no new generations: whatever
  // it started now it would have to abort in a few seconds anyway. Answered
  // before auth so the retry costs nothing; the client backs off and lands on
  // the replacement process.
  if (isDraining()) {
    return NextResponse.json(DRAINING_RESPONSE, {
      status: 503,
      headers: { "Retry-After": String(DRAIN_RETRY_AFTER_SECONDS) },
    });
  }
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const request = await resolveTurnContext(req, user);
  if (isRefusal(request)) return request;
  const { input } = request;

  const account = await resolveAccount(user);
  if (isRefusal(account)) return account;
  const { settings, plan, period, effective, toolDetailEnabled } = account;

  const identity = await resolveAssistantIdentity({ user, input });
  if (isRefusal(identity)) return identity;
  const { roomSetup, workspaceConfig, selectedKnowledgeFileIds, threadAgent } = identity;

  const model = await resolveModel({
    user,
    input,
    plan,
    settings,
    workspaceConfig,
    threadAgent,
    privateHistory: request.privateHistory,
    deterministicSmokeProviderEnabled: request.deterministicSmokeProviderEnabled,
    period,
    effective,
  });
  if (isRefusal(model)) return model;
  const { modelInfo } = model;

  const tokens = await resolveTurnTokens({ user, input, settings, workspaceConfig, modelInfo });
  const { turnContext, activeConnectors } = tokens;

  if (input.privateMode) {
    return runPrivateTurn({ req, user, request, settings, plan, period, effective, model, tokens, toolDetailEnabled });
  }

  const accepted = await acceptTurn({
    user,
    input,
    plan,
    period,
    effective,
    account: account.account,
    firstSubmissionHash: request.firstSubmissionHash,
    legacyOrphanConversationId: request.legacyOrphanConversationId,
    requestedConnectorIDs: tokens.requestedConnectorIDs,
    conversationModelId: model.conversationModelId,
    turnContext,
    roomSetup,
  });
  if (isRefusal(accepted)) return accepted;
  const { conversation, userMessageId, durableGenerationId, artifactEditTarget, roomMessageId } = accepted;

  try {
    const turnHistory = await resolveHistory({
      userId: user.id,
      conversationId: conversation.id,
      staleAssistantId: accepted.staleAssistantId,
      roomSetup,
      userMessageId,
      hiddenUserContent: accepted.clarificationModelContent ?? accepted.preflightClarificationModelContent,
      modelInfo,
    });
    // Memory and project context are independent reads of different tables;
    // they used to run one after the other on the path to the first token.
    const [memory, context] = await Promise.all([
      resolveMemory({
        userId: user.id,
        settings,
        workspaceConfig,
        projectId: conversation.projectId,
        latestUserMessage: [...turnHistory.baseHistory].reverse().find((m) => m.role === "USER")?.content,
      }),
      resolveProjectContext({
        user,
        input,
        settings,
        modelInfo,
        workspaceConfig,
        selectedKnowledgeFileIds,
        conversation,
        turnHistory,
        turnContext,
        contextPort: tokens.contextPort,
        userMessageId,
      }),
    ]);
    const { attachmentToolToggles } = context;

    const capabilities = resolveCapabilities({ input, plan, modelInfo, workspaceConfig });
    const { researchActive, useWebSearch, useProMode, canvasOn } = capabilities;

    const skill = await resolveSkills({
      userId: user.id,
      input,
      turnSkillSlug: tokens.turnSkillSlug,
      projectId: conversation.projectId,
      grant: {
        webSearch: useWebSearch,
        canvas: canvasOn,
        documents: attachmentToolToggles.documents,
        images: attachmentToolToggles.images,
        connectors: activeConnectors.map((connector) => connector.id),
      },
      turnContext,
      durableGenerationId,
    });
    const { appliedSkill } = skill;

    const untrustedContentInTurn = turnCarriesUntrustedContent({
      connectors: activeConnectors.length,
      useWebSearch,
      researchActive,
      projectKnowledge: !!context.projectKnowledge,
      attachmentKnowledge: !!context.attachmentKnowledge,
      projectReferenceFiles: context.projectReferenceFiles !== "",
      historyCarriesAttachmentText: context.historyCarriesAttachmentText,
      untrustedSkill: !!appliedSkill?.untrusted,
      documentTool: attachmentToolToggles.documents,
      historyHasToolNotes: context.historyHasToolNotes,
      contextTokensUntrusted: turnContext.untrusted,
    });

    const approvals = await resolveApprovals({
      user,
      input,
      plan,
      settings,
      modelInfo,
      useWebSearch,
      useProMode,
      researchActive,
      userMessageId,
      artifactEdit: !!artifactEditTarget,
      conversation,
      roomSetup,
      appliedSkill,
    });
    const { agentContext } = approvals;

    /*
     * The referenced-context block, and the history the model reads with it.
     * Decided here because a named crew member's ask goes to
     * `hand_off_to_teammate` only when this turn carries that tool — the agent
     * context above says whether it does, and the handoff tool below exists
     * only with a user message to key it on.
     */
    const contextBlock = turnContext.turnBlock({ handoffAvailable: !!agentContext?.handoff && !!userMessageId });
    /*
     * The per-generation tail: the memory notes ranked for this question, the
     * extracts retrieved for it, and the references the user named. After the
     * conversation, never in the system prompt, so the cached prefix (system +
     * history) survives a question that ranks or retrieves differently — see
     * src/lib/chat/turn-context-tail.ts.
     */
    const turnTail = buildTurnContextTail({
      memoryNotes: memory.memoryEnabled ? memory.memoryProfile.recent : [],
      memoryScope: memory.memoryProfile.summaryScope,
      hasMemorySummary: !!memory.memoryProfile.summary,
      retrieved: context.retrievedContext,
      references: contextBlock,
    });
    const turnHistoryForModel = appendVolatileTail(context.modelHistory, turnTail);
    const generationId = durableGenerationId ?? input.generationId ?? crypto.randomUUID();

    const tools = await resolveTools({
      user,
      input,
      plan,
      settings,
      modelInfo,
      capabilityProbes: model.capabilityProbes,
      useProMode,
      generationId,
      conversation,
      appliedSkill,
      artifactEdit: !!artifactEditTarget,
      workspaceConfig,
      functionToolsReachModel: approvals.taskGate.functionToolsReachModel,
      attachmentToolToggles,
    });

    const { system, baseSystemSections } = composeTurnSystem({
      user,
      input,
      settings,
      memory,
      canvasOn,
      promptContext: context.promptContext,
      untrustedContentInTurn,
      taskToolOn: approvals.taskToolOn,
      useWebSearch,
      attachmentToolToggles,
      executionSections: tools.executionSections,
      artifactEditTarget,
      appliedSkill,
      agentContext,
      roomSetup,
      roomMessageId,
    });

    const trace = createTurnTrace({
      runId: generationId,
      requestId: req.headers.get(REQUEST_ID_HEADER),
      accountId: user.id,
      conversationId: conversation.id,
      surface: "saved",
      client: request.legacyClient,
      agentId: approvals.turnAgentId ?? null,
      model: { id: modelInfo.id, provider: modelInfo.provider },
      requestedModel: model.requestedId,
      rerouted: !!model.routingWarning,
      reasoningEffort: model.autoReasoningEffort ?? model.requestedEffort,
      features: {
        webSearch: useWebSearch,
        research: researchActive,
        connectors: activeConnectors.length,
        actingTools: Number(approvals.taskToolOn) + Number(!!agentContext?.handoff) + Number(approvals.agentConfigToolsOn),
        skill: !!appliedSkill,
        artifactEdit: !!artifactEditTarget,
        regenerate: !!input.regenerate,
      },
    }, emitTurnTrace);

    const run = await runTurn({
      req,
      user,
      input,
      plan,
      period,
      effective,
      budget: accepted.budget,
      legacyClient: request.legacyClient,
      doneArtifacts: request.doneArtifacts,
      deterministicSmokeProviderEnabled: request.deterministicSmokeProviderEnabled,
      toolDetailEnabled,
      generationId,
      durableGenerationId,
      conversation,
      conversationModelId: model.conversationModelId,
      userMessageId,
      staleAssistantId: accepted.staleAssistantId,
      artifactEditTarget,
      contextAttachmentIds: accepted.contextAttachmentIds,
      clarificationVisibleContent: accepted.clarificationVisibleContent,
      preflightVisibleContent: accepted.preflightVisibleContent,
      consumed: accepted.consumed,
      roomSetup,
      roomTurnId: accepted.roomTurnId,
      roomMessageId,
      modelInfo,
      modelId: model.modelId,
      requestedId: model.requestedId,
      requestedEffort: model.requestedEffort,
      autoReasoningEffort: model.autoReasoningEffort,
      routingNote: model.routingNote,
      routingWarning: model.routingWarning,
      turnContext,
      activeConnectors,
      memory,
      projectContext: context.projectContext,
      attachmentContext: context.attachmentContext,
      projectKnowledge: context.projectKnowledge,
      attachmentKnowledge: context.attachmentKnowledge,
      allAttachments: context.allAttachments,
      attachmentToolToggles,
      modelHistory: context.modelHistory,
      turnHistory: turnHistoryForModel,
      researchActive,
      researchRequested: capabilities.researchRequested,
      useWebSearch,
      useFastMode: capabilities.useFastMode,
      useProMode,
      skill,
      untrustedContentInTurn,
      approvals,
      tools,
      system,
      baseSystemSections,
      trace,
    });

    // `after` runs once the response is settled — including when the client
    // disconnects. finalizeOutputs awaits the detached generation before any
    // work that needs its answer.
    after(() =>
      finalizeOutputs({
        user,
        moderate: request.moderate,
        moderationTexts: request.moderationTexts,
        memoryEnabled: memory.memoryEnabled,
        modelInfo,
        conversation,
        conversationId: conversation.id,
        outcome: run.outcome,
        generation: run.generation,
      })
    );

    return run.response;
  } catch (error) {
    if (!durableGenerationId || !userMessageId || !conversation) throw error;
    await failDurableReceiptAtStart(user.id, durableGenerationId);
    await refundMessage(user.id, plan).catch(() => {});
    throw new DurableFirstSubmissionStartError(error, {
      generationId: durableGenerationId,
      conversationId: conversation.id,
      userMessageId,
    });
  }
}

/**
 * What the client is told when the request fails before the stream starts.
 *
 * A fixed sentence plus the request id — never `err.message`. The detail used
 * to be echoed verbatim "so the client shows the real reason", and the real
 * reason was a Prisma error naming a column, a provider's account fault, or an
 * internal invariant ("Durable first-submission receipt could not enter the
 * running state"). None of that is for a browser. The request id is what lets
 * a support conversation find the full detail in the server log, where it is
 * still written.
 */
function chatStartFailureMessage(req: Request): string {
  const requestId = req.headers.get(REQUEST_ID_HEADER);
  return requestId
    ? `Couldn't start the chat. Please try again. (request ${requestId})`
    : "Couldn't start the chat. Please try again.";
}

export async function POST(req: Request) {
  // Everything before the SSE stream starts (auth, quota, DB writes for the
  // conversation/message, system-prompt build) runs here. If any of it throws —
  // e.g. a production database missing a migration/column — we must return a
  // JSON { error } so the client shows a real failure instead of an opaque 500
  // rendered as a generic "Something went wrong.". The detail stays in the log.
  try {
    return await handleChat(req);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unexpected server error.";
    console.error("[chat] request failed before streaming", {
      requestId: req.headers.get(REQUEST_ID_HEADER),
      message: detail,
      stack: err instanceof Error ? err.stack : undefined,
    });
    if (err instanceof DurableFirstSubmissionStartError) {
      return NextResponse.json(
        {
          error: chatStartFailureMessage(req),
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
    return NextResponse.json({ error: chatStartFailureMessage(req) }, { status: 500 });
  }
}
