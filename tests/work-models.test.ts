import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_MODEL_ID,
  WORK_DEFAULT_MODEL,
  cheapestWorkModel,
  defaultWorkModelId,
  isAutoModelId,
  isWorkCapableModel,
  isWorkModelAllowed,
  workModelLocked,
  workModelOptions,
} from "@/lib/work/models";
import { canUseModel } from "@/lib/plans";
import { DEFAULT_MODEL, MODEL_LIST, resolveModel, type ModelInfo } from "@/lib/models";

/*
 * Which models can carry a Work run, and which one runs when nobody chose.
 *
 * The failure this file guards is quiet in exactly the way the rest of Work is
 * quiet. A Work run is an agent loop: the executor splits `provider:model`,
 * builds an adapter and starts calling tools. Hand it an image model, a model
 * that is in the catalog but not yet callable, or an OpenAI entry that only
 * exists on the Responses API, and the run does not refuse politely — it dies
 * somewhere after `preparing`, and every surface renders that as a task that is
 * still going.
 *
 * So the tests below are written against the catalog as it actually is rather
 * than against fixtures. A hand-built `ModelInfo` proves the predicate reads its
 * own fields; only the real list proves the predicate excludes the entries that
 * are really in there.
 */

/** A minimal chat model, for the cases that are about one field at a time. */
function chatModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "anthropic:test-model",
    provider: "anthropic",
    providerModel: "test-model",
    name: "Test Model",
    minPlan: "FREE",
    vision: false,
    reasoning: false,
    agenticTools: true,
    cost: 1,
    modality: "chat",
    webSearch: false,
    status: "current",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// What the runtime can drive
// ---------------------------------------------------------------------------

test("only chat models survive, one excluded field at a time", () => {
  assert.equal(isWorkCapableModel(chatModel()), true);

  // An image or video model has no tool loop to drive. The picker showing one
  // is a run that fails after it has been claimed, which is the worst place for
  // it to fail: the user has already been told it started.
  assert.equal(isWorkCapableModel(chatModel({ modality: "image" })), false);
  assert.equal(isWorkCapableModel(chatModel({ modality: "video" })), false);

  // The proxy provider speaks /chat/completions and /v1/messages. Nothing in
  // the Work runtime speaks the Responses API.
  assert.equal(isWorkCapableModel(chatModel({ api: "responses" })), false);
  assert.equal(isWorkCapableModel(chatModel({ api: "chat" })), true);

  // Listed but not yet callable. Offering it is offering a model that 404s.
  assert.equal(isWorkCapableModel(chatModel({ comingSoon: true })), false);

  // Deprecated is a slower version of the same problem: it works until the day
  // the provider turns it off, and a Work run is the thing that is still
  // running on that day.
  assert.equal(isWorkCapableModel(chatModel({ status: "deprecated" })), false);
  assert.equal(isWorkCapableModel(chatModel({ status: "legacy" })), true);
});

test("nothing the real catalog offers for Work is undriveable", () => {
  const offered = workModelOptions(MODEL_LIST);
  assert.ok(offered.length > 0, "an empty picker would be a worse bug than a wrong one");

  for (const model of offered) {
    assert.equal(model.modality, "chat", `${model.id} is a ${model.modality} model`);
    assert.notEqual(model.api, "responses", `${model.id} is Responses-only`);
    assert.notEqual(model.comingSoon, true, `${model.id} is not callable yet`);
    assert.notEqual(model.status, "deprecated", `${model.id} is deprecated`);
  }

  // Spot-checks against entries that exist today, so a catalog edit that
  // reclassifies one of them shows up here rather than in a stuck run.
  const ids = new Set(offered.map((model) => model.id));
  assert.equal(ids.has("anthropic:claude-sonnet-5"), true);
  assert.equal(ids.has("openai:gpt-5.5-pro"), false, "Responses API only");
  assert.equal(ids.has("openai:gpt-image-2"), false, "an image model");
});

test("the picker keeps its order and keeps the models the reader cannot afford", () => {
  const offered = workModelOptions(MODEL_LIST);
  const catalogOrder = MODEL_LIST.filter((model) => offered.some((kept) => kept.id === model.id));
  assert.deepEqual(
    offered.map((model) => model.id),
    catalogOrder.map((model) => model.id),
    "the catalog's own order is the order the reader has learnt"
  );

  // Plan-gated models are shown with a lock, never dropped. Silently omitting
  // Opus answers "why can't I pick Opus" with nothing at all, which is how a
  // picker teaches people that Juno's catalog is arbitrary.
  const locked = offered.filter((model) => workModelLocked(model, "FREE"));
  assert.ok(locked.length > 0, "the free plan cannot call every model, so some must be shown locked");
});

test("the provider filter is opt-in, because the browser cannot answer it", () => {
  const anthropicOnly = workModelOptions(MODEL_LIST, { providers: ["anthropic"] });
  assert.ok(anthropicOnly.length > 0);
  assert.ok(anthropicOnly.every((model) => model.provider === "anthropic"));

  // `null` skips the check. The dispatch route passes it: by then the only
  // question left is whether the run can be created, and the executor is the
  // authority on whether a key resolves.
  assert.deepEqual(
    workModelOptions(MODEL_LIST, { providers: null }).map((model) => model.id),
    workModelOptions(MODEL_LIST).map((model) => model.id)
  );
});

// ---------------------------------------------------------------------------
// The plan gate
// ---------------------------------------------------------------------------

