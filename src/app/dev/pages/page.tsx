import { notFound } from "next/navigation";
import { PagesGallery } from "./gallery";
import { PAGES, STATES, type PageName, type PageState } from "./pages";

/**
 * Dev-only fixture for the app's secondary pages: the real page components
 * (Library, Projects, Artifacts, Connections, Agents, Automations, Compare,
 * Settings, Memory, Skills) inside the real `AppShell`, with their routes
 * answered from made-up data by a fetch shim, so each page can be looked at
 * signed out in every state it has.
 *
 *   ?page=library|projects|artifacts|connections|agents|automations|compare|
 *         settings|memory|skills|notifications|search
 *   ?state=ready|empty|loading|error   (the page's own data; the shell's reads always answer)
 *
 * `notifications` and `search` open the inbox popover and the search dialog
 * over the Projects page. A project's page lives at /dev/pages/project/p-atlas,
 * because it reads its id from the route.
 *
 * Not linked from anywhere and 404s outside development, the same contract as
 * /dev/controls.
 */
export default async function PagesDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const page = (PAGES as readonly string[]).includes(String(params.page)) ? (params.page as PageName) : "library";
  const state = (STATES as readonly string[]).includes(String(params.state))
    ? (params.state as PageState)
    : "ready";
  return <PagesGallery key={`${page}-${state}`} page={page} state={state} />;
}
