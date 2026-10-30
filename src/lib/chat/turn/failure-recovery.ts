import "server-only";
import type { Plan } from "@prisma/client";
import { isAutoModelId } from "@/lib/auto-model";
import { loadModelCapabilityMap, modelCanRoute } from "@/lib/model-capability";
import { suggestAlternativeModel } from "@/lib/model-selection";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { canUseModel } from "@/lib/plans";
import { prisma } from "@/lib/prisma";
import { normalizeProviderError, wireErrorClass } from "@/lib/provider-error";
import { providerHealthy } from "@/lib/provider-health";
import { isProviderConfigured, type Provider } from "@/lib/providers";
import { autoPaidTierProviders } from "@/lib/router/chat-inputs";
import { autoDataUseVerdict, isAutoDataBoundary, type AutoDataBoundary } from "@/lib/router/data-policy";
import type { ChatErrorRecovery } from "@/types/chat";
import type { MessageForModel } from "@/types/llm";

/**
 * What a chat turn that failed AT ITS PROVIDER says about it beyond the
 * sentence: on the error frame, what kind of failure it was and which model
 * could answer instead. (Feeding provider health is the caller's
 * `noteLiveProviderFault`, which also runs for a partial answer.)
 *
 * Called only on the provider-failure branch of the saved and private turns
 * — never for a Stop, a stall, a drain, a canvas conflict or a persistence
 * error, none of which say anything about the lab.
 *
 * The suggestion is an offer, never a substitution: the turn has already
 * failed on the model the reader chose, and nothing is sent anywhere else
 * unless they click "Answer with <model>", which is their explicit choice.
 * It is held to what the reader could have picked themselves (configured,
 * in their plan, a chat model whose capability probe allows it, vision when
 * the conversation carries pictures) plus `suggestAlternativeModel`'s own
 * rules: a different, healthy lab, cheapest first.
 *
 * Every offer, explicit or Auto, must also clear the platform's data-use
 * record for training (`autoDataUseVerdict` with the `verified_no_training`
 * boundary): the model row's own `trainsOnPrompts`, and the PROVIDER's terms
 * in PROVIDER_DATA_POLICIES — a lab whose API terms allow training is never
 * offered, nor one whose terms are unverified, nor a tier-dependent one whose
 * paid tier the owner has not attested (AUTO_ROUTER_PAID_TIER_PROVIDERS). The
 * reader chose a model; the platform choosing one for them to click must not
 * land them on terms nobody reviewed, just because it was cheapest. When the
 * failed turn was on Auto, the offer clears the account's own Auto data
 * boundary instead (which includes those training checks), as Auto's own
 * substitutes must (turn/model.ts): a reader who limited Auto to certain labs
 * is not offered one outside that limit. If that boundary cannot be read, no
 * model is offered.
 *
 * The wire class folds `auth` and `billing` into `account`
 * (`wireErrorClass`): anyone reading the stream learns that the model is
 * unavailable, never the platform's funding or key state.
 *
 * Never throws: a failure here must not replace the error the reader is owed.
 */
export async function providerErrorRecovery(
  err: unknown,
  input: {
    modelInfo: ModelInfo;
    plan: Plan;
    history?: readonly MessageForModel[];
    /** What the reader asked for; Auto holds the offer to Auto's data boundary. */
    requestedId?: string;
    /** Whose Auto data boundary to read when the request was Auto. */
    userId?: string;
  },
): Promise<ChatErrorRecovery> {
  let recovery: ChatErrorRecovery = {};
  try {
    const normalized = normalizeProviderError(err);
    // An error with no HTTP status that no class recognises is not a
    // provider's answer at all (an internal error that reached the same
    // catch): it gets its sentence and nothing it could be wrong about.
    if (normalized.class === "unknown" && normalized.status === null) return {};
    recovery = {
      errorClass: wireErrorClass(normalized.class),
      retryable: normalized.retryable,
      ...(normalized.retryAfterSeconds !== null ? { retryAfterSeconds: normalized.retryAfterSeconds } : {}),
    };
    const needsVision = (input.history ?? []).some((message) =>
      message.attachments?.some((attachment) => attachment.mimeType?.startsWith("image/")),
    );
    const probes = await loadModelCapabilityMap(MODEL_LIST.map((model) => model.id));
    const autoTerms = input.requestedId && isAutoModelId(input.requestedId) ? await autoDataTerms(input.userId) : null;
    if (autoTerms === "unreadable") return recovery;
    // Training terms only for an explicit choice; the reader's own boundary on Auto.
    const dataTerms = autoTerms ?? { paidTier: autoPaidTierProviders(), boundary: "verified_no_training" as const };
    const suggestion = suggestAlternativeModel<ModelInfo>({
      failed: input.modelInfo,
      errorClass: normalized.class,
      catalogue: MODEL_LIST,
      isEligible: (model) =>
        model.modality === "chat" &&
        !model.comingSoon &&
        !isAutoModelId(model.id) &&
        isProviderConfigured(model.provider) &&
        canUseModel(input.plan, model.id) &&
        modelCanRoute(model, probes) &&
        (!needsVision || model.vision),
      isProviderHealthy: (provider) => providerHealthy(provider as Provider),
      clearsTrainingTerms: (model) => autoDataUseVerdict(model, dataTerms).eligible,
    });
    if (suggestion) {
      recovery = { ...recovery, suggestedModelId: suggestion.id, suggestedModelName: suggestion.name };
    }
  } catch (error) {
    console.warn("[chat] failure recovery skipped", error instanceof Error ? error.message : error);
  }
  return recovery;
}

/** The terms Auto's substitutes must clear for this account, as turn/model.ts reads them. */
async function autoDataTerms(
  userId: string | undefined,
): Promise<{ paidTier: ReadonlySet<string>; boundary?: AutoDataBoundary } | "unreadable"> {
  if (!userId) return "unreadable";
  try {
    const settings = await prisma.settings.findUnique({ where: { userId }, select: { autoDataBoundary: true } });
    return {
      paidTier: autoPaidTierProviders(),
      boundary: isAutoDataBoundary(settings?.autoDataBoundary) ? settings.autoDataBoundary : undefined,
    };
  } catch {
    return "unreadable";
  }
}
