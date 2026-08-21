import { nativeModelCatalog } from "../src/lib/native-model-manifest";
import { REASONING_TIERS, reasoningCaps, reasoningOptions } from "../src/lib/model-metrics";
import { MODEL_LIST } from "../src/lib/models";

const OFFICIAL_REASONING_DOCS: Record<string, string> = {
  anthropic: "https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking",
  openai: "https://platform.openai.com/docs/guides/reasoning",
  google: "https://ai.google.dev/gemini-api/docs/thinking",
  xai: "https://docs.x.ai/docs/guides/reasoning",
  mistral: "https://docs.mistral.ai/capabilities/reasoning/",
  deepseek: "https://api-docs.deepseek.com/guides/thinking_mode",
  zhipu: "https://docs.z.ai/guides/capabilities/thinking-mode",
  moonshot: "https://platform.moonshot.ai/docs/guide/use-kimi-k2-thinking-model",
  minimax: "https://platform.minimax.io/docs/api-reference/text-openai-api",
  meta: "https://ai.meta.com/resources/models-and-libraries/",
  qwen: "https://www.alibabacloud.com/help/en/model-studio/deep-thinking",
  mimo: "https://platform.xiaomimimo.com/#/docs/api/text-generation",
  longcat: "https://longcat.chat/platform/docs",
};

const failures: string[] = [];
const chatModels = MODEL_LIST.filter((model) => model.modality === "chat" && !model.comingSoon);
for (const model of chatModels) {
  const caps = reasoningCaps(model);
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
