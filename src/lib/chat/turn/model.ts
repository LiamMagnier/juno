import "server-only";
import { NextResponse } from "next/server";
import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cheapestEligible, selectModel } from "@/lib/model-selection";
import { canUseModel } from "@/lib/plans";
import { isModelId, getModel, DEFAULT_MODEL, MODEL_LIST, type ModelInfo } from "@/lib/models";
import { AUTO_MODEL_ID, isAutoModelId, pickAutoModel } from "@/lib/auto-model";
import { isProviderConfigured, configuredProviders, PROVIDERS, type Provider } from "@/lib/providers";
import { providerHealthy } from "@/lib/provider-health";
import { loadModelCapabilityMap, modelCanRoute } from "@/lib/model-capability";
import { isPlatformBudgetExceeded } from "@/lib/platform-budget";
import { formatClarificationModelMessage } from "@/lib/clarification-wizard";
import { formatPreflightClarificationModelMessage } from "@/lib/preflight-clarification";
import { logDebug } from "@/lib/logger";
import { chatSearchAvailable } from "@/lib/web/search";
import { checkBudget, type billingPeriodFor } from "@/lib/spend";
import type { EffectiveBudget } from "@/lib/spend-ceiling";
import { isBudgetLow } from "@/lib/credits";
import { agentTurnModel } from "@/lib/agents/domain";
import type { ChatRequestBody } from "@/lib/chat/request";
import type { WorkspaceConfig } from "@/lib/projects/workspace-config";
import { PRODUCT_NAME } from "@/lib/brand/names";
import type { MessageForModel } from "@/types/llm";
import type { TurnSettings } from "./account";
import type { TurnUser } from "./types";

/*
 * Pipeline stage 4 — resolveModel: which model answers, and why. Requested →
 * agent's → workspace's → user default → app default; Auto routing; provider
 * health and plan eligibility from ONE capability snapshot; the platform
 * budget degradation. Provider-specific behaviour stays in the adapters —
 * this stage only decides identity.
 */

