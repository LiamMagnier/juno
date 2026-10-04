import type { Plan } from "@prisma/client";
import { BENCHMARKS, BENCHMARK_STAMP } from "@/lib/benchmarks.generated";
import { getModelMetrics, hasLiveBenchmark, type ModelMetrics } from "@/lib/model-metrics";
import { CURATED_CHAT_MODELS, type ModelInfo } from "@/lib/models";
import { modelRequiredPlan, PLANS } from "@/lib/plans";
import { tokenRate } from "@/lib/pricing";
import { PROVIDERS } from "@/lib/providers";
import { displayPrice } from "@/lib/price-display";

/**
 * PUBLIC MODEL COMPARISONS (/vs and /vs/[slug]).
 *
 * Every figure these pages print is read from the files the product itself
 * runs on: the curated catalog (models.ts), the price and grade tables
 * (model-metrics.ts), the leaderboard sync (benchmarks.generated.ts), the
 * billing rates (pricing.ts) and the plan gates (plans.ts). Nothing here holds
 * a number of its own except the illustrative workloads below, and those are
 * printed next to every result they produce.
 *
 * The rule the page copy follows: a claim is either a figure from those files
 * or a comparison of two such figures. When a grade is a catalog estimate
 * rather than a measurement, the page says so.
 */

export type CompareUse = "general" | "coding" | "writing";

export interface ModelPair {
  slug: string;
  a: string; // canonical model id, "provider:providerModel"
  b: string;
  use: CompareUse;
  group: "flagship" | "everyday" | "task";
}

/** A typical request for a use, in tokens. Printed wherever a cost uses it. */
export interface Workload {
  label: string;
  inputTokens: number;
  /** Share of the input served from the provider's prompt cache. */
  cachedShare: number;
  outputTokens: number;
}

export const WORKLOADS: Record<CompareUse, Workload> = {
  // The same 800 / 500 split model-metrics.ts uses for its average request.
  general: { label: "a chat turn of 800 input and 500 output tokens", inputTokens: 800, cachedShare: 0, outputTokens: 500 },
  coding: {
    label: "a coding turn of 20,000 input tokens (80% of them a cached repository context) and 1,500 output tokens",
    inputTokens: 20_000,
    cachedShare: 0.8,
    outputTokens: 1_500,
  },
  writing: { label: "a writing turn of 1,500 input and 2,000 output tokens", inputTokens: 1_500, cachedShare: 0, outputTokens: 2_000 },
};

const id = (provider: string, model: string) => `${provider}:${model}`;
const OPUS = id("anthropic", "claude-opus-5-5");
const SONNET = id("anthropic", "claude-sonnet-5-5");
const FABLE = id("anthropic", "claude-fable-5-1");
const SOL = id("openai", "gpt-6.1-sol");
const ASTRA = id("openai", "gpt-6-astra");
const LUNA = id("openai", "gpt-6-luna");
const GEMINI_PRO = id("google", "gemini-3.1-pro-preview");
const GEMINI_FLASH = id("google", "gemini-3.8-flash");
const GLM = id("zhipu", "glm-5.3");
const MUSE = id("meta", "muse-spark-1.3");

/** The model a page is about, in URL form: "Claude Opus 5.5" → "claude-opus-5-5". */
export function modelSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function catalogModel(modelId: string): ModelInfo | undefined {
  return CURATED_CHAT_MODELS.find((m) => m.id === modelId);
}

function pair(a: string, b: string, use: CompareUse, group: ModelPair["group"]): ModelPair {
  const ma = catalogModel(a);
  const mb = catalogModel(b);
  // A missing id must fail loudly at build time, not render a blank page.
  if (!ma || !mb) throw new Error(`compare pair references an unknown model: ${!ma ? a : b}`);
  const suffix = use === "general" ? "" : `-for-${use}`;
  return { slug: `${modelSlug(ma.name)}-vs-${modelSlug(mb.name)}${suffix}`, a, b, use, group };
}

