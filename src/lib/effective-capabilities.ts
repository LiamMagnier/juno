/**
 * What the user asked for, what actually ran, and why they differ.
 *
 * Juno silently degrades a turn in several places: reasoning effort is clamped
 * to what the model accepts, web search is dropped when the model or plan
 * cannot do it, fast mode is ignored on models without a priority tier, and a
 * budget ceiling can swap the model outright. Each of those is individually
 * reasonable and individually invisible — the reply simply comes back, and
 * nothing says it was answered by a different model at a lower effort with
 * search switched off.
 *
 * This resolves the two side by side and records every difference with a
 * reason, so "requested vs effective" is a value the product can persist and
 * show rather than something a reader has to infer from a bill.
 *
 * Versioned, because the same contract is consumed by web, the backend, macOS
 * and iOS: a client that does not understand a newer capability must be able to
 * tell that it is looking at a newer manifest rather than silently ignoring a
 * field.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports so the resolution
 * rules stay unit-testable and can be mirrored into the Swift contract.
 */

import manifest from "../../contracts/capabilities/juno-capabilities-v1.json";

/**
 * The single source of truth for both platforms.
 *
 * This module and the generated Swift contract both derive from
 * `contracts/capabilities/juno-capabilities-v1.json`, so there is nothing to
 * keep in sync — only one file to change. Restating the levels here as a
 * literal union would reintroduce exactly the drift the manifest exists to
 * prevent, and it would be a drift a type-checker could not see.
 */
export const CAPABILITY_MANIFEST_VERSION: number = manifest.version;

export const REASONING_LEVELS = manifest.reasoningLevels as readonly ReasoningLevel[];

export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Everything a turn can ask for that the runtime may not be able to honour. */
export interface RequestedCapabilities {
  modelId: string;
  reasoning?: ReasoningLevel | null;
  webSearch?: boolean;
  fastMode?: boolean;
  vision?: boolean;
  connectors?: readonly string[];
}

/** What a given model, on a given plan, can actually do. */
export interface ModelCapabilities {
  modelId: string;
  provider: string;
  reasoning: boolean;
  /** Highest level this model accepts; requests above it are clamped. */
  maxReasoning?: ReasoningLevel | null;
  webSearch: boolean;
  fastMode: boolean;
  vision: boolean;
  connectors: boolean;
}

export type DegradationKind =
  | "model_substituted"
  | "reasoning_clamped"
  | "reasoning_unsupported"
  | "web_search_unavailable"
  | "fast_mode_unavailable"
  | "vision_unavailable"
  | "connectors_unavailable";

export interface Degradation {
  kind: DegradationKind;
  /** What was asked for, rendered for display. */
  requested: string;
  /** What ran instead. */
  effective: string;
  /** Why, in a sentence a user can act on. */
  reason: string;
}

export interface EffectiveCapabilities {
  version: number;
  modelId: string;
  provider: string;
  reasoning: ReasoningLevel | null;
  webSearch: boolean;
  fastMode: boolean;
  vision: boolean;
  connectors: boolean;
  degradations: Degradation[];
}

export function reasoningRank(level: ReasoningLevel): number {
  const index = REASONING_LEVELS.indexOf(level);
  // An unknown level ranks lowest rather than highest: a value this build does
  // not recognise must not be treated as permission to run at maximum effort.
  return index === -1 ? 0 : index;
}

/**
 * Resolves a request against what the runtime can do.
 *
 * `substitutedFrom` is passed when something upstream — a budget ceiling, an
 * unavailable provider — already swapped the model. The swap is the single
 * most consequential degradation and the one users notice in the bill, so it is
 * recorded first rather than being folded into the others.
 */
