/**
 * Pure, environment-agnostic parts of live model discovery — shared by the
 * server route (model-discovery.ts, which adds "server-only" + caching) and
 * the sync CLI (scripts/sync-models.ts). Keep this module free of Next.js /
 * server-only imports so scripts can run it under tsx.
 */
import type { Plan } from "@prisma/client";
import { providerApiKey, providerBaseUrl, type Provider } from "@/lib/providers";
import { MODELS, prettifyModelName, guessVision, guessPlan, guessReasoning, guessCost, providerSupportsWebSearch, type ModelInfo,
  guessAgenticTools,
} from "@/lib/models";

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 2500;

// Models that aren't general chat models, or that we never want to surface.
//
// `contributor` is the second kind, and the reason it is worth naming: Meta's
// muse-spark-*-contributor ids are ordinary chat models sold at ~12x off in
// exchange for the right to train on the prompts and completions sent to them.
// Discovery keeps the LATEST id per family, so without this the nightly sync
// could quietly promote the training-on tier over the standard one and move
// users' conversations onto it. Opting into that is a decision for a human.
export const JUNK_RE =
  /(robot|antigravity|embed|tts|whisper|audio|speech|dall|image|imagen|veo|video|moderation|rerank|guard|safety|aqa|tuning|learnlm|gemma|banana|live|realtime|computer-use|vision-?only|ocr|distill|deprecat|legacy|contributor|^ada|babbage|davinci|curie|sora|moderation)/i;

export interface Family {
  label: string;
  match: RegExp;
  minPlan: Plan;
  vision: boolean;
  /**
   * The product line this rule stands for, as the SAME slug the curated
   * registry uses (`ModelInfo.family` in models.ts).
   *
   * Discovery already keeps one model per rule, but `latestPerFamily` has to be
   * able to see that a discovered `gemini-3.6-flash` and the curated
   * `gemini-3.5-flash` are the same line — both are `current`, so nothing else
   * would collapse them and the picker would list two Flashes. Matching the
   * registry's slug exactly is the whole point: "flash", not "Gemini Flash".
   */
  family: string;
}

