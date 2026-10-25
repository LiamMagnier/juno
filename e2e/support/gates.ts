/**
 * The gate registry (spec §9 and §14, P0 (4)).
 *
 * Every gate in budgets.ts runs report-only by default: a failing measurement
 * is written to the report and printed as a warning, and the run stays green.
 * A package enforces a gate by listing its id in its own
 * `e2e/wave2/<pkg>/gates.ts`:
 *
 *   import type { GateId } from "../../support/budgets";
 *   export const enforce = ["chat.enter-bubble", "chat.tail-drain"] as const satisfies readonly GateId[];
 *
 * The registry globs those files, so no package edits anyone else's file to
 * enforce its gates. The files are data: the registry reads the `enforce`
 * array literal without executing the module, which keeps it identical under
 * Playwright, tsx and plain Node. A listed id that is not in the catalog is a
 * configuration error and fails the run, so a typo can never silently leave a
 * gate report-only.
 *
 * Measurements are JSON files (one per gate per test) under the report
 * directory; `evaluateResults` applies the modes, and `scripts/qa/gates.ts
 * evaluate` turns that into an exit code for CI and the runner.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { GATES, type GateDefinition, type GateStat } from "./budgets";
import { percentile } from "./perf-marks";

export type GateMode = "enforce" | "report";

export interface GateFile {
  /** The package directory under e2e/wave2, e.g. "p5-chat". */
  pkg: string;
  file: string;
  enforce: string[];
}

export interface GateConfig {
  root: string;
  files: GateFile[];
  /** gate id → the packages that enforce it */
  enforcedBy: Map<string, string[]>;
  errors: string[];
  catalog: readonly GateDefinition[];
}

export interface GateMeasurement {
  /** A single value, when the gate measures one thing. */
  value?: number;
  /** Repeated runs; the gate's `stat` (p95, max…) is taken over these. */
  samples?: number[];
  /** For pass/fail gates without a numeric budget. */
  pass?: boolean;
  detail?: string;
  /** Free-form context: the route, the project, the theme. */
  context?: Record<string, string | number | boolean | null>;
}

export interface GateResult {
  gate: string;
  pass: boolean;
  /** The number compared against the budget, when there is one. */
  observed: number | null;
  stat: GateStat | null;
  budget: string;
  detail: string;
  samples?: number[];
  stats?: { n: number; p50: number; p95: number; min: number; max: number };
  context?: GateMeasurement["context"];
  recordedAt: string;
}

export interface EvaluatedGate {
  id: string;
  title: string;
  /** Measured by its own CI job (platform "ci"), never by a Playwright run. */
  external: boolean;
  measuredBy: string;
  mode: GateMode;
  enforcedBy: string[];
  results: GateResult[];
  status: "pass" | "fail" | "warn" | "unmeasured";
}

export interface RunSummary {
  exitCode: 0 | 1;
  gates: EvaluatedGate[];
  failures: EvaluatedGate[];
  warnings: EvaluatedGate[];
  errors: string[];
}

/**
 * Reads a file, or returns null when it does not exist. One call instead of
 * existsSync-then-readFileSync, so there is no window between the check and
 * the read (CodeQL js/file-system-race on PR #99).
 */
function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Directory entries, or none when the directory does not exist. */
function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** The repo root: the nearest directory up from `from` holding playwright.config.ts. */
export function repoRoot(from: string = process.cwd()): string {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, "playwright.config.ts")) && existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * Reads the `enforce` array literal from a gates.ts source without running it.
 * Throws with a precise message when the file is not in the expected shape.
 */
export function parseGateFile(source: string, file = "gates.ts"): string[] {
  const code = stripComments(source);
  const match = /export\s+const\s+enforce\b[^=]*=\s*\[([^\]]*)\]/.exec(code);
  if (!match) {
    throw new Error(`${file} must export \`enforce\` as an array literal of gate ids (export const enforce = [...]).`);
  }
  const body = match[1];
  const ids: string[] = [];
  const literal = /(["'`])([^"'`\\]*)\1/g;
  let rest = body;
  for (const m of body.matchAll(literal)) {
    ids.push(m[2]);
    rest = rest.replace(m[0], "");
  }
  if (rest.replace(/[\s,]/g, "") !== "") {
    throw new Error(`${file}: \`enforce\` may only contain gate id string literals (found "${rest.replace(/\s+/g, " ").trim()}").`);
  }
  return ids;
}

/**
 * Globs `e2e/wave2/<pkg>/gates.ts` under `root` and works out every gate's mode.
 * @param catalog defaults to the spec §9 catalog; tests pass a fixture catalog
 */
export function loadGateConfig(root: string = repoRoot(), catalog: readonly GateDefinition[] = GATES): GateConfig {
  const known = new Set(catalog.map((gate) => gate.id));
  const files: GateFile[] = [];
  const errors: string[] = [];
  const enforcedBy = new Map<string, string[]>();
  const wave2 = path.join(root, "e2e", "wave2");
  const dirs = entriesOf(wave2).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const pkg of dirs) {
    const file = path.join(wave2, pkg, "gates.ts");
    const source = readIfPresent(file);
    if (source === null) continue;
    const relative = path.relative(root, file);
    let enforce: string[];
    try {
      enforce = parseGateFile(source, relative);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const id of enforce) {
      if (!known.has(id)) {
        errors.push(`${relative} enforces "${id}", which is not a known gate. Known gates are listed in e2e/support/budgets.ts.`);
        continue;
      }
      const by = enforcedBy.get(id) ?? [];
      if (!by.includes(pkg)) by.push(pkg);
      enforcedBy.set(id, by);
    }
    files.push({ pkg, file: relative, enforce });
  }
  return { root, files, enforcedBy, errors, catalog };
}

