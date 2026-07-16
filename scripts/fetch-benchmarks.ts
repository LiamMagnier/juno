/**
 * Benchmark sync — grounds every curated model's intelligence/speed/price on
 * live leaderboard data and maintains src/lib/benchmarks.generated.ts.
 *
 *   npm run sync:benchmarks          fetch + write the generated file
 *
 * Sources, in order of authority:
 *  1. Artificial Analysis Data API v2 (needs AA_API_KEY — free key from
 *     artificialanalysis.ai; ATTRIBUTION REQUIRED, shown in the model picker):
 *     intelligence index, median output tok/s, TTFT, $/MTok list prices, plus
 *     image/video arena ELOs for generative models.
 *  2. OpenRouter /api/v1/models (keyless): $/MTok prices + context length as a
 *     fallback, so the sync still works with zero secrets configured.
 *
 * model-metrics.ts overlays this data on FAMILY_RULES at runtime — hand-tuned
 * numbers remain the fallback for models no leaderboard covers.
 * Mapping to 1–10 grades (documented in FAMILY_RULES header, keep in sync):
 *   intelligence = clamp(round((AA II − 2) / 6), 1, 10)
 *   speed        = tok/s bands ≥230→10 ≥180→9 ≥140→8 ≥100→7 ≥85→6 ≥70→5
 *                  ≥55→4 ≥45→3 ≥38→2 else 1, −1 when TTFT > 30s (min 1)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURATED_CHAT_MODELS, CURATED_GEN_MODELS, type ModelInfo } from "../src/lib/models";

const ROOT = process.cwd();
const GENERATED_PATH = join(ROOT, "src/lib/benchmarks.generated.ts");
const FETCH_TIMEOUT_MS = 20_000;

// —— Env loading (.env then .env.local; never override already-set keys) ——
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(["'])([\s\S]*)\1$/);
    if (quoted) value = quoted[2];
    else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// —— Matching: leaderboard slugs/names → curated registry ids ——

/** Lowercase alphanumeric skeleton — "GPT-5.6 Luna" and "gpt-5.6-luna" collide. */
const skeleton = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Known slug → canonical id where skeleton matching is ambiguous or fails. */
const SLUG_OVERRIDES: Record<string, string> = {
  // AA grades reasoning models per (model, effort) variant; the bare slug wins
  // via exact match, so only genuinely divergent names need entries here.
  "deepseek-v4": "deepseek:deepseek-v4-pro",
  "nano-banana-pro": "google:gemini-3-pro-image",
  "nano-banana-2": "google:gemini-3.1-flash-image",
  "nano-banana-2-lite": "google:gemini-3.1-flash-lite-image",
  "seedance-2-0": "seedance:dreamina-seedance-2-0-260128",
  "dreamina-seedance-2-0-720p": "seedance:dreamina-seedance-2-0-260128",
};

/** Leaderboard creator slugs → Juno provider ids (only where they differ). */
const CREATOR_TO_PROVIDER: Record<string, string> = {
  alibaba: "qwen",
  "z-ai": "zhipu",
  zhipuai: "zhipu",
  "moonshot-ai": "moonshot",
  moonshotai: "moonshot",
  xiaomi: "mimo",
  meituan: "longcat",
  bytedance: "seedance",
  spacexai: "xai",
};

interface CandidateKeys {
  model: ModelInfo;
  keys: Set<string>;
}

function candidateKeys(models: readonly ModelInfo[]): CandidateKeys[] {
  return models.map((m) => ({
    model: m,
    keys: new Set([
      skeleton(m.providerModel),
      skeleton(m.name),
      // "-latest" aliases (mistral) and dated snapshots also match their stem.
      skeleton(m.providerModel.replace(/-latest$/, "")),
      skeleton(m.providerModel.replace(/[-_]\d{6,8}$/, "")),
    ]),
  }));
}

