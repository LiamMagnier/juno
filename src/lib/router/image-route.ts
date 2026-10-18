/**
 * Which image model makes a picture asked for in chat (G04).
 *
 * The chat router (decide.ts) scores chat models on expected total cost; an
 * image has no tool rounds, no retries the reader sees and no "first-try
 * answer" to price, so its choice is simpler and lives here: the same hard
 * filters, in the same order — catalogue, provider configured, plan, Auto's
 * data-use boundary, what the request needs (a reference image needs a model
 * that edits), provider health, the remaining budget — then the best picture
 * for the reader's Auto preference.
 *
 * A model the person NAMED ("make it with Nano Banana") is their choice, not
 * Auto's: like a chat model chosen by name it skips the data boundary, but
 * never the plan, the key or the reference rule.
 *
 * Pure and client-safe: every environmental fact is an input, so every branch
 * is reachable from a test and the composer can rank its own default.
 */

import type { Plan } from "@prisma/client";
import { GEN_MODELS, hasRetired, imageEditSupport, type ModelInfo } from "@/lib/models";
import { canUseModel } from "@/lib/plans";
import { isProviderConfigured } from "@/lib/providers";
import { autoDataUseVerdict, type AutoDataBoundary } from "@/lib/router/data-policy";
import type { AutoPreference } from "@/lib/router/decide";

export type ImageExclusion =
  | "not_image"
  | "unavailable_in_catalogue"
  | "provider_not_configured"
  | "not_in_plan"
  | "data_use_terms"
  | "cannot_edit"
  | "superseded"
  | "provider_unavailable"
  | "over_budget";

export interface ImageRouteInput {
  plan: Plan;
  /** The request works from a reference picture: only a model that edits can. */
  needsEdit?: boolean;
  /** A model the person named; honoured when it passes the hard filters. */
  requested?: string | null;
  preference?: AutoPreference;
  boundary?: AutoDataBoundary;
  paidTier?: ReadonlySet<string>;
  isProviderAvailable?: (provider: string) => boolean;
  /** One image's estimated cost, micro-USD (spend.ts' `mediaRequestCost`). */
  costOf?: (modelId: string) => number;
  remainingBudgetMicroUsd?: number | null;
  /** Test seams. */
  catalogue?: readonly ModelInfo[];
  isConfigured?: (provider: string) => boolean;
  canUse?: (plan: Plan, modelId: string) => boolean;
}

export interface ImageRouteDecision {
  model: ModelInfo;
  /** Auto chose it (false: the person named it). */
  auto: boolean;
  /** Every eligible model, best first. */
  ranked: ModelInfo[];
  excluded: Partial<Record<ImageExclusion, number>>;
  degraded: null | "all_providers_unavailable" | "over_budget";
  /** "Selected for:" lines in the receipt's voice. */
  reasons: string[];
}

/** Why nothing could be chosen, with the count each filter removed. */
export class NoImageModelError extends Error {
  constructor(
    public readonly excluded: Partial<Record<ImageExclusion, number>>,
    /** The named model, and the one filter that refused it. */
    public readonly requested: { model: ModelInfo; reason: ImageExclusion } | null = null,
  ) {
    super(
      requested
        ? `${requested.model.name} can't make this image (${requested.reason.replace(/_/g, " ")}).`
        : "No image model is available for this request on your plan and data settings.",
    );
    this.name = "NoImageModelError";
  }
}

/**
 * How good a family's pictures are, 1–10: composition, text in the image,
 * prompt adherence. A product judgement written down so it can be argued
 * with, from each lab's own positioning and our side-by-side runs; a family
 * not listed is middling.
 */
const FAMILY_QUALITY: Record<string, number> = {
  "gemini-image-pro": 9,
  "gpt-image": 9,
  "gpt-image-fast": 8,
  "gemini-image-flash": 8,
  "imagine-image-2": 7,
  "muse-image": 6.5,
  "glm-image": 6,
  image: 6,
  "image-live": 6,
  "gemini-image-lite": 5,
  "imagine-image-fast": 5,
  "gpt-image-mini": 5,
};

export function imageQuality(model: Pick<ModelInfo, "family">): number {
  return FAMILY_QUALITY[model.family ?? ""] ?? 5.5;
}

/** Price weight per preference: quality buys the best picture, economy the cheapest good one. */
const COST_WEIGHT: Record<AutoPreference, number> = { balanced: 1.2, quality: 0.2, economy: 2.4 };

function score(model: ModelInfo, preference: AutoPreference): number {
  return imageQuality(model) - COST_WEIGHT[preference] * model.cost;
}

function byScore(preference: AutoPreference) {
  return (a: ModelInfo, b: ModelInfo) =>
    score(b, preference) - score(a, preference) ||
    (b.released ?? "").localeCompare(a.released ?? "") ||
    a.id.localeCompare(b.id);
}

/** Match a name the model or the person wrote ("Nano Banana Pro", "gpt-image-2.5-flare") to a catalogue id. */
export function matchImageModel(requested: string, catalogue: readonly ModelInfo[] = GEN_MODELS): ModelInfo | null {
  const wanted = requested.trim().toLowerCase();
  if (!wanted) return null;
  const images = catalogue.filter((m) => m.modality === "image");
  return (
    images.find((m) => m.id.toLowerCase() === wanted) ??
    images.find((m) => m.providerModel.toLowerCase() === wanted) ??
    images.find((m) => m.name.toLowerCase() === wanted) ??
    null
  );
}

