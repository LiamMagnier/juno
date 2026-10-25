/**
 * Auto's receipt on an assistant turn (BRIEF §27, master brief Part 4.2).
 *
 *   Auto · Claude Opus 5.5 · High
 *
 * and, on click or focus, one plain sentence on why ("Complex coding, so Auto
 * chose a stronger model with High thinking.") above "Selected for:" with the
 * reasons the decision record gave. Stored on `Message.routing` so a reload
 * shows the same receipt the live turn did; built only from a `RouteDecision`,
 * so it can never claim a reason the router did not act on.
 *
 * `factors` is the internal half: every fact the decision turned on (the
 * selected model, task class, complexity, modality, tools needed, context
 * size, provider health, cost and latency tier, plan, preference, how many
 * models competed, and whether measured Alevr outcomes moved the pick). The
 * sentence is derived from it, so the two cannot disagree. Receipts written
 * before `factors` existed parse without it and show only their reasons.
 *
 * Client-safe: no server imports. The model's display name is resolved from
 * `Message.model` by the renderer, not stored twice.
 */

import type { ReasoningEffort } from "@/lib/model-metrics";
import { isTaskClass, type TaskClass } from "@/lib/router/task-class";

export type ReceiptComplexity = "simple" | "medium" | "hard" | "expert";
export type ReceiptTier = "low" | "medium" | "high";
export type ReceiptLatencyTier = "fast" | "standard" | "slow";
export type ReceiptEvidenceSource = "prior" | "measured" | "reliability";
export type ReceiptChoice = "lowest_cost" | "better_odds" | "only_option";
export type RerouteReason = "unreachable" | "capacity";

/** Every fact the decision turned on. Internal: the UI shows `receiptSummary`, never these numbers. */
export interface RoutingFactors {
  /** The model the router selected. `Message.model` answered; they differ only when the receipt says `rerouted`. */
  selected: string;
  /** The difficulty the router acted on (raised a step for agentic and long-context stakes). */
  complexity: ReceiptComplexity;
  /** What the turn takes in and what it must give back. */
  modality: { input: "text" | "text_image"; output: "text" | "image" };
  /** Tools the turn needed from the model. */
  tools: { webSearch: boolean; imageGeneration: boolean; connectors: number; reliable: boolean };
  /** Tokens the router estimated the turn would send (history, files, project, system, tool schemas). */
  contextTokens: number;
  /** Providers reported down when Auto chose, and the rate-limit pressure on the answering provider (0–1). */
  providerHealth: { down: string[]; retryPressure: number };
  /** The answering model's catalogue price tier, and the turn's expected spend (call, tool rounds, retries). */
  cost: { tier: ReceiptTier; expectedMicroUsd: number };
  /** Seconds to a complete answer the router expected, and its tier. */
  latency: { tier: ReceiptLatencyTier; expectedS: number };
  /** The account's plan when Auto chose. */
  plan: string;
  /** The reader's Auto preference (balanced, quality, economy). */
  preference: string;
  /** Models that passed every hard filter and were scored. */
  candidates: number;
  /**
   * How the pick relates to the field: the lowest expected total cost, a
   * pricier model whose first-try odds outweighed a cheaper one, or the only
   * model that passed the filters.
   */
  choice: ReceiptChoice;
  /** Estimated first-try success odds for the answering model (0–1). */
  pSuccess: number;
  /**
   * Where the answering model's odds came from: catalogue priors, measured
   * outcomes on this task class, or its measured error rate across classes.
   * `shiftedFrom` names the model the priors alone would have chosen, when
   * measured outcomes changed the pick.
   */
  evidence: { source: ReceiptEvidenceSource; samples: number; shiftedFrom: string | null };
  /** Under 10% of the month's budget was left, so Auto kept to cost-1 models. */
  budgetSaver: boolean;
  routerVersion: number;
}

