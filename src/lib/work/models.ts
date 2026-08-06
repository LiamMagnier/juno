/**
 * Which models can carry a Work task, and which one runs when nobody chose.
 *
 * Work is not chat. A chat turn is one request that either answers or does not;
 * a Work run is an agent loop that calls tools, reads what came back, and goes
 * again, for as long as the task takes. Two things follow, and they are the
 * whole of this file:
 *
 *   1. **Not every model in the catalog can be driven this way.** The catalog
 *      carries image and video models, entries that are listed but not yet
 *      callable, and OpenAI's Responses-API-only models — and the agent
 *      runtime speaks `/chat/completions` and `/v1/messages`, nothing else.
 *      `backendAgentCatalog` (`src/lib/model-catalog-api.ts`) already draws
 *      exactly this line for the Code runner; `isWorkCapableModel` is that same
 *      line, stated once so the picker and the dispatch route cannot drift.
 *
 *   2. **A run with no model does not fail politely.** `scripts/work-runner.ts`
 *      splits `provider:model` to choose an adapter, and an empty string throws
 *      before the first token — "The run has no model. Set one on the session,
 *      or a default for the account." Until now nothing on the web sent one, so
 *      that was the fate of every cloud run started from a browser. A picker
 *      alone does not fix it: the default has to be a real id by the time the
 *      run row is written, which is what `WORK_DEFAULT_MODEL` and the Auto
 *      resolution in the dispatch route are for.
 *
 * Free of `server-only`, Prisma and env reads, like its siblings in this
 * directory: the composer imports it in the browser, the route imports it on
 * the server, and the one function that genuinely needs the environment —
 * picking a concrete model for Auto — lives in the route, not here.
 */

import { AUTO_MODEL_ID, isAutoModelId } from "@/lib/auto-model";
import { canUseModel, effectiveMinPlan, planRank } from "@/lib/plans";
import { DEFAULT_MODEL, type ModelId, type ModelInfo } from "@/lib/models";
import type { Plan } from "@prisma/client";
import type { Provider } from "@/lib/providers";

/**
 * What a run falls back to when Auto cannot be resolved.
 *
 * The same id chat falls back to. Named separately anyway, because the two
 * defaults answer different questions — "what should this conversation use"
 * and "what should this agent loop use" — and a future where Work wants a
 * different floor should be one constant, not a search.
 */
export const WORK_DEFAULT_MODEL: ModelId = DEFAULT_MODEL;

/**
 * Can the agent runtime actually drive this model?
 *
 * Catalog-shape only: no plan, no provider keys, no health. Those are three
 * different questions with three different answers per caller, and folding them
 * in here is what produces a picker that hides a model for a reason it cannot
 * explain.
 */
export function isWorkCapableModel(model: ModelInfo): boolean {
  return (
    model.modality === "chat" &&
    // The proxy provider speaks /chat/completions or /v1/messages, not the
    // Responses API. `model-catalog-api.ts` draws this same line for Code.
    model.api !== "responses" &&
    !model.comingSoon &&
    model.status !== "deprecated"
  );
}

/**
 * The models to offer for a Work task, in the catalog's own order.
 *
 * `providers` is passed in rather than read from the environment because the
 * browser cannot read it: the server publishes the configured labs as
 * `features.providers`, and a client-side `isProviderConfigured` would answer
 * false for every lab and empty the picker. Pass `null` to skip the check
 * entirely — the dispatch route does, because by then the only question left is
 * whether the run can be created, and the executor is the authority on whether
 * a key resolves.
 *
 * Plan-gated models are **kept**, not dropped. The chat picker shows them with
 * a lock and sends the reader to `/upgrade`, and a Work picker that silently
 * omitted them would answer "why can't I pick Opus" with nothing at all.
 */
export function workModelOptions(
  models: readonly ModelInfo[],
  options: { providers?: readonly Provider[] | null } = {}
): ModelInfo[] {
  const providers = options.providers;
  return models.filter((model) => {
    if (!isWorkCapableModel(model)) return false;
    if (providers != null && !providers.includes(model.provider)) return false;
    return true;
  });
}

/** Is this model locked behind a plan the account does not hold? */
export function workModelLocked(model: ModelInfo, plan: Plan): boolean {
  return planRank(plan) < planRank(effectiveMinPlan(model.minPlan));
}

/**
 * Server-side gate: may this account start a run on this model id?
 *
 * The wire schema deliberately accepts an unvalidated model string — the
 * comment in `protocol.ts` explains why, and it is a good reason: the executor
 * resolves the model and records a substitution when it has to. But
 * "unvalidated against the catalog" was never meant to mean "unvalidated
 * against the account's plan", and until this existed a direct POST could name
 * any model in the catalog regardless of what the reader had paid for. The
 * client-side lock in the picker is a courtesy; this is the enforcement.
 *
 * Auto passes here, as `canUseModel` says it should — but passing this gate is
 * NOT the end of the check, and reading it that way was a real hole. The
 * sentinel does not carry an entitlement; it carries a promise to choose one,
 * and `pickAutoModel`'s last-resort fallback consults neither the plan nor the
 * configured providers. On an account whose eligible pool is empty it returns a
 * frontier model, so "the sentinel resolves to something the plan allows" — the
 * sentence that used to be here — was simply false. Whatever Auto lands on has
 * to be checked again, on the resolved id. See ``cheapestWorkModel``.
 */
export function isWorkModelAllowed(modelId: string | null | undefined, plan: Plan): boolean {
  if (modelId == null || modelId.trim().length === 0) return true;
  return canUseModel(plan, modelId.trim());
}

/**
 * The cheapest model this account may use that the agent runtime can drive, or
 * null when the account may use none.
 *
 * The floor under every other choice: what a run falls back to when the model it
 * asked for cannot be driven, and what stands between `pickAutoModel`'s
 * plan-blind last resort and a free account running an agent loop on a frontier
 * model at the deployment's expense.
 *
 * Cheapest rather than best, deliberately. This is reached only after the
 * reader's actual preference turned out to be unusable, and the honest answer to
 * "you cannot have the one you asked for" is the least the account is owed, said
 * out loud in a `model_substituted` degradation — not a silent upgrade nobody
 * chose and somebody pays for.
 *
 * `models` is passed in so this stays free of the environment: the caller
 * decides whether an unconfigured provider is a candidate, because only the
 * server can know.
 */
export function cheapestWorkModel(models: readonly ModelInfo[], plan: Plan): ModelInfo | null {
  const eligible = models
    .filter((model) => isWorkCapableModel(model) && canUseModel(plan, model.id))
    .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
  return eligible[0] ?? null;
}

/**
 * The model id a session should carry when the reader has expressed no
 * preference: the Auto sentinel, never a concrete model.
 *
 * Storing a concrete id here would freeze the choice at the moment the draft
 * was written. A task drafted in March and started in August should be routed
 * by August's catalog, and the sentinel is what defers the decision to the
 * moment there is a goal to route.
 */
export function defaultWorkModelId(): ModelId {
  return AUTO_MODEL_ID;
}

export { AUTO_MODEL_ID, isAutoModelId };
