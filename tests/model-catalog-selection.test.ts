import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { latestPerFamily } from "../src/lib/model-metrics";
import { MODEL_LIST, MODELS, type ModelInfo } from "../src/lib/models";
import { curate, FAMILIES, toModelInfo, versionScore } from "../src/lib/model-discovery-core";
import { type Provider } from "../src/lib/providers";

/**
 * What a model picker is allowed to show: every configured lab, one entry per
 * product line, newest first.
 *
 * The regression these guard is a catalog that shrinks silently. Two ways it
 * happened: a provider whose account ran out of credit had ALL of its models
 * removed server-side (so Claude simply ceased to exist in every client at
 * once), and every generation a lab still serves was listed at full length, so
 * the fix for one made the other worse.
 */

function model(overrides: Partial<ModelInfo> & { id: string; name: string }): ModelInfo {
  return {
    provider: "openai",
    providerModel: overrides.id,
    minPlan: "FREE",
    vision: false,
    reasoning: false,
    cost: 2,
    modality: "chat",
    webSearch: false,
    status: "current",
    ...overrides,
    id: `${overrides.provider ?? "openai"}:${overrides.id}`,
  };
}

const names = (list: ModelInfo[]) => list.map((m) => m.name);

describe("latestPerFamily", () => {
  it("keeps one model per family and drops the superseded generations", () => {
    const kept = latestPerFamily([
      model({ id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic", family: "opus", released: "2026-07" }),
      model({ id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", family: "opus", status: "legacy", legacy: true, released: "2026-04" }),
      model({ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic", family: "opus", status: "deprecated", legacy: true, released: "2025-11" }),
      model({ id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic", family: "sonnet", released: "2026-05" }),
      model({ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", family: "haiku", released: "2025-10" }),
    ]);
    assert.deepEqual(names(kept), ["Claude Opus 5", "Claude Sonnet 5", "Claude Haiku 4.5"]);
  });

  it("lets a freshly discovered model replace the curated one it supersedes", () => {
    // Both are `current` — only the family collapse can tell that the live
    // 3.6 Flash is the same product line as the curated 3.5.
    const discovered = toModelInfo("google", "models/gemini-3.6-flash", {
      label: "Gemini Flash", family: "flash", match: /flash/i, minPlan: "FREE", vision: true,
    });
    const kept = latestPerFamily([
      model({ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", provider: "google", family: "flash", released: "2026-06" }),
      discovered,
    ]);
    assert.deepEqual(names(kept), ["Gemini 3.6 Flash"]);
  });

  it("drops a superseded model even when nothing replaces it", () => {
    // The family's ONLY member is legacy. Without the superseded filter the
    // family collapse alone would happily keep it — it is the newest of one.
    assert.deepEqual(latestPerFamily([
      model({ id: "gpt-4o", name: "GPT-4o", family: "gpt-4o", status: "deprecated", legacy: true, released: "2024-05" }),
      model({ id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", family: "gpt-3.5", status: "legacy", legacy: true, released: "2023-03" }),
    ]), []);
  });

  it("keeps the curated entry when discovery only found another id for it", () => {
    // `mistral-medium-2604` IS `mistral-medium-latest`. The curated row is the
    // one with a verified name, release date and price, so it has to win — the
    // discovered name is just prettifyModelName over an id.
    const snapshot = toModelInfo("mistral", "mistral-medium-2604", {
      label: "Mistral Medium", family: "medium", match: /^mistral-medium/i, minPlan: "PRO", vision: true,
    });
    const curated = MODELS["mistral:mistral-medium-latest"];
    assert.ok(curated, "fixture requires the curated Mistral Medium entry");
    assert.deepEqual(names(latestPerFamily([snapshot, curated])), [curated.name]);
    // Order of arguments must not decide it.
    assert.deepEqual(names(latestPerFamily([curated, snapshot])), [curated.name]);
    // …and it must be the CURATED rule doing the work, not the release date:
    // strip the date and the curated entry still has to win, or the preference
    // is only ever exercised through a field discovery happens not to set.
    const undated = { ...curated, released: undefined };
    assert.deepEqual(names(latestPerFamily([snapshot, undated])), [curated.name]);
    assert.deepEqual(names(latestPerFamily([undated, snapshot])), [curated.name]);
  });

  it("never merges two models on a missing family", () => {
    const kept = latestPerFamily([
      model({ id: "a", name: "Model A", provider: "meta" }),
      model({ id: "b", name: "Model B", provider: "meta" }),
    ]);
    assert.equal(kept.length, 2);
  });

  it("keeps chat, image and video siblings of one family apart", () => {
    const kept = latestPerFamily([
      model({ id: "grok-4.5", name: "Grok 4.5", provider: "xai", family: "grok" }),
      model({ id: "grok-imagine-image", name: "Grok Imagine", provider: "xai", family: "grok", modality: "image" }),
    ]);
    assert.equal(kept.length, 2);
  });

  it("leaves every lab in the catalog represented", () => {
    // The catalog may only lose *models*, never a whole lab: a lab that
    // disappears reads as a broken app, and there is nothing in the UI that
    // brings it back.
    const before = new Set(MODEL_LIST.map((m) => m.provider));
    const after = new Set(latestPerFamily(MODEL_LIST).map((m) => m.provider));
    assert.deepEqual([...before].filter((p) => !after.has(p)), []);
  });

  it("is idempotent", () => {
    const once = latestPerFamily(MODEL_LIST);
    assert.deepEqual(names(latestPerFamily(once)), names(once));
  });

  it("offers exactly one current model per curated family", () => {
    const seen = new Map<string, string>();
    for (const m of latestPerFamily(MODEL_LIST)) {
      if (!m.family) continue;
      const key = `${m.provider}|${m.modality}|${m.family}`;
      assert.equal(seen.get(key), undefined, `${key}: both ${seen.get(key)} and ${m.name}`);
      seen.set(key, m.name);
    }
  });
});

describe("versionScore", () => {
  it("reads a release stamp as a date, not as a version number", () => {
    // The bug: "2604" parsed as version 2604, so a dated snapshot outranked
    // every real version of the same model.
    assert.ok(versionScore("mistral-medium-3.5") > versionScore("mistral-medium-2604"));
    assert.ok(versionScore("claude-haiku-4-5") > versionScore("claude-haiku-4-5-20251001"));
    assert.ok(versionScore("gpt-5.6-sol") > versionScore("gpt-5.4-2026-03-05"));
  });

  it("strips a whole ISO date, not just its year", () => {
    // Leaving `-MM-DD` behind made the MONTH the version: qwen-plus-2025-04-28
    // scored 4.0 and outranked every real Qwen Plus, which is the bug the stamp
    // handling exists to prevent, reintroduced one alternation apart.
    assert.ok(versionScore("qwen3.9-plus") > versionScore("qwen-plus-2025-04-28"));
    assert.ok(versionScore("codestral-latest") > versionScore("codestral-2026-01-15"));
    assert.ok(versionScore("qwen-max") > versionScore("qwen-max-2025-01-25"));
  });

  it("prefers a canonical alias to a dated snapshot of the same version", () => {
    assert.ok(versionScore("ministral-14b-latest") > versionScore("ministral-14b-2512"));
  });

  it("still ranks a higher version first", () => {
    assert.ok(versionScore("glm-5.2") > versionScore("glm-4.7"));
    assert.ok(versionScore("qwen3.8-max-preview") > versionScore("qwen3.7-max"));
    // A version that PRECEDES the stamp must survive the strip untouched.
    assert.ok(versionScore("gpt-5.6-sol") > versionScore("gpt-5.4-2026-03-05"));
    assert.equal(versionScore("glm-4-32b-0414-128k"), versionScore("glm-4-32b-2512"));
  });
});

describe("discovery families", () => {
  it("lands next year's model in this year's family", () => {
    // The whole mechanism in one assertion: a version nobody has curated yet
    // shows up on a provider's live API, and it has to be recognised as the
    // same product line as the model it replaces. If the rule's slug drifts
    // from the registry's, the collapse cannot see they are the same line and
    // the picker shows both — which is the duplicate this exists to prevent.
    const cases: [Provider, string, string][] = [
      ["anthropic", "claude-opus-6", "anthropic:claude-opus-5"],
      ["anthropic", "claude-haiku-5", "anthropic:claude-haiku-4-5"],
      ["openai", "gpt-5.7-sol", "openai:gpt-5.6-sol"],
      ["openai", "gpt-5.7-luna", "openai:gpt-5.6-luna"],
      ["openai", "gpt-6-codex", "openai:gpt-5.3-codex"],
      ["google", "models/gemini-3.7-flash", "google:gemini-3.5-flash"],
      ["zhipu", "glm-6", "zhipu:glm-5.2"],
      ["moonshot", "kimi-k4", "moonshot:kimi-k3"],
      ["mistral", "mistral-medium-4", "mistral:mistral-medium-latest"],
      ["xai", "grok-5", "xai:grok-4.5"],
      ["deepseek", "deepseek-v5-pro", "deepseek:deepseek-v4-pro"],
      ["minimax", "MiniMax-M4", "minimax:MiniMax-M3"],
      ["qwen", "qwen3.9-plus", "qwen:qwen3.7-plus"],
      ["longcat", "LongCat-3.0", "longcat:LongCat-2.0"],
    ];
    for (const [provider, futureId, supersededId] of cases) {
      const superseded = MODELS[supersededId];
      assert.ok(superseded?.family, `fixture requires ${supersededId}`);
      const [discovered] = curate(provider, [futureId]);
      assert.ok(discovered, `${provider}: no discovery rule matched ${futureId}`);
      assert.equal(discovered.family, superseded.family, `${futureId} must join ${supersededId}'s family`);
      // …and then win it, which is the point of recognising the line at all.
      assert.deepEqual(names(latestPerFamily([superseded, discovered])), [discovered.name]);
    }
  });

  it("gives every discovered model its rule's family", () => {
    const [rule] = FAMILIES.zhipu ?? [];
    assert.ok(rule, "fixture requires zhipu discovery rules");
    assert.equal(toModelInfo("zhipu", "glm-6v-flashx", rule).family, rule.family);
  });

  it("marks a discovered OpenAI Codex or Pro model as Responses-only", () => {
    // These lines are a hard 400 on /chat/completions. A discovered successor
    // WINS its family, so getting this wrong replaces a working GPT-5.3 Codex
    // with one that cannot answer at all.
    const codexRule = { label: "GPT Codex", family: "gpt-codex", match: /codex/i, minPlan: "PRO" as const, vision: true };
    assert.equal(toModelInfo("openai", "gpt-6-codex", codexRule).api, "responses");
    assert.equal(toModelInfo("openai", "gpt-6-pro", codexRule).api, "responses");
    assert.equal(toModelInfo("openai", "gpt-6-sol", codexRule).api, undefined);
    // Only OpenAI: every other lab's "pro" tier speaks Chat Completions.
    assert.equal(toModelInfo("deepseek", "deepseek-v5-pro", codexRule).api, undefined);
  });

  it("does not strand a next-generation model without reasoning", () => {
    // The guess regexes used to key on the literal `gpt-5`, so the first GPT-6
    // would have shipped into every picker with the thinking control missing.
    const rule = { label: "GPT Sol", family: "gpt", match: /sol/i, minPlan: "PRO" as const, vision: true };
    assert.equal(toModelInfo("openai", "gpt-6-sol", rule).reasoning, true);
    assert.equal(toModelInfo("xai", "grok-5", rule).reasoning, true);
    assert.equal(toModelInfo("moonshot", "kimi-k4", rule).reasoning, true);
  });

  it("prefers the curated family when the registry already knows the id", () => {
    const curated = MODELS["zhipu:glm-5.2"];
    assert.ok(curated?.family, "fixture requires the curated GLM-5.2 entry");
    const wrongRule = { label: "GLM Flash", family: "glm-flash", match: /glm/i, minPlan: "FREE" as const, vision: false };
    assert.equal(toModelInfo("zhipu", "glm-5.2", wrongRule).family, curated.family);
  });
});

describe("provider health", () => {
  it("never filters the catalog", () => {
    // The original bug, guarded at the only place it can come back.
    //
    // This reads source text rather than calling the function, which is not how
    // a test should normally work — but src/lib/model-catalog-api.ts pulls in
    // `server-only` through model-discovery and cannot be imported by the test
    // runner at all, and the alternative is what the repo had before: nothing.
    // A single `.filter(providerHealthy)` in this function deletes every model
    // of every lab whose API account is out of credit, from the website, iOS
    // and macOS simultaneously, and no other test in the suite notices.
    const source = readFileSync(new URL("../src/lib/model-catalog-api.ts", import.meta.url), "utf8");
    const start = source.indexOf("export async function loadAvailableModels");
    assert.ok(start > 0, "loadAvailableModels must exist in model-catalog-api.ts");
    const body = source.slice(start, source.indexOf("\n}", start));
    const active = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    assert.ok(
      !/providerHealthy/.test(active),
      "loadAvailableModels must not gate the catalog on provider health — report it, reroute on it, but never hide a lab"
    );
  });

  it("still tells the cloud runner which labs are answering", () => {
    // The other half: health stopped being a filter, so it has to be a value on
    // the runner catalog, which picks a provider with no user present to warn.
    const source = readFileSync(new URL("../src/lib/model-catalog-api.ts", import.meta.url), "utf8");
    const start = source.indexOf("export function backendAgentCatalog");
    assert.ok(start > 0, "backendAgentCatalog must exist in model-catalog-api.ts");
    const body = source.slice(start);
    assert.match(body, /available:\s*providerHealthy\(model\.provider\)/);
  });
});
