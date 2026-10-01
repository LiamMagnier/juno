import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_MODEL, MODEL_LIST, GEN_MODELS, hasRetired, migrateModelId, resolveModel, RETIRED_MODELS } from "../src/lib/models";
import { providerRequestModel } from "../src/lib/model-request";

const ALL_MODELS = [...MODEL_LIST, ...GEN_MODELS];

test("GPT-6 Astra is selectable with the exact documented API id", () => {
  const astra = MODEL_LIST.find((model) => model.id === "openai:gpt-6-astra");
  assert.ok(astra);
  assert.equal(astra.providerModel, "gpt-6-astra");
  assert.equal(astra.contextWindow, 1_050_000);
  assert.equal(astra.status, "current");
});

test("model catalog fidelity: every displayed model has matching providerModel", () => {
  for (const m of ALL_MODELS) {
    assert.ok(m.id, "Model must have an id");
    assert.ok(m.providerModel, `Model ${m.id} must have a providerModel`);
    assert.ok(m.name, `Model ${m.id} must have a display name`);

    // Provider model must be the suffix of model id for standard models
    const expectedId = `${m.provider}:${m.providerModel}`;
    assert.equal(m.id, expectedId, `Model id ${m.id} should equal ${expectedId}`);

  }
});

test("image catalog includes every active provider image variant", () => {
  const imageIds = new Set(GEN_MODELS.filter((model) => model.modality === "image").map((model) => model.id));
  for (const id of [
    "openai:gpt-image-2",
    "openai:gpt-image-1-mini",
    "openai:gpt-image-1.5",
    "openai:gpt-image-1",
    "google:gemini-3-pro-image",
    "google:gemini-3.1-flash-image",
    "google:gemini-3.1-flash-lite-image",
    "google:gemini-2.5-flash-image",
    "xai:grok-imagine-image-2.0",
    "xai:grok-imagine-image-quality",
    "xai:grok-imagine-image",
    "zhipu:glm-image",
    "minimax:image-01",
    "minimax:image-01-live",
  ]) {
    assert.equal(imageIds.has(id), true, `${id} should be selectable when its provider is configured`);
  }
});

test("displayed catalog entries send the same provider model id", () => {
  for (const model of MODEL_LIST) {
    assert.equal(providerRequestModel(model), model.providerModel, `${model.id} must invoke its displayed providerModel`);
  }
});

test("retired/aliased models migrate to real registered models with matching providerModel", () => {
  for (const [retiredId, targetId] of Object.entries(RETIRED_MODELS)) {
    const resolved = resolveModel(retiredId);
    assert.ok(resolved, `Retired model ${retiredId} should resolve to a valid model`);
    assert.equal(resolved.id, targetId, `Retired model ${retiredId} should resolve to ${targetId}`);
    assert.ok(ALL_MODELS.some((m) => m.id === targetId), `Target model ${targetId} must exist in ALL_MODELS`);
  }
});

/*
 * The September 2026 additions, each pinned to the exact id its provider
 * serves. A wrong id here is a 404 on every message sent with the model, and
 * the picker cannot tell — which is the whole failure mode this file exists
 * to prevent.
 */