export function gateMode(config: GateConfig, id: string): GateMode {
  return config.enforcedBy.has(id) ? "enforce" : "report";
}

function compare(op: NonNullable<GateDefinition["check"]>["op"], observed: number, limit: number): boolean {
  switch (op) {
    case "lte":
      return observed <= limit;
    case "lt":
      return observed < limit;
    case "eq":
      return observed === limit;
    case "gte":
      return observed >= limit;
  }
}

function statOf(stat: GateStat, samples: readonly number[]): number {
  switch (stat) {
    case "p50":
      return percentile(samples, 50);
    case "p95":
      return percentile(samples, 95);
    case "min":
      return Math.min(...samples);
    case "mean":
      return samples.reduce((a, b) => a + b, 0) / samples.length;
    case "max":
    case "value":
      return Math.max(...samples);
  }
}

/** Applies a gate's budget to one measurement. Pure. */
export function evaluateMeasurement(gate: GateDefinition, measurement: GateMeasurement, now: Date = new Date()): GateResult {
  const base = {
    gate: gate.id,
    budget: gate.budget,
    context: measurement.context,
    recordedAt: now.toISOString(),
  };
  const check = gate.check;
  if (!check) {
    if (typeof measurement.pass !== "boolean") {
      return { ...base, pass: false, observed: null, stat: null, detail: `"${gate.id}" is pass/fail and the measurement carried no pass value.` };
    }
    return { ...base, pass: measurement.pass, observed: measurement.value ?? null, stat: null, detail: measurement.detail ?? "" };
  }
  const samples = measurement.samples ?? (typeof measurement.value === "number" ? [measurement.value] : []);
  if (samples.length === 0 || samples.some((s) => !Number.isFinite(s))) {
    return { ...base, pass: false, observed: null, stat: check.stat ?? "value", detail: "The measurement carried no finite value." };
  }
  const stat = check.stat ?? "value";
  const observed = statOf(stat, samples);
  const enough = !check.minSamples || samples.length >= check.minSamples;
  const within = compare(check.op, observed, check.value);
  const rounded = Math.round(observed * 1000) / 1000;
  const opText = { lte: "≤", lt: "<", eq: "=", gte: "≥" }[check.op];
  let detail = `${stat === "value" ? "" : `${stat} `}${rounded}${check.unit ? ` ${check.unit}` : ""} (budget ${opText} ${check.value})`;
  if (!enough) detail += `; only ${samples.length} of the ${check.minSamples} required runs`;
  if (measurement.detail) detail += `; ${measurement.detail}`;
  const result: GateResult = { ...base, pass: within && enough, observed, stat, detail };
  if (samples.length > 1) {
    result.samples = samples;
    result.stats = {
      n: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      min: Math.min(...samples),
      max: Math.max(...samples),
    };
  }
  return result;
}

/**
 * Reads every result file under `dirs`: a GateResult (written by the
 * Playwright recorder) or an array of them, or a native record
 * (`{ gate, measurement: { samples, unit } }`, written by
 * Wave2PerfReport.swift), which is evaluated here against the catalog so the
 * budget lives in one place. Native records with no gate are probes and are
 * skipped.
 */
