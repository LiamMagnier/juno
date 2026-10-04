/**
 * What each plan buys, as rows the plans page can compare (src/components/
 * billing/upgrade-view.tsx). Every row restates a flag or a figure the product
 * already enforces in plans.ts, so the page cannot promise what a plan does
 * not do. Pure and client-safe.
 */
import type { Plan } from "@prisma/client";
import { PLANS, planRank } from "@/lib/plans";

export interface CapabilityRow {
  id: string;
  label: string;
  /** Whether this plan has it at all. */
  has: boolean;
  /** How strong this plan's version is, to tell an upgrade from a sidestep. */
  level: number;
}

const MODEL_LABEL = ["Fast models: Claude Haiku, GPT-6 Luna, Gemini Flash-Lite", "Everyday models: Claude Sonnet, Gemini Flash, GLM", "Every model: Claude Opus, GPT-6, Gemini Pro"];

function modelLevel(plan: Plan): number {
  if (plan === "FREE") return 0;
  if (plan === "LITE") return 1;
  return 2;
}

function priorityLevel(plan: Plan): number {
  if (planRank(plan) >= planRank("MAX")) return 2;
  if (plan === "PLUS") return 1;
  return 0;
}

/** "5× Pro", "2.5× Pro", "Pro usage", or the Free allowance. */
export function usageLabel(plan: Plan): string {
  const multiple = PLANS[plan].usageVsPro;
  if (multiple == null) return "No usage cap";
  if (plan === "FREE") return "A small monthly allowance";
  if (multiple === 1) return "Pro usage every month";
  return `${multiple < 1 ? "About half of" : `${multiple}×`} Pro usage every month`;
}

/** The rows a plan has, strongest first, in the order a person weighs them. */
export function planCapabilities(plan: Plan): CapabilityRow[] {
  const config = PLANS[plan];
  const rows: CapabilityRow[] = [
    { id: "models", label: MODEL_LABEL[modelLevel(plan)], has: true, level: modelLevel(plan) },
    { id: "usage", label: usageLabel(plan), has: true, level: config.usageVsPro ?? Infinity },
    { id: "search", label: "Web search", has: config.webSearch, level: 1 },
    { id: "research", label: "Deep Field research", has: config.research, level: 1 },
    { id: "code", label: "Alevr Code", has: config.code, level: 1 },
    { id: "agents", label: "Orbit agents and background work", has: config.agents, level: 1 },
    { id: "voice", label: "Voice mode", has: config.voice, level: 1 },
    {
      id: "priority",
      label: priorityLevel(plan) === 2 ? "Highest priority when it is busy" : "Higher priority when it is busy",
      has: priorityLevel(plan) > 0,
      level: priorityLevel(plan),
    },
    { id: "uploads", label: `Files up to ${config.maxUploadMb} MB`, has: true, level: config.maxUploadMb },
    { id: "memory", label: "Memory, canvas and artifacts", has: config.canvas, level: 1 },
  ];
  return rows.filter((row) => row.has);
}

export interface CapabilityChange extends CapabilityRow {
  /** New or stronger than what `from` has. */
  gained: boolean;
}

/** `to`'s rows, each marked when it is new or stronger than `from`'s. */
export function capabilityChanges(from: Plan, to: Plan): CapabilityChange[] {
  const before = new Map(planCapabilities(from).map((row) => [row.id, row]));
  return planCapabilities(to).map((row) => {
    const had = before.get(row.id);
    return { ...row, gained: !had || row.level > had.level };
  });
}

/** What `from` has that `to` does not: what a downgrade gives up. */
export function capabilitiesLost(from: Plan, to: Plan): CapabilityRow[] {
  const after = new Map(planCapabilities(to).map((row) => [row.id, row]));
  return planCapabilities(from).filter((row) => {
    const kept = after.get(row.id);
    return !kept || kept.level < row.level;
  });
}
