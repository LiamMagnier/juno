import { createHash } from "node:crypto";
import type { Plan } from "@prisma/client";
import { AUTO_MODEL_INFO, isAutoModelId } from "@/lib/auto-model";
import { getModelMetrics, reasoningCaps, supportsProMode } from "@/lib/model-metrics";
import { toolCapabilitiesFor } from "@/lib/model-tools";
import { imageEditSupport, isSupersededModel, type ModelInfo } from "@/lib/models";
import { modelRequiredPlan, planRank } from "@/lib/plans";
import { fastModeMultiplier, supportsFastMode } from "@/lib/pricing";
import { providerSearchServed } from "@/lib/provider-routing";
import { PROVIDERS } from "@/lib/providers";
import { decideModelCapability, type ModelCapabilityEvidence } from "@/lib/model-capability-policy";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { tiersFor } from "@/lib/code-v2/context-tiers";
import { codeRank, isCodeAgentModel } from "@/lib/code-v2/code-models";

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
  return planRank(plan) >= planRank(modelRequiredPlan(model));
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
export interface NativeModelCapabilityVerdict {
  allowed: boolean;
  reason?: string;
}

/** Persisted probe evidence accepted at the catalog boundary. */
export interface NativeModelCapabilityEvidence {
  status: string;
  checkedAt: Date | null;
  expiresAt: Date | null;
  probeVersion: number;
}

type NativeModelCapability = NativeModelCapabilityVerdict | NativeModelCapabilityEvidence;

function capabilityDecision(model: ModelInfo, capability: NativeModelCapability | undefined) {
  if (!capability) return null;
  if ("allowed" in capability) return capability;

  const evidence: ModelCapabilityEvidence = {
    status: capability.status === "passed" ? "passed" : "failed",
    checkedAt: capability.checkedAt,
    expiresAt: capability.expiresAt,
    probeVersion: capability.probeVersion,
  };
  // Curated-only catalog: no model is an unreviewed discovery.
  return decideModelCapability(model, false, evidence);
}

/** Server facts the manifest cannot read from a `ModelInfo`. */
export interface NativeModelCatalogOptions {
  /**
   * Alevr Search serves its tools on this deployment (`chatSearchAvailable()`,
   * BRIEF §15), so every tool-capable model can turn web on. The routes pass
   * it; absent means false (web only where the provider searches).
   */
  alevrSearch?: boolean;
  /** The pre-Alevr name of `alevrSearch`, still read. */
  keyedSearchEngine?: boolean;
}

/**
 * Whether turning web on can do anything for this model on this deployment
 * (SPEC §3.6, RC-2). That is true when the provider's own search is served on
 * the model's transport. It is also true when the model takes function tools
 * and a keyed engine can run Juno's `web_search` for it.
 *
 * Native clients disable their web toggle when this is false. Publishing only
 * the provider's search would keep the toggle off for good on every model that
 * searches through Juno: the compat labs, the retiring OpenAI snapshots and the
 * Grok slugs whose server search is unconfirmed.
 */
function webSearchPossible(model: ModelInfo, keyedSearchEngine: boolean): boolean {
  if (model.modality !== "chat") return false;
  if (providerSearchServed(model)) return true;
  return keyedSearchEngine && toolCapabilitiesFor(model).supported;
}

