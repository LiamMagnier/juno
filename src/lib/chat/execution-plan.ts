/**
 * Stage: execution planning — which model actually serves this turn.
 *
 * Four separate rules used to be interleaved across eighty lines of the route,
 * each reading module-level singletons (the registry, the provider-key
 * environment, the health cache, the platform budget) directly. That is why
 * none of them had a test: exercising "an unhealthy provider degrades to the
 * cheapest healthy one" required standing up all four.
 *
 * Here the singletons arrive as a `ModelPolicy` the caller supplies, so the
 * cascade is a pure function of candidates + policy. The route still owns
 * *reading* the environment; this owns deciding what it means.
 *
 * The order below is load-bearing and is preserved exactly from the route:
 * ineligible → fallback (silently, with no user-facing warning), otherwise
 * unhealthy → reroute (with a warning), then platform-budget → degrade (with a
 * warning). The fallback case is silent on purpose: the user never chose the
 * model that was rejected, so there is nothing to tell them it changed *from*.
 */
import type { ModelInfo } from "@/lib/models";
import type { Provider } from "@/lib/providers";

export interface ModelPolicy {
  /** The provider's API key is present. */
  isConfigured(provider: Provider): boolean;
  /** The provider is currently answering — not failing auth or billing. */
  isHealthy(provider: Provider): boolean;
  /** The user's plan permits this model. */
  allows(modelId: string): boolean;
  /** "juno:auto" and friends — a routing sentinel, never a real target. */
  isAuto(modelId: string): boolean;
}

/** A model this account could be billed for right now. */
export function isEligible(model: ModelInfo, policy: ModelPolicy): boolean {
  return (
    model.modality === "chat" &&
    !model.comingSoon &&
    !policy.isAuto(model.id) &&
    policy.isConfigured(model.provider) &&
    policy.allows(model.id)
  );
}

/**
 * Cheapest eligible model, NOT the first in registry order.
 *
 * Registry order is a display order — its first chat entry is a frontier model.
 * Falling back to it costs roughly 40x the cheapest capable model per request,
 * silently, on the path taken precisely when something has already gone wrong.
 * Nobody chose that model, so nobody should be billed as if they had.
 */
export function cheapestEligible(
  candidates: readonly ModelInfo[],
  policy: ModelPolicy,
  requireHealthy: boolean
): ModelInfo | undefined {
  return candidates
    .filter((model) => isEligible(model, policy) && (!requireHealthy || policy.isHealthy(model.provider)))
    .sort((a, b) => a.cost - b.cost)[0];
}

export type RoutingChange =
  /** The requested model could not be used at all; nothing to warn about. */
  | { kind: "fallback"; to: ModelInfo | null }
  | { kind: "unhealthy_provider"; from: ModelInfo; to: ModelInfo }
  | { kind: "platform_budget"; from: ModelInfo; to: ModelInfo };

export interface ExecutionModelResolution {
  /** null when nothing is eligible — the route answers 503. */
  model: ModelInfo | null;
  /** Applied in order. Empty when the requested model served unchanged. */
  changes: RoutingChange[];
  /** One line for the user, or null. The last warning-bearing change wins. */
  routingWarning: string | null;
}

export function routingWarningFor(change: RoutingChange): string | null {
  if (change.kind === "unhealthy_provider") {
    return `${change.from.name} is unavailable right now — answered with ${change.to.name} instead.`;
  }
  if (change.kind === "platform_budget") {
    return `Answered with ${change.to.name} to stay within today's capacity.`;
  }
  return null;
}

export function resolveExecutionModel(input: {
  /** The model asked for, already looked up; undefined when unknown or Auto failed. */
  requested: ModelInfo | undefined;
  candidates: readonly ModelInfo[];
  policy: ModelPolicy;
  /** Platform-wide daily spend ceiling has been reached. */
  platformBudgetExceeded: boolean;
}): ExecutionModelResolution {
  const { candidates, policy } = input;
  const cheapest = (requireHealthy: boolean) => cheapestEligible(candidates, policy, requireHealthy);
  const changes: RoutingChange[] = [];
  let model: ModelInfo | null = input.requested ?? null;

  if (
    !model ||
    policy.isAuto(model.id) ||
    model.comingSoon ||
    !policy.isConfigured(model.provider) ||
    !policy.allows(model.id)
  ) {
    // Prefer a provider that is actually answering; a configured-but-dead one
    // is better than nothing, so it stays as the second choice.
    model = cheapest(true) ?? cheapest(false) ?? null;
    changes.push({ kind: "fallback", to: model });
  } else if (!policy.isHealthy(model.provider)) {
    // The requested model's provider is failing auth or billing, so this
    // generation cannot succeed. Reroute rather than stream a guaranteed
    // failure — but only if there is somewhere healthy to go. Auto lands here
    // too: it picks the cheapest model overall without consulting health.
    const alternative = cheapest(true);
    if (alternative) {
      changes.push({ kind: "unhealthy_provider", from: model, to: alternative });
      model = alternative;
    }
  }

  // Degrade rather than refuse: a slower answer beats a 503, and it keeps the
  // product usable while an operator decides what to do. Per-user budgets are
  // enforced separately.
  if (model && input.platformBudgetExceeded) {
    const alternative = cheapest(true);
    if (alternative && alternative.cost < model.cost) {
      changes.push({ kind: "platform_budget", from: model, to: alternative });
      model = alternative;
    }
  }

  let routingWarning: string | null = null;
  for (const change of changes) {
    const warning = routingWarningFor(change);
    if (warning) routingWarning = warning;
  }

  return { model, changes, routingWarning };
}

/**
 * The model id the request is asking for, before any eligibility check:
 * explicit choice → the account default → the app default.
 *
 * An id that is not in the registry at all is ignored at each step rather than
 * failing the request, because a stored default can outlive the model it names.
 */
export function resolveRequestedModelId(input: {
  requested?: string;
  accountDefault?: string | null;
  appDefault: string;
  isKnown(modelId: string): boolean;
}): string {
  if (input.requested && input.isKnown(input.requested)) return input.requested;
  if (input.accountDefault && input.isKnown(input.accountDefault)) return input.accountDefault;
  return input.appDefault;
}