export interface RoutingReceipt {
  v: 1;
  /** Thinking effort Auto chose; null = Instant / no extra reasoning. */
  effort: ReasoningEffort;
  taskClass: TaskClass;
  /** "Selected for:" lines, at most four. */
  reasons: string[];
  /** Set when Auto had to answer with a relaxed rule (see RouteDecision.degraded). */
  degraded?: "all_providers_unavailable" | "over_budget" | null;
  /** Set when the pick was replaced after routing (provider down, platform budget). */
  rerouted?: string | null;
  /**
   * Why it was replaced: the pick could not be reached (provider down, not
   * routable here), or the platform's daily capacity sent Auto to a cheaper one.
   */
  rerouteReason?: RerouteReason | null;
  /**
   * The image model that made this answer's picture (`generate_image`, G04),
   * and whether Auto chose it or the person named it.
   */
  image?: { model: string; name: string; auto: boolean } | null;
  /** The decision's inputs and outcome. Absent on receipts written before it existed. */
  factors?: RoutingFactors | null;
}

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const COMPLEXITIES = new Set<ReceiptComplexity>(["simple", "medium", "hard", "expert"]);
const TIERS = new Set<ReceiptTier>(["low", "medium", "high"]);
const LATENCY_TIERS = new Set<ReceiptLatencyTier>(["fast", "standard", "slow"]);
const SOURCES = new Set<ReceiptEvidenceSource>(["prior", "measured", "reliability"]);
const CHOICES = new Set<ReceiptChoice>(["lowest_cost", "better_odds", "only_option"]);

/** The catalogue's 1–3 price tier, in words. */
export function costTierOf(cost: number): ReceiptTier {
  return cost <= 1 ? "low" : cost === 2 ? "medium" : "high";
}

/** A complete answer in under 6 s reads as fast; 20 s and over as slow. */
export function latencyTierOf(seconds: number): ReceiptLatencyTier {
  return seconds < 6 ? "fast" : seconds < 20 ? "standard" : "slow";
}

/** The slice of a scored candidate a receipt needs (decide.ts `CandidateScore`). */
export interface ReceiptCandidate {
  modelId: string;
  costTier: number;
  pSuccess: number;
  callMicroUsd: number;
  toolRoundsMicroUsd: number;
  retriesMicroUsd: number;
  expectedLatencyS: number;
  retryPressure: number;
  evidence: ReceiptEvidenceSource;
  samples: number;
}

export interface ReceiptSource {
  reasoningEffort: ReasoningEffort;
  profile: { taskClass: TaskClass };
  reasons: string[];
  degraded: RoutingReceipt["degraded"];
  factors?: RoutingFactors | null;
  ranked?: readonly ReceiptCandidate[];
}

/**
 * The receipt for a decision. `answeringModelId` is the model that actually
 * answers when it is not the router's pick (a reroute): the per-model facts —
 * cost, latency, odds, evidence, rate-limit pressure — are then that model's
 * own scored row, so the receipt never describes a model that did not answer.
 * `selected` keeps the router's pick.
 */
export function receiptFromDecision(decision: ReceiptSource, answeringModelId?: string | null): RoutingReceipt {
  return {
    v: 1,
    effort: decision.reasoningEffort,
    taskClass: decision.profile.taskClass,
    reasons: decision.reasons.slice(0, 4),
    degraded: decision.degraded ?? null,
    ...(decision.factors ? { factors: factorsForAnswer(decision.factors, decision.ranked, answeringModelId) } : {}),
  };
}