// Curated "families" per provider. From the provider's real API list we keep
// only the latest model in each family, so the picker shows clean, current
// models instead of every dated snapshot and old version.
export const FAMILIES: Partial<Record<Provider, Family[]>> = {
  anthropic: [
    { label: "Claude Fable", family: "fable", match: /fable/i, minPlan: "PRO", vision: true },
    { label: "Claude Mythos", family: "mythos", match: /mythos/i, minPlan: "PRO", vision: true },
    { label: "Claude Opus", family: "opus", match: /opus/i, minPlan: "PRO", vision: true },
    { label: "Claude Sonnet", family: "sonnet", match: /sonnet/i, minPlan: "FREE", vision: true },
    { label: "Claude Haiku", family: "haiku", match: /haiku/i, minPlan: "FREE", vision: true },
  ],
  openai: [
    { label: "GPT-5.6 Sol", family: "gpt", match: /^gpt-5\.6-sol/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.6 Terra", family: "gpt-value", match: /^gpt-5\.6-terra/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.6 Luna", family: "gpt-luna", match: /^gpt-5\.6-luna/i, minPlan: "FREE", vision: true },
    { label: "GPT-5.6 Sol", family: "gpt", match: /^gpt-5\.6(?!-)/i, minPlan: "PRO", vision: true }, // bare alias → Sol
    { label: "GPT-5.5 Pro", family: "gpt-pro", match: /^gpt-5\.5-pro/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.5", family: "gpt", match: /^gpt-5\.5(?!-)/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.3 Codex", family: "gpt-codex", match: /^gpt-5\.3-codex/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.2 Pro", family: "gpt-pro", match: /^gpt-5\.2-pro/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.2 Codex", family: "gpt-codex", match: /^gpt-5\.2-codex/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.2", family: "gpt", match: /^gpt-5\.2(?!-)/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.1 Codex Mini", family: "gpt-codex-mini", match: /^gpt-5\.1-codex-mini/i, minPlan: "FREE", vision: true },
    { label: "GPT-5.1 Codex", family: "gpt-codex", match: /^gpt-5\.1-codex(?!-mini)/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.1", family: "gpt", match: /^gpt-5\.1(?!-)/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.4 Mini", family: "gpt-mini", match: /^gpt-5\.4-mini/i, minPlan: "FREE", vision: true },
    { label: "GPT-5.4 Nano", family: "gpt-nano", match: /^gpt-5\.4-nano/i, minPlan: "FREE", vision: true },
    { label: "GPT-5.4", family: "gpt-value", match: /^gpt-5\.4(?!-)/i, minPlan: "PRO", vision: true },
    // Version-agnostic catch-alls, LAST so every pinned rule above claims its
    // own id first. Without these, OpenAI's whole table is pinned to versions
    // that exist today: the morning GPT-5.7 Sol ships, discovery matches
    // nothing, and the picker keeps offering 5.6 until somebody hand-edits the
    // registry. `used` means these only ever pick up an id no rule claimed —
    // which is exactly "a version we have not curated yet".
    { label: "GPT Sol", family: "gpt", match: /^gpt-\d+(?:\.\d+)?-sol/i, minPlan: "PRO", vision: true },
    { label: "GPT Terra", family: "gpt-value", match: /^gpt-\d+(?:\.\d+)?-terra/i, minPlan: "PRO", vision: true },
    { label: "GPT Luna", family: "gpt-luna", match: /^gpt-\d+(?:\.\d+)?-luna/i, minPlan: "FREE", vision: true },
    { label: "GPT Pro", family: "gpt-pro", match: /^gpt-\d+(?:\.\d+)?-pro/i, minPlan: "PRO", vision: true },
    { label: "GPT Codex Mini", family: "gpt-codex-mini", match: /^gpt-\d+(?:\.\d+)?-codex-mini/i, minPlan: "FREE", vision: true },
    { label: "GPT Codex", family: "gpt-codex", match: /^gpt-\d+(?:\.\d+)?-codex/i, minPlan: "PRO", vision: true },
    { label: "GPT Mini", family: "gpt-mini", match: /^gpt-\d+(?:\.\d+)?-mini/i, minPlan: "FREE", vision: true },
    { label: "GPT Nano", family: "gpt-nano", match: /^gpt-\d+(?:\.\d+)?-nano/i, minPlan: "FREE", vision: true },
    { label: "GPT", family: "gpt", match: /^gpt-\d+(?:\.\d+)?$/i, minPlan: "PRO", vision: true },
  ],
  google: [
    { label: "Gemini Flash-Lite", family: "flash-lite", match: /gemini-[\d.]+-flash-lite/i, minPlan: "FREE", vision: true },
    { label: "Gemini Flash", family: "flash", match: /gemini-[\d.]+-flash(?!-lite)/i, minPlan: "FREE", vision: true },
    { label: "Gemini Pro", family: "pro", match: /gemini-[\d.]+-pro/i, minPlan: "PRO", vision: true },
  ],
  meta: [
    // family "muse-spark" matches the curated slug on purpose: when Meta ships
    // 1.3, latestPerFamily has to see it as the same line as the curated 1.2 and
    // collapse them, instead of the picker listing two Sparks.
    { label: "Muse Spark", family: "muse-spark", match: /^muse-spark/i, minPlan: "PRO", vision: true },
    { label: "Llama 4 Maverick", family: "llama-maverick", match: /^llama-4-maverick/i, minPlan: "PRO", vision: true },
    { label: "Llama 4 Scout", family: "llama-scout", match: /^llama-4-scout/i, minPlan: "FREE", vision: true },
    { label: "Llama 3.3 70B", family: "llama-70b", match: /^llama-3\.3-70b/i, minPlan: "FREE", vision: false },
  ],
  zhipu: [
    { label: "GLM Vision FlashX", family: "glm-v-flashx", match: /^glm-[\d.]+v-flashx$/i, minPlan: "FREE", vision: true },
    { label: "GLM Vision Flash", family: "glm-v-flash", match: /^glm-[\d.]+v-flash$/i, minPlan: "FREE", vision: true },
    { label: "GLM FlashX", family: "glm-flashx", match: /glm-[\d.]+-flashx/i, minPlan: "FREE", vision: false },
    { label: "GLM Flash", family: "glm-flash", match: /glm-[\d.]+-flash(?!x)/i, minPlan: "FREE", vision: false },
    { label: "GLM AirX", family: "glm-airx", match: /^glm-[\d.]+-airx$/i, minPlan: "FREE", vision: false },
    { label: "GLM Air", family: "glm-air", match: /^glm-[\d.]+-air$/i, minPlan: "FREE", vision: false },
    { label: "GLM Turbo", family: "glm-turbo", match: /^glm-[\d.]+-turbo$/i, minPlan: "PRO", vision: false },
    { label: "GLM Vision", family: "glm-v", match: /^glm-[\d.]+v(-turbo)?$/i, minPlan: "PRO", vision: true },
    { label: "GLM 32B", family: "glm-4-32b", match: /^glm-4-32b/i, minPlan: "FREE", vision: false },
    { label: "GLM X", family: "glm-x", match: /^glm-[\d.]+-x$/i, minPlan: "PRO", vision: false },
    { label: "GLM", family: "glm", match: /^glm-[\d.]+(?:-0\d+)?$/i, minPlan: "PRO", vision: false },
  ],
  moonshot: [
    { label: "Kimi Code High-Speed", family: "kimi-code-highspeed", match: /kimi-k[\d.]+-code-highspeed/i, minPlan: "PRO", vision: false },
    { label: "Kimi Code", family: "kimi-code", match: /kimi-k[\d.]+-code(?!-)/i, minPlan: "PRO", vision: false },
    { label: "Kimi", family: "kimi", match: /^kimi-k[\d.]+$/i, minPlan: "PRO", vision: true },
    { label: "Moonshot v1", family: "moonshot-v1", match: /^moonshot-v1-(8k|32k|128k)$/i, minPlan: "FREE", vision: false },
  ],
  deepseek: [
    { label: "DeepSeek V4 Pro", family: "v4-pro", match: /deepseek-v4-pro/i, minPlan: "PRO", vision: false },
    { label: "DeepSeek V4 Flash", family: "v4-flash", match: /deepseek-v4-flash/i, minPlan: "FREE", vision: false },
    // Same reason as OpenAI's: pinned to V4, so V5 would arrive invisible.
    { label: "DeepSeek Pro", family: "v4-pro", match: /deepseek-v\d+(?:\.\d+)?-pro/i, minPlan: "PRO", vision: false },
    { label: "DeepSeek Flash", family: "v4-flash", match: /deepseek-v\d+(?:\.\d+)?-flash/i, minPlan: "FREE", vision: false },
  ],
  mistral: [
    { label: "Mistral Medium", family: "medium", match: /^mistral-medium/i, minPlan: "PRO", vision: true },
    { label: "Mistral Large", family: "large", match: /^mistral-large/i, minPlan: "PRO", vision: true },
    { label: "Mistral Small", family: "small", match: /^mistral-small/i, minPlan: "FREE", vision: true },
    { label: "Codestral", family: "codestral", match: /^codestral(?!.*embed)/i, minPlan: "PRO", vision: false },
    { label: "Ministral", family: "ministral", match: /^ministral-14b/i, minPlan: "FREE", vision: false },
    { label: "Ministral 8B", family: "ministral-8b", match: /^ministral-8b/i, minPlan: "FREE", vision: false },
    { label: "Ministral 3B", family: "ministral-3b", match: /^ministral-3b/i, minPlan: "FREE", vision: false },
  ],
  xai: [
    { label: "Grok 4.5", family: "grok", match: /^grok-4\.5/i, minPlan: "PRO", vision: true },
    { label: "Grok 4.3", family: "grok", match: /^grok-4\.3/i, minPlan: "PRO", vision: true },
    { label: "Grok Build", family: "grok-build", match: /^grok-build/i, minPlan: "PRO", vision: true },
    { label: "Grok Multi-Agent", family: "grok-multi-agent", match: /multi-agent/i, minPlan: "PRO", vision: true },
    // Last: the next numbered Grok, whatever it is called. Grok's image and
    // video ids never reach here — JUNK_RE drops them upstream.
    { label: "Grok", family: "grok", match: /^grok-\d+(?:\.\d+)?/i, minPlan: "PRO", vision: true },
  ],
  minimax: [
    { label: "MiniMax M3", family: "m", match: /^minimax-m3$/i, minPlan: "PRO", vision: true },
    { label: "MiniMax Highspeed", family: "m-highspeed", match: /^minimax-m[\d.]+-highspeed$/i, minPlan: "FREE", vision: false },
    { label: "MiniMax M", family: "m", match: /^minimax-m\d+(?:\.\d+)?$/i, minPlan: "PRO", vision: true },
  ],
  mimo: [
    { label: "MiMo V2.5 Pro", family: "mimo", match: /^mimo-v2\.5-pro$/i, minPlan: "PRO", vision: true },
    { label: "MiMo Flash", family: "mimo-flash", match: /^mimo-v[\d.]+-flash$/i, minPlan: "FREE", vision: false },
    { label: "MiMo Pro", family: "mimo", match: /^mimo-v\d+(?:\.\d+)?-pro$/i, minPlan: "PRO", vision: true },
  ],
  qwen: [
    { label: "Qwen 3.8 Max", family: "qwen-max", match: /^qwen3\.8-max/i, minPlan: "PRO", vision: true },
    { label: "Qwen 3.7 Max", family: "qwen-max", match: /^qwen3\.7-max/i, minPlan: "PRO", vision: false },
    { label: "Qwen 3.7 Plus", family: "qwen-plus", match: /^qwen3\.7-plus/i, minPlan: "PRO", vision: true },
    { label: "Qwen 3.6 Flash", family: "qwen-flash", match: /^qwen3\.6-flash/i, minPlan: "FREE", vision: true },
    { label: "Qwen 3.6 Plus", family: "qwen-plus", match: /^qwen3\.6-plus/i, minPlan: "PRO", vision: true },
    { label: "Qwen Long", family: "qwen-long", match: /^qwen-long/i, minPlan: "PRO", vision: false },
    { label: "Qwen Coder", family: "qwen-coder", match: /qwen[\d.]*-coder/i, minPlan: "PRO", vision: false },
    { label: "Qwen VL", family: "qwen-vl", match: /qwen[\d.]*-vl/i, minPlan: "PRO", vision: true },
    { label: "Qwen Max", family: "qwen-max", match: /qwen[\d.]*-max/i, minPlan: "PRO", vision: false },
    { label: "Qwen Plus", family: "qwen-plus", match: /qwen[\d.]*-plus/i, minPlan: "PRO", vision: true },
    { label: "Qwen Flash", family: "qwen-flash", match: /qwen[\d.]*-flash/i, minPlan: "FREE", vision: true },
    { label: "Qwen Turbo", family: "qwen-flash", match: /qwen[\d.]*-turbo/i, minPlan: "FREE", vision: false },
    { label: "QwQ", family: "qwq", match: /^qwq/i, minPlan: "PRO", vision: false },
  ],
  longcat: [
    { label: "LongCat 2.0", family: "longcat", match: /^longcat-2/i, minPlan: "PRO", vision: false },
    { label: "LongCat", family: "longcat", match: /^longcat-\d/i, minPlan: "PRO", vision: false },
  ],
};

