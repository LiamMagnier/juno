"use client";

/**
 * Starred projects live in localStorage (they are a per-device view preference,
 * not server state).
 *
 * This exists because the same `JSON.parse(localStorage.getItem(...) || "[]")`
 * was copy-pasted across the projects list, the project detail page and the
 * sidebar — unguarded. A corrupt or legacy non-JSON value throws, and several of
 * those call sites run inside a useEffect during render, so one bad string took
 * the whole page down. Reading a view preference must never be able to do that.
 */

const KEY = "starredProjects";

/** Never throws: a corrupt value degrades to "nothing starred". */
export function readStarredProjects(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) || "[]");
    // Also guards the legacy shape: anything non-array, or an array of non-strings.
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Returns the next list so callers can update state without re-reading. */
export function writeStarredProjects(ids: string[]): string[] {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Storage full or blocked (Safari private mode) — the star just won't persist.
  }
  // Other surfaces (sidebar, detail page) mirror this list, so tell them.
  window.dispatchEvent(new CustomEvent("projects:sync"));
  return ids;
}

/** Toggle `id`, persist, and return the new list. */
export function toggleStarredProject(id: string): string[] {
  const current = readStarredProjects();
  return writeStarredProjects(
    current.includes(id) ? current.filter((p) => p !== id) : [...current, id]
  );
}

/** Drop a deleted project so its star can't linger as a ghost entry. */
export function removeStarredProject(id: string): string[] {
  return writeStarredProjects(readStarredProjects().filter((p) => p !== id));
}
