/**
 * What the Research row and panel show, as plain functions of the run
 * (SPEC §9.11.3–§9.11.4).
 *
 * The components are thin views over these. Keeping the decisions here — which
 * count a row shows, when its clock runs, which tabs a panel has, when it
 * cross-fades to the report, what a line in the activity stream says — is
 * what lets `tests/research-ui-phase.test.ts` hold them without a DOM, and
 * what keeps the row, the panel and the report card from each growing their
 * own answer to the same question (research-UI bug 11: three surfaces, three
 * source counts).
 *
 * Every word is a `RESEARCH_COPY` phrase; queries, domains and numbers ride
 * beside it as argument nodes (§10.1).
 */

import { PRIVATE_SOURCE_LABEL, parsePrivateSourceUrl } from "@/lib/research/private-sources";
import { RESEARCH_COPY, phrase, sourcesCount } from "@/components/research/copy";
import type { ResearchRunView, ResearchSourceView } from "@/components/research/use-research-run";
import type { ResearchEventDTO } from "@/lib/research/domain";
import { RESEARCH_PHASE_UI, isTerminalPhase, isWorkingPhase } from "@/lib/research/phase";
import type { PhraseLine, PhraseSpec } from "@/lib/run/types";
import type { ResearchPhase, ResearchQuestionStatus, ResearchSteeringEntry } from "@/types/research";

/** The Research panel's views; the same union the right-column state carries. */
export type ResearchView = "progress" | "sources" | "plan" | "report" | "details";

// ── The row (§9.11.3) ─────────────────────────────────────────────────────────

/**
 * The row's clock, in `RunClock`'s terms. `workingMs` from the DTO already
 * leaves out gates and paused time (research-UI bug 9); between polls it is
 * extrapolated from when the payload was fetched while the run works, and held
 * still at a gate, while paused and at rest, so the figure never jumps on a
 * poll and never counts time nobody spent.
 */
export function researchClock(
  run: Pick<ResearchRunView, "workingMs"> | null,
  phase: ResearchPhase,
  fetchedAt: number | null,
): { elapsedMs: number; since: number | null } {
  const elapsedMs = Math.max(0, Number.isFinite(run?.workingMs) ? (run?.workingMs as number) : 0);
  return { elapsedMs, since: isWorkingPhase(phase) && fetchedAt !== null ? fetchedAt : null };
}

/**
 * One count vocabulary (research-UI bug 11): pages READ while the run works,
 * sources CITED once it is over. A run from before `counts` existed falls back
 * to its source rows.
 */
export function rowSourceCount(
  run: Pick<ResearchRunView, "counts"> & { sources?: ReadonlyArray<Pick<ResearchSourceView, "read">> },
  phase: ResearchPhase,
): number {
  const counts = run.counts;
  const read = counts?.read ?? run.sources?.filter((s) => s.read).length ?? 0;
  if (!isTerminalPhase(phase)) return read;
  return counts?.cited ?? read;
}

/** The first sources the row's favicon stack shows: read pages, in the order they were read. */
export function rowFavicons(run: { sources?: ReadonlyArray<Pick<ResearchSourceView, "url" | "title" | "read">> }): Array<{ url: string; title?: string }> {
  return (run.sources ?? []).filter((s) => s.read).map((s) => ({ url: s.url, title: s.title }));
}

/**
 * The row's sentence. At rest after a report it is the static "Report ready"
 * (the affordance beside it becomes "Open report"); otherwise the phase line.
 */
export function rowLine(phase: ResearchPhase, run: ResearchRunView | null): PhraseLine {
  if (!run) return RESEARCH_PHASE_UI.planning.line({});
  return RESEARCH_PHASE_UI[phase].line(run);
}

/** Which panel view the row opens: the report once there is one, else the progress. */
export function rowOpensView(phase: ResearchPhase, run: Pick<ResearchRunView, "report"> | null): ResearchView {
  return phase === "done" && !!run?.report ? "report" : "progress";
}

