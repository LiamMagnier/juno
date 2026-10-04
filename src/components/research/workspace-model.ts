import type { ResearchEventDTO } from "@/lib/research/domain";
import { isResearchState, isWorkingResearchState } from "@/lib/research/domain";
import type { ResearchRunView } from "./use-research-run";

export const WORKSPACE_STAGES = [
  { id: "plan", label: "Plan" },
  { id: "investigate", label: "Read sources" },
  { id: "review", label: "Review evidence" },
  { id: "write", label: "Write report" },
  { id: "check", label: "Check citations" },
] as const;

const STAGE_INDEX: Record<string, number> = {
  accepted: 0, clarifying: 0, planning: 0, awaiting_clarification: 0,
  awaiting_plan_confirmation: 0, investigating: 1, reviewing: 2,
  synthesizing: 3, validating_citations: 4, completed: 5,
};

export type WorkspaceQuestion = {
  id: string; question: string; status: string; sourceIds: string[];
};

/** Presentation from durable evidence only. Never estimate progress from time. */
export function researchWorkspace(run: ResearchRunView, events: readonly ResearchEventDTO[]) {
  let stage = STAGE_INDEX[run.state] ?? -1;
  if (run.state === "paused" || run.state === "awaiting_user_input") {
    const previous = [...events].reverse().find(event =>
      event.kind === "state_changed" && typeof event.payload.from === "string" && event.payload.state === run.state,
    );
    stage = previous ? STAGE_INDEX[String(previous.payload.from)] ?? -1 : -1;
  }
  const questions: WorkspaceQuestion[] = (run.questions?.length ? run.questions : run.plan.objectives ?? []).map(question => ({
    id: question.id,
    question: question.question,
    status: question.status,
    sourceIds: [...new Set((run.plan.coverage ?? [])
      .filter(entry => entry.objectiveId === question.id)
      .flatMap(entry => entry.supportingSourceIds))]
      .filter(id => run.sources.some(source => source.id === id && source.read)),
  }));
  const workers = new Map<string, { id: string; label: string; state: "working" | "finished" }>();
  for (const event of events) {
    const id = typeof event.payload.workerId === "string" ? event.payload.workerId : null;
    if (!id) continue;
    if (event.kind === "worker_spawned") {
      const label = [event.payload.role, event.payload.brief, event.payload.objective]
        .find(value => typeof value === "string" && value.trim());
      workers.set(id, { id, label: typeof label === "string" ? label : "Researcher", state: "working" });
    }
    if (event.kind === "worker_finished" && workers.has(id)) workers.get(id)!.state = "finished";
  }
  const working = isWorkingResearchState(run.state);
  return {
    stage,
    questions,
    workers: [...workers.values()],
    activeWorkers: working ? [...workers.values()].filter(worker => worker.state === "working").length : 0,
    found: run.counts?.found ?? run.sources.length,
    read: run.counts?.read ?? run.sources.filter(source => source.read).length,
    // Absent citation indexing means unknown, not zero citations.
    cited: run.counts?.cited ?? (run.sources.some(source => source.citedIndex != null)
      ? run.sources.filter(source => source.citedIndex != null).length : null),
    canGuide: run.live && (working || run.state === "paused") && !run.finishRequested,
    currentSource: working ? [...events].reverse().find(event => event.kind === "source_read" || event.kind === "query_issued") : undefined,
  };
}

function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * The host being read right now, for the field's one presence line: the
 * server's own `phaseDetail.domain` while it says it is reading, else the
 * newest page a researcher opened while the run is still investigating.
 * Nothing while the run is not working: a paused map has no live object.
 */
export function readingHost(run: Pick<ResearchRunView, "state" | "phase" | "phaseDetail">, events: readonly ResearchEventDTO[]): string | null {
  if (!isResearchState(run.state) || !isWorkingResearchState(run.state)) return null;
  const domain = run.phaseDetail?.domain?.trim();
  if (run.phase === "reading" && domain) return domain.replace(/^www\./, "");
  if (run.state !== "investigating") return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "state_changed") return null;
    const url = event.kind === "worker_tool_call" && event.payload.tool === "open_page" && event.payload.ok !== false
      ? event.payload.arg
      : event.kind === "source_read" ? event.payload.url : null;
    if (typeof url === "string") return hostOfUrl(url);
  }
  return null;
}

/** Questions answered so far, for the rail's heading. */
export function answeredCount(questions: readonly Pick<WorkspaceQuestion, "status">[]): number {
  return questions.filter((question) => question.status === "covered").length;
}

export function questionState(status: string): string {
  switch (status) {
    case "covered": return "Answered";
    case "partial": return "Partial evidence";
    case "thin": return "Needs evidence";
    case "searching": return "Investigating";
    default: return "Pending";
  }
}

/** An audit with unverified claims must never get a clean shield. */
export function researchAuditClean(audit: NonNullable<ResearchRunView["auditSummary"]>): boolean {
  return audit.claims > 0 && audit.supported === audit.claims &&
    audit.partiallySupported + audit.unsupported + audit.contradicted + audit.unverified === 0;
}
