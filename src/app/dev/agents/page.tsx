import { notFound } from "next/navigation";
import { AgentsStage } from "./stage";
import { AgentsGallery } from "./gallery";

/**
 * Dev-only stage for Agents: the real components inside the real `AppShell`,
 * fed fixtures through a fetch shim, so the signed-in surfaces can be seen
 * and their motion judged without an account.
 *
 *   ?view=motion   every face state, large, light and dark (hover them)
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
  if (params.view === "gallery") {
    return <AgentsGallery />;
  }
  const view = params.view === "thread" ? "thread" : "motion";
  return <AgentsStage view={view} fresh={params.fresh === "1"} panel={params.panel === "1"} state={typeof params.state === "string" ? params.state : null} />;
}