export function resolveEffectiveCapabilities(opts: {
  requested: RequestedCapabilities;
  actual: ModelCapabilities;
  /** Plan-level gates, applied on top of the model's own limits. */
  planAllowsWebSearch?: boolean;
  planAllowsConnectors?: boolean;
  /** The model originally requested, when it was substituted. */
  substitutedFrom?: { modelId: string; reason: string } | null;
}): EffectiveCapabilities {
  const { requested, actual } = opts;
  const planAllowsWebSearch = opts.planAllowsWebSearch ?? true;
  const planAllowsConnectors = opts.planAllowsConnectors ?? true;
  const degradations: Degradation[] = [];

  if (opts.substitutedFrom && opts.substitutedFrom.modelId !== actual.modelId) {
    degradations.push({
      kind: "model_substituted",
      requested: opts.substitutedFrom.modelId,
      effective: actual.modelId,
      reason: opts.substitutedFrom.reason,
    });
  }

  // Reasoning
  let reasoning: ReasoningLevel | null = null;
  if (requested.reasoning) {
    if (!actual.reasoning) {
      degradations.push({
        kind: "reasoning_unsupported",
        requested: requested.reasoning,
        effective: "none",
        reason: `${actual.modelId} does not support a reasoning effort.`,
      });
    } else {
      const ceiling = actual.maxReasoning ?? "max";
      reasoning =
        reasoningRank(requested.reasoning) > reasoningRank(ceiling)
          ? ceiling
          : requested.reasoning;
      if (reasoning !== requested.reasoning) {
        degradations.push({
          kind: "reasoning_clamped",
          requested: requested.reasoning,
          effective: reasoning,
          reason: `${actual.modelId} accepts at most ${ceiling} reasoning effort.`,
        });
      }
    }
  }

  const webSearch = Boolean(requested.webSearch) && actual.webSearch && planAllowsWebSearch;
  if (requested.webSearch && !webSearch) {
    degradations.push({
      kind: "web_search_unavailable",
      requested: "on",
      effective: "off",
      reason: !actual.webSearch
        ? `${actual.modelId} cannot search the web.`
        : "Web search is not included in this plan.",
    });
  }

  const fastMode = Boolean(requested.fastMode) && actual.fastMode;
  if (requested.fastMode && !fastMode) {
    degradations.push({
      kind: "fast_mode_unavailable",
      requested: "on",
      effective: "off",
      reason: `${actual.modelId} has no faster tier, so the request ran at the normal speed.`,
    });
  }

  const vision = Boolean(requested.vision) && actual.vision;
  if (requested.vision && !vision) {
    degradations.push({
      kind: "vision_unavailable",
      requested: "on",
      effective: "off",
      reason: `${actual.modelId} cannot read images.`,
    });
  }

  const wantsConnectors = (requested.connectors?.length ?? 0) > 0;
  const connectors = wantsConnectors && actual.connectors && planAllowsConnectors;
  if (wantsConnectors && !connectors) {
    degradations.push({
      kind: "connectors_unavailable",
      requested: `${requested.connectors?.length ?? 0} connector(s)`,
      effective: "none",
      reason: !actual.connectors
        ? `${actual.modelId} does not support tool calling.`
        : "Connectors are not included in this plan.",
    });
  }

  return {
    version: CAPABILITY_MANIFEST_VERSION,
    modelId: actual.modelId,
    provider: actual.provider,
    reasoning,
    webSearch,
    fastMode,
    vision,
    connectors,
    degradations,
  };
}

/** True when anything the user asked for did not happen. */
export function wasDegraded(effective: EffectiveCapabilities): boolean {
  return effective.degradations.length > 0;
}

/**
 * A compact record for persistence.
 *
 * Only the differences, not the full manifest: storing the whole resolved
 * capability set on every message would be a large, mostly-identical blob, and
 * the interesting fact is always the delta.
 */
export function degradationSummary(effective: EffectiveCapabilities): {
  version: number;
  model: string;
  degradations: Degradation[];
} | null {
  if (!wasDegraded(effective)) return null;
  return {
    version: effective.version,
    model: effective.modelId,
    degradations: effective.degradations,
  };
}