function matchModel(cands: CandidateKeys[], creator: string | null, ...names: (string | null | undefined)[]): ModelInfo | null {
  const provider = creator ? (CREATOR_TO_PROVIDER[creator.toLowerCase()] ?? creator.toLowerCase()) : null;
  for (const raw of names) {
    if (!raw) continue;
    const override = SLUG_OVERRIDES[raw.toLowerCase()];
    if (override) {
      const hit = cands.find((c) => c.model.id === override);
      if (hit) return hit.model;
    }
    const key = skeleton(raw);
    if (!key) continue;
    const hits = cands.filter((c) => c.keys.has(key));
    if (hits.length === 1) return hits[0].model;
    if (hits.length > 1 && provider) {
      // Same skeleton across providers (rare) — the creator hint decides.
      const scoped = hits.filter((c) => c.model.provider === provider);
      if (scoped.length === 1) return scoped[0].model;
    }
  }
  return null;
}

// —— Generated shape (mirrored in src/lib/benchmarks.generated.ts) ——

export interface FetchedBenchmark {
  intelligenceIndex?: number; // AA Intelligence Index (composite, ~0-70)
  outputTokensPerSec?: number; // AA median output speed
  ttftSeconds?: number; // AA median time-to-first-token
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
  arenaElo?: number; // AA image/video arena ELO (generative models)
  source: "artificial-analysis" | "openrouter";
  slug: string; // source-side identifier, for auditability
}

type BenchMap = Map<string, FetchedBenchmark>;

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

// —— Artificial Analysis ——

interface AaLlm {
  slug?: string;
  name?: string;
  model_creator?: { slug?: string; name?: string };
  evaluations?: { artificial_analysis_intelligence_index?: number };
  pricing?: { price_1m_input_tokens?: number; price_1m_output_tokens?: number };
  median_output_tokens_per_second?: number;
  median_time_to_first_token_seconds?: number;
}

async function fetchArtificialAnalysis(key: string, out: BenchMap): Promise<number> {
  const cands = candidateKeys(CURATED_CHAT_MODELS);
  const data = (await fetchJson("https://artificialanalysis.ai/api/v2/data/llms/models", { "x-api-key": key })) as {
    data?: AaLlm[];
  };
  let matched = 0;
  for (const rec of data.data ?? []) {
    const model = matchModel(cands, rec.model_creator?.slug ?? null, rec.slug, rec.name);
    if (!model) continue;
    const prev = out.get(model.id);
    const ii = num(rec.evaluations?.artificial_analysis_intelligence_index);
    // AA lists one record per (model, reasoning effort); keep the strongest
    // variant — that is what the picker's effort selector scales from.
    if (prev?.source === "artificial-analysis" && (prev.intelligenceIndex ?? 0) >= (ii ?? 0)) continue;
    out.set(model.id, {
      intelligenceIndex: ii,
      outputTokensPerSec: num(rec.median_output_tokens_per_second),
      ttftSeconds: num(rec.median_time_to_first_token_seconds),
      priceInPerMTok: num(rec.pricing?.price_1m_input_tokens),
      priceOutPerMTok: num(rec.pricing?.price_1m_output_tokens),
      source: "artificial-analysis",
      slug: rec.slug ?? rec.name ?? "?",
    });
    matched++;
  }
  return matched;
}

interface AaMedia {
  slug?: string;
  name?: string;
  model_creator?: { slug?: string };
  elo?: number;
}

async function fetchAaMediaArena(key: string, path: string, out: BenchMap): Promise<number> {
  const cands = candidateKeys(CURATED_GEN_MODELS);
  const data = (await fetchJson(`https://artificialanalysis.ai/api/v2/data/media/${path}`, { "x-api-key": key })) as {
    data?: AaMedia[];
  };
  let matched = 0;
  for (const rec of data.data ?? []) {
    const model = matchModel(cands, rec.model_creator?.slug ?? null, rec.slug, rec.name);
    if (!model || out.has(model.id)) continue;
    out.set(model.id, { arenaElo: num(rec.elo), source: "artificial-analysis", slug: rec.slug ?? rec.name ?? "?" });
    matched++;
  }
  return matched;
}

// —— OpenRouter (keyless fallback: price + context only) ——

interface OrModel {
  id?: string; // "openai/gpt-5.6-luna"
  name?: string;
  pricing?: { prompt?: string; completion?: string }; // USD per TOKEN, strings
  context_length?: number;
}