/** The pairs people actually search for, among the current catalog. */
export const MODEL_PAIRS: readonly ModelPair[] = [
  pair(OPUS, SOL, "general", "flagship"),
  pair(OPUS, SOL, "coding", "task"),
  pair(OPUS, SOL, "writing", "task"),
  pair(OPUS, ASTRA, "general", "flagship"),
  pair(FABLE, ASTRA, "general", "flagship"),
  pair(OPUS, GEMINI_PRO, "general", "flagship"),
  pair(SOL, GEMINI_PRO, "general", "flagship"),
  pair(SONNET, SOL, "general", "everyday"),
  pair(SONNET, SOL, "coding", "task"),
  pair(SONNET, GEMINI_FLASH, "general", "everyday"),
  pair(SONNET, GLM, "general", "everyday"),
  pair(SONNET, MUSE, "general", "everyday"),
  pair(GLM, SOL, "coding", "task"),
  pair(GEMINI_FLASH, LUNA, "general", "everyday"),
];

export function findPair(slug: string): ModelPair | undefined {
  return MODEL_PAIRS.find((p) => p.slug === slug);
}

// ——— One model, as the page shows it ———

export interface ModelFacts {
  id: string;
  name: string;
  lab: string;
  description?: string;
  released?: string;
  /** "Sep 2026" */
  releasedLabel?: string;
  contextTokens: number;
  contextLabel: string;
  inputUsd: number;
  outputUsd: number;
  cachedInputUsd: number;
  intelligence: number;
  speed: number;
  /** Whether an Artificial Analysis measurement backs the grades. */
  measured: boolean;
  metricsSource: ModelMetrics["source"];
  reasoning: boolean;
  vision: boolean;
  webSearch: boolean;
  agenticTools: boolean;
  plan: Plan;
  planName: string;
  planPrice: string;
  planPriceTtc: number;
  /** The OpenRouter resale listing for this exact id, when the sync has one. */
  openRouter?: { slug: string; inputUsd?: number; outputUsd?: number };
}

/** "1M", "1.05M", "400K": two decimals, so 1,050,000 does not read as 1.1M. */
export function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(2)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function modelFacts(modelId: string): ModelFacts {
  const model = catalogModel(modelId);
  if (!model) throw new Error(`unknown model ${modelId}`);
  const metrics = getModelMetrics(model);
  const rate = tokenRate(model);
  const plan = modelRequiredPlan(model);
  const price = displayPrice(PLANS[plan].price, "en");
  const bench = BENCHMARKS[model.id];
  const [year, month] = model.released?.split("-") ?? [];
  return {
    id: model.id,
    name: model.name,
    lab: PROVIDERS[model.provider].label.split(" · ")[0],
    description: model.description,
    released: model.released,
    releasedLabel: year && month ? `${MONTHS[Number(month) - 1]} ${year}` : undefined,
    contextTokens: metrics.contextTokens,
    contextLabel: contextLabel(metrics.contextTokens),
    inputUsd: metrics.inputUsdPerMTok,
    outputUsd: metrics.outputUsdPerMTok,
    cachedInputUsd: rate.cacheRead,
    intelligence: metrics.intelligence,
    speed: metrics.speed,
    measured: hasLiveBenchmark(model),
    metricsSource: metrics.source,
    reasoning: model.reasoning,
    vision: model.vision,
    webSearch: model.webSearch,
    agenticTools: model.agenticTools,
    plan,
    planName: PLANS[plan].name,
    planPrice: price.monthly,
    planPriceTtc: price.monthlyTtc,
    openRouter: bench && bench.source === "openrouter"
      ? { slug: bench.slug, inputUsd: bench.priceInPerMTok, outputUsd: bench.priceOutPerMTok }
      : undefined,
  };
}

/** USD for one request of a workload at a model's list prices. */
export function workloadCostUsd(facts: Pick<ModelFacts, "inputUsd" | "outputUsd" | "cachedInputUsd">, w: Workload): number {
  const cached = w.inputTokens * w.cachedShare;
  const fresh = w.inputTokens - cached;
  return (fresh * facts.inputUsd + cached * facts.cachedInputUsd + w.outputTokens * facts.outputUsd) / 1_000_000;
}

export function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

// ——— The reading of the data ———

export interface Finding {
  /** "For long documents" */
  topic: string;
  /** The model the data favours, or null when it does not separate them. */
  favours: "a" | "b" | null;
  text: string;
}