test("the September 2026 models carry the ids their providers actually serve", () => {
  const byId = new Map(ALL_MODELS.map((model) => [model.id, model]));

  // DeepSeek points the UNVERSIONED alias at the current Flash generation, the
  // way `deepseek-chat` used to work. `deepseek-v4.1-flash` is the product
  // name, not the id.
  const deepseek = byId.get("deepseek:deepseek-flash");
  assert.ok(deepseek, "DeepSeek V4.1 Flash is in the catalog");
  assert.equal(deepseek.providerModel, "deepseek-flash");
  assert.equal(deepseek.status, "current");
  // V4 Flash used to step down to `legacy` here. The 2026-09-22 catalog sync
  // found DeepSeek no longer serving the versioned id at all and put it in
  // UNAVAILABLE, which prunes the row from the picker — so the assertion that
  // matters now is the pair: gone from the catalog, still resolvable, because
  // conversations pinned to the old id must keep answering.
  assert.equal(byId.get("deepseek:deepseek-v4-flash"), undefined, "V4 Flash is no longer served");
  assert.equal(
    resolveModel("deepseek:deepseek-v4-flash")?.id,
    "deepseek:deepseek-flash",
    "a pruned id still resolves to the live Flash row"
  );

  // Both image variants ship under one version with two names.
  for (const [id, family] of [
    ["openai:gpt-image-2.5-sunburst", "gpt-image"],
    ["openai:gpt-image-2.5-flare", "gpt-image-fast"],
  ] as const) {
    const model = byId.get(id);
    assert.ok(model, `${id} is in the catalog`);
    assert.equal(model.modality, "image");
    assert.equal(model.status, "current");
    assert.equal(model.family, family, "Flare and Sunburst are separate families — both stay current");
  }
  assert.equal(byId.get("openai:gpt-image-2")?.status, "legacy");

  // xAI's volume tier: the widest context window in the catalog.
  const fast = byId.get("xai:grok-4.1-fast");
  assert.ok(fast, "Grok 4.1 Fast is in the catalog");
  assert.equal(fast.contextWindow, 2_000_000);
  assert.equal(fast.reasoning, true, "reasoning is a switch on this model, not absent");

  // Google's Lite line moved on a generation.
  const lite = byId.get("google:gemini-3.5-flash-lite");
  assert.ok(lite, "Gemini 3.5 Flash-Lite is in the catalog");
  assert.equal(lite.contextWindow, 1_048_576);
  assert.equal(byId.get("google:gemini-3.1-flash-lite")?.status, "legacy");

  // And the one retirement: Google deprecated this endpoint on 30 Sep 2026.
  // Before that date it is listed as deprecated; from 1 Oct it leaves the
  // catalog and stored ids migrate to its replacement.
  const omni = byId.get("google:gemini-omni-flash-preview");
  if (hasRetired({ retiresOn: "2026-09-30" })) {
    assert.equal(omni, undefined, "a retired model is no longer offered");
    assert.equal(migrateModelId("google:gemini-omni-flash-preview"), "google:veo-3.1-fast-generate-preview");
  } else {
    assert.ok(omni);
    assert.equal(omni.status, "deprecated");
    assert.equal(omni.retiresOn, "2026-09-30");
    assert.ok(omni.replacedBy, "a retirement without a replacement is how a stored id becomes a 404");
  }
});

/*
 * The second audit pass — the seven labs the first one did not reach.
 *
 * Same contract as the test above: a wrong id is a 404 on every message and
 * the picker cannot tell.
 */
