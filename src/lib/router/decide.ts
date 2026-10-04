/**
 * Auto Router 2.0 — the task-success router (BRIEF §25, §27, §49, §51).
 *
 * The old router asked one question: "what is the cheapest model above an
 * intelligence floor for this prompt?". That is the price of ONE call. What a
 * reader pays for a turn is the price of getting a good answer, which also
 * includes the tool rounds the model takes, the retries its provider forces,
 * and — when the answer is wrong — the cost of recovering: a regenerate on a
 * stronger model plus the reader's own time. So each candidate is scored as
 *
 *   expected_total = call
 *                  + expected_tool_rounds × round_cost
 *                  + expected_retries × call
 *                  + (1 − p_success) × recovery_cost
 *                  + expected_latency × value_of_a_second
 *
 * and the cheapest EXPECTED TOTAL wins. `p_success`, tool rounds and retries
 * start as priors from the catalogue (intelligence/speed/context/tool flags)
 * and move toward measured Alevr outcomes once a (model, task class) cell has
 * enough samples (evidence.ts).
 *
 * Hard filters come first and are never traded against price: plan, provider
 * configured, data-use terms (data-policy.ts), modality needs, context window,
 * the remaining budget, and provider availability.
 *
 * Pure. Every environmental fact (health, rate-limit pressure, tool probes,
 * evidence, budget) is an input, which is what makes every branch reachable
 * from a test and lets the eval harness replay decisions.
 */

import type { Plan } from "@prisma/client";
import {
  classifyPromptComplexity,
  pickAutoReasoningEffort,
  type PromptComplexity,
  type PromptComplexityResult,
} from "@/lib/auto-model";
import { MODEL_LIST, hasRetired, type ModelInfo } from "@/lib/models";
import { getModelMetrics, reasoningMultiplier, type ReasoningEffort } from "@/lib/model-metrics";
import { canUseModel } from "@/lib/plans";
import { isProviderConfigured } from "@/lib/providers";
import { autoDataUseVerdict, type AutoDataBoundary } from "@/lib/router/data-policy";
import { emptyEvidence, evidenceKey, posterior, type EvidenceTable } from "@/lib/router/evidence";
import { classifyTask, type TaskProfile } from "@/lib/router/task-class";

export const ROUTER_VERSION = 2;

export const AUTO_PREFERENCES = ["balanced", "quality", "economy"] as const;
export type AutoPreference = (typeof AUTO_PREFERENCES)[number];
export const DEFAULT_AUTO_PREFERENCE: AutoPreference = "balanced";
export function isAutoPreference(value: unknown): value is AutoPreference {
  return typeof value === "string" && (AUTO_PREFERENCES as readonly string[]).includes(value);
}

export type ToolVerdict = "verified" | "failed" | "untested";

export interface RouteInput {
  message: string;
  plan: Plan;
  hasImages?: boolean;
  wantsWebSearch?: boolean;
  /** Connectors / client tools offered to the model this turn. */
  toolsOffered?: number;
  /** Tokens already in the context (history + attachments), when known. */
  contextTokens?: number;
  preferCurrent?: boolean;
  /** The reader's Auto preference (Settings.autoPreference). */
  preference?: AutoPreference;
  /** The reader's Auto data boundary (Settings.autoDataBoundary). */
  boundary?: AutoDataBoundary;
  /** Providers the owner attested are on a paid (no-training) tier. */
  paidTier?: ReadonlySet<string>;
  evidence?: EvidenceTable;
  /** Provider currently answering (provider-health). Default: yes. */
  isProviderAvailable?: (provider: string) => boolean;
  /** Expected extra attempts from recent rate limits (provider-pressure). Default 0. */
  retryPressure?: (provider: string) => number;
  /** The tool round-trip probe verdict per model id. Default: untested. */
  toolVerdict?: (modelId: string) => ToolVerdict;
  /** Room left under the tightest budget that bounds this turn, micro-USD. Null = unbounded. */
  remainingBudgetMicroUsd?: number | null;
  /** Test seams. Default: the live catalogue and environment. */
  catalogue?: readonly ModelInfo[];
  isConfigured?: (provider: string) => boolean;
  canUse?: (plan: Plan, modelId: string) => boolean;
}

export type ExclusionReason =
  | "not_chat"
  | "unavailable_in_catalogue"
  | "provider_not_configured"
  | "not_in_plan"
  | "data_use_terms"
  | "needs_vision"
  | "needs_web_search"
  | "context_too_small"
  | "superseded"
  | "over_budget"
  | "provider_unavailable";