/**
 * The row's accessible name: a stable noun phrase, "Research. {phase line}.
 * {n sources}. Open research panel" (§9.11.3). The count rides in the name
 * because below 28rem the favicon stack and the count leave the row.
 */
export function rowNameLine(phase: ResearchPhase, run: ResearchRunView | null, sources: number): PhraseLine {
  const line: PhraseSpec[] = [phrase(RESEARCH_COPY.row.research), ...rowLine(phase, run)];
  if (sources > 0) line.push(sourcesCount(sources));
  line.push(phrase(rowOpensView(phase, run) === "report" ? RESEARCH_COPY.row.openReport : RESEARCH_COPY.row.openPanel));
  return line;
}

// ── The panel's tabs (§9.11.4) ───────────────────────────────────────────────

export const TAB_LABEL: Record<ResearchView, string> = {
  progress: RESEARCH_COPY.tabs.progress,
  sources: RESEARCH_COPY.tabs.sources,
  plan: RESEARCH_COPY.tabs.plan,
  report: RESEARCH_COPY.tabs.report,
  details: RESEARCH_COPY.tabs.details,
};

/**
 * Progress · Sources · Plan while the run is live; Report · Sources · Plan ·
 * Details once it is over. A run that ended without a report keeps Progress
 * where the report would be: what happened is the only story it has.
 */
export function panelTabs(phase: ResearchPhase, hasReport: boolean): ResearchView[] {
  if (!isTerminalPhase(phase)) return ["progress", "sources", "plan"];
  return hasReport ? ["report", "sources", "plan", "details"] : ["progress", "sources", "plan", "details"];
}

/** The view to show: the asked-for one when the run has it, else its first tab. */
export function coerceView(view: ResearchView, tabs: readonly ResearchView[]): ResearchView {
  return tabs.includes(view) ? view : tabs[0];
}

/**
 * The completion cross-fade (§9.11.4, deep-research audit §6.3): when a run
 * finishes while the panel shows Progress, the panel moves to the Report —
 * unless the reader picked a tab during the run, in which case what they
 * picked stays.
 */
export function viewOnCompletion(input: {
  view: ResearchView;
  /** The reader chose a tab since the panel opened on this run. */
  userPicked: boolean;
  wasTerminal: boolean;
  phase: ResearchPhase;
  hasReport: boolean;
}): ResearchView {
  const tabs = panelTabs(input.phase, input.hasReport);
  if (!input.wasTerminal && isTerminalPhase(input.phase) && input.hasReport && !input.userPicked && input.view === "progress") {
    return "report";
  }
  return coerceView(input.view, tabs);
}

// ── The header controls (§9.7) ───────────────────────────────────────────────

export interface PanelControls {
  pause: boolean;
  resume: boolean;
  /** "Finish now": shown while it can still change something, disabled once asked for. */
  finish: "shown" | "disabled" | "hidden";
  /** "Finishing with what it has" in the header, from the answer, until the writing starts. */
  finishing: boolean;
  cancel: boolean;
}

export function panelControls(run: Pick<ResearchRunView, "finishRequested" | "live"> | null, phase: ResearchPhase): PanelControls {
  const none: PanelControls = { pause: false, resume: false, finish: "hidden", finishing: false, cancel: false };
  if (!run || !run.live || isTerminalPhase(phase)) return none;
  const gate = phase === "awaiting_start" || phase === "planning";
  const writing = phase === "writing" || phase === "checking";
  const requested = !!run.finishRequested;
  return {
    pause: !gate && phase !== "paused" && !writing,
    resume: phase === "paused",
    finish: gate || writing ? "hidden" : requested ? "disabled" : "shown",
    finishing: requested && !writing,
    cancel: true,
  };
}

// ── Progress (§9.11.4) ────────────────────────────────────────────────────────

