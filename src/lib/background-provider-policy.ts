/**
 * Where Juno is allowed to send *background* work.
 *
 * Background work is everything the user did not explicitly address to a model:
 * memory extraction, title generation, research planning, moderation,
 * consolidation, follow-up suggestions, translation. It is invisible by
 * definition, which is exactly why it needs a stated rule.
 *
 * The rule it replaces: `utilityModelCandidates()` returned every free chat
 * model across every configured provider, and the walk took whichever answered
 * first. So a conversation held with Anthropic could have its decrypted
 * messages extracted into memories by DeepSeek, because DeepSeek's free tier
 * happened to be fast — and nothing in the product ever said so.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports so the resolution
 * rules stay unit-testable.
 */

export const BACKGROUND_PROVIDER_MODES = [
  "same_provider",
  "selected_provider",
  "any_allowed_provider",
  "local_only",
] as const;

export type BackgroundProviderMode = (typeof BACKGROUND_PROVIDER_MODES)[number];

/**
 * The privacy-preserving default, and the value every existing account is
 * migrated to. Chosen because it is the only mode whose behaviour a user can
 * predict from what they already see: the provider they picked for the
 * conversation is the provider that sees the conversation.
 */
export const DEFAULT_BACKGROUND_PROVIDER_MODE: BackgroundProviderMode = "same_provider";

export interface BackgroundProviderPolicy {
  mode: BackgroundProviderMode;
  /** The one provider chosen for `selected_provider`. */
  selectedProvider?: string | null;
  /**
   * Deployment-level allowlist (enterprise/admin, regional policy). When set,
   * it bounds *every* mode — a user cannot opt out of it, and a provider
   * missing from it is never eligible however the user's own mode reads.
   */
  allowedProviders?: readonly string[] | null;
}

/** Why a background job could not run, for logs and for the caller's fallback. */
export type BackgroundDenialReason =
  /** Policy is same_provider but the conversation's provider has no utility model. */
  | "no_candidate_for_conversation_provider"
  /** Policy names a provider that is not configured or has no utility model. */
  | "selected_provider_unavailable"
  /** local_only, and no local utility model is available in this deployment. */
  | "no_local_model"
  /** The allowlist excluded every otherwise-eligible provider. */
  | "excluded_by_allowlist"
  /** No utility model is configured at all. */
  | "no_candidates";

export interface BackgroundProviderDecision<T> {
  /** Models this job may use, in preference order. Empty means: do not run. */
  candidates: T[];
  /** Set when `candidates` is empty. */
  deniedReason?: BackgroundDenialReason;
  /** The effective policy mode, for the audit record. */
  mode: BackgroundProviderMode;
}

/** The minimum a candidate must expose for the policy to judge it. */
export interface UtilityCandidate {
  id: string;
  provider: string;
  /** True for models that run on Juno's own infrastructure, not a third party. */
  isLocal?: boolean;
}

export function isBackgroundProviderMode(value: unknown): value is BackgroundProviderMode {
  return (
    typeof value === "string" &&
    (BACKGROUND_PROVIDER_MODES as readonly string[]).includes(value)
  );
}

/** Coerces a stored value, defaulting anything unrecognised to the safe mode. */
export function normalizeBackgroundProviderPolicy(
  raw: Partial<BackgroundProviderPolicy> | null | undefined
): BackgroundProviderPolicy {
  const mode = isBackgroundProviderMode(raw?.mode) ? raw.mode : DEFAULT_BACKGROUND_PROVIDER_MODE;
  return {
    mode,
    selectedProvider: raw?.selectedProvider ?? null,
    allowedProviders: raw?.allowedProviders ?? null,
  };
}

/**
 * Narrows the utility candidates to those the policy permits.
 *
 * Returning an empty list is a real outcome, not an error: it means the job
 * must be skipped. Every mode except `any_allowed_provider` can legitimately
 * produce it, and the caller's job is to skip quietly rather than to fall back
 * — falling back is precisely the behaviour the policy exists to forbid.
 */
