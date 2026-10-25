import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCompareRequestBody,
  compareEffortLabel,
  createRunSpec,
  effortDisplay,
  planDefaultEffort,
  plannedEffort,
  sharedInputFingerprint,
  stableStringify,
} from "@/lib/compare/run-spec";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import { readFileSync } from "node:fs";
import { FREE_DEFAULT_MODEL, getModel, type ModelInfo } from "@/lib/models";

/*
 * Master brief 4.3, identical-input controlled runs: one frozen spec per
 * comparison, one request builder, and a fingerprint that proves every pane
 * sent the same thing. Plus the effort each model will actually take, by the
 * same clamp the server applies.
 */

const model = (provider: string, providerModel: string, extra: Partial<ModelInfo> = {}) =>
  ({ id: `${provider}:${providerModel}`, provider, providerModel, name: providerModel, reasoning: true, ...extra }) as unknown as ModelInfo;

const OPUS_55 = model("anthropic", "claude-opus-5-5"); // always on, LMHXM, default medium
const OPUS_45 = model("anthropic", "claude-opus-4-5"); // LMH, can disable → default Instant
const HAIKU_45 = model("anthropic", "claude-haiku-4-5"); // on/off only
const PLAIN = model("openai", "gpt-4.1", { reasoning: false });

const base = { prompt: "Plan a 3-day Lisbon trip.", webSearch: false, reasoningEffort: null, timeZone: null };

test("two panes' requests differ only in model and generation id", () => {
  const a = buildCompareRequestBody({ ...base, webSearch: true, reasoningEffort: "high", timeZone: "UTC" }, "m:a", "gen-a");
  const b = buildCompareRequestBody({ ...base, webSearch: true, reasoningEffort: "high", timeZone: "UTC" }, "m:b", "gen-b");
  const differing = Object.keys({ ...a, ...b }).filter((key) => stableStringify(a[key]) !== stableStringify(b[key]));
  assert.deepEqual(differing.sort(), ["generationId", "model"]);
  assert.equal(sharedInputFingerprint(a), sharedInputFingerprint(b));
  assert.equal(a.privateMode, true, "comparisons ride the private transport: nothing is stored");
  assert.deepEqual(a.privateHistory, [{ role: "USER", content: base.prompt }]);
});

test("an unset effort and an unknown time zone are left out rather than sent empty", () => {
  const body = buildCompareRequestBody(base, "m", "g");
  assert.equal("reasoningEffort" in body, false);
  assert.equal("timeZone" in body, false);
  assert.equal(body.webSearch, false, "search off is sent explicitly");
});

test("the spec's fingerprint is the fingerprint of the body every pane sends", () => {
  const spec = createRunSpec({ id: "s", prompt: base.prompt, settings: { webSearch: true, reasoningEffort: "low" }, timeZone: " Europe/Paris ", now: new Date(0) });
  assert.equal(spec.timeZone, "Europe/Paris");
  assert.equal(spec.createdAt, "1970-01-01T00:00:00.000Z");
  for (const modelId of ["anthropic:x", "openai:y", "google:z"]) {
    assert.equal(sharedInputFingerprint(buildCompareRequestBody(spec, modelId, crypto.randomUUID())), spec.fingerprint);
  }
});

test("every shared input moves the fingerprint; the model and generation id do not", () => {
  const fp = (overrides: Partial<typeof base>, modelId = "m", gen = "g") =>
    sharedInputFingerprint(buildCompareRequestBody({ ...base, ...overrides }, modelId, gen));
  const reference = fp({});
  assert.equal(fp({}, "other-model", "other-gen"), reference);
  assert.notEqual(fp({ prompt: "Plan a 4-day Lisbon trip." }), reference);
  assert.notEqual(fp({ webSearch: true }), reference);
  assert.notEqual(fp({ reasoningEffort: "high" as never }), reference);
  assert.notEqual(fp({ timeZone: "Asia/Tokyo" as never }), reference);
  assert.match(reference, /^[0-9a-f]{10}$/);
});

