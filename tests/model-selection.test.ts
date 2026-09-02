import test from "node:test";
import assert from "node:assert/strict";
import {
  cheapestEligible,
  selectModel,
  type SelectableModel,
} from "@/lib/model-selection";

/*
 * Characterisation tests for the model-selection stage, pinning the behaviour
 * it had while inline in the chat route. The rules here decide what a turn
 * costs, and every one of them used to be reachable only by standing up a
 * request with auth, quota and a database behind it.
 */

const frontier: SelectableModel = {
  id: "frontier", provider: "anthropic", name: "Frontier", cost: 40, modality: "chat",
};
const mid: SelectableModel = {
  id: "mid", provider: "openai", name: "Mid", cost: 8, modality: "chat",
};
const cheap: SelectableModel = {
  id: "cheap", provider: "deepseek", name: "Cheap", cost: 1, modality: "chat",
};
// Registry order is a *display* order — the frontier model comes first.
const CATALOGUE = [frontier, mid, cheap];

const allEligible = () => true;
const allHealthy = () => true;

test("an eligible, healthy request is honoured", () => {
  const result = selectModel({
    requestedId: "mid", requested: mid, catalogue: CATALOGUE,
    isEligible: allEligible, isProviderHealthy: allHealthy,
  });
  assert.equal(result.model?.id, "mid");
  assert.equal(result.reason, "requested");
  assert.equal(result.warning, null);
});

test("fallback takes the CHEAPEST eligible model, not the first in registry order", () => {
  // The bug this prevents: registry order leads with a frontier model, so a
  // fallback on the failure path silently bills ~40x the cheapest capable one.
  const result = selectModel({
    requestedId: "unknown", requested: null, catalogue: CATALOGUE,
    isEligible: allEligible, isProviderHealthy: allHealthy, allowSubstitution: true,
  });
  assert.equal(result.model?.id, "cheap");
  assert.equal(result.reason, "fallback");
});

test("an explicit ineligible request is refused rather than sent to another provider", () => {
  const result = selectModel({
    requestedId: "frontier", requested: frontier, catalogue: CATALOGUE,
    isEligible: (m) => m.id !== "frontier", isProviderHealthy: allHealthy,
  });
  assert.equal(result.model, null);
  assert.equal(result.reason, "fallback");
});

test("Auto may reroute an unhealthy provider, and says so in words a user can read", () => {
  const result = selectModel({
    requestedId: "frontier", requested: frontier, catalogue: CATALOGUE,
    isEligible: allEligible,
    isProviderHealthy: (p) => p !== "anthropic",
    allowSubstitution: true,
  });
  assert.equal(result.model?.id, "cheap");
  assert.equal(result.reason, "rerouted_unhealthy_provider");
  assert.match(String(result.warning), /Frontier is unavailable/);
  assert.match(String(result.warning), /Cheap/);
});

test("with nowhere healthy to go, the request is kept rather than pointlessly downgraded", () => {
  // Rerouting to another dead provider buys nothing and hides the real cause.
  const result = selectModel({
    requestedId: "frontier", requested: frontier, catalogue: CATALOGUE,
    isEligible: allEligible, isProviderHealthy: () => false,
  });
  assert.equal(result.model?.id, "frontier");
  assert.equal(result.reason, "requested");
  assert.equal(result.warning, null);
});

test("an explicit unhealthy model stays on its selected provider", () => {
  const result = selectModel({
    requestedId: "frontier", requested: frontier, catalogue: CATALOGUE,
    isEligible: allEligible, isProviderHealthy: (p) => p !== "anthropic",
  });
  assert.equal(result.model?.id, "frontier");
  assert.equal(result.reason, "requested");
  assert.equal(result.warning, null);
});

test("a dead-provider fallback still beats no model at all", () => {
  // Nothing healthy, and the request was ineligible: a configured-but-failing
  // model is a worse answer than a working one and a better answer than none.
  const result = selectModel({
    requestedId: "unknown", requested: null, catalogue: CATALOGUE,
    isEligible: allEligible, isProviderHealthy: () => false, allowSubstitution: true,
  });
  assert.equal(result.model?.id, "cheap");
  assert.equal(result.reason, "fallback");
});

test("no eligible model anywhere yields null rather than an arbitrary pick", () => {
  const result = selectModel({
    requestedId: "unknown", requested: null, catalogue: CATALOGUE,
    isEligible: () => false, isProviderHealthy: allHealthy,
  });
  assert.equal(result.model, null);
});

test("a spend ceiling degrades to the cheapest rather than refusing the turn", () => {
  const result = selectModel({
    requestedId: "frontier", requested: frontier, catalogue: CATALOGUE,
    isEligible: allEligible, isProviderHealthy: allHealthy,
    budgetExhausted: true, allowSubstitution: true,
  });
  assert.equal(result.model?.id, "cheap");
  assert.equal(result.reason, "budget_degraded");
  assert.match(String(result.warning), /daily spending limit/);
});

test("a spend ceiling does not 'degrade' a model that is already cheapest", () => {
  const result = selectModel({
    requestedId: "cheap", requested: cheap, catalogue: CATALOGUE,
    isEligible: allEligible, isProviderHealthy: allHealthy,
    budgetExhausted: true, allowSubstitution: true,
  });
  assert.equal(result.model?.id, "cheap");
  assert.equal(result.reason, "requested");
  assert.equal(result.warning, null);
});

test("a spend ceiling never changes an explicit model choice", () => {
  const result = selectModel({
    requestedId: "frontier", requested: frontier, catalogue: CATALOGUE,
    isEligible: allEligible, isProviderHealthy: allHealthy,
    budgetExhausted: true,
  });
  assert.equal(result.model?.id, "frontier");
  assert.equal(result.reason, "requested");
  assert.equal(result.warning, null);
});

test("a reroute warning is not overwritten by a later budget degrade", () => {
  // The user sees one sentence; it should be the one that explains the model
  // they actually got, not the second thing that happened to it.
  const result = selectModel({
    requestedId: "frontier", requested: frontier, catalogue: CATALOGUE,
    isEligible: allEligible,
    isProviderHealthy: (p) => p !== "anthropic",
    budgetExhausted: true, allowSubstitution: true,
  });
  assert.match(String(result.warning), /unavailable right now/);
});

test("the requested id is carried through for the requested-vs-effective record", () => {
  const result = selectModel({
    requestedId: "frontier", requested: null, catalogue: CATALOGUE,
    isEligible: allEligible, isProviderHealthy: allHealthy, allowSubstitution: true,
  });
  assert.equal(result.requestedId, "frontier");
  assert.notEqual(result.model?.id, "frontier");
});

test("cheapestEligible ignores health when no health predicate is given", () => {
  assert.equal(cheapestEligible(CATALOGUE, allEligible)?.id, "cheap");
  assert.equal(cheapestEligible(CATALOGUE, allEligible, () => false), null);
  assert.equal(cheapestEligible([], allEligible), null);
});
