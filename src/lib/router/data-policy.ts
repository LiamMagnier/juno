/**
 * Provider data-use policy, as Auto is allowed to read it (BRIEF §51).
 *
 * The rule this file exists for: Auto must never silently send a private
 * request to an endpoint whose data-use terms differ materially from the terms
 * the reader would assume — "the provider does not train on what I send" —
 * just because that endpoint is cheap. A concrete model chosen by hand is the
 * reader's own decision and is never filtered here; this table only bounds what
 * the ROUTER may choose for them.
 *
 * Every row says where its claim comes from. A claim nobody in this repository
 * has checked against the provider's own published terms is `unknown`, and an
 * `unknown` provider is ineligible for Auto. That is deliberately the
 * expensive direction: a provider wrongly left out costs a little routing
 * quality; a provider wrongly let in moves conversations onto terms nobody
 * reviewed. The owner action to clear each `unknown` is recorded in
 * `docs/rework/program/AUTO_ROUTER.md` ("Owner blockers").
 *
 * Pure and client-safe: no `server-only`, no env reads except through the
 * attestation parser the caller hands in, so it is unit-testable and the
 * receipt UI can explain an exclusion with the same words the router used.
 */

import type { Provider } from "@/lib/providers";

/** Does the provider train on API prompts/completions by default? */
export type TrainingTerms =
  /** Published primary terms say API content is not used for training by default. */
  | "no"
  /** Published primary terms say it is (or the tier is the training tier). */
  | "yes"
  /** Depends on the account tier the deployment's key is on (free tier trains). */
  | "tier_dependent"
  /** Not verified from a primary source in this repository. */
  | "unknown";

/** Where the provider is headquartered / where its default endpoint processes. */
export type Jurisdiction = "US" | "EU" | "PRC" | "SG";

export interface ProviderDataPolicy {
  provider: Provider;
  training: TrainingTerms;
  /** Default retention of API content, as published. Null when unknown. */
  retention: string | null;
  /** HQ jurisdiction (from docs/SUBPROCESSORS.md). */
  jurisdiction: Jurisdiction;
  /** Where the default endpoint in `providers.ts` processes, when it differs. */
  endpointRegion?: Jurisdiction;
  /** Primary source for `training`, and the day it was read. Null when unknown. */
  source: { url: string; checkedOn: string } | null;
  /** One line a person can read in the receipt / settings. */
  note: string;
}

/**
 * The table. Read 2026-10-04; re-read when a provider's terms change. Sources
 * are the providers' own pages — third-party comparisons were used only to find
 * them, never as the claim.
 */
export const PROVIDER_DATA_POLICIES: Record<Provider, ProviderDataPolicy> = {
  anthropic: {
    provider: "anthropic",
    training: "no",
    retention: null,
    jurisdiction: "US",
    source: { url: "https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training", checkedOn: "2026-10-04" },
    note: "Commercial API inputs and outputs are not used for training by default.",
  },
  openai: {
    provider: "openai",
    training: "no",
    retention: "30 days (abuse monitoring)",
    jurisdiction: "US",
    source: { url: "https://developers.openai.com/api/docs/guides/your-data", checkedOn: "2026-10-04" },
    note: "API data is not used for training unless the account opts in.",
  },
  google: {
    provider: "google",
    training: "tier_dependent",
    retention: "temporary logging for abuse monitoring (paid tier)",
    jurisdiction: "US",
    source: { url: "https://ai.google.dev/gemini-api/terms", checkedOn: "2026-10-04" },
    note: "Paid Gemini API traffic is not used to improve products; unpaid traffic is.",
  },
  mistral: {
    provider: "mistral",
    training: "tier_dependent",
    retention: "30 days (abuse monitoring)",
    jurisdiction: "EU",
    source: { url: "https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training", checkedOn: "2026-10-04" },
    note: "Paid (Scale) plans are opted out of training; the free Experiment tier is opted in.",
  },
  xai: {
    provider: "xai",
    training: "no",
    retention: "30 days (abuse auditing)",
    jurisdiction: "US",
    source: { url: "https://docs.x.ai/developers/faq/security", checkedOn: "2026-10-04" },
    note: "API inputs and outputs are not used for training without explicit permission.",
  },
  meta: {
    provider: "meta",
    // Standard tier only. The `-contributor` ids carry `trainsOnPrompts` on the
    // model row, which `modelDataUse` reads before this provider row.
    training: "no",
    retention: null,
    jurisdiction: "US",
    source: { url: "docs/models-september-2026.md", checkedOn: "2026-10-04" },
    note: "Standard Muse tier: no training. The Contributor tier trains and is never chosen by Auto.",
  },
  deepseek: {
    provider: "deepseek",
    training: "yes",
    retention: null,
    jurisdiction: "PRC",
    source: { url: "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html", checkedOn: "2026-10-04" },
    note: "The privacy policy that governs the API allows inputs to be used to train models.",
  },
  qwen: {
    provider: "qwen",
    training: "no",
    retention: null,
    jurisdiction: "PRC",
    endpointRegion: "SG",
    source: { url: "https://www.alibabacloud.com/help/en/model-studio/faq-about-alibaba-cloud-model-studio", checkedOn: "2026-10-04" },
    note: "Model Studio states customer data is not used for model training; default endpoint is Singapore.",
  },
  zhipu: {
    provider: "zhipu",
    training: "unknown",
    retention: null,
    jurisdiction: "PRC",
    source: null,
    note: "Z.ai's published terms are ambiguous about training on API content; not verified.",
  },
  moonshot: {
    provider: "moonshot",
    training: "unknown",
    retention: null,
    jurisdiction: "PRC",
    source: null,
    note: "No primary API data-use statement verified.",
  },
  minimax: {
    provider: "minimax",
    training: "unknown",
    retention: null,
    jurisdiction: "PRC",
    source: null,
    note: "No primary API data-use statement verified.",
  },
  mimo: {
    provider: "mimo",
    training: "unknown",
    retention: null,
    jurisdiction: "PRC",
    source: null,
    note: "No primary API data-use statement verified.",
  },
  longcat: {
    provider: "longcat",
    training: "unknown",
    retention: null,
    jurisdiction: "PRC",
    source: null,
    note: "No primary API data-use statement verified.",
  },
  seedance: {
    provider: "seedance",
    training: "unknown",
    retention: null,
    jurisdiction: "PRC",
    source: null,
    note: "No primary API data-use statement verified.",
  },
};

