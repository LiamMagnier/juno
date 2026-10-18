/**
 * Regenerate src/lib/deepinfra-models.generated.ts from DeepInfra's public
 * model list.
 *
 *   npm run models:deepinfra                 # fetch https://api.deepinfra.com/models/list
 *   npm run models:deepinfra -- --from x.json # read a saved copy instead
 *   npm run models:deepinfra -- --check       # exit 1 when the file is stale
 *
 * The list is public (no key is sent, none is read). Only the DeepInfra ids
 * the catalog actually routes to (`deepinfra:` on a models.ts row) are kept,
 * keyed by the canonical Alevr id so pricing and routing look an entry up the
 * same way they look up OFFICIAL_RATES.
 *
 * DeepInfra quotes prices in CENTS per token; the table is USD per 1M tokens
 * like model-rates.generated.ts. `rate_per_input_token_cached` is a ratio of
 * the input price, not a price.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CURATED_CHAT_MODELS } from "../../src/lib/models";
import type { DeepInfraModelEntry } from "../../src/lib/deepinfra-models.generated";

export const DEEPINFRA_LIST_URL = "https://api.deepinfra.com/models/list";
const OUT = path.join(process.cwd(), "src/lib/deepinfra-models.generated.ts");

export interface DeepInfraListing {
  model_name: string;
  type?: string;
  tags?: string[];
  max_tokens?: number | null;
  deprecated?: number | null;
  replaced_by?: string | null;
  pricing?: {
    type?: string;
    full?: string | null;
    cents_per_input_token?: number | null;
    cents_per_output_token?: number | null;
    rate_per_input_token_cached?: number | null;
  } | null;
}

/** Cents per token -> USD per 1M tokens, rounded to a tenth of a cent. */
function perMTok(centsPerToken: number): number {
  return Math.round(centsPerToken * 10_000 * 1000) / 1000;
}

/**
 * DeepInfra's tiered prompt pricing, from its `full` string ("$2.50 in $7.50
 * out … <= 32K, $5.0 in $15 out … <= 128K, …"). The table carries one
 * threshold, so the FIRST step is kept: above it every token is billed at the
 * second tier's multiple. That under-states only the third tier.
 */
function longContextFrom(full: string | null | undefined): DeepInfraModelEntry["longContext"] {
  if (!full) return null;
  const tiers = [...full.matchAll(/\$([\d.]+) in \$([\d.]+) out[^,]*?<=\s*(\d+)K/g)];
  const next = [...full.matchAll(/\$([\d.]+) in \$([\d.]+) out/g)];
  if (tiers.length === 0 || next.length < 2) return null;
  const [, in0, out0, k] = tiers[0];
  const [, in1, out1] = next[1];
  return {
    threshold: Number(k) * 1000,
    inclusive: false,
    inputMultiplier: Math.round((Number(in1) / Number(in0)) * 1000) / 1000,
    outputMultiplier: Math.round((Number(out1) / Number(out0)) * 1000) / 1000,
  };
}

export function entryFor(listing: DeepInfraListing): DeepInfraModelEntry {
  const p = listing.pricing ?? {};
  if (p.type !== "tokens" || p.cents_per_input_token == null || p.cents_per_output_token == null) {
    throw new Error(`${listing.model_name}: not priced per token (pricing.type=${p.type ?? "none"})`);
  }
  const input = perMTok(p.cents_per_input_token);
  const entry: DeepInfraModelEntry = {
    model: listing.model_name,
    input,
    output: perMTok(p.cents_per_output_token),
    // No cached rate published = no discount: a cached token is a full-price token.
    cacheRead: Math.round(input * (p.rate_per_input_token_cached ?? 1) * 10_000) / 10_000,
    longContext: longContextFrom(p.full),
    tags: [...new Set(listing.tags ?? [])].sort(),
  };
  if (listing.max_tokens) entry.contextTokens = listing.max_tokens;
  if (listing.deprecated) entry.deprecatedOn = new Date(listing.deprecated * 1000).toISOString().slice(0, 10);
  if (listing.replaced_by) entry.replacedBy = listing.replaced_by;
  return entry;
}

export function buildTable(listings: readonly DeepInfraListing[]): Record<string, DeepInfraModelEntry> {
  const byName = new Map(listings.map((l) => [l.model_name, l]));
  const out: Record<string, DeepInfraModelEntry> = {};
  for (const model of CURATED_CHAT_MODELS) {
    if (!model.deepinfra) continue;
    const listing = byName.get(model.deepinfra);
    if (!listing) throw new Error(`${model.id}: DeepInfra does not list ${model.deepinfra}`);
    out[model.id] = entryFor(listing);
  }
  return out;
}

export function renderTable(table: Record<string, DeepInfraModelEntry>, verified: string): string {
  const header = readFileSync(OUT, "utf8");
  const at = header.indexOf("export const DEEPINFRA_VERIFIED");
  if (at < 0) throw new Error("deepinfra-models.generated.ts: DEEPINFRA_VERIFIED not found");
  const body = Object.keys(table)
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(table[id])},`)
    .join("\n");
  return `${header.slice(0, at)}export const DEEPINFRA_VERIFIED = ${JSON.stringify(verified)};\n\nexport const DEEPINFRA_MODELS: Readonly<Record<string, DeepInfraModelEntry>> = {\n${body}\n};\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromAt = args.indexOf("--from");
  const check = args.includes("--check");
  const raw =
    fromAt >= 0
      ? JSON.parse(readFileSync(args[fromAt + 1], "utf8"))
      : await fetch(DEEPINFRA_LIST_URL).then((r) => {
          if (!r.ok) throw new Error(`${DEEPINFRA_LIST_URL}: ${r.status}`);
          return r.json();
        });
  if (!Array.isArray(raw)) throw new Error("DeepInfra model list: expected an array");
  const table = buildTable(raw as DeepInfraListing[]);
  const current = readFileSync(OUT, "utf8");
  const verified = check ? (/DEEPINFRA_VERIFIED = "([^"]+)"/.exec(current)?.[1] ?? "") : new Date().toISOString().slice(0, 10);
  const next = renderTable(table, verified);
  if (check) {
    if (next !== current) {
      console.error("deepinfra-models.generated.ts is stale: run npm run models:deepinfra");
      process.exit(1);
    }
    console.log(`deepinfra-models.generated.ts is current (${Object.keys(table).length} routes)`);
    return;
  }
  writeFileSync(OUT, next);
  console.log(`wrote ${Object.keys(table).length} DeepInfra routes to ${path.relative(process.cwd(), OUT)}`);
}

if (process.argv[1] && /deepinfra\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