export interface CandidateScore {
  modelId: string;
  provider: string;
  name: string;
  effort: ReasoningEffort;
  pSuccess: number;
  expectedToolRounds: number;
  expectedRetries: number;
  callMicroUsd: number;
  toolRoundsMicroUsd: number;
  retriesMicroUsd: number;
  failureMicroUsd: number;
  latencyMicroUsd: number;
  expectedTotalMicroUsd: number;
  expectedLatencyS: number;
  /** True when measured Alevr outcomes moved the priors. */
  measured: boolean;
  samples: number;
}

export interface RouteDecision {
  model: ModelInfo;
  reasoningEffort: ReasoningEffort;
  complexity: PromptComplexityResult;
  profile: TaskProfile;
  /** "Selected for:" — short, in the receipt's voice, from this decision only. */
  reasons: string[];
  /** Every scored candidate, best first. */
  ranked: CandidateScore[];
  /** Same-quality alternates on OTHER providers, for a provider failure mid-turn. */
  alternates: ModelInfo[];
  /** How many models each hard filter removed. */
  excluded: Partial<Record<ExclusionReason, number>>;
  /** Set when a hard filter had to be relaxed to answer at all. */
  degraded: null | "all_providers_unavailable" | "over_budget";
  preference: AutoPreference;
  routerVersion: number;
}

export class NoAutoCandidateError extends Error {
  constructor(public readonly excluded: Partial<Record<ExclusionReason, number>>) {
    super(
      "Auto found no model it may use for this request: every configured model was excluded by plan, data-use terms or capability. Choose a model directly."
    );
    this.name = "NoAutoCandidateError";
  }
}

// ── Prior model ────────────────────────────────────────────────────────────

/** Minimum intelligence a task of this complexity asks for (the old router's floors). */
export const REQUIRED_INTELLIGENCE: Record<PromptComplexity, number> = {
  simple: 4,
  medium: 6,
  hard: 8,
  expert: 9,
};

/**
 * What one failed turn costs the reader, in micro-USD of their time and
 * attention: the regenerate, the rereading, the lost minutes. A product
 * judgement, written down so it can be argued with: half a cent for a quick
 * question, sixty cents for an expert one.
 */
export const FAILURE_TIME_COST_MICRO_USD: Record<PromptComplexity, number> = {
  simple: 5_000,
  medium: 40_000,
  hard: 200_000,
  expert: 600_000,
};

/** Value of a second of waiting, micro-USD. Everyday turns are latency-sensitive. */
function secondValue(profile: TaskProfile): number {
  return profile.taskClass === "everyday" ? 400 : profile.complexity === "simple" ? 250 : 80;
}

const PREFERENCE_WEIGHTS: Record<AutoPreference, { failure: number; latency: number }> = {
  balanced: { failure: 1, latency: 1 },
  quality: { failure: 3, latency: 0.5 },
  economy: { failure: 0.35, latency: 1 },
};

