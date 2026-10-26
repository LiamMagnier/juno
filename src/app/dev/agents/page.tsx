import { notFound, redirect } from "next/navigation";
import { AgentsStage } from "./stage";
import { AgentsGallery } from "./gallery";

/**
 * Dev-only stage for Agents: the real components inside the real `AppShell`,
 * fed fixtures through a fetch shim, so the signed-in surfaces can be seen
 * and their motion judged without an account.
 *
 *   ?view=motion   every face state at every size, the bodies, the small rows (&replay=1)
 *   ?view=thread   Mira's thread in the real shell   (&panel=1 opens her profile)
 *   ?view=gallery  full agents rework gallery
 *   ?state=<AgentState>  forces Mira's state in the thread
 *   &fresh=1       an empty thread (the greeting)
 *
 * Not linked from anywhere and 404s outside development.
 */
export default async function AgentsDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  // `&panel=1` opens Mira's profile the way the app does, through `?agent=`
  // in the URL the thread reads on its first render (a history.replaceState
  // from the client was never seen by the router, so the panel never opened).
  if (params.panel === "1" && !params.agent) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (typeof value === "string") query.set(key, value);
    query.set("agent", "profile");
    redirect(`/dev/agents?${query.toString()}`);
  }
  const view = params.view === "thread" ? "thread" : "motion";
  // The client root sits inside a server element, never directly in the
  // segment's child list. In development that list is forked (Next adds a
  // segment-explorer sibling), and when the client chunk is still loading at
  // hydration the lazy page element suspends; React 19.2 replays it without
  // its tree fork (resetWorkInProgress clears the Forked flag), so every
  // useId below it, the faces' mask ids and Radix's aria ids, came out
  // different from the server's on some loads. As the only child of a host
  // element it has no fork to lose.
  return (
    <div className="contents">
      {params.view === "gallery" ? (
        <AgentsGallery />
      ) : (
        <AgentsStage view={view} fresh={params.fresh === "1"} state={typeof params.state === "string" ? params.state : null} />
      )}
    </div>
  );
}
