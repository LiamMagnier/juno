/**
 * Runs workflows through an executor, validates every attempt independently,
 * and records what happened: product, version, model, settings, start time,
 * duration, cost (and whether that cost was observed), every attempt, every
 * check, and the artifact hashes a human review binds to.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { FIXTURES_DIR, HIDDEN_DIR, REPO_ROOT } from "./fixtures";
import { deriveVerdict, type ExecutorOutcome } from "./status";
import type {
  ArtifactRecord,
  AttemptRecord,
  BenchScope,
  CheckResult,
  ProductInfo,
  ReviewRecord,
  RunRecord,
  RunState,
  WorkflowSpec,
} from "./types";
import { runValidators } from "./validators";
import { SKIPPED_DIRS, linksAndSpecialFiles, sha256 } from "./validators/util";

export interface ExecutionContext {
  workflow: WorkflowSpec;
  attempt: number;
  attemptDir: string;
  /** Only the workflow's declared inputs, copied in. */
  inputsDir: string;
  /** Empty at start; whatever is here when execute returns is the deliverable. */
  outputsDir: string;
  signal: AbortSignal;
}

export interface ExecutionResult {
  outcome: ExecutorOutcome;
  model?: string | null;
  settings?: Record<string, unknown>;
  cost?: RunRecord["cost"];
  startedAt?: string;
  durationMs?: number;
  /** Per-run identity of whoever executed (imported runs); defaults to the executor's. */
  executorIdentity?: string;
  /** Per-run product facts reported by the executor (version, surface). */
  product?: Partial<ProductInfo>;
  /** The attempt number the executor declares (imported runs: 1 = first attempt). */
  declaredAttempt?: number;
  /** Human help beyond routine approvals: the run may pass, but never as a first-attempt success. */
  humanInterventions?: string[];
}

export type ExecutionPlan =
  | { runnable: true }
  | { runnable: false; state: "not_run"; reason: string }
  | { runnable: false; state: "unsupported"; reason: string; evidence: { source: string; accessedAt: string; note: string } | null };

export interface Executor {
  id: string;
  /** Who/what executed. A reviewer must not be this identity. */
  identity: string;
  kind: "automated" | "human";
  product: ProductInfo;
  scope: BenchScope;
  plan(workflow: WorkflowSpec): ExecutionPlan;
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;
}

export interface RunOptions {
  runId: string;
  /** The results directory; run files go under `runs/`. */
  outDir: string;
  executor: Executor;
  workflows: WorkflowSpec[];
  maxAttempts?: number;
  network?: boolean;
  officeReopen?: boolean;
  soffice?: string | null;
  /** Run delivered code without the sandbox (the operator's --unsafe-code). */
  unsafeCode?: boolean;
  /** Open delivered office files without the sandbox (the operator's --unsafe-office). */
  unsafeOffice?: boolean;
  /** Override the workflow's own time limit (tests). */
  timeoutMs?: number;
  onRecord?: (record: RunRecord) => void;
}

/**
 * The regular files of a run's outputs, hashed. Walked with lstat: a symlink,
 * FIFO, socket or device is never followed or read (a link to /dev/zero would
 * never finish hashing). Those entries are left out here and failed by
 * validateAttempt, which reports them.
 */
export function listArtifacts(outputsDir: string): ArtifactRecord[] {
  if (!existsSync(outputsDir) || !lstatSync(outputsDir).isDirectory()) return [];
  const out: ArtifactRecord[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry)) walk(full);
      } else if (stat.isFile()) {
        out.push({ name: path.relative(outputsDir, full).split(path.sep).join("/"), bytes: stat.size, sha256: sha256(readFileSync(full)) });
      }
    }
  };
  walk(outputsDir);
  return out;
}

export function loadReview(attemptDir: string): ReviewRecord | null {
  const file = path.join(attemptDir, "review.json");
  if (!existsSync(file)) return null;
  // A review is read only from a regular file, never through a link.
  if (!lstatSync(file).isFile()) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ReviewRecord;
  } catch {
    return null;
  }
}

function relativeRunDir(outDir: string, dir: string): string {
  return path.relative(outDir, dir).split(path.sep).join("/");
}

export function runSlug(executor: Pick<Executor, "product" | "scope">): string {
  return `${executor.product.id}-${executor.scope}`;
}

async function withTimeout(promise: Promise<ExecutionResult>, ms: number, controller: AbortController): Promise<ExecutionResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ExecutionResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("time limit"));
      resolve({ outcome: { kind: "timeout", error: `exceeded the ${Math.round(ms / 1000)}s limit` } });
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ValidateRunInput {
  workflow: WorkflowSpec;
  scope: BenchScope;
  attemptDir: string;
  executorIdentity: string;
  network: boolean;
  officeReopen: boolean;
  soffice: string | null;
  unsafeCode?: boolean;
  unsafeOffice?: boolean;
}

