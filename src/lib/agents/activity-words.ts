/**
 * Activity that reads like work, not like a debug log (BRIEF §46).
 *
 *   tool_call completed     →  Scout searched 12 sources
 *   worker_4 finished       →  Researcher finished
 *   approval_requested      →  Waiting for your approval to update GitHub
 *   artifact_created        →  Report ready
 *
 * Two readings of the same Work event stream, both pure: `teamMemberLines`
 * (one line per member of a temporary team, the newest thing each did) and
 * `workSummaryLines` (what a run did, counted and named after whoever did
 * it). Every line keeps its technical side (event kinds, tool names, ids,
 * attempts) in `technical`, for a disclosure, never in the sentence.
 *
 * Client-safe.
 */

import { TEAM_ROLES, TEAM_ROLE_INFO, type TeamRole } from "@/lib/agents/team";

export interface ActivityEventLike {
  kind: string;
  payload: unknown;
  agentId?: string | null;
  createdAt: string;
  seq?: number;
  runId?: string;
}

export interface ActivityLine {
  key: string;
  sentence: string;
  /** Attention lines (waiting on the person, a failure) are drawn in the attention ink. */
  /** "missed" is a contained failure: said plainly, not as something the person must act on. */
  tone: "quiet" | "attention" | "done" | "missed";
  /** For the disclosure: what actually happened underneath. */
  technical: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** One line per team member: the newest thing it did, in the team's order. */
export function teamMemberLines(events: readonly ActivityEventLike[]): ActivityLine[] {
  const latest = new Map<TeamRole, { event: ActivityEventLike; payload: Record<string, unknown> }>();
  for (const event of events) {
    if (event.kind !== "subagent_update") continue;
    const payload = record(event.payload);
    const role = (text(payload.role) ?? event.agentId ?? "") as TeamRole;
    if (!(TEAM_ROLES as readonly string[]).includes(role)) continue;
    latest.set(role, { event, payload });
  }
  return TEAM_ROLES.filter((role) => latest.has(role)).map((role) => {
    const { event, payload } = latest.get(role)!;
    const phase = text(payload.phase) ?? "update";
    return {
      key: role,
      sentence: text(payload.title) ?? text(payload.sentence) ?? `${TEAM_ROLE_INFO[role].name} reported in`,
      tone: phase === "waiting" ? "attention" : phase === "failed" || phase === "skipped" ? "missed" : phase === "finished" ? "done" : "quiet",
      technical: [`${role}`, phase, text(payload.sessionId) ? `task ${text(payload.sessionId)}` : null, event.seq !== undefined ? `seq ${event.seq}` : null]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

/** Whether a run's events are a team's (its lead's). */
export function isTeamActivity(events: readonly ActivityEventLike[]): boolean {
  return events.some((event) => event.kind === "subagent_update" && (TEAM_ROLES as readonly string[]).includes(text(record(event.payload).role) ?? ""));
}

// ---------------------------------------------------------------------------
// A run, summarised
// ---------------------------------------------------------------------------

type ToolGroup = "search" | "read" | "files" | "code" | "app" | "other";

const SEARCH = /(^|_)(web_?search|search|google|bing|lookup|find_sources)(_|$)/i;
const READ = /(^|_)(fetch|open_url|read_url|browse|navigate|read_page|scrape|crawl|get_page)(_|$)/i;
const FILES = /(^|_)(write_file|edit_file|create_file|apply_patch|delete_file|move_file|save)(_|$)/i;
const CODE = /(^|_)(run_code|python|exec|shell|bash|terminal|run_command)(_|$)/i;

function toolGroup(name: string): ToolGroup {
  if (SEARCH.test(name)) return "search";
  if (READ.test(name)) return "read";
  if (FILES.test(name)) return "files";
  if (CODE.test(name)) return "code";
  if (name.includes("__") || /^(github|gmail|slack|notion|linear|drive|calendar|jira)/i.test(name)) return "app";
  return "other";
}

/** "GitHub" from "github__create_issue". */
function appName(tool: string): string {
  const raw = tool.split("__")[0] ?? tool;
  const known: Record<string, string> = { github: "GitHub", gmail: "Gmail", slack: "Slack", notion: "Notion", linear: "Linear", drive: "Google Drive", calendar: "Calendar", jira: "Jira" };
  return known[raw.toLowerCase()] ?? raw.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "update GitHub" for "Waiting for your approval to …". */
function approvalPhrase(payload: Record<string, unknown>): string {
  const summary = text(payload.summary) ?? text(payload.title);
  if (summary) return summary.replace(/[.!]+$/, "").replace(/^(\w)/, (c) => c.toLowerCase());
  const tool = text(payload.tool) ?? text(payload.action) ?? "";
  return tool ? `use ${appName(tool)}` : "continue";
}

/**
 * What a run did, as a few sentences named after its actor ("Scout"), in the
 * order a person cares about: what it needs, what it produced, what it did.
 */
export function workSummaryLines(events: readonly ActivityEventLike[], actor = "It"): ActivityLine[] {
  const counts: Record<ToolGroup, number> = { search: 0, read: 0, files: 0, code: 0, app: 0, other: 0 };
  const apps = new Set<string>();
  const sources = new Set<string>();
  let filesChanged = 0;
  const artifacts: string[] = [];
  const openApprovals = new Map<string, Record<string, unknown>>();
  let failed: string | null = null;
  for (const event of events) {
    const payload = record(event.payload);
    switch (event.kind) {
      case "tool_finished": {
        const tool = text(payload.tool) ?? text(payload.name) ?? "";
        if (!tool) break;
        const group = toolGroup(tool);
        counts[group] += 1;
        if (group === "app") apps.add(appName(tool));
        break;
      }
      case "source_cited": {
        const url = text(payload.url) ?? text(payload.id);
        if (url) sources.add(url);
        break;
      }
      case "files_changed": {
        const count = typeof payload.count === "number" ? payload.count : Array.isArray(payload.files) ? payload.files.length : 1;
        filesChanged += count;
        break;
      }
      case "artifact_created": {
        const kind = text(payload.kind) ?? text(payload.title) ?? "Result";
        artifacts.push(kind);
        break;
      }
      case "approval_requested": {
        const id = text(payload.approvalId) ?? text(payload.id) ?? String(event.seq ?? artifacts.length);
        openApprovals.set(id, payload);
        break;
      }
      case "approval_resolved": {
        const id = text(payload.approvalId) ?? text(payload.id);
        if (id) openApprovals.delete(id);
        break;
      }
      case "error":
        failed = text(payload.message) ?? "Something went wrong";
        break;
    }
  }
  const lines: ActivityLine[] = [];
  for (const [id, payload] of openApprovals) {
    lines.push({ key: `approval:${id}`, sentence: `Waiting for your approval to ${approvalPhrase(payload)}`, tone: "attention", technical: `approval_requested · ${text(payload.tool) ?? "action"} · ${id}` });
  }
  for (const [index, kind] of artifacts.entries()) {
    const label = kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, " ");
    lines.push({ key: `artifact:${index}`, sentence: `${label} ready`, tone: "done", technical: `artifact_created · ${kind}` });
  }
  const searched = Math.max(counts.search, 0);
  const sourceCount = sources.size;
  if (searched > 0 || sourceCount > 0) {
    lines.push({
      key: "search",
      sentence: sourceCount > 0 ? `${actor} searched ${plural(sourceCount, "source", "sources")}` : `${actor} ran ${plural(searched, "search", "searches")}`,
      tone: "quiet",
      technical: `tool_finished(search) × ${searched} · source_cited × ${sourceCount}`,
    });
  }
  if (counts.read > 0) lines.push({ key: "read", sentence: `${actor} read ${plural(counts.read, "page", "pages")}`, tone: "quiet", technical: `tool_finished(read) × ${counts.read}` });
  if (apps.size > 0) lines.push({ key: "apps", sentence: `${actor} worked in ${[...apps].join(", ")}`, tone: "quiet", technical: `tool_finished(app) × ${counts.app}` });
  if (counts.code > 0) lines.push({ key: "code", sentence: `${actor} ran code ${plural(counts.code, "time", "times")}`, tone: "quiet", technical: `tool_finished(code) × ${counts.code}` });
  if (filesChanged > 0) lines.push({ key: "files", sentence: `${actor} changed ${plural(filesChanged, "file", "files")}`, tone: "quiet", technical: `files_changed · ${filesChanged}` });
  if (failed) lines.push({ key: "error", sentence: `${actor} hit a problem: ${failed}`, tone: "attention", technical: "error" });
  return lines;
}
