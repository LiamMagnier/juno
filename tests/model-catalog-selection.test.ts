import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { latestPerFamily, withSupersededMarked } from "../src/lib/model-metrics";
import { hasRetired, isSupersededModel, migrateModelId, MODEL_LIST, MODELS, resolveModel, type ModelInfo } from "../src/lib/models";

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

  it("lets a newer model replace an older one of its family that still says current", () => {
    // Both are `current` — only the family collapse can tell that 3.8 Flash
    // is the same product line as 3.5.
    const newer = model({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "google", family: "flash", released: "2026-09" });
    const kept = latestPerFamily([
      model({ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", provider: "google", family: "flash", released: "2026-06" }),
      newer,
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

  it("keeps the curated entry over an uncurated id for the same model", () => {
    // `mistral-medium-2604` IS `mistral-medium-latest`. The curated row is the
    // one with a verified name, release date and price, so it has to win.
    const snapshot = model({ id: "mistral-medium-2604", name: "Mistral Medium", provider: "mistral", family: "medium", minPlan: "PRO", vision: true });
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

describe("provider health", () => {
  it("never filters the catalog", () => {
    // The original bug, guarded at the only place it can come back.
    //
    // This reads source text rather than calling the function, which is not how
    // a test should normally work — but src/lib/model-catalog-api.ts pulls in
    // `server-only` and cannot be imported by the test runner directly, and
    // the alternative is what the repo had before: nothing.
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

  it("demotes a model a newer one of its family has overtaken", () => {
    // Both say `current`; only the family comparison can tell that 3.8 Flash
    // replaced 3.5. The loser must come back marked, not missing — it is
    // still callable.
    const marked = withSupersededMarked([
      model({ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", provider: "google", family: "flash", released: "2026-06" }),
      model({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "google", family: "flash", released: "2026-09" }),
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
    // resolving to a model the provider no longer answers on. models:sync moves
    // expired rows into RETIRED_MODELS, so today there may be none left to
    // test against: the clock is moved past the last scheduled retirement in a
    // child process instead (tests/model-retirement-clock.test.ts does the
    // same for the pinned suites).
    const retiring = Object.values(MODELS).filter((m) => m.retiresOn && m.replacedBy);
    if (!retiring.length) return;
    const last = retiring.map((m) => m.retiresOn!).sort().pop()!;
    const after = new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const out = execFileSync(
      "npx",
      ["tsx", "-e", `import { MODEL_LIST, migrateModelId, resolveModel } from "./src/lib/models"; const ids = ${JSON.stringify(retiring.map((m) => m.id))}; console.log(JSON.stringify(ids.map((id) => [id, MODEL_LIST.some((m) => m.id === id), migrateModelId(id), resolveModel(id)?.id])));`],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, JUNO_CATALOG_TODAY: after } }
    );
    for (const [id, listed, migrated, resolved] of JSON.parse(out) as [string, boolean, string, string][]) {
      const heir = MODELS[id].replacedBy;
      assert.equal(listed, false, `${id} is still listed on ${after}`);
      assert.equal(migrated, heir, `${id} migrates to ${heir} on ${after}`);
      assert.equal(resolved, heir, `${id} resolves to ${heir} on ${after}`);
    }
  });
});