const EFFORT_INTEL_BOOST: Record<Exclude<ReasoningEffort, null>, number> = {
  minimal: 0.1,
  low: 0.25,
  medium: 0.5,
  high: 1,
  xhigh: 1.1,
  max: 1.2,
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const CODE_SPECIALIST = /(code|codestral|grok-build)/i;

/** Prior probability that this model, at this effort, gets this task right first time. */
export function priorSuccess(
  model: ModelInfo,
  effort: ReasoningEffort,
  profile: TaskProfile,
  toolVerdict: ToolVerdict = "untested"
): number {
  const metrics = getModelMetrics(model);
  let intel = metrics.intelligence + (effort ? EFFORT_INTEL_BOOST[effort] : 0);
  if (profile.needs.coding && CODE_SPECIALIST.test(model.providerModel)) intel += 1;
  const gap = intel - REQUIRED_INTELLIGENCE[profile.complexity];
  let p = 0.2 + 0.78 * sigmoid(1.1 * gap + 0.8);

  if (profile.needs.toolReliability) {
    if (!model.agenticTools) p *= 0.4;
    else if (toolVerdict === "failed") p *= 0.5;
    else if (toolVerdict === "verified") p = Math.min(0.99, p * 1.02);
  }
  if (profile.needs.structuredOutput && metrics.intelligence < 5) p *= 0.85;
  if ((profile.complexity === "hard" || profile.complexity === "expert") && !model.reasoning) p *= 0.8;
  if (profile.needs.longContext) {
    const ctx = model.contextWindow ?? metrics.contextTokens;
    if (ctx < profile.estInputTokens * 2) p *= 0.85;
  }
  return Math.max(0.01, Math.min(0.99, p));
}

/** µUSD for a call: tokens × $/MTok (the 10^6 factors cancel). */
function callCost(model: ModelInfo, profile: TaskProfile, effort: ReasoningEffort): number {
  const m = getModelMetrics(model);
  const out = profile.estOutputTokens * (model.reasoning ? reasoningMultiplier(effort) : 1);
  return Math.round(profile.estInputTokens * m.inputUsdPerMTok + out * m.outputUsdPerMTok);
}

/** Seconds to a complete answer, from the 1–10 speed grade. */
function expectedLatencySeconds(model: ModelInfo, profile: TaskProfile, effort: ReasoningEffort, rounds: number): number {
  const m = getModelMetrics(model);
  const tokPerSec = 25 + m.speed * 22;
  const thinking = model.reasoning ? reasoningMultiplier(effort) : 1;
  const ttft = 0.6 + (effort === "high" || effort === "xhigh" || effort === "max" ? 4 : effort ? 1.5 : 0);
  return ttft + (profile.estOutputTokens * thinking) / tokPerSec + rounds * 2.5;
}

// ── The decision ───────────────────────────────────────────────────────────

export function routeAuto(input: RouteInput): RouteDecision {
  const complexity = classifyPromptComplexity(input.message);
  const profile = classifyTask({
    message: input.message,
    complexity,
    hasImages: input.hasImages,
    wantsWebSearch: input.wantsWebSearch,
    toolsOffered: input.toolsOffered,
    contextTokens: input.contextTokens,
  });
  const preference = input.preference ?? DEFAULT_AUTO_PREFERENCE;
  const weights = PREFERENCE_WEIGHTS[preference];
  const catalogue = input.catalogue ?? MODEL_LIST;
  const isConfigured = input.isConfigured ?? ((p: string) => isProviderConfigured(p as never));
  const canUse = input.canUse ?? canUseModel;
  const available = input.isProviderAvailable ?? (() => true);
  const pressure = input.retryPressure ?? (() => 0);
  const evidence = input.evidence ?? emptyEvidence();
  const paidTier = input.paidTier ?? new Set<string>();

  const excluded: Partial<Record<ExclusionReason, number>> = {};
  const drop = (reason: ExclusionReason) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
    return false;
  };

  let pool = catalogue.filter((m) => {
    if (m.modality !== "chat") return drop("not_chat");
    if (m.comingSoon || m.status === "deprecated" || hasRetired(m)) return drop("unavailable_in_catalogue");
    if (!isConfigured(m.provider)) return drop("provider_not_configured");
    if (!canUse(input.plan, m.id)) return drop("not_in_plan");
    if (!autoDataUseVerdict(m, { paidTier, boundary: input.boundary }).eligible) return drop("data_use_terms");
    if (profile.needs.vision && !m.vision) return drop("needs_vision");
    if (input.wantsWebSearch && !m.webSearch) return drop("needs_web_search");
    const ctx = m.contextWindow ?? getModelMetrics(m).contextTokens;
    if (ctx < profile.estInputTokens * 1.1) return drop("context_too_small");
    return true;
  });

  if (pool.length === 0) throw new NoAutoCandidateError(excluded);

  if (input.preferCurrent !== false) {
    const current = pool.filter((m) => m.status === "current" || !m.status);
    if (current.length > 0) {
      excluded.superseded = pool.length - current.length;
      pool = current;
    }
  }

  let degraded: RouteDecision["degraded"] = null;
  const healthy = pool.filter((m) => available(m.provider));
  if (healthy.length > 0) {
    if (healthy.length < pool.length) excluded.provider_unavailable = pool.length - healthy.length;
    pool = healthy;
  } else {
    // Every eligible provider is reported down. A provider that might be
    // recovering beats refusing outright — the turn's own error says so if not.
    degraded = "all_providers_unavailable";
  }

  // Score every candidate at the effort Auto would give it.
  const scored = pool.map((model) => {
    const effort = pickAutoReasoningEffort(model, complexity);
    const prior = {
      success: priorSuccess(model, effort, profile, input.toolVerdict?.(model.id)),
      toolRounds: profile.priorToolRounds,
      retries: 0.02 + pressure(model.provider),
    };
    const post = posterior(evidence.get(evidenceKey(model.id, profile.taskClass)), prior);
    // Measured retries are historical; current pressure still applies on top.
    const retries = post.measured ? post.retries + pressure(model.provider) : post.retries;
    const call = callCost(model, profile, effort);
    // A tool round re-sends the grown context (largely cached) and reads a short
    // reply: about 45% of a full call.
    const toolRoundsMicroUsd = Math.round(post.toolRounds * call * 0.45);
    const retriesMicroUsd = Math.round(retries * call);
    const latencyS = expectedLatencySeconds(model, profile, effort, post.toolRounds);
    return { model, effort, post, retries, call, toolRoundsMicroUsd, retriesMicroUsd, latencyS };
  });

  // Recovery = asking again on the strongest candidate, plus the reader's time.
  const strongest = scored.reduce((best, s) => (s.post.success > best.post.success ? s : best), scored[0]);
  const recovery = strongest.call + FAILURE_TIME_COST_MICRO_USD[profile.complexity] * weights.failure;

  let ranked: CandidateScore[] = scored
    .map((s) => {
      const failureMicroUsd = Math.round((1 - s.post.success) * recovery);
      const latencyMicroUsd = Math.round(s.latencyS * secondValue(profile) * weights.latency);
      const total = s.call + s.toolRoundsMicroUsd + s.retriesMicroUsd + failureMicroUsd + latencyMicroUsd;
      return {
        modelId: s.model.id,
        provider: s.model.provider,
        name: s.model.name,
        effort: s.effort,
        pSuccess: round3(s.post.success),
        expectedToolRounds: round3(s.post.toolRounds),
        expectedRetries: round3(s.retries),
        callMicroUsd: s.call,
        toolRoundsMicroUsd: s.toolRoundsMicroUsd,
        retriesMicroUsd: s.retriesMicroUsd,
        failureMicroUsd,
        latencyMicroUsd,
        expectedTotalMicroUsd: total,
        expectedLatencyS: Math.round(s.latencyS * 10) / 10,
        measured: s.post.measured,
        samples: s.post.n,
      } satisfies CandidateScore;
    })
    .sort(
      (a, b) =>
        a.expectedTotalMicroUsd - b.expectedTotalMicroUsd ||
        b.pSuccess - a.pSuccess ||
        a.modelId.localeCompare(b.modelId)
    );

  // Budget: the expected spend of the turn itself must fit what is left.
  const remaining = input.remainingBudgetMicroUsd;
  if (remaining != null) {
    const fits = ranked.filter((c) => c.callMicroUsd + c.toolRoundsMicroUsd <= remaining);
    if (fits.length > 0) {
      if (fits.length < ranked.length) excluded.over_budget = ranked.length - fits.length;
      ranked = fits;
    } else {
      // Nothing fits the estimate; the cheapest call is the honest attempt and
      // the spend gate downstream decides whether it may run at all.
      ranked = [...ranked].sort((a, b) => a.callMicroUsd - b.callMicroUsd);
      degraded = degraded ?? "over_budget";
    }
  }

  const winner = ranked[0];
  const model = pool.find((m) => m.id === winner.modelId)!;

  const alternates: ModelInfo[] = [];
  for (const c of ranked.slice(1)) {
    if (c.provider === model.provider || alternates.some((a) => a.provider === c.provider)) continue;
    if (c.pSuccess < winner.pSuccess - 0.1) continue;
    const alt = pool.find((m) => m.id === c.modelId);
    if (alt) alternates.push(alt);
    if (alternates.length >= 2) break;
  }

  return {
    model,
    reasoningEffort: winner.effort,
    complexity,
    profile,
    reasons: decisionReasons(profile, winner, ranked, degraded),
    ranked,
    alternates,
    excluded,
    degraded,
    preference,
    routerVersion: ROUTER_VERSION,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * "Selected for:" lines. Built only from this decision — the task signals it
 * acted on and the comparison it made — never from a template that would read
 * the same whatever happened.
 */
export function decisionReasons(
  profile: TaskProfile,
  winner: CandidateScore,
  ranked: CandidateScore[],
  degraded: RouteDecision["degraded"]
): string[] {
  const reasons = profile.signals.slice(0, 3);
  const cheapestCall = ranked.reduce((min, c) => Math.min(min, c.callMicroUsd), Infinity);
  if (ranked.length > 1) {
    // "Outweigh a cheaper model" only when the pick really costs more per call;
    // a pick near the cheapest is simply the cheapest good answer.
    if (winner.callMicroUsd > cheapestCall * 1.5 && winner.callMicroUsd - cheapestCall > 200) {
      reasons.push("better odds of a first-try answer outweigh a cheaper model");
    } else {
      reasons.push(`lowest expected cost of ${ranked.length} eligible models`);
    }
  }
  if (winner.measured) reasons.push(`measured on ${winner.samples} similar Alevr turns`);
  if (degraded === "over_budget") reasons.push("kept within your remaining budget");
  return reasons.slice(0, 4);
}