/** "In progress", never "Searching": that word is the verb prefix elsewhere (§7.6). */
export const QUESTION_STATUS_PHRASE: Record<ResearchQuestionStatus, string> = {
  pending: RESEARCH_COPY.questionStatus.pending,
  searching: RESEARCH_COPY.questionStatus.searching,
  covered: RESEARCH_COPY.questionStatus.covered,
  partial: RESEARCH_COPY.questionStatus.partial,
  thin: RESEARCH_COPY.questionStatus.thin,
};

/** A steering row: ["You", quote] · ["Applies at the next round"] or ["Applied in round", n]. */
export function steeringLine(entry: Pick<ResearchSteeringEntry, "text" | "appliedAtRound">): PhraseLine {
  return [
    { parts: [{ phrase: RESEARCH_COPY.steer.you }, { kind: "quote", value: entry.text }] },
    entry.appliedAtRound === null
      ? phrase(RESEARCH_COPY.steer.appliesNext)
      : { parts: [{ phrase: RESEARCH_COPY.steer.appliedIn }, { kind: "number", value: entry.appliedAtRound }] },
  ];
}

export interface ActivityLine {
  /** The event's id: a line is never re-keyed by a poll (research-UI bug 24). */
  key: string;
  seq: number;
  at: string;
  line: PhraseLine;
  tone: "default" | "warning";
}

export const MAX_ACTIVITY_LINES = 50;