function factorsForAnswer(
  factors: RoutingFactors,
  ranked: readonly ReceiptCandidate[] | undefined,
  answeringModelId: string | null | undefined
): RoutingFactors {
  if (!answeringModelId || answeringModelId === factors.selected) return factors;
  const row = ranked?.find((candidate) => candidate.modelId === answeringModelId);
  if (!row) return factors;
  return {
    ...factors,
    providerHealth: { ...factors.providerHealth, retryPressure: round2(row.retryPressure) },
    cost: {
      tier: costTierOf(row.costTier),
      expectedMicroUsd: row.callMicroUsd + row.toolRoundsMicroUsd + row.retriesMicroUsd,
    },
    latency: { tier: latencyTierOf(row.expectedLatencyS), expectedS: row.expectedLatencyS },
    pSuccess: row.pSuccess,
    // A substitute was not chosen on price or odds against the field.
    choice: "only_option",
    // The evidence shift explained the router's pick, not the substitute's.
    evidence: { source: row.evidence, samples: row.samples, shiftedFrom: null },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const num = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Read stored factors defensively; any malformed field drops the whole block (a half-true record is worse than none). */
export function parseRoutingFactors(raw: unknown): RoutingFactors | null {
  const f = record(raw);
  if (!f) return null;
  const modality = record(f.modality);
  const tools = record(f.tools);
  const health = record(f.providerHealth);
  const cost = record(f.cost);
  const latency = record(f.latency);
  const evidence = record(f.evidence);
  if (!modality || !tools || !health || !cost || !latency || !evidence) return null;
  const contextTokens = num(f.contextTokens);
  const connectors = num(tools.connectors);
  const retryPressure = num(health.retryPressure, 0, 1);
  const expectedMicroUsd = num(cost.expectedMicroUsd);
  const expectedS = num(latency.expectedS);
  const candidates = num(f.candidates);
  const pSuccess = num(f.pSuccess, 0, 1);
  const samples = num(evidence.samples);
  const routerVersion = num(f.routerVersion);
  if (
    typeof f.selected !== "string" ||
    !COMPLEXITIES.has(f.complexity as ReceiptComplexity) ||
    (modality.input !== "text" && modality.input !== "text_image") ||
    (modality.output !== "text" && modality.output !== "image") ||
    typeof tools.webSearch !== "boolean" ||
    typeof tools.imageGeneration !== "boolean" ||
    typeof tools.reliable !== "boolean" ||
    connectors == null ||
    contextTokens == null ||
    !Array.isArray(health.down) ||
    retryPressure == null ||
    !TIERS.has(cost.tier as ReceiptTier) ||
    expectedMicroUsd == null ||
    !LATENCY_TIERS.has(latency.tier as ReceiptLatencyTier) ||
    expectedS == null ||
    typeof f.plan !== "string" ||
    typeof f.preference !== "string" ||
    candidates == null ||
    !CHOICES.has(f.choice as ReceiptChoice) ||
    pSuccess == null ||
    !SOURCES.has(evidence.source as ReceiptEvidenceSource) ||
    samples == null ||
    (evidence.shiftedFrom !== null && typeof evidence.shiftedFrom !== "string") ||
    typeof f.budgetSaver !== "boolean" ||
    routerVersion == null
  ) {
    return null;
  }
  return {
    selected: f.selected,
    complexity: f.complexity as ReceiptComplexity,
    modality: { input: modality.input, output: modality.output },
    tools: { webSearch: tools.webSearch, imageGeneration: tools.imageGeneration, connectors, reliable: tools.reliable },
    contextTokens,
    providerHealth: {
      down: health.down.filter((p): p is string => typeof p === "string").slice(0, 20),
      retryPressure,
    },
    cost: { tier: cost.tier as ReceiptTier, expectedMicroUsd },
    latency: { tier: latency.tier as ReceiptLatencyTier, expectedS },
    plan: f.plan,
    preference: f.preference,
    candidates,
    choice: f.choice as ReceiptChoice,
    pSuccess,
    evidence: {
      source: evidence.source as ReceiptEvidenceSource,
      samples,
      shiftedFrom: (evidence.shiftedFrom as string | null) ?? null,
    },
    budgetSaver: f.budgetSaver,
    routerVersion,
  };
}

/** Read a stored receipt defensively; anything malformed reads as "no receipt". */
export function parseRoutingReceipt(raw: unknown): RoutingReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !isTaskClass(r.taskClass) || !Array.isArray(r.reasons)) return null;
  const effort = typeof r.effort === "string" && EFFORTS.has(r.effort) ? (r.effort as ReasoningEffort) : null;
  const reasons = r.reasons.filter((x): x is string => typeof x === "string").slice(0, 4);
  const degraded =
    r.degraded === "all_providers_unavailable" || r.degraded === "over_budget" ? r.degraded : null;
  const rerouted = typeof r.rerouted === "string" ? r.rerouted : null;
  const rerouteReason =
    rerouted && (r.rerouteReason === "unreachable" || r.rerouteReason === "capacity") ? r.rerouteReason : null;
  const imageRaw = r.image && typeof r.image === "object" && !Array.isArray(r.image) ? (r.image as Record<string, unknown>) : null;
  const image =
    imageRaw && typeof imageRaw.model === "string" && typeof imageRaw.name === "string"
      ? { model: imageRaw.model, name: imageRaw.name, auto: imageRaw.auto !== false }
      : null;
  const factors = parseRoutingFactors(r.factors);
  return {
    v: 1,
    effort,
    taskClass: r.taskClass,
    reasons,
    degraded,
    rerouted,
    ...(rerouteReason ? { rerouteReason } : {}),
    ...(image ? { image } : {}),
    ...(factors ? { factors } : {}),
  };
}

const EFFORT_LABEL: Record<Exclude<ReasoningEffort, null>, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(effort: ReasoningEffort): string {
  return effort ? EFFORT_LABEL[effort] : "Instant";
}

/** "Auto · Claude Opus 5.5 · High" — the one line, in one place. */
export function receiptLine(modelName: string, receipt: RoutingReceipt): string {
  return `Auto · ${modelName} · ${effortLabel(receipt.effort)}`;
}

/**
 * What Auto chose, in words the factors support: "more likely to get it right
 * first time" only when it paid more per call for those odds (a bigger model
 * or more thinking — the factor does not say which, so neither does this);
 * "fast" and "low-cost" only when the latency and price tiers say so;
 * otherwise "the best-value model" (the lowest expected total cost, which is
 * what the router computes).
 */
