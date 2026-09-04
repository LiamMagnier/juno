import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { latestPerFamily, withSupersededMarked } from "../src/lib/model-metrics";
import { hasRetired, isSupersededModel, migrateModelId, MODEL_LIST, MODELS, resolveModel, type ModelInfo } from "../src/lib/models";
import { curate, FAMILIES, toModelInfo, versionScore } from "../src/lib/model-discovery-core";
import { type Provider } from "../src/lib/providers";

/**
 * What a model picker shows: every configured lab, every model still being
 * served, the newest of each product line first and the older generations
 * marked so the UI can file them under "Past models".
 *
 * The regression these guard is a catalog that shrinks silently, which happened
 * twice for different reasons: a lab whose API account ran out of credit had
 * ALL of its models deleted server-side, and then the fix for the resulting
 * five-generations-of-Opus picker deleted the old generations instead of
 * grouping them. Only one thing may actually remove a model now — the provider
 * switching it off, on a date the registry states in advance.
 */

function model(overrides: Partial<ModelInfo> & { id: string; name: string }): ModelInfo {
  return {
    provider: "openai",
    providerModel: overrides.id,
    minPlan: "FREE",
    vision: false,
    reasoning: false,
    agenticTools: true,
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
    const discovered = toModelInfo("google", "models/gemini-3.8-flash", {
      label: "Gemini Flash", family: "flash", match: /flash/i, minPlan: "FREE", vision: true,
    });
    const kept = latestPerFamily([
      model({ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", provider: "google", family: "flash", released: "2026-06" }),
      discovered,
    ]);
    assert.deepEqual(names(kept), ["Gemini 3.8 Flash"]);
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
      ["openai", "gpt-7-nebula", "openai:gpt-6-astra"],
      ["openai", "gpt-6-codex", "openai:gpt-5.3-codex"],
      ["google", "models/gemini-3.8-flash", "google:gemini-3.7-flash"],
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
    assert.equal(toModelInfo("openai", "gpt-7-nebula", rule).reasoning, true);
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

describe("withSupersededMarked", () => {
  const line = [
    model({ id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic", family: "opus", released: "2026-07" }),
    model({ id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic", family: "opus", status: "legacy", legacy: true, released: "2026-04" }),
    model({ id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic", family: "opus", status: "deprecated", legacy: true, released: "2025-11" }),
  ];

  it("keeps every model a provider still serves", () => {
    // The whole point of the rework: an older generation is filed away, never
    // withheld. Withholding is what made a lab look like it had ceased to exist.
    assert.deepEqual(
      names(withSupersededMarked(line)).sort(),
      ["Claude Opus 4.5", "Claude Opus 4.8", "Claude Opus 5"]
    );
  });

  it("marks everything that is not the newest of its line", () => {
    const marked = withSupersededMarked(line);
    const past = marked.filter(isSupersededModel).map((m) => m.name);
    assert.deepEqual(names(marked.filter((m) => !isSupersededModel(m))), ["Claude Opus 5"]);
    assert.deepEqual(past.sort(), ["Claude Opus 4.5", "Claude Opus 4.8"]);
  });

  it("demotes a curated model a discovered one has overtaken", () => {
    // Both say `current`; only the family comparison can tell that the live
    // 3.6 Flash replaced the curated 3.5. The loser must come back marked, not
    // missing — it is still callable.
    const discovered = toModelInfo("google", "models/gemini-3.8-flash", {
      label: "Gemini Flash", family: "flash", match: /flash/i, minPlan: "FREE", vision: true,
    });
    const marked = withSupersededMarked([
      model({ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", provider: "google", family: "flash", released: "2026-06" }),
      discovered,
    ]);
    assert.equal(marked.length, 2);
    assert.deepEqual(names(marked.filter((m) => !isSupersededModel(m))), ["Gemini 3.8 Flash"]);
    const demoted = marked.find((m) => m.name === "Gemini 3.5 Flash");
    assert.equal(demoted?.legacy, true);
    // `status` moves with `legacy` — the native manifest reads status for its
    // `lifecycle`, so leaving it "current" files a model under "Older models"
    // while still calling it current.
    assert.equal(demoted?.status, "legacy");
  });

  it("puts the current models first", () => {
    assert.equal(withSupersededMarked(line)[0].name, "Claude Opus 5");
  });

  it("removes a model whose retirement date has passed", () => {
    const past = [
      model({ id: "gpt-4o", name: "GPT-4o", provider: "openai", family: "gpt-4o", status: "deprecated", legacy: true, retiresOn: "2026-10-23" }),
      model({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai", family: "gpt" }),
    ];
    // The day before, and on the day itself, it is still selectable…
    assert.equal(withSupersededMarked(past, "2026-10-22").length, 2);
    assert.equal(withSupersededMarked(past, "2026-10-23").length, 2);
    // …and the morning after, it is gone.
    assert.deepEqual(names(withSupersededMarked(past, "2026-10-24")), ["GPT-5.6 Sol"]);
  });

  it("leaves a model with no retirement date alone forever", () => {
    const undated = [model({ id: "glm-5.2", name: "GLM-5.2", provider: "zhipu", family: "glm" })];
    assert.equal(withSupersededMarked(undated, "2099-01-01").length, 1);
  });
});

describe("retirement dates in the registry", () => {
  it("gives every retiring model a date and somewhere to go", () => {
    for (const m of MODEL_LIST) {
      if (!m.retiresOn) continue;
      assert.match(m.retiresOn, /^\d{4}-\d{2}-\d{2}$/, `${m.id}: retiresOn must be YYYY-MM-DD`);
      assert.ok(m.replacedBy, `${m.id}: retiring with no replacedBy`);
      const heir = MODELS[m.replacedBy!];
      assert.ok(heir, `${m.id}: replacedBy ${m.replacedBy} is not registered`);
      assert.equal(heir.status, "current", `${m.id}: replacedBy ${m.replacedBy} is not current`);
    }
  });

  it("agrees with the sentence it also states in prose", () => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    for (const m of MODEL_LIST) {
      const spelled = m.deprecationNote?.match(/^Retires (\w{3}) (\d{1,2}), (\d{4})/);
      if (!spelled) continue;
      const iso = `${spelled[3]}-${String(months.indexOf(spelled[1]) + 1).padStart(2, "0")}-${spelled[2].padStart(2, "0")}`;
      assert.equal(m.retiresOn, iso, `${m.id}: note and retiresOn disagree`);
    }
  });

  it("never offers a model whose date has already passed", () => {
    for (const m of MODEL_LIST) {
      assert.equal(hasRetired(m), false, `${m.id} retired on ${m.retiresOn} and is still listed`);
    }
  });

  it("migrates a stored id off a model that has retired", () => {
    // A date passing has to behave like a RETIRED_MODELS entry, or the id keeps
    // resolving to a model the provider no longer answers on.
    const expired = Object.values(MODELS).find((m) => hasRetired(m) && m.replacedBy);
    assert.ok(expired, "fixture requires at least one already-expired registry entry");
    assert.equal(migrateModelId(expired.id), expired.replacedBy);
    assert.equal(resolveModel(expired.id)?.id, expired.replacedBy);
  });
});
