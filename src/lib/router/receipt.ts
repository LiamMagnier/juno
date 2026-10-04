/**
 * Auto's receipt on an assistant turn (BRIEF §27).
 *
 *   Auto · Claude Opus 5.5 · High
 *
 * and, on click or focus, "Selected for:" with the reasons the decision record
 * gave. Stored on `Message.routing` so a reload shows the same receipt the
 * live turn did; built only from a `RouteDecision`, so it can never claim a
 * reason the router did not act on.
 *
 * Client-safe: no server imports. The model's display name is resolved from
 * `Message.model` by the renderer, not stored twice.
 */

import type { ReasoningEffort } from "@/lib/model-metrics";
import { isTaskClass, type TaskClass } from "@/lib/router/task-class";

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
}

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

export function receiptFromDecision(decision: {
  reasoningEffort: ReasoningEffort;
  profile: { taskClass: TaskClass };
  reasons: string[];
  degraded: RoutingReceipt["degraded"];
}): RoutingReceipt {
  return {
    v: 1,
    effort: decision.reasoningEffort,
    taskClass: decision.profile.taskClass,
    reasons: decision.reasons.slice(0, 4),
    degraded: decision.degraded ?? null,
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
  return { v: 1, effort, taskClass: r.taskClass, reasons, degraded, rerouted };
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
