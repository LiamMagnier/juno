/**
 * The Orchestrate (role) picker's model (DESIGN §5.11; SPEC §3.4, §4):
 * presets → `RoleRouting`, the estimate line, the budget field, and which
 * roles spend Alevr money (subscription roles count against the vendor plan,
 * not the budget).
 */
import { instanceKindOf, type ModelSelection, type RolePreset, type RoleRouting } from "@/lib/code-v2/contracts";

export const PRESET_LABELS: Record<RolePreset, string> = {
  solo: "Solo",
  "lead-workers": "Lead + workers",
  "best-of-n": "Best of N",
};

export const PRESET_SENTENCES: Record<RolePreset, string> = {
  solo: "One model does the whole run. Simple, and the cheapest.",
  "lead-workers":
    "The lead plans and delegates. Workers run in parallel, each on its own branch of the plan. The reviewer reads every diff before you do.",
  "best-of-n": "The same prompt runs once per candidate, each in its own worktree. You compare them and keep one.",
};

export const ROLE_COPY = {
  lead: { name: "Lead", duty: "Plans, delegates, writes the summary" },
  workers: { name: "Workers", duty: "Up to {n} at once" },
  reviewer: { name: "Reviewer", duty: "Reads each diff, can send it back once" },
  explorer: { name: "Explorer", duty: "Searches the repo and the web, read-only" },
  candidates: { name: "Candidates", duty: "Each runs in its own worktree" },
  utility: { name: "Titles and compaction", duty: "" },
} as const;

export const WORKERS_MIN = 1;
export const WORKERS_MAX = 6;
export const CANDIDATES_MIN = 2;
export const CANDIDATES_MAX = 4;
export const DEFAULT_BUDGET_USD = 4;

/** Short control label: "Solo", "Lead + 3", "Best of 3". */
export function orchestrateLabel(routing: RoleRouting | undefined): string {
  if (!routing || routing.preset === "solo") return "Solo";
  const n = routing.workers?.length ?? 0;
  return routing.preset === "best-of-n" ? `Best of ${Math.max(CANDIDATES_MIN, n)}` : `Lead + ${n}`;
}

/** Switch preset, keeping the lead and any role models already chosen. */
export function withPreset(routing: RoleRouting, preset: RolePreset): RoleRouting {
  const lead = routing.orchestrator;
  if (preset === "solo") return { orchestrator: lead, preset, budget: routing.budget };
  const workerModel = routing.workers?.[0] ?? lead;
  if (preset === "lead-workers") {
    const count = clampCount(routing.workers?.length ?? 3, WORKERS_MIN, WORKERS_MAX) || 3;
    return {
      ...routing,
      preset,
      workers: Array.from({ length: count }, (_, i) => routing.workers?.[i] ?? workerModel),
      reviewer: routing.reviewer ?? lead,
      budget: routing.budget ?? { maxUsd: DEFAULT_BUDGET_USD },
    };
  }
  const count = clampCount(routing.workers?.length ?? 3, CANDIDATES_MIN, CANDIDATES_MAX);
  return {
    orchestrator: lead,
    preset,
    workers: Array.from({ length: count }, (_, i) => routing.workers?.[i] ?? lead),
    reviewer: routing.reviewer,
    budget: routing.budget ?? { maxUsd: DEFAULT_BUDGET_USD },
  };
}