function choicePhrase(f: RoutingFactors): string {
  if (f.choice === "better_odds") return "a model more likely to get it right first time";
  if (f.choice === "only_option") return "the only model that fit";
  const words = [f.latency.tier === "fast" ? "fast" : null, f.cost.tier === "low" ? "low-cost" : null].filter(Boolean);
  return words.length ? `a ${words.join(", ")} model` : "the best-value model";
}

function thinkingClause(effort: ReasoningEffort): string {
  return effort && effort !== "minimal" && effort !== "low" ? `, with ${effortLabel(effort)} thinking` : "";
}

/**
 * One plain sentence on why Auto answered this turn the way it did, for the
 * person reading it — built from the stored factors and the receipt's own
 * flags, never a template that reads the same whatever happened. No scores,
 * no prices, no model internals, and no claim about a model the router did
 * not act on: a capability is named only where it was a hard filter (vision,
 * web search, the image tool, a context window), and a trade-off only as the
 * `choice` factor records it. Null for a receipt without factors (written
 * before they existed): the reasons list still shows.
 *
 * Precedence follows what most changed the outcome: a replacement or a relaxed
 * rule first, then a hard need (an image to make or read, a long context, the
 * web, connected apps), then the kind of task.
 */
export function receiptSummary(receipt: RoutingReceipt): string | null {
  const f = receipt.factors;
  if (!f) return null;
  const sentences: string[] = [];

  if (receipt.rerouted) {
    sentences.push(
      receipt.rerouteReason === "capacity"
        ? "Auto switched to a lower-cost model to stay within today's capacity."
        : "Auto's first choice couldn't be reached, so the next best model answered."
    );
  } else if (receipt.degraded === "over_budget") {
    sentences.push("Auto chose the model that fits what's left of your budget.");
  } else if (receipt.degraded === "all_providers_unavailable") {
    sentences.push("Every eligible provider was reporting trouble, so Auto used the best one it had.");
  } else if (f.budgetSaver) {
    sentences.push("Your monthly budget is nearly used, so Auto kept to a low-cost model.");
  } else {
    sentences.push(needSentence(receipt, f));
  }

  if (f.evidence.shiftedFrom && !receipt.rerouted) {
    sentences.push("Results on similar Alevr requests tipped the choice.");
  }
  if (f.providerHealth.down.length > 0 && !receipt.rerouted && receipt.degraded !== "all_providers_unavailable") {
    sentences.push(
      f.providerHealth.down.length === 1
        ? "It skipped a provider that was having trouble."
        : "It skipped providers that were having trouble."
    );
  }
  return sentences.join(" ");
}

function needSentence(receipt: RoutingReceipt, f: RoutingFactors): string {
  const hard = f.complexity === "hard" || f.complexity === "expert";
  const thinking = thinkingClause(receipt.effort);
  const chose = choicePhrase(f);
  // Hard filters: the capability named is one every candidate had to have.
  if (f.modality.output === "image") return "You asked for a picture, so Auto chose a model that can make one with the image tool.";
  if (f.modality.input === "text_image") return `Your message includes an image, so Auto chose a model that can read it${thinking}.`;
  if (receipt.taskClass === "long_context") {
    const k = Math.max(1, Math.round(f.contextTokens / 1000));
    return `This conversation is long (about ${k.toLocaleString("en-US")}k tokens), so Auto chose a model with room for all of it.`;
  }
  if (f.tools.webSearch) return `This needs current information, so Auto chose a model that can search the web${thinking}.`;
  // Weighed, not filtered: the sentence says so.
  if (receipt.taskClass === "agentic") return "This acts through your connected apps, so Auto weighed how reliably each model uses tools.";
  switch (receipt.taskClass) {
    case "coding":
      return `${hard ? "Complex coding" : "A coding question"}, so Auto chose ${chose}${thinking}.`;
    case "research":
      return `A research question, so Auto chose ${chose}${thinking}.`;
    case "reasoning":
      return `This needs ${hard ? "careful" : "some"} reasoning, so Auto chose ${chose}${thinking}.`;
    case "structured_output":
      return `This needs an exact format, so Auto chose ${chose}${thinking}.`;
    case "writing":
      return `${hard ? "A demanding writing task" : "A writing task"}, so Auto chose ${chose}${thinking}.`;
    case "vision":
      return "This involves an image, so Auto chose a model that can read it.";
    default:
      return `A quick everyday question, so Auto chose ${chose}.`;
  }
}
