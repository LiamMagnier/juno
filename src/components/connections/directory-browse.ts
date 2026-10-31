/**
 * How the app directory is browsed: what the person sees with nothing typed.
 *
 * Composio's catalogue is not filtered: `/api/connectors/composio/catalog`
 * returns every toolkit the REST listing does, searched, by category and by
 * cursor (src/lib/composio.ts `listComposioApps`). The overview, though, is a
 * showcase: a few apps from the first `FEATURED_CATEGORY_COUNT` categories,
 * with no chip row and no "Load more". Before this, the remaining categories
 * and every app outside a featured one could only be reached by guessing its
 * name in search. The overview now ends in a way into each of the rest and
 * into the whole catalogue as one paged list. The featured sections stay what
 * they were.
 *
 * Pure, so the rule is testable without a DOM (tests/connector-directory-browse.test.ts).
 */

/** How many categories the overview shows a section of apps for. */
export const FEATURED_CATEGORY_COUNT = 6;

export interface BrowseCategory {
  id: string;
  label: string;
  count?: number;
}

/** The categories the overview features, and the ones it only links to. */
export function splitDirectoryCategories<T extends BrowseCategory>(
  categories: readonly T[],
  featuredCount: number = FEATURED_CATEGORY_COUNT
): { featured: T[]; more: T[] } {
  return { featured: categories.slice(0, featuredCount), more: categories.slice(featuredCount) };
}

/**
 * What the directory shows.
 *
 * - `overview`: nothing typed, no category, not browsing everything: the
 *   featured sections, then the way into the rest.
 * - `search`: something typed; the catalogue's own search, paged.
 * - `category`: one category, paged.
 * - `all`: the whole catalogue, most used first, paged.
 * - `builtin`: Composio is not configured, so only the built-in connectors.
 */
export type DirectoryView = "overview" | "search" | "category" | "all" | "builtin";

export function directoryView(input: {
  query: string;
  category: string | null;
  browseAll: boolean;
  composioConfigured: boolean;
}): DirectoryView {
  if (!input.composioConfigured) return "builtin";
  if (input.query.trim()) return "search";
  if (input.category) return "category";
  if (input.browseAll) return "all";
  return "overview";
}

/** "Load more" belongs to every paged view, and never to the overview's showcase. */
export function directoryPages(view: DirectoryView): boolean {
  return view === "search" || view === "category" || view === "all";
}

/** The heading of the way into the whole catalogue: its size when the API said. */
export function allAppsLabel(total: number | undefined): string {
  return typeof total === "number" && total > 0 ? `All ${total.toLocaleString("en-US")} apps` : "All apps";
}
