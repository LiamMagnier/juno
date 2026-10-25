import { isAutoModelId } from "@/lib/auto-model";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { compareCitations } from "@/lib/compare/citations";
import {
  timeToFirstAnswerMs,
  timeToFirstOutputMs,
  totalMs,
  type PaneRun,
  type PaneStatus,
  type PaneUsageBasis,
} from "@/lib/compare/pane-run";
import { compareEffortLabel, effortDisplay, plannedEffort, type CompareRunSpec } from "@/lib/compare/run-spec";
import { PROVIDERS } from "@/lib/providers";
import { formatUsd } from "@/lib/utils";
import type { ModelInfo } from "@/lib/models";
import type { ChatFinishReason, ReasoningEffort } from "@/types/chat";

/**
 * A comparison as a record: what was asked, what each model was actually run
 * with, what it produced, how long it took and what it cost, with the basis
 * of every number stated. The page's summary strip and both exports
 * (Markdown, JSON) are built from this one object, so they cannot disagree.
 */

export const COMPARE_REPORT_SCHEMA = "alevr.compare.v1";
/** A pane that started this much later than the first is called out. */
export const LATE_START_MS = 1000;

export interface ComparePaneEntry {
  paneId: string;
  /** The model the pane is set to (and asked for). */
  modelId: string;
  run: PaneRun;
}

export interface ReportModelRef {
  id: string;
  name: string;
  provider: string | null;
}

export interface CompareReportPane {
  position: number;
  paneId: string;
  label: string;
  model: { requested: ReportModelRef; served: ReportModelRef | null; changed: boolean; auto: boolean };
  effort: {
    requested: ReasoningEffort | null;
    /** What the server reported sending; null with `reported: false` means unknown. */
    applied: ReasoningEffort | null;
    reported: boolean;
    /** False when a specific effort was asked for and the model ran at another. */
    honoured: boolean | null;
    label: string;
  };
  webSearch: { requested: boolean; applied: boolean | null };
  status: PaneStatus;
  finishReason: ChatFinishReason | null;
  error: string | null;
  inputFingerprint: string | null;
  latency: {
    basis: "measured_in_browser";
    startOffsetMs: number | null;
    firstOutputMs: number | null;
    firstAnswerMs: number | null;
    totalMs: number | null;
  };
  usage: { basis: PaneUsageBasis | null; promptTokens: number | null; completionTokens: number | null };
  cost: {
    usd: number | null;
    basis: "reported_usage" | "estimated" | null;
    /**
     * The person stopped this answer, so the cost covers only what it
     * produced before that. A partial cost is spent money, but it is not
     * comparable with a full answer's, so it never wins "Lowest cost".
     */
    partial: boolean;
  };
  citations: {
    total: number;
    shared: number;
    unique: number;
    refs: Array<{ title: string; url: string; host: string; inSources: boolean; inText: boolean; sharedWith: string[] }>;
  };
  answer: string;
}

export interface CompareVerdict {
  paneId: string;
  position: number;
  label: string;
  value: number;
}

export interface CompareReport {
  schema: typeof COMPARE_REPORT_SCHEMA;
  product: string;
  generatedAt: string;
  input: {
    prompt: string;
    fingerprint: string;
    webSearch: boolean;
    reasoningEffort: ReasoningEffort | null;
    reasoningEffortLabel: string;
    timeZone: string | null;
    startedAt: string;
    transport: "private";
    sampling: "provider_default";
  };
  /**
   * Every pane that ran SENT the spec's exact shared request (prompt, history,
   * search flag, effort, time zone): the fingerprint each pane recorded from
   * the body it posted matches the spec's. This checks the request as the
   * browser sent it. What each model then ran with on the server (its effort
   * and whether it could search) is reported per pane in `effort.applied` and
   * `webSearch.applied`, and differences there are surfaced separately.
   */
  identicalInput: boolean;
  panes: CompareReportPane[];
  summary: {
    fastestFirstOutput: CompareVerdict | null;
    fastestFinish: CompareVerdict | null;
    lowestCost: (CompareVerdict & { estimated: boolean; allReported: boolean }) | null;
    /** Null when fewer than two panes reported an effort. */
    effortsMatch: boolean | null;
    /** Null unless search was requested and at least one pane reported. */
    searchApplied: boolean | null;
    modelChanged: string[];
    lateStarts: Array<{ label: string; offsetMs: number }>;
    citations: {
      union: number;
      sharedByAll: Array<{ title: string; url: string }>;
      sharedHosts: Array<{ host: string; labels: string[] }>;
    };
  };
  notes: string[];
}

