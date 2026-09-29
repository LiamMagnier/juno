import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { ensureAgentThread, findAgent } from "@/lib/agents/store";

/** Old links named tabs (`now`, `setup`, `goals`…); each now opens the profile. */
function mapTabParam(raw: string | undefined): "profile" | "computer" | null {
  if (raw === "computer") return "computer";
  return raw ? "profile" : null;
}

/**
 * `/agents/[id]` is the agent's thread: it redirects there, opening the
 * profile or the computer when the link asks for one.
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
  redirect(`/chat/${encodeURIComponent(conversationId)}${tab ? `?agent=${tab}` : ""}`);
}