/** The deliverables a run must contain: the offline plan's own for offline_pipeline runs. */
export function requiredList(input: Pick<ValidateRunInput, "scope" | "workflow">): Array<{ name: string; alternatives?: string[] }> {
  return input.scope === "offline_pipeline" && input.workflow.offline
    ? input.workflow.offline.deliverables.map((name) => ({ name }))
    : input.workflow.requiredArtifacts;
}

/** Validate one attempt's outputs. Shared by `run` and `rescore`. */
export async function validateAttempt(input: ValidateRunInput): Promise<{ artifacts: ArtifactRecord[]; checks: CheckResult[]; review: ReviewRecord | null }> {
  const outputsDir = path.join(input.attemptDir, "outputs");
  mkdirSync(outputsDir, { recursive: true });
  const artifacts = listArtifacts(outputsDir);
  // Outputs come from an untrusted product. A link or special file anywhere
  // in them fails the run, and no validator opens anything: a validator that
  // followed a link could read outside the run or block forever.
  const links = linksAndSpecialFiles(outputsDir);
  if (links.length) {
    return {
      artifacts,
      review: null,
      checks: [
        {
          id: "outputs:no-links",
          status: "fail",
          detail: `outputs hold ${links.length} symlink(s) or special file(s), refused and never followed: ${links.slice(0, 6).join(", ")}${links.length > 6 ? ", …" : ""}`,
        },
      ],
    };
  }
  const review = loadReview(input.attemptDir);
  const checks = await runValidators(input.workflow.validators, {
    scope: input.scope,
    outputsDir,
    fixturesDir: FIXTURES_DIR,
    hiddenDir: HIDDEN_DIR,
    repoRoot: REPO_ROOT,
    scratchDir: path.join(input.attemptDir, ".scratch"),
    reviewDir: path.join(input.attemptDir, "review"),
    artifacts,
    review,
    executorIdentity: input.executorIdentity,
    network: input.network,
    officeReopen: input.officeReopen,
    soffice: input.soffice,
    unsafeCode: input.unsafeCode,
    unsafeOffice: input.unsafeOffice,
  });
  // Required artifacts are a check of their own: a missing file fails the run
  // even when no validator happened to name it.
  const requiredChecks: CheckResult[] = requiredList(input).map((required) => {
    const names = [required.name, ...(required.alternatives ?? [])];
    const present = names.find((n) => artifacts.some((a) => a.name === n || a.name.startsWith(`${n}/`)));
    return present
      ? { id: `required:${required.name}`, status: "pass", detail: `delivered ${present}` }
      : { id: `required:${required.name}`, status: "fail", detail: `not delivered (accepted: ${names.join(", ")})` };
  });
  return { artifacts, checks: [...requiredChecks, ...checks], review };
}