test("a model above the account's plan is refused, and Auto never is", () => {
  // The enforcement, not the courtesy. The lock in the picker is a rendering
  // decision; this is what a direct POST runs into.
  assert.equal(isWorkModelAllowed("anthropic:claude-opus-5", "FREE"), false);
  assert.equal(isWorkModelAllowed("anthropic:claude-opus-5", "PRO"), true);
  assert.equal(isWorkModelAllowed("anthropic:claude-opus-5", "OWNER"), true);

  // Auto passes for everyone, on every plan, because it is not a model: it is a
  // promise to choose one, and the router only ever returns models the plan can
  // call. Refusing the sentinel would refuse the default every client sends.
  assert.equal(isWorkModelAllowed(AUTO_MODEL_ID, "FREE"), true);
  assert.equal(isWorkModelAllowed("auto", "FREE"), true);

  // No model named is not a model refused. The dispatch route resolves the
  // absent case to the sentinel; a gate that 403'd on it would refuse a request
  // that had not yet asked for anything.
  assert.equal(isWorkModelAllowed(null, "FREE"), true);
  assert.equal(isWorkModelAllowed(undefined, "FREE"), true);
  assert.equal(isWorkModelAllowed("   ", "FREE"), true);
});

test("workModelLocked and isWorkModelAllowed agree about the same model", () => {
  // Two functions, two callers — the picker and the route — and one answer. If
  // they ever disagree the reader is shown an unlocked model that the server
  // then refuses, which reads as Juno breaking rather than as a plan limit.
  for (const model of workModelOptions(MODEL_LIST)) {
    for (const plan of ["FREE", "PRO", "MAX", "MAX20", "OWNER"] as const) {
      assert.equal(
        workModelLocked(model, plan),
        !isWorkModelAllowed(model.id, plan),
        `${model.id} on ${plan}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The defaults
// ---------------------------------------------------------------------------

test("a session with no preference stores the sentinel, never a concrete model", () => {
  assert.equal(defaultWorkModelId(), AUTO_MODEL_ID);
  assert.equal(isAutoModelId(defaultWorkModelId()), true);

  // Storing a concrete id would freeze the choice at the moment the draft was
  // written. A task drafted in March and started in August should be routed by
  // August's catalog.
  assert.notEqual(defaultWorkModelId(), WORK_DEFAULT_MODEL);
});

test("the fallback is a model the runtime can actually drive", () => {
  // This is the one that matters. `WORK_DEFAULT_MODEL` is where the dispatch
  // route lands when a requested model turns out to be undriveable, so if it
  // were itself undriveable the substitution would swap one dead run for
  // another and record a degradation explaining the swap.
  const fallback = resolveModel(WORK_DEFAULT_MODEL);
  assert.ok(fallback, `${WORK_DEFAULT_MODEL} is not in the catalog`);
  assert.equal(isWorkCapableModel(fallback), true);
  assert.equal(isAutoModelId(WORK_DEFAULT_MODEL), false, "the fallback must be concrete");

  // Same id chat falls back to, named separately so a future where Work wants a
  // different floor is one constant rather than a search.
  assert.equal(WORK_DEFAULT_MODEL, DEFAULT_MODEL);
});

// ---------------------------------------------------------------------------
// The floor under Auto
// ---------------------------------------------------------------------------

/*
 * `isWorkModelAllowed` waves the Auto sentinel through, and it is right to:
 * the sentinel names no model, so there is nothing yet to check. What made that
 * a hole was reading it as a guarantee. `pickAutoModel`'s last resort consults
 * neither the plan nor the configured providers, so on an account whose
 * eligible pool is empty it returns whichever chat model comes first in the
 * catalog — a frontier model, on the deployment's key, for an account entitled
 * to none. `cheapestWorkModel` is the floor the resolved id is checked against.
 */

test("a plan with no entitlement gets no model at all, rather than the first one in the catalog", () => {
  // Since the FREE trial, a FREE account is entitled to the catalog's
  // FREE-priced tier — its floor must come from inside that tier…
  const free = cheapestWorkModel(MODEL_LIST, "FREE");
  if (free) assert.ok(canUseModel("FREE", free.id), "the FREE fallback must be inside the trial tier");
  // …and an account whose eligible pool is genuinely empty still gets null,
  // never the first model in the catalog.
  assert.equal(
    cheapestWorkModel(MODEL_LIST.filter((model) => model.minPlan !== "FREE"), "FREE"),
    null
  );
});

test("the floor is the cheapest thing the account may actually use, and it can be driven", () => {
  const picked = cheapestWorkModel(MODEL_LIST, "PRO");
  assert.ok(picked, "a PRO account must have something to fall back to");
  assert.ok(isWorkCapableModel(picked), "the fallback must be a model the agent runtime can drive");
  assert.ok(canUseModel("PRO", picked.id), "the fallback must be inside the plan");

  const cheaper = MODEL_LIST.filter(
    (model) => isWorkCapableModel(model) && canUseModel("PRO", model.id) && model.cost < picked.cost
  );
  assert.deepEqual(cheaper, [], "nothing cheaper and usable may have been passed over");
});

test("a richer plan never falls back to something a poorer one could not have", () => {
  // The floor moves with entitlement, so it can only ever widen.
  const pro = cheapestWorkModel(MODEL_LIST, "PRO");
  const max = cheapestWorkModel(MODEL_LIST, "MAX20");
  assert.ok(pro && max);
  assert.ok(max.cost <= pro.cost);
});
