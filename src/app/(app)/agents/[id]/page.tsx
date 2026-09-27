import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { ensureAgentThread, findAgent } from "@/lib/agents/store";

function mapTabParam(raw: string | undefined): "now" | "computer" | "setup" {
  if (raw === "computer") return "computer";
  if (raw === "profile" || raw === "setup" || raw === "goals" || raw === "routines" || raw === "activity") {
    return "setup";
  }
  return "now";
}

/**
 * `/agents/[id]` redirects to the agent's chat thread with the side panel open
 * (`docs/design/agents-v2/BRIEF.md` §4.8.2).
 */
export default async function AgentRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; agent?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const agent = await findAgent(user.id, id);
  if (!agent) notFound();
  const conversationId = await ensureAgentThread(user.id, agent);
  const tab = mapTabParam(query.agent ?? query.tab);
  redirect(`/chat/${encodeURIComponent(conversationId)}?agent=${tab}`);
}