export const stripPrefix = (id: string) => id.replace(/^models\//i, "");

async function fetchModelList(provider: Provider, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${provider} models ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Raw model-id list from the provider's live API (Anthropic uses its native
 *  endpoint; everyone else is OpenAI-compatible GET /models). Throws on
 *  missing key, HTTP error, or timeout — callers decide how to degrade. */
export async function fetchProviderModelIds(provider: Provider, timeoutMs: number = DEFAULT_DISCOVERY_TIMEOUT_MS): Promise<string[]> {
  const key = providerApiKey(provider);
  if (!key) throw new Error(`${provider}: API key not configured`);

  if (provider === "anthropic") {
    const data = (await fetchModelList(provider, "https://api.anthropic.com/v1/models?limit=1000", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }, timeoutMs)) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id).filter(Boolean);
  }
  const base = (providerBaseUrl(provider) ?? "").replace(/\/$/, "");
  const data = (await fetchModelList(provider, `${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  }, timeoutMs)) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id).filter(Boolean);
}

/**
 * A release stamp, not a version: an ISO date, a `YYYYMMDD`/`YYMMDD` run, or a
 * bare four-digit `YYMM` group (`mistral-medium-2604`, `ministral-14b-2512`,
 * `grok-4.20-multi-agent-0309`).
 *
 * Stripped before the version is read, because otherwise the FIRST number in
 * the id is the date: `mistral-medium-2604` scored 2604 and beat every real
 * Mistral Medium by three orders of magnitude, so the picker offered a dated
 * snapshot in place of the curated `-latest` alias — same model, worse id, and
 * the curated name/price/context lost with it.
 */
// Every alternative starts at the same place — the delimiter — on purpose.
// With a bare `\d{4}-\d{2}-\d{2}` first, the LAST alternative could begin one
// character earlier (at the `-` before the year), and JS takes the leftmost
// match whatever the alternation order says: `qwen-plus-2025-04-28` had only
// its year stripped, leaving `qwen-plus-04-28`, and the MONTH became the
// version. That scored 4.0 and beat every real Qwen Plus, so a dated snapshot
// went on outranking the canonical id — the exact bug this was added to kill.
const STAMP_SOURCE = /(?:^|[-_])\d{4}-\d{2}-\d{2}(?=$|[-_])|(?:^|[-_])\d{6,8}(?=$|[-_])|(?:^|[-_])\d{4}(?=$|[-_])/;
// Two objects on purpose: a /g regex carries `lastIndex` across .test() calls,
// so sharing one between the strip and the check makes every other call lie.
const STAMP_STRIP_RE = new RegExp(STAMP_SOURCE.source, "g");
const STAMP_RE = new RegExp(STAMP_SOURCE.source);

export function versionScore(bare: string): number {
  const v = bare.replace(STAMP_STRIP_RE, "").match(/(\d+(?:\.\d+)?)/);
  const ver = v ? parseFloat(v[1]) : 0;
  // Tiebreaks between ids of the same version, worst last. A dated snapshot is
  // the least canonical thing a provider serves — it is pinned to one build and
  // goes stale — so it loses to a preview and to an alias. `latest` is barely
  // penalised at all: for several labs (Mistral, Codestral) it IS the
  // documented id, and it is the one that keeps working after the next build.
  const penalty = STAMP_RE.test(bare) ? 0.002 : /preview|exp|snapshot/i.test(bare) ? 0.001 : /latest/i.test(bare) ? 0.0005 : 0;
  return ver - penalty;
}

export function toModelInfo(provider: Provider, rawId: string, fam?: Family): ModelInfo {
  const bareId = stripPrefix(rawId);
  const id = `${provider}:${bareId}`;
  const known = MODELS[id] ?? MODELS[`${provider}:${rawId}`];
  // The provider is still serving this id on its live API, so it is current
  // unless a curated entry says otherwise. Leaving these unset made every
  // consumer that reads `status !== "current"` treat a brand-new model as
  // legacy, which hid it in the pickers' collapsed legacy section.
  const status = known?.status ?? "current";
  return {
    id,
    provider,
    providerModel: bareId,
    name: prettifyModelName(rawId), // real model name with version (e.g. "GLM 5.2")
    // The product line, so `latestPerFamily` can see that this discovered model
    // and the curated entry it supersedes are the same thing. Curated wins:
    // discovery's rule is a guess about a model nobody has verified yet.
    family: known?.family ?? fam?.family,
    minPlan: fam?.minPlan ?? known?.minPlan ?? guessPlan(bareId),
    vision: fam?.vision ?? known?.vision ?? guessVision(bareId),
    reasoning: known?.reasoning ?? guessReasoning(bareId),
    // Curated wins, then the heuristic — the same precedence every other
    // capability here follows.
    agenticTools: known?.agenticTools ?? guessAgenticTools(rawId),
    cost: known?.cost ?? guessCost(rawId),
    modality: known?.modality ?? "chat",
    webSearch: providerSupportsWebSearch(provider),
    status,
    legacy: known?.legacy ?? status !== "current",
    // OpenAI serves its Codex and Pro lines on the Responses API only; a request
    // to /chat/completions is a hard 400. The curated entries say so with
    // `api`, but a discovered successor has nobody to say it for it — and since
    // that successor now WINS its family (it is the newer generation), getting
    // this wrong would replace a working GPT-5.3 Codex with an uncallable one.
    // Same rule the Swift side infers from the id
    // (JunoCodeBridge/BackendCodeModelClient.swift, CodeModelProviderResolver).
    api: known?.api ?? (provider === "openai" && /-codex|-pro$/i.test(rawId) ? "responses" : undefined),
  };
}

export function curate(provider: Provider, rawIds: string[]): ModelInfo[] {
  const items = rawIds.map((raw) => ({ raw, bare: stripPrefix(raw) })).filter((x) => !JUNK_RE.test(x.bare));
  const families = FAMILIES[provider];

  if (!families) {
    const seen = new Set<string>();
    return items
      .filter((x) => (seen.has(x.bare) ? false : (seen.add(x.bare), true)))
      .slice(0, 12)
      .map((x) => toModelInfo(provider, x.raw));
  }

  const out: ModelInfo[] = [];
  const used = new Set<string>();
  for (const fam of families) {
    const matches = items.filter((x) => fam.match.test(x.bare) && !used.has(x.raw));
    if (!matches.length) continue;
    const latest = matches.sort((a, b) => versionScore(b.bare) - versionScore(a.bare) || a.bare.length - b.bare.length)[0];
    used.add(latest.raw);
    out.push(toModelInfo(provider, latest.raw, fam));
  }
  return out;
}
