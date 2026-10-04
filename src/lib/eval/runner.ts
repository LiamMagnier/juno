/**
 * Runs the evaluation suite (suite.ts) and the router evaluation, producing
 * records that carry their own provenance: every number says whether it was
 * measured, estimated or authored.
 *
 * The provider call is injected (`LiveCall`) so the runner stays testable and
 * the script decides whether a real network call may happen.
 */

import type { Plan } from "@prisma/client";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { NoAutoCandidateError, routeAuto, type RouteDecision, type RouteInput } from "@/lib/router/decide";
import { aggregateOutcomes } from "@/lib/router/evidence";
import type { ReasoningEffort } from "@/lib/model-metrics";
import { EVAL_SUITE, longContextPrompt, type EvalCategory, type EvalOutput, type EvalTaskSpec } from "@/lib/eval/suite";

export type EvalMode = "mock" | "live";

export interface EvalRecord {
  taskId: string;
  category: EvalCategory;
  /** mock = authored response; live = real provider call; not_run = see reason. */
  mode: "mock" | "live" | "not_run";
  success: boolean | null;
  latencyMs: number | null;
  latencySource: "measured" | "router_estimate" | null;
  costMicroUsd: number | null;
  costSource: "measured_usage" | "priced_mock_tokens" | null;
  toolCount: number | null;
  model: string | null;
  provider: string | null;
  effort: string | null;
  taskClass: string | null;
  errors: string[];
  citationQuality: number | null;
  notes: string;
}

