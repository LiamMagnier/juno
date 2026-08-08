/**
 * The shapes unified search speaks in.
 *
 * Free of `server-only` and of Prisma on purpose: the palette imports these to
 * render results, the API route imports them to validate a request, and the
 * tests import them without standing up a database. Only src/lib/search/index.ts
 * touches Postgres.
 *
 * The one idea worth stating up front is `SearchCoverage`. Juno cannot search
 * everything with equal confidence — message bodies are encrypted at rest, some
 * sources are scanned within a bounded window, and any single source can fail
 * on its own. A search UI that quietly returns fewer results in those cases
 * teaches people that Juno "doesn't have" something it does have, and that is
 * unrecoverable: nobody re-runs a search that already looked complete. So every
 * source reports what it actually covered, and the UI is obliged to say so.
 */

/**
 * The kinds of thing a person can look for. Order is the order groups are
 * rendered in — conversations and their messages first because that is what
 * most searches are for, memories and Work last because they are the rarest.
 */
export const SEARCH_TYPES = [
  "conversation",
  "message",
  "project",
  "file",
  "knowledge",
  "artifact",
  "memory",
  "work",
] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

export function isSearchType(value: string): value is SearchType {
  return (SEARCH_TYPES as readonly string[]).includes(value);
}

/** Group headings. Plain nouns — the row underneath already says which one it is. */
export const SEARCH_TYPE_LABELS: Record<SearchType, string> = {
  conversation: "Chats",
  message: "Messages",
  project: "Projects",
  file: "Files",
  knowledge: "Knowledge",
  artifact: "Artifacts",
  memory: "Memory",
  work: "Work",
};

/**
 * A matched span inside a snippet, as offsets rather than markup.
 *
 * Offsets, not `<mark>` tags in a string: the snippet comes from user content,
 * and the moment highlighting is expressed as HTML somebody has to decide
 * whether to escape it. Offsets cannot be mis-rendered into an injection, and
 * they let the native clients highlight with their own attributed strings.
 */
export interface SearchMark {
  start: number;
  end: number;
}

export interface SearchSnippet {
  /** One line of context, already elided at both ends where it was cut. */
  text: string;
  /** Ascending, non-overlapping. Offsets index `text`. */
  marks: SearchMark[];
}

/**
 * One result.
 *
 * `href` is the contract that makes this search rather than a list: it resolves
 * to the exact place the match lives — the message inside the conversation, the
 * version of the artifact, the page of the document — not merely the container
 * it belongs to.
 */
export interface SearchHit {
  /** Unique across types, so React keys and keyboard cursors cannot collide. */
  id: string;
  type: SearchType;
  title: string;
  /**
   * Matched spans inside `title`, same offset convention as a snippet.
   *
   * Separate from `snippet` because a chat matched on its title has no body to
   * excerpt, and rendering the row with nothing highlighted anywhere leaves the
   * reader to work out for themselves why it is in the list.
   */
  titleMarks: SearchMark[];
  snippet: SearchSnippet | null;
  href: string;
  /**
   * Where in the product this sits, when it sits anywhere: "page 4", "v3",
   * "step 12". Rendered as trailing meta, never as the title.
   */
  locator: string | null;
  /** For the project filter, and null for the things that have no project. */
  projectId: string | null;
  /** ISO. Recency is the tie-breaker for equally-relevant hits. */
  updatedAt: string;
  /** Postgres relevance, already weighted by type. Higher is better. */
  score: number;
}

export type CoverageState = "complete" | "partial" | "unavailable";

/**
 * What one source actually managed to search.
 *
 * `detail` is user-facing copy and is mandatory for anything other than
 * "complete" — a partial result that cannot explain itself is the failure this
 * type exists to prevent.
 */
export interface SearchCoverage {
  type: SearchType;
  state: CoverageState;
  detail: string | null;
}

export interface SearchGroup {
  type: SearchType;
  label: string;
  hits: SearchHit[];
}

export interface UnifiedSearchResult {
  /** Echoed back so a late response can be discarded against the live input. */
  query: string;
  groups: SearchGroup[];
  total: number;
  coverage: SearchCoverage[];
  /** True when any source returned less than everything it holds. */
  partial: boolean;
}

/** Date windows the palette offers. Bounded set: a free-form range is a form, not a palette. */
export const SEARCH_WINDOWS = ["any", "week", "month", "year"] as const;
export type SearchWindow = (typeof SEARCH_WINDOWS)[number];

export function isSearchWindow(value: string): value is SearchWindow {
  return (SEARCH_WINDOWS as readonly string[]).includes(value);
}

export const SEARCH_WINDOW_LABELS: Record<SearchWindow, string> = {
  any: "Any time",
  week: "Past week",
  month: "Past month",
  year: "Past year",
};

const DAY_MS = 86_400_000;

/** The `since` a window means, or null for "any time". */
export function windowSince(window: SearchWindow, now: Date = new Date()): Date | null {
  const days = window === "week" ? 7 : window === "month" ? 30 : window === "year" ? 365 : 0;
  return days === 0 ? null : new Date(now.getTime() - days * DAY_MS);
}