test("stableStringify is key-order independent and drops undefined", () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } }), '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test("planned effort follows the server's clamp, including the trap where Max on a model without it means Instant", () => {
  assert.deepEqual(plannedEffort(OPUS_55, "high"), { effort: "high", planDefault: false, honoured: true, reasoning: true, auto: false });
  assert.deepEqual(plannedEffort(OPUS_55, null), { effort: "medium", planDefault: false, honoured: true, reasoning: true, auto: false }, "always-on runs at its default");
  assert.deepEqual(plannedEffort(OPUS_45, null), { effort: null, planDefault: false, honoured: true, reasoning: true, auto: false }, "a model that can stop thinking runs Instant by default");
  assert.deepEqual(plannedEffort(OPUS_45, "max"), { effort: null, planDefault: false, honoured: false, reasoning: true, auto: false }, "unsupported Max falls to the default, which is Instant here");
  assert.deepEqual(plannedEffort(HAIKU_45, "low"), { effort: "high", planDefault: false, honoured: false, reasoning: true, auto: false }, "on/off models only think at their one setting");
  assert.deepEqual(plannedEffort(PLAIN, "high"), { effort: null, planDefault: false, honoured: false, reasoning: false, auto: false });
  assert.deepEqual(plannedEffort(PLAIN, null), { effort: null, planDefault: false, honoured: true, reasoning: false, auto: false });
  assert.equal(plannedEffort({ ...OPUS_55, id: AUTO_MODEL_ID } as ModelInfo, "high")?.auto, true);
  assert.equal(plannedEffort(undefined, "high"), null);
});

test("before a run, Free's default model plans the server's plan default (Low), not the model's own", () => {
  const luna = getModel(FREE_DEFAULT_MODEL) as ModelInfo;
  assert.ok(luna?.reasoning, "the Free default model is a reasoning model");
  assert.equal(planDefaultEffort("FREE", FREE_DEFAULT_MODEL), "low");
  assert.equal(planDefaultEffort("PRO", FREE_DEFAULT_MODEL), null, "only Free has the default");
  assert.equal(planDefaultEffort("FREE", OPUS_55.id), null, "only on the Free default model");
  assert.equal(planDefaultEffort(null, FREE_DEFAULT_MODEL), null);

  const free = plannedEffort(luna, null, { plan: "FREE" });
  assert.deepEqual(free, { effort: "low", planDefault: true, honoured: true, reasoning: true, auto: false });
  // An effort that was asked for wins over the plan default, as on the server.
  assert.equal(plannedEffort(luna, "high", { plan: "FREE" })?.effort, "high");
  assert.equal(plannedEffort(luna, "high", { plan: "FREE" })?.planDefault, false);
  // Other plans, or no plan given, plan the model's own default.
  assert.equal(plannedEffort(luna, null, { plan: "PRO" })?.planDefault, false);
  assert.deepEqual(plannedEffort(luna, null, { plan: "PRO" }), plannedEffort(luna, null));
});

test("the plan default mirrored here is the rule the turn applies", () => {
  // If the server's rule changes, this mirror must change with it (src/lib/chat/turn/model.ts).
  const turn = readFileSync("src/lib/chat/turn/model.ts", "utf8");
  assert.match(turn, /input\.reasoningEffort \?\?[\s\S]{0,160}\(plan === "FREE" && requestedId === FREE_DEFAULT_MODEL \? FREE_DEFAULT_EFFORT : undefined\)/);
});

test("effort reads the way each model takes it", () => {
  assert.equal(effortDisplay(OPUS_55, "xhigh"), "Extra high");
  assert.equal(effortDisplay(OPUS_45, null), "Instant");
  assert.equal(effortDisplay(OPUS_55, null), "Provider default");
  assert.equal(effortDisplay(PLAIN, null), "No thinking");
  assert.equal(effortDisplay(undefined, null), "Unknown");
  assert.equal(compareEffortLabel(null), "Model default");
  assert.equal(compareEffortLabel("max"), "Max");
});
