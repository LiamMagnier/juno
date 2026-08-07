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

import { AUTO_MODEL_ID, classifyPromptComplexity, isAutoModelId } from "@/lib/auto-model";
import { canUseModel, effectiveMinPlan, planRank } from "@/lib/plans";
import { DEFAULT_MODEL, type ModelId, type ModelInfo } from "@/lib/models";
// Pure scoring, no environment: `getModelMetrics` reads the generated benchmark
// table and `averageRequestCostMicroUsd` is arithmetic over the catalog's own
// prices, so importing them here keeps this module as browser-safe as its
// header promises.
import { averageRequestCostMicroUsd, getModelMetrics } from "@/lib/model-metrics";
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
    // The whole point of a Work run. Everything else on this list is about
    // whether the model can be *reached*; this is about whether it can do the
    // job once reached.
    //
    // Without it a model that answers in prose instead of calling tools was
    // offered for Work, picked by `cheapestWorkModel` as the Auto fallback, and
    // produced runs that left the plan untouched and failed while costing real
    // tokens. See `ModelInfo.agenticTools`.
    model.agenticTools &&
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
 * The intelligence floor a Work run adds on top of the one a chat turn asks for.
 *
 * `classifyPromptComplexity` grades a *sentence*, and it grades it for the job
 * chat does: answer once, well enough. "clean my github & add readme on projects
 * that doesn't have one" is sixty-two characters of ordinary English, so it
 * scores `simple` / `minIntelligence: 4` — and on a floor of 4 the cheapest-first
 * ranking in `pickAutoModel` hands an unbounded tool-calling loop the least
 * capable model in the catalog that clears it. Measured on this catalog, that is
 * a model billing an average of zero: a free tier, which is also the tier with
 * the tightest rate limits, which is how that task died against a 429.
 *
 * The sentence is short; the job is not. It means: list every repository on an
 * account, read each one's tree, decide what a README should say about code it
 * has just met, write it, and open a commit or a pull request per repository —
 * dozens of tool calls, each depending on the last, with nobody watching. The
 * question that matters for a Work run is not "can it answer this sentence" but
 * "will it still be following the thread forty tool calls from now", and no
 * heuristic reading the goal text can see that difference, because the
 * difference is not in the text.
 *
 * So Work states its own floor and takes whichever is higher. Six rather than a
 * frontier number because this is a floor and not a preference — everything
 * above it is still ranked cheapest-first, and pricing background work out of
 * the product would be its own failure. The calibration is the one in
 * `model-metrics.ts`, where Haiku 4.5 is a 5, Grok 4.3 a 6 and GLM-5.2 an 8, so
 * six admits the small-but-competent tier and excludes the tier that narrates
 * what it would do instead of calling the tool that would do it.
 */
export const WORK_MIN_INTELLIGENCE = 6;

/**
 * How far the floor may fall before Work would rather run nothing.
 *
 * A floor that cannot be met is not a reason to refuse: an account whose plan
 * admits only small models is still owed its task attempted on the best it has.
 * But it is a reason to *say so*, which is what `relaxed` on the result is for.
 */
const WORK_FLOOR_FLOOR = 4;

export interface WorkModelPick {
  model: ModelInfo;
  /** The floor actually applied, after any relaxation. */
  floor: number;
  /** The floor Work asked for before relaxing. */
  desiredFloor: number;
  /** True when nothing cleared `desiredFloor` and the floor had to come down. */
  relaxed: boolean;
  /** How many models cleared the applied floor, for the log line. */
  candidatesConsidered: number;
}

/**
 * The model a Work run should start on.
 *
 * Replaces `pickAutoModel` on this path. Not a wrapper around it — a wrapper
 * would inherit the two properties that made it wrong here — but it borrows the
 * one part that is right, `classifyPromptComplexity`, because a hard goal should
 * still lift the floor above Work's own minimum.
 *
 * Three differences from the chat router, each answering something that actually
 * happened:
 *
 *   1. **The floor is Work's.** See `WORK_MIN_INTELLIGENCE`.
 *   2. **The pool is the drivable, reachable one.** `workModelOptions` already
 *      draws both lines — `isWorkCapableModel` for what the runtime can drive and
 *      `providers` for what this deployment can reach. `cheapestWorkModel`, the
 *      function this replaces at the fallback, consulted neither: it ranked the
 *      whole catalog, so it could name a lab with no key configured and turn a
 *      recoverable substitution into `UnrunnableModelError` at the executor.
 *   3. **The tie-break is not the display name.** `cheapestWorkModel` sorts
 *      `a.cost - b.cost || a.name.localeCompare(b.name)`, and eight models on
 *      this catalog tie at `cost: 1` — so which model ran an account's
 *      background work was decided by the first letter of its marketing name,
 *      and "Claude Haiku 4.5" won because C sorts early. That is an accident,
 *      not a policy. Ranking here is by real average request cost, then by
 *      intelligence descending, then by id, which is deterministic without being
 *      arbitrary: among models that cost the same, take the more capable one.
 *
 * `providers` is passed in rather than read, for the reason `workModelOptions`
 * gives: this module is imported by the browser, `isProviderConfigured` answers
 * false for every lab there, and a provider filter that ran client-side would
 * empty the pool. Pass `null` to skip the check.
 *
 * Returns `null` when the account's plan admits no drivable model at all, which
 * is a 403 the caller has a sentence for — not something to paper over.
 */
