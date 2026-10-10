import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProviderInstance } from "@/lib/code-v2/contracts";
import { codeProviderModels } from "@/lib/code-v2/code-models";
import {
  CONNECT_SUBSCRIPTION,
  cycleTab,
  defaultTab,
  labGroups,
  labOfModelId,
  labTiles,
  pickerRowLine,
  pickerTabs,
  searchCatalogue,
  sortForPicker,
  subscriptionGroups,
  tabKey,
} from "@/lib/code-v2/picker-catalogue";
import {
  GENERATION_KINDS,
  GENERATION_MODELS_COPY,
  defaultGenerationModel,
  generationModelOptions,
  generationOptionLabel,
  parseGenerationChoice,
  resolveGenerationModel,
} from "@/lib/code-v2/generation-models";
import { DEFAULT_AUDIO_MODEL, MODELS, hasRetired, type ModelInfo } from "@/lib/models";
import { PROVIDER_LIST } from "@/lib/providers";
import { INSTANCES } from "../src/app/dev/code-v2/fixtures";

const alevr = INSTANCES.find((i) => i.id === "alevr")!;
const imageModel = Object.values(MODELS).find((m) => m.modality === "image" && m.status === "current")!;

test("rail: one tile per lab with a text model, in PROVIDER_LIST order, then Subscriptions", () => {
  const tiles = labTiles(INSTANCES);
  assert.ok(tiles.length > 3);
  const order = tiles.map((t) => PROVIDER_LIST.indexOf(t.lab as never));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(tiles[0].name, "Anthropic");
  assert.ok(!tiles.some((t) => t.lab === "seedance"), "a lab with only video models has no tile");
  const tabs = pickerTabs(INSTANCES);
  assert.equal(tabKey(tabs[tabs.length - 1]), "subscriptions");
  assert.equal(tabKey(cycleTab(INSTANCES, tabs[tabs.length - 1], 1)), tabKey(tabs[0]));
});

test("a lab lists Alevr, then your key; newest generation first; rows carry their source line", () => {
  const groups = labGroups(INSTANCES, "anthropic");
  assert.deepEqual(groups.map((g) => g.title), ["Alevr", "Your Anthropic key"]);
  const names = groups[0].rows.map((r) => r.model.label);
  // Haiku 5.5 replaced 4.5 as the current Haiku on 2026-10-07 (models:sync).
  assert.ok(names.indexOf("Claude Opus 5.5") >= 0 && names.indexOf("Claude Opus 5.5") < names.indexOf("Claude Haiku 5.5"));
  assert.match(groups[0].rows[0].line, /^\$[\d.]+ \/ \$[\d.]+ · \d+[KM]$/);
  assert.match(groups[1].rows[0].line, /^Your key · \d+[KM]$/);
  // A lab without the user's key has only the Alevr group.
  assert.deepEqual(labGroups(INSTANCES, "openai").map((g) => g.title), ["Alevr"]);
});

test("only models that write code: image, video and audio models never appear", () => {
  const withMedia: ProviderInstance[] = INSTANCES.map((i) =>
    i.kind === "alevr" || i.kind === "byok" ? { ...i, models: [...(i.models ?? []), { id: imageModel.id, label: imageModel.name }] } : i,
  );
  for (const tile of labTiles(withMedia))
    for (const g of labGroups(withMedia, tile.lab)) for (const r of g.rows) assert.notEqual(r.model.id, imageModel.id);
  assert.equal(searchCatalogue(withMedia, imageModel.name).length, 0);
});

test("a key with no models of its own offers the Alevr models of its lab", () => {
  const instances: ProviderInstance[] = [alevr, { id: "byok:openai", kind: "byok", label: "openai key", status: "ready", models: [] }];
  const g = labGroups(instances, "openai");
  assert.deepEqual(g.map((x) => x.title), ["Alevr", "Your OpenAI key"]);
  assert.equal(g[1].rows.length, g[0].rows.length);
  assert.ok(g[1].rows.every((r) => r.instance.id === "byok:openai"));
});

test("OpenRouter gets its own tile only when it reports models", () => {
  const loading: ProviderInstance = { id: "byok:openrouter", kind: "byok", label: "openrouter key", status: "ready", models: [] };
  assert.ok(!labTiles([alevr, loading]).some((t) => t.lab === "openrouter"));
  const loaded = { ...loading, models: [{ id: "openrouter:anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5", contextTiers: [{ tokens: 200_000, label: "200K", inputPerMTok: 3, outputPerMTok: 15 }] }] };
  const tiles = labTiles([alevr, loaded]);
  assert.equal(tiles[tiles.length - 1].name, "OpenRouter");
  assert.deepEqual(labGroups([alevr, loaded], "openrouter").map((g) => g.title), ["Your OpenRouter key"]);
});

