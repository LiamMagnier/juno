/**
 * Pathname prefix → tab title. Longest prefix wins, so "/work/skills" beats
 * "/work". The root layout's template is "%s · Juno" (src/app/layout.tsx), so
 * these are the bare nouns; the suffix is added once, at the call site, because
 * `document.title` is set imperatively and no metadata template applies to it.
 *
 * A map rather than twenty one-line layout.tsx files: 25 of the 38
 * authenticated pages are client components and cannot export `metadata` at
 * all, and a conversation's title is not known at build time in any case.
 *
 * The same map captions the mobile top bar (app-shell.tsx), which is why the
 * strings read as page names rather than as tab labels — one noun has to work
 * in both places, and the bar is the one a user reads to answer "where am I".
 */
export const ROUTE_TITLES: ReadonlyArray<readonly [string, string]> = [
  ["/chat", "Juno"], // the new-chat screen has no subject yet
  ["/work/skills", "Skills"],
  ["/work/schedules", "Schedules"],
  ["/work/permissions", "Permissions"],
  ["/work/hosts", "Macs"],
  ["/work", "Work"],
  ["/code/pulls", "Pull requests"],
  ["/code/new", "New run"],
  ["/code", "Code"],
  ["/design", "Design"],
  ["/library", "Library"],
  ["/artifacts", "Artifacts"],
  ["/projects", "Projects"],
  ["/assistants", "Assistants"],
  ["/tasks", "Tasks"],
  ["/memory", "Memory"],
  ["/connections", "Connections"],
  ["/knowledge/documents", "Document"],
  ["/research", "Research"],
  ["/compare", "Compare"],
  ["/roadmap", "Roadmap"],
  ["/upgrade", "Plans"],
  ["/profile", "Profile"],
  ["/settings", "Settings"],
  ["/admin/announcements", "Announcements"],
  ["/admin/moderation", "Moderation"],
  ["/admin/users", "Accounts"],
  ["/admin", "Admin"],
];

/**
 * The title for a pathname, or "Juno" when nothing matches — a route with no
 * entry is better off with the product name than with a guess derived from the
 * URL, which is how "Chat/[id]" ends up in somebody's window switcher.
 */
export function titleForPath(pathname: string): string {
  let best = "";
  let title = "Juno";
  for (const [prefix, name] of ROUTE_TITLES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      if (prefix.length > best.length) {
        best = prefix;
        title = name;
      }
    }
  }
  return title;
}

/**
 * 60 characters is where a tab's hover tooltip stops being useful and a window
 * switcher entry stops being distinguishable; AI-written conversation titles
 * routinely run past it.
 */
export const MAX_TAB_TITLE = 60;

export function truncateTitle(title: string, max = MAX_TAB_TITLE): string {
  const trimmed = title.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