export async function resolveModel({
  user,
  input,
  plan,
  settings,
  workspaceConfig,
  threadAgent,
  privateHistory,
  deterministicSmokeProviderEnabled,
  period,
  effective,
}: {
  user: TurnUser;
  input: ChatRequestBody;
  plan: Plan;
  settings: TurnSettings;
  workspaceConfig: WorkspaceConfig;
  threadAgent: { model: string | null; reasoningEffort: string | null } | null;
  privateHistory: MessageForModel[];
  deterministicSmokeProviderEnabled: boolean;
  period: ReturnType<typeof billingPeriodFor>;
  effective: EffectiveBudget;
}) {
  const agentModel = agentTurnModel({
    agent: threadAgent,
    requestedModel: input.model,
    usable: (id) => {
      if (isAutoModelId(id)) return true;
      const model = getModel(id);
      return (
        !!model &&
        model.modality === "chat" &&
        !model.comingSoon &&
        isProviderConfigured(model.provider) &&
        canUseModel(plan, model.id)
      );
    },
  });
  const namedModel = agentModel.kind === "fallback" ? undefined : input.model;
  const workspacePreferredModel =
    !namedModel && workspaceConfig.preferredModelId && isModelId(workspaceConfig.preferredModelId)
      ? workspaceConfig.preferredModelId
      : null;
  const requestedId =
    agentModel.kind === "agent"
      ? agentModel.model
      : namedModel && isModelId(namedModel)
        ? namedModel
        : workspacePreferredModel
          ? workspacePreferredModel
        : settings?.defaultModel && isModelId(settings.defaultModel)
          ? settings.defaultModel
          : DEFAULT_MODEL;
  /** The thinking effort asked for: the agent's with its model, otherwise the composer's. */
  const requestedEffort =
    agentModel.kind === "agent" && agentModel.reasoningEffort ? agentModel.reasoningEffort : input.reasoningEffort;

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
    // The fair fallback: with under 10% of the month left, Auto keeps to the
    // cost-1 models. A read only (no reaping); the gate proper runs later.
    const autoBudget = await checkBudget(user.id, plan, period, effective, { reap: false }).catch(() => null);
    try {
      const pick = pickAutoModel({
        message: routingMessage,
        plan,
        hasImages,
        wantsWebSearch: !!input.webSearch,
        // Voice keeps the provider's own search (policy.ts), so it never widens the pool.
        alevrSearch: !input.voiceMode && chatSearchAvailable(),
        lowBudget: autoBudget ? isBudgetLow(autoBudget.remainingMicroUsd, autoBudget.budgetMicroUsd) : false,
      });
      modelInfo = pick.model;
      autoReasoningEffort = pick.reasoningEffort;
      routingNote = `Auto picked ${pick.model.name} — ${pick.complexity.level} prompt${
        pick.complexity.reasons.length ? ` (${pick.complexity.reasons.slice(0, 2).join(", ")})` : ""
      }${pick.budgetSaver ? " · saving your remaining budget" : ""}`;
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
  /*
   * The capability rows, kept for the whole request: routing reads the
   * transport verdict here, and the tool entitlements below read the tool
   * round-trip verdict from the same snapshot (src/lib/model-tool-probe.ts).
   * Empty under the deterministic smoke provider, so every model is untested.
   */
  let capabilityProbes: Awaited<ReturnType<typeof loadModelCapabilityMap>> = new Map();
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
    capabilityProbes = await loadModelCapabilityMap(MODEL_LIST.map((model) => model.id));

    // Eligibility and fallback now live in `lib/model-selection.ts`. The rules
    // decide what a turn costs, and inline here they were reachable only by
    // standing up a request with auth, quota and a database behind it.
    //
    // `pickAutoModel` does not consult provider health, so Auto opts into the
    // substitution branch below. Concrete selector choices never do: a user who
    // picks Claude/GPT/etc. must not have that prompt silently sent to Gemini (or
    // any other provider) just because it is the only healthy configured lab.
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
      allowSubstitution: isAutoModelId(requestedId),
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
  // set). Only Auto may pick a cheaper model. A concrete choice is an explicit
  // data-routing decision, so substituting another provider would violate it.
  if (!deterministicSmokeProviderEnabled && modelInfo && (await isPlatformBudgetExceeded())) {
    if (!isAutoModelId(requestedId)) {
      return NextResponse.json(
        {
          error: `The selected model is temporarily unavailable because ${PRODUCT_NAME} reached its daily provider budget. Choose Auto or try again later.`,
          code: "PLATFORM_BUDGET_EXCEEDED",
        },
        { status: 503 }
      );
    }
    const cheapest = cheapestEligible(MODEL_LIST, eligible, (p) => providerHealthy(p as Provider));
    if (cheapest && cheapest.cost < modelInfo.cost) {
      console.warn("[chat] platform budget exceeded — Auto is choosing a cheaper model", {
        from: modelInfo.id,
        to: cheapest.id,
      });
      routingWarning = `Auto chose ${cheapest.name} to stay within today's capacity.`;
      modelInfo = cheapest;
    }
  }

  if (!modelInfo) {
    const requested = !isAutoModelId(requestedId) ? getModel(requestedId) : undefined;
    let msg: string;
    let code = "MODEL_UNAVAILABLE";
    let status = 503;
    if (requested && !isProviderConfigured(requested.provider)) {
      msg = `${PROVIDERS[requested.provider].label} is not configured. Add ${PROVIDERS[requested.provider].apiKeyEnv} before using ${requested.name}.`;
      code = "PROVIDER_NOT_CONFIGURED";
    } else if (requested && !canUseModel(plan, requested.id)) {
      msg = `${requested.name} is not included in your current plan.`;
      code = "MODEL_NOT_IN_PLAN";
      status = 403;
    } else if (requested?.comingSoon) {
      msg = `${requested.name} is not available yet.`;
    } else if (requested) {
      msg = `${requested.name} cannot be reached with its provider right now. ${PRODUCT_NAME} did not send your prompt to a different provider.`;
    } else {
      msg = configuredProviders().length === 0
        ? "No AI model providers are configured. Add at least one provider API key (e.g. ANTHROPIC_API_KEY)."
        : "No AI model is available for your plan. Configure a provider with a model your plan allows.";
    }
    return NextResponse.json({ error: msg, code }, { status });
  }
  const modelId = modelInfo.id;
  // Persist the user's *selection* on the conversation (keep requested model sticky). The
  // concrete `modelId` is what every generation / message version records.
  const conversationModelId = isAutoModelId(requestedId) ? AUTO_MODEL_ID : requestedId;

  return {
    modelInfo,
    modelId,
    requestedId,
    requestedEffort,
    conversationModelId,
    autoReasoningEffort,
    routingNote,
    routingWarning,
    capabilityProbes,
  };
}

export type TurnModel = Exclude<Awaited<ReturnType<typeof resolveModel>>, Response>;
