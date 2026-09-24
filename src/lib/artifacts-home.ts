import { artifactPath, chatArtifactPath } from "@/lib/artifact-links";
import type { ArtifactType } from "@/lib/message-content";

/**
 * The Artifacts home's URL grammar and its filter rules, as plain functions.
 *
 * `/artifacts?type=DESIGN` is now where a Design door's traffic lands (the
 * `/design` redirect, ⌘K's "Design" alias, a bookmark), and `?new=design` is a
 * link that arrives with the New menu open on the presets. Both are read from
 * the URL by a client page; the reading lives here so it can be tested without
 * rendering one — a page file cannot export anything but its page.
 */

/** The home's filter: one type, or every type. */
export type HomeTypeFilter = ArtifactType | "ALL";

/**
 * The order the type chips read in.
 *
 * Designs first. It is the one chip that always shows (see `homeTypeChips`),
 * and a chip that is always there belongs at the front, where it does not shift
 * every time a kind to its left appears or goes. The rest keep the order they
 * have always had.
 */
export const HOME_TYPE_ORDER: readonly ArtifactType[] = [
  "DESIGN",
  "HTML",
  "REACT",
  "CODE",
  "MARKDOWN",
  "SVG",
  "MERMAID",
];

/**
 * `?type=` as a filter.
 *
 * Case-insensitive, so `?type=design` (the registry noun the plan writes,
 * §5.1) and `?type=DESIGN` (the enum the contract writes) are one link. A value
 * that names no type is ignored rather than trusted: an unknown filter would
 * render an empty page with no chip selected to explain it.
 */
export function homeTypeFromParam(value: string | null | undefined): HomeTypeFilter {
  if (!value) return "ALL";
  const upper = value.trim().toUpperCase();
  return (HOME_TYPE_ORDER as readonly string[]).includes(upper) ? (upper as ArtifactType) : "ALL";
}

/**
 * The URL for a filter, keeping every other parameter the page was given.
 *
 * Written back with `history.replaceState` when a chip changes, so a reload or
 * a copied link keeps the filter the reader chose. "All" removes the parameter
 * rather than writing `?type=ALL`: the bare page is the unfiltered one.
 */
export function homeHrefForType(currentSearch: string, filter: HomeTypeFilter): string {
  const params = new URLSearchParams(currentSearch);
  if (filter === "ALL") params.delete("type");
  else params.set("type", filter);
  const query = params.toString();
  return query ? `/artifacts?${query}` : "/artifacts";
}

/**
 * `?new=` as a request to open the New menu. Only `design` means anything
 * today; App, Doc and Deck join the menu when their create routes exist.
 */
export function homeNewFromParam(value: string | null | undefined): "design" | null {
  return value?.trim().toLowerCase() === "design" ? "design" : null;
}

/**
 * Which type chips show, in order.
 *
 * A chip shows when there is something under it — except Designs, which always
 * shows (04-MERGE-PLAN §4.2). `/design` redirects to it, and with the Design
 * row gone from the sidebar this chip is how a person who has never made a
 * design finds out that designs are made here.
 */
export function homeTypeChips(present: Iterable<ArtifactType>): ArtifactType[] {
  const seen = new Set(present);
  return HOME_TYPE_ORDER.filter((type) => type === "DESIGN" || seen.has(type));
}

/**
 * The filter actually applied, given the chips on screen (L31).
 *
 * A filter can outlive its chip: the last Diagram is deleted while Diagrams is
 * on, or a link says `?type=REACT` to an account with no components. Held
 * as-is, that filter hides every row behind a chip nobody can see to turn off.
 * So a filter with no chip is read as All — without forgetting it, so the
 * chip comes back selected if its kind reappears.
 */
export function effectiveHomeFilter(filter: HomeTypeFilter, chips: readonly ArtifactType[]): HomeTypeFilter {
  if (filter === "ALL") return "ALL";
  return chips.includes(filter) ? filter : "ALL";
}

/**
 * Where an artifact opens: its canonical page, `/a/{id}` (04-MERGE-PLAN §5.1).
 *
 * One link for every type. A design gets its full-window editor there; every
 * other kind gets its full-window view, which links back to its chat. The id,
 * not the per-chat identifier, because the id survives a rename, a new type
 * and a re-created identifier, and the identifier survives none of them.
 *
 * Spelled by `artifact-links.ts`, the one grammar every link to an artifact
 * goes through, so the home cannot drift from search, Sources and the route.
 */
export function artifactHref(id: string): string {
  return artifactPath(id);
}

/**
 * The artifact open beside the chat it was made in — the Canvas panel.
 *
 * Kept as a menu item ("Open in conversation") now that a row opens `/a/{id}`:
 * a page or a component still previews live in that panel, and the chat is
 * where it is changed. The same deep link as the window's "Open in chat".
 */
export function conversationArtifactHref(conversationId: string, identifier: string): string {
  return chatArtifactPath(conversationId, identifier);
}
