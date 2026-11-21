/*
 * The projects list's own arithmetic: which projects a search and a filter
 * leave, in which order, and what a card says about when it was last used.
 * Pure and client-safe, so the page and its test read the same rules.
 */

export type ProjectSort = "activity" | "name" | "created";
export type ProjectFilter = "all" | "pinned";

export const PROJECT_SORT_OPTIONS: ReadonlyArray<{ value: ProjectSort; label: string }> = [
  { value: "activity", label: "Activity" },
  { value: "name", label: "Name" },
  { value: "created", label: "Created" },
];

export interface ProjectListEntry {
  id: string;
  name: string;
  parentId: string | null;
  description?: string;
  instructions?: string;
  starred?: boolean;
  updatedAt?: string;
  createdAt?: string;
  /** The newest of its own edits and its chats' last messages (GET /api/projects). */
  lastActivityAt?: string;
}

function time(iso: string | undefined): number {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : 0;
}

/** When the project was last used: a chat in it, or an edit to it. */
export function lastActivityOf(project: ProjectListEntry): string | undefined {
  const activity = time(project.lastActivityAt);
  const updated = time(project.updatedAt);
  if (!activity && !updated) return undefined;
  return activity >= updated ? project.lastActivityAt : project.updatedAt;
}

/**
 * The projects a list shows. With no search and no filter it is the top level
 * (folders are drawn inside their project); a search or the Pinned filter
 * looks through every level, since the match may be a folder. The search
 * reads the name and the description, never the instructions, which are a
 * prompt the person wrote for the model rather than words they would search.
 */
export function visibleProjects<T extends ProjectListEntry>(
  all: readonly T[],
  options: { query: string; filter: ProjectFilter; sort: ProjectSort },
): T[] {
  const ids = new Set(all.map((project) => project.id));
  const query = options.query.trim().toLowerCase();
  const filtering = query.length > 0 || options.filter !== "all";
  let result = filtering ? [...all] : all.filter((project) => !project.parentId || !ids.has(project.parentId));
  if (options.filter === "pinned") result = result.filter((project) => project.starred);
  if (query) {
    result = result.filter(
      (project) => project.name.toLowerCase().includes(query) || (project.description ?? "").toLowerCase().includes(query),
    );
  }
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  result.sort((a, b) => {
    if (options.sort === "name") return byName(a, b);
    if (options.sort === "created") return time(b.createdAt) - time(a.createdAt) || byName(a, b);
    return time(lastActivityOf(b)) - time(lastActivityOf(a)) || byName(a, b);
  });
  return result;
}

/** "Updated 3 days ago": the card's one line about time, from its last activity. */
export function activityLabel(project: ProjectListEntry, now: number = Date.now()): string | null {
  const iso = lastActivityOf(project);
  if (!iso) return null;
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "Updated today";
  if (days === 1) return "Updated yesterday";
  if (days < 30) return `Updated ${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Updated ${months} ${months === 1 ? "month" : "months"} ago`;
  const years = Math.floor(days / 365);
  return `Updated ${years} ${years === 1 ? "year" : "years"} ago`;
}
