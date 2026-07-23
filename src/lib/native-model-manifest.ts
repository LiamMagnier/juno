import { createHash } from "node:crypto";
import type { Plan } from "@prisma/client";
import { AUTO_MODEL_INFO, isAutoModelId } from "@/lib/auto-model";
import { getModelMetrics, reasoningCaps, supportsProMode } from "@/lib/model-metrics";
import { isSupersededModel, type ModelInfo } from "@/lib/models";
import { effectiveMinPlan, planRank } from "@/lib/plans";
import { PROVIDERS } from "@/lib/providers";

/**
 * `canUseModel` re-looks-the-model-up in the global registry. Here the manifest
 * must describe the models it was *handed*, so the same rule is applied to the
 * passed `ModelInfo` directly: paid models are Pro-floored, and Auto is always
 * callable because the router only ever picks models the plan can reach.
 */
/** `legacy` is derived from `status`; the flag itself is only a cached copy. */
const isLegacy = isSupersededModel;

function usable(model: ModelInfo, plan: Plan | undefined): boolean {
  if (!plan) return true;
  if (isAutoModelId(model.id)) return true;
  return planRank(plan) >= planRank(effectiveMinPlan(model.minPlan));
}

/**
 * How Auto describes itself to a client that cannot see `pickAutoModel`. Same
 * three routing tiers the web selector spells out, so the native panel explains
 * Auto with the product's own words rather than a guess.
 */
const AUTO_HIGHLIGHTS = [
  "Short or simple asks go to budget models, answered instantly.",
  "Coding and analysis go to the mid tier with light thinking.",
  "Hard reasoning goes to a flagship with deep thinking.",
];

/**
 * The native (v1) model manifest.
 *
 * `plan` is optional: pass it and the manifest becomes account-specific —
 * models the plan cannot call come back as `requires_plan` instead of
 * `available`, so a client can render them disabled *with a reason* and can
 * never offer a selection the chat route would reject. Omit it (the web
 * `/api/models` case) and availability stays plan-agnostic.
 *
 * Auto is part of the manifest rather than a client-side constant: it is a real
 * selection `/api/chat` accepts (`juno:auto`), and hard-coding it in each client
 * is exactly the drift this endpoint exists to prevent. It reports no reasoning
 * tiers because the router — not the client — chooses the thinking depth for
 * every Auto message.
 */
export function nativeModelCatalog(models: ModelInfo[], plan?: Plan) {
  const chatModels = models.filter((model) => model.modality === "chat" && !model.comingSoon);
  const autoUsable = chatModels.some((model) => usable(model, plan));
  const listed = autoUsable ? [AUTO_MODEL_INFO, ...models] : models;

  const payload = listed.map((model) => {
    const auto = isAutoModelId(model.id);
    const metrics = getModelMetrics(model);
    const reasoning = reasoningCaps(model);
    const availability = model.comingSoon
      ? "coming_soon"
      : usable(model, plan)
        ? "available"
        : "requires_plan";
    return {
      id: model.id,
      // Auto is Juno's own routing product, not the fallback provider its
      // ModelInfo borrows for a logo.
      provider: auto
        ? { id: "juno", displayName: "Juno" }
        : { id: model.provider, displayName: PROVIDERS[model.provider].label },
      displayName: model.name,
      description: model.description ?? null,
      highlights: auto ? AUTO_HIGHLIGHTS : null,
      lifecycle: model.status === "deprecated" ? "deprecated" : model.status === "legacy" ? "legacy" : "active",
      // What the model produces — the pickers' top-level sections (Chat, Image,
      // Video), matching the web selector's MODALITY_GROUPS.
      modality: auto ? "chat" : model.modality ?? "chat",
      // Superseded within its family. Both pickers collapse these behind an
      // "Older models" disclosure instead of interleaving them.
      legacy: auto ? false : isLegacy(model),
      released: auto ? null : model.released ?? null,
      availability,
      minimumPlan: model.minPlan.toLowerCase(),
      // The plan `canUseModel` actually enforces (paid models are Pro-floored).
      // Auto is exempt — the router only ever picks models the plan can call.
      requiredPlan: auto ? model.minPlan.toLowerCase() : effectiveMinPlan(model.minPlan).toLowerCase(),
      modalities: {
        input: model.vision ? ["text", "image"] : ["text"],
        output: [model.modality === "chat" ? "text" : model.modality],
      },
      contextWindowTokens: auto ? null : metrics.contextTokens,
      pricing: auto
        ? null
        : {
            class: model.cost === 3 ? "premium" : model.cost === 2 ? "standard" : "economy",
            inputPerMillion: metrics.inputUsdPerMTok,
            outputPerMillion: metrics.outputUsdPerMTok,
            currency: "USD",
            source: metrics.source,
          },
      // The 1–10 grades the web selector's bars read from. Null for Auto: it is
      // not one model, so it has no one speed or intelligence.
      metrics: auto ? null : { speed: metrics.speed, intelligence: metrics.intelligence },
      supportedReasoningEfforts: auto ? [] : reasoning.tiers,
      reasoning: {
        supported: model.reasoning,
        canDisable: auto ? true : reasoning.canDisable,
        onOffOnly: auto ? false : reasoning.onOff,
        supportsProMode: auto ? false : supportsProMode(model),
        // Auto picks the thinking depth per message; a client must not offer a
        // slider for it, and must not send an effort with `juno:auto`.
        automatic: auto,
      },
      capabilities: {
        tools: model.modality === "chat",
        vision: model.vision,
        webSearch: model.webSearch,
        attachments: model.modality === "chat" || model.vision,
        streaming: model.modality === "chat",
      },
      deprecationNote: model.deprecationNote ?? null,
    };
  });
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { manifestVersion: `v1-${digest.slice(0, 16)}`, contractDigest: digest, models: payload };
}
