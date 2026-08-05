import test from "node:test";
import assert from "node:assert/strict";
import {
  cheapestEligible,
  isEligible,
  resolveExecutionModel,
  resolveRequestedModelId,
  routingWarningFor,
  type ModelPolicy,
} from "@/lib/chat/execution-plan";
import type { ModelInfo } from "@/lib/models";

/*
 * Characterisation tests for the execution-planning stage of the chat route.
 *
 * They pin the model-selection cascade exactly as the route ran it before the
 * extraction: ineligible falls back silently, an unhealthy provider reroutes
 * with a warning, and the platform budget degrades only downward.
 */

function model(overrides: Partial<ModelInfo> & Pick<ModelInfo, "id" | "cost">): ModelInfo {
  return {
    provider: "anthropic",
    providerModel: overrides.id,
    name: overrides.id,
    minPlan: "FREE",
    vision: false,
    reasoning: false,
    modality: "chat",
    webSearch: false,
    ...overrides,
  } as ModelInfo;
}

const cheap = model({ id: "anthropic:cheap", cost: 1, name: "Cheap" });
const mid = model({ id: "openai:mid", cost: 2, name: "Mid", provider: "openai" });
const frontier = model({ id: "anthropic:frontier", cost: 3, name: "Frontier" });
const CANDIDATES = [frontier, mid, cheap];

function policy(overrides: Partial<ModelPolicy> = {}): ModelPolicy {
  return {
    isConfigured: () => true,
    isHealthy: () => true,
    allows: () => true,
    isAuto: (id) => id === "juno:auto",
    ...overrides,
  };
}

test("a healthy, allowed, configured model serves unchanged", () => {
  const result = resolveExecutionModel({
    requested: frontier,
    candidates: CANDIDATES,
    policy: policy(),
    platformBudgetExceeded: false,
  });
  assert.equal(result.model, frontier);
  assert.deepEqual(result.changes, []);
  assert.equal(result.routingWarning, null);
});

test("fallback picks the CHEAPEST eligible model, not the first in registry order", () => {
  // Registry order is a display order — its first chat entry is a frontier
  // model. Falling back to it bills roughly 40x the cheapest capable model on
  // the path taken precisely when something has already gone wrong.
  const result = resolveExecutionModel({
    requested: undefined,
    candidates: CANDIDATES,
    policy: policy(),
    platformBudgetExceeded: false,
  });
  assert.equal(result.model, cheap);
});

test("fallback is silent — the user never chose the model that was rejected", () => {
  const result = resolveExecutionModel({
    requested: undefined,
    candidates: CANDIDATES,
    policy: policy(),
    platformBudgetExceeded: false,
  });
  assert.equal(result.routingWarning, null);
  assert.equal(result.changes[0]?.kind, "fallback");
});

test("Auto is a routing sentinel and is never itself the execution model", () => {
  const auto = model({ id: "juno:auto", cost: 1, name: "Auto" });
  const result = resolveExecutionModel({
    requested: auto,
    candidates: [auto, ...CANDIDATES],
    policy: policy(),
    platformBudgetExceeded: false,
  });
  assert.equal(result.model, cheap);
});

test("an unconfigured provider falls back rather than being called", () => {
  const result = resolveExecutionModel({
    requested: frontier,
    candidates: CANDIDATES,
    policy: policy({ isConfigured: (provider) => provider !== "anthropic" }),
    platformBudgetExceeded: false,
  });
  assert.equal(result.model, mid);
});

test("a model the plan disallows falls back", () => {
  const result = resolveExecutionModel({
    requested: frontier,
    candidates: CANDIDATES,
    policy: policy({ allows: (id) => id !== frontier.id }),
    platformBudgetExceeded: false,
  });
  assert.equal(result.model, cheap);
});

test("an unhealthy provider reroutes to a healthy one, and says so", () => {
  const result = resolveExecutionModel({
    requested: frontier,
    candidates: CANDIDATES,
    policy: policy({ isHealthy: (provider) => provider !== "anthropic" }),
    platformBudgetExceeded: false,
  });
  assert.equal(result.model, mid);
  assert.equal(result.changes[0]?.kind, "unhealthy_provider");
  assert.equal(result.routingWarning, "Frontier is unavailable right now — answered with Mid instead.");
});

test("an unhealthy provider with nowhere healthy to go still runs the requested model", () => {
  // A configured-but-dead provider is better than a 503: the request may still
  // succeed, and refusing guarantees it cannot.
  const result = resolveExecutionModel({
    requested: frontier,
    candidates: CANDIDATES,
    policy: policy({ isHealthy: () => false }),
    platformBudgetExceeded: false,
  });
  assert.equal(result.model, frontier);
  assert.equal(result.routingWarning, null);
});