export interface LiveCallResult extends EvalOutput {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export type LiveCall = (input: {
  model: ModelInfo;
  effort: ReasoningEffort;
  prompt: string;
  webSearch: boolean;
  probeTools: boolean;
}) => Promise<LiveCallResult>;

export interface RunEvalOptions {
  mode: EvalMode;
  plan?: Plan;
  /** Router context (paid-tier attestation, boundary, configuration). */
  routeContext?: Partial<RouteInput>;
  live?: LiveCall;
  /** Include tasks marked expensive (the 130k-token haystack) in live mode. */
  includeExpensive?: boolean;
  onRecord?: (record: EvalRecord) => void;
}

function empty(task: EvalTaskSpec, mode: EvalRecord["mode"], notes: string): EvalRecord {
  return {
    taskId: task.id,
    category: task.category,
    mode,
    success: null,
    latencyMs: null,
    latencySource: null,
    costMicroUsd: null,
    costSource: null,
    toolCount: null,
    model: null,
    provider: null,
    effort: null,
    taskClass: null,
    errors: [],
    citationQuality: null,
    notes,
  };
}

function promptFor(task: EvalTaskSpec): string {
  return task.id === "long-needle" ? longContextPrompt() : task.prompt;
}

export async function runEvalSuite(options: RunEvalOptions): Promise<EvalRecord[]> {
  const records: EvalRecord[] = [];
  const push = (r: EvalRecord) => {
    records.push(r);
    options.onRecord?.(r);
  };
  for (const task of EVAL_SUITE) {
    if (task.notRunnable) {
      push(
        empty(
          task,
          "not_run",
          `${task.notRunnable.reason}${task.notRunnable.coveredBy ? ` Covered elsewhere by: ${task.notRunnable.coveredBy}.` : ""}`
        )
      );
      continue;
    }
    if (options.mode === "live" && task.expensive && !options.includeExpensive) {
      push(empty(task, "not_run", "Expensive in live mode; set EVAL_LIVE_EXPENSIVE=1 to include."));
      continue;
    }

    let decision: RouteDecision;
    try {
      decision = routeAuto({
        message: task.id === "long-needle" ? "Find the access code in this document." : task.prompt,
        plan: options.plan ?? "PRO",
        wantsWebSearch: task.route.wantsWebSearch,
        toolsOffered: task.route.toolsOffered,
        contextTokens: task.route.contextTokens,
        ...options.routeContext,
      });
    } catch (err) {
      const r = empty(task, "not_run", err instanceof NoAutoCandidateError ? "No eligible model is configured for this task." : "Routing failed.");
      r.errors.push(err instanceof Error ? err.message : String(err));
      push(r);
      continue;
    }

    const base: EvalRecord = {
      ...empty(task, options.mode, ""),
      model: decision.model.id,
      provider: decision.model.provider,
      effort: decision.reasoningEffort ?? "instant",
      taskClass: decision.profile.taskClass,
    };

    if (options.mode === "mock") {
      const graded = task.grade(task.mock);
      push({
        ...base,
        success: graded.success,
        latencyMs: Math.round(decision.ranked[0].expectedLatencyS * 1000),
        latencySource: "router_estimate",
        costMicroUsd: Math.round(
          estimateCostUsd(decision.model, { input: task.mock.inputTokens, output: task.mock.outputTokens }) * 1_000_000
        ),
        costSource: "priced_mock_tokens",
        toolCount: task.mock.toolCalls ?? 0,
        citationQuality: graded.citationQuality,
        notes: `mock response · ${graded.notes}`,
      });
      continue;
    }

    if (!options.live) {
      push({ ...base, mode: "not_run", notes: "Live mode without a provider call." });
      continue;
    }
    try {
      const out = await options.live({
        model: decision.model,
        effort: decision.reasoningEffort,
        prompt: promptFor(task),
        webSearch: !!task.route.wantsWebSearch,
        probeTools: !!task.needsProbeTools,
      });
      const graded = task.grade(out);
      push({
        ...base,
        success: graded.success,
        latencyMs: out.latencyMs,
        latencySource: "measured",
        costMicroUsd: Math.round(estimateCostUsd(decision.model, { input: out.inputTokens, output: out.outputTokens }) * 1_000_000),
        costSource: "measured_usage",
        toolCount: out.toolCalls ?? 0,
        citationQuality: graded.citationQuality,
        notes: `live · ${graded.notes}`,
      });
    } catch (err) {
      push({
        ...base,
        success: false,
        errors: [err instanceof Error ? err.message.slice(0, 300) : String(err)],
        notes: "live call failed",
      });
    }
  }
  return records;
}

// ── Router evaluation ───────────────────────────────────────────────────────

export interface RouterScenarioPick {
  scenario: string;
  model: string;
  provider: string;
  /** Catalogue cost tier 1–3 ("tier" in the brief). */
  tier: number;
  effort: string;
  expectedTotalMicroUsd: number;
  pSuccess: number;
  degraded: string | null;
}

export interface RouterEvalRow {
  taskId: string;
  category: EvalCategory | "benchmark";
  /** The suite category, or what the benchmark-class prompt is shaped like. */
  label: string;
  taskClass: string;
  complexity: string;
  picks: RouterScenarioPick[];
}

/**
 * Where Auto sends each runnable task under named scenarios — default terms,
 * owner-attested paid tiers, each preference, the primary provider down, a
 * tight budget, and measured failures on the default pick. Every provider is
 * treated as configured, so the table shows routing, not this machine's keys.
 */
/**
 * Prompts SHAPED like well-known benchmark task classes — not the benchmarks
 * themselves, which need their own harnesses and scoring. They exist so the
 * router table covers the hard end of the range, where the suite's tasks
 * (mostly short, gradeable asks) never reach.
 */
export const ROUTER_BENCHMARK_CLASSES: {
  id: string;
  shapedLike: string;
  route: Pick<RouteInput, "message" | "wantsWebSearch" | "toolsOffered" | "contextTokens" | "hasImages">;
}[] = [
  {
    id: "repo-bugfix",
    shapedLike: "SWE-bench (repository-scale bug fix)",
    route: {
      message:
        "In this repository, the session refresh in src/auth/refresh.ts races with logout across multiple files and corrupts the token store under concurrency. Find the root cause, refactor the migration path, write unit tests for the race condition, and explain the trade-offs step by step.",
      toolsOffered: 2,
    },
  },
  {
    id: "expert-qa",
    shapedLike: "GPQA (graduate-level reasoning)",
    route: {
      message:
        "Prove rigorously, step by step, why the ground-state energy of a two-electron atom cannot be computed exactly with a product of hydrogenic orbitals, consider the edge cases of electron correlation, and compare the variational and perturbative estimates with their trade-offs.",
    },
  },
  {
    id: "agentic-workflow",
    shapedLike: "τ-bench (tool-using agent)",
    route: {
      message: "Use the tools to find my next three calendar events, then send an email to Sam on my behalf proposing to move the Friday one.",
      toolsOffered: 4,
    },
  },
  {
    id: "needle",
    shapedLike: "needle-in-a-haystack (long context)",
    route: { message: "Find the access code in this document.", contextTokens: 400_000 },
  },
  {
    id: "chart-read",
    shapedLike: "MMMU / ChartQA (vision)",
    route: { message: "What trend does this chart show between 2019 and 2024?", hasImages: true },
  },
  {
    id: "fresh-fact",
    shapedLike: "SimpleQA with search (fresh facts, cited)",
    route: { message: "Who won the most recent Ballon d'Or? Cite sources.", wantsWebSearch: true },
  },
  { id: "small-talk", shapedLike: "everyday chat", route: { message: "hey! any idea for a quick dinner tonight?" } },
];

/**
 * Where Auto sends each task under named scenarios — default terms,
 * owner-attested paid tiers, each preference, a narrower data boundary, the
 * primary provider down, a budget just below the default pick, and measured
 * failures on the default pick. Every provider is treated as configured, so
 * the table shows routing, not this machine's keys.
 */
export function evaluateRouter(plan: Plan = "PRO"): RouterEvalRow[] {
  const rows: RouterEvalRow[] = [];
  const all = { isConfigured: () => true, catalogue: MODEL_LIST } as const;
  const attested = new Set(["google", "mistral"]);
  const inputs: { id: string; category: EvalCategory | "benchmark"; label: string; route: Omit<RouteInput, "plan"> }[] = [
    ...ROUTER_BENCHMARK_CLASSES.map((b) => ({ id: b.id, category: "benchmark" as const, label: b.shapedLike, route: b.route })),
    ...EVAL_SUITE.filter((t) => !t.notRunnable).map((t) => ({
      id: t.id,
      category: t.category,
      label: t.category,
      route: {
        message: t.id === "long-needle" ? "Find the access code in this document." : t.prompt,
        wantsWebSearch: t.route.wantsWebSearch,
        toolsOffered: t.route.toolsOffered,
        contextTokens: t.route.contextTokens,
      },
    })),
  ];
  for (const item of inputs) {
    const base: RouteInput = { ...item.route, plan, ...all };
    const pick = (scenario: string, extra: Partial<RouteInput>): RouterScenarioPick => {
      const d = routeAuto({ ...base, ...extra });
      return {
        scenario,
        model: d.model.id,
        provider: d.model.provider,
        tier: d.model.cost,
        effort: d.reasoningEffort ?? "instant",
        expectedTotalMicroUsd: d.ranked[0].expectedTotalMicroUsd,
        pSuccess: d.ranked[0].pSuccess,
        degraded: d.degraded,
      };
    };
    const first = routeAuto(base);
    const failures = Array.from({ length: 200 }, () => ({
      modelId: first.model.id,
      taskClass: first.profile.taskClass,
      completionState: "failed",
      userRegenerated: false,
      userSwitchedModel: false,
      userEdited: false,
      feedback: null,
      toolRounds: 0,
      retryCount: 1,
      latencyMs: null,
      costMicroUsd: null,
    }));
    const winner = first.ranked[0];
    rows.push({
      taskId: item.id,
      category: item.category,
      label: item.label,
      taskClass: first.profile.taskClass,
      complexity: first.profile.complexity,
      picks: [
        pick("default terms", {}),
        pick("paid tiers attested (google, mistral)", { paidTier: attested }),
        pick("preference: quality", { paidTier: attested, preference: "quality" }),
        pick("preference: economy", { paidTier: attested, preference: "economy" }),
        pick("boundary: EU and US only", { paidTier: attested, boundary: "eu_us_only" }),
        pick(`fallback: ${first.model.provider} down`, { isProviderAvailable: (p) => p !== first.model.provider }),
        pick("budget: just below the default pick", {
          remainingBudgetMicroUsd: winner.callMicroUsd + winner.toolRoundsMicroUsd - 1,
        }),
        pick("evidence: 200 measured failures on the default pick", { evidence: aggregateOutcomes(failures) }),
      ],
    });
  }
  return rows;
}

export function summarize(records: readonly EvalRecord[]) {
  const ran = records.filter((r) => r.mode !== "not_run");
  const passed = ran.filter((r) => r.success).length;
  const cost = ran.reduce((s, r) => s + (r.costMicroUsd ?? 0), 0);
  return {
    total: records.length,
    ran: ran.length,
    passed,
    notRun: records.length - ran.length,
    costMicroUsd: cost,
    modes: [...new Set(records.map((r) => r.mode))],
  };
}