export function resolveBackgroundCandidates<T extends UtilityCandidate>(opts: {
  policy: BackgroundProviderPolicy;
  /** Provider of the model the user chose for the work this job supports. */
  conversationProvider?: string | null;
  candidates: readonly T[];
}): BackgroundProviderDecision<T> {
  const policy = normalizeBackgroundProviderPolicy(opts.policy);
  const { mode } = policy;

  // The allowlist bounds every mode, including the user's own choice.
  const allowlist = policy.allowedProviders;
  const permitted =
    allowlist && allowlist.length > 0
      ? opts.candidates.filter((c) => allowlist.includes(c.provider))
      : [...opts.candidates];

  if (opts.candidates.length === 0) {
    return { candidates: [], deniedReason: "no_candidates", mode };
  }
  if (permitted.length === 0) {
    return { candidates: [], deniedReason: "excluded_by_allowlist", mode };
  }

  switch (mode) {
    case "same_provider": {
      // No conversation provider means there is nothing to match, and guessing
      // would be the cross-provider send this mode forbids.
      const provider = opts.conversationProvider;
      const matching = provider ? permitted.filter((c) => c.provider === provider) : [];
      return matching.length > 0
        ? { candidates: matching, mode }
        : { candidates: [], deniedReason: "no_candidate_for_conversation_provider", mode };
    }

    case "selected_provider": {
      const provider = policy.selectedProvider;
      const matching = provider ? permitted.filter((c) => c.provider === provider) : [];
      return matching.length > 0
        ? { candidates: matching, mode }
        : { candidates: [], deniedReason: "selected_provider_unavailable", mode };
    }

    case "local_only": {
      const local = permitted.filter((c) => c.isLocal === true);
      return local.length > 0
        ? { candidates: local, mode }
        : { candidates: [], deniedReason: "no_local_model", mode };
    }

    case "any_allowed_provider":
      // The only mode that may cross providers, and the only one a user has to
      // opt into by name.
      return { candidates: permitted, mode };
  }
}

/**
 * A sentence explaining a denial, for the surfaces that have to tell the user
 * why nothing happened.
 *
 * It exists because the alternative shipped: /api/memory/edit could not
 * distinguish "the policy refused" from "every provider failed", so it reported
 * a policy denial as "The AI providers are rate-limited right now" — a claim
 * that was false, unactionable, and told the user to wait for a condition that
 * would never change. A refusal has to name the rule that refused and where to
 * change it, or it is worse than no message at all.
 */
/*
 * Whole sentences, and a name the i18n extractor recognises as copy
 * (scripts/generate-i18n-catalog.mjs collects every literal inside a
 * `*Message` variable). Composing these from a shared "you can change this
 * under…" fragment read better in English and would have handed translators
 * half-sentences with no grammar to hang them on.
 */
const DENIAL_MESSAGE: Record<BackgroundDenialReason, string> = {
  no_candidate_for_conversation_provider:
    "Juno keeps background work with the provider you chat with, and that provider has no model free for it right now. You can change this under Settings → Memory → Background processing.",
  selected_provider_unavailable:
    "Background work is pinned to one provider, and that provider isn’t configured or has no model available. You can change this under Settings → Memory → Background processing.",
  no_local_model:
    "Background work is limited to on-device models, and none is available in this deployment. You can change this under Settings → Memory → Background processing.",
  excluded_by_allowlist:
    "This deployment’s provider allowlist rules out every provider that could do this work. Your administrator sets that list.",
  // Not a policy decision at all — nothing is configured to deny. Providers are
  // a deployment concern here, so there is no setting to point at, and
  // inventing one would be its own small lie.
  no_candidates: "No AI provider is configured for background work in this deployment yet.",
};

const FALLBACK_DENIAL_MESSAGE =
  "Your background-processing setting left no provider allowed to do this. You can change it under Settings → Memory → Background processing.";

/**
 * Takes only the reason, not the mode: the stored mode is a snake_case token,
 * not something a person should be made to read, and every sentence above
 * already implies the rule that produced it. The mode still travels in the API
 * response beside the message, for logs and for a client that wants to
 * preselect the control.
 */
export function backgroundDenialMessage(reason: BackgroundDenialReason | undefined): string {
  return (reason && DENIAL_MESSAGE[reason]) || FALLBACK_DENIAL_MESSAGE;
}

/**
 * What a background job did, recorded so the choice is auditable.
 *
 * Carries no content and no identifiers beyond the account — the point is to
 * be able to answer "which provider saw work for this account, and why",
 * without the record itself becoming a second copy of the message.
 */
export interface BackgroundProcessingRecord {
  purpose: BackgroundPurpose;
  mode: BackgroundProviderMode;
  /** Null when the job was skipped. */
  effectiveProvider: string | null;
  effectiveModel: string | null;
  deniedReason?: BackgroundDenialReason;
}

export type BackgroundPurpose =
  | "memory_extraction"
  | "memory_consolidation"
  /** Drafting a memory change from the user's natural-language instruction. */
  | "memory_edit"
  | "title"
  | "moderation"
  | "research_planning"
  | "follow_ups"
  | "translation"
  /**
   * Embedding a user's uploaded documents. The most content-revealing
   * background job there is — indexing a library sends every paragraph of every
   * file to a provider, not a summary of one conversation — so it goes through
   * the same policy rather than around it. See src/lib/knowledge/embed.ts.
   */
  | "knowledge_embedding";
