import { nativeModelCatalog } from "../src/lib/native-model-manifest";
import { REASONING_TIERS, reasoningCaps, reasoningOptions } from "../src/lib/model-metrics";
import {
  buildReasoningCapabilityRegistry,
  OFFICIAL_REASONING_DOCS,
} from "../src/lib/model-reasoning-capabilities";
import { MODEL_LIST } from "../src/lib/models";

const failures: string[] = [];
const chatModels = MODEL_LIST.filter((model) => model.modality === "chat" && !model.comingSoon);
const registry = buildReasoningCapabilityRegistry(chatModels);
for (const model of chatModels) {
  const caps = reasoningCaps(model);
  const evidence = registry[model.id];
  if (!evidence) failures.push(`${model.id}: no machine-readable capability evidence`);
  if (evidence?.providerModel !== model.providerModel || evidence?.canonicalId !== model.id) {
    failures.push(`${model.id}: evidence identity drifted from selectable catalog`);
  }
  if (!evidence?.officialDocs.startsWith("https://")) failures.push(`${model.id}: missing official documentation URL`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(evidence?.verifiedAt ?? "")) failures.push(`${model.id}: invalid verification date`);
  if (model.reasoning && evidence?.controlType === "none") failures.push(`${model.id}: reasoning model has no declared control contract`);
  if (!model.reasoning && evidence?.controlType !== "none") failures.push(`${model.id}: non-reasoning model declares a reasoning wire control`);
  if (JSON.stringify(evidence?.tiers) !== JSON.stringify(caps.tiers)) failures.push(`${model.id}: evidence tiers drifted from runtime capabilities`);
  if (evidence?.defaultLevel !== caps.defaultLevel || evidence?.canDisable !== caps.canDisable) {
    failures.push(`${model.id}: evidence default/off-switch drifted from runtime capabilities`);
  }
  const unique = new Set(caps.tiers);
  if (unique.size !== caps.tiers.length) failures.push(`${model.id}: duplicate reasoning tier`);
  if (caps.tiers.some((tier) => !REASONING_TIERS.includes(tier))) {
    failures.push(`${model.id}: unknown reasoning tier`);
  }
  if (!model.reasoning && (caps.tiers.length || caps.canDisable || caps.onOff || caps.defaultLevel)) {
    failures.push(`${model.id}: non-reasoning model exposes a reasoning control`);
  }
  if (caps.onOff && (!caps.canDisable || caps.tiers.length !== 0)) {
    failures.push(`${model.id}: on/off control must have no enum tiers and allow off`);
  }
  if (caps.defaultLevel && !caps.tiers.includes(caps.defaultLevel)) {
    failures.push(`${model.id}: default ${caps.defaultLevel} is not supported`);
  }
  if (model.reasoning && !OFFICIAL_REASONING_DOCS[model.provider]) {
    failures.push(`${model.id}: no official provider evidence registered`);
  }
  const optionValues = reasoningOptions(model).map((option) => option.value).filter(Boolean);
  if (!caps.onOff && optionValues.some((value) => !caps.tiers.includes(value!))) {
    failures.push(`${model.id}: UI option is absent from canonical capabilities`);
  }
}

const gemini = chatModels.find((model) => model.id === "google:gemini-3.7-flash");
if (!gemini) failures.push("google:gemini-3.7-flash: missing from selectable catalog");
else {
  const caps = reasoningCaps(gemini);
  if (JSON.stringify(caps.tiers) !== JSON.stringify(["low", "medium", "high"])) {
    failures.push("google:gemini-3.7-flash: must expose exactly low, medium, high");
  }
  if (caps.canDisable || caps.defaultLevel !== "medium") {
    failures.push("google:gemini-3.7-flash: must be mandatory with medium default");
  }
}

const manifest = nativeModelCatalog(chatModels).models;
for (const entry of manifest) {
  if (entry.reasoning.automatic) continue;
  const source = chatModels.find((model) => model.id === entry.id);
  if (!source) continue;
  const caps = reasoningCaps(source);
  if (JSON.stringify(entry.supportedReasoningEfforts) !== JSON.stringify(caps.tiers)) {
    failures.push(`${entry.id}: native manifest tiers drifted from canonical capabilities`);
  }
  if (entry.reasoning.defaultEffort !== caps.defaultLevel) {
    failures.push(`${entry.id}: native manifest default drifted from canonical capabilities`);
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Model capability audit passed: ${chatModels.length} selectable chat models, ${Object.keys(OFFICIAL_REASONING_DOCS).length} official provider evidence roots.`);
