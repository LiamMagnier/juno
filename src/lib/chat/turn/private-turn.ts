import "server-only";
import { budgetExceededBody } from "@/lib/billing/budget-fallback";
import { NextResponse, after } from "next/server";
import type { Plan } from "@prisma/client";
import type { EffectiveBudget } from "@/lib/spend-ceiling";
import { consumeMessage, consumeRefusalBody, refundMessage } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { isAutoModelId } from "@/lib/auto-model";
import { PROVIDERS } from "@/lib/providers";
import { buildSystemPromptSections, buildDynamicContext } from "@/lib/anthropic";
import { finishReasonTitle } from "@/lib/finish-reason";
import { registerGeneration, wasGenerationAbortedForShutdown, wasGenerationStopped } from "@/lib/generation-cancel";
import { streamChat, providerErrorMessage } from "@/lib/llm";
import { checkBudget, releaseSpend, reserveSpend, modelRatesMicroUsdPerToken, type billingPeriodFor } from "@/lib/spend";
import { createSseSender, SSE_HEADERS } from "@/lib/chat-stream";
import { DEFAULT_PERSONALITY } from "@/lib/personalities";
import { supportsFastMode } from "@/lib/pricing";
import { supportsProMode } from "@/lib/model-metrics";
import { buildUsage } from "@/lib/chat-usage";
import { createStallWatchdog, stallDetail, stallMessageFor } from "@/lib/chat-stall";
import { createStreamBudgetGuard } from "@/lib/chat-budget-guard";
import { appendFinishWarning, effectiveReasoningEffort, plural } from "@/lib/chat-responses";
import { moderateUserMessages } from "@/lib/moderation-ai";
import { promptChars } from "@/lib/chat/context-assembly";
import { privateModeFeatureRefusal } from "@/lib/chat/entitlements";
import { postGenerationPlan } from "@/lib/chat/post-processing";
import { appendSkillBlock, composeSystemPrompt } from "@/lib/chat/prompt-sections";
import { loadChatSkill } from "@/lib/chat/skill-runtime";
import { CHAT_SKILL_REFUSAL_MESSAGES, skillAppliedActivity } from "@/lib/chat/skills";
import { contextActivityRows } from "@/lib/chat/context-resolution";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import { INTERNAL_ERROR_FAILURE_CODE, resolveTerminalState } from "@/lib/chat/terminal-state";
import { REQUEST_ID_HEADER } from "@/lib/request-id";
import { SHUTDOWN_USER_MESSAGE } from "@/lib/shutdown";
import type { TurnRequest } from "./admission";
import { refuse, usageWindowRefusal } from "./admission";
import type { TurnSettings } from "./account";
import type { TurnModel } from "./model";
import type { TurnTokens } from "./context";
import { skillSettlement } from "./context";
import { createToolActivity, prepareChatArtifactOutput, privateAssistantMessage } from "./activity";
import { withRegenerateInstruction } from "./prompt";
import { pumpTurnStream, sendReasoningAndSearch, sendSelectedModel } from "./run-stream";
import { recordTurnSpend } from "./spend";
import { createTurnTrace, traceUsage } from "./trace";
import { emitTurnTrace } from "./trace-sink";
import type { TurnUser } from "./types";

/*
 * Pipeline — the private turn, start to finish.
 *
 * Private mode persists nothing: no conversation, no message, no activity,
 * no audit row, no stream log. It shares the saved turn's model resolution,
 * activity shaping, stream loop, terminal-state model and spend ledger, and
 * differs only in what it refuses to keep. Moved out of the route intact;
 * tests/chat-turn-pipeline.integration.test.ts pins it.
 */