test("the remaining seven labs carry their current ids", () => {
  const byId = new Map(ALL_MODELS.map((model) => [model.id, model]));

  // Qwen's volume tier. Lowercase with the period — `Qwen3.8-Flash` and
  // `qwen-3.8-flash` both 404.
  const qwenFlash = byId.get("qwen:qwen3.8-flash");
  assert.ok(qwenFlash, "Qwen3.8 Flash is in the catalog");
  assert.equal(qwenFlash.providerModel, "qwen3.8-flash");
  assert.equal(byId.get("qwen:qwen3.6-flash")?.status, "legacy");

  // GLM-5.3's API opened, so the gate came off and it rejoined `glm` ahead of
  // 5.2 — which is what the `comingSoon` dance existed to allow. The inverse
  // of the assertion this used to make: it must now be routable, and it must
  // be in the SAME family as 5.2, because the newest current row per family is
  // what the pickers show and the newest one answers.
  const glm53 = byId.get("zhipu:glm-5.3");
  assert.ok(glm53, "GLM-5.3 is in the catalog");
  assert.notEqual(glm53.comingSoon, true, "Z.ai serves it on the General API now");
  assert.equal(glm53.family, byId.get("zhipu:glm-5.2")?.family, "it leads the glm family now");
  // 5.2 stepped down when 5.3 joined its family — one CURRENT row per family is
  // what `validate:models` enforces, and a `legacy` row is still selectable
  // under "Past models" and still routable. It is hidden, not retired.
  assert.equal(byId.get("zhipu:glm-5.2")?.status, "legacy", "5.2 stepped down for 5.3");

  // MiMo V2.6, released 22 Sept 2026 — three models, and UltraSpeed is the one
  // with a trap in it: its id ends in `-ultraspeed` but CONTAINS `pro`, so a
  // pricing branch tested in the wrong order bills it at a third of its rate.
  for (const [id, family] of [
    ["mimo:mimo-v2.6-pro", "mimo"],
    ["mimo:mimo-v2.6-flash", "mimo-flash"],
    ["mimo:mimo-v2.6-pro-ultraspeed", "mimo-ultraspeed"],
  ] as const) {
    const model = byId.get(id);
    assert.ok(model, `${id} is in the catalog`);
    assert.equal(model.status, "current", `${id} is served`);
    assert.notEqual(model.comingSoon, true, `${id} is routable`);
    assert.equal(model.family, family, `${id} sits in ${family}`);
    assert.ok(model.reasoning, `${id} is a reasoning model`);
    assert.ok(model.vision, `${id} takes the full modality set`);
  }
  // The generation it replaces is hidden but still answers.
  assert.equal(byId.get("mimo:mimo-v2.5-pro")?.status, "legacy", "V2.5 Pro stepped down");
  assert.equal(byId.get("mimo:mimo-v2-flash")?.status, "legacy", "V2 Flash stepped down");

  // Delisted in the September 2026 price card.
  for (const id of ["zhipu:glm-5-turbo", "zhipu:glm-5v-turbo"]) {
    const model = byId.get(id);
    assert.ok(model, `${id} is in the catalog`);
    assert.equal(model.status, "deprecated", `${id} was delisted`);
    assert.ok(model.replacedBy, `${id} needs somewhere for stored ids to go`);
  }

  // Xiaomi's omnimodal pair, and the window the Pro row had four times too small.
  assert.ok(byId.get("mimo:mimo-v2.5"), "MiMo V2.5 is in the catalog");
  assert.equal(byId.get("mimo:mimo-v2.5")?.contextWindow, 1_050_000);
  assert.equal(byId.get("mimo:mimo-v2.5-pro")?.contextWindow, 1_050_000);

  // Meta and ByteDance moved a generation.
  assert.ok(byId.get("meta:muse-spark-1.3"), "Muse Spark 1.3 is in the catalog");
  assert.equal(byId.get("meta:muse-spark-1.2")?.status, "legacy");
  assert.ok(byId.get("seedance:dreamina-seedance-2-5-260628"), "Seedance 2.5 is in the catalog");
  assert.equal(byId.get("seedance:dreamina-seedance-2-0-260128")?.status, "legacy");

  // The app default must still land on something callable.
  const fallback = resolveModel(DEFAULT_MODEL);
  assert.ok(fallback, "DEFAULT_MODEL resolves");
  assert.equal(fallback.status, "current", "the default model is routable");
});

/*
 * Meta's Muse line, where the trap is not the version number but the TIER.
 *
 * Meta serves 1.3 under two ids for one set of weights. `muse-spark-1.3` is the
 * standard tier; `muse-spark-1.3-contributor` is the same model at 12.5x less
 * on input and 21x less on output, and the discount is paid for by letting
 * Meta train on the prompts and completions sent to it. Every mistake this
 * block guards against is a tier confusion rather than a 404:
 *
 *   - a contributor id migrating to the standard one is a silent 12.5x/21x
 *     price rise charged to somebody who chose the cheap tier deliberately;
 *   - anything migrating the other way opts a reader into training through a
 *     rename they never agreed to;
 *   - and `muse-image-1` — how the launch posts write it — is not an id Meta
 *     serves at all. `resolveModel` invents a *chat* model for an id it does
 *     not recognise, so that one does not 404 loudly: it sends an image prompt
 *     to /chat/completions as text.
 */