function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function int(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function hostOf(url: string): string {
  const own = parsePrivateSourceUrl(url);
  if (own) return PRIVATE_SOURCE_LABEL[own.kind];
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const one = (text: string): PhraseLine => [phrase(text)];

/**
 * The Progress tab's activity stream: one line per round boundary and per
 * notable event, newest first, at most 50. Searches and page opens are
 * notable (they are what the run is doing); ranking, leases, spend and the
 * stage bookkeeping are not.
 */
export function activityLines(events: readonly ResearchEventDTO[], max = MAX_ACTIVITY_LINES): ActivityLine[] {
  const out: ActivityLine[] = [];
  const roundsStarted = new Set<number>();
  const ownKinds = new Set<string>();
  const push = (event: ResearchEventDTO, line: PhraseLine, tone: ActivityLine["tone"] = "default") => {
    out.push({ key: event.id, seq: event.seq, at: event.createdAt, line, tone });
  };

  for (const event of events) {
    const p = event.payload ?? {};
    switch (event.kind) {
      case "run_started":
        push(event, one(RESEARCH_COPY.activity.started));
        break;
      case "worker_spawned": {
        const round = int(p, "round") ?? 1;
        if (roundsStarted.has(round)) break;
        roundsStarted.add(round);
        push(event, [{ parts: [{ phrase: RESEARCH_COPY.activity.startedRound }, { kind: "number", value: round }] }]);
        break;
      }
      case "round_reviewed": {
        const round = int(p, "round");
        const claims = int(p, "claims");
        const line: PhraseSpec[] = [
          round === null
            ? phrase(RESEARCH_COPY.activity.finishedRound)
            : { parts: [{ phrase: RESEARCH_COPY.activity.finishedRound }, { kind: "number", value: round }] },
        ];
        if (claims !== null && claims > 0) {
          line.push({ parts: [{ kind: "count", n: claims, one: RESEARCH_COPY.count.finding, other: RESEARCH_COPY.count.findings }] });
        }
        push(event, line);
        break;
      }
      case "follow_up_scheduled":
        push(event, one(RESEARCH_COPY.activity.anotherRound));
        break;
      case "query_issued": {
        // A web search withheld because it repeated the person's own data.
        if (str(p, "withheld") === "private") {
          push(event, one(RESEARCH_COPY.activity.keptPrivate));
          break;
        }
        const query = str(p, "query");
        // A worker's queries arrive again as its tool calls below; count each once.
        if (!query || str(p, "workerId")) break;
        push(event, [{ parts: [{ phrase: RESEARCH_COPY.activity.searchedFor }, { kind: "quote", value: query }] }]);
        break;
      }
      case "worker_tool_call": {
        const tool = str(p, "tool");
        const arg = str(p, "arg");
        if (!arg || p.ok === false) break;
        if (tool === "search") {
          push(event, [{ parts: [{ phrase: RESEARCH_COPY.activity.searchedFor }, { kind: "quote", value: arg }] }]);
        } else if (tool === "open_page") {
          const host = hostOf(arg);
          if (host) push(event, [{ parts: [{ phrase: RESEARCH_COPY.activity.opened }, { kind: "domain", value: host }] }]);
        }
        break;
      }
      case "source_read": {
        // The person's own sources: one line per kind, the first time it is read.
        const ownKind = str(p, "private");
        if (ownKind) {
          if (ownKinds.has(ownKind)) break;
          ownKinds.add(ownKind);
          const label = PRIVATE_SOURCE_LABEL[ownKind as keyof typeof PRIVATE_SOURCE_LABEL];
          push(event, label ? [{ parts: [{ phrase: RESEARCH_COPY.activity.searchedOwn }, { kind: "domain", value: label }] }] : one(RESEARCH_COPY.activity.searchedOwn));
          break;
        }
        // Ranked reads resolve inside the searches above; a pinned read has no search.
        if (p.pinned !== true) break;
        const host = hostOf(str(p, "url"));
        if (host) push(event, [{ parts: [{ phrase: RESEARCH_COPY.activity.opened }, { kind: "domain", value: host }] }]);
        break;
      }
      case "conflict_found":
        if (str(p, "kind") !== "duplicate_content") push(event, one(RESEARCH_COPY.activity.sourcesDisagree), "warning");
        break;
      case "steering_applied":
        push(event, one(RESEARCH_COPY.activity.appliedGuidance));
        break;
      case "paused":
        push(event, one(RESEARCH_COPY.activity.paused));
        break;
      case "resumed":
        push(event, one(RESEARCH_COPY.activity.resumed));
        break;
      case "budget_exhausted":
        push(event, one(RESEARCH_COPY.activity.spendingLimit), "warning");
        break;
      case "state_changed":
        if (str(p, "state") === "synthesizing") push(event, one(RESEARCH_COPY.activity.writing));
        break;
      case "report_ready":
        push(event, one(RESEARCH_COPY.activity.drafted));
        break;
      case "citation_audit_completed":
      case "citation_audit":
        push(event, one(RESEARCH_COPY.activity.checkedCitations));
        break;
      case "cancelled":
        push(event, one(RESEARCH_COPY.activity.stopped));
        break;
      default:
        break;
    }
  }
  out.sort((a, b) => b.seq - a.seq);
  return out.slice(0, Math.max(0, max));
}

// ── Sources (§9.11.4) ─────────────────────────────────────────────────────────

export interface SourceRowView {
  key: string;
  url: string;
  title: string;
  domain: string;
  /** The citation number, for a cited source. */
  cited?: number;
}

export interface SourceSections {
  cited: SourceRowView[];
  read: SourceRowView[];
  found: SourceRowView[];
}

/**
 * Cited (after the report, numbered, in citation order), Read (opened, not
 * cited) and Found (searched, not opened). `citationOrder` is the list the
 * report's `[n]` resolve into and `citedNumbers` the markers the report uses;
 * before a report both are empty and nothing is "cited" yet.
 */
export function sourceSections(
  sources: readonly ResearchSourceView[],
  citationOrder: ReadonlyArray<{ url: string; title: string }> = [],
  citedNumbers: ReadonlySet<number> = new Set(),
): SourceSections {
  const cited: SourceRowView[] = [];
  const citedUrls = new Set<string>();
  citationOrder.forEach((source, i) => {
    const n = i + 1;
    if (!citedNumbers.has(n) || citedUrls.has(source.url)) return;
    citedUrls.add(source.url);
    cited.push({ key: `cited:${n}`, url: source.url, title: source.title || hostOf(source.url), domain: hostOf(source.url), cited: n });
  });
  const read: SourceRowView[] = [];
  const found: SourceRowView[] = [];
  for (const source of sources) {
    if (citedUrls.has(source.url)) continue;
    const row = { key: source.id, url: source.url, title: source.title || hostOf(source.url), domain: hostOf(source.url) };
    (source.read ? read : found).push(row);
  }
  return { cited, read, found };
}

// ── Plan and details ──────────────────────────────────────────────────────────

/** What bounded the run, in words, when it was not its own scope. */
export function limitedByPhrase(limitedBy: "scope" | "plan" | "month" | "window" | null | undefined): string | null {
  switch (limitedBy) {
    case "plan":
      return RESEARCH_COPY.plan.limitedPlan;
    case "month":
      return RESEARCH_COPY.plan.limitedMonth;
    case "window":
      return RESEARCH_COPY.plan.limitedWindow;
    default:
      return null;
  }
}

/** Why a run that stopped early stopped, for the report's notice line. */
export function stoppedEarlyReason(events: readonly Pick<ResearchEventDTO, "kind">[], finishRequested?: boolean): string | null {
  if (finishRequested) return RESEARCH_COPY.report.stoppedByYou;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "budget_exhausted") return RESEARCH_COPY.report.stoppedBudget;
  }
  return null;
}