export async function runPrivateTurn({
  req,
  user,
  request,
  settings,
  plan,
  period,
  effective,
  model,
  tokens,
  toolDetailEnabled,
}: {
  req: Request;
  user: TurnUser;
  request: TurnRequest;
  settings: TurnSettings;
  plan: Plan;
  period: ReturnType<typeof billingPeriodFor>;
  effective: EffectiveBudget;
  model: TurnModel;
  tokens: TurnTokens;
  toolDetailEnabled: boolean;
}): Promise<Response> {
  const { input, privateHistory, legacyClient, moderate, moderationTexts } = request;
  const { modelInfo, modelId, requestedId, requestedEffort, autoReasoningEffort, routingNote, routingWarning } = model;
  const { turnContext, activeConnectors, turnSkillSlug } = tokens;
  const unavailable = privateModeFeatureRefusal(input);
  if (unavailable) return refuse(unavailable);

  const budget = await checkBudget(user.id, plan, period, effective);
  if (!budget.allowed) {
    return NextResponse.json(budgetExceededBody(plan, budget.resetsAtMs), { status: 402 });
  }
  const windowed = await usageWindowRefusal(user.id, plan, period, effective);
  if (windowed) return windowed;

  const consumed = await consumeMessage(user.id, plan);
  if (!consumed.allowed) {
    return NextResponse.json(consumeRefusalBody(consumed), { status: 402 });
  }

  const useWebSearch = !!input.webSearch && PLANS[plan].webSearch && modelInfo.webSearch;
  const useFastMode = !!input.fastMode && supportsFastMode(modelInfo);
  const useProMode = !!input.proMode && supportsProMode(modelInfo);
  /*
   * A skill applies here too.
   *
   * Private mode persists nothing, and a skill is the user's own stored
   * instructions rather than anything that leaves the account — so the reason
   * private mode refuses canvas edits and regenerates (both need a row) does
   * not reach this. The one thing that differs is the grant: this branch has
   * no connectors, no canvas and no attachment tools, so a skill asking for
   * any of them is told it did not get them, which is true.
   */
  const privateSkill = turnSkillSlug
    ? await loadChatSkill({
        userId: user.id,
        slug: turnSkillSlug,
        capabilities: {
          webSearch: useWebSearch,
          canvas: false,
          documents: false,
          images: false,
          connectors: [],
        },
      })
    : null;
  const privateSkillBlock = privateSkill?.applied ? privateSkill.application : null;
  turnContext.settleSkill(skillSettlement(privateSkill));
  const baseSystemSections = buildSystemPromptSections({
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
    // outside content like any other — and an unvouched-for skill's
    // instructions go into the prompt inside the same envelope, so the rule
    // that reads those markers has to be present whenever one did. Markers
    // with no rule look like a boundary and are not one.
    untrustedContent: useWebSearch || !!privateSkillBlock?.untrusted,
  });
  const baseSystem = baseSystemSections.variable
    ? `${baseSystemSections.stable}\n\n${baseSystemSections.variable}`
    : baseSystemSections.stable;
  // Same composition the saved path uses. The two used to be hand-written
  // expressions that happened to agree.
  const system = withRegenerateInstruction(
    appendSkillBlock(
      composeSystemPrompt({ base: baseSystem, webSearch: useWebSearch, canvasOn: false }),
      privateSkillBlock
    ),
    input
  );
  const generationId = input.generationId ?? crypto.randomUUID();
  // The per-turn trace (trace.ts): ids, model, timings, counts and outcome —
  // nothing a private turn promises not to keep (no text, no conversation).
  const trace = createTurnTrace({
    runId: generationId,
    requestId: req.headers.get(REQUEST_ID_HEADER),
    accountId: user.id,
    conversationId: null,
    surface: "private",
    client: legacyClient,
    agentId: null,
    model: { id: modelInfo.id, provider: modelInfo.provider },
    requestedModel: requestedId,
    rerouted: !!routingWarning,
    reasoningEffort: autoReasoningEffort ?? requestedEffort,
    features: {
      webSearch: useWebSearch,
      research: false,
      connectors: 0,
      actingTools: 0,
      skill: !!privateSkill?.applied,
      artifactEdit: false,
      regenerate: !!input.regenerate,
    },
  }, emitTurnTrace);
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
      // What became of the tokens: in incognito only a skill applies, and
      // the rest say so rather than vanishing.
      for (const row of contextActivityRows(turnContext.receipt())) sendActivity(row);
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
        sendSelectedModel(sendActivity, { modelInfo, routingNote, routingWarning });
        // The saved path's refusal row, sent the same way. Here it goes only
        // to the reader, in the stream and the final message: this branch
        // stores no activity and writes no audit row, so it leaves no trace.
        if (privateSkill && !privateSkill.applied) {
          sendActivity({
            kind: "warning",
            title: "Skill not applied",
            detail: CHAT_SKILL_REFUSAL_MESSAGES[privateSkill.reason],
          });
        }
        // Progressive disclosure the reader can see: the skill that shaped
        // this turn is named in the run instead of vanishing into the prompt.
        if (privateSkill?.applied) {
          sendActivity(skillAppliedActivity(privateSkill.application));
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
          autoReasoningEffort !== undefined ? autoReasoningEffort ?? undefined : requestedEffort
        );
        sendReasoningAndSearch(sendActivity, {
          reasoningEffort,
          auto: isAutoModelId(requestedId),
          webSearch: useWebSearch,
          modelInfo,
        });

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
            cacheReadTokens: acc.tokens.cacheReadTokens,
            // Anthropic's input_tokens exclude cache reads; every other adapter
            // reports a prompt count that includes them (pricing.ts, normalizeUsage).
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
        const enforceStreamBudget = () => budgetGuard.enforce();

        await pumpTurnStream(
          streamChat({
            model: modelInfo,
            system,
            systemStablePrefix: baseSystemSections.stable,
            history: privateHistory,
            maxTokens: PLANS[plan].maxOutputTokens,
            signal: generationController.signal,
            reasoningEffort,
            webSearch: useWebSearch,
            // Deliberately empty — see the warning above. Passing them would only
            // reach `streamChat`'s "connectors without an audit identity" branch,
            // which logs the same refusal as an internal bug.
            connectors: [],
            dynamicContext: buildDynamicContext(input.timeZone),
            // Private chats have no stable conversation id; group the cache by
            // user (their system prompt is the shared prefix).
            cacheKey: `private-${user.id}`,
            fastMode: useFastMode,
            proMode: useProMode,
          }),
          {
            acc,
            stallWatchdog,
            toolActivity,
            send,
            sendActivity,
            enforceStreamBudget,
            writing: { title: "Writing the private answer", detail: "Streaming response text" },
            forwardDeltas: true,
          }
        );
        // Provider done — stop measuring silence before Juno's own work. See
        // the same call on the persisted path.
        stallWatchdog.stop();

        const preparedArtifacts = prepareChatArtifactOutput(acc.text, sendActivity);
        if (preparedArtifacts) acc.replaceText(preparedArtifacts.text);

        const finishReason = acc.finishReason;
        const usage = buildUsage(modelInfo, acc.rawUsage({ promptChars: privatePromptChars() }), acc.servedFast);
        if (usage.totalInput || usage.output) {
          sendActivity({ kind: "usage", title: "Token usage recorded", detail: usage.detail });
        }
        appendFinishWarning(finishReason, sendActivity, acc.finishNote);
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
        await recordTurnSpend({
          userId: user.id,
          modelId,
          source: legacyClient,
          generationId,
          usage: usage,
          acc,
          promptChars: privatePromptChars(),
          completionChars: acc.text.length,
        });
        spendRecorded = true;
        trace.finish({ finishReason, outcome: "completed", usage: traceUsage(usage, acc) });
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
            shutdown: wasGenerationAbortedForShutdown(generationId),
            leaseLost: false,
            error: err,
          },
          { hasText: !!acc.text, hasReasoning: !!acc.reasoning, artifactEdit: false }
        );
        const reason = terminal.finishReason;
        const cancellation = {
          userStopped: wasGenerationStopped(generationId),
          budgetHalted,
          stalled: stallWatchdog.stalled,
          shutdown: wasGenerationAbortedForShutdown(generationId),
        };
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
            await recordTurnSpend({
              userId: user.id,
              modelId,
              source: legacyClient,
              generationId,
              usage: partialUsage,
              acc,
              promptChars: privatePromptChars(),
              completionChars: acc.text.length,
            });
            spendRecorded = true;
          }
          trace.finish({ finishReason: reason, outcome: "partial", usage: traceUsage(partialUsage, acc), cancellation });
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
            : wasGenerationAbortedForShutdown(generationId)
              ? SHUTDOWN_USER_MESSAGE
              : reason === "user_stopped"
                ? "Generation stopped before any output."
                : providerErrorMessage(err, { model: modelInfo.name, provider: PROVIDERS[modelInfo.provider].label });
          sendActivity({
            kind: "warning",
            title: finishReasonTitle(reason),
            detail: message,
          });
          send({ type: "error", message, quota, finishReason: reason });
          trace.finish({
            finishReason: reason,
            outcome: reason === "user_stopped" ? "stopped" : "failed",
            failureCode: terminal.failureCode,
            error: err,
            cancellation,
          });
        }
      } finally {
        trace.finish({ finishReason: "error", outcome: "failed", failureCode: INTERNAL_ERROR_FAILURE_CODE });
        stallWatchdog.stop();
        clearInterval(heartbeat);
        // Same leak, same fix as the saved path below: `recordSpend` is the
        // only thing that settles this turn's hold, so a turn that never
        // reaches one has to give the headroom back itself.
        if (!spendRecorded) {
          await releaseSpend(user.id, generationId).catch(() => {});
        }
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
      moderateUserMessages({
        userId: user.id,
        texts: moderationTexts,
        redactPreview: true,
        // The classifier is background work on the user's own words, so the
        // background-provider policy decides where it may be sent. Without
        // this anchor `same_provider` matched null, the walk refused, and a
        // fail-open classifier reported every message as clean.
        conversationProvider: modelInfo.provider,
      }).catch(() => {})
    );
  }

  return new Response(stream, { headers: SSE_HEADERS });
}