function graded(a: ModelFacts, b: ModelFacts): string {
  if (a.measured && b.measured) return "Both grades come from Artificial Analysis measurements.";
  if (!a.measured && !b.measured) {
    return "Neither model has an Artificial Analysis measurement in Alevr's latest benchmark sync yet, so both grades are the catalog's estimates and may move when one lands.";
  }
  const est = a.measured ? b : a;
  return `${est.name}'s grade is a catalog estimate until a benchmark measures it.`;
}

/** Ratio above which two prices count as different. */
const PRICE_MARGIN = 1.1;

export function findings(p: ModelPair): Finding[] {
  const a = modelFacts(p.a);
  const b = modelFacts(p.b);
  const w = WORKLOADS[p.use];
  const out: Finding[] = [];
  const pick = (x: number, y: number, higherWins = true): "a" | "b" | null =>
    x === y ? null : (x > y) === higherWins ? "a" : "b";
  const nameOf = (side: "a" | "b") => (side === "a" ? a.name : b.name);

  // Cost of the use's workload.
  const ca = workloadCostUsd(a, w) * 1000;
  const cb = workloadCostUsd(b, w) * 1000;
  const cheap = Math.max(ca, cb) / Math.max(Math.min(ca, cb), 1e-9) >= PRICE_MARGIN ? pick(ca, cb, false) : null;
  out.push({
    topic: p.use === "coding" ? "For long coding sessions on a budget" : p.use === "writing" ? "For long drafts on a budget" : "For the lowest cost per message",
    favours: cheap,
    text:
      `At list prices, 1,000 requests of ${w.label} cost ${usd(ca)} on ${a.name} and ${usd(cb)} on ${b.name}. ` +
      (cheap ? `${nameOf(cheap)} is about ${(Math.max(ca, cb) / Math.min(ca, cb)).toFixed(1)}× cheaper for this workload.` : "That is within 10%, so price does not separate them here."),
  });

  const brains = pick(a.intelligence, b.intelligence);
  out.push({
    topic: p.use === "coding" ? "For hard bugs and large refactors" : p.use === "writing" ? "For nuanced, demanding writing" : "For the hardest reasoning",
    favours: brains,
    text:
      (brains
        ? `${nameOf(brains)} has the higher intelligence grade, ${Math.max(a.intelligence, b.intelligence)} against ${Math.min(a.intelligence, b.intelligence)} out of 10. `
        : `Both carry the same intelligence grade, ${a.intelligence} out of 10. `) + graded(a, b),
  });

  if (p.use === "coding") {
    const agentic = a.agenticTools === b.agenticTools ? null : a.agenticTools ? "a" : "b";
    out.push({
      topic: "For agent loops that call tools",
      favours: agentic,
      text: agentic
        ? `Only ${nameOf(agentic)} is marked in Alevr's catalog as reliably driving a multi-step tool loop.`
        : a.agenticTools
          ? "Both are marked in Alevr's catalog as reliably driving a multi-step tool loop, so either can run Alevr Code and agents."
          : "Neither is marked in Alevr's catalog as reliable in a multi-step tool loop.",
    });
    const cache = a.cachedInputUsd === b.cachedInputUsd ? null : pick(a.cachedInputUsd, b.cachedInputUsd, false);
    out.push({
      topic: "For re-reading the same repository",
      favours: cache,
      text: `A cached input token costs ${usd(a.cachedInputUsd)} per million on ${a.name} and ${usd(b.cachedInputUsd)} on ${b.name}. Coding sessions resend the same files every turn, and a cache hit is billed at this rate instead of the full input price.`,
    });
  }

  if (p.use === "writing") {
    const outPrice = a.outputUsd === b.outputUsd ? null : pick(a.outputUsd, b.outputUsd, false);
    out.push({
      topic: "For output-heavy work",
      favours: outPrice,
      text: `Writing is mostly output. ${a.name} charges ${usd(a.outputUsd)} and ${b.name} ${usd(b.outputUsd)} per million output tokens.`,
    });
  }

  const fast = pick(a.speed, b.speed);
  out.push({
    topic: "For quick back-and-forth",
    favours: fast,
    text: fast
      ? `${nameOf(fast)} has the higher speed grade, ${Math.max(a.speed, b.speed)} against ${Math.min(a.speed, b.speed)} out of 10.`
      : `Both carry the same speed grade, ${a.speed} out of 10.`,
  });

  const ctxRatio = Math.max(a.contextTokens, b.contextTokens) / Math.min(a.contextTokens, b.contextTokens);
  const longDocs = ctxRatio >= 1.1 ? pick(a.contextTokens, b.contextTokens) : null;
  out.push({
    topic: p.use === "coding" ? "For whole-repository context" : "For long documents",
    favours: longDocs,
    text: longDocs
      ? `${nameOf(longDocs)} reads up to ${contextLabel(Math.max(a.contextTokens, b.contextTokens))} tokens at once, against ${contextLabel(Math.min(a.contextTokens, b.contextTokens))}.`
      : a.contextTokens === b.contextTokens
        ? `Both read up to ${a.contextLabel} tokens at once.`
        : `The context windows are close: ${a.contextLabel} and ${b.contextLabel} tokens.`,
  });

  const planPick = a.plan === b.plan ? null : a.planPriceTtc < b.planPriceTtc ? "a" : "b";
  out.push({
    topic: "On a smaller Alevr plan",
    favours: planPick,
    text: planPick
      ? `${nameOf(planPick)} is included from ${planPick === "a" ? a.planName : b.planName} (${planPick === "a" ? a.planPrice : b.planPrice} a month incl. VAT); ${nameOf(planPick === "a" ? "b" : "a")} needs ${planPick === "a" ? b.planName : a.planName} (${planPick === "a" ? b.planPrice : a.planPrice}).`
      : `Both are included from ${a.planName}, ${a.planPrice} a month incl. VAT.`,
  });

  return out;
}

