/**
 * Turns one or more results files into a report: headline numbers per
 * product and scope, the category matrix, every workflow's state, the reason
 * behind every failure and every not_run, and the P1-7 acceptance status.
 *
 * Scopes are never added together: an offline-pipeline pass is evidence about
 * Alevr's renderers and runtime, not about a model answering a person.
 */

import { BENCH_CATEGORIES, RUN_STATES, type BenchResults, type RunRecord, type RunState, type WorkflowSpec } from "./types";

export interface ColumnSummary {
  column: string;
  product: string;
  scope: string;
  total: number;
  counts: Record<RunState, number>;
  attempted: number;
  firstAttemptPassed: number;
  /** firstAttemptPassed / attempted; null when nothing was attempted. */
  firstAttemptRate: number | null;
  /** firstAttemptPassed / total workflows (the stricter denominator). */
  firstAttemptRateAllWorkflows: number | null;
  observedCostUsd: number | null;
  costSources: string[];
  medianDurationMs: number | null;
}

export const STATE_LABEL: Record<RunState, string> = {
  passed: "PASS",
  failed: "FAIL",
  unverified: "UNVERIFIED",
  unsupported: "UNSUPPORTED",
  not_run: "NOT RUN",
};

export function columnOf(record: Pick<RunRecord, "product" | "scope">): string {
  return `${record.product.id}:${record.scope}`;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function summarize(records: RunRecord[]): ColumnSummary[] {
  const columns = new Map<string, RunRecord[]>();
  for (const r of records) columns.set(columnOf(r), [...(columns.get(columnOf(r)) ?? []), r]);
  return [...columns.entries()].map(([column, rows]) => {
    const counts = Object.fromEntries(RUN_STATES.map((s) => [s, rows.filter((r) => r.state === s).length])) as Record<RunState, number>;
    const attempted = counts.passed + counts.failed + counts.unverified;
    const firstAttemptPassed = rows.filter((r) => r.firstAttemptPassed === true).length;
    const costs = rows.map((r) => r.cost.usd).filter((c): c is number => typeof c === "number");
    return {
      column,
      product: rows[0].product.id,
      scope: rows[0].scope,
      total: rows.length,
      counts,
      attempted,
      firstAttemptPassed,
      firstAttemptRate: attempted ? firstAttemptPassed / attempted : null,
      firstAttemptRateAllWorkflows: rows.length ? firstAttemptPassed / rows.length : null,
      observedCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      costSources: [...new Set(rows.filter((r) => r.attempts.length).map((r) => r.cost.source))],
      medianDurationMs: median(rows.map((r) => r.durationMs).filter((d): d is number => typeof d === "number")),
    };
  });
}

export interface AcceptanceStatus {
  criterion: string;
  met: boolean;
  evidence: string;
}

/** LEDGER P1-7 acceptance, computed from the records — never asserted. */
export function acceptance(records: RunRecord[]): AcceptanceStatus[] {
  const alevrE2E = records.filter((r) => r.product.id === "alevr" && r.scope === "end_to_end");
  const reviewedRuns = alevrE2E.filter((r) => r.attempts.length > 0 && r.artifacts.length > 0 && (r.state === "passed" || r.state === "failed"));
  const competitors = records.filter((r) => r.product.id !== "alevr" && r.attempts.length > 0);
  const coveredCategories = new Set(competitors.map((r) => r.category));
  const missing = BENCH_CATEGORIES.filter((c) => !coveredCategories.has(c));
  const summary = summarize(alevrE2E)[0];
  return [
    {
      criterion: "≥ 30 Alevr end-to-end runs recorded with artifacts and an independent verdict",
      met: reviewedRuns.length >= 30,
      evidence: `${reviewedRuns.length} Alevr end-to-end run(s) with artifacts and a final passed/failed verdict (offline-pipeline runs are reported separately and do not count)`,
    },
    {
      criterion: "At least one competitor column per category",
      met: missing.length === 0,
      evidence: missing.length ? `no competitor run in ${missing.length}/${BENCH_CATEGORIES.length} categories: ${missing.join(", ")}` : "every category has a competitor run",
    },
    {
      criterion: "First-attempt success rate reported",
      met: Boolean(summary && summary.attempted > 0),
      evidence: summary && summary.attempted > 0 ? `Alevr end-to-end: ${summary.firstAttemptPassed}/${summary.attempted} attempted (${pct(summary.firstAttemptRate)})` : "no Alevr end-to-end run was attempted, so there is no rate to report",
    },
  ];
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`;
}

function esc(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderReport(results: BenchResults[], workflows: WorkflowSpec[]): string {
  const records = results.flatMap((r) => r.records);
  const summaries = summarize(records);
  const columns = summaries.map((s) => s.column);
  const byKey = new Map(records.map((r) => [`${columnOf(r)}|${r.workflowId}`, r]));
  const lines: string[] = [];
  const env = results[0]?.environment;

  lines.push("# Workflow benchmark report", "");
  lines.push(`Generated ${new Date().toISOString()} from ${results.length} results file(s): ${results.map((r) => `\`${r.runId}\``).join(", ")}.`, "");
  if (env) {
    lines.push(
      `Environment: Node ${env.node} on ${env.platform}; git ${env.gitCommit?.slice(0, 12) ?? "unknown"}${env.gitDirty ? " (dirty)" : ""}; ` +
        `LibreOffice: ${env.libreoffice ?? "not installed"}; network: ${env.network ? "on" : "off"}; ` +
        `model providers configured: ${env.providersConfigured.length ? env.providersConfigured.join(", ") : "none"}; fixtures digest \`${env.fixturesDigest.slice(0, 16)}\`.`,
      ""
    );
  }
  lines.push(
    "States: **PASS** = delivered and every independent check passed (plus human review where required) · **FAIL** = product error or a check rejected the deliverable · " +
      "**UNVERIFIED** = delivered but a check could not run or human review is pending · **UNSUPPORTED** = capability absent, with dated evidence · **NOT RUN** = nothing ran; the reason is listed.",
    "",
    "Scopes: `end_to_end` = the real product from prompt to deliverable · `offline_pipeline` = Alevr's own deterministic code driven by a fixed plan instead of a model (proves the product pipeline and the validators, not model quality). Scopes are never summed.",
    ""
  );

  lines.push("## Headline", "");
  lines.push("| Product · scope | Workflows | Pass | Fail | Unverified | Unsupported | Not run | First-attempt pass (of attempted) | First-attempt pass (of all) | Observed cost | Median duration |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    lines.push(
      `| ${s.column} | ${s.total} | ${s.counts.passed} | ${s.counts.failed} | ${s.counts.unverified} | ${s.counts.unsupported} | ${s.counts.not_run} | ` +
        `${s.attempted ? `${s.firstAttemptPassed}/${s.attempted} (${pct(s.firstAttemptRate)})` : "n/a"} | ${s.firstAttemptPassed}/${s.total} (${pct(s.firstAttemptRateAllWorkflows)}) | ` +
        `${s.observedCostUsd === null ? "unobserved" : `$${s.observedCostUsd.toFixed(4)}`}${s.costSources.length ? ` (${s.costSources.join(", ")})` : ""} | ${s.medianDurationMs === null ? "—" : `${s.medianDurationMs} ms`} |`
    );
  }
  lines.push("");

  lines.push("## Acceptance (LEDGER P1-7)", "");
  for (const a of acceptance(records)) lines.push(`- ${a.met ? "**MET**" : "**NOT MET**"} — ${a.criterion}: ${a.evidence}.`);
  lines.push("");

  lines.push("## Categories", "");
  lines.push(`| Category | ${columns.join(" | ")} |`);
  lines.push(`|---|${columns.map(() => "---").join("|")}|`);
  for (const category of BENCH_CATEGORIES) {
    const ids = workflows.filter((w) => w.category === category).map((w) => w.id);
    const cells = columns.map((column) => {
      const rows = ids.map((id) => byKey.get(`${column}|${id}`)).filter((r): r is RunRecord => Boolean(r));
      const n = (s: RunState) => rows.filter((r) => r.state === s).length;
      const attempted = n("passed") + n("failed") + n("unverified");
      return attempted ? `${n("passed")}/${attempted} pass${n("unverified") ? `, ${n("unverified")} unverified` : ""}${n("failed") ? `, ${n("failed")} fail` : ""}${n("not_run") ? ` · ${n("not_run")} not run` : ""}` : `${n("unsupported") ? `${n("unsupported")} unsupported · ` : ""}${n("not_run")} not run`;
    });
    lines.push(`| ${category} | ${cells.join(" | ")} |`);
  }
  lines.push("");

  lines.push("## Workflows", "");
  lines.push(`| Workflow | Category | ${columns.join(" | ")} |`);
  lines.push(`|---|---|${columns.map(() => "---").join("|")}|`);
  for (const w of workflows) {
    const cells = columns.map((column) => {
      const r = byKey.get(`${column}|${w.id}`);
      if (!r) return "—";
      const checks = r.checks.length ? ` ${r.checks.filter((c) => c.status === "pass").length}/${r.checks.length}` : "";
      return `${STATE_LABEL[r.state]}${checks}`;
    });
    lines.push(`| \`${w.id}\` ${esc(w.title)} | ${w.category} | ${cells.join(" | ")} |`);
  }
  lines.push("", "Cells show the state and passed/total checks.", "");

  const failed = records.filter((r) => r.state === "failed");
  lines.push("## Failures", "");
  if (!failed.length) lines.push("None.", "");
  for (const r of failed) {
    lines.push(`### ${r.workflowId} · ${columnOf(r)}`, "");
    lines.push(`${esc(r.reason)}`, "");
    for (const c of r.checks.filter((c) => c.status === "fail")) lines.push(`- \`${c.id}\` — ${esc(c.detail)}`);
    if (r.runDir) lines.push(`- run files: \`${r.runDir}\``);
    lines.push("");
  }

  const unverified = records.filter((r) => r.state === "unverified");
  lines.push("## Unverified (delivered, not fully checked)", "");
  if (!unverified.length) lines.push("None.", "");
  for (const r of unverified) {
    const pending = r.checks.filter((c) => c.status === "not_run").map((c) => esc(c.detail));
    lines.push(`- **${r.workflowId}** · ${columnOf(r)} — ${r.checks.filter((c) => c.status === "pass").length}/${r.checks.length} automated checks passed; pending: ${pending.join("; ")}${r.runDir ? ` (files: \`${r.runDir}\`)` : ""}`);
  }
  lines.push("");

  lines.push("## Not run", "");
  const notRun = records.filter((r) => r.state === "not_run");
  const byReason = new Map<string, string[]>();
  for (const r of notRun) byReason.set(`${columnOf(r)} — ${r.reason}`, [...(byReason.get(`${columnOf(r)} — ${r.reason}`) ?? []), r.workflowId]);
  if (!byReason.size) lines.push("None.");
  for (const [reason, ids] of byReason) lines.push(`- ${esc(reason)}: ${ids.map((id) => `\`${id}\``).join(", ")}`);
  lines.push("");

  const unsupported = records.filter((r) => r.state === "unsupported");
  if (unsupported.length) {
    lines.push("## Unsupported", "");
    for (const r of unsupported) lines.push(`- **${r.workflowId}** · ${columnOf(r)} — ${esc(r.reason)} (source: ${r.unsupportedEvidence?.source ?? "?"}, accessed ${r.unsupportedEvidence?.accessedAt ?? "?"})`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