export function routeImage(input: ImageRouteInput): ImageRouteDecision {
  const catalogue = input.catalogue ?? GEN_MODELS;
  const isConfigured = input.isConfigured ?? ((p: string) => isProviderConfigured(p as never));
  const canUse = input.canUse ?? canUseModel;
  const available = input.isProviderAvailable ?? (() => true);
  const paidTier = input.paidTier ?? new Set<string>();
  const preference = input.preference ?? "balanced";
  const excluded: Partial<Record<ImageExclusion, number>> = {};

  /** The first hard filter this model fails, or null. Health and budget come later. */
  const refusal = (m: ModelInfo, auto: boolean): ImageExclusion | null => {
    if (m.modality !== "image") return "not_image";
    if (m.comingSoon || m.status === "deprecated" || hasRetired(m)) return "unavailable_in_catalogue";
    if (!isConfigured(m.provider)) return "provider_not_configured";
    if (!canUse(input.plan, m.id)) return "not_in_plan";
    if (auto && !autoDataUseVerdict(m, { paidTier, boundary: input.boundary }).eligible) return "data_use_terms";
    if (input.needsEdit && imageEditSupport(m.provider) === "none") return "cannot_edit";
    return null;
  };

  // The person's own pick, when they made one and it can run.
  const named = input.requested ? matchImageModel(input.requested, catalogue) : null;
  if (named) {
    const reason = refusal(named, false) ?? (available(named.provider) ? null : "provider_unavailable");
    if (reason) throw new NoImageModelError({ [reason]: 1 }, { model: named, reason });
    return {
      model: named,
      auto: false,
      ranked: [named],
      excluded,
      degraded: null,
      reasons: ["the model you named"],
    };
  }

  let pool = catalogue.filter((m) => {
    const reason = refusal(m, true);
    if (reason && reason !== "not_image") excluded[reason] = (excluded[reason] ?? 0) + 1;
    return reason === null;
  });
  if (pool.length === 0) throw new NoImageModelError(excluded);

  const current = pool.filter((m) => m.status === "current" || !m.status);
  if (current.length > 0 && current.length < pool.length) {
    excluded.superseded = pool.length - current.length;
    pool = current;
  }

  let degraded: ImageRouteDecision["degraded"] = null;
  const healthy = pool.filter((m) => available(m.provider));
  if (healthy.length > 0) {
    if (healthy.length < pool.length) excluded.provider_unavailable = pool.length - healthy.length;
    pool = healthy;
  } else {
    // Every eligible lab reports trouble: try the best one rather than refuse;
    // its own error names the cause if it is really down.
    degraded = "all_providers_unavailable";
  }

  let ranked = [...pool].sort(byScore(preference));
  const remaining = input.remainingBudgetMicroUsd;
  if (remaining != null && input.costOf) {
    const fits = ranked.filter((m) => input.costOf!(m.id) <= remaining);
    if (fits.length > 0) {
      if (fits.length < ranked.length) excluded.over_budget = ranked.length - fits.length;
      ranked = fits;
    } else {
      // Nothing fits the estimate: the cheapest is the honest attempt, and the
      // pipeline's spend gate decides whether it may run at all.
      ranked = [...ranked].sort((a, b) => input.costOf!(a.id) - input.costOf!(b.id));
      degraded = degraded ?? "over_budget";
    }
  }

  const model = ranked[0]!;
  const reasons: string[] = [];
  if (input.needsEdit) reasons.push("works from your reference image");
  reasons.push(
    ranked.length > 1
      ? preference === "quality"
        ? `best picture of ${ranked.length} eligible image models`
        : preference === "economy"
          ? `cheapest good picture of ${ranked.length} eligible image models`
          : `best picture for the price of ${ranked.length} eligible image models`
      : "the one image model eligible for this request",
  );
  if (degraded === "over_budget") reasons.push("kept within your remaining budget");
  return { model, auto: true, ranked, excluded, degraded, reasons };
}

/**
 * Whether any image model could run for this plan: in the catalogue,
 * configured, and in the plan. Data terms and health are left to the call,
 * because a model the person names skips the first and the second changes by
 * the minute; this only decides whether the turn carries the tool at all.
 */
export function imageModelAvailable(
  plan: Plan,
  catalogue: readonly ModelInfo[] = GEN_MODELS,
  isConfigured: (provider: string) => boolean = (p) => isProviderConfigured(p as never),
  canUse: (plan: Plan, modelId: string) => boolean = canUseModel,
): boolean {
  return catalogue.some(
    (m) =>
      m.modality === "image" &&
      !m.comingSoon &&
      m.status !== "deprecated" &&
      !hasRetired(m) &&
      isConfigured(m.provider) &&
      canUse(plan, m.id),
  );
}

/**
 * The composer's default for "Create image": the image model used most
 * recently when it is still usable, else the best usable one. The client
 * cannot see data terms or provider health; the list it holds is already the
 * configured catalogue, and the server checks the rest when it generates.
 */
export function defaultImageModel(
  models: readonly ModelInfo[],
  plan: Plan,
  lastUsed?: string | null,
  locked: (model: ModelInfo, plan: Plan) => boolean = (m, p) => !canUseModel(p, m.id),
): ModelInfo | null {
  const usable = models.filter(
    (m) => m.modality === "image" && !m.comingSoon && m.status !== "deprecated" && !hasRetired(m) && !locked(m, plan),
  );
  if (usable.length === 0) return null;
  const last = lastUsed ? usable.find((m) => m.id === lastUsed) : undefined;
  if (last) return last;
  const current = usable.filter((m) => m.status === "current" || !m.status);
  return [...(current.length > 0 ? current : usable)].sort(byScore("balanced"))[0] ?? null;
}