function clampCount(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Change the worker / candidate count; new slots copy the first slot's model. */
export function withCount(routing: RoleRouting, count: number): RoleRouting {
  if (routing.preset === "solo") return routing;
  const [min, max] = routing.preset === "best-of-n" ? [CANDIDATES_MIN, CANDIDATES_MAX] : [WORKERS_MIN, WORKERS_MAX];
  const n = clampCount(count, min, max);
  const first = routing.workers?.[0] ?? routing.orchestrator;
  return { ...routing, workers: Array.from({ length: n }, (_, i) => routing.workers?.[i] ?? first) };
}

export type RoleSlot = "orchestrator" | "workers" | "reviewer" | "explorer" | "compaction" | { candidate: number };

/** Set one role's model. For workers, every worker takes it (one model per role). */
export function withRoleModel(routing: RoleRouting, slot: RoleSlot, selection: ModelSelection): RoleRouting {
  if (typeof slot === "object") {
    const workers = [...(routing.workers ?? [])];
    workers[slot.candidate] = selection;
    return { ...routing, workers };
  }
  if (slot === "workers") return { ...routing, workers: (routing.workers ?? [selection]).map(() => selection) };
  return { ...routing, [slot]: selection };
}

/** Parse the budget field ("$4", "4.50", "") → USD or undefined (no budget). */
export function parseBudget(text: string): number | undefined | null {
  const t = text.replace(/[$,\s]/g, "");
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

export function formatBudget(usd: number | undefined): string {
  return usd === undefined ? "" : `$${usd.toFixed(2)}`;
}

/** Whether a role's model spends Alevr money (alevr instance). BYOK and subscriptions do not count. */
export function countsAgainstBudget(selection: ModelSelection): boolean {
  return instanceKindOf(selection.instanceId) === "alevr";
}

export function isSubscription(selection: ModelSelection): boolean {
  const k = instanceKindOf(selection.instanceId);
  return k === "claude-agent" || k === "codex" || k === "acp";
}

/** Price lookup for an Alevr/BYOK model: $ per MTok in / out. */
export type RateLookup = (selection: ModelSelection) => { inputPerMTok: number; outputPerMTok: number } | undefined;

/** Typical token use per role per run (an estimate, labelled as such in the UI). */
export const ROLE_TOKEN_PROFILE = {
  orchestrator: { input: 180_000, output: 9_000 },
  worker: { input: 120_000, output: 7_000 },
  reviewer: { input: 60_000, output: 2_500 },
  explorer: { input: 50_000, output: 2_000 },
} as const;

/**
 * Estimated Alevr spend for one run with this routing. Subscription and BYOK
 * roles cost 0 here (they bill elsewhere). Returns the estimate and whether
 * any role is on a subscription (for the footer's second line).
 */
export function estimateRunUsd(routing: RoleRouting, rates: RateLookup): { usd: number; subscriptionRoles: boolean; byokRoles: boolean } {
  let usd = 0;
  let subscriptionRoles = false;
  let byokRoles = false;
  const add = (sel: ModelSelection | undefined, profile: { input: number; output: number }) => {
    if (!sel) return;
    if (isSubscription(sel)) {
      subscriptionRoles = true;
      return;
    }
    if (instanceKindOf(sel.instanceId) === "byok") {
      byokRoles = true;
      return;
    }
    const r = rates(sel);
    if (!r) return;
    usd += (profile.input * r.inputPerMTok + profile.output * r.outputPerMTok) / 1_000_000;
  };
  add(routing.orchestrator, ROLE_TOKEN_PROFILE.orchestrator);
  if (routing.preset !== "solo") {
    for (const w of routing.workers ?? []) add(w, routing.preset === "best-of-n" ? ROLE_TOKEN_PROFILE.orchestrator : ROLE_TOKEN_PROFILE.worker);
    add(routing.reviewer, ROLE_TOKEN_PROFILE.reviewer);
    add(routing.explorer, ROLE_TOKEN_PROFILE.explorer);
  }
  return { usd: Math.round(usd * 100) / 100, subscriptionRoles, byokRoles };
}

/** Run-head line for the agent tree: "2m 41s · $0.64 of $4.00". */
export function budgetLine(spentUsd: number | undefined, budgetUsd: number | undefined): string | undefined {
  if (spentUsd === undefined) return undefined;
  return budgetUsd !== undefined ? `$${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}` : `$${spentUsd.toFixed(2)}`;
}

/** Crossing 80% of the budget tints the figure (INTERACTION I-8). */
export function budgetWarn(spentUsd: number | undefined, budgetUsd: number | undefined): boolean {
  return spentUsd !== undefined && budgetUsd !== undefined && budgetUsd > 0 && spentUsd >= 0.8 * budgetUsd;
}