/**
 * Providers whose deployment keys the owner has attested are on a PAID tier,
 * which is what turns `tier_dependent` into `no`. Read from
 * `AUTO_ROUTER_PAID_TIER_PROVIDERS` ("google,mistral") by the server caller.
 * An attestation is an owner statement about the account, not something code
 * can check — hence an env value the owner sets, never a default.
 */
export function parsePaidTierAttestation(raw: string | null | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** The user's data boundary for Auto (Settings.autoDataBoundary). */
export const AUTO_DATA_BOUNDARIES = ["verified_no_training", "exclude_prc", "eu_us_only"] as const;
export type AutoDataBoundary = (typeof AUTO_DATA_BOUNDARIES)[number];
export const DEFAULT_AUTO_DATA_BOUNDARY: AutoDataBoundary = "verified_no_training";

export function isAutoDataBoundary(value: unknown): value is AutoDataBoundary {
  return typeof value === "string" && (AUTO_DATA_BOUNDARIES as readonly string[]).includes(value);
}

export type DataUseVerdict =
  | { eligible: true; effectiveTraining: "no" }
  | {
      eligible: false;
      reason: "trains_on_prompts" | "terms_unknown" | "unpaid_tier_unattested" | "outside_user_boundary" | "unknown_provider";
      detail: string;
    };

/**
 * May Auto send this request to this model, under these terms?
 *
 * Order matters only for which reason is reported: every failing check makes
 * the model ineligible.
 */
export function autoDataUseVerdict(
  model: { provider: string; trainsOnPrompts?: boolean },
  ctx: { paidTier: ReadonlySet<string>; boundary?: AutoDataBoundary }
): DataUseVerdict {
  if (model.trainsOnPrompts === true) {
    return { eligible: false, reason: "trains_on_prompts", detail: "This tier trains on what is sent to it." };
  }
  const policy = (PROVIDER_DATA_POLICIES as Record<string, ProviderDataPolicy | undefined>)[model.provider];
  if (!policy) {
    return { eligible: false, reason: "unknown_provider", detail: "No data-use record for this provider." };
  }
  if (policy.training === "yes") {
    return { eligible: false, reason: "trains_on_prompts", detail: policy.note };
  }
  if (policy.training === "unknown") {
    return { eligible: false, reason: "terms_unknown", detail: policy.note };
  }
  if (policy.training === "tier_dependent" && !ctx.paidTier.has(policy.provider)) {
    return {
      eligible: false,
      reason: "unpaid_tier_unattested",
      detail: `${policy.note} The deployment has not attested a paid tier.`,
    };
  }
  const boundary = ctx.boundary ?? DEFAULT_AUTO_DATA_BOUNDARY;
  if (boundary === "exclude_prc" && policy.jurisdiction === "PRC") {
    return { eligible: false, reason: "outside_user_boundary", detail: "Outside your Auto data boundary (PRC-based providers excluded)." };
  }
  if (boundary === "eu_us_only" && policy.jurisdiction !== "EU" && policy.jurisdiction !== "US") {
    return { eligible: false, reason: "outside_user_boundary", detail: "Outside your Auto data boundary (EU and US providers only)." };
  }
  return { eligible: true, effectiveTraining: "no" };
}

/** Providers whose terms are unverified: the owner-blocker list, derived, never hand-kept. */
export function providersWithUnverifiedTerms(): Provider[] {
  return (Object.values(PROVIDER_DATA_POLICIES) as ProviderDataPolicy[])
    .filter((p) => p.training === "unknown")
    .map((p) => p.provider);
}
