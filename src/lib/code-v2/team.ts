/**
 * The Team orchestrator (team lane): the composer's always-visible Team chip
 * and its role editor read and write a `RoleRouting` through these helpers.
 *
 * Four roles map onto the contract's routing:
 *   Architect → routing.architect   plans the structure and approach
 *   Builder   → routing.workers     writes the implementation, N in parallel
 *   Verifier  → routing.reviewer    reviews and tests the result
 *   Explorer  → routing.explorer    optional, searches first, read-only
 * The lead (routing.orchestrator) is always the composer's own model: it runs
 * the phases in order and writes the summary.
 *
 * Pure: no React, no storage of its own (persistence takes a Storage-like
 * object), so every rule is a test. The Swift twin is
 * native/Packages/JunoCode/Sources/JunoCodeCore/CodeV2/CodeV2Team.swift, and
 * both read contracts/code/team-summaries.json so the chip says the same
 * thing on the web and the Mac.
 */
import type { AgentRole, EffortLevel, ModelSelection, RolePreset, RoleRouting, TeamPhase } from "@/lib/code-v2/contracts";
import { DEFAULT_BUDGET_USD, WORKERS_MAX, WORKERS_MIN, withCount, withPreset } from "@/lib/code-v2/orchestrate";

/** The presets the editor offers, in order. `lead-workers` stays readable but is not offered. */
export const TEAM_PRESETS = ["solo", "plan-build-verify", "best-of-n"] as const satisfies readonly RolePreset[];
export type TeamPreset = (typeof TEAM_PRESETS)[number];

export const TEAM_PRESET_COPY: Record<TeamPreset, { label: string; line: string }> = {
  solo: { label: "Solo", line: "One model does everything." },
  "plan-build-verify": { label: "Plan → Build → Verify", line: "One model plans, others build in parallel, another checks the result." },
  "best-of-n": { label: "Best of N", line: "Several models try the same task. You keep the best." },
};

export const TEAM_ROLES = ["architect", "builder", "verifier", "explorer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_COPY: Record<TeamRole, { name: string; duty: string; verb: string }> = {
  architect: { name: "Architect", duty: "Plans the structure and approach", verb: "plans" },
  builder: { name: "Builder", duty: "Writes the implementation", verb: "builds" },
  verifier: { name: "Verifier", duty: "Reviews and tests the result", verb: "verifies" },
  explorer: { name: "Explorer", duty: "Maps the code first, read-only", verb: "explores" },
};

/** Where each editor role lives in the contract's routing. */
export const TEAM_ROLE_SLOT: Record<TeamRole, "architect" | "workers" | "reviewer" | "explorer"> = {
  architect: "architect",
  builder: "workers",
  verifier: "reviewer",
  explorer: "explorer",
};

/** The phase a subagent of this contract role runs in, for the agent tree. */
export function teamPhaseOf(role: AgentRole): TeamPhase | undefined {
  if (role === "architect") return "plan";
  if (role === "worker") return "build";
  if (role === "reviewer") return "verify";
  return undefined;
}

export const TEAM_PHASE_LABELS: Record<TeamPhase, string> = { plan: "Plan", build: "Build", verify: "Verify" };

export const BUILDERS_MIN = WORKERS_MIN;
export const BUILDERS_MAX = WORKERS_MAX;

/** The editor's view of a preset: `lead-workers` reads as the team it closest resembles. */
export function teamPresetOf(routing: RoleRouting | undefined): TeamPreset {
  if (!routing || routing.preset === "solo") return "solo";
  if (routing.preset === "best-of-n") return "best-of-n";
  return "plan-build-verify";
}

/** Switch preset. Plan → Build → Verify fills each role from the lead, two builders and a $4 cap. */
export function withTeamPreset(routing: RoleRouting, preset: TeamPreset): RoleRouting {
  if (preset !== "plan-build-verify") return withPreset(routing, preset);
  const next = withPreset({ ...routing, workers: routing.workers?.length ? routing.workers : undefined }, "plan-build-verify");
  return { ...next, budget: routing.budget ?? { maxUsd: DEFAULT_BUDGET_USD } };
}

/** A role's model; Architect and Verifier fall back to the lead, as the engines do. */
export function teamRoleSelection(routing: RoleRouting, role: TeamRole): ModelSelection | undefined {
  switch (role) {
    case "architect":
      return routing.architect ?? routing.orchestrator;
    case "builder":
      return routing.workers?.[0] ?? routing.orchestrator;
    case "verifier":
      return routing.reviewer ?? routing.orchestrator;
    case "explorer":
      return routing.explorer;
  }
}

/** Set (or, for the optional Explorer, clear) one role's model. Every builder takes the builder model. */
export function withTeamRole(routing: RoleRouting, role: TeamRole, selection: ModelSelection | undefined): RoleRouting {
  if (role === "builder") {
    if (!selection) return routing;
    const n = Math.max(1, routing.workers?.length ?? 1);
    return { ...routing, workers: Array.from({ length: n }, () => selection) };
  }
  const slot = TEAM_ROLE_SLOT[role] as "architect" | "reviewer" | "explorer";
  const next = { ...routing };
  if (selection) next[slot] = selection;
  else delete next[slot];
  return next;
}

/** Change one role's effort, keeping its model. */
export function withTeamEffort(routing: RoleRouting, role: TeamRole, effort: EffortLevel | undefined): RoleRouting {
  const current = teamRoleSelection(routing, role);
  if (!current) return routing;
  const next: ModelSelection = { ...current };
  if (effort) next.effort = effort;
  else delete next.effort;
  return withTeamRole(routing, role, next);
}