export function readResults(dirs: readonly string[], catalog: readonly GateDefinition[] = GATES): { results: GateResult[]; errors: string[] } {
  const results: GateResult[] = [];
  const errors: string[] = [];
  const walk = (dir: string) => {
    for (const entry of entriesOf(dir)) {
      const name = entry.name;
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !name.endsWith(".json") || name === "summary.json") continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(full, "utf8"));
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          const record = item as Partial<GateResult> & { measurement?: { samples?: unknown; unit?: unknown; detail?: unknown } };
          if (typeof record.gate === "string" && typeof record.pass === "boolean") {
            results.push(record as GateResult);
          } else if (typeof record.gate === "string" && record.measurement && typeof record.measurement === "object") {
            const gate = catalog.find((g) => g.id === record.gate);
            if (!gate) {
              errors.push(`${full}: names the unknown gate "${record.gate}".`);
              continue;
            }
            const samples = Array.isArray(record.measurement.samples) ? record.measurement.samples.filter((n): n is number => typeof n === "number") : [];
            const detail = typeof record.measurement.detail === "string" ? record.measurement.detail : undefined;
            results.push(evaluateMeasurement(gate, { samples, detail, context: { source: path.basename(full) } }));
          }
        }
      } catch (error) {
        errors.push(`${full}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return { results, errors };
}

/**
 * Applies modes to a run's results. Enforced gates with a failing result fail
 * the run; report-only failures are warnings; configuration errors fail it.
 */
export function evaluateResults(
  config: GateConfig,
  results: readonly GateResult[],
  extraErrors: readonly string[] = [],
  options: { requireEnforced?: boolean } = {}
): RunSummary {
  const byGate = new Map<string, GateResult[]>();
  const errors = [...config.errors, ...extraErrors];
  const known = new Set(config.catalog.map((gate) => gate.id));
  for (const result of results) {
    if (!known.has(result.gate)) {
      errors.push(`A result names the unknown gate "${result.gate}".`);
      continue;
    }
    const list = byGate.get(result.gate) ?? [];
    list.push(result);
    byGate.set(result.gate, list);
  }
  const gates: EvaluatedGate[] = config.catalog.map((gate) => {
    const mode = gateMode(config, gate.id);
    const list = byGate.get(gate.id) ?? [];
    const failed = list.some((r) => !r.pass);
    const status: EvaluatedGate["status"] = list.length === 0 ? "unmeasured" : !failed ? "pass" : mode === "enforce" ? "fail" : "warn";
    return {
      id: gate.id,
      title: gate.title,
      external: gate.platform === "ci",
      measuredBy: gate.measuredBy,
      mode,
      enforcedBy: config.enforcedBy.get(gate.id) ?? [],
      results: list,
      status,
    };
  });
  // A full run (CI's summary job) must measure every enforced gate: an
  // enforced gate whose test was skipped or never ran would otherwise pass by
  // saying nothing. Partial local runs leave this off and only get a note.
  //
  // Except the external gates (platform "ci"): they are measured by their own
  // CI job, never by Playwright, so no browser run can record them. P1
  // enforces two (design.contrast-matrix in native-parity.yml, design.lint in
  // ESLint); requiring them here turned every full run red with "recorded no
  // measurement" for gates that were green where they are actually measured.
  const external = new Set(config.catalog.filter((gate) => gate.platform === "ci").map((gate) => gate.id));
  if (options.requireEnforced) {
    for (const gate of gates) {
      if (external.has(gate.id)) continue;
      if (gate.mode === "enforce" && gate.status === "unmeasured") {
        errors.push(`${gate.id} is enforced by ${gate.enforcedBy.join(", ")} but this run recorded no measurement for it.`);
      }
    }
  }
  const failures = gates.filter((g) => g.status === "fail");
  const warnings = gates.filter((g) => g.status === "warn");
  return { exitCode: failures.length > 0 || errors.length > 0 ? 1 : 0, gates, failures, warnings, errors };
}

/** A plain-text report of a run, for the terminal and CI logs. */
export function formatSummary(summary: RunSummary): string {
  const lines: string[] = [];
  for (const gate of summary.gates) {
    if (gate.status === "unmeasured") continue;
    const tag = { pass: "pass", fail: "FAIL", warn: "warn", unmeasured: "    " }[gate.status];
    const mode = gate.mode === "enforce" ? `enforced by ${gate.enforcedBy.join(", ")}` : "report-only";
    const worst = gate.results.find((r) => !r.pass) ?? gate.results[0];
    lines.push(`  ${tag}  ${gate.id} (${mode}): ${worst?.detail ?? ""}`);
  }
  const unmeasuredEnforced = summary.gates.filter((g) => g.status === "unmeasured" && g.mode === "enforce");
  for (const gate of unmeasuredEnforced) {
    lines.push(
      gate.external
        ? `  ext   ${gate.id} is enforced by ${gate.enforcedBy.join(", ")} and measured outside this run (${gate.measuredBy}).`
        : `  note  ${gate.id} is enforced by ${gate.enforcedBy.join(", ")} but was not measured in this run.`
    );
  }
  for (const error of summary.errors) lines.push(`  ERROR ${error}`);
  const measured = summary.gates.filter((g) => g.status !== "unmeasured").length;
  lines.push(
    `Gates: ${measured} measured, ${summary.failures.length} enforced failure(s), ${summary.warnings.length} report-only warning(s)${summary.errors.length ? `, ${summary.errors.length} error(s)` : ""}.`
  );
  return lines.join("\n");
}