test("Meta's Muse line carries its real ids, and each tier stays in its own tier", () => {
  const byId = new Map(ALL_MODELS.map((model) => [model.id, model]));

  const standard = byId.get("meta:muse-spark-1.3");
  assert.ok(standard, "Muse Spark 1.3 is in the catalog");
  assert.equal(standard.providerModel, "muse-spark-1.3");
  assert.equal(standard.status, "current");
  assert.equal(standard.contextWindow, 1_048_576);
  assert.notEqual(standard.trainsOnPrompts, true, "the standard tier keeps your prompts out of training");

  const contributor = byId.get("meta:muse-spark-1.3-contributor");
  assert.ok(contributor, "Muse Spark 1.3 Contributor is in the catalog");
  assert.equal(contributor.providerModel, "muse-spark-1.3-contributor");
  assert.equal(contributor.status, "current");
  assert.equal(contributor.trainsOnPrompts, true, "the discount is paid for with the reader's prompts");
  assert.notEqual(
    contributor.family,
    standard.family,
    "one current row per family is enforced — sharing a family would hide one of the two tiers"
  );

  // The generation it replaces is hidden but still answers.
  assert.equal(byId.get("meta:muse-spark-1.2")?.status, "legacy", "1.2 stepped down for 1.3");

  // Muse Image ships as `muse-image-1.0`. The shorthands are aliases, not ids.
  const image = byId.get("meta:muse-image-1.0");
  assert.ok(image, "Muse Image is in the catalog");
  assert.equal(image.providerModel, "muse-image-1.0");
  assert.equal(image.modality, "image");
  assert.equal(image.status, "current");
  for (const alias of ["meta:muse-image", "meta:muse-image-1"]) {
    const resolved = resolveModel(alias);
    assert.equal(resolved?.id, "meta:muse-image-1.0", `${alias} must route to the id Meta actually serves`);
    assert.equal(resolved?.modality, "image", `${alias} must not resolve to a guessed chat model`);
  }

  // The tiers never cross, in either direction.
  for (const alias of [
    "meta:muse-spark-contributor",
    "meta:muse-spark-1.2-contributor",
    "meta:muse-spark-1.1-contributor",
  ]) {
    assert.equal(
      resolveModel(alias)?.id,
      "meta:muse-spark-1.3-contributor",
      `${alias} must stay on the contributor ladder — crossing to standard is a 12.5x/21x price rise`
    );
  }
  for (const alias of ["meta:muse-spark", "meta:muse-spark-1.1", "meta:muse-max", "meta:muse-flash"]) {
    assert.equal(resolveModel(alias)?.id, "meta:muse-spark-1.3", `${alias} must route to the standard tier`);
  }
  for (const [dead, target] of Object.entries(RETIRED_MODELS)) {
    assert.equal(
      dead.includes("contributor"),
      target.includes("contributor"),
      `${dead} -> ${target} crosses the contributor boundary — a tier is not a generation`
    );
  }
});

test("Muse Image is metered at Meta's per-image rate, not the catalog default", () => {
  /*
   * `mediaRequestCost` is the only thing that charges for an image generation —
   * image providers report no token usage, so the per-request figure IS the
   * bill. Meta publishes $0.01 per returned image, flat: the same whatever
   * `reasoning_strength` ran at, and with its built-in web and image search
   * included rather than billed on top. Without a row of its own Muse Image
   * fell through to the $0.03 default and every generation was metered at 3x.
   *
   * Read from source rather than imported: `spend.ts` opens with `server-only`
   * and pulls in Prisma, so it is not loadable under the plain test condition —
   * the same reason `usage-windows.test.ts` reads this file as text.
   */
  const spend = readFileSync(new URL("../src/lib/spend.ts", import.meta.url), "utf8");
  const body = spend.slice(spend.indexOf("export function mediaRequestCost"));
  const museImage = body.indexOf('id.includes("muse-image")');
  assert.notEqual(museImage, -1, "mediaRequestCost must price Muse Image explicitly");
  assert.match(body.slice(museImage, museImage + 80), /return 10_000;/, "Muse Image is $0.01 an image");
  assert.ok(
    museImage < body.indexOf("return 30_000;"),
    "the Muse Image branch must come before the default, or it never runs"
  );
});
