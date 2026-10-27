import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * Stage: which model actually answers a turn.
 *
 * Lifted out of `src/app/api/chat/route.ts`, where the rules sat inline among
 * auth, quota, moderation and streaming — so the one question the billing
 * depends on ("which model, and why that one") could not be asked without
 * standing up a request.
 *
 * Four things decide it, and they compose in this order:
 *   1. what was asked for — request, then user default, then app default;
 *   2. whether that model is eligible at all (configured, in-plan, shipping);
 *   3. whether its provider is currently answering;
 *   4. whether a platform spend ceiling forces something cheaper.
 *
 * Pure: no Prisma, no network, no `server-only`. The caller supplies the
 * catalogue and the two predicates, which is what makes every branch reachable
 * from a test.
 */

/** The subset of `ModelInfo` this stage needs. Structural, so it accepts the real type. */
export interface SelectableModel {
  id: string;
  provider: string;
  name: string;
  cost: number;
  modality: string;
  comingSoon?: boolean;
  /** See `ModelInfo.trainsOnPrompts` — structural, so the real type fits. */
  trainsOnPrompts?: boolean;
}

export type SelectionReason =
  /** The requested model was eligible and healthy. */
  | "requested"
  /** Nothing usable was asked for, so the cheapest eligible model answered. */
  | "fallback"
  /** The requested model's provider is failing; rerouted to a healthy one. */
  | "rerouted_unhealthy_provider"
  /** A platform spend ceiling forced a cheaper model. */
  | "budget_degraded";

export interface ModelSelection<M extends SelectableModel> {
  model: M | null;
  reason: SelectionReason;
  /** Set when the model used is not the one asked for. Safe to show a user. */
  warning: string | null;
  /** The id originally asked for, for the requested-vs-effective record. */
  requestedId: string;
}

export interface SelectionInputs<M extends SelectableModel> {
  requestedId: string;
  /** The full catalogue, in registry (display) order. */
  catalogue: readonly M[];
  /** Configured provider, allowed by plan, shipping, and a chat model. */
  isEligible: (model: M) => boolean;
  /** Whether the provider is currently answering rather than erroring. */
  isProviderHealthy: (provider: string) => boolean;
  /** The model asked for, already looked up. Null when unknown or Auto. */
  requested: M | null;
  /** True when a platform-wide daily spend ceiling has been reached. */
  budgetExhausted?: boolean;
  /**
   * Whether Juno may answer with a model other than `requested`.
   *
   * This is deliberately opt-in. An explicit selector choice is a routing
   * contract, not a suggestion: silently replacing Claude or GPT with the only
   * configured provider makes the UI lie about which API received the prompt.
   * Auto mode opts in because provider/model substitution is its stated job.
   */
  allowSubstitution?: boolean;
}

/**
 * The cheapest eligible model, not the first in registry order.
 *
 * Registry order is a *display* order, and its first chat entry is a frontier
 * model. Falling back to it costs roughly forty times the cheapest capable
 * model per request — silently, on the path taken precisely when something has
 * already gone wrong. Nobody chose that model, so nobody should be billed as
 * though they had.
 *
 * "Nobody chose it" is also why a model the provider trains on can never be
 * the answer here, and why the exclusion lives in this function rather than in
 * the caller's `isEligible`. That predicate does double duty in `selectModel`
 * — it validates the model that WAS asked for as well as ranking the ones that
 * were not — so excluding the tier there would have made an explicit choice of
 * it unselectable. Here it only removes it from the ranking, which is the
 * whole distinction: Meta's `-contributor` tier is the cheapest thing on the
 * catalog, so every cheapest-first fallback would land on it, and a reader who
 * had chosen a frontier model would find their prompt on a training endpoint
 * because a provider went unhealthy. See `ModelInfo.trainsOnPrompts`.
 */
export function cheapestEligible<M extends SelectableModel>(
  catalogue: readonly M[],
  isEligible: (model: M) => boolean,
  isProviderHealthy?: (provider: string) => boolean
): M | null {
  const candidates = catalogue.filter(
    (model) =>
      model.trainsOnPrompts !== true &&
      isEligible(model) &&
      (!isProviderHealthy || isProviderHealthy(model.provider))
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.cost - b.cost)[0];
}

