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