async function fetchOpenRouter(out: BenchMap): Promise<number> {
  const cands = candidateKeys(CURATED_CHAT_MODELS);
  const data = (await fetchJson("https://openrouter.ai/api/v1/models")) as { data?: OrModel[] };
  let matched = 0;
  for (const rec of data.data ?? []) {
    const bare = rec.id?.split("/")[1];
    const orProvider = rec.id?.split("/")[0] ?? null;
    const model = matchModel(cands, orProvider, bare, rec.name);
    if (!model || out.has(model.id)) continue; // AA data always wins
    const priceIn = num(rec.pricing?.prompt);
    const priceOut = num(rec.pricing?.completion);
    out.set(model.id, {
      priceInPerMTok: priceIn !== undefined ? priceIn * 1_000_000 : undefined,
      priceOutPerMTok: priceOut !== undefined ? priceOut * 1_000_000 : undefined,
      source: "openrouter",
      slug: rec.id ?? "?",
    });
    matched++;
  }
  return matched;
}

// —— Rendering ——

function renderGenerated(stamp: string, map: BenchMap): string {
  const ids = [...map.keys()].sort();
  const rows = ids.map((id) => {
    const b = map.get(id)!;
    const fields = Object.entries(b)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
    return `  ${JSON.stringify(id)}: { ${fields} },`;
  });
  return `// AUTO-GENERATED by scripts/fetch-benchmarks.ts — do not edit by hand.
// Regenerate: \`npm run sync:benchmarks\`. Scores by Artificial Analysis
// (artificialanalysis.ai) — attribution is required by their API terms and is
// rendered in the model picker whenever this data is shown.

export interface ModelBenchmark {
  /** Artificial Analysis Intelligence Index (composite, roughly 0-70). */
  intelligenceIndex?: number;
  /** AA median output speed, tokens/second. */
  outputTokensPerSec?: number;
  /** AA median time-to-first-token, seconds (large for heavy reasoners). */
  ttftSeconds?: number;
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
  /** AA image/video arena ELO (generative models only). */
  arenaElo?: number;
  source: "artificial-analysis" | "openrouter";
  slug: string;
}

/** ISO timestamp of the last successful fetch (null = never fetched). */
export const BENCHMARK_STAMP: string | null = ${JSON.stringify(stamp)};

/** Canonical Juno model id → live leaderboard data. */
export const BENCHMARKS: Record<string, ModelBenchmark> = {
${rows.join("\n")}
};
`;
}

// —— Main ——

async function main(): Promise<number> {
  loadEnvFile(join(ROOT, ".env"));
  loadEnvFile(join(ROOT, ".env.local"));

  const out: BenchMap = new Map();
  const aaKey = process.env.AA_API_KEY;

  if (aaKey) {
    try {
      const n = await fetchArtificialAnalysis(aaKey, out);
      console.log(`artificial-analysis: matched ${n} chat models`);
    } catch (e) {
      console.error(`artificial-analysis LLM fetch failed: ${e instanceof Error ? e.message : e}`);
    }
    for (const arena of ["text-to-image", "text-to-video"]) {
      try {
        const n = await fetchAaMediaArena(aaKey, arena, out);
        console.log(`artificial-analysis ${arena}: matched ${n} generative models`);
      } catch (e) {
        console.error(`artificial-analysis ${arena} fetch failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } else {
    console.log("AA_API_KEY not set — skipping Artificial Analysis (grades stay hand-tuned).");
  }

  try {
    const n = await fetchOpenRouter(out);
    console.log(`openrouter: matched ${n} additional models (price/context only)`);
  } catch (e) {
    console.error(`openrouter fetch failed: ${e instanceof Error ? e.message : e}`);
  }

  if (!out.size) {
    console.error("no benchmark data fetched — leaving benchmarks.generated.ts untouched.");
    return 1;
  }
  writeFileSync(GENERATED_PATH, renderGenerated(new Date().toISOString(), out));
  console.log(`wrote src/lib/benchmarks.generated.ts (${out.size} models).`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("fetch-benchmarks crashed:", err);
    process.exit(1);
  });
