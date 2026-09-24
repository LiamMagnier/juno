import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { loadAgentDetail } from "@/lib/agents/store";
import { AgentPage } from "@/components/agents/agent-page";

/**
 * One agent's page. The first paint is the server's read, so the face and the
 * state sentence are right the moment the page arrives; the client polls from
 * there (use-agents.ts).
 */
export default async function AgentRoute({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const detail = await loadAgentDetail(user.id, id);
  if (!detail) notFound();
  return (
    <Suspense>
      <AgentPage initial={detail} />
    </Suspense>
  );
}
