import { describe, it } from "node:test";
import fs from "node:fs";
import { curate } from "../src/lib/model-discovery-core";
import { latestPerFamily } from "../src/lib/model-metrics";
import { MODELS, type ModelInfo } from "../src/lib/models";
import { PROVIDER_LIST, type Provider } from "../src/lib/providers";

const VENDOR_MAP: Record<string, Provider> = {
  anthropic: "anthropic", openai: "openai", google: "google", "z-ai": "zhipu",
  moonshotai: "moonshot", deepseek: "deepseek", mistralai: "mistral", "x-ai": "xai",
  minimax: "minimax", qwen: "qwen", xiaomi: "mimo", meituan: "longcat",
};

// mimic model-discovery.ts fetchProviderModels()
function simulate(provider: Provider, rawIds: string[]): ModelInfo[] {
  const discovered = curate(provider, rawIds);
  const curatedModelsForProvider = Object.values(MODELS).filter((m) => m.provider === provider && m.modality === "chat");
  const curatedNames = new Set(curatedModelsForProvider.map((m) => m.name.toLowerCase()));
  const combinedMap = new Map<string, ModelInfo>();
  for (const m of discovered) if (!curatedNames.has(m.name.toLowerCase())) combinedMap.set(m.id, m);
  for (const m of curatedModelsForProvider) combinedMap.set(m.id, m);
  return [...combinedMap.values()];
}

describe("scratch pipeline", () => {
  it("what the picker shows", () => {
    const radar: string[] = JSON.parse(fs.readFileSync("scripts/model-radar-seen.json", "utf8"));
    const byProvider = new Map<Provider, Set<string>>();
    for (const full of radar) {
      const [vendor, ...rest] = full.split("/");
      const p = VENDOR_MAP[vendor];
      if (!p) continue;
      const s = byProvider.get(p) ?? new Set<string>();
      s.add(rest.join("/").replace(/:free$/, ""));
      byProvider.set(p, s);
    }
    for (const p of PROVIDER_LIST) {
      const ids = [...(byProvider.get(p) ?? [])];
      if (!ids.length) continue;
      const merged = simulate(p, ids);
      const shown = latestPerFamily(merged);
      const before = merged.filter((m) => !m.legacy);
      console.log(`\n== ${p}`);
      console.log("  PICKER NOW: " + shown.map((m) => `${m.name}[${m.family}]`).join(" | "));
      const lostCurrent = before.filter((m) => !shown.some((s) => s.id === m.id));
      if (lostCurrent.length) console.log("  LOST (was non-legacy): " + lostCurrent.map((m) => `${m.name}(${m.id})`).join(" | "));
    }
  });
});
