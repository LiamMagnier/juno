import "server-only";
import type { Plan } from "@prisma/client";
import { isAutoModelId } from "@/lib/auto-model";
import { loadModelCapabilityMap, modelCanRoute } from "@/lib/model-capability";
import { suggestAlternativeModel } from "@/lib/model-selection";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { canUseModel } from "@/lib/plans";
import { normalizeProviderError } from "@/lib/provider-error";
import { providerHealthy } from "@/lib/provider-health";
import { isProviderConfigured, type Provider } from "@/lib/providers";
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
 * rules: a different, healthy lab, and never one that trains on prompts.
 *
 * Never throws: a failure here must not replace the error the reader is owed.
 */
export async function providerErrorRecovery(
  err: unknown,
  input: {
    modelInfo: ModelInfo;
    plan: Plan;
    history?: readonly MessageForModel[];
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
      errorClass: normalized.class,
      retryable: normalized.retryable,
      ...(normalized.retryAfterSeconds !== null ? { retryAfterSeconds: normalized.retryAfterSeconds } : {}),
    };
    const needsVision = (input.history ?? []).some((message) =>
      message.attachments?.some((attachment) => attachment.mimeType?.startsWith("image/")),
    );
    const probes = await loadModelCapabilityMap(MODEL_LIST.map((model) => model.id));
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
    });
    if (suggestion) {
      recovery = { ...recovery, suggestedModelId: suggestion.id, suggestedModelName: suggestion.name };
    }
  } catch (error) {
    console.warn("[chat] failure recovery skipped", error instanceof Error ? error.message : error);
  }
  return recovery;
}