// ── Which models did the work ────────────────────────────────────────────────

/**
 * The models line, beside the spend and under the report title: only what the
 * run recorded, so a run from before models were recorded says nothing.
 *
 *   chosen, all stages   "Running on Claude Opus 4.5"
 *   chosen, no tools     "Running on GPT-5 Pro · Search by Claude Haiku 4.5 · GPT-5 Pro has no tool calling"
 *   Auto, two models     "Led by Claude Opus 4.5 · Researchers on Claude Haiku 4.5"
 *   chosen, refused      "Gemini 3.5 Flash-Lite isn't available on your plan · Led by Claude Fable 5.1 · Researchers on …"
 *
 * The writer is named only when it is not the lead (a chat that streamed the
 * report through its own model).
 */
export function modelsLine(models: ResearchRunView["models"], done: boolean): PhraseLine | null {
  if (!models) return null;
  const M = RESEARCH_COPY.models;
  const label = (value: string) => ({ kind: "label" as const, value });
  const line: PhraseSpec[] = [];
  const worker = models.worker;
  if (!worker || worker.id === models.lead.id || models.chosen) {
    line.push({ parts: [{ phrase: done ? M.ranOn : M.runningOn }, label(models.lead.label)] });
    if (worker && worker.id !== models.lead.id) {
      line.push({ parts: [{ phrase: M.searchBy }, label(worker.label)] });
      if (models.workerNote) {
        line.push({ parts: [label(models.lead.label), { phrase: models.workerNote === "no_tools" ? M.noTools : M.noLoop }] });
      }
    }
  } else {
    line.push({ parts: [{ phrase: M.ledBy }, label(models.lead.label)] });
    line.push({ parts: [{ phrase: M.researchersOn }, label(worker.label)] });
  }
  // The person picked a model that could not lead: say so first, so the
  // models that follow read as the stand-in they are, never as their choice.
  const refused = models.chosenRefused;
  if (refused && !models.chosen && refused.model.id !== models.lead.id) {
    const why = refused.reason === "plan" ? M.chosenNotOnPlan : refused.reason === "not_configured" ? M.chosenNotConfigured : M.chosenUnavailable;
    line.unshift({ parts: [label(refused.model.label), { phrase: why }] });
  }
  if (models.writer && models.writer.id !== models.lead.id) {
    line.push({ parts: [{ phrase: RESEARCH_COPY.report.writtenBy }, label(models.writer.label)] });
  }
  return line;
}

/** The one model name beside the spend: the run's lead, or nothing when unrecorded. */
export function headerModelLabel(models: ResearchRunView["models"]): string | null {
  return models?.lead.label ?? null;
}