/**
 * The provider failure classes where answering with a different lab plausibly
 * works: the lab's account is broken (auth, billing), its servers are failing
 * (capacity), it is throttling (rate_limit), or it does not serve the id
 * (not_found). Not `content_filter` — offering another model to get round a
 * safety refusal is not a recovery — and not the request-level classes
 * (context, invalid_request), the transport (network) or `unknown`, where the
 * honest next step is Try again or a shorter chat.
 */
export const SUGGEST_ALTERNATIVE_FOR = ["auth", "billing", "capacity", "rate_limit", "not_found"] as const;

/**
 * The one model to offer as "Answer with <model>" after a turn failed at its
 * provider: the cheapest eligible model on a DIFFERENT, healthy lab that does
 * not train on prompts (all three via `cheapestEligible`).
 *
 * A suggestion, never a substitution. It is shown on the error card and sent
 * only if the reader clicks it, which makes it their explicit choice — the
 * routing contract in `SelectionInputs.allowSubstitution` is untouched. A
 * different lab because every fault this answers belongs to the lab (its
 * account, its servers, its quota), so the same lab's next model meets the
 * same fault.
 */
export function suggestAlternativeModel<M extends SelectableModel>(input: {
  failed: Pick<SelectableModel, "id" | "provider">;
  errorClass: string;
  catalogue: readonly M[];
  isEligible: (model: M) => boolean;
  isProviderHealthy: (provider: string) => boolean;
}): M | null {
  if (!(SUGGEST_ALTERNATIVE_FOR as readonly string[]).includes(input.errorClass)) return null;
  return cheapestEligible(
    input.catalogue,
    (model) => model.id !== input.failed.id && model.provider !== input.failed.provider && input.isEligible(model),
    input.isProviderHealthy
  );
}

export function selectModel<M extends SelectableModel>(
  inputs: SelectionInputs<M>
): ModelSelection<M> {
  const { catalogue, isEligible, isProviderHealthy, requested, requestedId } = inputs;
  const allowSubstitution = inputs.allowSubstitution === true;

  // Auto prefers a healthy provider, but a configured-yet-failing one beats
  // nothing at all. Exact mode never calls this fallback.
  const fallback = () =>
    cheapestEligible(catalogue, isEligible, isProviderHealthy) ??
    cheapestEligible(catalogue, isEligible);

  let model: M | null;
  let reason: SelectionReason;
  let warning: string | null = null;

  if (!requested || !isEligible(requested)) {
    model = allowSubstitution ? fallback() : null;
    reason = "fallback";
  } else if (!isProviderHealthy(requested.provider)) {
    // Auto may reroute a provider known to be failing auth or billing. An exact
    // choice keeps the requested model and lets its provider error surface.
    const alternative = allowSubstitution
      ? cheapestEligible(catalogue, isEligible, isProviderHealthy)
      : null;
    if (alternative) {
      warning = `${requested.name} is unavailable right now — answered with ${alternative.name} instead.`;
      model = alternative;
      reason = "rerouted_unhealthy_provider";
    } else {
      model = requested;
      reason = "requested";
    }
  } else {
    model = requested;
    reason = "requested";
  }

  // Auto may also account for the platform ceiling. Exact choices are never
  // degraded here because that would change the provider receiving the prompt.
  if (allowSubstitution && inputs.budgetExhausted && model) {
    const cheapest = cheapestEligible(catalogue, isEligible, isProviderHealthy)
      ?? cheapestEligible(catalogue, isEligible);
    if (cheapest && cheapest.id !== model.id && cheapest.cost < model.cost) {
      warning =
        warning
        ?? `Answered with ${cheapest.name} — ${PRODUCT_NAME} is at its daily spending limit.`;
      model = cheapest;
      reason = "budget_degraded";
    }
  }

  return { model, reason, warning, requestedId };
}