export function pickWorkModel(input: {
  goal: string;
  plan: Plan;
  models: readonly ModelInfo[];
  providers?: readonly Provider[] | null;
}): WorkModelPick | null {
  const pool = workModelOptions(input.models, { providers: input.providers ?? null }).filter(
    (model) => canUseModel(input.plan, model.id)
  );
  if (pool.length === 0) return null;

  const complexity = classifyPromptComplexity(input.goal);
  const desiredFloor = Math.max(complexity.minIntelligence, WORK_MIN_INTELLIGENCE);

  // Step the floor down rather than falling straight to "anything". A goal that
  // wanted a 9 and can have an 8 should get the 8, not the cheapest thing on the
  // account — the fallback that skipped the middle is what made a substitution
  // feel like a punishment.
  let floor = desiredFloor;
  let candidates = pool.filter((model) => getModelMetrics(model).intelligence >= floor);
  while (candidates.length === 0 && floor > WORK_FLOOR_FLOOR) {
    floor -= 1;
    candidates = pool.filter((model) => getModelMetrics(model).intelligence >= floor);
  }
  if (candidates.length === 0) {
    floor = 0;
    candidates = pool;
  }

  const ranked = candidates.slice().sort((a, b) => {
    const costDelta = averageRequestCostMicroUsd(a) - averageRequestCostMicroUsd(b);
    if (costDelta !== 0) return costDelta;
    const intelDelta = getModelMetrics(b).intelligence - getModelMetrics(a).intelligence;
    if (intelDelta !== 0) return intelDelta;
    return a.id.localeCompare(b.id);
  });

  const model = ranked[0];
  if (!model) return null;
  return {
    model,
    floor,
    desiredFloor,
    relaxed: floor < desiredFloor,
    candidatesConsidered: ranked.length,
  };
}

/**
 * The models a failed run may be retried on, best-first, excluding the ones
 * already tried.
 *
 * Failover is a *run-boundary* decision — see the comment on `nextRunModel` in
 * `scripts/work-runner.ts` for why it cannot be a mid-loop one — so this returns
 * an ordered list rather than performing a swap. `exclude` carries every model
 * this task has already burned an attempt on, so a task whose first two choices
 * are both rate-limited walks down the list instead of oscillating between them.
 *
 * Ordered by the same rule as `pickWorkModel`, then filtered: a failover that
 * moved to a *less* capable model would be trading the failure the user saw for
 * one they will not understand. Provider diversity is preferred explicitly —
 * the failure this exists for is a provider-wide rate limit, and the second
 * choice on the same lab would meet the same quota.
 */
export function workFailoverModels(input: {
  goal: string;
  plan: Plan;
  models: readonly ModelInfo[];
  providers?: readonly Provider[] | null;
  exclude: readonly string[];
}): ModelInfo[] {
  const spent = new Set(input.exclude);
  const spentProviders = new Set(
    input.exclude
      .map((id) => input.models.find((model) => model.id === id)?.provider)
      .filter((provider): provider is Provider => provider != null)
  );

  const pool = workModelOptions(input.models, { providers: input.providers ?? null }).filter(
    (model) => canUseModel(input.plan, model.id) && !spent.has(model.id)
  );
  if (pool.length === 0) return [];

  const complexity = classifyPromptComplexity(input.goal);
  const floor = Math.max(complexity.minIntelligence, WORK_MIN_INTELLIGENCE);

  return pool.slice().sort((a, b) => {
    // A different lab first: the quota that stopped the last attempt belongs to
    // the lab, not to the model.
    const freshA = spentProviders.has(a.provider) ? 1 : 0;
    const freshB = spentProviders.has(b.provider) ? 1 : 0;
    if (freshA !== freshB) return freshA - freshB;

    // Then the floor, as a partition rather than a filter — a task with nothing
    // above the floor left should still be retried on the best thing below it.
    const clearsA = getModelMetrics(a).intelligence >= floor ? 0 : 1;
    const clearsB = getModelMetrics(b).intelligence >= floor ? 0 : 1;
    if (clearsA !== clearsB) return clearsA - clearsB;

    const costDelta = averageRequestCostMicroUsd(a) - averageRequestCostMicroUsd(b);
    if (costDelta !== 0) return costDelta;
    const intelDelta = getModelMetrics(b).intelligence - getModelMetrics(a).intelligence;
    if (intelDelta !== 0) return intelDelta;
    return a.id.localeCompare(b.id);
  });
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