function modelRef(id: string, resolve: (id: string) => ModelInfo | undefined): ReportModelRef {
  const model = resolve(id);
  return {
    id,
    name: model?.name ?? id,
    provider: model ? (PROVIDERS[model.provider]?.label.split(" · ")[0] ?? model.provider) : null,
  };
}

function ran(run: PaneRun): boolean {
  return run.status !== "idle" && run.specId !== null;
}

function pickMin(
  entries: ReadonlyArray<{ pane: CompareReportPane; value: number | null }>
): CompareVerdict | null {
  const eligible = entries.filter((e): e is { pane: CompareReportPane; value: number } => e.value != null);
  // A verdict needs a field: one finisher is not "the fastest".
  if (eligible.length < 2) return null;
  const best = eligible.reduce((a, b) => (b.value < a.value ? b : a));
  return { paneId: best.pane.paneId, position: best.pane.position, label: best.pane.label, value: best.value };
}

export function buildCompareReport(input: {
  spec: CompareRunSpec;
  panes: ReadonlyArray<ComparePaneEntry>;
  resolveModel: (id: string) => ModelInfo | undefined;
  /** The account's plan, so a pane with no server effort report is planned with the plan's default effort (Free: GPT-6 Luna at Low). */
  plan?: string | null;
  generatedAt?: Date;
}): CompareReport {
  const { spec, resolveModel, plan } = input;
  const labelOf = new Map<string, string>();
  const panesThatRan = input.panes.filter((pane) => ran(pane.run) && pane.run.specId === spec.id);
  for (const pane of panesThatRan) {
    const id = pane.run.servedModelId ?? pane.run.requestedModelId ?? pane.modelId;
    labelOf.set(pane.paneId, resolveModel(id)?.name ?? id);
  }
  const citations = compareCitations(
    panesThatRan.map((pane) => ({ paneId: pane.paneId, sources: pane.run.sources, content: pane.run.content }))
  );
  const citationsOf = new Map(citations.panes.map((c) => [c.paneId, c]));
  const nameList = (ids: readonly string[]) => ids.map((id) => labelOf.get(id) ?? id);

  const panes: CompareReportPane[] = panesThatRan.map((pane, index) => {
    const { run } = pane;
    const requestedId = run.requestedModelId ?? pane.modelId;
    const requested = modelRef(requestedId, resolveModel);
    const served = run.servedModelId ? modelRef(run.servedModelId, resolveModel) : null;
    const auto = isAutoModelId(requestedId);
    const effectiveModel = resolveModel(run.servedModelId ?? requestedId);
    const reported = run.appliedEffort !== undefined;
    const planned = plannedEffort(resolveModel(requestedId), spec.reasoningEffort, { plan });
    const applied = reported ? (run.appliedEffort ?? null) : null;
    const honoured = reported
      ? spec.reasoningEffort === null || applied === spec.reasoningEffort
      : planned
        ? planned.honoured
        : null;
    const label = reported
      ? effortDisplay(effectiveModel, applied)
      : planned
        ? `${planned.auto ? "Auto" : effortDisplay(effectiveModel, planned.effort)} (planned)`
        : "Unknown";
    const paneCitations = citationsOf.get(pane.paneId);
    return {
      position: index + 1,
      paneId: pane.paneId,
      label: labelOf.get(pane.paneId) ?? requested.name,
      model: { requested, served, changed: !auto && !!served && served.id !== requested.id, auto },
      effort: { requested: spec.reasoningEffort, applied, reported, honoured, label },
      webSearch: { requested: spec.webSearch, applied: run.webSearchApplied },
      status: run.status,
      finishReason: run.finishReason,
      error: run.errorMessage,
      inputFingerprint: run.inputFingerprint,
      latency: {
        basis: "measured_in_browser",
        startOffsetMs: run.startOffsetMs,
        firstOutputMs: timeToFirstOutputMs(run),
        firstAnswerMs: timeToFirstAnswerMs(run),
        totalMs: totalMs(run),
      },
      usage: { basis: run.usageBasis, promptTokens: run.promptTokens, completionTokens: run.completionTokens },
      cost: {
        usd: run.costUsd,
        basis: run.costUsd == null ? null : run.usageBasis === "reported" ? "reported_usage" : "estimated",
        partial: run.status === "done" && run.finishReason === "user_stopped",
      },
      citations: {
        total: paneCitations?.total ?? 0,
        shared: paneCitations?.shared ?? 0,
        unique: paneCitations?.unique ?? 0,
        refs: (paneCitations?.refs ?? []).map((ref) => ({
          title: ref.title,
          url: ref.url,
          host: ref.host,
          inSources: ref.inSources,
          inText: ref.inText,
          sharedWith: nameList(ref.sharedWith),
        })),
      },
      answer: run.content,
    };
  });

  const finished = panes.filter((pane) => pane.status === "done");
  // A stopped answer is not a finish and its cost is not a full answer's:
  // both "fastest finish" and "lowest cost" are drawn from answers that ran
  // to the end. Its first output was still a real measurement, so it stays
  // in "fastest first output".
  const completed = finished.filter((pane) => pane.finishReason !== "user_stopped");
  const costed = completed.filter((pane) => pane.cost.usd != null);
  const cheapest = pickMin(costed.map((pane) => ({ pane, value: pane.cost.usd })));
  const reportedEfforts = panes.filter((pane) => pane.effort.reported).map((pane) => pane.effort.applied);
  const searchReports = panes.map((pane) => pane.webSearch.applied).filter((v): v is boolean => v !== null);

  const summary: CompareReport["summary"] = {
    fastestFirstOutput: pickMin(finished.map((pane) => ({ pane, value: pane.latency.firstOutputMs }))),
    fastestFinish: pickMin(completed.map((pane) => ({ pane, value: pane.latency.totalMs }))),
    lowestCost: cheapest
      ? {
          ...cheapest,
          estimated: costed.find((pane) => pane.paneId === cheapest.paneId)?.cost.basis !== "reported_usage",
          allReported: costed.every((pane) => pane.cost.basis === "reported_usage"),
        }
      : null,
    effortsMatch: reportedEfforts.length < 2 ? null : reportedEfforts.every((effort) => effort === reportedEfforts[0]),
    searchApplied: spec.webSearch && searchReports.length > 0 ? searchReports.every(Boolean) : null,
    modelChanged: panes.filter((pane) => pane.model.changed).map((pane) => pane.label),
    lateStarts: panes
      .filter((pane) => (pane.latency.startOffsetMs ?? 0) > LATE_START_MS)
      .map((pane) => ({ label: pane.label, offsetMs: pane.latency.startOffsetMs ?? 0 })),
    citations: {
      union: citations.union,
      sharedByAll: citations.sharedByAll.map((ref) => ({ title: ref.title, url: ref.url })),
      sharedHosts: citations.sharedHosts.map((entry) => ({ host: entry.host, labels: nameList(entry.paneIds) })),
    },
  };

  const notes = [
    "Latency is wall-clock time measured in the browser from sending the request; it includes the network and any server queueing.",
    "Cost is priced from token usage at list rates. “Reported” rests on the provider’s own usage report; “estimated” means some counts were estimated from text length.",
    "Each model ran with its provider’s default sampling, not seeded: the same input can give a different answer when run again.",
  ];
  if (summary.effortsMatch === false || panes.some((pane) => pane.effort.honoured === false)) {
    notes.push("Thinking effort differs between these runs. Tier names are each provider’s own, so even equal names are not equal amounts of thinking.");
  }
  if (summary.searchApplied === false) {
    notes.push("Web search was requested but not every model could search; those answered from their own knowledge.");
  }
  if (finished.some((pane) => pane.cost.partial)) {
    notes.push("An answer stopped before it finished is priced only for what it produced, so it is left out of the fastest finish and the lowest cost.");
  }

  return {
    schema: COMPARE_REPORT_SCHEMA,
    product: PRODUCT_NAME,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    input: {
      prompt: spec.prompt,
      fingerprint: spec.fingerprint,
      webSearch: spec.webSearch,
      reasoningEffort: spec.reasoningEffort,
      reasoningEffortLabel: compareEffortLabel(spec.reasoningEffort),
      timeZone: spec.timeZone,
      startedAt: spec.createdAt,
      transport: "private",
      sampling: "provider_default",
    },
    identicalInput: panes.length > 0 && panes.every((pane) => pane.inputFingerprint === spec.fingerprint),
    panes,
    summary,
    notes,
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatSeconds(ms: number | null): string {
  return ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`;
}

function formatCount(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

/** "$0.0021" for a reported price, "~$0.0021" for an estimate. */
export function formatCost(usd: number | null, basis: "reported_usage" | "estimated" | PaneUsageBasis | null): string {
  if (usd == null) return "—";
  return basis === "reported_usage" || basis === "reported" ? formatUsd(usd) : `~${formatUsd(usd)}`;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim() || "—";
}

/** A link's text: one line, with the brackets (and backslashes) that would end it early escaped. */
function linkText(text: string): string {
  return (
    text
      .replace(/[[\]\\]/g, (char) => `\\${char}`)
      .replace(/\s*\n\s*/g, " ")
      .trim() || "—"
  );
}

/**
 * A URL as a Markdown link destination. Parentheses, whitespace and angle
 * brackets are percent-encoded, so `Mercury_(planet)` cannot close the link
 * early in any renderer; servers read `%28` and `(` alike.
 */
export function markdownLinkUrl(url: string): string {
  return url.replace(/[()<>\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

function statusText(pane: CompareReportPane): string {
  if (pane.status === "error") return `failed: ${pane.error ?? "unknown error"}`;
  if (pane.finishReason === "user_stopped") return "stopped";
  if (pane.finishReason === "length") return "hit its token limit";
  if (pane.status === "done") return "done";
  return "still running";
}

function searchText(pane: CompareReportPane): string {
  if (pane.webSearch.applied === null) return pane.webSearch.requested ? "requested" : "off";
  return pane.webSearch.applied ? "on" : pane.webSearch.requested ? "unavailable" : "off";
}

function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function utcStamp(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function compareReportToMarkdown(report: CompareReport): string {
  const lines: string[] = [];
  const { input, summary } = report;
  lines.push("# Model comparison", "");
  lines.push(
    `Exported from ${report.product} on ${utcStamp(report.generatedAt)}. Comparisons are not saved, so this file is the only copy.`,
    ""
  );

  lines.push("## Input", "");
  lines.push(blockquote(input.prompt), "");
  lines.push(
    `- Request fingerprint: \`${input.fingerprint}\` (${report.identicalInput ? "the same request was sent to every model" : "NOT the same request for every model"})`
  );
  lines.push(`- Web search: ${input.webSearch ? "on" : "off"}`);
  lines.push(`- Thinking effort requested: ${input.reasoningEffortLabel}`);
  lines.push(
    `- Started together: ${summary.lateStarts.length === 0 ? "yes" : summary.lateStarts.map((s) => `${s.label} started ${formatSeconds(s.offsetMs)} later`).join("; ")}`
  );
  lines.push("- Sampling: provider defaults, not seeded", "");

  lines.push("## Results", "");
  lines.push("| # | Model | Effort | Search | First output | Total | Tokens in / out | Cost | Sources | Status |");
  lines.push("|---|---|---|---|---:|---:|---:|---:|---:|---|");
  for (const pane of report.panes) {
    const model = pane.model.changed
      ? `${pane.label} (asked for ${pane.model.requested.name})`
      : pane.model.auto && pane.model.served
        ? `Auto → ${pane.label}`
        : pane.label;
    const tokens =
      pane.usage.promptTokens == null && pane.usage.completionTokens == null
        ? "—"
        : `${pane.usage.basis === "estimated" ? "~" : ""}${formatCount(pane.usage.promptTokens)} / ${formatCount(pane.usage.completionTokens)}`;
    lines.push(
      `| ${pane.position} | ${cell(model)} | ${cell(pane.effort.label)} | ${searchText(pane)} | ${formatSeconds(pane.latency.firstOutputMs)} | ${formatSeconds(pane.latency.totalMs)} | ${tokens} | ${formatCost(pane.cost.usd, pane.cost.basis)} | ${pane.citations.total} | ${cell(statusText(pane))} |`
    );
  }
  lines.push("");
  lines.push(
    "Latency is measured in the browser. Costs without `~` are priced from the provider’s reported token usage at list rates; `~` marks an estimate.",
    ""
  );

  const verdicts: string[] = [];
  if (summary.fastestFirstOutput) verdicts.push(`- Fastest first output: ${summary.fastestFirstOutput.label}, ${formatSeconds(summary.fastestFirstOutput.value)}`);
  if (summary.fastestFinish) verdicts.push(`- Fastest finish: ${summary.fastestFinish.label}, ${formatSeconds(summary.fastestFinish.value)}`);
  if (summary.lowestCost) {
    verdicts.push(
      `- Lowest cost: ${summary.lowestCost.label}, ${formatCost(summary.lowestCost.value, summary.lowestCost.estimated ? "estimated" : "reported_usage")}${summary.lowestCost.allReported ? "" : " (some costs are estimates)"}`
    );
  }
  if (summary.effortsMatch === false) verdicts.push("- Thinking effort was not the same for every model.");
  if (summary.searchApplied === false) verdicts.push("- Not every model could search the web.");
  if (summary.modelChanged.length) verdicts.push(`- Answered by a different model than asked: ${summary.modelChanged.join(", ")}`);
  if (input.webSearch || summary.citations.union > 0) {
    verdicts.push(`- Sources: ${summary.citations.union} distinct, ${summary.citations.sharedByAll.length} cited by every model`);
  }
  if (verdicts.length) lines.push("## Summary", "", ...verdicts, "");

  if (summary.citations.union > 0) {
    lines.push("## Sources", "");
    if (summary.citations.sharedByAll.length) {
      lines.push("### Cited by every model", "");
      for (const ref of summary.citations.sharedByAll) lines.push(`- [${linkText(ref.title || ref.url)}](${markdownLinkUrl(ref.url)})`);
      lines.push("");
    }
    for (const pane of report.panes) {
      if (pane.citations.total === 0) continue;
      lines.push(`### ${pane.position}. ${pane.label} (${pane.citations.total}, ${pane.citations.unique} only here)`, "");
      for (const ref of pane.citations.refs) {
        const marks = [ref.inText ? "linked in the answer" : null, ref.sharedWith.length ? `also ${ref.sharedWith.join(", ")}` : null]
          .filter(Boolean)
          .join("; ");
        lines.push(`- [${linkText(ref.title || ref.host)}](${markdownLinkUrl(ref.url)})${marks ? ` (${marks})` : ""}`);
      }
      lines.push("");
    }
  }

  lines.push("## Answers", "");
  for (const pane of report.panes) {
    lines.push(`### ${pane.position}. ${pane.label}`, "");
    lines.push(pane.answer.trim() || (pane.error ? `_No answer: ${pane.error}_` : "_No answer._"), "");
  }

  lines.push("## Notes", "", ...report.notes.map((note) => `- ${note}`), "");
  return lines.join("\n");
}

export function compareReportToJson(report: CompareReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** `alevr-compare-20261025-1403.md` */
export function compareReportFileName(report: Pick<CompareReport, "generatedAt" | "product">, extension: "md" | "json"): string {
  const stamp = report.generatedAt.slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const product = report.product.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${product}-compare-${stamp}.${extension}`;
}