export async function runWorkflow(workflow: WorkflowSpec, options: RunOptions): Promise<RunRecord> {
  const { executor } = options;
  const base: Omit<RunRecord, "state" | "reason"> = {
    runId: options.runId,
    workflowId: workflow.id,
    category: workflow.category,
    scope: executor.scope,
    product: executor.product,
    model: null,
    settings: {},
    executor: { id: executor.id, identity: executor.identity, kind: executor.kind },
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    cost: { usd: null, source: "unobserved" },
    attempts: [],
    firstAttemptPassed: null,
    artifacts: [],
    checks: [],
    review: null,
    runDir: null,
  };
  const plan = executor.plan(workflow);
  if (!plan.runnable) {
    return {
      ...base,
      state: plan.state,
      reason: plan.reason,
      ...(plan.state === "unsupported" ? { unsupportedEvidence: plan.evidence } : {}),
    };
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  const workflowDir = path.join(options.outDir, "runs", runSlug(executor), workflow.id);
  const attempts: AttemptRecord[] = [];
  let last: { state: RunState; reason: string; artifacts: ArtifactRecord[]; checks: CheckResult[]; review: ReviewRecord | null; dir: string } | null = null;
  let model: string | null = null;
  let settings: Record<string, unknown> = {};
  let usd: number | null = null;
  let costSource: RunRecord["cost"]["source"] = "unobserved";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let startedAt: string | null = null;
  let totalMs = 0;
  let identity = executor.identity;
  let product: ProductInfo = { ...executor.product };
  let declaredFirst = true;
  let helped = false;

  for (let n = 1; n <= maxAttempts; n++) {
    const attemptDir = path.join(workflowDir, `attempt-${n}`);
    const inputsDir = path.join(attemptDir, "inputs");
    const outputsDir = path.join(attemptDir, "outputs");
    mkdirSync(inputsDir, { recursive: true });
    mkdirSync(outputsDir, { recursive: true });
    for (const input of workflow.inputs) {
      const target = path.join(inputsDir, input);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(FIXTURES_DIR, input), target);
    }
    const controller = new AbortController();
    const attemptStarted = new Date().toISOString();
    startedAt ??= attemptStarted;
    const t0 = performance.now();
    let result: ExecutionResult;
    try {
      result = await withTimeout(
        executor.execute({ workflow, attempt: n, attemptDir, inputsDir, outputsDir, signal: controller.signal }),
        options.timeoutMs ?? workflow.limits.timeMinutes * 60_000,
        controller
      );
    } catch (error) {
      result = { outcome: { kind: "errored", error: (error as Error).message ?? String(error) } };
    }
    const durationMs = result.durationMs ?? Math.round(performance.now() - t0);
    totalMs += durationMs;
    model = result.model ?? model;
    settings = { ...settings, ...(result.settings ?? {}) };
    if (result.executorIdentity) identity = result.executorIdentity;
    if (result.product) product = { ...product, ...result.product };
    if (n === 1 && result.declaredAttempt !== undefined && result.declaredAttempt !== 1) declaredFirst = false;
    if (result.humanInterventions?.length) helped = true;
    if (result.cost) {
      costSource = result.cost.source;
      if (result.cost.usd !== null) usd = (usd ?? 0) + result.cost.usd;
      if (typeof result.cost.inputTokens === "number") inputTokens = (inputTokens ?? 0) + result.cost.inputTokens;
      if (typeof result.cost.outputTokens === "number") outputTokens = (outputTokens ?? 0) + result.cost.outputTokens;
    }
    const validated =
      result.outcome.kind === "completed"
        ? await validateAttempt({
            workflow,
            scope: executor.scope,
            attemptDir,
            executorIdentity: identity,
            network: options.network ?? false,
            officeReopen: options.officeReopen ?? true,
            soffice: options.soffice ?? null,
            unsafeCode: options.unsafeCode,
            unsafeOffice: options.unsafeOffice,
          })
        : { artifacts: listArtifacts(outputsDir), checks: [] as CheckResult[], review: null };
    const verdict = deriveVerdict(result.outcome, validated.checks);
    attempts.push({
      n,
      startedAt: result.startedAt ?? attemptStarted,
      durationMs,
      outcome: result.outcome.kind,
      state: verdict.state,
      ...(result.outcome.kind === "completed" ? {} : { error: result.outcome.error }),
    });
    last = { ...verdict, ...validated, dir: attemptDir };
    // Retry only a failure; an unverified run needs a person, not another attempt.
    if (verdict.state !== "failed") break;
  }

  const final = last!;
  const budget = workflow.limits.budgetUsd;
  let reason = final.reason;
  let state = final.state;
  if (state === "passed" && usd !== null && usd > budget) {
    state = "failed";
    reason = `observed cost $${usd.toFixed(4)} exceeds the $${budget} budget`;
  }
  if (helped) settings = { ...settings, firstAttemptExcluded: "human intervention beyond routine approval" };
  return {
    ...base,
    product,
    executor: { ...base.executor, identity },
    model,
    settings,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: totalMs,
    cost: { usd, source: costSource, inputTokens, outputTokens },
    attempts,
    state,
    reason,
    firstAttemptPassed: attempts[0]?.state === "passed" && declaredFirst && !helped,
    artifacts: final.artifacts,
    checks: final.checks,
    review: final.review,
    runDir: relativeRunDir(options.outDir, final.dir),
  };
}

export async function runBenchmark(options: RunOptions): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const workflow of options.workflows) {
    const record = await runWorkflow(workflow, options);
    records.push(record);
    options.onRecord?.(record);
  }
  return records;
}

/**
 * Re-validate stored runs — after a reviewer adds review.json, or after
 * LibreOffice becomes available. The outputs are not re-executed.
 */
export async function rescoreRecord(
  record: RunRecord,
  workflow: WorkflowSpec,
  outDir: string,
  options: { network: boolean; officeReopen: boolean; soffice: string | null; unsafeCode?: boolean; unsafeOffice?: boolean }
): Promise<RunRecord> {
  if (!record.runDir || record.attempts.length === 0 || record.attempts.at(-1)?.outcome !== "completed") return record;
  const attemptDir = path.join(outDir, record.runDir);
  const validated = await validateAttempt({
    workflow,
    scope: record.scope,
    attemptDir,
    executorIdentity: record.executor.identity,
    ...options,
  });
  const verdict = deriveVerdict({ kind: "completed" }, validated.checks);
  // The budget rule applies on rescore exactly as on the original run.
  if (verdict.state === "passed" && record.cost.usd !== null && record.cost.usd > workflow.limits.budgetUsd) {
    verdict.state = "failed";
    verdict.reason = `observed cost $${record.cost.usd.toFixed(4)} exceeds the $${workflow.limits.budgetUsd} budget`;
  }
  const attempts = record.attempts.map((a, i) => (i === record.attempts.length - 1 ? { ...a, state: verdict.state } : a));
  const excluded = record.settings.firstAttemptExcluded !== undefined || (typeof record.settings.attempt === "number" && record.settings.attempt !== 1);
  return {
    ...record,
    attempts,
    state: verdict.state,
    reason: verdict.reason,
    firstAttemptPassed: attempts[0]?.state === "passed" && !excluded,
    artifacts: validated.artifacts,
    checks: validated.checks,
    review: validated.review,
  };
}
