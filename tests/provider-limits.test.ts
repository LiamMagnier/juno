import test from "node:test";
import assert from "node:assert/strict";
import { clampMaxTokens, PROVIDER_MAX_OUTPUT } from "@/lib/provider-limits";
import { MODELS, type ModelInfo } from "@/lib/models";
import { PROVIDER_LIST } from "@/lib/providers";
import { estimateCostUsd, tokenRate } from "@/lib/pricing";
import { getModelMetrics, reasoningCaps } from "@/lib/model-metrics";

/*
 * Table-completeness, asserted per provider.
 *
 * A missing row in any of these tables raises no error anywhere: the output cap
 * quietly falls to 8192 (Meta and LongCat could never write a long answer), a
 * price silently becomes zero, a thinking ladder silently disappears. The only
 * thing that catches it is iterating PROVIDER_LIST.
 */

const chatModelFor = (provider: string): ModelInfo | undefined =>
  Object.values(MODELS)
    .filter((m) => m.provider === provider && m.modality === "chat" && !m.comingSoon)
    .sort((a, b) => a.cost - b.cost)[0];

test("every provider declares an output ceiling", () => {
  for (const provider of PROVIDER_LIST) {
    assert.equal(typeof PROVIDER_MAX_OUTPUT[provider], "number", `${provider} has no PROVIDER_MAX_OUTPUT entry`);
  }
});

test("every provider that serves chat can produce a long answer", () => {
  for (const provider of PROVIDER_LIST) {
    if (!chatModelFor(provider)) continue; // seedance is media-only
    assert.ok(
      clampMaxTokens(provider, 100_000) > 8_192,
      `${provider} is capped at the 8192 fallback — add it to PROVIDER_MAX_OUTPUT`,
    );
  }
});

/*
 * `> 8192` catches an entry that is MISSING. It does not catch one that is
 * merely far too small, and that is the failure this test was added for: mimo
 * sat at 16384 — above the fallback, so the test above passed — against a real
 * Xiaomi ceiling of 131072. Eight times under, on models with a 1.05M context,
 * and the symptom was a reply that just stopped mid-sentence.
 *
 * The invariant: a provider you can hand 256k tokens to should be able to hand
 * more than 32k back. Two numbers that far apart are not a considered trade-off
 * between context and output, they are a placeholder nobody revisited — which
 * is exactly what 16384 was, the one entry in the table carrying no note
 * saying why.
 */
test("a long-context provider is not capped to a short answer", () => {
  const LONG_CONTEXT = 256_000;
  const FLOOR = 32_768;
  for (const provider of PROVIDER_LIST) {
    const longest = Object.values(MODELS)
      .filter((m) => m.provider === provider && m.modality === "chat" && !m.comingSoon)
      .reduce((max, m) => Math.max(max, m.contextWindow ?? 0), 0);
    if (longest < LONG_CONTEXT) continue;
    assert.ok(
      PROVIDER_MAX_OUTPUT[provider] >= FLOOR,
      `${provider} takes ${longest} tokens in but only allows ${PROVIDER_MAX_OUTPUT[provider]} out — check the lab's real ceiling`,
    );
  }
});

test("clamping keeps a floor as well as a ceiling", () => {
  assert.equal(clampMaxTokens("google", 10), 1_024);
  assert.equal(clampMaxTokens("google", 10_000_000), PROVIDER_MAX_OUTPUT.google);
  // An unknown provider string still yields a usable request rather than NaN.
  assert.equal(clampMaxTokens("not-a-provider", 100_000), 8_192);
});

/*
 * The bound that makes the lab ceilings above safe to state honestly.
 *
 * Before this existed, the table carried the job: a provider whose flagship has
 * a 1M window but whose cheap sibling has 128k was shaded down to protect the
 * sibling, and the flagship lost most of its answer. It did not even work —
 * `zhipu` sat at 131072 against `glm-4.6`'s 128,000-token window, so every
 * GLM-4.x request asked for more reply than the model could physically hold.
 */
test("a reply is never budgeted larger than the model's own window", () => {
  // 128k window: at most half of it may go to the reply, whatever the lab allows.
  assert.equal(clampMaxTokens("zhipu", 200_000, 128_000), 64_000);
  // 1M window on the same lab: the lab ceiling is what binds, not the window.
  assert.equal(clampMaxTokens("zhipu", 200_000, 1_000_000), PROVIDER_MAX_OUTPUT.zhipu);
  // An unknown window leaves the lab ceiling as the only bound (discovered models).
  assert.equal(clampMaxTokens("zhipu", 200_000), PROVIDER_MAX_OUTPUT.zhipu);
  assert.equal(clampMaxTokens("zhipu", 200_000, 0), PROVIDER_MAX_OUTPUT.zhipu);
  // The 1024 floor still wins over a tiny request.
  assert.equal(clampMaxTokens("zhipu", 10, 128_000), 1_024);
});

/*
 * Pins the two ends of the same rule across the whole catalog, so neither a new
 * model nor a raised ceiling can reintroduce either failure:
 *   - asking a model for more output than its window holds (a 400, or a reply
 *     the provider silently truncates), and
 *   - handing a long-context model a budget so small the answer stops early,
 *     which is the bug users actually report ("Response hit the token limit").
 */
test("every chat model gets a budget that fits its window and is worth having", () => {
  for (const model of Object.values(MODELS)) {
    if (model.modality !== "chat" || model.comingSoon) continue;
    const context = getModelMetrics(model).contextTokens;
    const budget = clampMaxTokens(model.provider, 200_000, context);
    assert.ok(
      budget <= context,
      `${model.id}: budgets ${budget} output tokens into a ${context}-token window`,
    );
    // 8192 is the lookup fallback — a model landing on it has been forgotten,
    // not deliberately limited. Only genuinely small windows may sit that low.
    assert.ok(
      budget > 8_192 || context <= 32_768,
      `${model.id}: ${context}-token window but only ${budget} tokens of reply`,
    );
  }
});

test("every provider's chat model has a price and a reasoning verdict", () => {
  for (const provider of PROVIDER_LIST) {
    const model = chatModelFor(provider);
    if (!model) continue;
    const rate = tokenRate(model);
    assert.ok(rate.input > 0, `${provider}: ${model.id} has no input rate`);
    assert.ok(rate.output > 0, `${provider}: ${model.id} has no output rate`);
    assert.ok(
      estimateCostUsd(model, { input: 1_000, output: 1_000 }) > 0,
      `${provider}: ${model.id} costs nothing to run`,
    );
    // Never throws, and never claims a ladder for a model that cannot reason.
    const caps = reasoningCaps(model);
    if (!model.reasoning) assert.deepEqual(caps.tiers, []);
  }
});