/** How many builders run in parallel (1…6). */
export function withBuilderCount(routing: RoleRouting, count: number): RoleRouting {
  return withCount(routing, count);
}

/** The run's cap in USD, or none. */
export function withBudget(routing: RoleRouting, usd: number | undefined): RoleRouting {
  const next = { ...routing };
  if (usd === undefined || !(usd > 0)) delete next.budget;
  else next.budget = { ...(routing.budget ?? {}), maxUsd: Math.round(usd * 100) / 100 };
  return next;
}

// ── The chip's words ────────────────────────────────────────────────────────

/**
 * A model's family name, short enough for the chip: "Opus", "Sonnet", "GPT",
 * "Gemini", "Flash". Unknown ids fall back to their first word.
 */
export function shortModelName(modelId: string): string {
  const bare = modelId.includes(":") ? modelId.slice(modelId.indexOf(":") + 1) : modelId;
  const id = bare.toLowerCase();
  const rules: [RegExp, string][] = [
    [/opus/, "Opus"],
    [/sonnet/, "Sonnet"],
    [/haiku/, "Haiku"],
    [/fable/, "Fable"],
    [/flash/, "Flash"],
    [/gemini/, "Gemini"],
    [/^(gpt|o\d|chatgpt)|codex/, "GPT"],
    [/grok/, "Grok"],
    [/deepseek/, "DeepSeek"],
    [/qwen|qwq/, "Qwen"],
    [/kimi/, "Kimi"],
    [/glm/, "GLM"],
    [/mistral|devstral|codestral/, "Mistral"],
    [/llama/, "Llama"],
  ];
  for (const [re, name] of rules) if (re.test(id)) return name;
  const first = bare.split(/[-_/\s.]/).find(Boolean) ?? bare;
  return first ? first[0]!.toUpperCase() + first.slice(1) : "Model";
}

export const TEAM_SUMMARY_MAX = 44;

/**
 * The chip's summary, or null for Solo (the chip then says only "Team"):
 * "Opus plans · Sonnet ×2 builds · GPT verifies". When that is longer than
 * `max` it drops the verbs ("Opus · Sonnet ×2 · GPT"), then says only how
 * many agents ("Team of 4").
 */
export function teamSummary(routing: RoleRouting | undefined, max = TEAM_SUMMARY_MAX): string | null {
  if (!routing || routing.preset === "solo") return null;
  const n = routing.workers?.length ?? 0;
  if (routing.preset === "best-of-n") return `Best of ${Math.max(2, n)}`;
  const name = (s: ModelSelection | undefined) => (s ? shortModelName(s.model) : "");
  const builders = n > 1 ? `${name(routing.workers?.[0])} ×${n}` : name(routing.workers?.[0] ?? routing.orchestrator);
  const parts: [string, string][] =
    routing.preset === "lead-workers"
      ? [
          [name(routing.orchestrator), "leads"],
          [builders, "builds"],
          ...(routing.reviewer ? ([[name(routing.reviewer), "reviews"]] as [string, string][]) : []),
        ]
      : [
          [name(routing.architect ?? routing.orchestrator), "plans"],
          [builders, "builds"],
          [name(routing.reviewer ?? routing.orchestrator), "verifies"],
        ];
  const full = parts.map(([who, verb]) => `${who} ${verb}`).join(" · ");
  if (full.length <= max) return full;
  const compact = parts.map(([who]) => who).join(" · ");
  if (compact.length <= max) return compact;
  return `Team of ${parts.length - 1 + Math.max(1, n)}`;
}

/** The agent count for accessibility: lead excluded. */
export function teamSize(routing: RoleRouting | undefined): number {
  if (!routing || routing.preset === "solo") return 1;
  const n = routing.workers?.length ?? 0;
  if (routing.preset === "best-of-n") return n;
  return 1 + n + (routing.reviewer || routing.preset === "plan-build-verify" ? 1 : 0) + (routing.explorer ? 1 : 0);
}

// ── Persistence: per thread, with a per-project default ────────────────────

/** The slice of Storage the team store needs (window.localStorage, or a Map in tests). */
export interface TeamStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TeamScope {
  /** The thread (conversation / env session) id. */
  session?: string;
  /** The project: its repo path or name. */
  project?: string;
}

const SESSION_KEY = "alevr.code.team.session:";
const PROJECT_KEY = "alevr.code.team.project:";

function parse(raw: string | null): RoleRouting | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as RoleRouting;
    return value && typeof value === "object" && value.orchestrator && value.preset ? value : null;
  } catch {
    return null;
  }
}

/** The thread's own team, else the project's default, else null. */
export function loadTeam(storage: TeamStorage, scope: TeamScope): RoleRouting | null {
  if (scope.session) {
    const own = parse(storage.getItem(SESSION_KEY + scope.session));
    if (own) return own;
  }
  return scope.project ? parse(storage.getItem(PROJECT_KEY + scope.project)) : null;
}

/** Saves the team for the thread and makes it the project's default for new threads. */
export function saveTeam(storage: TeamStorage, scope: TeamScope, routing: RoleRouting): void {
  const value = JSON.stringify(routing);
  if (scope.session) storage.setItem(SESSION_KEY + scope.session, value);
  if (scope.project) storage.setItem(PROJECT_KEY + scope.project, value);
}

/** A team for a new run: the stored one with the lead swapped for the composer's current model. */
export function adoptTeam(stored: RoleRouting | null, lead: ModelSelection): RoleRouting | null {
  if (!stored) return null;
  return { ...stored, orchestrator: lead };
}
