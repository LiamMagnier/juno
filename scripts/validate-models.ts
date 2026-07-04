/**
 * Model registry invariants — run with `npm run validate:models`.
 * Guards the curated registry in src/lib/models.ts against the classification
 * mistakes this file exists to prevent: duplicate ids, two "current" models in
 * one family, retired ids leaking back in, defaults pointing at dead models.
 */
import {
  CURATED_CHAT_MODELS,
  CURATED_GEN_MODELS,
  DEFAULT_MODEL,
  GEN_MODELS,
  MODEL_LIST,
  RETIRED_MODELS,
  resolveModel,
  type ModelInfo,
} from "../src/lib/models";
import { DISCOVERED, UNAVAILABLE } from "../src/lib/models.generated";
import { PROVIDER_LIST } from "../src/lib/providers";

const all: ModelInfo[] = [...MODEL_LIST, ...GEN_MODELS];
const errors: string[] = [];
const warnings: string[] = [];

// 1. No duplicate ids.
const seen = new Map<string, number>();
for (const m of all) seen.set(m.id, (seen.get(m.id) ?? 0) + 1);
for (const [id, n] of seen) if (n > 1) errors.push(`duplicate model id: ${id} (${n}x)`);

// 2. Required fields + enums.
for (const m of all) {
  if (!m.provider || !(PROVIDER_LIST as string[]).includes(m.provider)) errors.push(`${m.id}: unknown provider "${m.provider}"`);
  if (!m.providerModel) errors.push(`${m.id}: missing providerModel`);
  if (!m.name) errors.push(`${m.id}: missing display name`);
  if (!["chat", "image", "video"].includes(m.modality)) errors.push(`${m.id}: invalid modality "${m.modality}"`);
  if (!m.status || !["current", "legacy", "deprecated"].includes(m.status)) errors.push(`${m.id}: missing/invalid status "${m.status}"`);
  if (!m.family) errors.push(`${m.id}: missing family`);
  if (![1, 2, 3].includes(m.cost)) errors.push(`${m.id}: invalid cost tier ${m.cost}`);
  if (/[A-Z ]/.test(m.providerModel) && m.provider !== "minimax" && m.provider !== "meta") {
    warnings.push(`${m.id}: providerModel has uppercase/spaces — double-check exact API casing`);
  }
}

// 3. One current model per (provider, family, modality).
const currentByFamily = new Map<string, string[]>();
for (const m of all) {
  if (m.status !== "current") continue;
  const key = `${m.provider}/${m.modality}/${m.family}`;
  currentByFamily.set(key, [...(currentByFamily.get(key) ?? []), m.id]);
}
for (const [key, ids] of currentByFamily) {
  if (ids.length > 1) errors.push(`multiple CURRENT models in family ${key}: ${ids.join(", ")}`);
}

// 4. Status/legacy-flag consistency; deprecated models must carry a note.
for (const m of all) {
  const expectedLegacy = m.status !== "current";
  if ((m.legacy ?? false) !== expectedLegacy) errors.push(`${m.id}: legacy flag out of sync with status "${m.status}"`);
  if (m.status === "deprecated" && !m.deprecationNote) errors.push(`${m.id}: deprecated without a deprecationNote`);
}

// 5. Retired map: keys must NOT be registered; values must resolve to a
//    registered, current model of a sane modality.
const registered = new Set(all.map((m) => m.id));
for (const [dead, replacement] of Object.entries(RETIRED_MODELS)) {
  if (registered.has(dead)) errors.push(`retired id ${dead} is still registered in the curated lists`);
  const target = all.find((m) => m.id === replacement);
  if (!target) errors.push(`retired id ${dead} migrates to unregistered model ${replacement}`);
  else if (target.status !== "current") errors.push(`retired id ${dead} migrates to non-current model ${replacement} (${target.status})`);
}

// 6. Default model: registered, current, chat.
const def = resolveModel(DEFAULT_MODEL);
if (!def) errors.push(`DEFAULT_MODEL ${DEFAULT_MODEL} does not resolve`);
else {
  if (!registered.has(def.id)) errors.push(`DEFAULT_MODEL ${DEFAULT_MODEL} is not in the curated registry`);
  if (def.status !== "current") errors.push(`DEFAULT_MODEL ${DEFAULT_MODEL} is not current (${def.status})`);
  if (def.modality !== "chat") errors.push(`DEFAULT_MODEL ${DEFAULT_MODEL} is not a chat model`);
}

// 7. Capability sanity: gen models never claim chat-only capabilities.
for (const m of GEN_MODELS) {
  if (m.reasoning) errors.push(`${m.id}: generative model marked reasoning`);
  if (m.webSearch) errors.push(`${m.id}: generative model marked webSearch`);
}

// 8. Generated sync file (src/lib/models.generated.ts) invariants.
const curatedIds = new Set([...CURATED_CHAT_MODELS, ...CURATED_GEN_MODELS].map((m) => m.id));
const curatedGenIds = new Set(CURATED_GEN_MODELS.map((m) => m.id));
const migrationTargets = new Set(Object.values(RETIRED_MODELS));
for (const d of DISCOVERED) {
  if (curatedIds.has(`${d.provider}:${d.id}`)) errors.push(`generated DISCOVERED id ${d.provider}:${d.id} collides with a curated model`);
}
for (const id of UNAVAILABLE) {
  if (!curatedIds.has(id)) errors.push(`generated UNAVAILABLE id ${id} does not exist in the curated lists`);
  else if (curatedGenIds.has(id)) errors.push(`generated UNAVAILABLE id ${id} is an image/video model — sync must never prune generative models`);
  if (migrationTargets.has(id)) errors.push(`generated UNAVAILABLE id ${id} is the migration target of a retired model`);
}

// Report.
const counts = all.reduce<Record<string, number>>((acc, m) => ((acc[m.status ?? "?"] = (acc[m.status ?? "?"] ?? 0) + 1), acc), {});
console.log(`models: ${all.length} registered (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}), ${Object.keys(RETIRED_MODELS).length} retired migrations, ${DISCOVERED.length} auto-discovered, ${UNAVAILABLE.length} unavailable`);
for (const w of warnings) console.warn(`  warn: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`  FAIL: ${e}`);
  process.exit(1);
}
console.log("model registry OK");
