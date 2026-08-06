import { describe, it } from "node:test";
import fs from "node:fs";
import { FAMILIES, JUNK_RE, stripPrefix, versionScore } from "../src/lib/model-discovery-core";
import { CURATED_CHAT_MODELS, CURATED_GEN_MODELS } from "../src/lib/models";
import { PROVIDER_LIST, type Provider } from "../src/lib/providers";

function oldVersionScore(bare: string): number {
  const v = bare.match(/(\d+(?:\.\d+)?)/);
  const ver = v ? parseFloat(v[1]) : 0;
  const penalty = /\d{4}-\d{2}-\d{2}|\d{6,8}|preview|exp|snapshot|latest/i.test(bare) ? 0.001 : 0;
  return ver - penalty;
}

function curateWith(provider: Provider, rawIds: string[], score: (s: string) => number) {
  const items = rawIds.map((raw) => ({ raw, bare: stripPrefix(raw) })).filter((x) => !JUNK_RE.test(x.bare));
  const families = FAMILIES[provider];
  if (!families) return [];
  const out: { label: string; family: string; raw: string }[] = [];
  const used = new Set<string>();
  for (const fam of families) {
    const matches = items.filter((x) => fam.match.test(x.bare) && !used.has(x.raw));
    if (!matches.length) continue;
    const latest = matches.sort((a, b) => score(b.bare) - score(a.bare) || a.bare.length - b.bare.length)[0];
    used.add(latest.raw);
    out.push({ label: fam.label, family: fam.family, raw: latest.raw });
  }
  return out;
}

const VENDOR_MAP: Record<string, Provider> = {
  anthropic: "anthropic", openai: "openai", google: "google", "z-ai": "zhipu",
  moonshotai: "moonshot", deepseek: "deepseek", mistralai: "mistral", "x-ai": "xai",
  minimax: "minimax", qwen: "qwen", xiaomi: "mimo", meituan: "longcat",
};

describe("scratch curate diff", () => {
  it("diff", () => {
    const radar: string[] = JSON.parse(fs.readFileSync("scripts/model-radar-seen.json", "utf8"));
    const byProvider = new Map<Provider, Set<string>>();
    for (const full of radar) {
      const [vendor, ...rest] = full.split("/");
      const p = VENDOR_MAP[vendor];
      if (!p) continue;
      const id = rest.join("/").replace(/:free$/, "");
      const s = byProvider.get(p) ?? new Set();
      s.add(id);
      byProvider.set(p, s);
    }
    for (const m of [...CURATED_CHAT_MODELS, ...CURATED_GEN_MODELS]) {
      const s = byProvider.get(m.provider) ?? new Set<string>();
      s.add(m.providerModel);
      byProvider.set(m.provider, s);
    }
    for (const p of PROVIDER_LIST) {
      const ids = [...(byProvider.get(p) ?? [])];
      if (!ids.length || !FAMILIES[p]) continue;
      const nu = curateWith(p, ids, versionScore);
      const ol = curateWith(p, ids, oldVersionScore);
      const nuMap = new Map(nu.map((x) => [x.label + "|" + x.family, x.raw]));
      const olMap = new Map(ol.map((x) => [x.label + "|" + x.family, x.raw]));
      const keys = new Set([...nuMap.keys(), ...olMap.keys()]);
      const diffs = [...keys].filter((k) => nuMap.get(k) !== olMap.get(k));
      console.log(`\n== ${p} (${ids.length} ids)`);
      for (const k of diffs) console.log(`   ${k}:  OLD=${olMap.get(k)}   NEW=${nuMap.get(k)}`);
      if (!diffs.length) console.log("   (no change)");
      console.log("   NEW picks: " + nu.map((x) => `${x.family}=${x.raw}`).join(", "));
    }
  });
});