test("fallback prefers a healthy provider but accepts an unhealthy one over nothing", () => {
  const result = resolveExecutionModel({
    requested: undefined,
    candidates: CANDIDATES,
    policy: policy({ isHealthy: () => false }),
    platformBudgetExceeded: false,
  });
  assert.equal(result.model, cheap);
});

test("the platform budget degrades an expensive model and explains why", () => {
  const result = resolveExecutionModel({
    requested: frontier,
    candidates: CANDIDATES,
    policy: policy(),
    platformBudgetExceeded: true,
  });
  assert.equal(result.model, cheap);
  assert.equal(result.routingWarning, "Answered with Cheap to stay within today's capacity.");
});

test("the platform budget never degrades UPWARD", () => {
  // The guard is `cheapest.cost < model.cost`. Without it, an account already
  // on the cheapest model would be "degraded" onto itself — or, if the sort
  // ever changed, onto something more expensive during a capacity incident.
  const result = resolveExecutionModel({
    requested: cheap,
    candidates: CANDIDATES,
    policy: policy(),
    platformBudgetExceeded: true,
  });
  assert.equal(result.model, cheap);
  assert.equal(result.routingWarning, null);
});

test("the budget step is a no-op after a fallback, and says nothing", () => {
  // Not an accident worth 'fixing': a fallback already landed on the cheapest
  // eligible model, so the budget step's own `cheapest.cost < model.cost`
  // guard can never fire behind it. The user is therefore told nothing about
  // capacity on a request where they never chose a model in the first place —
  // which is the right answer, and is pinned here so a future reordering of
  // the two steps has to be a deliberate decision rather than a silent one.
  const result = resolveExecutionModel({
    requested: undefined,
    candidates: [frontier, mid],
    policy: policy(),
    platformBudgetExceeded: true,
  });
  assert.equal(result.model, mid);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, "fallback");
  assert.equal(result.routingWarning, null);
});

test("at most one change ever applies, so the budget degrade only follows an untouched request", () => {
  // Both earlier steps select `cheapest(healthy)` themselves, so once either
  // has fired the budget step's `cheapest.cost < model.cost` guard is false by
  // construction. Worth pinning: it is the reason a user is never shown two
  // routing sentences for one turn, and it would stop being true the moment
  // the fallback picked anything other than the cheapest.
  const rerouted = resolveExecutionModel({
    requested: frontier,
    candidates: CANDIDATES,
    policy: policy({ isHealthy: (provider) => provider !== "anthropic" }),
    platformBudgetExceeded: true,
  });
  assert.deepEqual(rerouted.changes.map((change) => change.kind), ["unhealthy_provider"]);

  const degraded = resolveExecutionModel({
    requested: frontier,
    candidates: CANDIDATES,
    policy: policy(),
    platformBudgetExceeded: true,
  });
  assert.deepEqual(degraded.changes.map((change) => change.kind), ["platform_budget"]);
});

test("nothing eligible resolves to null, which is the route's 503", () => {
  const result = resolveExecutionModel({
    requested: frontier,
    candidates: CANDIDATES,
    policy: policy({ isConfigured: () => false }),
    platformBudgetExceeded: false,
  });
  assert.equal(result.model, null);
});

test("non-chat modalities and coming-soon entries are never eligible", () => {
  const image = model({ id: "openai:image", cost: 1, modality: "image", provider: "openai" });
  const soon = model({ id: "openai:soon", cost: 1, comingSoon: true, provider: "openai" });
  assert.equal(isEligible(image, policy()), false);
  assert.equal(isEligible(soon, policy()), false);
  assert.equal(cheapestEligible([image, soon, mid], policy(), false), mid);
});

test("a fallback change carries no sentence", () => {
  assert.equal(routingWarningFor({ kind: "fallback", to: cheap }), null);
});

test("the requested id is the explicit choice, then the account default, then the app default", () => {
  const known = (id: string) => id === "a" || id === "b";
  assert.equal(
    resolveRequestedModelId({ requested: "a", accountDefault: "b", appDefault: "z", isKnown: known }),
    "a"
  );
  assert.equal(
    resolveRequestedModelId({ requested: "unknown", accountDefault: "b", appDefault: "z", isKnown: known }),
    "b"
  );
  // A stored default can outlive the model it names; that must not fail the
  // request, it must fall through.
  assert.equal(
    resolveRequestedModelId({ requested: undefined, accountDefault: "gone", appDefault: "z", isKnown: known }),
    "z"
  );
});
