/**
 * The Code sidebar's sections (DESIGN §4.1) and the FLIP plan for list
 * reorders (INTERACTION I-14, T3 Code's Sidebar.motion timing): displaced
 * rows translate from their old position over 150 ms, travel is clamped to
 * 40 px for a row whose neighbours did not move, and fades are skipped when
 * more than 40 rows would fade in one update.
 */

export type ThreadState = "idle" | "running" | "waiting" | "limited" | "error";

export interface ThreadSummary {
  id: string;
  title: string;
  /** Project / repo name the thread belongs to. */
  project: string;
  state: ThreadState;
  /** ISO-8601 last activity. */
  updatedAt: string;
  pinned?: boolean;
  /** What it is waiting for ("wants to run a command"). */
  waitingFor?: string;
  /** The branch or worktree the session writes to ("alevr/server-totals"). */
  branch?: string;
  /** Its pull request number, once one is open. */
  pr?: number;
  /** New activity the reader has not opened yet (title in weight 500). */
  unread?: boolean;
  /** Done with: listed under the collapsed "Settled" divider. */
  settled?: boolean;
}

export interface ThreadSection {
  id: string;
  title: string;
  /** Project sections carry a folder glyph header row; Needs you does not. */
  kind: "needs-you" | "pinned" | "project";
  threads: ThreadSummary[];
}

const byRecent = (a: ThreadSummary, b: ThreadSummary) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title);

/** Needs you first (each thread also stays in its project), then pinned, then projects by most recent activity. */
export function threadSections(threads: readonly ThreadSummary[]): ThreadSection[] {
  const sections: ThreadSection[] = [];
  const needs = threads.filter((t) => t.state === "waiting").sort(byRecent);
  if (needs.length) sections.push({ id: "needs-you", title: "Needs you", kind: "needs-you", threads: needs });
  const pinned = threads.filter((t) => t.pinned).sort(byRecent);
  if (pinned.length) sections.push({ id: "pinned", title: "Pinned", kind: "pinned", threads: pinned });
  const byProject = new Map<string, ThreadSummary[]>();
  for (const t of threads) {
    if (t.pinned) continue;
    const list = byProject.get(t.project) ?? [];
    list.push(t);
    byProject.set(t.project, list);
  }
  const projects = [...byProject.entries()]
    .map(([project, list]) => ({ project, list: list.sort(byRecent) }))
    .sort((a, b) => byRecent(a.list[0], b.list[0]));
  for (const { project, list } of projects) sections.push({ id: `project:${project}`, title: project, kind: "project", threads: list });
  return sections;
}

/** The trailing glyph for a row: spinner while running, coral hand when it needs you; nothing otherwise. */
export function threadTrailingGlyph(state: ThreadState): "loading" | "needs-you" | "pause-circle" | "error-circle" | null {
  switch (state) {
    case "running":
      return "loading";
    case "waiting":
      return "needs-you";
    case "limited":
      return "pause-circle";
    case "error":
      return "error-circle";
    default:
      return null;
  }
}

export const FLIP_DURATION_MS = 150;
export const FLIP_MAX_TRAVEL = 40;
export const FLIP_MAX_FADES = 40;

export interface FlipPlan {
  /** Rows to translate: id → dy (old − new), already clamped. */
  moves: Map<string, number>;
  entering: string[];
  leaving: string[];
  /** Too many fades in one update: translate only. */
  skipFades: boolean;
}

/**
 * Plan a FLIP from two ordered lists of measured row tops. Keys are row ids,
 * values the row's top in px; the order of `next` is the new list order.
 */
export function planFlip(prev: ReadonlyMap<string, number>, next: ReadonlyMap<string, number>): FlipPlan {
  const ids = [...next.keys()];
  const raw = new Map<string, number>();
  const entering: string[] = [];
  for (const id of ids) {
    const before = prev.get(id);
    if (before === undefined) entering.push(id);
    else raw.set(id, before - (next.get(id) ?? 0));
  }
  const leaving = [...prev.keys()].filter((id) => !next.has(id));
  const moves = new Map<string, number>();
  ids.forEach((id, i) => {
    const dy = raw.get(id);
    if (dy === undefined || dy === 0) return;
    const neighbourMoved = [ids[i - 1], ids[i + 1]].some((n) => n !== undefined && (raw.get(n) ?? 0) !== 0);
    const clamped = neighbourMoved ? dy : Math.max(-FLIP_MAX_TRAVEL, Math.min(FLIP_MAX_TRAVEL, dy));
    moves.set(id, clamped);
  });
  return { moves, entering, leaving, skipFades: entering.length + leaving.length > FLIP_MAX_FADES };
}

// ── The list of work (Alevr Code v4 sidebar, T3 Code's thread list) ────────

/** How long a finished session stays in the active list before it settles by itself. */
export const SETTLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export interface WorkList {
  /** Needs you first, then working, then the rest by recency. No section headers. */
  active: ThreadSummary[];
  /** Behind the "Settled (n)" divider, newest first. */
  settled: ThreadSummary[];
}

const STATE_RANK: Record<ThreadState, number> = { waiting: 0, running: 1, limited: 2, error: 2, idle: 3 };

export function isSettled(t: ThreadSummary, now = Date.now()): boolean {
  if (t.state === "waiting" || t.state === "running") return false;
  if (t.settled !== undefined) return t.settled;
  return now - Date.parse(t.updatedAt) > SETTLE_AFTER_MS;
}

/** One flat list of work, optionally filtered to a project, and the settled rest. */
export function workList(threads: readonly ThreadSummary[], opts: { project?: string | null; now?: number } = {}): WorkList {
  const now = opts.now ?? Date.now();
  const pool = opts.project ? threads.filter((t) => t.project === opts.project) : [...threads];
  const active = pool
    .filter((t) => !isSettled(t, now))
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || byRecent(a, b));
  const settled = pool.filter((t) => isSettled(t, now)).sort(byRecent);
  return { active, settled };
}

/** Projects in the list, most recently active first. */
export function workProjects(threads: readonly ThreadSummary[]): string[] {
  const latest = new Map<string, string>();
  for (const t of threads) if ((latest.get(t.project) ?? "") < t.updatedAt) latest.set(t.project, t.updatedAt);
  return [...latest.entries()].sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0])).map(([p]) => p);
}

/** "now", "12m", "3h", "2d", "5w": the sidebar's trailing age. */
export function relativeAge(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}
