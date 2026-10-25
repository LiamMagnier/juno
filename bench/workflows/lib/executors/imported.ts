/**
 * Runs conducted by a PERSON — in a competitor (ChatGPT, Claude, Gemini,
 * Perplexity, Grok) or in the Alevr product itself — and brought in for the
 * same independent validation as automated runs.
 *
 * `prepare` lays out one folder per workflow: the prompt, the frozen inputs,
 * an empty outputs/ and a result.json template. The person runs the prompt in
 * the product, saves the deliverables into outputs/, and fills result.json.
 * `import` then validates every folder; a folder left untouched stays not_run.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES_DIR } from "../fixtures";
import type { ExecutionContext, ExecutionPlan, ExecutionResult, Executor } from "../runner";
import { BENCH_VERSION, PERMITTED_TOOLS, type BenchScope, type ProductInfo, type WorkflowSpec } from "../types";

export const COMPETITORS = ["chatgpt", "claude", "gemini", "perplexity", "grok"] as const;

export interface ImportedResult {
  benchVersion?: string;
  workflowId: string;
  product: string;
  /** not_run | unsupported | completed | errored | timeout */
  status: "not_run" | "unsupported" | "completed" | "errored" | "timeout";
  reason?: string;
  productVersion: string | null;
  surface: string | null;
  model: string | null;
  settings?: Record<string, unknown>;
  executorIdentity: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
  /** 1 = first attempt. A retry is a new attempt and must be recorded as such. */
  attempt: number;
  costUsd: number | null;
  costSource?: "reported_by_executor" | "unobserved";
  inputTokens?: number | null;
  outputTokens?: number | null;
  humanInterventions?: string[];
  unsupportedEvidence?: { source: string; accessedAt: string; note: string } | null;
  error?: string;
}

export function resultTemplate(workflow: WorkflowSpec, product: string): ImportedResult {
  return {
    benchVersion: BENCH_VERSION,
    workflowId: workflow.id,
    product,
    status: "not_run",
    reason: "not conducted yet",
    productVersion: null,
    surface: null,
    model: null,
    settings: {},
    executorIdentity: null,
    startedAt: null,
    durationSeconds: null,
    attempt: 1,
    costUsd: null,
    costSource: "unobserved",
    inputTokens: null,
    outputTokens: null,
    humanInterventions: [],
    unsupportedEvidence: null,
  };
}

export function prepareImportDir(dir: string, product: string, workflows: WorkflowSpec[]): number {
  let n = 0;
  for (const workflow of workflows) {
    const folder = path.join(dir, product, workflow.id);
    if (existsSync(path.join(folder, "result.json"))) continue; // never overwrite a conducted run
    mkdirSync(path.join(folder, "outputs"), { recursive: true });
    for (const input of workflow.inputs) {
      const target = path.join(folder, "inputs", input);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(FIXTURES_DIR, input), target);
    }
    const tools = workflow.permittedTools.map((t) => `- ${t}: ${PERMITTED_TOOLS[t as keyof typeof PERMITTED_TOOLS] ?? t}`).join("\n");
    writeFileSync(
      path.join(folder, "prompt.txt"),
      `${workflow.prompt}\n\n---\nWorkflow ${workflow.id} (${workflow.category}) — ${workflow.title}\nInputs: ${workflow.inputs.join(", ") || "none"} (in inputs/)\nPermitted tools:\n${tools}\nTime limit: ${workflow.limits.timeMinutes} min · budget: $${workflow.limits.budgetUsd}\nSave the deliverables (${workflow.requiredArtifacts.map((a) => a.name).join(", ")}) in outputs/, then fill result.json. Record a retry as attempt 2, never overwrite attempt 1.\n`
    );
    writeFileSync(path.join(folder, "result.json"), `${JSON.stringify(resultTemplate(workflow, product), null, 2)}\n`);
    n += 1;
  }
  return n;
}

function readResult(folder: string): ImportedResult | null {
  try {
    return JSON.parse(readFileSync(path.join(folder, "result.json"), "utf8")) as ImportedResult;
  } catch {
    return null;
  }
}

export function importedExecutor(options: { dir: string; product: ProductInfo; scope?: BenchScope }): Executor {
  const folderFor = (workflow: WorkflowSpec) => path.join(options.dir, options.product.id, workflow.id);
  return {
    id: `imported-${options.product.id}`,
    identity: "imported",
    kind: "human",
    product: options.product,
    scope: options.scope ?? "end_to_end",
    plan(workflow): ExecutionPlan {
      const result = readResult(folderFor(workflow));
      if (!result) return { runnable: false, state: "not_run", reason: `no conducted run (expected ${path.relative(process.cwd(), path.join(folderFor(workflow), "result.json"))})` };
      if (result.workflowId !== workflow.id || result.product !== options.product.id) {
        return { runnable: false, state: "not_run", reason: `result.json identity (${result.product}/${result.workflowId}) does not match its folder` };
      }
      if (result.status === "not_run") return { runnable: false, state: "not_run", reason: result.reason || "not conducted" };
      if (result.status === "unsupported") {
        const e = result.unsupportedEvidence;
        if (!e || !e.source || !e.accessedAt || !e.note) {
          return { runnable: false, state: "not_run", reason: "marked unsupported without dated evidence (source, accessedAt, note); a missing account is not_run" };
        }
        return { runnable: false, state: "unsupported", reason: e.note, evidence: e };
      }
      if (!result.executorIdentity) return { runnable: false, state: "not_run", reason: "result.json has no executorIdentity; independent review needs one" };
      return { runnable: true };
    },
    async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
      const folder = folderFor(ctx.workflow);
      const result = readResult(folder)!;
      if (existsSync(path.join(folder, "outputs"))) cpSync(path.join(folder, "outputs"), ctx.outputsDir, { recursive: true });
      if (existsSync(path.join(folder, "review.json"))) cpSync(path.join(folder, "review.json"), path.join(ctx.attemptDir, "review.json"));
      const outcome =
        result.status === "completed"
          ? ({ kind: "completed" } as const)
          : ({ kind: result.status === "timeout" ? "timeout" : "errored", error: result.error || result.reason || result.status } as const);
      const interventions = (result.humanInterventions ?? []).filter((h) => !/^approval\b/i.test(h));
      const usd = typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd >= 0 ? result.costUsd : null;
      return {
        outcome,
        executorIdentity: result.executorIdentity ?? "imported",
        product: { version: result.productVersion, surface: result.surface ?? options.product.surface },
        declaredAttempt: result.attempt,
        humanInterventions: interventions,
        startedAt: result.startedAt ?? undefined,
        durationMs: result.durationSeconds === null ? undefined : Math.round(result.durationSeconds * 1000),
        model: result.model,
        settings: { ...(result.settings ?? {}), attempt: result.attempt, humanInterventions: result.humanInterventions ?? [] },
        cost: {
          usd,
          source: usd === null ? "unobserved" : "reported_by_executor",
          inputTokens: result.inputTokens ?? null,
          outputTokens: result.outputTokens ?? null,
        },
      };
    },
  };
}
