import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_LIST, guessAgenticTools, resolveModel } from "@/lib/models";
import { cheapestWorkModel, isWorkCapableModel } from "@/lib/work/models";

/*
 * Whether a model can actually call the tools a Work run gives it.
 *
 * Nothing in the catalog recorded this. `isWorkCapableModel` filtered on
 * modality, wire protocol, coming-soon and deprecation — all of which are about
 * whether a model can be *reached*, none about whether it can do the job once
 * reached. `providerSpecFor` in the cloud runner compounds it by hard-coding
 * `tools: true` on every adapter it builds, so the whole stack assumed the
 * capability and no layer could contradict it.
 *
 * The cost of that was concrete: `mistral-medium-latest` was offered for Work,
 * and produced seven consecutive runs that answered in prose, called no tool,
 * left the plan untouched and failed — each one billing real tokens.
 *
 * It reached those runs as a stored model id on the task, not through the Auto
 * fallback: `cheapestWorkModel` returns Haiku both before and after this
 * change. Recording the capability closes both doors, but only one of them was
 * the one anybody walked through.
 *
 * These tests are about the two halves that have to hold together: the
 * capability is recorded, and the surfaces that pick a model respect it.
 */

test("the capability is recorded on every catalog entry", () => {
  for (const model of MODEL_LIST) {
    assert.equal(
      typeof model.agenticTools,
      "boolean",
      `${model.id} has no agenticTools flag, so nothing can filter on it`
    );
  }
});

test("an unknown model is assumed capable rather than excluded", () => {
  // The default has to be permissive. An allowlist would answer "no" for every
  // model newer than itself, so the day a lab ships its next flagship the
  // catalog would quietly stop offering it for Work — the same failure the
  // catalog's other heuristics document and avoid.
  assert.equal(guessAgenticTools("some-model-nobody-has-met-yet"), true);
  assert.equal(guessAgenticTools("gpt-9-turbo"), true);
  assert.equal(guessAgenticTools("claude-opus-7"), true);
});

test("a model with evidence against it is excluded", () => {
  // Seven runs, zero tool calls. See NO_AGENTIC_TOOLS_RE for the record.
  assert.equal(guessAgenticTools("mistral-medium-latest"), false);
  assert.equal(guessAgenticTools("mistral-medium-2505"), false);
  // Narrow: the finding is about one model line, not the vendor.
  assert.equal(guessAgenticTools("mistral-large-latest"), true);
  assert.equal(guessAgenticTools("mistral-small-latest"), true);
});

test("Work will not offer a model that cannot call tools", () => {
  const model = resolveModel("mistral:mistral-medium-latest");
  assert.ok(model, "mistral-medium-latest is missing from the catalog");
  assert.equal(model.agenticTools, false);
  assert.equal(
    isWorkCapableModel(model),
    false,
    "a model that does not call tools is still being offered for Work"
  );
});

test("no substituted Auto choice can land on a model that cannot call tools", () => {
  // `cheapestWorkModel` sorts by cost over models that pass
  // `isWorkCapableModel`, and it is what a substituted Auto choice falls back
  // to. Whatever it returns has to be able to do the work.
  //
  // Note for anyone reading this after a related bug report: this path was NOT
  // how the reported runs ended up on mistral-medium. The cheapest work-capable
  // model is Haiku, before and after this change — those tasks carried a
  // concrete stored model id. The guard still belongs here, because the whole
  // point of a fallback is that nobody chose it deliberately.
  for (const plan of ["FREE", "PRO", "MAX", "OWNER"] as const) {
    const fallback = cheapestWorkModel(MODEL_LIST, plan);
    if (!fallback) continue;
    assert.equal(
      fallback.agenticTools,
      true,
      `the ${plan} fallback is ${fallback.id}, which cannot call tools`
    );
  }
});

test("excluding it did not empty the pool", () => {
  // A filter that removes everything is a product that cannot run a task at
  // all — a worse failure than the one being fixed. This is the blast-radius
  // check on `NO_AGENTIC_TOOLS_RE`: a pattern that is too broad shows up here
  // rather than in production.
  const capable = MODEL_LIST.filter(isWorkCapableModel);
  assert.ok(
    capable.length >= 50,
    `only ${capable.length} work-capable models remain; the pattern is too broad`
  );

  // Every paid plan keeps a fallback. FREE has none and had none before this
  // change — `cheapestWorkModel` returned null for it already, because no
  // work-capable model sits at that plan level. That is a separate product
  // question and deliberately not changed here; the assertion is written to
  // catch a *regression*, not to assert a state that never held.
  for (const plan of ["PRO", "MAX", "OWNER"] as const) {
    assert.ok(
      cheapestWorkModel(MODEL_LIST, plan) !== null,
      `no work-capable model is available on ${plan}`
    );
  }
});

test("image and video models were never work-capable and still are not", () => {
  // `def()` sets the flag false for non-chat modalities, which must not become
  // the reason they are excluded — `modality === "chat"` already does that, and
  // two overlapping reasons hide it when one is removed.
  for (const model of MODEL_LIST.filter((entry) => entry.modality !== "chat")) {
    assert.equal(model.agenticTools, false, `${model.id}`);
    assert.equal(isWorkCapableModel(model), false, `${model.id}`);
  }
});
