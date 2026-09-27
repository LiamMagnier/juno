import { AgentHire } from "@/components/agents/agent-hire";
import { AgentStart } from "@/components/agents/agent-start";

/**
 * Hiring an agent (`docs/design/agents-v2/BRIEF.md` §4.8.4).
 * With `?form=1`, renders the full `AgentHire` form; otherwise renders
 * chat-first `AgentStart`.
 */
export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; form?: string }>;
}) {
  const { template, form } = await searchParams;
  const initialTemplate = typeof template === "string" ? template : null;
  if (form === "1" || form === "true") {
    return <AgentHire initialTemplate={initialTemplate} />;
  }
  return <AgentStart initialTemplate={initialTemplate} />;
}