test("subscriptions: one group per connected plan, no keys, usage on the instance", () => {
  const groups = subscriptionGroups(INSTANCES);
  assert.deepEqual(groups.map((g) => g.title), ["Claude plan", "ChatGPT plan", "DeepSeek Harness"]);
  assert.ok(groups.every((g) => g.rows.every((r) => r.instance.kind !== "byok" && r.instance.kind !== "alevr")));
  assert.equal(groups[0].rows[0].line, "Included in your plan · 1M");
  assert.equal(groups[0].subscription?.id, "claude-agent:default");
  // Installed but signed out: not listed.
  assert.ok(!groups.some((g) => g.id === "acp:gemini"));
  const none = INSTANCES.map((i) => (i.kind === "alevr" || i.kind === "byok" ? i : { ...i, status: "signed-out" as const }));
  assert.equal(subscriptionGroups(none).length, 0);
  assert.equal(CONNECT_SUBSCRIPTION.title, "Connect a subscription");
});

test("opens on the selection's lab, or Subscriptions for a plan's model", () => {
  assert.deepEqual(defaultTab(INSTANCES, { instanceId: "claude-agent:default", model: "claude-opus-5-5" }), { type: "subscriptions" });
  assert.deepEqual(defaultTab(INSTANCES, { instanceId: "alevr", model: "openai:gpt-6.1-sol" }), { type: "lab", lab: "openai" });
  assert.deepEqual(defaultTab(INSTANCES, { instanceId: "byok:anthropic", model: "anthropic:claude-opus-5-5" }), { type: "lab", lab: "anthropic" });
  assert.equal(labOfModelId("anthropic:claude-opus-5-5"), "anthropic");
  assert.equal(labOfModelId("claude-opus-5-5"), null);
});

test("search: grouped by lab name, then Subscriptions", () => {
  const groups = searchCatalogue(INSTANCES, "opus");
  assert.deepEqual(groups.map((g) => g.title), ["Anthropic", "Subscriptions"]);
  assert.ok(groups[0].rows.some((r) => r.instance.kind === "alevr") && groups[0].rows.some((r) => r.instance.kind === "byok"));
  assert.ok(groups[1].rows.every((r) => r.instance.kind === "claude-agent"));
  assert.deepEqual(searchCatalogue(INSTANCES, "  "), []);
});

test("row lines and display order", () => {
  const m = { id: "x", label: "X", contextTiers: [{ tokens: 200_000, label: "200K", inputPerMTok: 5, outputPerMTok: 25 }, { tokens: 1_000_000, label: "1M", inputPerMTok: 10, outputPerMTok: 37.5 }] };
  assert.equal(pickerRowLine(alevr, m), "$5 / $25 · 1M");
  const sorted = sortForPicker([{ id: "nope:unknown", label: "?" }, ...codeProviderModels(undefined, { provider: "anthropic" })]);
  assert.equal(sorted[sorted.length - 1].id, "nope:unknown");
});

// ── Generation models (Settings) ─────────────────────────────────────────────

test("generation options: current, callable models of the modality, labelled with the lab", () => {
  for (const kind of GENERATION_KINDS) {
    const options = generationModelOptions(kind);
    assert.ok(options.length > 0, kind);
    for (const m of options) {
      assert.equal(m.modality, kind);
      assert.equal(m.status ?? "current", "current");
      assert.ok(!m.comingSoon && !hasRetired(m));
    }
  }
  assert.match(generationOptionLabel(MODELS["google:lyria-3.5"]), /^Lyria 3\.5 · Google$/);
  assert.doesNotMatch(GENERATION_MODELS_COPY.description, /[–—]/);
});

test("generation defaults: the newest by release, ties by display order; audio is DEFAULT_AUDIO_MODEL", () => {
  assert.equal(defaultGenerationModel("audio"), DEFAULT_AUDIO_MODEL);
  for (const kind of GENERATION_KINDS) {
    const id = defaultGenerationModel(kind)!;
    const newest = generationModelOptions(kind).reduce((a, m) => ((m.released ?? "") > a ? (m.released ?? "") : a), "");
    assert.equal(MODELS[id].released, newest, kind);
  }
  const fake = (id: string, released: string | undefined, cost: ModelInfo["cost"]): ModelInfo => ({ ...MODELS["google:lyria-3.5"], id, name: id, released, cost, status: "current" });
  // Same month: the display order (higher cost first here) breaks the tie.
  assert.equal(defaultGenerationModel("audio", [fake("a", "2026-09", 1), fake("b", "2026-09", 3), fake("c", undefined, 3)]), "b");
});

test("a stored generation model that is unknown or retired falls back to the default", () => {
  assert.equal(resolveGenerationModel("audio", "google:lyria-3-clip-preview"), "google:lyria-3-clip-preview");
  assert.equal(resolveGenerationModel("audio", "nope"), DEFAULT_AUDIO_MODEL);
  assert.equal(resolveGenerationModel("audio", "google:lyria-3-pro-preview"), DEFAULT_AUDIO_MODEL, "legacy is not an option");
  assert.equal(resolveGenerationModel("image", "google:lyria-3.5"), defaultGenerationModel("image"), "wrong modality");
  assert.deepEqual(parseGenerationChoice('{"image":"x","video":3,"other":"y"}'), { image: "x" });
  assert.deepEqual(parseGenerationChoice("not json"), {});
});