export function nativeModelCatalog(
  models: ModelInfo[],
  plan?: Plan,
  capabilities?: ReadonlyMap<string, NativeModelCapability>,
  options: NativeModelCatalogOptions = {},
) {
  const keyedSearchEngine = (options.alevrSearch ?? options.keyedSearchEngine) === true;
  const chatModels = models.filter((model) => model.modality === "chat" && !model.comingSoon);
  const autoUsable = chatModels.some((model) => usable(model, plan));
  const listed = autoUsable ? [AUTO_MODEL_INFO, ...models] : models;

  const payload = listed.map((model) => {
    const auto = isAutoModelId(model.id);
    const metrics = getModelMetrics(model);
    const reasoning = reasoningCaps(model);
    const capability = auto ? undefined : capabilityDecision(model, capabilities?.get(model.id));
    const availability = model.comingSoon
      ? "coming_soon"
      : usable(model, plan)
        ? "available"
        : "requires_plan";
    const effectiveAvailability =
      availability === "available" && capability && !capability.allowed
        ? "health_check_failed"
        : availability;
    return {
      id: model.id,
      // Auto is Juno's own routing product, not the fallback provider its
      // ModelInfo borrows for a logo.
      provider: auto
        ? { id: "juno", displayName: PRODUCT_NAME }
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
      availability: effectiveAvailability,
      availabilityReason:
        effectiveAvailability === "health_check_failed" ? capability?.reason ?? "model_health_check" : null,
      minimumPlan: model.minPlan.toLowerCase(),
      // The plan `canUseModel` actually enforces (paid models are Pro-floored).
      // Auto is exempt — the router only ever picks models the plan can call.
      requiredPlan: auto ? model.minPlan.toLowerCase() : modelRequiredPlan(model).toLowerCase(),
      modalities: {
        input: model.vision ? ["text", "image"] : ["text"],
        output: [model.modality === "chat" ? "text" : model.modality],
      },
      contextWindowTokens: auto ? null : metrics.contextTokens,
      // Selectable context windows with their $/MTok (Code v2 SPEC §4),
      // smallest first; the first is the default and equals
      // contextWindowTokens' cheapest band. Derived from pricing.ts, so a
      // lab's long-context surcharge arrives as a second, pricier tier. Null
      // for Auto and for media models, which have no window to pick.
      contextTiers: auto || model.modality !== "chat" ? null : tiersFor(model),
      // Alevr Code: whether the model can drive an agent loop and its place in
      // the curated "best for coding" order (null = unranked; sort those after
      // the ranked ones by intelligence). The Code picker filters on `agentic`.
      code: auto ? null : { agentic: isCodeAgentModel(model), rank: codeRank(model) },
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
        defaultEffort: auto ? null : reasoning.defaultLevel,
        supportsProMode: auto ? false : supportsProMode(model),
        // Auto picks the thinking depth per message; a client must not offer a
        // slider for it, and must not send an effort with `juno:auto`.
        automatic: auto,
      },
      capabilities: {
        // The catalog's answer, not "is it a chat model".
        //
        // This read `model.modality === "chat"`, which was the best available
        // proxy while nothing recorded tool use — and became a false statement
        // the moment `ModelInfo.agenticTools` did. Every native client reads
        // this into `supportsTools`, which drives the Tools chip and gates
        // Computer Use, so leaving it would have had every phone and Mac
        // advertise agentic capability for exactly the model the catalog now
        // excludes from Work.
        tools: model.agenticTools,
        vision: model.vision,
        // Auto routes a web turn to a model that searches (`pickAutoModel`).
        webSearch: auto ? model.webSearch : webSearchPossible(model, keyedSearchEngine),
        attachments: model.modality === "chat" || model.vision,
        streaming: model.modality === "chat",
        // How this model can edit an existing image: "mask" takes a pixel mask,
        // "prompt" takes the region as guidance only, "none" cannot edit.
        //
        // Published rather than duplicated client-side. The native apps had no
        // way to know, so a phone would have had to either hard-code a copy of
        // `IMAGE_EDIT_SUPPORT` — which drifts the first time a provider adds
        // masking — or offer a region selection to a model that ignores it.
        imageEdit: model.modality === "image" ? imageEditSupport(model.provider) : "none",
      },
      /**
       * A provider's premium serving tier — Anthropic `speed:"fast"`, OpenAI
       * `service_tier:"priority"` — or null when the model has no faster tier.
       *
       * A top-level key rather than a `capabilities` boolean, and NOT nested in
       * `pricing`, for two separate reasons.
       *
       * It carries the multiplier because the client has to be able to name the
       * premium it is agreeing to. "Faster, at a premium" is a sentence a user
       * believes once; "2.5x the normal rate" is one they can decide on. And
       * the presence of the object IS the support flag, so a boolean and a
       * number can never disagree about the same model.
       *
       * It is not inside `pricing` because `pricing` is null for Auto, which
       * would force a client to read "no pricing" as "no fast mode" — true
       * today only by coincidence, and a silent wrong answer the day it stops
       * being true.
       *
       * The asymmetry with `reasoning.supportsProMode` is deliberate and is the
       * point: pro mode is a way of thinking (same rate, more tokens), fast mode
       * is a way of being served (same tokens, higher rate). A client that
       * rendered them as two identical switches would be misdescribing one of
       * them, and it would be the one that costs money.
       *
       * Null for Auto: the router picks the model per message, so a premium
       * agreed to here would land on a model the user never chose.
       */
      fastMode:
        auto || !supportsFastMode(model)
          ? null
          : { rateMultiplier: fastModeMultiplier(model) ?? 1 },
      deprecationNote: model.deprecationNote ?? null,
      // The day the provider stops serving it, "YYYY-MM-DD", so a client can
      // say "Available until 23 Oct 2026" instead of parsing it back out of the
      // English sentence above. Null for everything that is not retiring, which
      // is most of the catalog.
      retiresOn: auto ? null : model.retiresOn ?? null,
    };
  });
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { manifestVersion: `v1-${digest.slice(0, 16)}`, contractDigest: digest, models: payload };
}
