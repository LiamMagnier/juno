import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BENCHMARKS } from "../src/lib/benchmarks.generated";
import { getModelMetrics } from "../src/lib/model-metrics";
import { CURATED_CHAT_MODELS } from "../src/lib/models";
import { modelRequiredPlan, PLANS } from "../src/lib/plans";
import { tokenRate } from "../src/lib/pricing";
import { displayPrice } from "../src/lib/price-display";
import {
  findPair,
  findings,
  MODEL_PAIRS,
  modelFacts,
  pairDescription,
  pairTitle,
  relatedPairs,
  usd,
  verdict,
  WORKLOADS,
  workloadCostUsd,
} from "../src/lib/compare/model-pairs";

/**
 * The public /vs pages promise that every figure is the app's own data. These
 * tests hold them to it: every slug resolves, every number a page renders is
 * recomputable from the catalog, metrics, pricing, benchmark and plan files,
 * and no page asserts a measurement the benchmark file does not contain.
 */

const model = (id: string) => CURATED_CHAT_MODELS.find((m) => m.id === id)!;

describe("public model comparisons", () => {
  it("has about a dozen unique, URL-safe slugs that all resolve", () => {
    assert.ok(MODEL_PAIRS.length >= 12);
    const slugs = MODEL_PAIRS.map((p) => p.slug);
    assert.equal(new Set(slugs).size, slugs.length, "duplicate slug");
    for (const p of MODEL_PAIRS) {
      assert.match(p.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*-vs-[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.equal(findPair(p.slug), p);
      assert.notEqual(p.a, p.b);
    }
    assert.equal(findPair("claude-opus-5-5-vs-gpt-6-1-sol")?.use, "general");
    assert.equal(findPair("claude-opus-5-5-vs-gpt-6-1-sol-for-coding")?.use, "coding");
    assert.equal(findPair("claude-opus-5-5-vs-gpt-6-1-sol-for-writing")?.use, "writing");
    assert.equal(findPair("not-a-pair"), undefined);
  });

  it("compares only current, callable chat models from the curated catalog", () => {
    for (const p of MODEL_PAIRS) {
      for (const id of [p.a, p.b]) {
        const m = model(id);
        assert.ok(m, `${id} is not in the curated catalog`);
        assert.equal(m.status, "current", `${id} is not current`);
        assert.equal(m.modality, "chat");
        assert.ok(!m.comingSoon, `${id} is not callable yet`);
      }
    }
  });

  it("renders only figures present in the data files", () => {
    for (const p of MODEL_PAIRS) {
      for (const id of [p.a, p.b]) {
        const f = modelFacts(id);
        const m = model(id);
        const metrics = getModelMetrics(m);
        assert.equal(f.inputUsd, metrics.inputUsdPerMTok);
        assert.equal(f.outputUsd, metrics.outputUsdPerMTok);
        assert.equal(f.contextTokens, metrics.contextTokens);
        assert.equal(f.intelligence, metrics.intelligence);
        assert.equal(f.speed, metrics.speed);
        assert.equal(f.cachedInputUsd, tokenRate(m).cacheRead);
        assert.equal(f.plan, modelRequiredPlan(m));
        assert.equal(f.planPrice, displayPrice(PLANS[f.plan].price, "en").monthly);
        // "Measured" may only appear when the benchmark file holds an
        // Artificial Analysis row for this exact model.
        assert.equal(f.measured, BENCHMARKS[id]?.source === "artificial-analysis");
        if (f.openRouter) assert.equal(f.openRouter.slug, BENCHMARKS[id]!.slug);
      }
    }
  });

  it("states every grade as an estimate when no benchmark measured it", () => {
    for (const p of MODEL_PAIRS) {
      const a = modelFacts(p.a);
      const b = modelFacts(p.b);
      const reasoning = findings(p)[1];
      if (!a.measured && !b.measured) assert.match(reasoning.text, /catalog's estimates/);
      if (a.measured !== b.measured) assert.match(reasoning.text, /catalog estimate/);
    }
  });

  it("builds every finding from the two models' own figures", () => {
    for (const p of MODEL_PAIRS) {
      const a = modelFacts(p.a);
      const b = modelFacts(p.b);
      const all = findings(p);
      assert.ok(all.length >= 5);
      const allText = all.map((f) => f.text).join(" ");
      // Every dollar amount in the copy is one of the models' prices or a
      // workload cost computed from them: no figure comes from anywhere else.
      const allowed = new Set(
        [a, b].flatMap((m) => [m.inputUsd, m.outputUsd, m.cachedInputUsd, workloadCostUsd(m, WORKLOADS[p.use]) * 1000].map(usd)),
      );
      for (const amount of allText.match(/\$[0-9]+(?:\.[0-9]+)?/g) ?? []) {
        assert.ok(allowed.has(amount), `${p.slug}: unexplained figure ${amount}`);
      }
      for (const f of all) if (f.favours) assert.ok(f.text.includes(f.favours === "a" ? a.name : b.name), `${p.slug}: ${f.topic}`);
      const v = verdict(p);
      assert.equal(v.a.length, all.filter((f) => f.favours === "a").length);
      assert.equal(v.b.length, all.filter((f) => f.favours === "b").length);
    }
  });

  it("titles, descriptions and related links are complete", () => {
    for (const p of MODEL_PAIRS) {
      const title = pairTitle(p);
      assert.ok(title.includes(modelFacts(p.a).name) && title.includes(modelFacts(p.b).name));
      assert.ok(pairDescription(p).length > 80);
      const related = relatedPairs(p);
      assert.ok(related.length > 0 && related.every((r) => r.slug !== p.slug));
    }
  });
});