/** "Pick A if …" / "Pick B if …", from the findings that favour each side. */
export function verdict(p: ModelPair): { a: string[]; b: string[] } {
  const f = findings(p);
  const lower = (s: string) => s.replace(/^For /, "").replace(/^On /, "on ");
  return {
    a: f.filter((x) => x.favours === "a").map((x) => lower(x.topic)),
    b: f.filter((x) => x.favours === "b").map((x) => lower(x.topic)),
  };
}

// ——— Page text ———

const USE_TITLE: Record<CompareUse, string> = { general: "", coding: " for coding", writing: " for writing" };

export function pairTitle(p: ModelPair): string {
  return `${modelFacts(p.a).name} vs ${modelFacts(p.b).name}${USE_TITLE[p.use]}`;
}

export function pairDescription(p: ModelPair): string {
  const a = modelFacts(p.a);
  const b = modelFacts(p.b);
  return `${a.name} and ${b.name} side by side${USE_TITLE[p.use]}: list prices per million tokens (${usd(a.inputUsd)}/${usd(a.outputUsd)} vs ${usd(b.inputUsd)}/${usd(b.outputUsd)}), ${a.contextLabel} vs ${b.contextLabel} context, speed and intelligence grades, and which to pick when. Use both in Alevr.`;
}

/** Other comparisons that share a model with this one. */
export function relatedPairs(p: ModelPair, limit = 6): ModelPair[] {
  const shares = (q: ModelPair) => [q.a, q.b].some((m) => m === p.a || m === p.b);
  return [...MODEL_PAIRS.filter((q) => q.slug !== p.slug && shares(q)), ...MODEL_PAIRS.filter((q) => q.slug !== p.slug && !shares(q))].slice(0, limit);
}

/** Every model the pairs mention, in first-mention order. */
export function featuredModelIds(): string[] {
  return [...new Set(MODEL_PAIRS.flatMap((p) => [p.a, p.b]))];
}

/** The cheapest paid plan, for "plans from …" copy. */
export function cheapestPaidPlan(): { name: string; price: string } {
  const price = displayPrice(PLANS.LITE.price, "en");
  return { name: PLANS.LITE.name, price: price.monthly };
}

/** The plan a reader needs to use both models of a pair. */
export function planForBoth(p: ModelPair): { name: string; price: string } {
  const a = modelFacts(p.a);
  const b = modelFacts(p.b);
  const both = a.planPriceTtc >= b.planPriceTtc ? a : b;
  return { name: both.planName, price: both.planPrice };
}

/** "22 September 2026" — when the benchmark sync last ran. */
export function benchmarkSyncLabel(): string | null {
  if (!BENCHMARK_STAMP) return null;
  const d = new Date(BENCHMARK_STAMP);
  return `${d.getUTCDate()} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
