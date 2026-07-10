/**
 * Industry model radar — spots NEW model releases across every lab, including
 * ones Juno's own provider keys can't list (no key, gen-only labs, regional
 * gating), by diffing OpenRouter's keyless catalog against a committed
 * seen-set. Complements sync-models.ts, which only sees configured providers.
 *
 *   npm run radar:models              print a markdown report of new arrivals
 *   npm run radar:models -- --out F   also write the report to file F
 *
 * State lives in scripts/model-radar-seen.json (committed). The first run
 * seeds the full catalog silently so the initial report isn't 300+ models.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURATED_CHAT_MODELS, CURATED_GEN_MODELS, RETIRED_MODELS } from "../src/lib/models";
import { DISCOVERED } from "../src/lib/models.generated";

const ROOT = process.cwd();
const SEEN_PATH = join(ROOT, "scripts/model-radar-seen.json");
const FETCH_TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT_PATH = outIdx !== -1 ? args[outIdx + 1] : null;

interface OrModel {
  id?: string; // "openai/gpt-5.6-luna"
  name?: string;
  created?: number; // unix seconds
  context_length?: number;
  pricing?: { prompt?: string; completion?: string }; // USD per token, strings
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

const skeleton = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Everything the registry already knows, as skeleton keys. */
function registrySkeletons(): Set<string> {
  const keys = new Set<string>();
  for (const m of [...CURATED_CHAT_MODELS, ...CURATED_GEN_MODELS]) {
    keys.add(skeleton(m.providerModel));
    keys.add(skeleton(m.name));
    keys.add(skeleton(m.providerModel.replace(/-latest$/, "")));
  }
  for (const d of DISCOVERED) keys.add(skeleton(d.id));
  for (const dead of Object.keys(RETIRED_MODELS)) keys.add(skeleton(dead.split(":")[1] ?? dead));
  return keys;
}

/** Variant suffixes that don't make a listing a genuinely new model. */
const VARIANT_RE = /(:free|:extended|:nitro|-exp$|-preview-\d|^openrouter\/)/i;

function fmtPrice(perTok?: string): string {
  const n = perTok ? parseFloat(perTok) : NaN;
  return Number.isFinite(n) ? `$${+(n * 1_000_000).toFixed(3)}` : "?";
}

async function main(): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let models: OrModel[];
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
    if (!res.ok) throw new Error(`openrouter models → ${res.status}`);
    models = ((await res.json()) as { data?: OrModel[] }).data ?? [];
  } finally {
    clearTimeout(timeout);
  }
  if (!models.length) {
    console.error("openrouter returned an empty catalog — leaving state untouched.");
    return 1;
  }

  const ids = models.map((m) => m.id).filter((id): id is string => !!id);
  const firstRun = !existsSync(SEEN_PATH);
  const seen = new Set<string>(firstRun ? [] : (JSON.parse(readFileSync(SEEN_PATH, "utf8")) as string[]));
  const fresh = models.filter((m) => m.id && !seen.has(m.id) && !VARIANT_RE.test(m.id));

  // Persist the union (never drop ids — delistings shouldn't re-trigger later).
  const union = [...new Set([...seen, ...ids])].sort();
  writeFileSync(SEEN_PATH, JSON.stringify(union, null, 1) + "\n");

  if (firstRun) {
    console.log(`seeded ${union.length} known OpenRouter ids — radar reports start next run.`);
    return 0;
  }
  if (!fresh.length) {
    console.log("radar: no new industry models since last run.");
    if (OUT_PATH) writeFileSync(OUT_PATH, "");
    return 0;
  }

  const known = registrySkeletons();
  const lines: string[] = ["## New industry models (OpenRouter radar)", ""];
  for (const m of fresh.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))) {
    const bare = m.id!.split("/")[1] ?? m.id!;
    const inRegistry = known.has(skeleton(bare)) || known.has(skeleton(m.name ?? ""));
    const date = m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : "?";
    const mods = m.architecture?.input_modalities?.join("+") ?? "?";
    lines.push(
      `- **${m.name ?? m.id}** (\`${m.id}\`) — released ${date}, ` +
        `${fmtPrice(m.pricing?.prompt)}/${fmtPrice(m.pricing?.completion)} per MTok, ` +
        `${m.context_length ?? "?"} ctx, ${mods}` +
        (inRegistry ? " — already in Juno's registry" : " — **NOT in Juno's registry**")
    );
  }
  lines.push("");
  const report = lines.join("\n");
  console.log(report);
  if (OUT_PATH) writeFileSync(OUT_PATH, report);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("model-radar crashed:", err);
    process.exit(1);
  });
